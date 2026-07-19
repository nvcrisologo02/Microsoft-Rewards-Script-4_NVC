# Rewards Control Dashboard — Fase 1 (Ver y controlar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a token-gated SPA dashboard at `http://127.0.0.1:3010/ui` from the existing Control API, with live status/points (SSE), start/stop/restart controls, a live log console, and a read-only accounts view.

**Architecture:** The existing dependency-free Control API (`scripts/api/server.js`) gains one new module (`staticServer.js`) that serves static files from `scripts/api/ui/` under the `/ui` path prefix, exempt from token auth (data endpoints stay token-gated). The frontend is a no-build Preact+htm SPA (single vendored ESM file), talking to the same origin via `fetch` and `EventSource`.

**Tech Stack:** Node.js ≥24 built-ins only on the server. Browser: vendored `htm/preact/standalone.module.js` (committed to the repo, installed with `npm i --no-save`, never added to package.json). No bundler, no build step.

**Reference spec:** `docs/superpowers/specs/2026-07-19-rewards-dashboard-design.md`

## Global Constraints

- Node.js `>=24.0.0` (from package.json engines).
- No new entries in package.json `dependencies`/`devDependencies`. Vendored browser libs are committed files under `scripts/api/ui/vendor/`.
- All `scripts/api/**` files are ESM `.js` (repo convention), 4-space indent, NO trailing semicolons (match `scripts/api/server.js` exactly; prettier enforces the repo style — run `npm run format:check` if unsure).
- UI copy is Spanish. Code identifiers/comments in English.
- Design tokens (exact values, from spec): bg `#0f1115`, surface `#171a21`, surface-2 `#1d212b`, border `#262b36`, ink `#e6e9ef`, accent `#3b82f6`, good `#22c55e`, warn `#f59e0b`, crit `#ef4444`. Radius 12px. Mono font stack `"JetBrains Mono","Cascadia Code",ui-monospace,Consolas,monospace`.
- Data endpoints keep requiring the token; only `/ui` static assets are exempt.
- Every task: run `npm run lint` (eslint covers `scripts/`) and fix new warnings before committing.
- Run tests with: `node --test scripts/api/staticServer.test.js` (the repo's `npm test` only globs `src/util/*.test.ts` — do not change that).
- Platform: must work on Windows (paths via `node:path`, no shell-isms in code).

---

### Task 1: Static file server module + `/ui` wiring

**Files:**
- Create: `scripts/api/staticServer.js`
- Create: `scripts/api/staticServer.test.js`
- Modify: `scripts/api/server.js` (imports at ~line 12; instantiate near line 57; call inside `requestHandler` before the auth gate at line 229; add `'GET /ui (dashboard)'` to the endpoints array at line 245)

**Interfaces:**
- Produces: `createUiHandler({ root }) → serveUi(req, res, pathname) → boolean` (true = request handled). Exported from `scripts/api/staticServer.js`.
- Later tasks rely on: GET `/ui` returns `scripts/api/ui/index.html`; `/ui/<file>` serves that file with correct MIME; unknown → 404 JSON; traversal blocked; no token required.

- [ ] **Step 1: Write the failing test**

Create `scripts/api/staticServer.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createUiHandler } from './staticServer.js'

function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ui-'))
    fs.writeFileSync(path.join(root, 'index.html'), '<title>Rewards Control</title>')
    fs.writeFileSync(path.join(root, 'styles.css'), 'body{color:red}')
    fs.writeFileSync(path.join(path.dirname(root), 'outside.txt'), 'secret')
    return root
}

async function withServer(fn) {
    const root = makeRoot()
    const serveUi = createUiHandler({ root })
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const pathname = url.pathname.replace(/\/+$/, '') || '/'
        if (serveUi(req, res, pathname)) return
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
        await fn(base)
    } finally {
        server.close()
        fs.rmSync(root, { recursive: true, force: true })
    }
}

test('GET /ui serves index.html without auth', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/ui`)
        assert.equal(res.status, 200)
        assert.match(res.headers.get('content-type'), /text\/html/)
        assert.match(await res.text(), /Rewards Control/)
    })
})

test('GET /ui/ (trailing slash, normalized upstream) serves index.html', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/ui/`)
        assert.equal(res.status, 200)
        assert.match(await res.text(), /Rewards Control/)
    })
})

test('GET /ui/styles.css serves css MIME', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/ui/styles.css`)
        assert.equal(res.status, 200)
        assert.match(res.headers.get('content-type'), /text\/css/)
    })
})

test('GET /ui/missing.js returns 404 JSON', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/ui/missing.js`)
        assert.equal(res.status, 404)
    })
})

test('encoded path traversal is blocked', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/ui/%2e%2e/outside.txt`)
        assert.equal(res.status, 404)
    })
})

test('POST /ui is rejected with 405', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/ui`, { method: 'POST' })
        assert.equal(res.status, 405)
    })
})

test('non-/ui paths are not handled', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/status`)
        assert.equal(res.status, 401)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/api/staticServer.test.js`
Expected: FAIL — `Cannot find module ... staticServer.js`

- [ ] **Step 3: Write the implementation**

Create `scripts/api/staticServer.js`:

```js
import fs from 'node:fs'
import path from 'node:path'

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
}

function sendJsonError(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: message }))
}

/**
 * Static handler for the dashboard SPA under the /ui prefix.
 * Returns true when it handled the request (even for errors inside /ui),
 * false when the path is not a /ui path so normal routing continues.
 * Intentionally auth-free: the SPA shell contains no secrets and every
 * data endpoint it calls still requires the API token.
 */
export function createUiHandler({ root }) {
    const absRoot = path.resolve(root)

    return function serveUi(req, res, pathname) {
        if (pathname !== '/ui' && !pathname.startsWith('/ui/')) return false

        const method = req.method ?? 'GET'
        if (method !== 'GET' && method !== 'HEAD') {
            sendJsonError(res, 405, 'Method not allowed')
            return true
        }

        let rel
        try {
            rel = decodeURIComponent(pathname.slice('/ui'.length)).replace(/^\/+/, '')
        } catch {
            sendJsonError(res, 400, 'Bad request path')
            return true
        }
        if (rel === '') rel = 'index.html'

        const full = path.resolve(absRoot, rel)
        if (full !== absRoot && !full.startsWith(absRoot + path.sep)) {
            sendJsonError(res, 404, 'Not found')
            return true
        }

        let stat
        try {
            stat = fs.statSync(full)
        } catch {
            sendJsonError(res, 404, 'Not found')
            return true
        }
        if (!stat.isFile()) {
            sendJsonError(res, 404, 'Not found')
            return true
        }

        const ext = path.extname(full).toLowerCase()
        const type = MIME[ext] ?? 'application/octet-stream'
        const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=300'
        res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': stat.size,
            'Cache-Control': cacheControl
        })
        if (method === 'HEAD') {
            res.end()
            return true
        }
        fs.createReadStream(full).pipe(res)
        return true
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/api/staticServer.test.js`
Expected: all 7 tests PASS.

- [ ] **Step 5: Wire into `server.js`**

In `scripts/api/server.js`:

1. Add to the import block (after the `sessionStore.js` import):

```js
import { createUiHandler } from './staticServer.js'
```

2. After the `pm` ProcessManager instantiation (around line 68), add:

```js
const serveUi = createUiHandler({ root: path.join(__dirname, 'ui') })
```

3. Inside `requestHandler`, immediately AFTER the `applyCors(res)` call and the `OPTIONS` block but BEFORE the `if (TOKEN && !isAuthorized(req, url))` auth gate, add:

```js
    // Dashboard SPA: static assets are served without a token. Every data
    // endpoint the SPA calls still goes through the auth gate below.
    if (serveUi(req, res, pathname)) return
```

4. In the `GET /` endpoints array, add `'GET /ui (dashboard)'` as the first entry.

Create the directory with a temporary placeholder so the route works before Task 2:
`scripts/api/ui/index.html` containing exactly:

```html
<!doctype html>
<meta charset="utf-8">
<title>Rewards Control</title>
<p>Dashboard en construcción (Task 2).</p>
```

- [ ] **Step 6: Verify against the real server**

Run (PowerShell, from repo root):

```powershell
$p = Start-Process node -ArgumentList 'scripts/api/server.js','-port','3999' -PassThru -NoNewWindow
Start-Sleep 2
curl.exe -s -o NUL -w "%{http_code} " http://127.0.0.1:3999/ui
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:3999/health
Stop-Process -Id $p.Id -Force
```

Expected output: `200 200` (health has no token configured locally; if `.env` sets API_TOKEN, expect `200 401` — both acceptable; `/ui` must be 200 either way).

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add scripts/api/staticServer.js scripts/api/staticServer.test.js scripts/api/server.js scripts/api/ui/index.html
git commit -m "feat(api): serve dashboard SPA statics under /ui"
```

---

### Task 2: SPA shell — vendored Preact, layout, navigation, design tokens

**Files:**
- Create: `scripts/api/ui/vendor/htm-preact-standalone.module.js` (vendored)
- Create: `scripts/api/ui/index.html` (replace Task 1 placeholder)
- Create: `scripts/api/ui/styles.css`
- Create: `scripts/api/ui/toast.js`
- Create: `scripts/api/ui/app.js`
- Create: `scripts/api/ui/views/placeholder.js`

**Interfaces:**
- Consumes: `/ui` static serving from Task 1.
- Produces:
  - Vendor module importable as `./vendor/htm-preact-standalone.module.js` exporting `html`, `render`, `useState`, `useEffect`, `useRef`, `useMemo`.
  - `toast.js` exporting `toast(message, kind)` where `kind ∈ 'ok'|'err'` (renders a transient notice, auto-removes after 4 s).
  - `app.js` renders the app; it defines the view registry `VIEWS` (array of `{ id, label, component }`) and passes each view component the props `{ state }` (store state — wired for real in Task 4; until then `state` is `null`).
  - CSS class contract used by all later view tasks: `card`, `grid-kpi`, `kpi`, `lbl`, `val`, `d`, `cols`, `row`, `bar`, `chips`, `chip` (+ `ok|now|err`), `badge` (+ `ok|err|mut`), `em`, `num`, `sess` (+ `has`), `acts`, `icon-btn`, `btn` (+ `primary|danger|sm`), `toolbar`, `fchip` (+ `on`), `console`, `lg-t lg-i lg-w lg-e lg-u lg-m lg-g`, `next`, `savebar`, `overlay`, `modal`.

- [ ] **Step 1: Vendor the library**

```bash
npm i --no-save htm preact
mkdir -p scripts/api/ui/vendor
cp node_modules/htm/preact/standalone.module.js scripts/api/ui/vendor/htm-preact-standalone.module.js
```

Verify the exports we need exist:

```bash
node -e "import('./scripts/api/ui/vendor/htm-preact-standalone.module.js').then(m => console.log(typeof m.html, typeof m.render, typeof m.useState, typeof m.useEffect, typeof m.useRef, typeof m.useMemo))"
```

Expected: `function function function function function function`.
If any prints `undefined`, instead build the vendor file by concatenating: copy `node_modules/htm/preact/index.module.js` plus its imports is NOT acceptable — in that case vendor three files (`preact.module.js`, `hooks.module.js`, `htm.module.js`) and add an import map to index.html mapping `preact` and `preact/hooks`. Only do this in the fallback case.

Note: `npm i --no-save` still rewrites `package-lock.json` timestamps sometimes — run `git checkout -- package-lock.json package.json` before committing if they show as modified.

- [ ] **Step 2: Write `index.html`**

Replace the placeholder `scripts/api/ui/index.html` with:

```html
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rewards Control</title>
<link rel="stylesheet" href="/ui/styles.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%233b82f6'/><text x='16' y='21' font-family='monospace' font-size='13' font-weight='bold' fill='white' text-anchor='middle'>RC</text></svg>">
</head>
<body>
<div id="root"></div>
<script type="module" src="/ui/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `styles.css`**

Create `scripts/api/ui/styles.css` with the full design system (tokens exactly as in Global Constraints):

```css
:root {
    --bg: #0f1115; --surface: #171a21; --surface-2: #1d212b; --border: #262b36;
    --ink: #e6e9ef; --ink-2: #9aa3b2; --ink-3: #6b7484;
    --accent: #3b82f6; --accent-soft: rgba(59, 130, 246, .14);
    --good: #22c55e; --warn: #f59e0b; --crit: #ef4444;
    --mono: "JetBrains Mono", "Cascadia Code", ui-monospace, Consolas, monospace;
    --r: 12px;
}
html { color-scheme: dark }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 Inter, system-ui, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased }
.app { display: grid; grid-template-columns: 216px 1fr; grid-template-rows: 56px 1fr; grid-template-areas: "side top" "side main"; min-height: 100vh }
.side { grid-area: side; background: var(--surface); border-right: 1px solid var(--border); padding: 14px 10px; display: flex; flex-direction: column; gap: 2px }
.logo { display: flex; align-items: center; gap: 10px; padding: 6px 10px 16px }
.logo .mark { width: 26px; height: 26px; border-radius: 8px; background: var(--accent); display: grid; place-items: center; font: 700 12px var(--mono); color: #fff }
.logo b { font-size: 14px }
.logo small { display: block; font-size: 10.5px; color: var(--ink-3) }
.nav { display: flex; flex-direction: column; gap: 2px }
.nav button { all: unset; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; color: var(--ink-2); cursor: pointer; font-size: 13.5px }
.nav button:hover { background: var(--surface-2); color: var(--ink) }
.nav button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px }
.nav button.on { background: var(--accent-soft); color: #bcd6ff }
.side .foot { margin-top: auto; padding: 10px; font-size: 11px; color: var(--ink-3); font-family: var(--mono) }
.top { grid-area: top; display: flex; align-items: center; gap: 14px; padding: 0 20px; background: var(--surface); border-bottom: 1px solid var(--border) }
.pill { display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px; border-radius: 99px; font-size: 12px; font-weight: 600; letter-spacing: .02em; border: 1px solid var(--border); color: var(--ink-2) }
.pill.run { background: rgba(34, 197, 94, .12); color: #5ee08a; border-color: rgba(34, 197, 94, .3) }
.pill.stopping { background: rgba(245, 158, 11, .12); color: #ffc861; border-color: rgba(245, 158, 11, .3) }
.pill.off { background: rgba(239, 68, 68, .12); color: #ff8b8b; border-color: rgba(239, 68, 68, .3) }
.dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor }
@media (prefers-reduced-motion: no-preference) {
    .pill.run .dot { animation: pulse 1.6s infinite }
    @keyframes pulse { 50% { opacity: .35 } }
}
.top .pts { margin-left: auto; text-align: right }
.top .pts b { font: 600 16px var(--mono); font-variant-numeric: tabular-nums }
.top .pts small { display: block; font-size: 11px; color: var(--good) }
.btn { border: 1px solid var(--border); background: var(--surface-2); color: var(--ink); border-radius: 8px; padding: 7px 14px; font: inherit; font-size: 13px; cursor: pointer }
.btn:hover { border-color: #39404f }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px }
.btn:disabled { opacity: .45; cursor: not-allowed }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600 }
.btn.danger { color: #ff8b8b; border-color: rgba(239, 68, 68, .4) }
.btn.sm { padding: 4px 9px; font-size: 12px; border-radius: 7px }
.main { grid-area: main; padding: 22px; overflow: auto }
.view { max-width: 1060px; margin: 0 auto }
h1 { font-size: 17px; margin: 0 0 4px }
.sub { color: var(--ink-2); font-size: 13px; margin: 0 0 18px }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 16px }
.grid-kpi { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 12px }
.kpi .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--ink-3) }
.kpi .val { font: 600 24px var(--mono); font-variant-numeric: tabular-nums; margin: 6px 0 2px }
.kpi .d { font-size: 12px; color: var(--ink-2) }
.kpi .d.up { color: var(--good) }
.kpi .d.down { color: #ff8b8b }
.cols { display: grid; grid-template-columns: 1.6fr 1fr; gap: 12px }
@media (max-width: 900px) {
    .cols { grid-template-columns: 1fr }
    .app { grid-template-columns: 60px 1fr }
    .nav button span, .logo b, .logo small, .side .foot { display: none }
}
.row { display: flex; align-items: center; gap: 10px }
.bar { height: 8px; border-radius: 99px; background: var(--surface-2); overflow: hidden; flex: 1 }
.bar i { display: block; height: 100%; background: var(--accent); border-radius: 99px; transition: width .4s }
.chips { display: flex; gap: 6px; flex-wrap: wrap }
.chip { padding: 3px 10px; border-radius: 99px; font-size: 12px; border: 1px solid var(--border); color: var(--ink-2) }
.chip.ok { color: #5ee08a; border-color: rgba(34, 197, 94, .35) }
.chip.now { color: #bcd6ff; border-color: rgba(59, 130, 246, .45); background: var(--accent-soft) }
.chip.err { color: #ff8b8b; border-color: rgba(239, 68, 68, .4) }
table { width: 100%; border-collapse: collapse; font-size: 13px }
th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); text-align: left; font-weight: 600; padding: 0 10px 8px }
td { padding: 11px 10px; border-top: 1px solid var(--border); vertical-align: middle }
tr { height: 44px }
.em { font-family: var(--mono); font-size: 12.5px }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right }
th.num { text-align: right }
.badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 99px; font-size: 11.5px; font-weight: 600 }
.badge.ok { background: rgba(34, 197, 94, .12); color: #5ee08a }
.badge.err { background: rgba(239, 68, 68, .12); color: #ff8b8b }
.badge.mut { background: var(--surface-2); color: var(--ink-2) }
.sess { font: 600 10.5px var(--mono); padding: 2px 6px; border-radius: 5px; border: 1px solid var(--border); color: var(--ink-3) }
.sess.has { color: #bcd6ff; border-color: rgba(59, 130, 246, .4) }
.acts { display: flex; gap: 4px; justify-content: flex-end }
.icon-btn { all: unset; cursor: pointer; padding: 5px 8px; border-radius: 6px; color: var(--ink-3); font-size: 12.5px }
.icon-btn:hover { background: var(--surface-2); color: var(--ink) }
.icon-btn:focus-visible { outline: 2px solid var(--accent) }
.icon-btn.danger:hover { color: #ff8b8b }
.console { background: #0b0d11; border: 1px solid var(--border); border-radius: var(--r); padding: 14px 16px; font: 12.5px/1.75 var(--mono); overflow: auto; max-height: 65vh; white-space: pre-wrap; word-break: break-word }
.lg-t { color: #4d5666 } .lg-i { color: #7dd3fc } .lg-w { color: var(--warn) } .lg-e { color: var(--crit) }
.lg-u { color: #a78bfa } .lg-m { color: #cdd3de } .lg-g { color: var(--good) }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap }
.toolbar input { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; color: var(--ink); padding: 7px 12px; font: inherit; font-size: 13px; min-width: 200px }
.fchip { padding: 4px 12px; border-radius: 99px; border: 1px solid var(--border); cursor: pointer; background: none; color: var(--ink-2); font: inherit; font-size: 12.5px }
.fchip.on { background: var(--accent-soft); color: #bcd6ff; border-color: rgba(59, 130, 246, .45) }
.next { list-style: none; margin: 6px 0 0; padding: 0 }
.next li { display: flex; justify-content: space-between; gap: 10px; padding: 9px 2px; border-top: 1px solid var(--border); font-size: 13px; color: var(--ink-2) }
.next li b { font-family: var(--mono); color: var(--ink); font-weight: 500; white-space: nowrap }
.savebar { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px }
.overlay { position: fixed; inset: 0; background: rgba(5, 7, 10, .65); display: grid; place-items: center; z-index: 9 }
.modal { width: min(440px, 92vw); background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px }
.modal h2 { margin: 0 0 14px; font-size: 15px }
.modal label { display: block; font-size: 11.5px; color: var(--ink-3); text-transform: uppercase; letter-spacing: .06em; margin: 12px 0 5px }
.modal input, .modal select { width: 100%; box-sizing: border-box; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; color: var(--ink); padding: 8px 11px; font: 13px var(--mono) }
.login { min-height: 100vh; display: grid; place-items: center }
.login .modal { width: min(380px, 92vw) }
.login .err { color: #ff8b8b; font-size: 12.5px; margin-top: 10px }
#toasts { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 20 }
.toast { background: var(--surface-2); border: 1px solid var(--border); border-left: 3px solid var(--good); border-radius: 8px; padding: 10px 14px; font-size: 13px; max-width: 340px }
.toast.err { border-left-color: var(--crit) }
.mt { margin-top: 12px }
```

- [ ] **Step 4: Write `toast.js`**

Create `scripts/api/ui/toast.js`:

```js
export function toast(message, kind = 'ok') {
    let host = document.getElementById('toasts')
    if (!host) {
        host = document.createElement('div')
        host.id = 'toasts'
        document.body.appendChild(host)
    }
    const el = document.createElement('div')
    el.className = kind === 'err' ? 'toast err' : 'toast'
    el.textContent = message
    host.appendChild(el)
    setTimeout(() => el.remove(), 4000)
}
```

- [ ] **Step 5: Write `views/placeholder.js` and `app.js`**

Create `scripts/api/ui/views/placeholder.js`:

```js
import { html } from '../vendor/htm-preact-standalone.module.js'

export function Placeholder({ title, phase }) {
    return html`<section class="view">
        <h1>${title}</h1>
        <p class="sub">Disponible en la ${phase} del dashboard.</p>
        <div class="card" style="color:var(--ink-3)">
            Esta sección aún no está implementada. La API ya expone los datos;
            la vista llegará en la ${phase}.
        </div>
    </section>`
}
```

Create `scripts/api/ui/app.js`:

```js
import { html, render, useState } from './vendor/htm-preact-standalone.module.js'
import { Placeholder } from './views/placeholder.js'

const VIEWS = [
    { id: 'resumen', label: 'Resumen', component: props => html`<${Placeholder} title="Resumen" phase="Fase 1 (Task 5)" ...${props} />` },
    { id: 'cuentas', label: 'Cuentas', component: props => html`<${Placeholder} title="Cuentas" phase="Fase 1 (Task 7)" ...${props} />` },
    { id: 'runs', label: 'Ejecuciones', component: props => html`<${Placeholder} title="Ejecuciones" phase="Fase 3" ...${props} />` },
    { id: 'logs', label: 'Logs', component: props => html`<${Placeholder} title="Logs" phase="Fase 1 (Task 6)" ...${props} />` },
    { id: 'config', label: 'Configuración', component: props => html`<${Placeholder} title="Configuración" phase="Fase 2" ...${props} />` },
    { id: 'schedule', label: 'Programación', component: props => html`<${Placeholder} title="Programación" phase="Fase 2" ...${props} />` },
    { id: 'diag', label: 'Diagnósticos', component: props => html`<${Placeholder} title="Diagnósticos" phase="Fase 3" ...${props} />` }
]

function Sidebar({ current, onNav }) {
    return html`<aside class="side">
        <div class="logo">
            <div class="mark">RC</div>
            <div><b>Rewards Control</b><small>${location.host}</small></div>
        </div>
        <nav class="nav">
            ${VIEWS.map(v => html`<button key=${v.id} class=${current === v.id ? 'on' : ''}
                onClick=${() => onNav(v.id)}><span>${v.label}</span></button>`)}
        </nav>
        <div class="foot">Fase 1</div>
    </aside>`
}

function Topbar() {
    return html`<header class="top">
        <span class="pill"><span class="dot"></span>SIN CONEXIÓN</span>
        <div class="pts"><b>— pts</b><small> </small></div>
    </header>`
}

function App() {
    const [current, setCurrent] = useState('resumen')
    const View = VIEWS.find(v => v.id === current).component
    return html`<div class="app">
        <${Sidebar} current=${current} onNav=${setCurrent} />
        <${Topbar} />
        <main class="main"><${View} state=${null} /></main>
    </div>`
}

render(html`<${App} />`, document.getElementById('root'))
```

- [ ] **Step 6: Teach eslint the browser globals**

The repo's `eslint.config.mjs` configures Node globals; the UI files use browser globals (`document`, `localStorage`, `fetch`, `EventSource`, `confirm`, `location`, `URL`, `Blob`). Open `eslint.config.mjs`, find where `globals` (already a devDependency) is used, and add a config block scoped to the UI (adapt to the file's existing structure):

```js
{
    files: ['scripts/api/ui/**/*.js'],
    languageOptions: { globals: { ...globals.browser } }
}
```

Run `npm run lint` — the UI files must produce no `no-undef` errors. Include `eslint.config.mjs` in this task's commit.

- [ ] **Step 7: Verify**

Syntax-check every module: `node --check scripts/api/ui/app.js scripts/api/ui/toast.js scripts/api/ui/views/placeholder.js`
Expected: no output (exit 0).

Start the API (`node scripts/api/server.js -port 3999`), then:
`curl.exe -s http://127.0.0.1:3999/ui | findstr "Rewards"` → prints the title line.
`curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:3999/ui/vendor/htm-preact-standalone.module.js` → `200`.
Stop the server.

- [ ] **Step 8: Lint and commit**

```bash
npm run lint
git add scripts/api/ui eslint.config.mjs
git commit -m "feat(ui): SPA shell with vendored preact, layout and navigation"
```

---

### Task 3: API client + token login gate

**Files:**
- Create: `scripts/api/ui/api.js`
- Modify: `scripts/api/ui/app.js` (wrap App in auth gate)

**Interfaces:**
- Consumes: shell from Task 2.
- Produces (exact, later tasks import these):
  - `api(path, { method, body }) → Promise<object>` — same-origin fetch, adds `Authorization: Bearer <token>` when a token is stored, JSON in/out, throws `ApiError` on non-2xx.
  - `class ApiError extends Error { status: number, body: object|null }`
  - `getToken(): string`, `setToken(t): void`, `clearToken(): void` — localStorage key `rc.apiToken`.

- [ ] **Step 1: Write `api.js`**

```js
const KEY = 'rc.apiToken'

export function getToken() {
    return localStorage.getItem(KEY) ?? ''
}
export function setToken(t) {
    localStorage.setItem(KEY, t)
}
export function clearToken() {
    localStorage.removeItem(KEY)
}

export class ApiError extends Error {
    constructor(status, body) {
        super(body?.error ?? `HTTP ${status}`)
        this.status = status
        this.body = body
    }
}

export async function api(path, { method = 'GET', body } = {}) {
    const headers = {}
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
    })
    let data = null
    try {
        data = await res.json()
    } catch { /* non-JSON response (e.g. empty) */ }
    if (!res.ok) throw new ApiError(res.status, data)
    return data
}
```

- [ ] **Step 2: Add the login gate to `app.js`**

Add imports at the top of `app.js`:

```js
import { useEffect } from './vendor/htm-preact-standalone.module.js'
import { api, ApiError, getToken, setToken, clearToken } from './api.js'
```

(Merge with the existing vendor import: `import { html, render, useState, useEffect } from './vendor/htm-preact-standalone.module.js'`.)

Add a `Login` component and an auth wrapper. Replace the existing `App` + `render` block with:

```js
function Login({ onOk }) {
    const [value, setValue] = useState('')
    const [error, setError] = useState('')
    const submit = async e => {
        e.preventDefault()
        setToken(value.trim())
        try {
            await api('/health')
            onOk()
        } catch (err) {
            clearToken()
            setError(err instanceof ApiError && err.status === 401
                ? 'Token incorrecto.'
                : 'No se puede conectar con la API.')
        }
    }
    return html`<div class="login"><form class="modal" onSubmit=${submit}>
        <h2>Rewards Control</h2>
        <label for="tok">Token de la API</label>
        <input id="tok" type="password" autofocus value=${value}
            onInput=${e => setValue(e.target.value)} placeholder="API_TOKEN" />
        ${error && html`<div class="err">${error}</div>`}
        <div class="savebar"><button class="btn primary" type="submit">Entrar</button></div>
    </form></div>`
}

function App() {
    // authed: null = probing, false = needs token, true = in
    const [authed, setAuthed] = useState(null)
    const [current, setCurrent] = useState('resumen')

    useEffect(() => {
        api('/health')
            .then(() => setAuthed(true))
            .catch(err => setAuthed(err instanceof ApiError && err.status === 401 ? false : true))
    }, [])

    if (authed === null) return html`<div class="login"><div style="color:var(--ink-3)">Conectando…</div></div>`
    if (authed === false) return html`<${Login} onOk=${() => setAuthed(true)} />`

    const View = VIEWS.find(v => v.id === current).component
    return html`<div class="app">
        <${Sidebar} current=${current} onNav=${setCurrent} />
        <${Topbar} />
        <main class="main"><${View} state=${null} /></main>
    </div>`
}

render(html`<${App} />`, document.getElementById('root'))
```

Note the probe deliberately treats network errors as `authed=true` so the app shell renders and the store (Task 4) surfaces the connection problem; only a explicit 401 shows the login.

- [ ] **Step 3: Verify**

`node --check scripts/api/ui/api.js scripts/api/ui/app.js` → exit 0.

Manual: start `node scripts/api/server.js -port 3999 -token testtoken123`, open `http://127.0.0.1:3999/ui` in a browser → login form appears; wrong token shows `Token incorrecto.`; `testtoken123` enters the shell. Without `-token`, the shell loads directly. (If no browser available in the session, verify with curl that `/health` returns 401 without token and 200 with it, and rely on `node --check`.)

- [ ] **Step 4: Lint and commit**

```bash
npm run lint
git add scripts/api/ui/api.js scripts/api/ui/app.js
git commit -m "feat(ui): api client and token login gate"
```

---

### Task 4: Live store (SSE) + live topbar

**Files:**
- Create: `scripts/api/ui/store.js`
- Modify: `scripts/api/ui/app.js` (connect store, live Topbar, pass `state` to views)

**Interfaces:**
- Consumes: `api.js` (`getToken`), SSE endpoint `GET /events?replay=200&token=…` emitting `hello`(full status), `status`(full status), `log`(entry) — see `scripts/api/README.md`.
- Produces (exact):
  - `connect(): void` — idempotent; opens the EventSource and keeps it alive with backoff (1 s doubling to max 30 s).
  - `subscribe(fn): () => void` — fn called with the state object after every change.
  - `getState(): State` where `State = { connected: boolean, status: object|null, logs: LogEntry[] }`; `logs` is a ring buffer capped at 500, newest last; `status` is the API `/status` shape (`state`, `run.collected`, `run.live`, `run.accounts`, `run.accountsTotal`, `run.accountsSeen`, `lastExit`).
- Status pill mapping used by Topbar and later views: `running|starting → 'run'`, `stopping → 'stopping'`, `idle → ''` (neutral), disconnected → `'off'`.

- [ ] **Step 1: Write `store.js`**

```js
import { getToken } from './api.js'

const MAX_LOGS = 500

const state = {
    connected: false,
    status: null,
    logs: []
}

const subs = new Set()

export function getState() {
    return state
}

export function subscribe(fn) {
    subs.add(fn)
    return () => subs.delete(fn)
}

function emit() {
    for (const fn of subs) fn(state)
}

let es = null
let retryMs = 1000
let retryTimer = null
let started = false

function open() {
    const token = getToken()
    const qs = new URLSearchParams({ replay: '200' })
    if (token) qs.set('token', token)
    es = new EventSource(`/events?${qs}`)

    es.addEventListener('hello', e => {
        state.connected = true
        retryMs = 1000
        state.status = JSON.parse(e.data)
        emit()
    })
    es.addEventListener('status', e => {
        state.status = JSON.parse(e.data)
        emit()
    })
    es.addEventListener('log', e => {
        state.logs.push(JSON.parse(e.data))
        if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS)
        emit()
    })
    es.onerror = () => {
        state.connected = false
        emit()
        es.close()
        es = null
        retryTimer = setTimeout(open, retryMs)
        retryMs = Math.min(retryMs * 2, 30000)
    }
}

export function connect() {
    if (started) return
    started = true
    open()
}

export function disconnect() {
    started = false
    if (retryTimer) clearTimeout(retryTimer)
    if (es) es.close()
    es = null
    state.connected = false
    emit()
}
```

- [ ] **Step 2: Wire the store into `app.js`**

Imports: `import { connect, subscribe, getState } from './store.js'`.

In `App`, after auth passes, connect and re-render on store changes:

```js
    const [, force] = useState(0)
    useEffect(() => {
        if (authed !== true) return
        connect()
        return subscribe(() => force(n => n + 1))
    }, [authed])
```

Replace the static `Topbar` with the live one:

```js
const PILL = {
    running: ['run', 'EN EJECUCIÓN'],
    starting: ['run', 'ARRANCANDO'],
    stopping: ['stopping', 'DETENIENDO'],
    idle: ['', 'INACTIVO']
}

function Topbar({ state }) {
    const st = state?.status?.state ?? 'idle'
    const [cls, label] = state?.connected ? (PILL[st] ?? PILL.idle) : ['off', 'SIN CONEXIÓN']
    const live = state?.status?.run?.live
    const collected = state?.status?.run?.collected ?? 0
    return html`<header class="top">
        <span class=${`pill ${cls}`}><span class="dot"></span>${label}</span>
        ${live?.currentAccount && html`<span style="color:var(--ink-3);font-size:12.5px">
            <span class="em" style="color:var(--ink-2)">${live.currentAccount}</span></span>`}
        <div class="pts">
            <b>${live?.currentBalance != null ? live.currentBalance.toLocaleString('es') : '—'} pts</b>
            <small>${collected > 0 ? `+${collected.toLocaleString('es')} en esta sesión` : ' '}</small>
        </div>
    </header>`
}
```

And in `App`'s final render, pass the state down:

```js
    const st = getState()
    return html`<div class="app">
        <${Sidebar} current=${current} onNav=${setCurrent} />
        <${Topbar} state=${st} />
        <main class="main"><${View} state=${st} /></main>
    </div>`
```

- [ ] **Step 3: Verify**

`node --check scripts/api/ui/store.js scripts/api/ui/app.js` → exit 0.
Start API on 3999, open `/ui`: pill shows INACTIVO (connected) — kill the API → pill flips to SIN CONEXIÓN; restart API → reconnects within 30 s. If no browser available: `node --check` plus code review of the SSE param names against `scripts/api/README.md` (`replay`, `token`, events `hello|status|log`).

- [ ] **Step 4: Lint and commit**

```bash
npm run lint
git add scripts/api/ui/store.js scripts/api/ui/app.js
git commit -m "feat(ui): live SSE store and topbar status"
```

---

### Task 5: Resumen view (KPIs, run progress, start/stop/restart)

**Files:**
- Create: `scripts/api/ui/views/resumen.js`
- Modify: `scripts/api/ui/app.js` (register the real component in `VIEWS`)

**Interfaces:**
- Consumes: `api()` from `api.js`; `toast()` from `toast.js`; `state` prop (`connected`, `status`); endpoints `POST /start {accountIndex?}`, `POST /stop {}`, `POST /restart {}`, `GET /schedule`, `GET /errors?limit=8`, `GET /accounts`.
- Produces: `export function Resumen({ state })`.

- [ ] **Step 1: Write `views/resumen.js`**

```js
import { html, useEffect, useState } from '../vendor/htm-preact-standalone.module.js'
import { api, ApiError } from '../api.js'
import { toast } from '../toast.js'

function fmt(n) {
    return n == null ? '—' : n.toLocaleString('es')
}

async function control(path, body, okMsg) {
    try {
        await api(path, { method: 'POST', body: body ?? {} })
        toast(okMsg)
    } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Sin conexión con la API'
        toast(msg, 'err')
    }
}

function AccountPicker({ accounts, onClose }) {
    const [index, setIndex] = useState(accounts[0]?.index ?? 1)
    return html`<div class="overlay" onClick=${e => { if (e.target === e.currentTarget) onClose() }}>
        <div class="modal" role="dialog" aria-label="Ejecutar una sola cuenta">
            <h2>Ejecutar una sola cuenta</h2>
            <label for="acc">Cuenta</label>
            <select id="acc" value=${index} onInput=${e => setIndex(Number(e.target.value))}>
                ${accounts.map(a => html`<option key=${a.index} value=${a.index}>${a.email}</option>`)}
            </select>
            <div class="savebar">
                <button class="btn" onClick=${onClose}>Cancelar</button>
                <button class="btn primary" onClick=${async () => {
                    await control('/start', { accountIndex: index }, 'Run de una cuenta iniciado')
                    onClose()
                }}>Iniciar</button>
            </div>
        </div>
    </div>`
}

export function Resumen({ state }) {
    const status = state?.status
    const run = status?.run
    const live = run?.live
    const [schedule, setSchedule] = useState(null)
    const [errors, setErrors] = useState([])
    const [accounts, setAccounts] = useState([])
    const [picker, setPicker] = useState(false)

    useEffect(() => {
        api('/schedule').then(setSchedule).catch(() => {})
        api('/accounts').then(d => setAccounts(d.accounts ?? [])).catch(() => {})
    }, [])
    useEffect(() => {
        api('/errors?limit=8').then(d => setErrors(d.errors ?? [])).catch(() => {})
    }, [status?.state])

    const busy = ['starting', 'running', 'stopping'].includes(status?.state)
    const accs = run?.accounts ?? []
    const okCount = accs.filter(a => a.success === true).length
    const failCount = accs.filter(a => a.success === false).length
    const seen = run?.accountsSeen ?? 0
    const total = run?.accountsTotal ?? 0
    const pct = total > 0 ? Math.round(seen / total * 100) : 0

    return html`<section class="view">
        <h1>Resumen</h1>
        <p class="sub">Estado del bot, progreso del run y últimos avisos.</p>
        <div class="grid-kpi">
            <div class="card kpi"><div class="lbl">Puntos esta sesión</div>
                <div class="val">${run?.collected ? `+${fmt(run.collected)}` : '0'}</div>
                <div class="d">${busy ? 'run en curso' : 'sin run activo'}</div></div>
            <div class="card kpi"><div class="lbl">Balance actual</div>
                <div class="val">${fmt(live?.currentBalance)}</div>
                <div class="d">${live?.currentAccount ?? 'cuenta activa'}</div></div>
            <div class="card kpi"><div class="lbl">Cuentas</div>
                <div class="val">${total ? `${okCount}/${total}` : '—'}</div>
                <div class="d ${failCount ? 'down' : ''}">${failCount ? `${failCount} con error` : 'sin errores'}</div></div>
            <div class="card kpi"><div class="lbl">Próximo run</div>
                <div class="val">${schedule?.enabled && schedule?.cron ? schedule.cron : '—'}</div>
                <div class="d">${schedule?.timezone ?? 'cron no configurado'}</div></div>
        </div>
        <div class="cols">
            <div class="card">
                <div class="row" style="justify-content:space-between;margin-bottom:12px">
                    <b style="font-size:13.5px">Run</b>
                    ${status?.startedAt && html`<span style="font:12px var(--mono);color:var(--ink-3)">
                        iniciado ${new Date(status.startedAt).toLocaleTimeString('es')}</span>`}
                </div>
                ${busy ? html`
                    <div class="row" style="margin-bottom:12px">
                        <span class="em">${live?.currentAccount ?? '…'}</span>
                        <div class="bar"><i style=${`width:${pct}%`}></i></div>
                        <span class="num" style="font-size:12px;color:var(--ink-2)">${seen}/${total}</span>
                    </div>
                    <div class="chips">
                        ${accs.map(a => html`<span key=${a.email} class=${
                            'chip ' + (a.success === true ? 'ok' : a.success === false ? 'err' : a.email === live?.currentAccount ? 'now' : '')
                        }>${a.email}${a.collectedPoints != null ? ` · +${fmt(a.collectedPoints)}` : ''}</span>`)}
                    </div>`
                : html`<p style="color:var(--ink-3);margin:0 0 6px">
                    No hay ningún run en marcha.${status?.lastExit ? ` Último proceso terminó con código ${status.lastExit.code}.` : ''}</p>`}
                <div class="savebar">
                    <button class="btn" disabled=${busy} onClick=${() => setPicker(true)}>Solo una cuenta…</button>
                    <button class="btn" disabled=${!busy} onClick=${() => {
                        if (confirm('¿Reiniciar el run actual?')) control('/restart', {}, 'Reinicio solicitado')
                    }}>Reiniciar</button>
                    ${busy
                        ? html`<button class="btn danger" onClick=${() => control('/stop', {}, 'Parada solicitada')}>Detener</button>`
                        : html`<button class="btn primary" onClick=${() => control('/start', {}, 'Run iniciado')}>Iniciar run</button>`}
                </div>
            </div>
            <div class="card">
                <b style="font-size:13.5px">Últimos avisos</b>
                ${errors.length === 0
                    ? html`<p style="color:var(--ink-3);font-size:13px">Sin warnings ni errores recientes.</p>`
                    : html`<ul class="next">${errors.slice(-8).reverse().map(e => html`<li key=${e.id}>
                        <span style=${e.level === 'error' ? 'color:#ff8b8b' : 'color:var(--warn)'}>
                            ${e.level === 'error' ? '✕' : '⚠'} ${e.title ?? ''} · ${e.message}</span>
                    </li>`)}</ul>`}
            </div>
        </div>
        ${picker && html`<${AccountPicker} accounts=${accounts} onClose=${() => setPicker(false)} />`}
    </section>`
}
```

- [ ] **Step 2: Register in `app.js`**

```js
import { Resumen } from './views/resumen.js'
```

and change the `resumen` entry of `VIEWS` to:

```js
    { id: 'resumen', label: 'Resumen', component: Resumen },
```

- [ ] **Step 3: Verify**

`node --check scripts/api/ui/views/resumen.js scripts/api/ui/app.js` → exit 0.
Start the API on 3999 and open `/ui`. With the bot idle: "Iniciar run" visible and enabled, KPIs show `—`/0, schedule KPI shows the cron if configured. Press Iniciar run → toast + pill turns EN EJECUCIÓN (the bot may fail quickly without accounts configured — the state transition is what's being verified). If a browser is unavailable, verify with curl that `POST /start` transitions `GET /status` state and review JSX shape mismatches manually against the `/status` sample in `scripts/api/README.md`.

- [ ] **Step 4: Lint and commit**

```bash
npm run lint
git add scripts/api/ui/views/resumen.js scripts/api/ui/app.js
git commit -m "feat(ui): resumen view with kpis, run progress and controls"
```

---

### Task 6: Logs view (live console, filters, pause, download)

**Files:**
- Create: `scripts/api/ui/views/logs.js`
- Modify: `scripts/api/ui/app.js` (register component)

**Interfaces:**
- Consumes: `state.logs` from the store (array of `{ id, ts, level, user, platform, title, message, raw }`), newest last.
- Produces: `export function Logs({ state })`.

- [ ] **Step 1: Write `views/logs.js`**

```js
import { html, useEffect, useMemo, useRef, useState } from '../vendor/htm-preact-standalone.module.js'

const LEVELS = ['todos', 'info', 'warn', 'error']
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 }

function levelClass(level) {
    if (level === 'error') return 'lg-e'
    if (level === 'warn') return 'lg-w'
    return 'lg-i'
}

export function Logs({ state }) {
    const [level, setLevel] = useState('todos')
    const [query, setQuery] = useState('')
    const [paused, setPaused] = useState(false)
    const frozen = useRef([])
    const boxRef = useRef(null)

    const source = paused ? frozen.current : (state?.logs ?? [])

    const entries = useMemo(() => {
        const min = level === 'todos' ? 0 : LEVEL_RANK[level]
        const q = query.trim().toLowerCase()
        return source.filter(e => {
            if ((LEVEL_RANK[e.level] ?? 1) < min) return false
            if (!q) return true
            return [e.user, e.title, e.message, e.platform]
                .some(f => typeof f === 'string' && f.toLowerCase().includes(q))
        })
    }, [source, level, query])

    useEffect(() => {
        const box = boxRef.current
        if (box && !paused) box.scrollTop = box.scrollHeight
    }, [entries.length, paused])

    const togglePause = () => {
        if (!paused) frozen.current = [...(state?.logs ?? [])]
        setPaused(!paused)
    }

    const download = () => {
        const text = (state?.logs ?? []).map(e => e.raw ?? e.message).join('\n')
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
        a.download = `rewards-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`
        a.click()
        URL.revokeObjectURL(a.href)
    }

    return html`<section class="view">
        <h1>Logs</h1>
        <p class="sub">Stream en vivo por SSE · búfer local de 500 entradas.</p>
        <div class="toolbar">
            ${LEVELS.map(l => html`<button key=${l} class=${'fchip' + (level === l ? ' on' : '')}
                onClick=${() => setLevel(l)}>${l[0].toUpperCase() + l.slice(1)}</button>`)}
            <input placeholder="Filtrar… (cuenta, título, texto)" aria-label="Filtrar logs"
                value=${query} onInput=${e => setQuery(e.target.value)} />
            <button class="btn sm" onClick=${togglePause}>${paused ? '▶ Reanudar' : '⏸ Pausar'}</button>
            <button class="btn sm" onClick=${download}>↓ Descargar</button>
        </div>
        <div class="console" ref=${boxRef}>
            ${entries.length === 0
                ? html`<span style="color:var(--ink-3)">Sin entradas todavía. Inicia un run para ver logs.</span>`
                : entries.map(e => html`<div key=${e.id}><span class="lg-t">[${e.ts ?? ''}]</span>${' '}
                    ${e.user && html`<span class="lg-u">[${e.user}]</span> `}
                    <span class=${levelClass(e.level)}>[${e.platform ?? ''}${e.platform && e.title ? ' ' : ''}${e.title ?? ''}]</span>${' '}
                    <span class="lg-m">${e.message}</span></div>`)}
        </div>
    </section>`
}
```

- [ ] **Step 2: Register in `app.js`**

```js
import { Logs } from './views/logs.js'
```

`VIEWS` entry: `{ id: 'logs', label: 'Logs', component: Logs },`

- [ ] **Step 3: Verify**

`node --check scripts/api/ui/views/logs.js scripts/api/ui/app.js` → exit 0.
With the API running and a run started, the console fills live, filter by `error` narrows the list, pause freezes it while the buffer keeps growing, download produces a `.txt`. Headless fallback: `node --check` + manual review that field names (`id, ts, level, user, platform, title, message, raw`) match the `/logs` sample in `scripts/api/README.md`.

- [ ] **Step 4: Lint and commit**

```bash
npm run lint
git add scripts/api/ui/views/logs.js scripts/api/ui/app.js
git commit -m "feat(ui): live logs view with filters, pause and download"
```

---

### Task 7: Cuentas view (read-only + run-one + delete sessions)

**Files:**
- Create: `scripts/api/ui/views/cuentas.js`
- Modify: `scripts/api/ui/app.js` (register component)

**Interfaces:**
- Consumes: `GET /accounts` (`{ accounts: [{ index, email, geoLocale, runs, totalCollected, successStreak, lastCollected, lastSuccess, lastError }] }`), `GET /sessions` (`{ sessions: [{ email, platform, updatedAt }] }`), `POST /start {accountIndex}`, `DELETE /sessions/:email` (409 while a run is active); `state.status.state` for disabling actions while busy.
- Produces: `export function Cuentas({ state })`.

- [ ] **Step 1: Write `views/cuentas.js`**

```js
import { html, useEffect, useState } from '../vendor/htm-preact-standalone.module.js'
import { api, ApiError } from '../api.js'
import { toast } from '../toast.js'

function fmt(n) {
    return n == null ? '—' : n.toLocaleString('es')
}

export function Cuentas({ state }) {
    const [accounts, setAccounts] = useState(null)
    const [sessions, setSessions] = useState([])
    const [query, setQuery] = useState('')
    const busy = ['starting', 'running', 'stopping'].includes(state?.status?.state)

    const load = () => {
        api('/accounts').then(d => setAccounts(d.accounts ?? [])).catch(() => setAccounts([]))
        api('/sessions').then(d => setSessions(d.sessions ?? [])).catch(() => setSessions([]))
    }
    useEffect(load, [])

    const sessionsFor = email => {
        const mine = sessions.filter(s => s.email?.toLowerCase() === email.toLowerCase())
        return {
            desktop: mine.some(s => s.platform === 'desktop'),
            mobile: mine.some(s => s.platform === 'mobile')
        }
    }

    const runOne = async a => {
        try {
            await api('/start', { method: 'POST', body: { accountIndex: a.index } })
            toast(`Run iniciado solo para ${a.email}`)
        } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Sin conexión con la API', 'err')
        }
    }

    const deleteSessions = async a => {
        if (!confirm(`¿Borrar las sesiones guardadas de ${a.email}? Tendrá que iniciar sesión de nuevo en el próximo run.`)) return
        try {
            const res = await api(`/sessions/${encodeURIComponent(a.email)}`, { method: 'DELETE' })
            toast(`Sesiones borradas (${res.removed})`)
            load()
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) toast('No se puede borrar con un run activo.', 'err')
            else if (err instanceof ApiError && err.status === 404) toast('Esta cuenta no tiene sesiones guardadas.', 'err')
            else toast('Error al borrar las sesiones.', 'err')
        }
    }

    const list = (accounts ?? []).filter(a => a.email.toLowerCase().includes(query.trim().toLowerCase()))

    return html`<section class="view">
        <h1>Cuentas</h1>
        <p class="sub">${accounts ? `${accounts.length} cuentas configuradas en .env` : 'Cargando…'} · edición disponible en la Fase 2.</p>
        <div class="card" style="padding:16px 6px 6px">
            <div class="toolbar" style="padding:0 10px">
                <input placeholder="Buscar cuenta…" aria-label="Buscar cuenta"
                    value=${query} onInput=${e => setQuery(e.target.value)} />
                <span style="flex:1"></span>
                <button class="btn sm" onClick=${load}>↻ Recargar</button>
            </div>
            <table>
                <thead><tr><th>Cuenta</th><th>Región</th><th class="num">Recogido</th><th class="num">Racha</th>
                    <th>Sesiones</th><th>Último run</th><th></th></tr></thead>
                <tbody>
                ${list.map(a => {
                    const s = sessionsFor(a.email)
                    return html`<tr key=${a.index}>
                        <td class="em">${a.email}</td>
                        <td>${a.geoLocale ?? '—'}</td>
                        <td class="num">${fmt(a.totalCollected)}</td>
                        <td class="num">${fmt(a.successStreak)}</td>
                        <td><span class=${'sess' + (s.desktop ? ' has' : '')}>D</span>${' '}
                            <span class=${'sess' + (s.mobile ? ' has' : '')}>M</span></td>
                        <td>${a.lastSuccess === true ? html`<span class="badge ok">✓ ${a.lastCollected != null ? `+${fmt(a.lastCollected)}` : 'ok'}</span>`
                            : a.lastSuccess === false ? html`<span class="badge err">✕ ${a.lastError ?? 'falló'}</span>`
                            : html`<span class="badge mut">sin datos</span>`}</td>
                        <td class="acts">
                            <button class="icon-btn" title="Ejecutar solo esta cuenta" disabled=${busy}
                                onClick=${() => runOne(a)}>▶</button>
                            <button class="icon-btn danger" title="Borrar sesiones guardadas" disabled=${busy}
                                onClick=${() => deleteSessions(a)}>🗑</button>
                        </td>
                    </tr>`
                })}
                </tbody>
            </table>
            ${accounts && accounts.length === 0 && html`<p style="padding:0 10px;color:var(--ink-3)">
                No hay cuentas en .env. Añade bloques ACCOUNT_1_* siguiendo env.example.</p>`}
        </div>
    </section>`
}
```

- [ ] **Step 2: Register in `app.js`**

```js
import { Cuentas } from './views/cuentas.js'
```

`VIEWS` entry: `{ id: 'cuentas', label: 'Cuentas', component: Cuentas },`

- [ ] **Step 3: Verify**

`node --check scripts/api/ui/views/cuentas.js scripts/api/ui/app.js` → exit 0.
With the API running: the table lists the `.env` accounts with session chips matching `GET /sessions`; "borrar sesiones" on an account with stored sessions asks for confirmation and the chips go grey after; while a run is active both actions are disabled. Headless fallback: `node --check` + `curl /accounts` and `curl /sessions` field-shape comparison.

- [ ] **Step 4: Lint and commit**

```bash
npm run lint
git add scripts/api/ui/views/cuentas.js scripts/api/ui/app.js
git commit -m "feat(ui): read-only accounts view with run-one and session deletion"
```

---

### Task 8: Docs + end-to-end verification

**Files:**
- Modify: `scripts/api/README.md` (add a "Dashboard" section after "Quick start")
- Modify: `README.md` only if it documents `npm run api` (check first; if it does not mention the API, leave it untouched)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Document the dashboard**

In `scripts/api/README.md`, after the "Quick start" section, insert:

```markdown
## Dashboard

The API serves a built-in dashboard SPA at:

```text
http://127.0.0.1:3010/ui
```

Static dashboard assets under `/ui` do not require the API token; every data
endpoint the dashboard calls still does. When `API_TOKEN` is set, the dashboard
shows a login screen and stores the token in the browser's localStorage.

The dashboard is a no-build Preact application vendored under
`scripts/api/ui/`. It uses the documented endpoints only: `/events` for live
logs and status, `/status`, `/points`, `/accounts`, `/sessions`, `/schedule`,
`/errors`, and the `/start`, `/stop`, `/restart` controls.
```

- [ ] **Step 2: Full test pass**

```bash
node --test scripts/api/staticServer.test.js
npm run lint
npm test
```

Expected: static server tests pass, lint clean, existing `src/util` tests unaffected.

- [ ] **Step 3: End-to-end smoke**

Start `node scripts/api/server.js -port 3999 -token smoketest`, then verify:
- `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:3999/ui` → `200`
- `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:3999/status` → `401`
- `curl.exe -s -o NUL -w "%{http_code}" -H "Authorization: Bearer smoketest" http://127.0.0.1:3999/status` → `200`
- Open `http://127.0.0.1:3999/ui` in a browser: login with `smoketest`, navigate all 7 sidebar entries, no console errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/api/README.md
git commit -m "docs(api): document the /ui dashboard"
```
