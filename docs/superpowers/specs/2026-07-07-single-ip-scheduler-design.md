# Diseño: Planificador consciente de IP única + refuerzos anti-ban

- **Proyecto:** `microsoft-rewards-script` (Netsky, v4.0.2, GPL-3.0)
- **Fecha:** 2026-07-07
- **Objetivo:** mejorar eficiencia y reducir riesgo de baneo al ejecutar varias cuentas **sin proxies** (misma IP pública), con un caso objetivo de **hasta 3 cuentas en paralelo**.
- **Estado:** diseño aprobado, pendiente de plan de implementación.

## 1. Contexto y problema

El bot ejecuta N cuentas usando `node:cluster`. Hoy `runMaster` (`src/index.ts:190-277`) reparte las cuentas en trozos fijos con `chunkArray(accounts, clusters)` y **forkea todos los workers casi a la vez** (solo 5 s de stagger, sin jitter ni orden aleatorio). Dentro de cada worker las cuentas de su trozo van en serie.

Sin proxies, el mayor riesgo de correlación por IP **no** es que una cuenta trabaje rápido, sino que **varias sesiones de Microsoft coincidan en el tiempo desde la misma IP**. El trabajo *dentro* de una cuenta (búsqueda móvil + desktop en paralelo) es tráfico coherente de una sola identidad y no aumenta la correlación entre cuentas.

Además:
- **Sesión (cookies) ya se reutiliza** por defecto (`src/browser/Browser.ts:88`): si la sesión sigue válida se evita el login (evento más arriesgado y lento).
- **Fingerprint NO se persiste** por defecto (`saveFingerprint` = `false` en `src/util/Load.ts`): cada ejecución genera un dispositivo nuevo → un usuario recurrente cuyo dispositivo cambia a diario es señal de bot.
- **No hay espaciado (jitter) entre cuentas** ni orden aleatorio de cuentas.

## 2. Objetivos y no-objetivos

**Objetivos**
1. Limitar la concurrencia a un máximo configurable (objetivo: 3) **con relleno**: mantener el pool lleno hasta agotar la cola.
2. **Jitter aleatorio** antes de cada arranque de cuenta (inicial y cada relleno) para de-correlacionar los logins/sesiones desde la IP compartida.
3. **Orden de cuentas aleatorio** en cada ejecución.
4. **Fingerprint estable por cuenta** entre ejecuciones (dispositivo consistente).
5. Conservar la velocidad por cuenta (`parallelSearching`) y el aislamiento por proceso.

**No-objetivos (YAGNI)**
- Reparto horario a lo largo del día (crontab) — fuera de alcance.
- Cifrado en reposo de credenciales/sesiones — el usuario lo considera fuera de alcance.
- Tocar los delays de búsqueda (`searchDelay`/`readDelay`) — ya son adecuados.
- Modificar la lógica de actividades, login o webhooks.

## 3. Arquitectura

Enfoque elegido: **pool de procesos en el master** (mantiene `node:cluster`, cambio concentrado en `runMaster`). La orquestación se extrae a una **función pura y testeable**, desacoplada de cluster/IPC.

### 3.1. Unidad reutilizable — `src/util/Scheduler.ts`

```ts
export interface SchedulerOptions {
    maxConcurrent: number
    shuffle: boolean
    jitterMs: () => number                 // delay para el PRÓXIMO lanzamiento
    wait: (ms: number) => Promise<void>
    shuffleArray?: <T>(a: T[]) => T[]      // inyectable para test determinista
    onError?: (item: unknown, error: unknown) => void
}

/**
 * Procesa `items` con como mucho `maxConcurrent` en vuelo.
 * - Antes de cada lanzamiento espera `jitterMs()`.
 * - Al completarse uno, rellena con el siguiente de la cola.
 * - Captura errores de `runOne` (los reporta por `onError`) para que
 *   el fallo de un ítem no detenga el pool ni rechace la promesa.
 * - Resuelve cuando TODOS los ítems han terminado.
 */
export async function runScheduled<T>(
    items: T[],
    runOne: (item: T, index: number) => Promise<void>,
    opts: SchedulerOptions
): Promise<void>
```

**Invariantes:**
- El número de `runOne` activos nunca supera `maxConcurrent`.
- Cada ítem se procesa exactamente una vez (pop síncrono de la cola **antes** del `await jitterMs()` para evitar carreras).
- La promesa resuelve solo cuando la cola está vacía y no quedan tareas en vuelo.

Esta unidad **no** conoce `cluster`, `Account` ni IPC — solo colas y concurrencia. Se testea con `runOne` falsos.

### 3.2. Cableado en el master — `src/index.ts` (`runMaster`)

`runMaster` deja de trocear y pasa a usar `runScheduled`:

- `runOne(account)`:
  1. `const worker = cluster.fork()`
  2. `worker.send({ chunk: [account], runStartTime })`
  3. Engancha `worker.on('message', …)` **por worker** para acumular `__stats` y reenviar `__ipcLog` a Discord/Ntfy (misma lógica que hoy, pero por worker).
  4. Devuelve una `Promise<void>` que resuelve en `worker.on('exit', …)`, registrando stats y marcando `hadWorkerFailure` si el código de salida ≠ 0 o hubo señal.
- `jitterMs()` = aleatorio en `[accountStartDelay.min, accountStartDelay.max]` (parseado con `ms`).
- `maxConcurrent = clamp(config.clusters, 1, this.accounts.length)`.
- Tras `runScheduled`: agrega totales (puntos iniciales/finales/colectados, duración), `flushAllWebhooks()`, `process.exit(hadWorkerFailure ? 1 : 0)` — **misma finalización que hoy**.

Se sustituye el `cluster.on('exit')` global por `worker.on('exit')` por worker (necesario para el modelo de pool). El worker (`runWorker`/`runTasks`) **no cambia**.

**Semántica de `clusters`:** pasa de "nº de workers con trozos fijos" a "**máx. cuentas concurrentes con relleno**". Compatible en valor (con 5 cuentas y `clusters:3` sigue habiendo 3 en paralelo), pero ahora rellena en vez de dejar workers ociosos, y arranca con jitter y orden aleatorio. Se documenta en README/`config.example.json`.

### 3.3. Camino secuencial (`clusters:1`) — `runTasks`

Cuando `clusters ≤ 1` se mantiene el camino secuencial actual, pero se añade:
- Barajar las cuentas una vez si `shuffleAccounts`.
- Esperar `accountStartDelay` **entre** cuentas (hoy no hay espaciado ahí).

En el modelo de pool cada worker recibe 1 cuenta, así que este espaciado inter-cuenta en `runTasks` solo actúa en el camino `clusters:1`.

## 4. Cambios de configuración

**`src/interface/Config.ts`** — nuevas claves de nivel superior (junto a `clusters`):
```ts
shuffleAccounts?: boolean
accountStartDelay?: { min: string; max: string }
```

**`src/util/Validator.ts`** (Zod) — validación con defaults, para que configs antiguos sigan cargando:
```ts
shuffleAccounts: z.boolean().default(true),
accountStartDelay: z.object({
    min: z.string().default('20sec'),
    max: z.string().default('90sec')
}).default({ min: '20sec', max: '90sec' })
```

**`config.example.json`** — añadir:
```jsonc
"shuffleAccounts": true,
"accountStartDelay": { "min": "20sec", "max": "90sec" }
```
(y comentario en README sobre la nueva semántica de `clusters` = máx. concurrentes con relleno).

**`src/util/Load.ts`** — `buildSaveFingerprint`: cambiar el default de `false` a `true` para `mobile` y `desktop`. Sigue siendo desactivable por cuenta con `ACCOUNT_N_SAVE_FINGERPRINT_MOBILE/DESKTOP=false`.

## 5. Flujo de datos

```
accounts
  └─(shuffle si shuffleAccounts)→ cola
       └─ pool(≤ maxConcurrent, jitterMs antes de cada lanzamiento)
            └─ runOne(account): cluster.fork() + send({chunk:[account]})
                 └─ worker: runTasks([account]) ── IPC {__stats, __ipcLog} ──▶ master
       (al exit de un worker) → registrar stats → rellenar desde la cola
  cola vacía + pool ocioso → totales + flushAllWebhooks() + process.exit(code)
```

## 6. Manejo de errores

- **Crash de un worker/cuenta:** libera su hueco del pool → se rellena con la siguiente. La ejecución continúa. Se marca `hadWorkerFailure` y el proceso termina con código 1 al final (comportamiento actual preservado).
- **`runOne` que rechaza** dentro de `runScheduled`: capturado por la unidad (reportado vía `onError`), no rompe el `Promise.all` interno ni detiene el pool.
- **Config antiguo sin las claves nuevas:** los defaults de Zod garantizan carga válida.
- **Parseo de `accountStartDelay`:** reutiliza `utils.stringToNumber`/`ms`; valores inválidos → error de validación temprano (igual que los demás delays).

## 7. Estrategia de pruebas

El proyecto no tiene hoy infraestructura de test. Se añade:
- Script `"test": "node --test"` en `package.json` (runner integrado de Node, sin dependencias nuevas).
- `src/util/Scheduler.test.ts` (o `.js` compilado) con casos sobre `runScheduled` usando `runOne` falsos y `wait` instantáneo:
  1. **Cap de concurrencia:** con `maxConcurrent=3` y 10 ítems, el máximo de tareas simultáneas observado es exactamente 3.
  2. **Relleno:** todas las 10 se procesan; el pool se mantiene lleno hasta agotar la cola.
  3. **Completitud y unicidad:** cada ítem se procesa una y solo una vez.
  4. **Tolerancia a fallos:** si una tarea rechaza, el resto se completa y `onError` se invoca una vez.
  5. **Jitter:** `jitterMs` se invoca una vez por lanzamiento (verificable con un contador).

La verificación end-to-end del cableado en `runMaster` se hace ejecutando el bot con `clusters:3` y observando en logs el cap, el relleno y el jitter (no automatizable sin cuentas reales).

## 8. Impacto y riesgos

- **Blast radius acotado:** cambios en `src/index.ts` (`runMaster`, y espaciado en `runTasks`), nuevo `src/util/Scheduler.ts`, y ajustes de config/validación/`Load.ts`. No se toca login, actividades, HTTP ni webhooks.
- **Compatibilidad:** configs existentes siguen funcionando (defaults de Zod). El cambio de default de fingerprint a `true` es una mejora de comportamiento documentada, reversible por cuenta.
- **Rendimiento:** el pool forkea un proceso Node por cuenta (5 forks para 5 cuentas) en vez de uno por trozo; coste despreciable frente a Chromium. Con `maxConcurrent=3` y `parallelSearching:true` el pico sigue siendo ~3×2 = 6 Chromium.

## 9. Configuración recomendada resultante (referencia)

```jsonc
{
  "headless": true,
  "clusters": 3,                 // máx. 3 cuentas concurrentes con relleno
  "shuffleAccounts": true,
  "accountStartDelay": { "min": "20sec", "max": "90sec" },
  "searchSettings": { "parallelSearching": false }  // true solo si sobra RAM
}
```
Con `ACCOUNT_N_SAVE_FINGERPRINT_MOBILE/DESKTOP` ahora en `true` por defecto.
