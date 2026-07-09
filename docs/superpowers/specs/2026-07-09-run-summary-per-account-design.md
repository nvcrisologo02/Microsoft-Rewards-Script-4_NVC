# Resumen de ejecución por cuenta — Diseño

**Fecha:** 2026-07-09
**Estado:** Aprobado (pendiente de revisión de spec por el usuario)

## Objetivo

Al final de cada ejecución, mostrar en la **consola** un resumen con, para cada cuenta:
- los **puntos obtenidos en esta ejecución** (`collectedPoints`), y
- el **total de puntos al que ha llegado la cuenta** (`finalPoints`),

más una fila `TOTAL` agregada. La línea `RUN-END` existente se mantiene sin cambios.

## Contexto

Los datos ya se recogen hoy: cada cuenta produce un `AccountStats` (`src/index.ts`) con
`{ email, initialPoints, finalPoints, collectedPoints, duration, success, error? }`.
`duration` está en **segundos** (`parseFloat((ms/1000).toFixed(1))`).

- En el **camino cluster** (`clusters ≥ 2`), `runMaster` agrega los stats de todos los workers en `allAccountStats: AccountStats[]` (vía IPC `__stats`) y emite `RUN-END`.
- En el **camino secuencial** (`clusters ≤ 1`), `runTasks` acumula `accountStats` y emite su propio `RUN-END`.

Hoy ninguno de los dos muestra el desglose por cuenta. Este diseño solo **formatea y emite** ese desglose; no recolecta datos nuevos ni toca login/actividades/scheduler.

## Alcance

- **Solo consola.** No se envía a webhooks (Discord/ntfy), aunque estén activos.
- Se muestra en **ambos** caminos (cluster y secuencial), usando el mismo formateador, para consistencia.
- No se modifica la línea `RUN-END` ni su cálculo agregado.

## Arquitectura

### Unidad nueva: `src/util/RunSummary.ts` (pura, testeable)

Sin conocimiento de `cluster`, logger ni IPC. Exporta:

```ts
export interface AccountSummary {
    email: string
    collectedPoints: number   // ganados en esta ejecución
    finalPoints: number       // total alcanzado por la cuenta
    durationSeconds: number   // duración de esa cuenta, en segundos
    success: boolean
}

export function formatRunSummary(
    rows: AccountSummary[],
    totalRuntimeSeconds: number
): string
```

Devuelve el bloque completo del resumen como un único string con saltos de línea (`\n`), listo para pasar a una sola llamada del logger.

### Cableado en `src/index.ts`

En **`runMaster`** (justo antes de la llamada a `RUN-END`) y en **`runTasks`** para el camino `clusters ≤ 1` (justo antes de su `RUN-END`):

1. Mapear cada `AccountStats` a `AccountSummary` (`email`, `collectedPoints`, `finalPoints`, `durationSeconds: s.duration`, `success`).
2. Calcular `totalRuntimeSeconds = (Date.now() - runStartTime) / 1000`.
3. `this.logger.info('main', 'RUN-SUMMARY', formatRunSummary(rows, totalRuntimeSeconds))`.

Una sola llamada al logger con el string multilínea, para que las filas no se intercalen con timestamps por línea.

## Formato de salida

```
===== RESUMEN DE EJECUCIÓN (6 cuentas) =====
Cuenta                     Ganados     Total    Dur   Estado
pupela_32@outlook.com         +285    26.831   4.2m   OK
pepelu-322@outlook.es         +285    33.949   4.5m   OK
pepelusa-322@outlook.com      +228    15.852   4.1m   OK
nvcrisologo09@gmail.com       +190    12.400   3.8m   OK
pepelu-320@outlook.es         +285    18.500   4.0m   OK
nvcrisologo02@gmail.com         +0         0   0.2m   FALLO
-------------------------------------------------------------
TOTAL                       +1.273   135.532  20.8m   5/6 OK
```

(Ejemplo ilustrativo con las 6 cuentas; los anchos reales los calcula el formateador.)

### Reglas de formato (deterministas, para poder testear)

- **Cabecera:** `===== RESUMEN DE EJECUCIÓN (N cuentas) =====`, donde `N = rows.length`.
- **Columnas:** `Cuenta`, `Ganados`, `Total`, `Dur`, `Estado`.
- **Cuenta:** alineada a la izquierda; ancho = `max(len("Cuenta"), longitud máxima de email)`.
- **Ganados:** `+{collectedPoints}` con agrupación de miles; alineado a la derecha. El signo `+` siempre presente (incluye `+0`). Si `collectedPoints` fuese negativo, se muestra `-` (sin `+`).
- **Total:** `{finalPoints}` con agrupación de miles; alineado a la derecha.
- **Dur:** `{(durationSeconds/60).toFixed(1)}m`; alineado a la derecha.
- **Estado:** `OK` si `success`, `FALLO` si no.
- **Ancho de cada columna numérica/estado:** `max` sobre cabecera y todas las filas del ancho del string formateado, para alineación robusta con cualquier dato.
- **Separación entre columnas:** exactamente 3 espacios entre columnas.
- **Línea separadora:** guiones (`-`) del ancho total de la tabla, antes de la fila `TOTAL`.
- **Fila `TOTAL`:**
  - Etiqueta `TOTAL` en la columna Cuenta.
  - Ganados = `+Σ collectedPoints` (agrupado).
  - Total = `Σ finalPoints` (agrupado).
  - Dur = `{(totalRuntimeSeconds/60).toFixed(1)}m` (runtime total de la ejecución, **no** la suma de duraciones, porque en cluster se solapan).
  - Estado = `{nº success}/{N} OK`.
- **Orden de filas:** el de llegada de los stats (sin reordenar).
- **Agrupación de miles:** helper propio que inserta `.` cada 3 dígitos desde la derecha (determinista, sin depender de `Intl`/locale). Maneja el signo para negativos.
- **Sin filas:** si `rows` está vacío (no debería ocurrir), devolver solo cabecera + `TOTAL` con ceros; no lanzar.

## Tests (`src/util/RunSummary.test.ts`, `node --test`)

- Incluye una fila por cada cuenta de entrada, con `+collectedPoints` y `finalPoints` correctos.
- Cuenta fallida (`success:false`) aparece con `FALLO`.
- Fila `TOTAL`: suma de ganados, suma de finales, `Dur` = runtime pasado, y `k/N OK` correcto.
- Agrupación de miles correcta (p. ej. `1273` → `1.273`, `135532` → `135.532`, `0` → `0`).
- Alineación: con emails de distinta longitud, todas las filas de datos tienen la columna Cuenta del mismo ancho (verificable buscando la posición de la primera columna numérica).
- Caso `rows` vacío no lanza y produce cabecera + TOTAL en cero.

## Cambios de ficheros

- **Crear** `src/util/RunSummary.ts` — formateador puro + `AccountSummary`.
- **Crear** `src/util/RunSummary.test.ts` — tests.
- **Modificar** `src/index.ts` — mapear `AccountStats`→`AccountSummary` y emitir `RUN-SUMMARY` en `runMaster` y en el camino secuencial de `runTasks`, antes de sus respectivos `RUN-END`.
- **Modificar** `package.json` — el script `test` pasa a cubrir todos los tests de `src/util` (glob `src/util/*.test.ts`) para incluir el nuevo fichero.

## Restricciones

- TypeScript strict (`noUnusedLocals`, `noUncheckedIndexedAccess`, `strictNullChecks`), Node ≥ 24, CommonJS.
- Sin dependencias nuevas. Cross-platform.
- No tocar login, actividades, HTTP, webhooks ni el scheduler. Solo formateo + dos puntos de cableado + el script de test.
- `RUN-END` y su cálculo agregado se mantienen intactos.

## Fuera de alcance (YAGNI)

- Envío a webhooks del resumen.
- Persistencia/histórico del resumen en fichero.
- Ordenación por puntos u otras vistas.
- Cambiar el formato de `RUN-END`.
