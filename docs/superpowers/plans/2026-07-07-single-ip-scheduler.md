# Planificador consciente de IP única — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ejecutar varias cuentas con un tope de concurrencia configurable (objetivo 3) con relleno, jitter aleatorio entre arranques y orden de cuentas barajado, más fingerprint estable por defecto, para reducir el riesgo de correlación por IP sin proxies.

**Architecture:** Se extrae la orquestación a una unidad pura y testeable (`src/util/Scheduler.ts`), y el master de `node:cluster` (`runMaster`) la usa forkeando un worker de 1 cuenta por tarea, con relleno al terminar. El worker (`runWorker`/`runTasks`) no cambia su contrato. Config nueva con defaults Zod (compatible hacia atrás).

**Tech Stack:** TypeScript (CommonJS, target ES2022), `node:cluster`, Zod, `ms`, runner de test integrado `node --test` con `ts-node/register` (ya es dependencia).

## Global Constraints

- Node ≥ 24 (`package.json engines`). `strict` TS activado (`noUnusedLocals`, `noUncheckedIndexedAccess`, `strictNullChecks`).
- **Cross-platform** (Windows/macOS/Linux/headless/Docker): nada específico de un SO.
- **Sin dependencias nuevas de runtime.** Test con runner integrado + `ts-node` (ya presente).
- No tocar login, actividades, HTTP ni webhooks. Solo `runMaster`, espaciado en `runTasks`, config/validación y el default de fingerprint.
- Compatibilidad hacia atrás: configs sin las claves nuevas deben cargar (defaults Zod).
- **Nota git:** este repo NO es un repositorio git en el entorno actual. Donde el plan dice "Commit", ejecutar en su lugar el checkpoint de verificación indicado. Si se inicializa git, usar los mensajes de commit propuestos.

---

## Estructura de ficheros

- **Crear** `src/util/Scheduler.ts` — unidad pura de orquestación (cola + concurrencia + relleno + jitter). Sin conocimiento de `cluster`, `Account` ni IPC.
- **Crear** `src/util/Scheduler.test.ts` — tests del scheduler con `node --test`.
- **Modificar** `src/interface/Config.ts` — 2 campos nuevos.
- **Modificar** `src/util/Validator.ts` — 2 entradas de schema con default.
- **Modificar** `config.example.json` — 2 claves nuevas.
- **Modificar** `src/util/Load.ts` — default de fingerprint a `true`.
- **Modificar** `src/index.ts` — `runMaster` usa el scheduler; `runTasks` añade shuffle+espaciado en el camino secuencial; eliminar campos ociosos.
- **Modificar** `package.json` — script `"test"`.

---

## Task 1: Núcleo del scheduler (`Scheduler.ts`) con TDD

**Files:**
- Create: `src/util/Scheduler.ts`
- Test: `src/util/Scheduler.test.ts`
- Modify: `package.json` (añadir script `test`)

**Interfaces:**
- Produces:
  - `interface SchedulerOptions { maxConcurrent: number; shuffle: boolean; jitterMs: () => number; wait: (ms: number) => Promise<void>; shuffleArray?: <T>(a: T[]) => T[]; onError?: (item: unknown, error: unknown) => void }`
  - `async function runScheduled<T>(items: T[], runOne: (item: T, index: number) => Promise<void>, opts: SchedulerOptions): Promise<void>`

- [ ] **Step 1: Añadir el script de test a `package.json`**

En la sección `"scripts"` de `package.json`, añadir (por ejemplo tras la línea `"clear-diagnostics": ...`):

```json
        "test": "node --require ts-node/register --test src/util/Scheduler.test.ts",
```

- [ ] **Step 2: Escribir el test que falla**

Crear `src/util/Scheduler.test.ts` con este contenido completo:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import { runScheduled } from './Scheduler'

const noWait = async (): Promise<void> => {}
const noJitter = (): number => 0

test('nunca supera maxConcurrent y procesa todos los ítems una vez', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i)
    const seen: number[] = []
    let active = 0
    let maxObserved = 0

    await runScheduled(
        items,
        async item => {
            active++
            maxObserved = Math.max(maxObserved, active)
            await Promise.resolve()
            seen.push(item as number)
            active--
        },
        { maxConcurrent: 3, shuffle: false, jitterMs: noJitter, wait: noWait }
    )

    assert.equal(maxObserved, 3, 'la concurrencia máxima observada debe ser 3')
    assert.equal(seen.length, 10, 'deben procesarse los 10 ítems')
    assert.deepEqual([...seen].sort((a, b) => a - b), items, 'cada ítem exactamente una vez')
})

test('rellena hasta agotar la cola aunque las tareas tarden distinto', async () => {
    const items = [0, 1, 2, 3, 4]
    const done: number[] = []

    await runScheduled(
        items,
        async item => {
            const n = item as number
            await new Promise<void>(r => setTimeout(r, n % 2 === 0 ? 5 : 1))
            done.push(n)
        },
        { maxConcurrent: 2, shuffle: false, jitterMs: noJitter, wait: noWait }
    )

    assert.equal(done.length, 5)
    assert.deepEqual([...done].sort((a, b) => a - b), items)
})

test('un fallo no detiene el pool y se reporta por onError', async () => {
    const items = [0, 1, 2]
    const done: number[] = []
    const errors: unknown[] = []

    await runScheduled(
        items,
        async item => {
            if (item === 1) throw new Error('boom')
            done.push(item as number)
        },
        {
            maxConcurrent: 2,
            shuffle: false,
            jitterMs: noJitter,
            wait: noWait,
            onError: (_item, error) => errors.push(error)
        }
    )

    assert.deepEqual([...done].sort((a, b) => a - b), [0, 2], 'las tareas sanas se completan')
    assert.equal(errors.length, 1, 'onError se invoca una vez')
})

test('jitterMs se invoca una vez por lanzamiento', async () => {
    const items = [0, 1, 2, 3]
    let jitterCalls = 0

    await runScheduled(items, async () => {}, {
        maxConcurrent: 2,
        shuffle: false,
        jitterMs: () => {
            jitterCalls++
            return 0
        },
        wait: noWait
    })

    assert.equal(jitterCalls, 4, 'una llamada a jitterMs por cada ítem lanzado')
})

test('shuffle usa shuffleArray inyectado sin perder ítems', async () => {
    const items = [1, 2, 3, 4, 5]
    const seen: number[] = []

    await runScheduled(
        items,
        async item => {
            seen.push(item as number)
        },
        {
            maxConcurrent: 5,
            shuffle: true,
            jitterMs: noJitter,
            wait: noWait,
            shuffleArray: <T>(a: T[]): T[] => [...a].reverse()
        }
    )

    assert.deepEqual([...seen].sort((a, b) => a - b), items, 'no se pierde ni duplica ningún ítem')
})
```

- [ ] **Step 3: Ejecutar el test y verificar que falla**

Run: `npm test`
Expected: FAIL — error de resolución de módulo `Cannot find module './Scheduler'` (aún no existe `Scheduler.ts`).

- [ ] **Step 4: Implementar `Scheduler.ts`**

Crear `src/util/Scheduler.ts` con este contenido completo:

```ts
export interface SchedulerOptions {
    /** Máximo de tareas en vuelo simultáneas. */
    maxConcurrent: number
    /** Si true, procesa los ítems en orden aleatorio. */
    shuffle: boolean
    /** Delay (ms) a esperar ANTES de cada lanzamiento. Se evalúa una vez por ítem. */
    jitterMs: () => number
    /** Espera asíncrona; inyectable para test. */
    wait: (ms: number) => Promise<void>
    /** Baraja inyectable (para test determinista). Por defecto Fisher-Yates interno. */
    shuffleArray?: <T>(a: T[]) => T[]
    /** Notifica un fallo de `runOne` sin detener el pool. */
    onError?: (item: unknown, error: unknown) => void
}

function defaultShuffle<T>(input: T[]): T[] {
    const a = [...input]
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const tmp = a[i] as T
        a[i] = a[j] as T
        a[j] = tmp
    }
    return a
}

/**
 * Procesa `items` con como mucho `opts.maxConcurrent` tareas en vuelo.
 * - Antes de cada lanzamiento espera `opts.wait(opts.jitterMs())`.
 * - Al terminar una tarea, rellena con el siguiente ítem de la cola.
 * - Los errores de `runOne` se capturan (reportados por `opts.onError`) y NO
 *   detienen el pool ni rechazan esta promesa.
 * - Resuelve cuando la cola está vacía y no queda ninguna tarea en vuelo.
 */
export async function runScheduled<T>(
    items: T[],
    runOne: (item: T, index: number) => Promise<void>,
    opts: SchedulerOptions
): Promise<void> {
    const shuffle = opts.shuffleArray ?? defaultShuffle
    const queue: Array<{ item: T; index: number }> = (opts.shuffle ? shuffle(items) : [...items]).map(
        (item, index) => ({ item, index })
    )

    const concurrency = Math.max(1, Math.min(opts.maxConcurrent, queue.length || 1))

    const worker = async (): Promise<void> => {
        // Pop SÍNCRONO antes de cualquier await, para evitar carreras por el mismo ítem.
        for (;;) {
            const next = queue.shift()
            if (!next) return

            await opts.wait(opts.jitterMs())

            try {
                await runOne(next.item, next.index)
            } catch (error) {
                opts.onError?.(next.item, error)
            }
        }
    }

    const runners: Array<Promise<void>> = []
    for (let i = 0; i < concurrency; i++) {
        runners.push(worker())
    }

    await Promise.all(runners)
}
```

- [ ] **Step 5: Ejecutar el test y verificar que pasa**

Run: `npm test`
Expected: PASS — los 5 tests en verde.

- [ ] **Step 6: Verificar tipos**

Run: `npm run build`
Expected: compila sin errores (tsc strict). El fichero `dist/util/Scheduler.js` se genera.

- [ ] **Step 7: Commit** (si no hay git, este paso es el checkpoint de verificación de los Steps 5-6)

```bash
git add src/util/Scheduler.ts src/util/Scheduler.test.ts package.json
git commit -m "feat(scheduler): pure concurrency pool with refill, jitter and shuffle"
```

---

## Task 2: Config — nuevas claves y fingerprint estable por defecto

**Files:**
- Modify: `src/interface/Config.ts` (interface `Config`, ~líneas 1-19)
- Modify: `src/util/Validator.ts` (`ConfigSchema`, ~líneas 53-106)
- Modify: `config.example.json`
- Modify: `src/util/Load.ts` (`buildSaveFingerprint`, líneas 108-113)

**Interfaces:**
- Consumes: `ConfigDelay` (ya existe en `Config.ts`), `DelaySchema` (ya existe en `Validator.ts`).
- Produces: `Config.shuffleAccounts: boolean`, `Config.accountStartDelay: ConfigDelay` (siempre presentes tras `loadConfig()` gracias a los defaults Zod).

- [ ] **Step 1: Añadir campos a la interface `Config`**

En `src/interface/Config.ts`, dentro de `export interface Config { ... }`, añadir tras la línea `clusters: number` (línea 4):

```ts
    shuffleAccounts: boolean
    accountStartDelay: ConfigDelay
```

(`ConfigDelay` ya está declarado más abajo en el mismo fichero — no hace falta importarlo.)

- [ ] **Step 2: Añadir validación con default en `ConfigSchema`**

En `src/util/Validator.ts`, dentro de `export const ConfigSchema = z.object({ ... })`, añadir tras la línea `clusters: z.number().int().nonnegative(),` (línea 56):

```ts
    shuffleAccounts: z.boolean().default(true),
    accountStartDelay: DelaySchema.default({ min: '20sec', max: '90sec' }),
```

(`DelaySchema` ya está definido en la línea 18 del mismo fichero.)

- [ ] **Step 3: Añadir las claves a `config.example.json`**

En `config.example.json`, tras la línea `"clusters": 1,`, añadir:

```json
    "shuffleAccounts": true,
    "accountStartDelay": { "min": "20sec", "max": "90sec" },
```

- [ ] **Step 4: Cambiar el default de fingerprint a `true` en `Load.ts`**

En `src/util/Load.ts`, reemplazar la función `buildSaveFingerprint` (líneas 108-113):

```ts
function buildSaveFingerprint(index: string): ConfigSaveFingerprint {
    return {
        mobile: envBool(`ACCOUNT_${index}_SAVE_FINGERPRINT_MOBILE`, false),
        desktop: envBool(`ACCOUNT_${index}_SAVE_FINGERPRINT_DESKTOP`, false)
    }
}
```

por:

```ts
function buildSaveFingerprint(index: string): ConfigSaveFingerprint {
    return {
        mobile: envBool(`ACCOUNT_${index}_SAVE_FINGERPRINT_MOBILE`, true),
        desktop: envBool(`ACCOUNT_${index}_SAVE_FINGERPRINT_DESKTOP`, true)
    }
}
```

- [ ] **Step 5: Verificar compilación y defaults**

Run: `npm run build`
Expected: compila sin errores.

Run: `node -e "const{loadConfig}=require('./dist/util/Load');const fs=require('fs');fs.copyFileSync('config.example.json','config.json');const c=loadConfig();console.log('shuffleAccounts=',c.shuffleAccounts,'accountStartDelay=',JSON.stringify(c.accountStartDelay));if(c.shuffleAccounts!==true||!c.accountStartDelay)process.exit(1)"`
Expected: imprime `shuffleAccounts= true accountStartDelay= {"min":"20sec","max":"90sec"}` y sale con código 0.

Run (compat hacia atrás — un config SIN las claves nuevas debe cargar con defaults):
`node -e "const{ConfigSchema}=require('./dist/util/Validator');const base=require('./config.example.json');delete base.shuffleAccounts;delete base.accountStartDelay;const c=ConfigSchema.parse(base);if(c.shuffleAccounts!==true||c.accountStartDelay.min!=='20sec')process.exit(1);console.log('compat OK')"`
Expected: imprime `compat OK` y sale con código 0.

- [ ] **Step 6: Commit** (o checkpoint de verificación si no hay git)

```bash
git add src/interface/Config.ts src/util/Validator.ts config.example.json src/util/Load.ts
git commit -m "feat(config): add shuffleAccounts + accountStartDelay; default fingerprint persistence on"
```

---

## Task 3: Cablear el scheduler en `runMaster` y espaciar el camino secuencial

**Files:**
- Modify: `src/index.ts` — import (línea ~27 zona de imports), `runMaster` (líneas 190-277), `runTasks` (línea 314), campos ociosos (líneas 104-105, 138-139).

**Interfaces:**
- Consumes: `runScheduled` y `SchedulerOptions` de `./util/Scheduler` (Task 1); `Config.shuffleAccounts` y `Config.accountStartDelay` (Task 2); helpers existentes `this.utils.randomDelay(min,max)`, `this.utils.wait(ms)`, `this.utils.shuffleArray(a)`.

- [ ] **Step 1: Importar `runScheduled`**

En `src/index.ts`, junto al resto de imports de utilidades (por ejemplo tras la línea `import { closeSessionStore } from './util/SessionStore'`), añadir:

```ts
import { runScheduled } from './util/Scheduler'
```

- [ ] **Step 2: Reemplazar el cuerpo completo de `runMaster`**

Sustituir todo el método `private async runMaster(...)` (actualmente líneas 190-277) por:

```ts
    private async runMaster(runStartTime: number): Promise<void> {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `Primary process started | PID: ${process.pid}`)

        const accounts = [...this.accounts]
        const maxConcurrent = Math.max(1, Math.min(this.config.clusters, accounts.length))

        void this.logger.info(
            'main',
            'SCHEDULER',
            `Scheduler | accounts=${accounts.length} | maxConcurrent=${maxConcurrent} | shuffle=${this.config.shuffleAccounts ? 'on' : 'off'}`
        )

        const allAccountStats: AccountStats[] = []
        let hadWorkerFailure = false

        const runOne = (account: Account): Promise<void> =>
            new Promise<void>(resolve => {
                const worker = cluster.fork()
                worker.send?.({ chunk: [account], runStartTime })

                worker.on('message', (msg: { __ipcLog?: IpcLog; __stats?: AccountStats[] }) => {
                    if (msg.__stats) {
                        allAccountStats.push(...msg.__stats)
                    }

                    const log = msg.__ipcLog
                    if (log && typeof log.content === 'string') {
                        const { webhook } = this.config
                        const { content, level } = log

                        if (webhook.discord?.enabled && webhook.discord.url) {
                            sendDiscord(webhook.discord.url, content, level)
                        }
                        if (webhook.ntfy?.enabled && webhook.ntfy.url) {
                            sendNtfy(webhook.ntfy, content, level)
                        }
                    }
                })

                worker.on('exit', (code, signal) => {
                    const failed = (code ?? 0) !== 0 || Boolean(signal)
                    if (failed) {
                        hadWorkerFailure = true
                    }

                    this.logger.warn(
                        'main',
                        'CLUSTER-WORKER-EXIT',
                        `Worker ${worker.process.pid ?? '?'} exit | Code: ${code ?? 'n/a'} | Signal: ${signal ?? 'n/a'}`
                    )

                    resolve()
                })
            })

        await runScheduled(accounts, account => runOne(account), {
            maxConcurrent,
            shuffle: this.config.shuffleAccounts,
            jitterMs: () => this.utils.randomDelay(this.config.accountStartDelay.min, this.config.accountStartDelay.max),
            wait: (msDelay: number) => this.utils.wait(msDelay),
            shuffleArray: <T>(a: T[]): T[] => this.utils.shuffleArray(a),
            onError: (_item, error) =>
                void this.logger.error(
                    'main',
                    'SCHEDULER-ERROR',
                    `Account task error: ${error instanceof Error ? error.message : String(error)}`
                )
        })

        const totalCollectedPoints = allAccountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
        const totalInitialPoints = allAccountStats.reduce((sum, s) => sum + s.initialPoints, 0)
        const totalFinalPoints = allAccountStats.reduce((sum, s) => sum + s.finalPoints, 0)
        const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

        this.logger.info(
            'main',
            'RUN-END',
            `Completed all accounts | Accounts processed: ${allAccountStats.length} | Total points collected: +${totalCollectedPoints} | Old total: ${totalInitialPoints} → New total: ${totalFinalPoints} | Total runtime: ${totalDurationMinutes}min`,
            'green'
        )

        await flushAllWebhooks()
        process.exit(hadWorkerFailure ? 1 : 0)
    }
```

- [ ] **Step 3: Eliminar los campos de clase ahora ociosos**

En `src/index.ts` borrar las dos declaraciones (líneas 104-105):

```ts
    private activeWorkers: number
    private exitedWorkers: number[]
```

y sus dos inicializaciones en el constructor (líneas 138-139):

```ts
        this.activeWorkers = this.config.clusters
        this.exitedWorkers = []
```

(Tras esto, `grep -n "activeWorkers\|exitedWorkers" src/index.ts` no debe devolver nada.)

- [ ] **Step 4: Añadir shuffle + espaciado en el camino secuencial `runTasks`**

En `src/index.ts`, en `runTasks` (línea 311+), reemplazar la línea de apertura del bucle:

```ts
        for (const account of accounts) {
```

por:

```ts
        const ordered =
            accounts.length > 1 && this.config.shuffleAccounts ? this.utils.shuffleArray([...accounts]) : accounts

        for (let accountIndex = 0; accountIndex < ordered.length; accountIndex++) {
            const account = ordered[accountIndex]!

            if (accountIndex > 0) {
                await this.utils.wait(
                    this.utils.randomDelay(this.config.accountStartDelay.min, this.config.accountStartDelay.max)
                )
            }
```

El resto del cuerpo del bucle (que usa la variable `account`) queda **igual**; solo cambia la cabecera del `for`. La llave de cierre `}` del bucle no cambia.

- [ ] **Step 5: Verificar compilación completa**

Run: `npm run build`
Expected: compila sin errores (comprueba que `account` sigue resolviéndose en el cuerpo del bucle y que no quedan referencias a los campos borrados).

- [ ] **Step 6: Re-ejecutar la suite de tests (no debe romperse)**

Run: `npm test`
Expected: PASS — los tests del scheduler siguen en verde.

- [ ] **Step 7: Humo de arranque del planificador (sin cuentas reales)**

Prepara un `.env` de prueba con 2 cuentas ficticias (el login fallará, pero el scheduler debe barajar, aplicar jitter, lanzar con cap y rellenar antes de fallar):

```bash
printf 'ACCOUNT_1_EMAIL=a@example.com\nACCOUNT_1_PASSWORD=x\nACCOUNT_2_EMAIL=b@example.com\nACCOUNT_2_PASSWORD=y\n' > .env.smoke
```

Run (config con clusters:2, headless, jitter corto para no esperar):
`node -e "const fs=require('fs');const c=require('./config.example.json');c.clusters=2;c.headless=true;c.accountStartDelay={min:'1sec',max:'2sec'};fs.writeFileSync('config.json',JSON.stringify(c,null,2))" && cp .env.smoke .env && node ./dist/index.js`
Expected en logs: aparece una línea `SCHEDULER | accounts=2 | maxConcurrent=2 | shuffle=on`, se forkean 2 workers (con el jitter de 1-2s entre ellos), cada uno procesa 1 cuenta y el proceso termina con resumen `RUN-END`. Los logins fallan (credenciales falsas) pero el pool NO se cuelga y termina. Limpieza: `rm -f .env.smoke`.

- [ ] **Step 8: Commit** (o checkpoint de verificación si no hay git)

```bash
git add src/index.ts
git commit -m "feat(scheduler): drive account runs through IP-aware pool; space sequential path"
```

---

## Self-Review (cobertura frente a la spec)

- **Obj. 1 (cap con relleno):** Task 1 (`runScheduled`, cap + refill) + Task 3 (cableado). ✔
- **Obj. 2 (jitter antes de cada arranque):** Task 1 (`wait(jitterMs())`) + Task 3 (`jitterMs` desde `accountStartDelay`). ✔
- **Obj. 3 (orden aleatorio):** Task 1 (`shuffle`) + Task 2 (`shuffleAccounts`) + Task 3 (pool y secuencial). ✔
- **Obj. 4 (fingerprint estable):** Task 2 (default `true`). ✔
- **Obj. 5 (velocidad por cuenta + aislamiento por proceso):** intacto — `parallelSearching` y el modelo de proceso por cuenta no se tocan. ✔
- **Config compatible hacia atrás:** Task 2 Step 5 (verificación de defaults + compat). ✔
- **Sin dependencias nuevas / cross-platform / no tocar login-actividades-HTTP:** respetado en todas las tareas. ✔
- **Semántica de `clusters` = máx concurrentes con relleno:** Task 3 (`maxConcurrent = clamp(clusters,1,n)`), documentada en la spec. ✔