# Repesca automática y pausa global de cuentas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tras cada run, repescar automáticamente las cuentas que probablemente dejaron puntos sin recoger, y hacer que pausar una cuenta signifique realmente que no se ejecuta venga el run de donde venga.

**Architecture:** Un controlador nuevo en el servidor API (`scripts/api/rerunController.js`) se suscribe al evento `run-complete` que ya emite `ProcessManager`, decide con una función pura qué cuentas repescar, espera un cooldown y vuelve a llamar a `pm.start()` con esas cuentas vía el `excludedAccountIndexes` existente. `ProcessManager` no se toca. La pausa de cuentas reutiliza `excludedAccountIndexes` de `config/schedule.json`, que pasa a aplicarse también en los arranques manuales.

**Tech Stack:** Node 24 ESM (`scripts/api/*.js`, sin TypeScript), `node:test` + `node:assert/strict`, TypeScript estricto en `src/`, preact+htm sin build en `scripts/api/ui/`.

Spec: [`docs/superpowers/specs/2026-08-05-auto-rerun-and-account-pause-design.md`](../specs/2026-08-05-auto-rerun-and-account-pause-design.md)

## Global Constraints

- **`scripts/api/**` es JavaScript ESM puro, nunca TypeScript.** Imports con extensión `.js` explícita. Sin dependencias nuevas: solo built-ins de Node.
- **Los mensajes de la API y los comentarios de código van en inglés**; los textos de la interfaz (`scripts/api/ui/`) van en español, como el resto de las vistas.
- **`maxPasses` cuenta pasadas totales, incluida la principal.** Por defecto 3, es decir hasta 2 repescas. Hay repesca mientras `pass < maxPasses`.
- **Nunca uses el índice posicional de una cuenta tal y como aparece en el log del proceso hijo.** `buildExcludedAccountsEnv` renumera los slots supervivientes a `ACCOUNT_1..N` en el entorno del hijo, así que el hijo desconoce su índice real. La única clave de unión válida entre un run y la configuración es **el email**, igual que hace `mergeAccountStats`.
- **Nada de lo que haga el controlador puede tumbar el servidor.** Todo va en `try/catch` y degrada a "no repescar".
- Verificación antes de cada commit: `npm run lint` y las pruebas indicadas en la tarea. `npm run build` solo hace falta en las tareas que tocan `src/`.
- Formato: 4 espacios de indentación, comillas simples, sin punto y coma final (es lo que aplica Prettier en este repo). Ejecuta `npm run format:check` si dudas.

---

### Task 1: `autoRerun` en el almacén de configuración

Añade el bloque de configuración `autoRerun` a `config/schedule.json`, con defectos tomados del entorno cuando no hay fichero de override — exactamente el patrón que `readSchedule` ya usa para `cron`.

**Files:**
- Modify: `scripts/api/scheduleStore.js`
- Test: `scripts/api/scheduleStore.test.js`
- Modify: `package.json` (scripts de test)

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces:
  - `readSchedule(projectRoot)` devuelve ahora, además de lo que ya devolvía, `autoRerun: { enabled: boolean, delayMinutes: number, maxPasses: number }`.
  - `writeSchedule(projectRoot, patch)` acepta `patch.autoRerun` como objeto parcial (`{ enabled?, delayMinutes?, maxPasses? }`), fusionándolo sobre el valor actual.
  - `export const AUTO_RERUN_LIMITS = { delayMinutes: { min: 1, max: 120 }, maxPasses: { min: 1, max: 10 } }`

- [ ] **Step 1: Escribe las pruebas que fallan**

En `scripts/api/scheduleStore.test.js`, amplía el import existente para que quede así:

```js
import { remapIndexes, remapExclusionsAfterDelete, readSchedule, writeSchedule, AUTO_RERUN_LIMITS } from './scheduleStore.js'
```

y añade al final del fichero:

```js
function withTempSchedule(contents, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-autorerun-'))
    const file = path.join(dir, 'schedule.json')
    const prior = process.env.SCHEDULE_FILE
    process.env.SCHEDULE_FILE = file
    if (contents !== null) fs.writeFileSync(file, JSON.stringify(contents, null, 2))
    try {
        return fn(dir, file)
    } finally {
        if (prior === undefined) delete process.env.SCHEDULE_FILE
        else process.env.SCHEDULE_FILE = prior
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

test('readSchedule defaults autoRerun when no override file exists', () => {
    withTempSchedule(null, dir => {
        const prior = { ...process.env }
        delete process.env.AUTO_RERUN
        delete process.env.AUTO_RERUN_DELAY_MINUTES
        delete process.env.AUTO_RERUN_MAX_PASSES
        try {
            assert.deepEqual(readSchedule(dir).autoRerun, { enabled: true, delayMinutes: 5, maxPasses: 3 })
        } finally {
            process.env = prior
        }
    })
})

test('readSchedule takes autoRerun defaults from the environment', () => {
    withTempSchedule(null, dir => {
        const prior = { ...process.env }
        process.env.AUTO_RERUN = 'false'
        process.env.AUTO_RERUN_DELAY_MINUTES = '9'
        process.env.AUTO_RERUN_MAX_PASSES = '4'
        try {
            assert.deepEqual(readSchedule(dir).autoRerun, { enabled: false, delayMinutes: 9, maxPasses: 4 })
        } finally {
            process.env = prior
        }
    })
})

test('readSchedule prefers the persisted autoRerun override over the environment', () => {
    const saved = {
        enabled: false,
        cron: null,
        skipIfRunning: true,
        excludedAccountIndexes: [],
        autoRerun: { enabled: false, delayMinutes: 15, maxPasses: 2 }
    }
    withTempSchedule(saved, dir => {
        const prior = { ...process.env }
        process.env.AUTO_RERUN_DELAY_MINUTES = '5'
        try {
            assert.deepEqual(readSchedule(dir).autoRerun, { enabled: false, delayMinutes: 15, maxPasses: 2 })
        } finally {
            process.env = prior
        }
    })
})

test('readSchedule rejects an out-of-range autoRerun override', () => {
    const saved = {
        enabled: false,
        cron: null,
        skipIfRunning: true,
        excludedAccountIndexes: [],
        autoRerun: { enabled: true, delayMinutes: 0, maxPasses: 3 }
    }
    withTempSchedule(saved, dir => {
        assert.throws(() => readSchedule(dir), err => err.code === 'CORRUPT_SCHEDULE')
    })
})

test('writeSchedule merges a partial autoRerun patch over the current value', () => {
    withTempSchedule(null, dir => {
        const prior = { ...process.env }
        delete process.env.AUTO_RERUN
        delete process.env.AUTO_RERUN_DELAY_MINUTES
        delete process.env.AUTO_RERUN_MAX_PASSES
        try {
            const updated = writeSchedule(dir, { autoRerun: { delayMinutes: 10 } })
            assert.deepEqual(updated.autoRerun, { enabled: true, delayMinutes: 10, maxPasses: 3 })
            assert.deepEqual(readSchedule(dir).autoRerun, { enabled: true, delayMinutes: 10, maxPasses: 3 })
        } finally {
            process.env = prior
        }
    })
})

test('writeSchedule rejects an invalid autoRerun patch with BAD_REQUEST', () => {
    withTempSchedule(null, dir => {
        assert.throws(
            () => writeSchedule(dir, { autoRerun: { maxPasses: 99 } }),
            err => err.code === 'BAD_REQUEST'
        )
        assert.throws(
            () => writeSchedule(dir, { autoRerun: { enabled: 'yes' } }),
            err => err.code === 'BAD_REQUEST'
        )
    })
})

test('AUTO_RERUN_LIMITS documents the accepted ranges', () => {
    assert.deepEqual(AUTO_RERUN_LIMITS, {
        delayMinutes: { min: 1, max: 120 },
        maxPasses: { min: 1, max: 10 }
    })
})
```

Nota: `writeSchedule` llama a `applyCrontab`, que con `enabled: false` intenta `crontab -r` y `fs.unlinkSync` sobre rutas de `/etc`; ambas llamadas ya están envueltas en `try/catch` que ignoran el fallo, así que las pruebas funcionan fuera de Docker sin tocar nada.

- [ ] **Step 2: Ejecuta las pruebas y comprueba que fallan**

```bash
node --test scripts/api/scheduleStore.test.js
```

Esperado: FAIL. `readSchedule(...).autoRerun` es `undefined` y `AUTO_RERUN_LIMITS` no existe (`SyntaxError: The requested module './scheduleStore.js' does not provide an export named 'AUTO_RERUN_LIMITS'`).

- [ ] **Step 3: Implementa el soporte de `autoRerun`**

En `scripts/api/scheduleStore.js`, justo después del bloque `CRON_FIELD_RANGES` (sobre la línea 14), añade:

```js
export const AUTO_RERUN_LIMITS = {
    delayMinutes: { min: 1, max: 120 },
    maxPasses: { min: 1, max: 10 }
}

const AUTO_RERUN_FALLBACK = { enabled: true, delayMinutes: 5, maxPasses: 3 }

function envBool(value, fallback) {
    if (value === undefined || value === '') return fallback
    return value !== 'false' && value !== '0'
}

function envInt(value, fallback, { min, max }) {
    if (value === undefined || value === '') return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback
    return parsed
}

/** autoRerun defaults, taken from the environment when no override file exists. */
function autoRerunFromEnv(sourceEnv = process.env) {
    return {
        enabled: envBool(sourceEnv.AUTO_RERUN, AUTO_RERUN_FALLBACK.enabled),
        delayMinutes: envInt(
            sourceEnv.AUTO_RERUN_DELAY_MINUTES,
            AUTO_RERUN_FALLBACK.delayMinutes,
            AUTO_RERUN_LIMITS.delayMinutes
        ),
        maxPasses: envInt(sourceEnv.AUTO_RERUN_MAX_PASSES, AUTO_RERUN_FALLBACK.maxPasses, AUTO_RERUN_LIMITS.maxPasses)
    }
}

/**
 * Validates and normalizes an autoRerun object. `errorCode` distinguishes a
 * corrupt persisted file from a bad request body, which the callers surface as
 * different HTTP statuses.
 */
function normalizeAutoRerun(value, base, errorCode) {
    const fail = message => {
        throw Object.assign(new Error(message), { code: errorCode })
    }
    if (value === undefined) return { ...base }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail('autoRerun must be an object.')
    }

    const next = { ...base }
    if ('enabled' in value) {
        if (typeof value.enabled !== 'boolean') fail('autoRerun.enabled must be a boolean.')
        next.enabled = value.enabled
    }
    for (const key of ['delayMinutes', 'maxPasses']) {
        if (!(key in value)) continue
        const { min, max } = AUTO_RERUN_LIMITS[key]
        const parsed = Number(value[key])
        if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
            fail(`autoRerun.${key} must be an integer between ${min} and ${max}.`)
        }
        next[key] = parsed
    }
    return next
}
```

En `readSchedule`, dentro de la rama del fichero existente, tras la línea que lee `excludedAccountIndexes` (línea 80), añade:

```js
        const autoRerun = normalizeAutoRerun(saved.autoRerun, autoRerunFromEnv(), 'CORRUPT_SCHEDULE')
```

y añade `autoRerun` al objeto devuelto por esa rama, tras `excludedAccountIndexes`:

```js
            autoRerun,
```

En la rama final (sin fichero), añade al objeto devuelto, tras `excludedAccountIndexes: []`:

```js
        autoRerun: autoRerunFromEnv(),
```

En `writeSchedule`, antes del bloque `if (next.enabled && !next.cron)`, añade:

```js
    if ('autoRerun' in patch) {
        next.autoRerun = normalizeAutoRerun(patch.autoRerun, current.autoRerun, 'BAD_REQUEST')
    }
```

- [ ] **Step 4: Ejecuta las pruebas y comprueba que pasan**

```bash
node --test scripts/api/scheduleStore.test.js
```

Esperado: PASS, 10 pruebas (3 previas + 7 nuevas).

- [ ] **Step 5: Añade los scripts de test del API a `package.json`**

Hoy `npm test` solo cubre `src/**`; las 50 pruebas de `scripts/api/**` no las ejecuta nadie. Sustituye la entrada `"test"` de `package.json` por estas tres:

```json
    "test:unit": "node --require ts-node/register --test \"src/util/*.test.ts\" \"src/functions/*.test.ts\" \"src/browser/*.test.ts\"",
    "test:api": "node --test \"scripts/api/**/*.test.js\"",
    "test": "npm run test:unit && npm run test:api",
```

- [ ] **Step 6: Verifica la suite completa**

```bash
npm test
npm run lint
```

Esperado: ambas suites en verde (49 pruebas en `src`, 57 en `scripts/api`) y lint sin errores.

- [ ] **Step 7: Commit**

```bash
git add scripts/api/scheduleStore.js scripts/api/scheduleStore.test.js package.json
git commit -m "feat(api): persist autoRerun settings in schedule.json"
```

---

### Task 2: `decideNextPass`, la decisión pura

La función que decide si hay repesca y con qué cuentas. Sin E/S, sin temporizadores, sin estado: es la pieza que concentra toda la lógica del comportamiento y toda la cobertura de pruebas.

**Files:**
- Create: `scripts/api/rerunController.js`
- Test: `scripts/api/rerunController.test.js`

**Interfaces:**
- Consumes: la forma de `autoRerun` producida por la Task 1.
- Produces:
  ```js
  decideNextPass({
      runAccounts,             // [{ email, collectedPoints, success, error, live: { gained } }]
      knownAccounts,           // [{ index, email }] tal y como los devuelve loadAccounts()
      excludedAccountIndexes,  // number[] - cuentas pausadas
      autoRerun,               // { enabled, delayMinutes, maxPasses }
      pass,                    // number, 1-based: la pasada que acaba de terminar
      cancelled                // boolean: el usuario detuvo la cadena
  }) => {
      shouldRerun: boolean,
      accountIndexes: number[],  // índices reales a ejecutar, ordenados
      delayMs: number,
      reason: 'stopped' | 'disabled' | 'max-passes' | 'nothing-pending' | 'pending'
  }
  ```

- [ ] **Step 1: Escribe las pruebas que fallan**

Crea `scripts/api/rerunController.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { decideNextPass } from './rerunController.js'

const KNOWN = [
    { index: 1, email: 'uno@example.com' },
    { index: 2, email: 'dos@example.com' },
    { index: 3, email: 'tres@example.com' }
]

const AUTO_RERUN = { enabled: true, delayMinutes: 5, maxPasses: 3 }

function acc(email, patch = {}) {
    return { email, collectedPoints: 0, success: true, error: null, live: { gained: 0 }, ...patch }
}

function decide(patch = {}) {
    return decideNextPass({
        runAccounts: [],
        knownAccounts: KNOWN,
        excludedAccountIndexes: [],
        autoRerun: AUTO_RERUN,
        pass: 1,
        cancelled: false,
        ...patch
    })
}

test('no rerun when every account finished with zero points', () => {
    const result = decide({ runAccounts: [acc('uno@example.com'), acc('dos@example.com')] })
    assert.equal(result.shouldRerun, false)
    assert.equal(result.reason, 'nothing-pending')
    assert.deepEqual(result.accountIndexes, [])
})

test('only the accounts that gained points go into the next pass', () => {
    const result = decide({
        runAccounts: [acc('uno@example.com', { collectedPoints: 30 }), acc('dos@example.com'), acc('tres@example.com', { collectedPoints: 5 })]
    })
    assert.equal(result.shouldRerun, true)
    assert.equal(result.reason, 'pending')
    assert.deepEqual(result.accountIndexes, [1, 3])
    assert.equal(result.delayMs, 5 * 60_000)
})

test('an account that failed with zero points is still retried', () => {
    const result = decide({
        runAccounts: [acc('dos@example.com', { success: false, error: 'Flow failed' })]
    })
    assert.equal(result.shouldRerun, true)
    assert.deepEqual(result.accountIndexes, [2])
})

test('live.gained counts when the ACCOUNT-END line never arrived', () => {
    const result = decide({
        runAccounts: [{ email: 'uno@example.com', collectedPoints: null, success: null, error: null, live: { gained: 12 } }]
    })
    assert.equal(result.shouldRerun, true)
    assert.deepEqual(result.accountIndexes, [1])
})

test('a paused account never enters a rerun, even after gaining points', () => {
    const result = decide({
        runAccounts: [acc('uno@example.com', { collectedPoints: 30 }), acc('dos@example.com', { collectedPoints: 10 })],
        excludedAccountIndexes: [1]
    })
    assert.equal(result.shouldRerun, true)
    assert.deepEqual(result.accountIndexes, [2])
})

test('no rerun once the pass count reaches maxPasses', () => {
    const runAccounts = [acc('uno@example.com', { collectedPoints: 30 })]
    assert.equal(decide({ runAccounts, pass: 2 }).shouldRerun, true)
    const capped = decide({ runAccounts, pass: 3 })
    assert.equal(capped.shouldRerun, false)
    assert.equal(capped.reason, 'max-passes')
})

test('maxPasses of 1 disables reruns outright', () => {
    const result = decide({
        runAccounts: [acc('uno@example.com', { collectedPoints: 30 })],
        autoRerun: { ...AUTO_RERUN, maxPasses: 1 }
    })
    assert.equal(result.shouldRerun, false)
    assert.equal(result.reason, 'max-passes')
})

test('a run stopped by the user does not trigger a rerun', () => {
    const result = decide({
        runAccounts: [acc('uno@example.com', { collectedPoints: 30 })],
        cancelled: true
    })
    assert.equal(result.shouldRerun, false)
    assert.equal(result.reason, 'stopped')
})

test('autoRerun.enabled false disables reruns', () => {
    const result = decide({
        runAccounts: [acc('uno@example.com', { collectedPoints: 30 })],
        autoRerun: { ...AUTO_RERUN, enabled: false }
    })
    assert.equal(result.shouldRerun, false)
    assert.equal(result.reason, 'disabled')
})

test('accounts are matched by email regardless of case, and unknown emails are dropped', () => {
    const result = decide({
        runAccounts: [acc('UNO@Example.com', { collectedPoints: 30 }), acc('fantasma@example.com', { collectedPoints: 30 })]
    })
    assert.deepEqual(result.accountIndexes, [1])
})

test('the delay follows autoRerun.delayMinutes', () => {
    const result = decide({
        runAccounts: [acc('uno@example.com', { collectedPoints: 30 })],
        autoRerun: { ...AUTO_RERUN, delayMinutes: 12 }
    })
    assert.equal(result.delayMs, 12 * 60_000)
})
```

- [ ] **Step 2: Ejecuta las pruebas y comprueba que fallan**

```bash
node --test scripts/api/rerunController.test.js
```

Esperado: FAIL con `Cannot find module ... rerunController.js`.

- [ ] **Step 3: Implementa `decideNextPass`**

Crea `scripts/api/rerunController.js`:

```js
/**
 * Decides whether a finished run deserves another pass, and with which
 * accounts. Pure on purpose: every behavioural rule of the rerun feature lives
 * here, so it can be tested without processes, timers or files.
 *
 * An account is worth retrying when it gained points (there is likely more
 * pending - Bing daily offers in particular credit asynchronously, after the
 * account has already been closed) or when it failed outright (it almost
 * certainly left points untouched, and nothing retries it today).
 */
export function decideNextPass({
    runAccounts = [],
    knownAccounts = [],
    excludedAccountIndexes = [],
    autoRerun,
    pass = 1,
    cancelled = false
}) {
    const delayMs = Math.max(1, autoRerun?.delayMinutes ?? 5) * 60_000
    const nothing = reason => ({ shouldRerun: false, accountIndexes: [], delayMs, reason })

    if (cancelled) return nothing('stopped')
    if (!autoRerun?.enabled) return nothing('disabled')
    if (pass >= (autoRerun?.maxPasses ?? 1)) return nothing('max-passes')

    // The child process renumbers surviving slots to ACCOUNT_1..N, so its logs
    // carry no usable index. Email is the only valid join key back to config.
    const indexByEmail = new Map(knownAccounts.map(account => [account.email.toLowerCase(), account.index]))
    const paused = new Set(excludedAccountIndexes)

    const accountIndexes = [
        ...new Set(
            runAccounts
                .filter(account => {
                    const gained = account?.collectedPoints ?? account?.live?.gained ?? 0
                    return gained > 0 || account?.success === false
                })
                .map(account => indexByEmail.get(String(account?.email ?? '').toLowerCase()))
                .filter(index => index !== undefined && !paused.has(index))
        )
    ].sort((a, b) => a - b)

    if (!accountIndexes.length) return nothing('nothing-pending')

    return { shouldRerun: true, accountIndexes, delayMs, reason: 'pending' }
}
```

- [ ] **Step 4: Ejecuta las pruebas y comprueba que pasan**

```bash
node --test scripts/api/rerunController.test.js
npm run lint
```

Esperado: PASS, 11 pruebas. Lint limpio.

- [ ] **Step 5: Commit**

```bash
git add scripts/api/rerunController.js scripts/api/rerunController.test.js
git commit -m "feat(api): decide which accounts deserve a rerun pass"
```

---

### Task 3: El orquestador `RerunController`

La parte con estado: se suscribe a `run-complete`, programa el temporizador, relee la configuración justo antes de arrancar y llama a `pm.start()`. Todas las dependencias se inyectan para poder probarlo sin procesos ni relojes reales.

**Files:**
- Modify: `scripts/api/rerunController.js`
- Test: `scripts/api/rerunController.test.js`

**Interfaces:**
- Consumes: `decideNextPass` de la Task 2; `readSchedule` de la Task 1; `loadAccounts` y `buildExcludedAccountsEnv` de `scripts/api/accounts.js`.
- Produces:
  ```js
  new RerunController({
      pm,                 // ProcessManager (o un doble con .on/.start/.note)
      projectRoot,        // string
      readSchedule,       // (projectRoot) => schedule
      loadAccounts,       // () => [{ index, email }]
      buildExcludedEnv,   // (excludedIndexes) => { env, includedAccounts, excludedAccounts }
      setTimer = setTimeout,
      clearTimer = clearTimeout
  })
  controller.attach()                 // suscribe run-complete; devuelve el propio controller
  controller.noteExternalStart()      // reinicia el contador a 1 y cancela lo pendiente
  controller.cancel(reason)           // cancela la cadena (usado por /stop y por SIGTERM)
  controller.getState()               // { pending, pass, maxPasses, nextPassAt, accountIndexes }
  ```
  `RerunController` extiende `EventEmitter` y emite `'change'` cada vez que `getState()` cambia.

- [ ] **Step 1: Escribe las pruebas que fallan**

Añade al final de `scripts/api/rerunController.test.js`:

```js
import { EventEmitter } from 'node:events'
import { RerunController } from './rerunController.js'

class FakePm extends EventEmitter {
    constructor() {
        super()
        this.starts = []
        this.notes = []
        this.startError = null
    }
    start(overrides) {
        if (this.startError) throw this.startError
        this.starts.push(overrides)
        return { pid: 1234 }
    }
    note(level, message) {
        this.notes.push({ level, message })
    }
}

function makeHarness({ schedule, accounts = KNOWN, scheduleError = null } = {}) {
    const pm = new FakePm()
    const timers = []
    const controller = new RerunController({
        pm,
        projectRoot: '/tmp/fake',
        readSchedule: () => {
            if (scheduleError) throw scheduleError
            return {
                excludedAccountIndexes: [],
                autoRerun: AUTO_RERUN,
                ...schedule
            }
        },
        loadAccounts: () => accounts,
        buildExcludedEnv: excluded => ({
            env: { EXCLUDED: excluded.join(',') },
            includedAccounts: accounts.filter(a => !excluded.includes(a.index)),
            excludedAccounts: accounts.filter(a => excluded.includes(a.index))
        }),
        setTimer: (fn, ms) => {
            const handle = { fn, ms, cleared: false }
            timers.push(handle)
            return handle
        },
        clearTimer: handle => {
            if (handle) handle.cleared = true
        }
    }).attach()
    return { pm, controller, timers, fire: () => timers.at(-1).fn() }
}

function completion(runAccounts) {
    return { startedAt: 'x', endedAt: 'y', exit: { code: 0 }, run: { accounts: runAccounts } }
}

test('a completed run with pending accounts schedules the next pass', () => {
    const { pm, controller, timers } = makeHarness()
    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))

    assert.equal(timers.length, 1)
    assert.equal(timers[0].ms, 5 * 60_000)
    assert.equal(controller.getState().pending, true)
    assert.deepEqual(controller.getState().accountIndexes, [1])
    assert.equal(pm.starts.length, 0, 'must not start before the cooldown elapses')
})

test('firing the timer starts the next pass with the other accounts excluded', () => {
    const { pm, fire } = makeHarness()
    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))
    fire()

    assert.equal(pm.starts.length, 1)
    assert.equal(pm.starts[0].env.EXCLUDED, '2,3')
    assert.equal(pm.starts[0].env.RERUN_PASS, '2')
})

test('the pass counter advances and stops at maxPasses', () => {
    const { pm, controller, fire } = makeHarness()
    const gained = completion([acc('uno@example.com', { collectedPoints: 30 })])

    pm.emit('run-complete', gained)
    fire()
    assert.equal(pm.starts[0].env.RERUN_PASS, '2')

    pm.emit('run-complete', gained)
    fire()
    assert.equal(pm.starts[1].env.RERUN_PASS, '3')

    pm.emit('run-complete', gained)
    assert.equal(pm.starts.length, 2, 'maxPasses of 3 allows no fourth pass')
    assert.equal(controller.getState().pending, false)
})

test('a run killed by a signal is treated as stopped, not as a candidate', () => {
    const { pm, controller, timers } = makeHarness()
    pm.emit('run-complete', {
        exit: { code: null, signal: 'SIGTERM' },
        run: { accounts: [acc('uno@example.com', { collectedPoints: 30 })] }
    })

    assert.equal(timers.length, 0)
    assert.equal(controller.getState().pending, false)
})

test('noteExternalStart resets the chain and clears any pending timer', () => {
    const { pm, controller, timers } = makeHarness()
    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))
    assert.equal(controller.getState().pending, true)

    controller.noteExternalStart()

    assert.equal(timers[0].cleared, true)
    assert.equal(controller.getState().pending, false)
    assert.equal(controller.getState().pass, 1)
})

test('cancel stops the chain so the completing run schedules nothing', () => {
    const { pm, controller, timers } = makeHarness()
    controller.cancel('stopped by user')
    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))

    assert.equal(timers.length, 0)
    assert.equal(controller.getState().pending, false)
})

test('a corrupt schedule cancels the chain rather than running paused accounts', () => {
    const { pm, controller, timers } = makeHarness({
        scheduleError: Object.assign(new Error('schedule.json is corrupt'), { code: 'CORRUPT_SCHEDULE' })
    })
    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))

    assert.equal(timers.length, 0)
    assert.equal(controller.getState().pending, false)
    assert.match(pm.notes.at(-1).message, /corrupt/i)
})

test('an ALREADY_RUNNING start abandons the chain without throwing', () => {
    const { pm, controller, fire } = makeHarness()
    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))
    pm.startError = Object.assign(new Error('Cannot start: a run is already running.'), { code: 'ALREADY_RUNNING' })

    assert.doesNotThrow(() => fire())
    assert.equal(controller.getState().pending, false)
})

test('change events fire when a pass is scheduled and when it is cancelled', () => {
    const { pm, controller } = makeHarness()
    let changes = 0
    controller.on('change', () => changes++)

    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))
    assert.equal(changes, 1)

    controller.noteExternalStart()
    assert.equal(changes, 2)
})

test('the schedule is re-read at fire time so a mid-cooldown pause takes effect', () => {
    const pm = new FakePm()
    const timers = []
    let excluded = []
    new RerunController({
        pm,
        projectRoot: '/tmp/fake',
        readSchedule: () => ({ excludedAccountIndexes: excluded, autoRerun: AUTO_RERUN }),
        loadAccounts: () => KNOWN,
        buildExcludedEnv: list => ({ env: { EXCLUDED: list.join(',') }, includedAccounts: [], excludedAccounts: [] }),
        setTimer: (fn, ms) => {
            const handle = { fn, ms }
            timers.push(handle)
            return handle
        },
        clearTimer: () => {}
    }).attach()

    pm.emit('run-complete', completion([
        acc('uno@example.com', { collectedPoints: 30 }),
        acc('dos@example.com', { collectedPoints: 30 })
    ]))
    excluded = [1]
    timers.at(-1).fn()

    assert.equal(pm.starts[0].env.EXCLUDED, '1,3', 'account 1 was paused during the cooldown')
})
```

- [ ] **Step 2: Ejecuta las pruebas y comprueba que fallan**

```bash
node --test scripts/api/rerunController.test.js
```

Esperado: FAIL con `does not provide an export named 'RerunController'`.

- [ ] **Step 3: Implementa `RerunController`**

Añade a `scripts/api/rerunController.js`, tras `decideNextPass`:

```js
import { EventEmitter } from 'node:events'

/**
 * Owns the multi-pass chain: which pass we are on, whether one is pending, and
 * the timer in between. Deliberately separate from ProcessManager, whose state
 * machine describes a single child process - folding the chain into it would
 * make its `state !== 'idle'` start guard ambiguous.
 */
export class RerunController extends EventEmitter {
    constructor({
        pm,
        projectRoot,
        readSchedule,
        loadAccounts,
        buildExcludedEnv,
        setTimer = setTimeout,
        clearTimer = clearTimeout
    }) {
        super()
        this.pm = pm
        this.projectRoot = projectRoot
        this.readSchedule = readSchedule
        this.loadAccounts = loadAccounts
        this.buildExcludedEnv = buildExcludedEnv
        this.setTimer = setTimer
        this.clearTimer = clearTimer

        this.pass = 1
        this.maxPasses = null
        this.cancelled = false
        this._timer = null
        this._pendingIndexes = []
        this._nextPassAt = null
    }

    attach() {
        this.pm.on('run-complete', entry => this._onRunComplete(entry))
        return this
    }

    getState() {
        return {
            pending: this._timer != null,
            pass: this.pass,
            maxPasses: this.maxPasses,
            nextPassAt: this._nextPassAt,
            accountIndexes: [...this._pendingIndexes]
        }
    }

    /** A run this controller did not start: cron, the dashboard, RUN_ON_START. */
    noteExternalStart() {
        this._clearPending()
        this.pass = 1
        this.cancelled = false
        this.emit('change')
    }

    cancel(reason) {
        const wasPending = this._timer != null
        this._clearPending()
        this.cancelled = true
        if (reason) this._note('info', `Rerun chain cancelled (${reason}).`)
        if (wasPending) this.emit('change')
    }

    _clearPending() {
        if (this._timer != null) this.clearTimer(this._timer)
        this._timer = null
        this._pendingIndexes = []
        this._nextPassAt = null
    }

    _note(level, message) {
        try {
            this.pm.note(level, `[AUTO-RERUN] ${message}`)
        } catch {
            /* logging must never break the chain */
        }
    }

    _onRunComplete(entry) {
        try {
            let schedule
            try {
                schedule = this.readSchedule(this.projectRoot)
            } catch (error) {
                // Rather run nothing than run accounts the user paused.
                this._note('warn', `Could not read the schedule (${error.message}); not scheduling another pass.`)
                this._clearPending()
                return
            }

            this.maxPasses = schedule.autoRerun?.maxPasses ?? null

            const decision = decideNextPass({
                runAccounts: entry?.run?.accounts ?? [],
                knownAccounts: this.loadAccounts(),
                excludedAccountIndexes: schedule.excludedAccountIndexes ?? [],
                autoRerun: schedule.autoRerun,
                pass: this.pass,
                // A signalled exit means something killed the child - a container
                // shutdown, or a stop on a platform where the explicit cancel
                // never reached us. Either way, do not chain another pass.
                cancelled: this.cancelled || Boolean(entry?.exit?.signal)
            })

            this.cancelled = false

            if (!decision.shouldRerun) {
                this._clearPending()
                if (decision.reason === 'nothing-pending') {
                    this._note('info', `Nothing left to collect after pass ${this.pass}; chain finished.`)
                } else if (decision.reason === 'max-passes') {
                    this._note('info', `Reached the ${schedule.autoRerun?.maxPasses} pass limit; chain finished.`)
                }
                return
            }

            this._pendingIndexes = decision.accountIndexes
            this._nextPassAt = new Date(Date.now() + decision.delayMs).toISOString()
            this._timer = this.setTimer(() => this._startNextPass(), decision.delayMs)
            if (typeof this._timer?.unref === 'function') this._timer.unref()

            this._note(
                'info',
                `Pass ${this.pass} done. Scheduling pass ${this.pass + 1} of ${schedule.autoRerun?.maxPasses} in ` +
                    `${decision.delayMs / 60_000} min for ACCOUNT_${decision.accountIndexes.join(', ACCOUNT_')}.`
            )
            this.emit('change')
        } catch (error) {
            this._note('warn', `Unexpected failure while planning the next pass: ${error.message}`)
            this._clearPending()
        }
    }

    _startNextPass() {
        const indexes = [...this._pendingIndexes]
        this._clearPending()

        try {
            // Re-read now, not at decision time: pausing an account during the
            // cooldown must take effect on the pass about to start.
            const schedule = this.readSchedule(this.projectRoot)
            const paused = new Set(schedule.excludedAccountIndexes ?? [])
            const wanted = new Set(indexes.filter(index => !paused.has(index)))

            if (!wanted.size) {
                this._note('info', 'Every account for this pass is now paused; chain finished.')
                this.emit('change')
                return
            }

            const excluded = this.loadAccounts()
                .map(account => account.index)
                .filter(index => !wanted.has(index))

            const selection = this.buildExcludedEnv(excluded)
            this.pass += 1
            this.pm.start({ env: { ...selection.env, RERUN_PASS: String(this.pass) } })
            this._note('info', `Pass ${this.pass} started.`)
        } catch (error) {
            if (error?.code === 'ALREADY_RUNNING') {
                this._note('info', 'Another run is already in progress; abandoning the rerun chain.')
            } else {
                this._note('warn', `Could not start the next pass: ${error.message}`)
            }
        } finally {
            this.emit('change')
        }
    }
}
```

Mueve el `import { EventEmitter } from 'node:events'` al principio del fichero, junto al resto de imports.

- [ ] **Step 4: Ejecuta las pruebas y comprueba que pasan**

```bash
node --test scripts/api/rerunController.test.js
npm run lint
```

Esperado: PASS, 21 pruebas (11 de la Task 2 más 10 nuevas). Lint limpio.

- [ ] **Step 5: Commit**

```bash
git add scripts/api/rerunController.js scripts/api/rerunController.test.js
git commit -m "feat(api): orchestrate multi-pass rerun chains"
```

---

### Task 4: Pausa global de cuentas en `/start` y `/restart`

Hoy `POST /start {}` ejecuta todas las cuentas, ignorando las que el usuario apartó. Este es el cambio que hace que pausar signifique algo.

**Files:**
- Modify: `scripts/api/server.js:605-700` (manejadores `/start` y `/restart`)
- Modify: `scripts/api/trigger.js:73-88` (eliminar `buildStartBody`)
- Test: `scripts/api/pauseSelection.test.js` (nuevo)
- Create: `scripts/api/startSelection.js`

**Interfaces:**
- Consumes: `readSchedule` (Task 1), `buildExcludedAccountsEnv` de `scripts/api/accounts.js`.
- Produces:
  ```js
  // scripts/api/startSelection.js
  resolveStartSelection(body, { readSchedule, projectRoot, buildSingleEnv, buildExcludedEnv })
  // => { env, selectedAccount, excludedAccounts }
  // Lanza errores con .code 'BAD_REQUEST' | 'ALL_PAUSED' | 'CORRUPT_SCHEDULE'
  ```

- [ ] **Step 1: Escribe las pruebas que fallan**

Crea `scripts/api/pauseSelection.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveStartSelection } from './startSelection.js'

const ACCOUNTS = [
    { index: 1, email: 'uno@example.com' },
    { index: 2, email: 'dos@example.com' }
]

function deps({ excludedAccountIndexes = [], scheduleError = null } = {}) {
    return {
        projectRoot: '/tmp/fake',
        readSchedule: () => {
            if (scheduleError) throw scheduleError
            return { excludedAccountIndexes, autoRerun: { enabled: true, delayMinutes: 5, maxPasses: 3 } }
        },
        buildSingleEnv: index => ({
            env: { SINGLE: String(index) },
            account: ACCOUNTS.find(a => a.index === index)
        }),
        buildExcludedEnv: list => {
            if (list.length >= ACCOUNTS.length) {
                throw Object.assign(new Error('A scheduled run cannot exclude every configured account.'), {
                    code: 'BAD_REQUEST'
                })
            }
            return {
                env: { EXCLUDED: list.join(',') },
                excludedAccounts: ACCOUNTS.filter(a => list.includes(a.index)),
                includedAccounts: ACCOUNTS.filter(a => !list.includes(a.index))
            }
        }
    }
}

test('an empty body applies the persisted pauses', () => {
    const result = resolveStartSelection({}, deps({ excludedAccountIndexes: [2] }))
    assert.equal(result.env.EXCLUDED, '2')
    assert.deepEqual(result.excludedAccounts, [{ index: 2, email: 'dos@example.com' }])
    assert.equal(result.selectedAccount, null)
})

test('an empty body with nothing paused adds no environment override', () => {
    const result = resolveStartSelection({}, deps())
    assert.deepEqual(result.env, {})
    assert.deepEqual(result.excludedAccounts, [])
})

test('an explicit empty exclusion list overrides the pauses', () => {
    const result = resolveStartSelection({ excludedAccountIndexes: [] }, deps({ excludedAccountIndexes: [2] }))
    assert.equal(result.env.EXCLUDED, '')
    assert.deepEqual(result.excludedAccounts, [])
})

test('an explicit accountIndex runs even a paused account', () => {
    const result = resolveStartSelection({ accountIndex: 2 }, deps({ excludedAccountIndexes: [2] }))
    assert.equal(result.env.SINGLE, '2')
    assert.deepEqual(result.selectedAccount, { index: 2, email: 'dos@example.com' })
})

test('accountIndex and excludedAccountIndexes together are rejected', () => {
    assert.throws(
        () => resolveStartSelection({ accountIndex: 1, excludedAccountIndexes: [2] }, deps()),
        err => err.code === 'BAD_REQUEST'
    )
})

test('pausing every account is reported as ALL_PAUSED, not a generic bad request', () => {
    assert.throws(
        () => resolveStartSelection({}, deps({ excludedAccountIndexes: [1, 2] })),
        err => err.code === 'ALL_PAUSED'
    )
})

test('a corrupt schedule refuses the implicit start instead of running paused accounts', () => {
    assert.throws(
        () =>
            resolveStartSelection(
                {},
                deps({ scheduleError: Object.assign(new Error('corrupt'), { code: 'CORRUPT_SCHEDULE' }) })
            ),
        err => err.code === 'CORRUPT_SCHEDULE'
    )
})

test('an explicit selection works even when the schedule is corrupt', () => {
    const result = resolveStartSelection(
        { accountIndex: 1 },
        deps({ scheduleError: Object.assign(new Error('corrupt'), { code: 'CORRUPT_SCHEDULE' }) })
    )
    assert.equal(result.env.SINGLE, '1')
})
```

- [ ] **Step 2: Ejecuta las pruebas y comprueba que fallan**

```bash
node --test scripts/api/pauseSelection.test.js
```

Esperado: FAIL con `Cannot find module ... startSelection.js`.

- [ ] **Step 3: Implementa `resolveStartSelection`**

Crea `scripts/api/startSelection.js`:

```js
/**
 * Resolves which accounts a start request should run.
 *
 * The key rule: a request that names no selection means "everything that is not
 * paused", not "everything". Paused accounts live in schedule.json's
 * excludedAccountIndexes, which used to be honoured only by cron - so the
 * dashboard's own start button quietly ran accounts the user had set aside.
 *
 * An explicit selection always wins: `accountIndex` runs that account even if
 * it is paused (naming a slot is a deliberate act), and an explicitly supplied
 * `excludedAccountIndexes` - including an empty array - replaces the pauses.
 */
export function resolveStartSelection(body, { readSchedule, projectRoot, buildSingleEnv, buildExcludedEnv }) {
    if (body.accountIndex != null && body.excludedAccountIndexes != null) {
        throw Object.assign(new Error('`accountIndex` and `excludedAccountIndexes` cannot be used together.'), {
            code: 'BAD_REQUEST'
        })
    }

    if (body.accountIndex != null) {
        const selection = buildSingleEnv(body.accountIndex)
        return { env: selection.env, selectedAccount: selection.account, excludedAccounts: [] }
    }

    if (body.excludedAccountIndexes != null) {
        const selection = buildExcludedEnv(body.excludedAccountIndexes)
        return { env: selection.env, selectedAccount: null, excludedAccounts: selection.excludedAccounts }
    }

    // Implicit start: fall back to the persisted pauses.
    const paused = readSchedule(projectRoot).excludedAccountIndexes ?? []
    if (!paused.length) return { env: {}, selectedAccount: null, excludedAccounts: [] }

    let selection
    try {
        selection = buildExcludedEnv(paused)
    } catch (error) {
        if (error?.code === 'BAD_REQUEST') {
            throw Object.assign(
                new Error('Every configured account is paused. Resume at least one, or name one explicitly.'),
                { code: 'ALL_PAUSED' }
            )
        }
        throw error
    }
    return { env: selection.env, selectedAccount: null, excludedAccounts: selection.excludedAccounts }
}
```

- [ ] **Step 4: Ejecuta las pruebas y comprueba que pasan**

```bash
node --test scripts/api/pauseSelection.test.js
```

Esperado: PASS, 8 pruebas.

- [ ] **Step 5: Conecta el resolvedor a `/start` y `/restart`**

En `scripts/api/server.js`, añade el import junto a los demás de la cabecera:

```js
import { resolveStartSelection } from './startSelection.js'
```

Añade este helper junto a `toHistoryRecord` (sobre la línea 129):

```js
function startSelectionFor(body) {
    return resolveStartSelection(body, {
        readSchedule,
        projectRoot,
        buildSingleEnv: buildSingleAccountEnv,
        buildExcludedEnv: buildExcludedAccountsEnv
    })
}

function selectionErrorStatus(code) {
    if (code === 'BAD_REQUEST') return 400
    if (code === 'ALL_PAUSED') return 409
    if (code === 'CORRUPT_SCHEDULE') return 500
    return 500
}
```

Sustituye el bloque `try { ... }` del manejador `/start` (líneas 619-641) por:

```js
            try {
                const selection = startSelectionFor(body)
                if (Object.keys(selection.env).length) {
                    overrides.env = { ...(overrides.env || {}), ...selection.env }
                }
                const info = pm.start(overrides)
                return sendJson(res, 202, {
                    started: true,
                    selectedAccount: selection.selectedAccount,
                    excludedAccounts: selection.excludedAccounts,
                    ...info
                })
            } catch (err) {
                if (err.code === 'ALREADY_RUNNING') return sendJson(res, 409, { error: err.message, code: err.code })
                if (err.code) return sendJson(res, selectionErrorStatus(err.code), { error: err.message, code: err.code })
                return sendJson(res, 500, { error: err.message })
            }
```

y elimina las declaraciones `let selectedAccount = null` / `let excludedAccounts = []` que quedan sin uso al principio del manejador.

Aplica exactamente la misma sustitución en el manejador `/restart` (a partir de la línea 673), conservando su `overrides.force` y su respuesta `{ restarted: true, ... }`.

- [ ] **Step 6: Simplifica `trigger.js`**

El servidor ya aplica las exclusiones, así que la copia de esa lógica en el disparador de cron sobra. En `scripts/api/trigger.js`, borra la función `buildStartBody` completa (líneas 73-88) y sus imports ya innecesarios (`getProjectRoot`, `readSchedule`, `path`, `fileURLToPath`, y las constantes `__dirname` / `projectRoot` si no se usan en ningún otro sitio del fichero). Sustituye la llamada:

```js
const { status, body } = await request('POST', '/start', buildStartBody())
```

por:

```js
// The API server applies the persisted account pauses itself.
const { status, body } = await request('POST', '/start', {})
```

- [ ] **Step 7: Verifica**

```bash
node --test "scripts/api/**/*.test.js"
npm run lint
node -e "import('./scripts/api/trigger.js').catch(e => { if (!/ECONNREFUSED|API server did not respond/.test(String(e))) throw e })" || true
```

Esperado: las pruebas del API en verde y lint limpio. La tercera orden solo comprueba que `trigger.js` sigue siendo sintácticamente válido tras el recorte; puede terminar con el error de conexión, eso es correcto.

- [ ] **Step 8: Commit**

```bash
git add scripts/api/server.js scripts/api/startSelection.js scripts/api/pauseSelection.test.js scripts/api/trigger.js
git commit -m "feat(api): honour paused accounts on every start, not just cron"
```

---

### Task 5: Estado `cooldown` y conexión del controlador al servidor

Sin esto, durante los 5 minutos de espera `GET /status` diría `idle`, `trigger.js` daría el run por terminado y soltaría el lockfile de cron a mitad de cadena.

**Files:**
- Modify: `scripts/api/server.js` (composición de estado, alta del controlador, `/stop`, SSE, señales)
- Modify: `scripts/api/trigger.js` (tratar `cooldown` como run en curso)

**Interfaces:**
- Consumes: `RerunController` (Task 3), `startSelectionFor` (Task 4).
- Produces: `GET /status` y los eventos SSE `hello`/`status` incluyen `rerun: { pending, pass, maxPasses, nextPassAt, accountIndexes }`, y `state` vale `'cooldown'` cuando el proceso está ocioso con una pasada pendiente.

- [ ] **Step 1: Da de alta el controlador en `server.js`**

Junto a los demás imports:

```js
import { RerunController } from './rerunController.js'
```

Tras el bloque `pm.on('run-complete', ...)` que ya persiste el historial (sobre la línea 111), añade:

```js
// Chains extra passes after a run so points that credit late - Bing daily
// offers in particular - get picked up without a manual run.
const rerunController = new RerunController({
    pm,
    projectRoot,
    readSchedule,
    loadAccounts,
    buildExcludedEnv: buildExcludedAccountsEnv
}).attach()
```

Asegúrate de que `loadAccounts` está importado desde `./accounts.js` en la cabecera del fichero; si no lo está, añádelo a la lista de imports existente.

- [ ] **Step 2: Compón el estado publicado**

Añade junto a `startSelectionFor`:

```js
/**
 * The published status merges the child-process state with the rerun chain.
 * During the cooldown no child exists, so a bare `idle` would tell trigger.js
 * the run had finished - releasing cron's lockfile mid-chain.
 */
function composeStatus() {
    const status = pm.getStatus()
    const rerun = rerunController.getState()
    return {
        ...status,
        state: status.state === 'idle' && rerun.pending ? 'cooldown' : status.state,
        rerun
    }
}
```

Sustituye el manejador `/status` por:

```js
        if (method === 'GET' && pathname === '/status') {
            return sendJson(res, 200, composeStatus())
        }
```

En `handleEventStream`, sustituye `sendEvent('hello', pm.getStatus())` (línea 233) por:

```js
    sendEvent('hello', composeStatus())
```

y sustituye el listener de estado (línea 250) por:

```js
    const onStatus = () => sendEvent('status', composeStatus())
    const onRerunChange = () => sendEvent('status', composeStatus())
```

Registra `rerunController.on('change', onRerunChange)` junto a `pm.on('status', onStatus)`, y añade `rerunController.off('change', onRerunChange)` al bloque de limpieza que ya desengancha los listeners de `pm` cuando se cierra la conexión.

- [ ] **Step 3: Cancela la cadena en `/stop` y reiníciala en los arranques externos**

En el manejador `/stop`, antes de `const stopping = pm.stop({ force })`:

```js
            rerunController.cancel('stop requested')
```

En los manejadores `/start` y `/restart`, justo antes de `pm.start(overrides)` / `pm.restart(overrides)`:

```js
                rerunController.noteExternalStart()
```

Esto es lo que distingue una cadena nueva de la continuación de una existente: el controlador arranca sus propias pasadas llamando a `pm.start()` directamente, sin pasar por HTTP, así que solo los arranques externos llegan aquí.

- [ ] **Step 4: Cancela el temporizador al apagar el contenedor**

Localiza los manejadores de `SIGTERM`/`SIGINT` de `server.js` y añade como primera línea de cada uno:

```js
    rerunController.cancel('shutting down')
```

Si el fichero no tiene manejadores de señal, añádelos justo antes de `server.listen(...)`:

```js
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        rerunController.cancel('shutting down')
        server.close(() => process.exit(0))
    })
}
```

- [ ] **Step 5: Haz que `trigger.js` espere a toda la cadena**

En `scripts/api/trigger.js`, sustituye la condición del bucle de sondeo (línea 141):

```js
        if (s?.state === 'idle') {
```

por:

```js
        // `cooldown` means an automatic rerun pass is pending: the chain has not
        // finished, and returning now would release cron's lockfile too early.
        if (s?.state === 'idle') {
```

y añade justo antes de ese `if`, dentro del `try`:

```js
        if (s?.state === 'cooldown') {
            const at = s.rerun?.nextPassAt ? ` (next pass at ${s.rerun.nextPassAt})` : ''
            console.log(`[trigger] Waiting for the scheduled rerun pass${at}…`)
            continue
        }
```

- [ ] **Step 6: Verifica a mano el estado compuesto**

```bash
node -e "
import('./scripts/api/rerunController.js').then(async ({ RerunController }) => {
  const { EventEmitter } = await import('node:events')
  const pm = new EventEmitter()
  pm.getStatus = () => ({ state: 'idle' })
  pm.note = () => {}
  pm.start = () => ({ pid: 1 })
  const c = new RerunController({
    pm, projectRoot: '.',
    readSchedule: () => ({ excludedAccountIndexes: [], autoRerun: { enabled: true, delayMinutes: 5, maxPasses: 3 } }),
    loadAccounts: () => [{ index: 1, email: 'a@b.c' }],
    buildExcludedEnv: () => ({ env: {}, includedAccounts: [], excludedAccounts: [] }),
    setTimer: () => ({}), clearTimer: () => {}
  }).attach()
  pm.emit('run-complete', { run: { accounts: [{ email: 'a@b.c', collectedPoints: 10, success: true, live: { gained: 10 } }] } })
  const s = pm.getStatus(), r = c.getState()
  console.log(JSON.stringify({ state: s.state === 'idle' && r.pending ? 'cooldown' : s.state, rerun: r }))
})
"
```

Esperado: `{"state":"cooldown","rerun":{"pending":true,"pass":1,"maxPasses":3,...,"accountIndexes":[1]}}`

- [ ] **Step 7: Arranca el servidor y comprueba que responde**

```bash
API_TOKEN= API_PORT=3999 node scripts/api/server.js &
sleep 2
curl -s http://127.0.0.1:3999/status | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('state:',s.state,'rerun:',JSON.stringify(s.rerun))})"
kill %1
```

Esperado: `state: idle rerun: {"pending":false,"pass":1,"maxPasses":null,"nextPassAt":null,"accountIndexes":[]}`

- [ ] **Step 8: Verifica y commitea**

```bash
node --test "scripts/api/**/*.test.js"
npm run lint
git add scripts/api/server.js scripts/api/trigger.js
git commit -m "feat(api): publish a cooldown state while a rerun pass is pending"
```

---

### Task 6: Interfaz — cooldown, conmutador de pausa y ajustes de repesca

**Files:**
- Modify: `scripts/api/ui/views/resumen.js:56` y la tarjeta "Run"
- Modify: `scripts/api/ui/views/cuentas.js:134` y la tabla de cuentas
- Modify: `scripts/api/ui/views/programacion.js`

**Interfaces:**
- Consumes: el campo `rerun` y el estado `cooldown` de `status` (Task 5); `autoRerun` en `/schedule` (Task 1); `PATCH /schedule` acepta `autoRerun` y `excludedAccountIndexes`.
- Produces: nada que consuman otras tareas.

- [ ] **Step 1: `cooldown` cuenta como actividad en ambas vistas**

En `scripts/api/ui/views/resumen.js` línea 56 y en `scripts/api/ui/views/cuentas.js` línea 134, sustituye la lista de estados por la misma en ambos ficheros:

```js
    const busy = ['starting', 'running', 'stopping', 'cooldown'].includes(status?.state)
```

(en `cuentas.js` la expresión es `state?.status?.state`; conserva esa forma y cambia solo la lista).

- [ ] **Step 2: Muestra la cuenta atrás en Resumen**

En `scripts/api/ui/views/resumen.js`, dentro de la tarjeta "Run", sustituye el párrafo del caso sin run (línea 99-100) por:

```js
                : status?.state === 'cooldown'
                ? html`<p style="color:var(--ink-3);margin:0 0 6px">
                    Repesca programada: pasada ${(status.rerun?.pass ?? 1) + 1} de ${status.rerun?.maxPasses ?? '—'}
                    para ${status.rerun?.accountIndexes?.length ?? 0} cuenta(s)${
                        status.rerun?.nextPassAt
                            ? ` a las ${new Date(status.rerun.nextPassAt).toLocaleTimeString('es')}`
                            : ''
                    }.</p>`
                : html`<p style="color:var(--ink-3);margin:0 0 6px">
                    No hay ningún run en marcha.${status?.lastExit ? ` Último proceso terminó con código ${status.lastExit.code}.` : ''}</p>`}
```

En la barra de botones de esa misma tarjeta, el botón *Detener* solo aparece cuando `busy`, y ahora `busy` incluye `cooldown`; `POST /stop` durante el cooldown devolvería 409 porque no hay proceso. Cambia la condición del botón para que en cooldown cancele la cadena en lugar de intentar parar un proceso inexistente:

```js
                    ${status?.state === 'cooldown'
                        ? html`<button class="btn danger" onClick=${() => control('/rerun/cancel', {}, 'Repesca cancelada')}>Cancelar repesca</button>`
                        : busy
                        ? html`<button class="btn danger" onClick=${() => control('/stop', {}, 'Parada solicitada')}>Detener</button>`
                        : html`<button class="btn primary" onClick=${() => control('/start', {}, 'Run iniciado')}>Iniciar run</button>`}
```

- [ ] **Step 3: Añade el endpoint `/rerun/cancel`**

En `scripts/api/server.js`, junto al manejador `/stop`:

```js
        // cancel a pending rerun pass without touching any running process
        if (method === 'POST' && pathname === '/rerun/cancel') {
            const pending = rerunController.getState().pending
            rerunController.cancel('cancelled from the dashboard')
            return sendJson(res, pending ? 202 : 409, {
                cancelled: pending,
                ...(pending ? {} : { error: 'No rerun pass is pending.', code: 'NOT_PENDING' })
            })
        }
```

Añade `POST /rerun/cancel` a la lista de rutas que devuelve el índice de la API (sobre la línea 324, junto a `'POST /start'`).

- [ ] **Step 4: Conmutador *Pausada* en la vista Cuentas**

En `scripts/api/ui/views/cuentas.js`, dentro de `Cuentas`, añade tras el `useEffect(load, [])`:

```js
    const [paused, setPaused] = useState([])
    useEffect(() => {
        api('/schedule').then(s => setPaused(s.excludedAccountIndexes ?? [])).catch(() => setPaused([]))
    }, [])

    const togglePaused = async a => {
        const next = paused.includes(a.index) ? paused.filter(i => i !== a.index) : [...paused, a.index].sort((x, y) => x - y)
        try {
            const updated = await api('/schedule', { method: 'PATCH', body: { excludedAccountIndexes: next } })
            setPaused(updated.excludedAccountIndexes ?? next)
            toast(next.includes(a.index) ? `${a.email} pausada` : `${a.email} reactivada`)
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) toast('Escritura desactivada: pon API_ALLOW_SCHEDULE_WRITE=true y reinicia la API', 'err')
            else toast(err instanceof ApiError ? err.message : 'Sin conexión con la API', 'err')
        }
    }
```

Añade una columna a la cabecera de la tabla (línea 219), entre `Cuenta` y `Región`:

```js
                <thead><tr><th>Cuenta</th><th>Estado</th><th>Región</th><th class="num">Puntos</th><th class="num">Recogido</th><th class="num">Racha</th>
                    <th>Sesiones</th><th>Último run</th><th></th></tr></thead>
```

y la celda correspondiente en cada fila, justo tras `<td class="em">${a.email}</td>`:

```js
                        <td><button class=${'fchip' + (paused.includes(a.index) ? ' on' : '')}
                            title=${paused.includes(a.index)
                                ? 'Pausada: no entra en los runs automáticos ni en las repescas'
                                : 'Activa: entra en todos los runs'}
                            onClick=${() => togglePaused(a)}>${paused.includes(a.index) ? '⏸ pausada' : '▶ activa'}</button></td>
```

Actualiza también el texto del botón de ejecución individual para que se entienda que una pausa no lo bloquea (línea 236):

```js
                            <button class="icon-btn" title="Ejecutar solo esta cuenta (ignora la pausa)" disabled=${busy}
                                onClick=${() => runOne(a)}>▶</button>
```

- [ ] **Step 5: Ajustes de repesca en la vista Programación**

En `scripts/api/ui/views/programacion.js`, añade `autoRerun` al borrador inicial (línea 30-35):

```js
            setDraft({
                enabled: Boolean(s.enabled),
                cron: s.cron ?? '',
                skipIfRunning: s.skipIfRunning !== false,
                excludedAccountIndexes: s.excludedAccountIndexes ?? [],
                autoRerun: {
                    enabled: s.autoRerun?.enabled !== false,
                    delayMinutes: s.autoRerun?.delayMinutes ?? 5,
                    maxPasses: s.autoRerun?.maxPasses ?? 3
                }
            })
```

Cambia el rótulo de la sección de exclusiones (línea 121-122), que ahora afecta a todos los runs y no solo al programado:

```js
                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3);margin-bottom:6px">
                        Cuentas pausadas (excluidas de todos los runs)</div>
```

Añade una tarjeta nueva tras la de "Horario", dentro del mismo `<div class="cols">`:

```js
            <div class="card">
                <div class="row" style="justify-content:space-between">
                    <b style="font-size:13.5px">Repesca automática</b>
                    <label class="row" style="gap:6px;font-size:12.5px;color:var(--ink-2)">
                        <input type="checkbox" checked=${draft.autoRerun.enabled} disabled=${!writable}
                            onInput=${e => setField({ autoRerun: { ...draft.autoRerun, enabled: e.target.checked } })} /> activada
                    </label>
                </div>
                <p style="font-size:12.5px;color:var(--ink-3);margin:8px 0 0">
                    Al terminar un run se repiten las cuentas que ganaron puntos o fallaron, por si quedaron
                    créditos pendientes de acreditar.</p>
                <div class="row mt" style="gap:16px">
                    <label style="font-size:12.5px;color:var(--ink-2)">Espera (min)
                        <input type="number" min="1" max="120" style="width:70px;margin-left:8px" disabled=${!writable}
                            value=${draft.autoRerun.delayMinutes}
                            onInput=${e => setField({ autoRerun: { ...draft.autoRerun, delayMinutes: Number(e.target.value) } })} />
                    </label>
                    <label style="font-size:12.5px;color:var(--ink-2)">Pasadas totales
                        <input type="number" min="1" max="10" style="width:70px;margin-left:8px" disabled=${!writable}
                            value=${draft.autoRerun.maxPasses}
                            onInput=${e => setField({ autoRerun: { ...draft.autoRerun, maxPasses: Number(e.target.value) } })} />
                    </label>
                </div>
                <p style="font-size:11.5px;color:var(--ink-3);margin-top:10px">
                    Incluye el run principal: 3 significa el run inicial más 2 repescas. 1 desactiva la repesca.</p>
            </div>
```

- [ ] **Step 6: Comprueba la interfaz a mano**

```bash
API_TOKEN= API_PORT=3999 API_ALLOW_SCHEDULE_WRITE=true node scripts/api/server.js
```

Abre `http://127.0.0.1:3999/ui` y comprueba:
1. Programación muestra la tarjeta "Repesca automática" con 5 min y 3 pasadas, y guardar aplica los cambios sin error.
2. Cuentas muestra la columna Estado con el chip `▶ activa`; al pulsarlo pasa a `⏸ pausada` y sale el aviso.
3. Recargando la página, la cuenta sigue pausada.
4. La consola del navegador no muestra errores.

Detén el servidor con Ctrl+C.

- [ ] **Step 7: Verifica y commitea**

```bash
node --test "scripts/api/**/*.test.js"
npm run lint
git add scripts/api/ui/views/resumen.js scripts/api/ui/views/cuentas.js scripts/api/ui/views/programacion.js scripts/api/server.js
git commit -m "feat(ui): show the rerun cooldown and let accounts be paused from Cuentas"
```

---

### Task 7: El bot identifica la pasada

Sin esto llegarían hasta tres correos de resumen indistinguibles y el log no diría de qué pasada es cada run.

**Files:**
- Modify: `src/index.ts:271-300` (`run`), `src/index.ts:322-348` (`sendSummaryEmail`)
- Test: `src/util/RunSummary.test.ts` no aplica; la comprobación es de compilación y manual.

**Interfaces:**
- Consumes: la variable de entorno `RERUN_PASS` que inyecta `RerunController._startNextPass` (Task 3).
- Produces: nada que consuman otras tareas.

- [ ] **Step 1: Añade el sufijo de pasada**

En `src/index.ts`, justo antes del método `run()` (sobre la línea 271), añade este método privado a la clase:

```typescript
    /**
     * The API server chains extra passes after a run to pick up points that
     * credit late, and marks each one with RERUN_PASS. Surfacing it keeps the
     * log and the summary emails distinguishable.
     */
    private rerunPassLabel(): string {
        const pass = Number(process.env.RERUN_PASS)
        return Number.isSafeInteger(pass) && pass > 1 ? ` | Pass: ${pass}` : ''
    }
```

En `run()`, cambia la llamada de `RUN-START` para añadir el sufijo **al final** del mensaje:

```typescript
        this.logger.info(
            'main',
            'RUN-START',
            `Starting Microsoft Rewards Script | v${pkg.version} | Accounts: ${totalAccounts} | Clusters: ${this.config.clusters}${this.rerunPassLabel()}`
        )
```

El sufijo va al final a propósito: el parser del dashboard usa
`/^Starting Microsoft Rewards Script \| v(\S+) \| Accounts: (\d+) \| Clusters: (\d+)/`
([`scripts/api/logParser.js:94`](../../../scripts/api/logParser.js)), sin anclaje de fin, así que solo sigue casando si nada se intercala en medio.

En el correo de inicio de `run()`, cambia el asunto:

```typescript
            void sendEmail(
                `Rewards: run iniciado (${totalAccounts} cuentas)${this.rerunPassLabel().replace(' | Pass:', ' · repesca')}`,
```

En `sendSummaryEmail`, cambia el asunto de la última línea:

```typescript
        await sendEmail(
            `Rewards: resumen ${okCount}/${stats.length} (+${totalCollected} pts)${this.rerunPassLabel().replace(' | Pass:', ' · repesca')}`,
            body
        )
```

- [ ] **Step 2: Compila y comprueba el parser**

```bash
npm run build
node -e "
const { parseLogLine, createRunState, applyLogToRunState, summarizeRunState } = require('./scripts/api/logParser.js');
" 2>/dev/null || node --input-type=module -e "
import { parseLogLine, createRunState, applyLogToRunState, summarizeRunState } from './scripts/api/logParser.js'
const state = createRunState()
const line = '[2026-08-05T10:00:00.000Z] [PID] [INFO] [main] [RUN-START] Starting Microsoft Rewards Script | v1.0.0 | Accounts: 3 | Clusters: 1 | Pass: 2'
applyLogToRunState(state, parseLogLine(line, 'stdout'))
console.log('version:', summarizeRunState(state).version, 'accountsTotal:', summarizeRunState(state).accountsTotal)
"
```

Esperado: `version: 1.0.0 accountsTotal: 3` — el sufijo no rompe el parser.

Si la línea de ejemplo no casa por diferencias en el prefijo del log, ajusta el prefijo copiando uno real de `docker logs` o de una ejecución local; lo que se comprueba es únicamente que el sufijo ` | Pass: 2` no impida el reconocimiento.

- [ ] **Step 3: Verifica y commitea**

```bash
npm run lint
npm test
git add src/index.ts
git commit -m "feat: label rerun passes in the run log and summary emails"
```

---

### Task 8: Documentación

**Files:**
- Modify: `README.md`
- Modify: `scripts/api/README.md`
- Modify: `compose.yaml`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: nada.

- [ ] **Step 1: Documenta las variables de entorno en `compose.yaml`**

En el bloque de `environment` de `compose.yaml`, junto al comentario existente de `API_MODE`, añade:

```yaml
            # Repesca automática (solo con API_MODE=true). Tras cada run se repiten
            # las cuentas que ganaron puntos o fallaron, por si quedaron créditos
            # pendientes de acreditar. AUTO_RERUN_MAX_PASSES cuenta el run principal.
            #AUTO_RERUN: 'true'
            #AUTO_RERUN_DELAY_MINUTES: '5'
            #AUTO_RERUN_MAX_PASSES: '3'
```

- [ ] **Step 2: Documenta el endpoint y la configuración en `scripts/api/README.md`**

Añade, en la sección donde se documentan los endpoints, junto a `POST /stop`:

```markdown
### `POST /rerun/cancel`

Cancela la pasada de repesca pendiente sin tocar ningún proceso en ejecución.
Devuelve `202` si había una programada y `409` con `code: "NOT_PENDING"` si no.

### Selección de cuentas en `POST /start`

Una petición sin `accountIndex` ni `excludedAccountIndexes` ejecuta **todas las
cuentas que no estén pausadas** en `config/schedule.json`. Para ejecutarlas todas
ignorando las pausas, manda `excludedAccountIndexes: []` explícitamente. Un
`accountIndex` concreto ejecuta esa cuenta aunque esté pausada.
Si todas están pausadas, devuelve `409` con `code: "ALL_PAUSED"`.

### Repesca automática

`GET /status` devuelve `state: "cooldown"` mientras hay una pasada programada, y
un bloque `rerun` con `{ pending, pass, maxPasses, nextPassAt, accountIndexes }`.
Se configura en `config/schedule.json`:

```json
"autoRerun": { "enabled": true, "delayMinutes": 5, "maxPasses": 3 }
```

con defectos tomados de `AUTO_RERUN`, `AUTO_RERUN_DELAY_MINUTES` y
`AUTO_RERUN_MAX_PASSES`. `maxPasses` cuenta pasadas totales, incluida la
principal: 3 significa el run inicial más 2 repescas, y 1 desactiva la repesca.
```

- [ ] **Step 3: Documenta el comportamiento en `README.md`**

Añade una subsección tras la de "How activities are claimed":

```markdown
### Automatic rerun passes

Some credits arrive asynchronously — Bing daily offers in particular can land
half a minute after the account has already been closed — so a single pass
regularly leaves points behind. When running with `API_MODE=true`, the control
API chains extra passes: after a run finishes it waits `delayMinutes` and runs
again with only the accounts that gained points or failed, up to `maxPasses`
total passes (the initial run included). A run stopped by hand never chains.

Configured in `config/schedule.json` under `autoRerun`, or via the
`AUTO_RERUN`, `AUTO_RERUN_DELAY_MINUTES` and `AUTO_RERUN_MAX_PASSES` environment
variables. Each pass is a separate run in the history and carries `RERUN_PASS`
in its environment, which the bot echoes into its `RUN-START` line.

### Pausing an account

`excludedAccountIndexes` in `config/schedule.json` — the *Cuentas pausadas*
chips in the dashboard, or the per-account toggle in the Cuentas view — keeps an
account out of every run: cron, the dashboard's start button and the automatic
rerun passes alike. Starting a run with an explicit `accountIndex` still runs
that account, since naming a slot is a deliberate override.
```

- [ ] **Step 4: Actualiza `CLAUDE.md`**

Añade a la sección de notas del fork, tras el bloque de mecanismos de reclamación:

```markdown
### Repesca automática y pausa de cuentas

`scripts/api/rerunController.js` encadena pasadas tras cada run (solo en
`API_MODE=true`): repite las cuentas que ganaron puntos o fallaron, hasta
`autoRerun.maxPasses` pasadas **totales**. `decideNextPass` es puro y concentra
todas las reglas; `RerunController` sólo orquesta.

`excludedAccountIndexes` de `config/schedule.json` es la única fuente de verdad
de "cuenta pausada" y la aplican `POST /start` y `POST /restart` cuando la
petición no trae selección explícita (`scripts/api/startSelection.js`).

**El proceso hijo renumera los slots a `ACCOUNT_1..N`**, así que el índice que
aparece en sus logs no es el real: la única clave de unión válida entre un run y
la configuración es el email.
```

- [ ] **Step 5: Commit**

```bash
git add README.md scripts/api/README.md compose.yaml CLAUDE.md
git commit -m "docs: document automatic rerun passes and global account pause"
```

---

### Task 9: Verificación de extremo a extremo antes del despliegue

**Files:** ninguno (solo comprobación).

- [ ] **Step 1: Suite completa**

```bash
npm run lint
npm run build
npm test
```

Esperado: lint limpio, build sin errores, y ambas suites en verde: 49 pruebas en `src` y 86 en `scripts/api` (las 50 que ya había más 7 de la Task 1, 11 de la Task 2, 10 de la Task 3 y 8 de la Task 4).

- [ ] **Step 2: Ensayo de la cadena con un cooldown corto**

```bash
API_TOKEN= API_PORT=3999 API_ALLOW_SCHEDULE_WRITE=true AUTO_RERUN=true AUTO_RERUN_DELAY_MINUTES=1 AUTO_RERUN_MAX_PASSES=2 node scripts/api/server.js
```

En otra terminal, comprueba que la configuración se publica:

```bash
curl -s http://127.0.0.1:3999/schedule | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).autoRerun))"
```

Esperado: `{ enabled: true, delayMinutes: 1, maxPasses: 2 }`

Comprueba que `/rerun/cancel` responde correctamente cuando no hay nada pendiente:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3999/rerun/cancel
```

Esperado: `409`

Detén el servidor con Ctrl+C.

- [ ] **Step 3: Commit final si algo quedó suelto**

```bash
git status --short
```

Esperado: árbol limpio. Si no lo está, revisa qué quedó sin commitear y decide dónde encaja.

---

## Despliegue

El despliegue lo ejecuta el operador humano (o quien conduzca el plan) tras la revisión de rama, siguiendo el flujo ya establecido en `CLAUDE.md`:

```bash
git archive main | ssh -i ~/.ssh/oci_vm.key opc@82.70.87.42 "tar -xzf - -C ~/rewards --exclude=compose.yaml"
ssh -i ~/.ssh/oci_vm.key opc@82.70.87.42 "cd ~/rewards && docker compose build && docker compose up -d"
```

Recuerda que `compose.yaml`, `.env` y `config/config.json` del VM son locales de la máquina y no se sobrescriben. Como `autoRerun` toma sus defectos del entorno y el VM no tiene `AUTO_RERUN*` definido, la repesca arrancará con los defectos del código (activada, 5 min, 3 pasadas), que es justo lo pedido — no hace falta tocar el `compose.yaml` del VM salvo que se quiera otro valor.

Verificación posterior:

```bash
ssh -i ~/.ssh/oci_vm.key opc@82.70.87.42 "docker logs --tail 50 microsoft-rewards-script"
curl -s http://82.70.87.42:3010/schedule -H "Authorization: Bearer <API_TOKEN>" | grep autoRerun
```

y, tras el siguiente run, buscar en el log las líneas `[AUTO-RERUN]`.
