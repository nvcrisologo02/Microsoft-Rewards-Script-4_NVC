# Welcometour y agregación de cadenas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reclamar las actividades `welcometour` (50 pts por cuenta nueva) y hacer que la vista Cuentas muestre el agregado de una cadena de repescas en vez de solo la última pasada, recuperando de paso el contador de racha que se oculta tras registros con el contador a `null`.

**Architecture:** El welcometour reutiliza el camino de reporte de `UrlReward` parametrizado con un `source` y una etiqueta de log. La agregación estampa `chainId`/`pass` en cada registro del historial desde el `RerunController` y agrupa por cadena dentro de `mergeAccountStats`, que es puro. El arreglo de la racha separa en dos búsquedas independientes lo que hoy es una sola.

**Tech Stack:** TypeScript estricto en `src/`, JavaScript ESM puro en `scripts/api/`, `node:test` + `node:assert/strict`, Zod para validar config.

Spec: [`docs/superpowers/specs/2026-08-05-welcometour-and-chain-aggregation-design.md`](../specs/2026-08-05-welcometour-and-chain-aggregation-design.md)

## Global Constraints

- **`scripts/api/**` es JavaScript ESM puro, nunca TypeScript.** Imports con extensión `.js`.
- **Los mensajes de la API, los comentarios y los logs del bot van en inglés**; los textos de la interfaz y los nombres de prueba en `src/functions/*.test.ts` van en español, siguiendo `LinkOffers.test.ts`.
- **Un registro de historial sin `chainId` es una cadena de una sola pasada.** Los 51 registros que ya existen en el VM no se migran y deben seguir leyéndose bien.
- **Convención de config del fork:** un flag nuevo va a `config.example.json` (versionado) **y** al `config.json` local, que nunca se commitea. Además necesita entrada en `src/interface/Config.ts`, defecto en `src/util/Validator.ts`, línea `_cfg` más entrada en el bloque de documentación de `scripts/docker/entrypoint.sh`, y fila en la tabla del README.
- Formato: 4 espacios, comillas simples, sin punto y coma final.
- Verificación antes de cada commit: `npm run lint` y las pruebas de la tarea. `npm run build` en las tareas que tocan `src/`.

---

### Task 1: Reclamar el welcometour

**Files:**
- Modify: `src/functions/activities/api/UrlReward.ts`
- Modify: `src/functions/Activities.ts:61-64`
- Modify: `src/functions/Workers.ts:728-808` (switch de `solveActivities`)
- Modify: `src/interface/Config.ts:74-80` (`ConfigActivities`)
- Modify: `src/util/Validator.ts:106-113`
- Modify: `config.example.json`
- Modify: `scripts/docker/entrypoint.sh:120` y `:392`
- Modify: `README.md` (tabla de Activities)
- Test: `src/functions/WelcomeTour.test.ts` (nuevo)

**Interfaces:**
- Consumes: `reportOfferActivity(bot, live, promotion, source)` de `src/functions/activities/api/ReportPromotion.ts`, ya existente.
- Produces:
  - `UrlReward.doUrlReward(promotion, options?)` donde `options` es `{ source?: string; tag?: string }`, con defectos `{ source: 'activity', tag: 'URL-REWARD' }`.
  - `Activities.doUrlReward(promotion, options?)` con la misma firma.
  - `export function welcomeTourOptions(): { source: string; tag: string }` en `src/functions/activities/api/UrlReward.ts`, devolviendo `{ source: 'welcomeTour', tag: 'WELCOME-TOUR' }`. Existe para que la prueba fije los literales sin depender del switch.
  - `config.activities.welcomeTour: boolean`, por defecto `true`.

- [ ] **Step 1: Escribe la prueba que falla**

Crea `src/functions/WelcomeTour.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { welcomeTourOptions } from './activities/api/UrlReward'

test('el welcometour se atribuye a su propio origen', () => {
    assert.deepEqual(welcomeTourOptions(), { source: 'welcomeTour', tag: 'WELCOME-TOUR' })
})

test('el origen no es el genérico de actividad, para poder distinguirlo en bySource', () => {
    assert.notEqual(welcomeTourOptions().source, 'activity')
})
```

- [ ] **Step 2: Ejecuta y comprueba que falla**

```bash
node --require ts-node/register --test src/functions/WelcomeTour.test.ts
```

Esperado: FAIL, `welcomeTourOptions` no existe.

- [ ] **Step 3: Parametriza `UrlReward`**

En `src/functions/activities/api/UrlReward.ts`, añade arriba del `export class`:

```typescript
export interface UrlRewardOptions {
    /** Attributes the credit in the bySource breakdown. */
    source?: string
    /** Log tag, so a caller-specific mechanism is greppable on its own. */
    tag?: string
}

/**
 * The welcome tour is a one-off Gamification FRE offer (50 points) that claims
 * exactly like a urlreward - the same reportActivity server action - so it
 * reuses this path rather than duplicating it. Its own source keeps it
 * distinguishable in the points breakdown, which is how we find out whether the
 * server action alone is enough.
 */
export function welcomeTourOptions(): { source: string; tag: string } {
    return { source: 'welcomeTour', tag: 'WELCOME-TOUR' }
}
```

Cambia la firma pública y propaga las opciones:

```typescript
    public async doUrlReward(promotion: BasePromotion, options: UrlRewardOptions = {}) {
        await this.runUrlReward(promotion, true, options)
    }

    private async runUrlReward(promotion: BasePromotion, allowSessionRepair: boolean, options: UrlRewardOptions = {}) {
        const offerId = promotion.offerId
        const tag = options.tag ?? 'URL-REWARD'
        const source = options.source ?? 'activity'
```

Sustituye **todas** las apariciones del literal `'URL-REWARD'` en el cuerpo de `runUrlReward` por la variable `tag`. Localízalas con `grep -n "'URL-REWARD'" src/functions/activities/api/UrlReward.ts` y comprueba con el mismo comando que no queda ninguna al terminar.

Pasa el `source` al reporte:

```typescript
            const { status, acknowledged, gained: gainedPoints, newBalance } = await reportOfferActivity(this.bot, live, promotion, source)
```

Y propaga las opciones en el reintento con sesión reparada:

```typescript
                        await this.runUrlReward(promotion, false, options)
```

En los mensajes de log de ese método, sustituye el texto literal `UrlReward` por `${tag}` **solo donde nombra el mecanismo**, no en `doUrlReward` del mensaje de error (que nombra el método). Concretamente:
- `` `Starting UrlReward | offerId=...` `` → `` `Starting ${tag} | offerId=...` ``
- `` `Completed UrlReward | offerId=...` `` → `` `Completed ${tag} | offerId=...` ``
- `` `Completed UrlReward (no points by design) | ...` `` → `` `Completed ${tag} (no points by design) | ...` ``
- `` `UrlReward credited no points | ...` `` → `` `${tag} credited no points | ...` ``
- `` `Retrying UrlReward once with the refreshed session | ...` `` → `` `Retrying ${tag} once with the refreshed session | ...` ``

- [ ] **Step 4: Propaga en `Activities.ts`**

En `src/functions/Activities.ts`, sustituye el método:

```typescript
    doUrlReward = async (promotion: BasePromotion, options?: UrlRewardOptions): Promise<void> => {
        const urlReward = new UrlReward(this.bot)
        await urlReward.doUrlReward(promotion, options)
    }
```

y añade el tipo al import existente de `UrlReward`:

```typescript
import { UrlReward, type UrlRewardOptions } from './activities/api/UrlReward'
```

Si el import actual no es nombrado, ajústalo conservando lo que ya importa.

- [ ] **Step 5: Añade el flag de configuración**

En `src/interface/Config.ts`, dentro de `ConfigActivities`, tras `linkOffers`:

```typescript
    welcomeTour: boolean
```

En `src/util/Validator.ts`, sustituye el bloque `activities`:

```typescript
    activities: z
        .object({
            urlReward: z.boolean().default(true),
            searchOnBing: z.boolean().default(true),
            quiz: z.boolean().default(true),
            linkOffers: z.boolean().default(true),
            welcomeTour: z.boolean().default(true)
        })
        .default({ urlReward: true, searchOnBing: true, quiz: true, linkOffers: true, welcomeTour: true }),
```

En `config.example.json`, dentro de `activities`, tras `"linkOffers": true`:

```json
        "welcomeTour": true
```

Haz el mismo añadido en el `config.json` local (que está gitignorado y **no** se commitea).

En `scripts/docker/entrypoint.sh`, tras la línea 120 del bloque de documentación:

```sh
#      CONFIG_ACTIVITY_WELCOME_TOUR      → .activities.welcomeTour
```

y tras la línea 392:

```sh
_cfg "${CONFIG_ACTIVITY_WELCOME_TOUR:-}"   '.activities.welcomeTour'                bool
```

- [ ] **Step 6: Añade el caso al switch**

En `src/functions/Workers.ts`, dentro del `switch (type)` de `solveActivities`, entre el `case 'quiz'` y el `default`:

```typescript
                    case 'welcometour': {
                        const basePromotion = activity as BasePromotion

                        if (!this.bot.config.activities.welcomeTour) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Skipping "WelcomeTour" (disabled in config) | offerId=${offerId}`
                            )
                            continue
                        }

                        this.bot.logger.info(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Found activity type "WelcomeTour" | title="${activity.title}" | offerId=${offerId}`
                        )

                        await this.bot.activities.doUrlReward(basePromotion, welcomeTourOptions())
                        break
                    }
```

El `continue` cuando está desactivado es deliberado: saltarlo por configuración es una decisión, no un hueco, así que no debe caer en `default` ni contarse en `ACTIVITY-GAPS`.

Añade el import al principio de `Workers.ts`, junto a los demás:

```typescript
import { welcomeTourOptions } from './activities/api/UrlReward'
```

Si eso crea un ciclo de imports (UrlReward extiende Workers), mueve `welcomeTourOptions` y `UrlRewardOptions` a un fichero nuevo `src/functions/activities/api/UrlRewardOptions.ts` y haz que tanto `UrlReward.ts` como `Workers.ts` importen de ahí. Comprueba cuál de los dos hace falta ejecutando el paso 7: un ciclo se manifiesta como `welcomeTourOptions is not a function` en tiempo de ejecución, no como error de compilación.

- [ ] **Step 7: Ejecuta las pruebas y compila**

```bash
node --require ts-node/register --test src/functions/WelcomeTour.test.ts
npm run build
npm run lint
```

Esperado: 2 pruebas PASS, build sin errores, lint sin errores nuevos (hay 1 warning preexistente en `src/interface/DashboardData.ts`).

- [ ] **Step 8: Comprueba que no hay ciclo de imports en tiempo de ejecución**

```bash
node -e "
const { welcomeTourOptions } = require('./dist/functions/activities/api/UrlReward.js')
console.log('welcomeTourOptions ->', JSON.stringify(welcomeTourOptions()))
"
```

Esperado: `welcomeTourOptions -> {"source":"welcomeTour","tag":"WELCOME-TOUR"}`

Si sale `undefined` o `not a function`, aplica la separación a `UrlRewardOptions.ts` descrita en el paso 6 y repite.

- [ ] **Step 9: Documenta en el README**

En `README.md`, en la tabla de la sección Activities donde ya aparecen `urlReward`, `quiz` y `linkOffers`, añade una fila:

```markdown
| `welcomeTour` | Claims the one-off "welcome tour" onboarding offer (`welcometour`, 50 points). Appears on mobile for newly created accounts and is claimed through the same server action as a url reward, attributed to `welcomeTour` in the `bySource` breakdown. |
```

Ajusta el número de columnas al de la tabla existente.

- [ ] **Step 10: Commit**

```bash
git add src/ config.example.json scripts/docker/entrypoint.sh README.md
git commit -m "feat: claim welcome tour offers through the url reward path"
```

---

### Task 2: `chainId` y `pass` en los registros del historial

**Files:**
- Modify: `scripts/api/rerunController.js`
- Modify: `scripts/api/server.js` (`toHistoryRecord`)
- Test: `scripts/api/rerunController.test.js`

**Interfaces:**
- Consumes: `RerunController` de la Task anterior del proyecto de repesca, ya en `main`.
- Produces:
  - `controller.getState()` gana dos campos: `chainId: string | null` y mantiene `pass`.
  - Cada registro escrito por `appendRun` gana `chainId: string` y `pass: number`.

- [ ] **Step 1: Escribe las pruebas que fallan**

Añade al final de `scripts/api/rerunController.test.js`:

```js
test('la primera pasada fija el chainId a su propio startedAt', () => {
    const { pm, controller } = makeHarness()
    pm.emit('run-complete', {
        startedAt: '2026-08-05T05:49:00.000Z',
        endedAt: '2026-08-05T09:54:00.000Z',
        exit: { code: 0 },
        run: { accounts: [acc('uno@example.com', { collectedPoints: 30 })] }
    })
    assert.equal(controller.getState().chainId, '2026-08-05T05:49:00.000Z')
})

test('las pasadas siguientes heredan el chainId de la primera', () => {
    const { pm, controller, fire } = makeHarness()
    const first = {
        startedAt: '2026-08-05T05:49:00.000Z',
        endedAt: '2026-08-05T09:54:00.000Z',
        exit: { code: 0 },
        run: { accounts: [acc('uno@example.com', { collectedPoints: 30 })] }
    }
    pm.emit('run-complete', first)
    fire()
    pm.emit('run-complete', {
        startedAt: '2026-08-05T09:59:00.000Z',
        endedAt: '2026-08-05T10:24:00.000Z',
        exit: { code: 0 },
        run: { accounts: [acc('uno@example.com', { collectedPoints: 20 })] }
    })
    assert.equal(controller.getState().chainId, '2026-08-05T05:49:00.000Z')
    assert.equal(controller.getState().pass, 2)
})

test('noteExternalStart estrena cadena', () => {
    const { pm, controller } = makeHarness()
    pm.emit('run-complete', {
        startedAt: '2026-08-05T05:49:00.000Z',
        endedAt: '2026-08-05T09:54:00.000Z',
        exit: { code: 0 },
        run: { accounts: [acc('uno@example.com', { collectedPoints: 30 })] }
    })
    assert.equal(controller.getState().chainId, '2026-08-05T05:49:00.000Z')

    controller.noteExternalStart()
    assert.equal(controller.getState().chainId, null)
    assert.equal(controller.getState().pass, 1)
})
```

- [ ] **Step 2: Ejecuta y comprueba que fallan**

```bash
node --test scripts/api/rerunController.test.js
```

Esperado: FAIL, `chainId` es `undefined` en `getState()`.

- [ ] **Step 3: Implementa el `chainId` en el controlador**

En `scripts/api/rerunController.js`, dentro del constructor de `RerunController`, junto a `this.pass = 1`:

```js
        this.chainId = null
```

En `getState()`, añade el campo al objeto devuelto:

```js
            chainId: this.chainId,
```

En `noteExternalStart()`, junto a `this.pass = 1`:

```js
        this.chainId = null
```

En `_onRunComplete(entry)`, como **primera** sentencia dentro del `try` exterior, antes de leer el schedule:

```js
            // The first pass of a chain names it. Later passes inherit the id,
            // which is what lets the dashboard aggregate them as one run.
            if (this.chainId == null && typeof entry?.startedAt === 'string') {
                this.chainId = entry.startedAt
            }
```

- [ ] **Step 4: Ejecuta las pruebas**

```bash
node --test scripts/api/rerunController.test.js
```

Esperado: PASS, 24 pruebas (21 previas + 3 nuevas).

- [ ] **Step 5: Estampa los campos en el registro del historial**

En `scripts/api/server.js`, en `toHistoryRecord`, añade los dos campos al objeto devuelto, justo después de `endedAt`:

```js
        // Passes of one rerun chain share a chainId, so the dashboard can show
        // the chain as a single run. Records written before this existed have
        // no chainId and each counts as a chain of one.
        chainId: rerunController.getState().chainId ?? entry.startedAt,
        pass: rerunController.getState().pass,
```

`toHistoryRecord` se invoca desde el manejador de `run-complete` que `server.js` registra, y ese manejador corre **después** del que instala `RerunController.attach()`, porque `attach()` se ejecuta antes en el fichero. Comprueba ese orden: el bloque `pm.on('run-complete', …)` que persiste el historial debe quedar **después** de la construcción de `rerunController`. Si no lo está, muévelo.

- [ ] **Step 6: Verifica el orden de los listeners**

```bash
node --input-type=module -e "
import { EventEmitter } from 'node:events'
import { RerunController } from './scripts/api/rerunController.js'
const pm = new EventEmitter()
pm.note = () => {}
pm.start = () => ({ pid: 1 })
const c = new RerunController({
  pm, projectRoot: '.',
  readSchedule: () => ({ excludedAccountIndexes: [], autoRerun: { enabled: false, delayMinutes: 5, maxPasses: 3 } }),
  loadAccounts: () => [{ index: 1, email: 'a@b.c' }],
  buildExcludedEnv: () => ({ env: {}, includedAccounts: [], excludedAccounts: [] }),
  setTimer: () => ({}), clearTimer: () => {}
}).attach()
let seen = null
pm.on('run-complete', e => { seen = { chainId: c.getState().chainId ?? e.startedAt, pass: c.getState().pass } })
pm.emit('run-complete', { startedAt: '2026-08-05T05:49:00.000Z', run: { accounts: [] } })
console.log(JSON.stringify(seen))
"
```

Esperado: `{"chainId":"2026-08-05T05:49:00.000Z","pass":1}` — confirma que el listener del historial ve el `chainId` ya fijado.

- [ ] **Step 7: Verifica y commitea**

```bash
node --test "scripts/api/**/*.test.js"
npm run lint
git add scripts/api/rerunController.js scripts/api/rerunController.test.js scripts/api/server.js
git commit -m "feat(api): stamp chain id and pass number on history records"
```

---

### Task 3: Agregación por cadena y arreglo del contador de racha

**Files:**
- Modify: `scripts/api/accounts.js:153-197` (`mergeAccountStats`)
- Test: `scripts/api/accounts.test.js` (nuevo)

**Interfaces:**
- Consumes: `chainId` y `pass` en los registros, de la Task 2.
- Produces: `mergeAccountStats(accounts, runs)` mantiene su firma y los nombres de todos los campos que devuelve. Cambia su semántica: `runs` cuenta cadenas, `lastCollected` es el total de la última cadena, y `streakCounter` se resuelve por separado de `streakProtection`.

- [ ] **Step 1: Escribe las pruebas que fallan**

Crea `scripts/api/accounts.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { mergeAccountStats } from './accounts.js'

const ACCOUNTS = [{ index: 1, email: 'uno@example.com', emailKey: 'uno@example.com' }]

/** Newest-first, the order combineRuns hands to mergeAccountStats. */
function run(startedAt, { chainId, pass, collected, balance, success = true, streak } = {}) {
    return {
        startedAt,
        endedAt: startedAt,
        ...(chainId !== undefined ? { chainId } : {}),
        ...(pass !== undefined ? { pass } : {}),
        accounts: [
            {
                email: 'uno@example.com',
                collected,
                balance,
                success,
                error: null,
                streakProtection: streak === undefined ? null : streak
            }
        ]
    }
}

test('las pasadas de una cadena se agregan en un solo run', () => {
    const runs = [
        run('2026-08-05T10:30:00Z', { chainId: 'C1', pass: 3, collected: 0, balance: 120 }),
        run('2026-08-05T09:59:00Z', { chainId: 'C1', pass: 2, collected: 20, balance: 120 }),
        run('2026-08-05T05:49:00Z', { chainId: 'C1', pass: 1, collected: 30, balance: 100 })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.runs, 1, 'una cadena es un run')
    assert.equal(a.lastCollected, 50, 'suma de las tres pasadas')
    assert.equal(a.totalCollected, 50)
})

test('el balance de la cadena es el ultimo valor no nulo', () => {
    const runs = [
        run('2026-08-05T10:30:00Z', { chainId: 'C1', pass: 3, collected: 0, balance: null }),
        run('2026-08-05T09:59:00Z', { chainId: 'C1', pass: 2, collected: 20, balance: 120 })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.lastBalance, 120)
})

test('los registros antiguos sin chainId son cada uno su propia cadena', () => {
    const runs = [
        run('2026-08-04T05:49:00Z', { collected: 40, balance: 90 }),
        run('2026-08-03T05:49:00Z', { collected: 35, balance: 50 })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.runs, 2)
    assert.equal(a.lastCollected, 40)
    assert.equal(a.totalCollected, 75)
})

test('registros con y sin chainId conviven', () => {
    const runs = [
        run('2026-08-05T09:59:00Z', { chainId: 'C1', pass: 2, collected: 20, balance: 120 }),
        run('2026-08-05T05:49:00Z', { chainId: 'C1', pass: 1, collected: 30, balance: 100 }),
        run('2026-08-04T05:49:00Z', { collected: 40, balance: 70 })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.runs, 2, 'una cadena de dos pasadas mas un registro antiguo')
    assert.equal(a.lastCollected, 50)
    assert.equal(a.totalCollected, 90)
})

test('el exito de la cadena es el de su ultima pasada', () => {
    const runs = [
        run('2026-08-05T09:59:00Z', { chainId: 'C1', pass: 2, collected: 0, balance: 120, success: false }),
        run('2026-08-05T05:49:00Z', { chainId: 'C1', pass: 1, collected: 30, balance: 100, success: true })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.lastSuccess, false)
})

test('el contador de racha sobrevive a registros que lo traen a null', () => {
    const withCounter = { enabled: true, remainingDays: 2, streakCounter: 21, updatedAt: null }
    const withoutCounter = { enabled: true, remainingDays: 2, streakCounter: null, updatedAt: null }
    const runs = [
        run('2026-08-05T09:59:00Z', { chainId: 'C1', pass: 2, collected: 0, balance: 120, streak: withoutCounter }),
        run('2026-08-05T05:49:00Z', { chainId: 'C1', pass: 1, collected: 30, balance: 100, streak: withoutCounter }),
        run('2026-08-04T05:49:00Z', { collected: 40, balance: 70, streak: withCounter })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.streakCounter, 21, 'retrocede hasta el registro que si lo tiene')
    assert.equal(a.streakProtection.remainingDays, 2)
})

test('sin ningun contador en el historial, streakCounter queda a null', () => {
    const runs = [run('2026-08-05T05:49:00Z', { collected: 10, balance: 20 })]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.streakCounter, null)
    assert.equal(a.streakProtection, null)
})

test('successStreak cuenta cadenas consecutivas correctas', () => {
    const runs = [
        run('2026-08-05T09:59:00Z', { chainId: 'C1', pass: 2, collected: 0, balance: 120 }),
        run('2026-08-05T05:49:00Z', { chainId: 'C1', pass: 1, collected: 30, balance: 100 }),
        run('2026-08-04T05:49:00Z', { chainId: 'C0', pass: 1, collected: 40, balance: 70, success: false })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.successStreak, 1, 'la cadena de ayer fallo y corta la racha')
})

test('no expone la clave interna emailKey', () => {
    const [a] = mergeAccountStats(ACCOUNTS, [run('2026-08-05T05:49:00Z', { collected: 10, balance: 20 })])
    assert.equal('emailKey' in a, false)
})
```

- [ ] **Step 2: Ejecuta y comprueba que fallan**

```bash
node --test scripts/api/accounts.test.js
```

Esperado: FAIL. `a.runs` vale 3 en vez de 1 y `a.lastCollected` vale 0 en vez de 50.

- [ ] **Step 3: Implementa la agregación y el arreglo de la racha**

En `scripts/api/accounts.js`, sustituye `mergeAccountStats` entera por:

```js
/**
 * Groups an account's per-pass records into chains before computing its stats.
 *
 * A rerun chain runs the same account several times; its last pass is by
 * construction the one that finds nothing left, so reading only the most recent
 * record reports zero collected on almost every day. Records written before
 * chainId existed carry none, and each counts as a chain of one.
 */
function groupIntoChains(results) {
    const chains = []
    const byChainId = new Map()

    for (const result of results) {
        const key = result.chainId ?? null
        if (key == null) {
            chains.push([result])
            continue
        }
        const existing = byChainId.get(key)
        if (existing) {
            existing.push(result)
            continue
        }
        const chain = [result]
        byChainId.set(key, chain)
        chains.push(chain)
    }

    // Each chain arrives newest-pass-first, matching the newest-first input.
    return chains.map(passes => ({
        when: passes[0]?.when ?? null,
        collected: passes.reduce((sum, pass) => sum + (pass.collected || 0), 0),
        balance: passes.find(pass => pass.balance != null)?.balance ?? null,
        success: passes[0]?.success ?? null,
        error: passes[0]?.error ?? null
    }))
}

export function mergeAccountStats(accounts, runs) {
    // Index history results by email.
    const byEmail = new Map()
    for (const run of runs) {
        const when = run.endedAt || run.startedAt || null
        for (const acc of run.accounts || []) {
            if (!byEmail.has(acc.email)) byEmail.set(acc.email, [])
            byEmail.get(acc.email).push({ ...acc, when, chainId: run.chainId ?? null })
        }
    }

    return accounts.map(a => {
        const results = byEmail.get(a.emailKey) || [] // already most-recent-first
        const chains = groupIntoChains(results)
        const last = chains[0] || null

        // Two independent lookups on purpose. Sharing one would let a record
        // that carries the protection object but a null counter hide a counter
        // that is still there, a few records further back.
        const streakProtection = results.find(result => result.streakProtection != null)?.streakProtection ?? null
        const streakCounter =
            results.find(result => result.streakProtection?.streakCounter != null)?.streakProtection?.streakCounter ??
            null

        let totalCollected = 0
        for (const chain of chains) totalCollected += chain.collected || 0

        // Consecutive successful chains from the most recent backwards.
        let successStreak = 0
        for (const chain of chains) {
            if (chain.success === true) successStreak++
            else break
        }

        const { emailKey, ...safe } = a
        void emailKey
        return {
            ...safe,
            runs: chains.length,
            totalCollected,
            successStreak,
            lastRunAt: last?.when ?? null,
            lastCollected: last?.collected ?? null,
            lastBalance: last?.balance ?? null,
            lastSuccess: last ? last.success : null,
            lastError: last?.error ?? null,
            streakProtection,
            // Microsoft's real daily streak counter (from the rewards snapshot),
            // distinct from successStreak which counts consecutive successful chains.
            streakCounter
        }
    })
}
```

- [ ] **Step 4: Ejecuta las pruebas**

```bash
node --test scripts/api/accounts.test.js
```

Esperado: PASS, 9 pruebas.

- [ ] **Step 5: Verifica contra el historial real del VM**

Copia el historial real y comprueba que las 9 cuentas recuperan el contador de racha y dejan de mostrar 0:

```bash
ssh -i ~/.ssh/oci_vm.key -o StrictHostKeyChecking=no opc@82.70.87.42 \
    "docker cp microsoft-rewards-script:/usr/src/microsoft-rewards-script/data/history.ndjson /tmp/history.ndjson"
scp -i ~/.ssh/oci_vm.key -o StrictHostKeyChecking=no opc@82.70.87.42:/tmp/history.ndjson /tmp/history.ndjson

node --input-type=module -e "
import fs from 'node:fs'
import { mergeAccountStats } from './scripts/api/accounts.js'
const runs = fs.readFileSync('/tmp/history.ndjson','utf8').split('\n').filter(Boolean).map(JSON.parse)
runs.sort((a,b)=> a.startedAt < b.startedAt ? 1 : -1)
const emails = [...new Set(runs.flatMap(r => (r.accounts||[]).map(a => a.email)))]
const accounts = emails.map((email,i) => ({ index: i+1, email, emailKey: email }))
console.log('%-26s %5s %10s %10s', 'cuenta', 'runs', 'lastColl', 'streakCnt')
for (const a of mergeAccountStats(accounts, runs)) {
  console.log('%-26s %5s %10s %10s', a.email, a.runs, a.lastCollected, a.streakCounter)
}
"
```

Esperado: las cuentas que hoy muestran `streakCnt` a `None` pasan a mostrar su contador (21 o similar), y `lastColl` deja de ser 0 en las que ganaron puntos en alguna pasada. Como los 51 registros actuales no llevan `chainId`, `runs` no bajará todavía y `lastColl` mostrará el de la última pasada — eso es lo correcto para datos antiguos, y a partir del próximo run sí se agruparán.

- [ ] **Step 6: Verifica y commitea**

```bash
node --test "scripts/api/**/*.test.js"
npm run lint
git add scripts/api/accounts.js scripts/api/accounts.test.js
git commit -m "fix(api): aggregate rerun passes per chain and stop hiding the streak counter"
```

---

### Task 4: Documentación

**Files:**
- Modify: `scripts/api/README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: nada.

- [ ] **Step 1: Documenta la agregación en `scripts/api/README.md`**

En la sección que documenta `GET /accounts`, añade:

```markdown
#### Chain aggregation

Each history record carries a `chainId` (shared by every pass of one automatic
rerun chain) and a `pass` number. `/accounts` groups an account's records by
chain before computing its stats, so `runs` counts chains rather than child
processes and `lastCollected` is the whole chain's total.

Without this, the figures would read the last pass of the chain - which is by
construction the one that found nothing left - and report zero collected on
almost every day.

Records written before `chainId` existed carry none; each counts as a chain of
one, so old history keeps reading correctly and needs no migration.

`streakCounter` and `streakProtection` are resolved independently, each walking
back to the most recent record that actually carries it. A record can carry the
protection object with a null counter inside, and sharing one lookup would let
it hide a counter that is still present further back.
```

- [ ] **Step 2: Actualiza `CLAUDE.md`**

En la sección de mecanismos de reclamación, añade a la lista de tags:

```markdown
- `WELCOME-TOUR` — offer único de gamificación (`welcometour`, 50 pts, `Gamification_FRE_Offer6nonwindows`) que aparece en móvil en cuentas nuevas. Se reclama por el mismo camino que `urlreward` (`UrlReward.doUrlReward` parametrizado con `welcomeTourOptions()`), y se atribuye a `welcomeTour` en `bySource` justo para poder comprobar si la acción de servidor basta.
```

Y en la sección de repesca:

```markdown
Cada registro del historial lleva `chainId` (compartido por las pasadas de una cadena) y `pass`. `mergeAccountStats` agrupa por cadena antes de calcular, porque leer la última pasada es leer justo la que ya no encontró nada. Los registros anteriores a `chainId` no lo llevan y cuentan como cadena de uno.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/api/README.md CLAUDE.md
git commit -m "docs: document welcome tour claiming and chain aggregation"
```

---

### Task 5: Verificación final

- [ ] **Step 1: Suite completa**

```bash
npm run lint
npm run build
npm test
```

Esperado: lint sin errores (1 warning preexistente), build limpio, 51 pruebas en `src` y 99 en `scripts/api`.

- [ ] **Step 2: Árbol limpio**

```bash
git status --short
```

Esperado: sin cambios sin commitear, salvo `config.json` (gitignorado) y los ficheros locales sin seguimiento que ya existían.

---

## Despliegue y lanzamiento

Tras cerrar la rama en `main`:

```bash
git archive --format=tar.gz main > /tmp/deploy.tar.gz
scp -i ~/.ssh/oci_vm.key /tmp/deploy.tar.gz opc@82.70.87.42:/tmp/deploy.tar.gz
ssh -i ~/.ssh/oci_vm.key opc@82.70.87.42 "cd ~/rewards && tar -xzf /tmp/deploy.tar.gz --exclude=compose.yaml && docker compose build && docker compose up -d"
```

`compose.yaml`, `.env` y `config/config.json` del VM son locales de la máquina. **El flag `welcomeTour` es nuevo y el `config.json` del VM no lo tiene**: el entrypoint solo avisa de claves ausentes, así que hay que añadirlo al `config/config.json` del VM (es root-owned, requiere `sudo`) o definir `CONFIG_ACTIVITY_WELCOME_TOUR=true`. Verifica el valor efectivo dentro del contenedor antes de lanzar.

Lanzamiento de un run manual y verificación:

```bash
ssh -i ~/.ssh/oci_vm.key opc@82.70.87.42 'TOKEN=$(docker exec microsoft-rewards-script printenv API_TOKEN); curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{}" http://127.0.0.1:3010/start'
```

Qué buscar en el log después:

- `Found activity type "WelcomeTour"` seguido de `Completed WELCOME-TOUR | ... pointsGained=50`, y `welcomeTour 50` en la línea `bySource=` de esa cuenta. Si en su lugar aparece `WELCOME-TOUR credited no points`, la acción de servidor no basta y toca el recorrido en navegador.
- Que `ACTIVITY-GAPS` ya no liste `welcometour`.
