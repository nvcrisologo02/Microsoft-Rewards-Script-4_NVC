# Rewards Control Dashboard — Fase 3 (Seguimiento profundo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable run history (NDJSON file), an Ejecuciones view with charts (points per day, totals per account), and a Diagnósticos gallery.

**Architecture:** `scripts/api/historyStore.js` appends each completed run (the existing `toHistoryRecord` shape) to `data/history.ndjson`; `processManager` gains a `run-complete` event emitted where it already pushes to its in-memory history; `GET /history?persisted=1` reads the file. Charts are hand-rolled SVG (`ui/chart.js`) fed by pure, node-tested transforms (`ui/chartData.js`).

**Spec deviations (documented):** (1) the spec listed a "balance por cuenta" time chart, but history records deliberately carry only per-run `collected` (no balances), so the second chart is "total recogido por cuenta" (horizontal bars) instead — same question ("which accounts earn"), available data. (2) the spec named uPlot for charts. At this dashboard's data volume (≤ a few hundred points) a ~100-line SVG component provides the same capability with zero vendored bytes and full styling control, so this plan uses hand-rolled SVG instead. Chart design follows the project's dataviz rules: single accent hue for series, identity via labels (never color alone), recessive grid, tabular numerals, hover tooltip.

**Reference spec:** `docs/superpowers/specs/2026-07-19-rewards-dashboard-design.md` (pantallas 3 y 7, historial persistente).

## Global Constraints

- Node.js `>=24.0.0`; no new package.json entries; ESM `.js`, 4-space indent, NO trailing semicolons in `scripts/api/**`; UI copy Spanish, identifiers/comments English.
- History file: `data/history.ndjson` under the project root (override via `HISTORY_FILE` env var); the `data/` directory is created on demand; appends are line-atomic (`fs.appendFileSync` of one `JSON.stringify + '\n'`).
- Corrupt/partial lines in the file must never crash a read — skip them.
- Tests: `node --test scripts/api/historyStore.test.js scripts/api/ui/chartData.test.js` plus the existing suites; never write test data into the repo's real `data/` (temp dirs only).
- Charts: colors from the existing tokens (`--accent #3b82f6`, grid `#232834`, text `var(--ink-3)`); values in `font-variant-numeric: tabular-nums`; every chart has an accessible `role="img"` + `aria-label`; a data table is always present alongside (the runs table / bars include labels+numbers).
- Diagnostics artifacts are fetched with the token when one is configured: `authedUrl(path)` helper appends `?token=`.
- `npm run lint` clean before each commit; commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Branch: `feature/rewards-dashboard-fase2` (Fase 3 continues on the same branch; the whole branch merges once).

## History record shape (from server.js `toHistoryRecord`, used throughout)

```jsonc
{
    "startedAt": "2026-07-14T09:30:00.000Z",
    "endedAt": "2026-07-14T09:36:12.000Z",
    "exit": { "code": 0, "signal": null, "at": "..." },
    "version": "4.0.3",
    "collected": 312,
    "accounts": [{ "email": "a@x.com", "collected": 155, "success": true, "error": null, "streakProtection": null }]
}
```

---

### Task 1: `historyStore.js` (TDD)

**Files:**
- Create: `scripts/api/historyStore.js`
- Create: `scripts/api/historyStore.test.js`

**Interfaces (Produces):**
- `historyFilePath(projectRoot) → string` — `HISTORY_FILE` env override or `<projectRoot>/data/history.ndjson`.
- `appendRun(projectRoot, record) → boolean` — appends one line; creates `data/` if missing; skips (returns false) when a record with the same `startedAt` is already the last line (restart dedup); true on append.
- `readRuns(projectRoot, { limit = 100, offset = 0 } = {}) → { runs, total }` — newest-first (file order is oldest-first), corrupt lines skipped, missing file → `{ runs: [], total: 0 }`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/api/historyStore.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { appendRun, historyFilePath, readRuns } from './historyStore.js'

function makeRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-hist-'))
}

function record(startedAt, collected) {
    return {
        startedAt,
        endedAt: startedAt,
        exit: { code: 0, signal: null, at: startedAt },
        version: '4.0.3',
        collected,
        accounts: [{ email: 'a@x.com', collected, success: true, error: null, streakProtection: null }]
    }
}

test('append creates data dir and file, read returns newest first', () => {
    const root = makeRoot()
    try {
        assert.equal(appendRun(root, record('2026-07-01T07:00:00.000Z', 100)), true)
        assert.equal(appendRun(root, record('2026-07-02T07:00:00.000Z', 200)), true)
        const { runs, total } = readRuns(root)
        assert.equal(total, 2)
        assert.equal(runs[0].collected, 200)
        assert.equal(runs[1].collected, 100)
        assert.equal(fs.existsSync(historyFilePath(root)), true)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('duplicate startedAt against the last line is skipped', () => {
    const root = makeRoot()
    try {
        appendRun(root, record('2026-07-01T07:00:00.000Z', 100))
        assert.equal(appendRun(root, record('2026-07-01T07:00:00.000Z', 100)), false)
        assert.equal(readRuns(root).total, 1)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('corrupt lines are skipped without crashing', () => {
    const root = makeRoot()
    try {
        appendRun(root, record('2026-07-01T07:00:00.000Z', 100))
        fs.appendFileSync(historyFilePath(root), 'NOT-JSON{{{\n')
        appendRun(root, record('2026-07-02T07:00:00.000Z', 200))
        const { runs, total } = readRuns(root)
        assert.equal(total, 2)
        assert.equal(runs[0].collected, 200)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('limit and offset paginate newest-first', () => {
    const root = makeRoot()
    try {
        for (let i = 1; i <= 5; i++) appendRun(root, record(`2026-07-0${i}T07:00:00.000Z`, i * 10))
        const page = readRuns(root, { limit: 2, offset: 1 })
        assert.equal(page.total, 5)
        assert.deepEqual(page.runs.map(r => r.collected), [40, 30])
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('missing file reads empty', () => {
    const root = makeRoot()
    try {
        assert.deepEqual(readRuns(root), { runs: [], total: 0 })
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})
```

- [ ] **Step 2: Run to verify failure** — `node --test scripts/api/historyStore.test.js` → module not found.

- [ ] **Step 3: Implement**

Create `scripts/api/historyStore.js`:

```js
import fs from 'node:fs'
import path from 'node:path'

export function historyFilePath(projectRoot) {
    const override = process.env.HISTORY_FILE
    if (override && override.trim().length) return path.resolve(override.trim())
    return path.join(projectRoot, 'data', 'history.ndjson')
}

function readAll(projectRoot) {
    const file = historyFilePath(projectRoot)
    let text
    try {
        text = fs.readFileSync(file, 'utf8')
    } catch {
        return []
    }
    const runs = []
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
            const parsed = JSON.parse(line)
            if (parsed && typeof parsed === 'object' && typeof parsed.startedAt === 'string') runs.push(parsed)
        } catch {
            // Corrupt or partial line (e.g. crash mid-append): skip, never crash a read.
        }
    }
    return runs
}

export function appendRun(projectRoot, record) {
    if (!record || typeof record.startedAt !== 'string') return false
    const file = historyFilePath(projectRoot)
    const existing = readAll(projectRoot)
    const last = existing[existing.length - 1]
    if (last && last.startedAt === record.startedAt) return false
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(record) + '\n')
    return true
}

export function readRuns(projectRoot, { limit = 100, offset = 0 } = {}) {
    const all = readAll(projectRoot)
    const newestFirst = all.slice().reverse()
    return {
        runs: newestFirst.slice(offset, offset + limit),
        total: all.length
    }
}
```

- [ ] **Step 4: Run to verify pass** — all 5 tests PASS.
- [ ] **Step 5: Lint and commit** — `npm run lint`; `git add scripts/api/historyStore.js scripts/api/historyStore.test.js`; commit `feat(api): ndjson history store`.

---

### Task 2: `run-complete` hook + persisted `/history`

**Files:**
- Modify: `scripts/api/processManager.js` (one `this.emit(...)` line)
- Modify: `scripts/api/server.js` (subscribe + route param)

**Interfaces:**
- Produces: `pm.emit('run-complete', historyEntry)` fired exactly where the in-memory history entry is pushed (find it: grep `historySize` / the array unshift-or-push in `processManager.js`; the entry is the same object `getHistory()` returns). Server subscribes once at boot: `pm.on('run-complete', entry => { try { appendRun(projectRoot, toHistoryRecord(entry)) } catch (error) { log('warn', \`History append failed: ${error.message}\`) } })` (match `lib.js#log`'s real signature — read it first).
- `GET /history?persisted=1[&limit&offset]` → `{ runs, count, total, inMemoryOnly: false, file: <path> }` from the store; without `persisted=1` behavior is unchanged (in-memory).

- [ ] **Step 1: Emit the event** — in `processManager.js`, locate the single place a completed run is recorded into the history array (search for the history push near the child `exit` handling). Immediately after the push, add: `this.emit('run-complete', entry)` (use the actual local variable name of the pushed entry).
- [ ] **Step 2: Wire server** — import `appendRun, historyFilePath, readRuns` in `server.js`; add the subscription right after the existing `pm.on('log', ...)` forwarding block; extend the `GET /history` route: when `url.searchParams.get('persisted') === '1'`, `const limit = clampInt(url.searchParams.get('limit'), 1, 500, 100)`, `const offset = clampInt(url.searchParams.get('offset'), 0, 1000000, 0)`, return `sendJson(res, 200, { ...readRuns(projectRoot, { limit, offset }), count: undefined, inMemoryOnly: false, file: historyFilePath(projectRoot) })` — shape it as `{ runs, total, count: runs.length, inMemoryOnly: false, file }` (compute explicitly; don't send `undefined`). Add `'GET /history?persisted=1'` to the endpoints index array.
- [ ] **Step 3: Verify (scratch, temp cwd)** — launch the server from a temp dir (so `data/` lands there via cwd? NO — `projectRoot` is resolved from the script location, not cwd; therefore set `HISTORY_FILE` to a temp path instead): `HISTORY_FILE=<temp>/history.ndjson node scripts/api/server.js -port 3996`. POST /start (bot will fail fast without accounts in the child env — fine), wait for exit, then `GET /history?persisted=1` → the failed run appears with its exit record; restart the API and confirm the run is still there (durability). Also `GET /history` (no param) unchanged shape.
- [ ] **Step 4: Tests, lint, commit** — full `node --test` of the four api suites; `npm run lint`; commit `feat(api): persist completed runs and serve them via /history?persisted=1`.

---

### Task 3: chart transforms + SVG chart components (TDD for transforms)

**Files:**
- Create: `scripts/api/ui/chartData.js`
- Create: `scripts/api/ui/chartData.test.js`
- Create: `scripts/api/ui/chart.js`

**Interfaces (Produces):**
- `chartData.js` (pure, no DOM):
  - `aggregateDaily(runs, days, now = new Date()) → [{ key: 'YYYY-MM-DD', label: 'D mes', points: number }]` — one entry per local day for the last `days` days ending today (zero-filled), summing `run.collected` by `startedAt` local date.
  - `totalsByAccount(runs) → [{ email, points, runs, failures }]` — summed per account across the given runs, sorted by points desc.
- `chart.js` (Preact components, imports vendor + nothing else):
  - `AreaChart({ data, height = 220, ariaLabel })` — `data` = aggregateDaily output; SVG area+line in accent blue, 3 horizontal gridlines with values, ~4 x labels, hover crosshair + tooltip showing `label · +points pts`; empty data → muted "Sin datos todavía."
  - `BarList({ items, ariaLabel })` — `items` = totalsByAccount output; horizontal bars (accent), email label left (mono), points right (mono, `es` locale), bar width proportional to max; includes failures count as a small red suffix when > 0.

- [ ] **Step 1: Write the failing transform tests**

Create `scripts/api/ui/chartData.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { aggregateDaily, totalsByAccount } from './chartData.js'

const NOW = new Date(2026, 6, 19, 12, 0, 0) // Sun 19 Jul 2026 local

function run(startedAtLocal, collected, accounts) {
    return { startedAt: startedAtLocal.toISOString(), collected, accounts }
}

test('aggregateDaily zero-fills and sums by local day, oldest first', () => {
    const runs = [
        run(new Date(2026, 6, 18, 7, 0), 100),
        run(new Date(2026, 6, 18, 19, 0), 50),
        run(new Date(2026, 6, 19, 7, 0), 200)
    ]
    const days = aggregateDaily(runs, 3, NOW)
    assert.equal(days.length, 3)
    assert.deepEqual(days.map(d => d.points), [0, 150, 200])
    assert.equal(days[2].key, '2026-07-19')
})

test('aggregateDaily ignores runs outside the window', () => {
    const runs = [run(new Date(2026, 5, 1, 7, 0), 999), run(new Date(2026, 6, 19, 7, 0), 10)]
    const days = aggregateDaily(runs, 7, NOW)
    assert.equal(days.reduce((a, d) => a + d.points, 0), 10)
})

test('totalsByAccount sums, counts runs and failures, sorts desc', () => {
    const runs = [
        run(new Date(2026, 6, 18, 7, 0), 0, [
            { email: 'a@x.com', collected: 100, success: true },
            { email: 'b@x.com', collected: 300, success: true }
        ]),
        run(new Date(2026, 6, 19, 7, 0), 0, [
            { email: 'a@x.com', collected: 50, success: false }
        ])
    ]
    const totals = totalsByAccount(runs)
    assert.deepEqual(totals[0], { email: 'b@x.com', points: 300, runs: 1, failures: 0 })
    assert.deepEqual(totals[1], { email: 'a@x.com', points: 150, runs: 2, failures: 1 })
})

test('empty input → empty outputs', () => {
    assert.deepEqual(totalsByAccount([]), [])
    assert.equal(aggregateDaily([], 5, NOW).length, 5)
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `chartData.js`**

```js
// Pure data transforms for the Ejecuciones charts. No DOM, node-testable.

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

function dayKey(date) {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

export function aggregateDaily(runs, days, now = new Date()) {
    const byDay = new Map()
    for (const run of runs ?? []) {
        const started = new Date(run.startedAt)
        if (Number.isNaN(started.getTime())) continue
        const key = dayKey(started)
        byDay.set(key, (byDay.get(key) ?? 0) + (run.collected ?? 0))
    }
    const out = []
    for (let i = days - 1; i >= 0; i--) {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
        const key = dayKey(date)
        out.push({ key, label: `${date.getDate()} ${MONTHS[date.getMonth()]}`, points: byDay.get(key) ?? 0 })
    }
    return out
}

export function totalsByAccount(runs) {
    const byEmail = new Map()
    for (const run of runs ?? []) {
        for (const account of run.accounts ?? []) {
            if (!account?.email) continue
            const entry = byEmail.get(account.email) ?? { email: account.email, points: 0, runs: 0, failures: 0 }
            entry.points += account.collected ?? 0
            entry.runs += 1
            if (account.success === false) entry.failures += 1
            byEmail.set(account.email, entry)
        }
    }
    return [...byEmail.values()].sort((a, b) => b.points - a.points)
}
```

- [ ] **Step 4: Run to verify pass** (4/4).

- [ ] **Step 5: Implement `chart.js`**

```js
import { html, useRef, useState } from './vendor/htm-preact-standalone.module.js'

const ACCENT = '#3b82f6'
const GRID = '#232834'

function niceMax(value) {
    if (value <= 0) return 10
    const magnitude = 10 ** Math.floor(Math.log10(value))
    for (const m of [1, 2, 5, 10]) {
        if (value <= m * magnitude) return m * magnitude
    }
    return 10 * magnitude
}

export function AreaChart({ data, height = 220, ariaLabel }) {
    const [hover, setHover] = useState(null)
    const svgRef = useRef(null)
    if (!data || data.length === 0 || data.every(d => d.points === 0)) {
        return html`<div style="color:var(--ink-3);font-size:13px;padding:24px 0;text-align:center">
            Sin datos todavía. Completa algún run para ver la gráfica.</div>`
    }
    const w = 800
    const padL = 46
    const padR = 10
    const padT = 10
    const padB = 22
    const max = niceMax(Math.max(...data.map(d => d.points)))
    const X = i => padL + i * (w - padL - padR) / Math.max(1, data.length - 1)
    const Y = v => padT + (1 - v / max) * (height - padT - padB)
    const points = data.map((d, i) => `${X(i)},${Y(d.points)}`).join(' ')
    const area = `M${X(0)},${Y(data[0].points)} ` + data.map((d, i) => `L${X(i)},${Y(d.points)}`).join(' ')
        + ` L${X(data.length - 1)},${height - padB} L${X(0)},${height - padB} Z`
    const gridLines = [0.5, 1].map(f => Math.round(max * f))
    const labelEvery = Math.max(1, Math.round(data.length / 4))

    const onMove = e => {
        const rect = svgRef.current.getBoundingClientRect()
        const x = (e.clientX - rect.left) * (w / rect.width)
        const i = Math.max(0, Math.min(data.length - 1,
            Math.round((x - padL) / ((w - padL - padR) / Math.max(1, data.length - 1)))))
        setHover(i)
    }

    return html`<div style="position:relative">
        <svg ref=${svgRef} viewBox=${`0 0 ${w} ${height}`} style="width:100%;display:block"
            role="img" aria-label=${ariaLabel}
            onMouseMove=${onMove} onMouseLeave=${() => setHover(null)}>
            ${gridLines.map(v => html`<g key=${v}>
                <line x1=${padL} y1=${Y(v)} x2=${w - padR} y2=${Y(v)} stroke=${GRID} stroke-width="1" />
                <text x=${padL - 8} y=${Y(v) + 3.5} text-anchor="end"
                    style="font:10.5px var(--mono);fill:var(--ink-3)">${v.toLocaleString('es')}</text>
            </g>`)}
            ${data.map((d, i) => i % labelEvery === 0 ? html`<text key=${d.key} x=${X(i)} y=${height - 6}
                text-anchor="middle" style="font:10.5px var(--mono);fill:var(--ink-3)">${d.label}</text>` : null)}
            <path d=${area} fill=${ACCENT} opacity="0.14" />
            <polyline points=${points} fill="none" stroke=${ACCENT} stroke-width="2" stroke-linejoin="round" />
            ${hover != null && html`
                <line x1=${X(hover)} y1=${padT} x2=${X(hover)} y2=${height - padB}
                    stroke="#39404f" stroke-dasharray="3 3" />
                <circle cx=${X(hover)} cy=${Y(data[hover].points)} r="4" fill=${ACCENT}
                    stroke="var(--surface)" stroke-width="2" />`}
        </svg>
        ${hover != null && html`<div style=${`position:absolute;pointer-events:none;left:${X(hover) / w * 100}%;top:0;transform:translate(-50%,-4px);background:#0b0d11;border:1px solid var(--border);border-radius:8px;padding:5px 10px;font:11.5px var(--mono);white-space:nowrap`}>
            ${data[hover].label} · <b style="color:#8ab4ff">+${data[hover].points.toLocaleString('es')} pts</b>
        </div>`}
    </div>`
}

export function BarList({ items, ariaLabel }) {
    if (!items || items.length === 0) {
        return html`<div style="color:var(--ink-3);font-size:13px;padding:12px 0">Sin datos todavía.</div>`
    }
    const max = Math.max(...items.map(i => i.points), 1)
    return html`<div role="img" aria-label=${ariaLabel} style="display:flex;flex-direction:column;gap:8px">
        ${items.map(item => html`<div key=${item.email} class="row" style="gap:10px">
            <span class="em" style="flex:0 0 220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.email}</span>
            <div style="flex:1;height:10px;border-radius:99px;background:var(--surface-2);overflow:hidden">
                <div style=${`height:100%;width:${Math.max(2, item.points / max * 100)}%;background:${ACCENT};border-radius:99px`}></div>
            </div>
            <span class="num" style="flex:0 0 90px;font-size:12.5px">${item.points.toLocaleString('es')}
                ${item.failures > 0 ? html`<span style="color:#ff8b8b"> ·${item.failures}✕</span>` : ''}</span>
        </div>`)}
    </div>`
}
```

- [ ] **Step 6: Verify** — `node --check scripts/api/ui/chart.js scripts/api/ui/chartData.js` → exit 0; transform tests green.
- [ ] **Step 7: Lint and commit** — `git add scripts/api/ui/chartData.js scripts/api/ui/chartData.test.js scripts/api/ui/chart.js`; commit `feat(ui): chart transforms and svg chart components`.

---

### Task 4: Ejecuciones view

**Files:**
- Create: `scripts/api/ui/views/ejecuciones.js`
- Modify: `scripts/api/ui/app.js` (replace the `runs` VIEWS entry)

**Interfaces:**
- Consumes: `GET /history?persisted=1&limit=500` (falls back to `GET /history` in-memory when the persisted read errors); `aggregateDaily`/`totalsByAccount` from `../chartData.js`; `AreaChart`/`BarList` from `../chart.js`; `api`/`toast`.
- Produces: `export function Ejecuciones({ state })` registered as `{ id: 'runs', label: 'Ejecuciones', component: Ejecuciones }`. Refreshes when a run completes (`state.status.state` returns to `idle`).

- [ ] **Step 1: Write `views/ejecuciones.js`**

```js
import { html, useEffect, useMemo, useState } from '../vendor/htm-preact-standalone.module.js'
import { api } from '../api.js'
import { toast } from '../toast.js'
import { aggregateDaily, totalsByAccount } from '../chartData.js'
import { AreaChart, BarList } from '../chart.js'

const RANGES = [
    { label: '30 días', days: 30 },
    { label: '90 días', days: 90 },
    { label: 'Todo', days: 365 }
]

function fmtDate(iso) {
    const d = new Date(iso)
    return d.toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function fmtDuration(run) {
    if (!run.startedAt || !run.endedAt) return '—'
    const secs = Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 1000)
    if (secs < 90) return `${secs} s`
    return `${Math.round(secs / 60)} min`
}

export function Ejecuciones({ state }) {
    const [runs, setRuns] = useState(null)
    const [persisted, setPersisted] = useState(true)
    const [range, setRange] = useState(RANGES[0])
    const [open, setOpen] = useState(null)

    const load = () => {
        api('/history?persisted=1&limit=500')
            .then(d => { setRuns(d.runs ?? []); setPersisted(true) })
            .catch(() => {
                api('/history')
                    .then(d => { setRuns(d.runs ?? []); setPersisted(false) })
                    .catch(() => { setRuns([]); toast('No se pudo cargar el historial', 'err') })
            })
    }
    useEffect(load, [])
    // Refresh when a run finishes (state returns to idle).
    useEffect(() => {
        if (state?.status?.state === 'idle') load()
    }, [state?.status?.state])

    const inRange = useMemo(() => {
        if (!runs) return []
        const cutoff = Date.now() - range.days * 24 * 3600 * 1000
        return runs.filter(r => new Date(r.startedAt).getTime() >= cutoff)
    }, [runs, range])

    const daily = useMemo(() => aggregateDaily(inRange, Math.min(range.days, 90)), [inRange, range])
    const totals = useMemo(() => totalsByAccount(inRange), [inRange])

    if (runs === null) {
        return html`<section class="view"><h1>Ejecuciones</h1><p class="sub">Cargando…</p></section>`
    }

    return html`<section class="view">
        <h1>Ejecuciones</h1>
        <p class="sub">${persisted
            ? 'Historial persistente · data/history.ndjson'
            : 'Historial en memoria (se pierde al reiniciar la API)'} · ${runs.length} runs</p>
        <div class="card" style="margin-bottom:12px">
            <div class="row" style="justify-content:space-between;margin-bottom:10px">
                <b style="font-size:13.5px">Puntos ganados por día</b>
                <div class="chips">${RANGES.map(r => html`<button key=${r.days}
                    class=${'fchip' + (range.days === r.days ? ' on' : '')}
                    onClick=${() => setRange(r)}>${r.label}</button>`)}</div>
            </div>
            <${AreaChart} data=${daily} ariaLabel=${`Puntos ganados por día, últimos ${range.days} días`} />
        </div>
        <div class="cols">
            <div class="card" style="padding:16px 6px 6px">
                <b style="font-size:13.5px;padding:0 10px">Runs</b>
                <table>
                    <thead><tr><th>Inicio</th><th>Duración</th><th class="num">Puntos</th><th>Cuentas</th><th>Resultado</th></tr></thead>
                    <tbody>
                    ${inRange.slice(0, 50).map((r, i) => {
                        const ok = (r.accounts ?? []).filter(a => a.success === true).length
                        const fail = (r.accounts ?? []).filter(a => a.success === false).length
                        return html`<tr key=${r.startedAt} style="cursor:pointer"
                            onClick=${() => setOpen(open === i ? null : i)}>
                            <td class="em">${fmtDate(r.startedAt)}</td>
                            <td>${fmtDuration(r)}</td>
                            <td class="num">+${(r.collected ?? 0).toLocaleString('es')}</td>
                            <td>${ok}/${(r.accounts ?? []).length}</td>
                            <td>${fail > 0
                                ? html`<span class="badge err">✕ ${fail} fallo${fail > 1 ? 's' : ''}</span>`
                                : r.exit?.code === 0
                                    ? html`<span class="badge ok">✓ completado</span>`
                                    : html`<span class="badge mut">código ${r.exit?.code ?? '?'}</span>`}</td>
                        </tr>
                        ${open === i && html`<tr key=${r.startedAt + '-d'}><td colspan="5" style="background:var(--surface-2)">
                            ${(r.accounts ?? []).map(a => html`<div key=${a.email} class="row" style="padding:4px 8px;font-size:12.5px">
                                <span class="em" style="flex:1">${a.email}</span>
                                <span class="num">+${(a.collected ?? 0).toLocaleString('es')}</span>
                                ${a.success === false
                                    ? html`<span style="color:#ff8b8b;font-size:12px">${a.error ?? 'falló'}</span>`
                                    : html`<span style="color:var(--good);font-size:12px">✓</span>`}
                            </div>`)}
                        </td></tr>`}`
                    })}
                    </tbody>
                </table>
                ${inRange.length === 0 && html`<p style="padding:0 10px;color:var(--ink-3)">Sin runs en este rango.</p>`}
            </div>
            <div class="card">
                <b style="font-size:13.5px">Total por cuenta (${range.label})</b>
                <div class="mt"><${BarList} items=${totals} ariaLabel="Puntos totales por cuenta" /></div>
            </div>
        </div>
    </section>`
}
```

- [ ] **Step 2: Register in `app.js`** — import `Ejecuciones`, entry `{ id: 'runs', label: 'Ejecuciones', component: Ejecuciones },`.
- [ ] **Step 3: Verify** — `node --check` both files; live check with `HISTORY_FILE` pointing at a temp file seeded with 2-3 NDJSON records (write them by hand) → chart renders, range chips filter, row expands. Headless fallback: `node --check` + shape review.
- [ ] **Step 4: Lint and commit** — commit `feat(ui): ejecuciones view with history charts and run detail`.

---

### Task 5: Diagnósticos view + `authedUrl`

**Files:**
- Modify: `scripts/api/ui/api.js` (add `authedUrl`)
- Create: `scripts/api/ui/views/diagnosticos.js`
- Modify: `scripts/api/ui/app.js` (replace the `diag` VIEWS entry)

**Interfaces:**
- `authedUrl(path) → string` — appends `?token=<stored token>` (or `&token=` if the path already has a query) when a token exists; otherwise returns the path unchanged. Exported from `api.js`.
- Consumes: `GET /diagnostics` → `{ dir, count, entries: [{ name, createdAt, hasScreenshot, hasHtml, hasError, error }] }`; artifacts at `/diagnostics/<name>/screenshot.png|error.txt|dump.html` (token query accepted).
- Produces: `export function Diagnosticos()` registered as `{ id: 'diag', label: 'Diagnósticos', component: Diagnosticos }`.

- [ ] **Step 1: Add `authedUrl` to `api.js`**

```js
export function authedUrl(path) {
    const token = getToken()
    if (!token) return path
    return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
}
```

- [ ] **Step 2: Write `views/diagnosticos.js`**

```js
import { html, useEffect, useState } from '../vendor/htm-preact-standalone.module.js'
import { api, authedUrl } from '../api.js'
import { toast } from '../toast.js'

function fmtDate(iso) {
    if (!iso) return ''
    return new Date(iso).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function Diagnosticos() {
    const [entries, setEntries] = useState(null)

    useEffect(() => {
        api('/diagnostics')
            .then(d => setEntries(d.entries ?? []))
            .catch(() => { setEntries([]); toast('No se pudieron cargar los diagnósticos', 'err') })
    }, [])

    if (entries === null) {
        return html`<section class="view"><h1>Diagnósticos</h1><p class="sub">Cargando…</p></section>`
    }

    return html`<section class="view">
        <h1>Diagnósticos</h1>
        <p class="sub">Capturas automáticas de errores · ${entries.length} captura(s).</p>
        ${entries.length === 0 && html`<div class="card" style="color:var(--ink-3)">
            No hay capturas de error. Se crean automáticamente cuando un run falla con errorDiagnostics activado.</div>`}
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">
            ${entries.map(e => html`<div key=${e.name} class="card">
                ${e.hasScreenshot
                    ? html`<a href=${authedUrl(`/diagnostics/${encodeURIComponent(e.name)}/screenshot.png`)} target="_blank" rel="noopener">
                        <img src=${authedUrl(`/diagnostics/${encodeURIComponent(e.name)}/screenshot.png`)} alt=${`Captura de ${e.name}`}
                            loading="lazy" style="width:100%;height:130px;object-fit:cover;object-position:top;border-radius:8px;border:1px solid var(--border);margin-bottom:10px" /></a>`
                    : html`<div style="height:130px;border-radius:8px;border:1px solid var(--border);margin-bottom:10px;display:grid;place-items:center;color:var(--ink-3);font-size:12px">sin captura</div>`}
                <div class="em" style="font-size:11.5px;color:var(--ink-3);margin-bottom:4px">${fmtDate(e.createdAt)}</div>
                ${e.error && html`<div style="font-size:12.5px;color:#ff8b8b;margin-bottom:10px;max-height:54px;overflow:hidden">${String(e.error).slice(0, 160)}</div>`}
                <div class="row" style="flex-wrap:wrap">
                    ${e.hasScreenshot && html`<a class="btn sm" style="text-decoration:none" target="_blank" rel="noopener"
                        href=${authedUrl(`/diagnostics/${encodeURIComponent(e.name)}/screenshot.png`)}>Captura</a>`}
                    ${e.hasError && html`<a class="btn sm" style="text-decoration:none" target="_blank" rel="noopener"
                        href=${authedUrl(`/diagnostics/${encodeURIComponent(e.name)}/error.txt`)}>error.txt</a>`}
                    ${e.hasHtml && html`<a class="btn sm" style="text-decoration:none" download
                        href=${authedUrl(`/diagnostics/${encodeURIComponent(e.name)}/dump.html`)}>HTML</a>`}
                </div>
            </div>`)}
        </div>
    </section>`
}
```

- [ ] **Step 3: Register in `app.js`** — import `Diagnosticos`, entry `{ id: 'diag', label: 'Diagnósticos', component: Diagnosticos },`. All 7 sidebar entries now render real views; delete `views/placeholder.js` and its import if nothing references it anymore (verify with grep first).
- [ ] **Step 4: Verify** — `node --check` all touched files; live: create a fake capture dir `diagnostics/error-2026-01-01T00-00-00.000Z/` with a small screenshot.png + error.txt, start the API, confirm the gallery renders and the links work with a token (`-token x` → links carry `?token=x`). Remove the fake capture afterwards.
- [ ] **Step 5: Lint and commit** — commit `feat(ui): diagnosticos gallery with authed artifact links`.

---

### Task 6: Docs + Fase 3 end-to-end verification

**Files:**
- Modify: `scripts/api/README.md`

**Steps:**

- [ ] **Step 1: Document** — in `scripts/api/README.md`:
  1. `GET /history` section: document `persisted=1`, `limit`, `offset` and the durable NDJSON file (`data/history.ndjson`, `HISTORY_FILE` override), and that the old in-memory behavior is unchanged without the param. Update the "not durable" sentence to mention the persisted option.
  2. Environment variables table: add `| HISTORY_FILE | <repo>/data/history.ndjson | Override the persisted run-history file path. |`
  3. Dashboard section endpoint sentence: add `/history` and `/diagnostics` to the enumeration.
  4. "Architecture and persistence" section: amend the memory-only list — completed runs are now ALSO appended to the NDJSON file (logs/live state remain memory-only).
- [ ] **Step 2: Full pass** — `node --test scripts/api/accountEditor.test.js scripts/api/staticServer.test.js scripts/api/historyStore.test.js scripts/api/scheduleStore.test.js scripts/api/ui/cron.test.js scripts/api/ui/chartData.test.js`; `npm run lint`; `npm test`.
- [ ] **Step 3: e2e smoke** — with `HISTORY_FILE` in temp: start API, `GET /ui/views/ejecuciones.js` and `/ui/views/diagnosticos.js` → 200; seed the temp NDJSON with one record → `GET /history?persisted=1` returns it; `.gitignore` check: confirm `data/` is either already ignored or add `data/` to `.gitignore` (check first — if you add it, include it in the commit).
- [ ] **Step 4: Commit** — `docs(api): document persisted history and fase 3 dashboard views`.
