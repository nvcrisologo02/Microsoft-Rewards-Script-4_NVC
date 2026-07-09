# Resumen de ejecución por cuenta — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Al final de cada ejecución, imprimir en consola una tabla-resumen con, por cada cuenta, los puntos ganados en esta ejecución y el total al que ha llegado, más una fila TOTAL.

**Architecture:** Se añade una unidad pura y testeable (`src/util/RunSummary.ts`) que formatea la tabla a partir de datos por cuenta; `runMaster` (camino cluster) y `runTasks` (camino secuencial) mapean sus `AccountStats` ya existentes a esas filas y emiten el bloque con una sola llamada al logger, justo antes de su `RUN-END`. La línea `RUN-END` no cambia.

**Tech Stack:** TypeScript (CommonJS, target ES2022), `node --test` con `ts-node/register` (ya presente). Sin dependencias nuevas.

## Global Constraints

- Node ≥ 24. TS `strict` (`noUnusedLocals`, `noUncheckedIndexedAccess`, `strictNullChecks`).
- Sin dependencias nuevas de runtime. Cross-platform (Windows/macOS/Linux).
- Solo consola: NO enviar el resumen a webhooks (Discord/ntfy).
- No tocar login, actividades, HTTP, webhooks ni el scheduler. Solo: formateador nuevo + 2 puntos de cableado en `index.ts` + el script `test`.
- `RUN-END` y su cálculo agregado se mantienen intactos.
- Separador de miles: `.` cada 3 dígitos, sin depender de `Intl`/locale.
- Separación entre columnas: exactamente 3 espacios. Filas de datos y TOTAL de ancho fijo (sin recortar espacios finales) para alineación.
- `AccountStats.duration` está en **segundos**.

---

## Estructura de ficheros

- **Crear** `src/util/RunSummary.ts` — `AccountSummary` + `formatRunSummary` (formateador puro). Sin conocimiento de `cluster`, logger ni IPC.
- **Crear** `src/util/RunSummary.test.ts` — tests con `node --test`.
- **Modificar** `src/index.ts` — import del formateador; emitir `RUN-SUMMARY` en `runMaster` y en el camino secuencial de `runTasks`, antes de sus `RUN-END`.
- **Modificar** `package.json` — el script `test` cubre todos los tests de `src/util`.

---

## Task 1: Formateador puro `RunSummary.ts` (TDD)

**Files:**
- Create: `src/util/RunSummary.ts`
- Test: `src/util/RunSummary.test.ts`
- Modify: `package.json` (script `test`)

**Interfaces:**
- Produces:
  - `interface AccountSummary { email: string; collectedPoints: number; finalPoints: number; durationSeconds: number; success: boolean }`
  - `function formatRunSummary(rows: AccountSummary[], totalRuntimeSeconds: number): string`

- [ ] **Step 1: Ampliar el script de test para cubrir todos los tests de `src/util`**

En `package.json`, reemplazar la línea del script `test` (línea 24):

```json
        "test": "node --require ts-node/register --test src/util/Scheduler.test.ts",
```

por:

```json
        "test": "node --require ts-node/register --test \"src/util/*.test.ts\"",
```

(Node ≥ 21 expande el glob en el runner de test; con Node ≥ 24 recoge tanto `Scheduler.test.ts` como el nuevo `RunSummary.test.ts`.)

- [ ] **Step 2: Escribir el test que falla**

Crear `src/util/RunSummary.test.ts` con este contenido completo:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import { formatRunSummary, AccountSummary } from './RunSummary'

const rows: AccountSummary[] = [
    { email: 'pupela_32@outlook.com', collectedPoints: 285, finalPoints: 26831, durationSeconds: 252, success: true },
    { email: 'nvcrisologo02@gmail.com', collectedPoints: 0, finalPoints: 0, durationSeconds: 12, success: false }
]

test('incluye una fila por cuenta con ganados y total', () => {
    const out = formatRunSummary(rows, 300)
    assert.ok(out.includes('pupela_32@outlook.com'), 'aparece la 1ª cuenta')
    assert.ok(out.includes('nvcrisologo02@gmail.com'), 'aparece la 2ª cuenta')
    assert.ok(out.includes('+285'), 'ganados con signo +')
    assert.ok(out.includes('26.831'), 'total con separador de miles')
})

test('marca OK y FALLO según success', () => {
    const out = formatRunSummary(rows, 300)
    assert.ok(out.includes('OK'), 'estado OK')
    assert.ok(out.includes('FALLO'), 'estado FALLO')
})

test('fila TOTAL: sumas, runtime y recuento k/N OK', () => {
    const out = formatRunSummary(rows, 300)
    const totalLine = out.split('\n').find(l => l.startsWith('TOTAL'))
    assert.ok(totalLine, 'existe la fila TOTAL')
    assert.ok(totalLine!.includes('+285'), 'total ganados = suma')
    assert.ok(totalLine!.includes('26.831'), 'total final = suma')
    assert.ok(totalLine!.includes('5.0m'), 'Dur = runtime total (300s → 5.0m)')
    assert.ok(totalLine!.includes('1/2 OK'), 'recuento de éxitos')
})

test('cabecera con el número de cuentas', () => {
    const out = formatRunSummary(rows, 300)
    assert.ok(out.includes('(2 cuentas)'), 'cabecera con N')
})

test('agrupación de miles: 0, 1273, 135532', () => {
    const out = formatRunSummary(
        [{ email: 'a@x.com', collectedPoints: 1273, finalPoints: 135532, durationSeconds: 60, success: true }],
        60
    )
    assert.ok(out.includes('+1.273'), '1273 → 1.273')
    assert.ok(out.includes('135.532'), '135532 → 135.532')

    const zero = formatRunSummary(
        [{ email: 'a@x.com', collectedPoints: 0, finalPoints: 0, durationSeconds: 0, success: true }],
        0
    )
    assert.ok(zero.includes('+0'), 'ganados 0 → +0')
})

test('filas de datos y TOTAL alineadas al mismo ancho', () => {
    const out = formatRunSummary(rows, 300)
    const lines = out.split('\n')
    const dataLines = lines.filter(
        l => l.startsWith('pupela_32') || l.startsWith('nvcrisologo02') || l.startsWith('TOTAL')
    )
    assert.equal(dataLines.length, 3, 'dos cuentas + TOTAL')
    const widths = new Set(dataLines.map(l => l.length))
    assert.equal(widths.size, 1, 'todas las filas de datos tienen el mismo ancho')
})

test('rows vacío no lanza y produce cabecera + TOTAL', () => {
    const out = formatRunSummary([], 0)
    assert.ok(out.includes('(0 cuentas)'), 'cabecera con 0')
    assert.ok(out.includes('TOTAL'), 'fila TOTAL presente')
    assert.ok(out.includes('0/0 OK'), 'recuento 0/0')
})
```

- [ ] **Step 3: Ejecutar el test y verificar que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module './RunSummary'` (aún no existe).

- [ ] **Step 4: Implementar `RunSummary.ts`**

Crear `src/util/RunSummary.ts` con este contenido completo:

```ts
export interface AccountSummary {
    /** Puntos ganados en esta ejecución. */
    collectedPoints: number
    /** Total de puntos al que ha llegado la cuenta. */
    finalPoints: number
    /** Duración de esta cuenta, en segundos. */
    durationSeconds: number
    email: string
    success: boolean
}

/** Inserta '.' cada 3 dígitos desde la derecha. Determinista, sin Intl. */
function groupThousands(value: number): string {
    const sign = value < 0 ? '-' : ''
    const digits = Math.abs(Math.trunc(value)).toString()
    let out = ''
    for (let i = 0; i < digits.length; i++) {
        if (i > 0 && (digits.length - i) % 3 === 0) {
            out += '.'
        }
        out += digits[i]
    }
    return sign + out
}

/** Ganados con signo: `+N` para >=0, `-N` para negativos. */
function formatGained(value: number): string {
    return value < 0 ? groupThousands(value) : `+${groupThousands(value)}`
}

function formatMinutes(seconds: number): string {
    return `${(seconds / 60).toFixed(1)}m`
}

function padLeft(text: string, width: number): string {
    return text.padStart(width)
}

function padRight(text: string, width: number): string {
    return text.padEnd(width)
}

/**
 * Devuelve el bloque de resumen (multilínea) listo para una sola llamada al
 * logger. Columnas: Cuenta (izq.), Ganados/Total/Dur (der.), Estado (izq.).
 * La fila TOTAL usa `totalRuntimeSeconds` para la duración (no la suma de
 * duraciones, que en cluster se solapan).
 */
export function formatRunSummary(rows: AccountSummary[], totalRuntimeSeconds: number): string {
    const GAP = '   ' // 3 espacios

    const H_ACCOUNT = 'Cuenta'
    const H_GAINED = 'Ganados'
    const H_TOTAL = 'Total'
    const H_DUR = 'Dur'
    const H_STATUS = 'Estado'
    const TOTAL_LABEL = 'TOTAL'

    const accountCells = rows.map(r => r.email)
    const gainedCells = rows.map(r => formatGained(r.collectedPoints))
    const totalCells = rows.map(r => groupThousands(r.finalPoints))
    const durCells = rows.map(r => formatMinutes(r.durationSeconds))
    const statusCells = rows.map(r => (r.success ? 'OK' : 'FALLO'))

    const okCount = rows.filter(r => r.success).length
    const sumCollected = rows.reduce((sum, r) => sum + r.collectedPoints, 0)
    const sumFinal = rows.reduce((sum, r) => sum + r.finalPoints, 0)

    const totalGained = formatGained(sumCollected)
    const totalTotal = groupThousands(sumFinal)
    const totalDur = formatMinutes(totalRuntimeSeconds)
    const totalStatus = `${okCount}/${rows.length} OK`

    const wAccount = Math.max(H_ACCOUNT.length, TOTAL_LABEL.length, ...accountCells.map(c => c.length))
    const wGained = Math.max(H_GAINED.length, totalGained.length, ...gainedCells.map(c => c.length))
    const wTotal = Math.max(H_TOTAL.length, totalTotal.length, ...totalCells.map(c => c.length))
    const wDur = Math.max(H_DUR.length, totalDur.length, ...durCells.map(c => c.length))
    const wStatus = Math.max(H_STATUS.length, totalStatus.length, ...statusCells.map(c => c.length))

    const rowLine = (account: string, gained: string, total: string, dur: string, status: string): string =>
        padRight(account, wAccount) +
        GAP +
        padLeft(gained, wGained) +
        GAP +
        padLeft(total, wTotal) +
        GAP +
        padLeft(dur, wDur) +
        GAP +
        padRight(status, wStatus)

    const header = rowLine(H_ACCOUNT, H_GAINED, H_TOTAL, H_DUR, H_STATUS)
    const separator = '-'.repeat(header.length)

    const title = `===== RESUMEN DE EJECUCIÓN (${rows.length} cuentas) =====`

    const body = rows.map((r, i) =>
        rowLine(
            accountCells[i] as string,
            gainedCells[i] as string,
            totalCells[i] as string,
            durCells[i] as string,
            statusCells[i] as string
        )
    )

    const totalRow = rowLine(TOTAL_LABEL, totalGained, totalTotal, totalDur, totalStatus)

    return [title, header, ...body, separator, totalRow].join('\n')
}
```

- [ ] **Step 5: Ejecutar el test y verificar que pasa**

Run: `npm test`
Expected: PASS — los tests de `RunSummary.test.ts` (7) **y** los de `Scheduler.test.ts` (5) en verde. Confirma que el glob recoge ambos ficheros (total ≥ 12 tests).

- [ ] **Step 6: Verificar tipos**

Run: `npm run build`
Expected: compila sin errores (tsc strict). Se genera `dist/util/RunSummary.js`.

- [ ] **Step 7: Commit** (o checkpoint de verificación si no hay git)

```bash
git add src/util/RunSummary.ts src/util/RunSummary.test.ts package.json
git commit -m "feat(summary): pure per-account run summary formatter"
```

---

## Task 2: Cablear el resumen en `index.ts` (cluster y secuencial)

**Files:**
- Modify: `src/index.ts` — import (zona de imports de `./util/`, línea ~19); `runMaster` (antes del `RUN-END`, línea ~287); `runTasks` camino secuencial (antes del `RUN-END`, línea ~429).

**Interfaces:**
- Consumes: `formatRunSummary`, `AccountSummary` de `./util/RunSummary` (Task 1). `AccountStats` (ya definido en `index.ts`: `{ email, initialPoints, finalPoints, collectedPoints, duration, success, error? }`, con `duration` en segundos).

- [ ] **Step 1: Importar `formatRunSummary`**

En `src/index.ts`, tras la línea `import { runScheduled } from './util/Scheduler'` (línea 19), añadir:

```ts
import { formatRunSummary } from './util/RunSummary'
```

- [ ] **Step 2: Emitir el resumen en `runMaster` (antes de `RUN-END`)**

En `src/index.ts`, en `runMaster`, localizar la llamada al logger de `RUN-END` (actualmente línea ~287):

```ts
        this.logger.info(
            'main',
            'RUN-END',
            `Completed all accounts | Accounts processed: ${allAccountStats.length} | Total points collected: +${totalCollectedPoints} | Old total: ${totalInitialPoints} → New total: ${totalFinalPoints} | Total runtime: ${totalDurationMinutes}min`,
            'green'
        )
```

Insertar **justo antes** de esa llamada:

```ts
        this.logger.info(
            'main',
            'RUN-SUMMARY',
            '\n' +
                formatRunSummary(
                    allAccountStats.map(s => ({
                        email: s.email,
                        collectedPoints: s.collectedPoints,
                        finalPoints: s.finalPoints,
                        durationSeconds: s.duration,
                        success: s.success
                    })),
                    (Date.now() - runStartTime) / 1000
                )
        )
```

(El `'\n' +` inicial separa la tabla del prefijo de log en la primera línea.)

- [ ] **Step 3: Emitir el resumen en el camino secuencial de `runTasks` (antes de `RUN-END`)**

En `src/index.ts`, en `runTasks`, dentro del bloque `if (this.config.clusters <= 1 && cluster.isPrimary) { ... }`, localizar la llamada al logger de `RUN-END` (actualmente línea ~429):

```ts
            this.logger.info(
                'main',
                'RUN-END',
                `Completed all accounts | Accounts processed: ${accountStats.length} | Total points collected: +${totalCollectedPoints} | Old total: ${totalInitialPoints} → New total: ${totalFinalPoints} | Total runtime: ${totalDurationMinutes}min`,
                'green'
            )
```

Insertar **justo antes** de esa llamada:

```ts
            this.logger.info(
                'main',
                'RUN-SUMMARY',
                '\n' +
                    formatRunSummary(
                        accountStats.map(s => ({
                            email: s.email,
                            collectedPoints: s.collectedPoints,
                            finalPoints: s.finalPoints,
                            durationSeconds: s.duration,
                            success: s.success
                        })),
                        (Date.now() - runStartTime) / 1000
                    )
            )
```

- [ ] **Step 4: Verificar compilación**

Run: `npm run build`
Expected: compila sin errores (comprueba que el import se usa, que `formatRunSummary` recibe los tipos correctos y que no hay locales sin usar).

- [ ] **Step 5: Re-ejecutar la suite de tests (no debe romperse)**

Run: `npm test`
Expected: PASS — todos los tests de `src/util` siguen en verde.

- [ ] **Step 6: Humo del formateador con datos reales (sin ejecución completa)**

Verifica el render exacto con datos de ejemplo usando el módulo compilado:

Run:
`node -e "const{formatRunSummary}=require('./dist/util/RunSummary');console.log(formatRunSummary([{email:'pupela_32@outlook.com',collectedPoints:285,finalPoints:26831,durationSeconds:252,success:true},{email:'nvcrisologo02@gmail.com',collectedPoints:0,finalPoints:0,durationSeconds:12,success:false}],300))"`

Expected: imprime la tabla con cabecera `===== RESUMEN DE EJECUCIÓN (2 cuentas) =====`, dos filas alineadas (`+285   26.831   4.2m   OK` y `+0   0   0.2m   FALLO`), la línea de guiones y la fila `TOTAL ... +285 ... 26.831 ... 5.0m ... 1/2 OK`.

- [ ] **Step 7: Commit** (o checkpoint de verificación si no hay git)

```bash
git add src/index.ts
git commit -m "feat(summary): show per-account run summary before RUN-END (cluster + sequential)"
```

---

## Self-Review (cobertura frente a la spec)

- **Resumen por cuenta (ganados + total):** Task 1 (`formatRunSummary`) + Task 2 (mapeo `collectedPoints`/`finalPoints`). ✔
- **Fila TOTAL (sumas, runtime, k/N OK):** Task 1 (fila TOTAL) + Task 2 (`totalRuntimeSeconds`). ✔
- **Solo consola, sin webhooks:** Task 2 usa `this.logger.info` en el master/secuencial; no se llama a `sendDiscord`/`sendNtfy`. ✔
- **Ambos caminos (cluster + secuencial):** Task 2 Steps 2 y 3. ✔
- **`RUN-END` intacto:** se inserta *antes*, sin modificar la llamada existente. ✔
- **Unidad pura y testeable:** Task 1 (`RunSummary.ts` sin imports de cluster/logger/IPC). ✔
- **Separador de miles sin Intl / cross-platform / sin deps nuevas / TS strict:** Task 1 (`groupThousands`). ✔
- **Script de test cubre el nuevo fichero:** Task 1 Step 1 (glob) + Step 5 (verificación de que corren ambas suites). ✔
- **`duration` en segundos:** Task 2 mapea `durationSeconds: s.duration`. ✔
