# Rewards Control Dashboard — Fase 2 (Gestionar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full account CRUD from the dashboard (writing `.env` safely behind an opt-in flag), a validated configuration editor, and a visual cron schedule editor.

**Architecture:** One new backend module (`scripts/api/accountEditor.js`) owns all `.env` account parsing/writing (atomic, backed-up, dense renumbering, secrets write-only) plus a `refreshProcessEnv` step — required because `lib.js#loadEnvFile` never overrides existing `process.env` keys and `accounts.js#loadAccounts` reads from `process.env`, so without a refresh the API and child bot processes would keep stale accounts after an edit. `server.js` gains CRUD routes gated by `API_ALLOW_ACCOUNT_WRITE`. The frontend gains an account modal, a generic config-form view with diff+PATCH, and a schedule view with a pure client-side cron parser (`ui/cron.js`, unit-tested with node:test).

**Tech Stack:** Node.js ≥24 built-ins only on the server. Frontend continues the Fase 1 no-build Preact stack.

**Reference spec:** `docs/superpowers/specs/2026-07-19-rewards-dashboard-design.md` (secciones: extensiones de API, pantallas 2/5/6, seguridad, manejo de errores).

## Global Constraints

- Node.js `>=24.0.0`; no new entries in package.json `dependencies`/`devDependencies`.
- `scripts/api/**` files are ESM `.js`, 4-space indent, NO trailing semicolons (match `scripts/api/server.js`). UI copy Spanish; identifiers/comments English.
- Secrets (`PASSWORD`, `TOTP_SECRET`, `PROXY_PASSWORD`) are **write-only**: accepted in request bodies, never returned by any endpoint, never rendered by the UI. Empty/omitted secret on edit = keep existing value.
- Every `.env` write: copy current file to `.env.bak` first, write to a temp file, `fs.renameSync` over the original (atomic on Windows and POSIX). Reject any field value containing `\n` or `\r` (env-injection guard).
- Write endpoints each gate on their own opt-in env var and return `403` with a hint naming the variable when disabled: accounts → `API_ALLOW_ACCOUNT_WRITE`, config → `API_ALLOW_CONFIG_WRITE` (already implemented), schedule → `API_ALLOW_SCHEDULE_WRITE` (already implemented).
- Account writes also require the bot to be idle (`409` otherwise) — a running child process holds the old env.
- **Never run write-route smoke tests against the repo's real `.env`.** Route smokes launch the server with `cwd` set to a temp directory containing a scratch `.env` (`loadEnvFile` prefers `process.cwd()/.env`).
- Tests: `node --test scripts/api/accountEditor.test.js scripts/api/staticServer.test.js scripts/api/ui/cron.test.js` (do not change the repo `npm test` glob). `npm run lint` clean before each commit.
- All commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Work happens on branch `feature/rewards-dashboard-fase2`.

## `.env` account field model (used by Tasks 1-3)

Canonical suffix order (from `env.example`): `EMAIL, PASSWORD, TOTP_SECRET, RECOVERY_EMAIL, GEO_LOCALE, LANG_CODE, PROXY_HTTP, PROXY_URL, PROXY_PORT, PROXY_USERNAME, PROXY_PASSWORD, SAVE_FINGERPRINT_MOBILE, SAVE_FINGERPRINT_DESKTOP`. Unknown `ACCOUNT_<n>_<SUFFIX>` keys found in the file must be preserved on rewrite (appended after the known ones).

---

### Task 1: `accountEditor.js` — parse, mutate and atomically rewrite `.env` accounts

**Files:**
- Create: `scripts/api/accountEditor.js`
- Create: `scripts/api/accountEditor.test.js`

**Interfaces (Produces — exact, later tasks import these):**
- `class AccountEditorError extends Error { status: number }`
- `readEnvAccounts(envPath) → { lines: string[], accounts: [{ index: number, fields: Record<string,string> }] }` (fields keyed by SUFFIX; commented lines ignored; missing file → empty)
- `accountDetail(envPath, index) → object|null` — `{ index, email, recoveryEmail, geoLocale, langCode, proxy: { http, url, port, username, hasPassword }, saveFingerprint: { mobile, desktop }, hasPassword, hasTotp }` — never any secret value
- `upsertAccount(envPath, targetIndex: number|null, body) → { index }` — `targetIndex null` creates a new slot; throws `AccountEditorError` (400 validation, 404 unknown index)
- `deleteAccount(envPath, index) → { removed: true }` — dense renumbering of remaining slots; throws 404 if unknown
- `refreshProcessEnv(envPath, env = process.env) → void` — deletes every `ACCOUNT_<n>_*` key from `env`, then re-sets from the file
- Body shape accepted by `upsertAccount` (all optional except noted): `{ email (required on create), password (required on create), totpSecret, recoveryEmail, geoLocale, langCode, proxy: { http, url, port, username, password }, saveFingerprintMobile, saveFingerprintDesktop }`

- [ ] **Step 1: Write the failing tests**

Create `scripts/api/accountEditor.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
    AccountEditorError,
    readEnvAccounts,
    accountDetail,
    upsertAccount,
    deleteAccount,
    refreshProcessEnv
} from './accountEditor.js'

function makeEnv(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-env-'))
    const envPath = path.join(dir, '.env')
    if (content !== null) fs.writeFileSync(envPath, content)
    return { dir, envPath }
}

const SAMPLE = [
    '# Account Credentials',
    'API_PORT=3010',
    '',
    '# Account 1',
    'ACCOUNT_1_EMAIL=a@example.com',
    'ACCOUNT_1_PASSWORD=secret-a',
    'ACCOUNT_1_GEO_LOCALE=ES',
    '#ACCOUNT_1_TOTP_SECRET=',
    '',
    'ACCOUNT_2_EMAIL=b@example.com',
    'ACCOUNT_2_PASSWORD=secret-b',
    'ACCOUNT_2_CUSTOM_FLAG=yes',
    '',
    'TRAILING=1'
].join('\n')

test('readEnvAccounts parses active lines, ignores comments', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        const { accounts } = readEnvAccounts(envPath)
        assert.equal(accounts.length, 2)
        assert.equal(accounts[0].fields.EMAIL, 'a@example.com')
        assert.equal(accounts[0].fields.TOTP_SECRET, undefined)
        assert.equal(accounts[1].fields.CUSTOM_FLAG, 'yes')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('accountDetail exposes flags but never secrets', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        const d = accountDetail(envPath, 1)
        assert.equal(d.email, 'a@example.com')
        assert.equal(d.hasPassword, true)
        assert.equal(d.hasTotp, false)
        assert.equal(JSON.stringify(d).includes('secret-a'), false)
        assert.equal(accountDetail(envPath, 9), null)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('create appends a new dense slot and preserves other lines', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        const { index } = upsertAccount(envPath, null, { email: 'c@example.com', password: 'secret-c' })
        assert.equal(index, 3)
        const text = fs.readFileSync(envPath, 'utf8')
        assert.match(text, /ACCOUNT_3_EMAIL=c@example\.com/)
        assert.match(text, /API_PORT=3010/)
        assert.match(text, /TRAILING=1/)
        assert.match(text, /#ACCOUNT_1_TOTP_SECRET=/)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('edit with omitted secret keeps the old password', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        upsertAccount(envPath, 1, { email: 'a2@example.com', password: '' })
        const { accounts } = readEnvAccounts(envPath)
        assert.equal(accounts[0].fields.EMAIL, 'a2@example.com')
        assert.equal(accounts[0].fields.PASSWORD, 'secret-a')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('delete renumbers densely and preserves unknown suffixes', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        deleteAccount(envPath, 1)
        const { accounts } = readEnvAccounts(envPath)
        assert.equal(accounts.length, 1)
        assert.equal(accounts[0].index, 1)
        assert.equal(accounts[0].fields.EMAIL, 'b@example.com')
        assert.equal(accounts[0].fields.CUSTOM_FLAG, 'yes')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('writes create a .bak backup and no stray temp files', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        upsertAccount(envPath, null, { email: 'c@example.com', password: 'x' })
        assert.equal(fs.existsSync(envPath + '.bak'), true)
        const stray = fs.readdirSync(dir).filter(f => f.includes('.tmp'))
        assert.deepEqual(stray, [])
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('rejects newline injection and missing create fields', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        assert.throws(() => upsertAccount(envPath, null, { email: 'x@example.com', password: 'a\nINJECTED=1' }), AccountEditorError)
        assert.throws(() => upsertAccount(envPath, null, { email: 'no-password@example.com' }), AccountEditorError)
        assert.throws(() => upsertAccount(envPath, null, { email: 'not-an-email', password: 'x' }), AccountEditorError)
        assert.throws(() => upsertAccount(envPath, 9, { email: 'x@example.com' }), AccountEditorError)
        assert.throws(() => deleteAccount(envPath, 9), AccountEditorError)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('refreshProcessEnv replaces stale ACCOUNT_* keys', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        const env = { ACCOUNT_1_EMAIL: 'stale@example.com', ACCOUNT_9_EMAIL: 'ghost@example.com', OTHER: 'keep' }
        refreshProcessEnv(envPath, env)
        assert.equal(env.ACCOUNT_1_EMAIL, 'a@example.com')
        assert.equal(env.ACCOUNT_9_EMAIL, undefined)
        assert.equal(env.OTHER, 'keep')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('missing file: read returns empty, create makes slot 1', () => {
    const { dir, envPath } = makeEnv(null)
    try {
        assert.deepEqual(readEnvAccounts(envPath).accounts, [])
        const { index } = upsertAccount(envPath, null, { email: 'a@example.com', password: 'x' })
        assert.equal(index, 1)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/api/accountEditor.test.js`
Expected: FAIL — `Cannot find module ... accountEditor.js`

- [ ] **Step 3: Write the implementation**

Create `scripts/api/accountEditor.js`:

```js
import fs from 'node:fs'

const FIELD_ORDER = [
    'EMAIL',
    'PASSWORD',
    'TOTP_SECRET',
    'RECOVERY_EMAIL',
    'GEO_LOCALE',
    'LANG_CODE',
    'PROXY_HTTP',
    'PROXY_URL',
    'PROXY_PORT',
    'PROXY_USERNAME',
    'PROXY_PASSWORD',
    'SAVE_FINGERPRINT_MOBILE',
    'SAVE_FINGERPRINT_DESKTOP'
]
const SECRET_FIELDS = new Set(['PASSWORD', 'TOTP_SECRET', 'PROXY_PASSWORD'])
const LINE_RE = /^ACCOUNT_(\d+)_([A-Z0-9_]+)=(.*)$/

export class AccountEditorError extends Error {
    constructor(status, message) {
        super(message)
        this.status = status
    }
}

export function readEnvAccounts(envPath) {
    const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
    const lines = text.length ? text.split(/\r?\n/) : []
    const slots = new Map()
    for (const line of lines) {
        const m = LINE_RE.exec(line)
        if (!m) continue
        const index = Number(m[1])
        if (!slots.has(index)) slots.set(index, {})
        slots.get(index)[m[2]] = m[3]
    }
    const accounts = [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([index, fields]) => ({ index, fields }))
    return { lines, accounts }
}

export function accountDetail(envPath, index) {
    const { accounts } = readEnvAccounts(envPath)
    const account = accounts.find(a => a.index === index)
    if (!account) return null
    const f = account.fields
    return {
        index,
        email: f.EMAIL ?? '',
        recoveryEmail: f.RECOVERY_EMAIL ?? '',
        geoLocale: f.GEO_LOCALE ?? '',
        langCode: f.LANG_CODE ?? '',
        proxy: {
            http: f.PROXY_HTTP === 'true',
            url: f.PROXY_URL ?? '',
            port: f.PROXY_PORT ?? '',
            username: f.PROXY_USERNAME ?? '',
            hasPassword: Boolean(f.PROXY_PASSWORD)
        },
        saveFingerprint: {
            mobile: f.SAVE_FINGERPRINT_MOBILE === 'true',
            desktop: f.SAVE_FINGERPRINT_DESKTOP === 'true'
        },
        hasPassword: Boolean(f.PASSWORD),
        hasTotp: Boolean(f.TOTP_SECRET)
    }
}

function assertSafeValue(name, value) {
    if (typeof value !== 'string') return
    if (value.includes('\n') || value.includes('\r')) {
        throw new AccountEditorError(400, `${name} must not contain newlines`)
    }
}

// Maps an API body onto env-field suffixes. `existing` supplies kept secrets.
function fieldsFromBody(body, existing = {}) {
    const out = { ...existing }
    const setOrKeep = (suffix, value, { secret = false } = {}) => {
        if (value === undefined || value === null) return
        const str = String(value)
        assertSafeValue(suffix, str)
        if (secret && str === '') return
        if (str === '') {
            delete out[suffix]
            return
        }
        out[suffix] = str
    }
    setOrKeep('EMAIL', body.email)
    setOrKeep('PASSWORD', body.password, { secret: true })
    setOrKeep('TOTP_SECRET', body.totpSecret, { secret: true })
    setOrKeep('RECOVERY_EMAIL', body.recoveryEmail)
    setOrKeep('GEO_LOCALE', body.geoLocale)
    setOrKeep('LANG_CODE', body.langCode)
    if (body.proxy && typeof body.proxy === 'object') {
        setOrKeep('PROXY_HTTP', body.proxy.http === undefined ? undefined : String(Boolean(body.proxy.http)))
        setOrKeep('PROXY_URL', body.proxy.url)
        setOrKeep('PROXY_PORT', body.proxy.port)
        setOrKeep('PROXY_USERNAME', body.proxy.username)
        setOrKeep('PROXY_PASSWORD', body.proxy.password, { secret: true })
    }
    if (body.saveFingerprintMobile !== undefined) out.SAVE_FINGERPRINT_MOBILE = String(Boolean(body.saveFingerprintMobile))
    if (body.saveFingerprintDesktop !== undefined) out.SAVE_FINGERPRINT_DESKTOP = String(Boolean(body.saveFingerprintDesktop))
    return out
}

function serializeAccounts(accounts) {
    const out = []
    accounts.forEach((account, i) => {
        const slot = i + 1
        out.push(`# Account ${slot}`)
        const known = FIELD_ORDER.filter(f => account.fields[f] !== undefined && account.fields[f] !== '')
        const unknown = Object.keys(account.fields)
            .filter(f => !FIELD_ORDER.includes(f) && account.fields[f] !== undefined && account.fields[f] !== '')
            .sort()
        for (const f of [...known, ...unknown]) out.push(`ACCOUNT_${slot}_${f}=${account.fields[f]}`)
        out.push('')
    })
    return out
}

function writeEnvAccounts(envPath, priorLines, accounts) {
    let insertAt = -1
    const kept = []
    for (const line of priorLines) {
        if (LINE_RE.test(line)) {
            if (insertAt === -1) insertAt = kept.length
            continue
        }
        if (/^# Account \d+$/.test(line.trim())) continue
        kept.push(line)
    }
    if (insertAt === -1) insertAt = kept.length
    const next = [...kept.slice(0, insertAt), ...serializeAccounts(accounts), ...kept.slice(insertAt)]
    const text = next.join('\n')
    if (fs.existsSync(envPath)) fs.copyFileSync(envPath, envPath + '.bak')
    const tmp = `${envPath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, envPath)
}

export function upsertAccount(envPath, targetIndex, body = {}) {
    const { lines, accounts } = readEnvAccounts(envPath)
    const isCreate = targetIndex === null || targetIndex === undefined

    if (isCreate) {
        if (!body.email) throw new AccountEditorError(400, 'email is required')
        if (!body.password) throw new AccountEditorError(400, 'password is required for a new account')
    }
    if (body.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email))) {
        throw new AccountEditorError(400, 'email is not a valid address')
    }
    if (body.proxy?.port !== undefined && body.proxy.port !== '' && !/^\d+$/.test(String(body.proxy.port))) {
        throw new AccountEditorError(400, 'proxy.port must be numeric')
    }

    let index
    if (isCreate) {
        accounts.push({ index: accounts.length + 1, fields: fieldsFromBody(body) })
        index = accounts.length
    } else {
        const account = accounts.find(a => a.index === targetIndex)
        if (!account) throw new AccountEditorError(404, `account ${targetIndex} not found`)
        account.fields = fieldsFromBody(body, account.fields)
        index = accounts.findIndex(a => a === account) + 1
    }
    writeEnvAccounts(envPath, lines, accounts)
    return { index }
}

export function deleteAccount(envPath, index) {
    const { lines, accounts } = readEnvAccounts(envPath)
    const remaining = accounts.filter(a => a.index !== index)
    if (remaining.length === accounts.length) throw new AccountEditorError(404, `account ${index} not found`)
    writeEnvAccounts(envPath, lines, remaining)
    return { removed: true }
}

export function refreshProcessEnv(envPath, env = process.env) {
    for (const key of Object.keys(env)) {
        if (/^ACCOUNT_\d+_/.test(key)) delete env[key]
    }
    const { accounts } = readEnvAccounts(envPath)
    accounts.forEach((account, i) => {
        const slot = i + 1
        for (const [suffix, value] of Object.entries(account.fields)) {
            env[`ACCOUNT_${slot}_${suffix}`] = value
        }
    })
}

export { SECRET_FIELDS }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/api/accountEditor.test.js`
Expected: all 9 tests PASS.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add scripts/api/accountEditor.js scripts/api/accountEditor.test.js
git commit -m "feat(api): env-backed account editor with atomic writes"
```

---

### Task 2: Account CRUD routes in `server.js`

**Files:**
- Modify: `scripts/api/server.js`

**Interfaces:**
- Consumes: everything exported by `scripts/api/accountEditor.js` (Task 1).
- Produces (HTTP contract for Task 3):
  - `GET /accounts/:index` → 200 `accountDetail` shape | 404 `{error, code:'ACCOUNT_NOT_FOUND'}` (token required like every data endpoint; NO write flag needed)
  - `POST /accounts` (body = upsert body) → 201 `{ ok:true, index }`
  - `PUT /accounts/:index` → 200 `{ ok:true, index }`
  - `DELETE /accounts/:index` → 200 `{ ok:true, removed:true }`
  - Writes: 403 `{error, code:'ACCOUNT_WRITE_DISABLED', hint:'Set API_ALLOW_ACCOUNT_WRITE=true'}` when flag off; 409 `{error, code:'NOT_IDLE'}` unless `pm.getStatus().state === 'idle'`; 400/404 from `AccountEditorError.status`.
  - After every successful write the server calls `refreshProcessEnv(ENV_FILE)` so `/accounts` and the next `/start` see the new data.

- [ ] **Step 1: Wire imports, flag and env-file path**

In `scripts/api/server.js`:

1. Add import after the `sessionStore.js` import:

```js
import { AccountEditorError, accountDetail, upsertAccount, deleteAccount, refreshProcessEnv } from './accountEditor.js'
```

2. Change the bare `loadEnvFile(projectRoot)` call (line ~28) to capture the path with a fallback for a not-yet-existing file:

```js
const ENV_FILE = loadEnvFile(projectRoot) ?? path.join(projectRoot, '.env')
```

3. Next to the other `API_ALLOW_*` constants add:

```js
const ALLOW_ACCOUNT_WRITE = envBool('API_ALLOW_ACCOUNT_WRITE', false)
```

- [ ] **Step 2: Add the routes**

Locate the existing `GET /accounts` route. Immediately BEFORE it, add (reuse the exact JSON-body helper the `POST /start` route uses — read that route first and match its pattern):

```js
        // account detail (read; non-sensitive fields + has* flags only)
        if (method === 'GET' && /^\/accounts\/\d+$/.test(pathname)) {
            const index = Number(pathname.split('/')[2])
            const detail = accountDetail(ENV_FILE, index)
            if (!detail) return sendJson(res, 404, { error: `Account ${index} not found`, code: 'ACCOUNT_NOT_FOUND' })
            return sendJson(res, 200, detail)
        }

        // account writes (opt-in, idle-only)
        if ((method === 'POST' && pathname === '/accounts') || ((method === 'PUT' || method === 'DELETE') && /^\/accounts\/\d+$/.test(pathname))) {
            if (!ALLOW_ACCOUNT_WRITE) {
                return sendJson(res, 403, {
                    error: 'Account writes are disabled.',
                    code: 'ACCOUNT_WRITE_DISABLED',
                    hint: 'Set API_ALLOW_ACCOUNT_WRITE=true in the API environment.'
                })
            }
            if (pm.getStatus().state !== 'idle') {
                return sendJson(res, 409, { error: 'Cannot edit accounts while a run is active.', code: 'NOT_IDLE' })
            }
            try {
                if (method === 'DELETE') {
                    const index = Number(pathname.split('/')[2])
                    deleteAccount(ENV_FILE, index)
                    refreshProcessEnv(ENV_FILE)
                    return sendJson(res, 200, { ok: true, removed: true })
                }
                const body = await readJsonBody(req) // ← use the server's existing body helper name
                const targetIndex = method === 'PUT' ? Number(pathname.split('/')[2]) : null
                const { index } = upsertAccount(ENV_FILE, targetIndex, body ?? {})
                refreshProcessEnv(ENV_FILE)
                return sendJson(res, method === 'POST' ? 201 : 200, { ok: true, index })
            } catch (error) {
                if (error instanceof AccountEditorError) {
                    return sendJson(res, error.status, { error: error.message, code: 'ACCOUNT_EDIT_FAILED' })
                }
                throw error
            }
        }
```

Adjust `readJsonBody` to whatever the file's real helper is called; if body parsing happens inline in `POST /start`, extract nothing — just replicate that inline pattern here.

3. Add to the `GET /` endpoints array (after `'GET /accounts'`): `'GET /accounts/:index'`, `'POST /accounts'`, `'PUT /accounts/:index'`, `'DELETE /accounts/:index'`.

- [ ] **Step 3: Verify against a scratch server (never the real .env)**

```powershell
$tmp = Join-Path $env:TEMP ("rc-smoke-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory $tmp | Out-Null
@'
ACCOUNT_1_EMAIL=a@example.com
ACCOUNT_1_PASSWORD=secret-a
API_ALLOW_ACCOUNT_WRITE=true
'@ | Out-File -Encoding ascii (Join-Path $tmp '.env')
$p = Start-Process node -ArgumentList "$PWD\scripts\api\server.js",'-port','3997' -WorkingDirectory $tmp -PassThru -NoNewWindow
Start-Sleep 2
curl.exe -s http://127.0.0.1:3997/accounts/1
curl.exe -s -X POST http://127.0.0.1:3997/accounts -H "Content-Type: application/json" -d '{"email":"b@example.com","password":"pw"}'
curl.exe -s http://127.0.0.1:3997/accounts
curl.exe -s -X DELETE http://127.0.0.1:3997/accounts/1
curl.exe -s http://127.0.0.1:3997/accounts
Stop-Process -Id $p.Id -Force
Get-Content (Join-Path $tmp '.env')
Remove-Item -Recurse -Force $tmp
```

Expected: detail without secrets; POST → `{"ok":true,"index":2}`; `/accounts` lists 2; DELETE → ok; `/accounts` lists 1 (b@example.com renumbered to slot 1); final `.env` content shows the renumbered block and `API_ALLOW_ACCOUNT_WRITE=true` preserved; a `.env.bak` exists in the temp dir. Also verify 403: rerun without the flag line and expect `ACCOUNT_WRITE_DISABLED` (or skip if time-boxed — note it).

- [ ] **Step 4: Run module tests, lint, commit**

```bash
node --test scripts/api/accountEditor.test.js scripts/api/staticServer.test.js
npm run lint
git add scripts/api/server.js
git commit -m "feat(api): account crud routes behind API_ALLOW_ACCOUNT_WRITE"
```

---

### Task 3: Cuentas view — create/edit/delete modal

**Files:**
- Modify: `scripts/api/ui/views/cuentas.js`

**Interfaces:**
- Consumes: Task 2 HTTP contract; `api`/`ApiError`, `toast`; existing view structure.
- Produces: UI actions — "+ Añadir cuenta" button opens the modal empty; per-row ✎ opens it pre-filled from `GET /accounts/:index`; per-row ✕ deletes with `confirm()`. 403 → toast naming `API_ALLOW_ACCOUNT_WRITE`; 409 → toast "bot en ejecución".

- [ ] **Step 1: Add the modal component and actions**

In `scripts/api/ui/views/cuentas.js`, add `useRef` import if needed (vendor exports it) and insert this component above `Cuentas` (uses only existing CSS classes: `overlay`, `modal`, `savebar`, `btn`, plus inline styles):

```js
function AccountModal({ initial, onClose, onSaved }) {
    // initial: null for create, or the GET /accounts/:index detail for edit
    const isEdit = Boolean(initial)
    const [form, setForm] = useState({
        email: initial?.email ?? '',
        password: '',
        totpSecret: '',
        recoveryEmail: initial?.recoveryEmail ?? '',
        geoLocale: initial?.geoLocale ?? '',
        langCode: initial?.langCode ?? '',
        proxyUrl: initial?.proxy?.url ?? '',
        proxyPort: initial?.proxy?.port ?? '',
        proxyUsername: initial?.proxy?.username ?? '',
        proxyPassword: '',
        proxyHttp: initial?.proxy?.http ?? false
    })
    const [saving, setSaving] = useState(false)
    const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }))

    const save = async () => {
        setSaving(true)
        const body = {
            email: form.email,
            password: form.password,
            totpSecret: form.totpSecret,
            recoveryEmail: form.recoveryEmail,
            geoLocale: form.geoLocale,
            langCode: form.langCode,
            proxy: {
                http: form.proxyHttp,
                url: form.proxyUrl,
                port: form.proxyPort,
                username: form.proxyUsername,
                password: form.proxyPassword
            }
        }
        try {
            if (isEdit) await api(`/accounts/${initial.index}`, { method: 'PUT', body })
            else await api('/accounts', { method: 'POST', body })
            toast(isEdit ? 'Cuenta actualizada' : 'Cuenta añadida')
            onSaved()
            onClose()
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) toast('Escritura desactivada: pon API_ALLOW_ACCOUNT_WRITE=true en .env y reinicia la API', 'err')
            else if (err instanceof ApiError && err.status === 409) toast('No se puede editar con el bot en ejecución', 'err')
            else toast(err instanceof ApiError ? err.message : 'Sin conexión con la API', 'err')
        } finally {
            setSaving(false)
        }
    }

    const secretPlaceholder = has => (isEdit && has ? '•••••• (sin cambios)' : '')

    return html`<div class="overlay" onClick=${e => { if (e.target === e.currentTarget) onClose() }}>
        <div class="modal" role="dialog" aria-label=${isEdit ? 'Editar cuenta' : 'Añadir cuenta'} style="width:min(520px,92vw)">
            <h2>${isEdit ? `Editar cuenta ${initial.index}` : 'Añadir cuenta'}</h2>
            <label for="f-email">Email</label>
            <input id="f-email" value=${form.email} onInput=${set('email')} placeholder="cuenta@outlook.com" />
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div>
                    <label for="f-pass">Contraseña</label>
                    <input id="f-pass" type="password" value=${form.password} onInput=${set('password')}
                        placeholder=${secretPlaceholder(initial?.hasPassword)} />
                </div>
                <div>
                    <label for="f-totp">Secreto TOTP</label>
                    <input id="f-totp" type="password" value=${form.totpSecret} onInput=${set('totpSecret')}
                        placeholder=${secretPlaceholder(initial?.hasTotp)} />
                </div>
            </div>
            <label for="f-rec">Email de recuperación</label>
            <input id="f-rec" value=${form.recoveryEmail} onInput=${set('recoveryEmail')} />
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div><label for="f-geo">Región</label><input id="f-geo" value=${form.geoLocale} onInput=${set('geoLocale')} placeholder="auto" /></div>
                <div><label for="f-lang">Idioma</label><input id="f-lang" value=${form.langCode} onInput=${set('langCode')} placeholder="es" /></div>
            </div>
            <label>Proxy (opcional)</label>
            <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
                <input value=${form.proxyUrl} onInput=${set('proxyUrl')} placeholder="http://proxy.ejemplo.com" aria-label="Proxy URL" />
                <input value=${form.proxyPort} onInput=${set('proxyPort')} placeholder="8080" aria-label="Proxy puerto" />
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px">
                <input value=${form.proxyUsername} onInput=${set('proxyUsername')} placeholder="usuario" aria-label="Proxy usuario" />
                <input type="password" value=${form.proxyPassword} onInput=${set('proxyPassword')}
                    placeholder=${secretPlaceholder(initial?.proxy?.hasPassword)} aria-label="Proxy contraseña" />
            </div>
            <p style="font-size:11.5px;color:var(--ink-3);margin:14px 0 0;border-top:1px solid var(--border);padding-top:10px">
                Se reescribe .env de forma atómica con copia previa en .env.bak. Los secretos nunca se vuelven a mostrar.
            </p>
            <div class="savebar">
                <button class="btn" onClick=${onClose}>Cancelar</button>
                <button class="btn primary" disabled=${saving} onClick=${save}>${isEdit ? 'Guardar cambios' : 'Guardar cuenta'}</button>
            </div>
        </div>
    </div>`
}
```

- [ ] **Step 2: Wire it into `Cuentas`**

Inside `Cuentas`:

1. Add state: `const [modal, setModal] = useState(null)` — `null` closed, `'new'` create, or a detail object for edit.
2. Add handlers:

```js
    const openNew = () => setModal('new')

    const openEdit = async a => {
        try {
            setModal(await api(`/accounts/${a.index}`))
        } catch {
            toast('No se pudo cargar el detalle de la cuenta', 'err')
        }
    }

    const removeAccount = async a => {
        if (!confirm(`¿Eliminar la cuenta ${a.email} de .env? Esta acción reescribe el fichero (copia previa en .env.bak).`)) return
        try {
            await api(`/accounts/${a.index}`, { method: 'DELETE' })
            toast('Cuenta eliminada')
            load()
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) toast('Escritura desactivada: pon API_ALLOW_ACCOUNT_WRITE=true en .env y reinicia la API', 'err')
            else if (err instanceof ApiError && err.status === 409) toast('No se puede eliminar con el bot en ejecución', 'err')
            else toast('Error al eliminar la cuenta', 'err')
        }
    }
```

3. In the toolbar, replace the lone `↻ Recargar` button area so it also offers creating:

```js
                <button class="btn sm" onClick=${load}>↻ Recargar</button>
                <button class="btn primary" onClick=${openNew}>+ Añadir cuenta</button>
```

4. In each row's `.acts` cell add, between ▶ and 🗑 (sessions), the edit and delete buttons:

```js
                            <button class="icon-btn" title="Editar cuenta" disabled=${busy} onClick=${() => openEdit(a)}>✎</button>
                            <button class="icon-btn danger" title="Eliminar cuenta de .env" disabled=${busy} onClick=${() => removeAccount(a)}>✕</button>
```

5. Render the modal at the end of the section, before `</section>`:

```js
        ${modal && html`<${AccountModal}
            initial=${modal === 'new' ? null : modal}
            onClose=${() => setModal(null)}
            onSaved=${load} />`}
```

6. Update the `.sub` line: replace `edición disponible en la Fase 2.` with `los secretos nunca se muestran.`

- [ ] **Step 3: Verify**

`node --check scripts/api/ui/views/cuentas.js` → exit 0. Scratch-server check (same temp-cwd pattern as Task 2 Step 3, with the flag on): load `/ui`, confirm modal opens, create → row appears, edit prefilled without secrets, delete renumbers. If no browser: curl the endpoints and review JSX against the Task 2 contract.

- [ ] **Step 4: Lint and commit**

```bash
npm run lint
git add scripts/api/ui/views/cuentas.js
git commit -m "feat(ui): account create/edit/delete modal"
```

---

### Task 4: `ui/cron.js` — pure cron parser + next-runs (TDD)

**Files:**
- Create: `scripts/api/ui/cron.js`
- Create: `scripts/api/ui/cron.test.js`

**Interfaces (Produces):**
- `parseCron(expr: string) → { minute:Set<number>, hour:Set<number>, dom:Set<number>, month:Set<number>, dow:Set<number> } | null` — numeric five-field cron; supports `*`, values, lists, ranges, steps; `null` on anything invalid (named months/macros are invalid, matching the server's parser).
- `nextRuns(expr: string, from: Date, count = 5) → Date[]` — strictly after `from`, standard dom/dow OR-semantics when both are restricted; empty array if invalid or nothing within 366 days.
- Pure module: no DOM, no imports — testable under node.

- [ ] **Step 1: Write the failing tests**

Create `scripts/api/ui/cron.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCron, nextRuns } from './cron.js'

// Wed 2026-07-15 12:00:00 local time
const FROM = new Date(2026, 6, 15, 12, 0, 0)

test('parseCron accepts numeric fields and rejects junk', () => {
    assert.notEqual(parseCron('0 7 * * *'), null)
    assert.notEqual(parseCron('*/15 2-4 1,15 * 1-5'), null)
    assert.equal(parseCron('@daily'), null)
    assert.equal(parseCron('0 7 * *'), null)
    assert.equal(parseCron('61 7 * * *'), null)
    assert.equal(parseCron('0 7 * * MON'), null)
})

test('daily at 07:00 → next is tomorrow 07:00 when asked after 07:00', () => {
    const runs = nextRuns('0 7 * * *', FROM, 3)
    assert.equal(runs.length, 3)
    assert.deepEqual(
        runs.map(d => [d.getDate(), d.getHours(), d.getMinutes()]),
        [[16, 7, 0], [17, 7, 0], [18, 7, 0]]
    )
})

test('twice daily 07:00/19:00 from noon → 19:00 today first', () => {
    const runs = nextRuns('0 7,19 * * *', FROM, 2)
    assert.deepEqual(runs.map(d => [d.getDate(), d.getHours()]), [[15, 19], [16, 7]])
})

test('weekdays only skips the weekend', () => {
    // FROM is Wednesday; ask for 4 → Thu, Fri, Mon, Tue
    const runs = nextRuns('0 7 * * 1-5', FROM, 4)
    assert.deepEqual(runs.map(d => d.getDay()), [4, 5, 1, 2])
})

test('step minutes */15', () => {
    const runs = nextRuns('*/15 * * * *', FROM, 2)
    assert.deepEqual(runs.map(d => d.getMinutes()), [15, 30])
})

test('dow 7 is treated as Sunday', () => {
    const runs = nextRuns('0 7 * * 7', FROM, 1)
    assert.equal(runs[0].getDay(), 0)
})

test('invalid expression → empty', () => {
    assert.deepEqual(nextRuns('nope', FROM, 5), [])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/api/ui/cron.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `scripts/api/ui/cron.js`:

```js
// Pure numeric five-field cron parsing (mirrors the server-side parser's accepted
// grammar: *, numbers, lists, ranges, steps; no names, no macros).

const BOUNDS = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // day of month
    { min: 1, max: 12 }, // month
    { min: 0, max: 7 }   // day of week (7 == 0 == Sunday)
]

function parseField(field, { min, max }) {
    const out = new Set()
    for (const part of field.split(',')) {
        const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
        if (!m) return null
        const step = m[2] === undefined ? 1 : Number(m[2])
        if (!Number.isInteger(step) || step < 1) return null
        let lo
        let hi
        if (m[1] === '*') {
            lo = min
            hi = max
        } else if (m[1].includes('-')) {
            const [a, b] = m[1].split('-').map(Number)
            lo = a
            hi = b
        } else {
            lo = Number(m[1])
            hi = m[2] === undefined ? lo : max
        }
        if (lo < min || hi > max || lo > hi) return null
        for (let v = lo; v <= hi; v += step) out.add(v)
    }
    return out.size ? out : null
}

export function parseCron(expr) {
    if (typeof expr !== 'string') return null
    const fields = expr.trim().split(/\s+/)
    if (fields.length !== 5) return null
    const parsed = fields.map((field, i) => parseField(field, BOUNDS[i]))
    if (parsed.some(set => set === null)) return null
    const [minute, hour, dom, month, dow] = parsed
    if (dow.has(7)) dow.add(0)
    return { minute, hour, dom, month, dow }
}

export function nextRuns(expr, from, count = 5) {
    const cron = parseCron(expr)
    if (!cron) return []
    const dowIsAll = [0, 1, 2, 3, 4, 5, 6].every(d => cron.dow.has(d))
    const domIsAll = cron.dom.size === 31

    const runs = []
    const cursor = new Date(from.getTime())
    cursor.setSeconds(0, 0)
    cursor.setMinutes(cursor.getMinutes() + 1)
    const limit = new Date(from.getTime() + 366 * 24 * 3600 * 1000)

    while (runs.length < count && cursor <= limit) {
        const monthOk = cron.month.has(cursor.getMonth() + 1)
        const domOk = cron.dom.has(cursor.getDate())
        const dowOk = cron.dow.has(cursor.getDay())
        // standard cron: when both dom and dow are restricted, either may match
        const dayOk = !domIsAll && !dowIsAll ? domOk || dowOk : domOk && dowOk
        if (monthOk && dayOk && cron.hour.has(cursor.getHours()) && cron.minute.has(cursor.getMinutes())) {
            runs.push(new Date(cursor.getTime()))
        }
        cursor.setMinutes(cursor.getMinutes() + 1)
    }
    return runs
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/api/ui/cron.test.js`
Expected: all 7 PASS.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add scripts/api/ui/cron.js scripts/api/ui/cron.test.js
git commit -m "feat(ui): pure cron parser with next-run computation"
```

---

### Task 5: Programación view

**Files:**
- Create: `scripts/api/ui/views/programacion.js`
- Modify: `scripts/api/ui/app.js` (register: replace the `schedule` VIEWS entry)

**Interfaces:**
- Consumes: `GET /schedule` → `{ enabled, cron, skipIfRunning, excludedAccountIndexes, timezone, source, writable }`; `PATCH /schedule` (only changed fields); `GET /accounts` for exclusion chips; `nextRuns` from `../cron.js`; `api`/`ApiError`/`toast`.
- Produces: `export function Programacion({ state })`; registered as `{ id: 'schedule', label: 'Programación', component: Programacion }`.

- [ ] **Step 1: Write `views/programacion.js`**

```js
import { html, useEffect, useState } from '../vendor/htm-preact-standalone.module.js'
import { api, ApiError } from '../api.js'
import { toast } from '../toast.js'
import { nextRuns, parseCron } from '../cron.js'

const PRESETS = [
    { label: 'Diario 07:00', cron: '0 7 * * *' },
    { label: 'Dos veces al día', cron: '0 7,19 * * *' },
    { label: 'Solo laborables', cron: '0 7 * * 1-5' }
]

const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

function fmtRun(d) {
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} · ${hh}:${mm}`
}

export function Programacion() {
    const [schedule, setSchedule] = useState(null)
    const [accounts, setAccounts] = useState([])
    const [draft, setDraft] = useState(null)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        api('/schedule').then(s => {
            setSchedule(s)
            setDraft({
                enabled: Boolean(s.enabled),
                cron: s.cron ?? '',
                skipIfRunning: s.skipIfRunning !== false,
                excludedAccountIndexes: s.excludedAccountIndexes ?? []
            })
        }).catch(() => toast('No se pudo cargar la programación', 'err'))
        api('/accounts').then(d => setAccounts(d.accounts ?? [])).catch(() => {})
    }, [])

    if (!schedule || !draft) {
        return html`<section class="view"><h1>Programación</h1>
            <p class="sub">Cargando…</p></section>`
    }

    const writable = Boolean(schedule.writable)
    const cronValid = draft.cron !== '' && parseCron(draft.cron) !== null
    const upcoming = cronValid && draft.enabled ? nextRuns(draft.cron, new Date(), 5) : []
    const setField = patch => setDraft(d => ({ ...d, ...patch }))

    const toggleExcluded = index => setDraft(d => ({
        ...d,
        excludedAccountIndexes: d.excludedAccountIndexes.includes(index)
            ? d.excludedAccountIndexes.filter(i => i !== index)
            : [...d.excludedAccountIndexes, index].sort((a, b) => a - b)
    }))

    const save = async () => {
        if (draft.enabled && !cronValid) {
            toast('La expresión cron no es válida', 'err')
            return
        }
        setSaving(true)
        try {
            // The server rejects an empty cron string even when disabling —
            // omit the field entirely when the input is blank.
            const body = { ...draft }
            if (body.cron === '') delete body.cron
            const updated = await api('/schedule', { method: 'PATCH', body })
            setSchedule(updated)
            toast('Programación aplicada')
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) toast('Escritura desactivada: pon API_ALLOW_SCHEDULE_WRITE=true y reinicia la API', 'err')
            else toast(err instanceof ApiError ? err.message : 'Sin conexión con la API', 'err')
        } finally {
            setSaving(false)
        }
    }

    return html`<section class="view">
        <h1>Programación</h1>
        <p class="sub">Cron efectivo (${schedule.source === 'override' ? 'guardado desde la API' : 'variable CRON_SCHEDULE'}) · zona horaria ${schedule.timezone ?? 'UTC'}.</p>
        ${!writable && html`<div class="card" style="margin-bottom:12px;color:var(--ink-2)">
            Solo lectura: la escritura del cron requiere <span class="em">API_ALLOW_SCHEDULE_WRITE=true</span>
            (disponible en el modo Docker de la API).</div>`}
        <div class="cols">
            <div class="card">
                <div class="row" style="justify-content:space-between">
                    <b style="font-size:13.5px">Horario</b>
                    <label class="row" style="gap:6px;font-size:12.5px;color:var(--ink-2)">
                        <input type="checkbox" checked=${draft.enabled} disabled=${!writable}
                            onInput=${e => setField({ enabled: e.target.checked })} /> activado
                    </label>
                </div>
                <div class="chips mt">
                    ${PRESETS.map(p => html`<button key=${p.cron}
                        class=${'fchip' + (draft.cron === p.cron ? ' on' : '')} disabled=${!writable}
                        onClick=${() => setField({ cron: p.cron, enabled: true })}>${p.label}</button>`)}
                </div>
                <div class="row mt">
                    <input class="em" style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;color:var(--ink);padding:8px 12px;letter-spacing:.1em;min-width:160px"
                        value=${draft.cron} disabled=${!writable} aria-label="Expresión cron"
                        onInput=${e => setField({ cron: e.target.value.trim() })} placeholder="0 7 * * *" />
                    ${draft.cron !== '' && html`<span style=${`font-size:12px;color:${cronValid ? 'var(--good)' : 'var(--crit)'}`}>
                        ${cronValid ? 'expresión válida' : 'expresión no válida'}</span>`}
                </div>
                <div class="row mt" style="justify-content:space-between">
                    <label class="row" style="gap:6px;font-size:12.5px;color:var(--ink-2)">
                        <input type="checkbox" checked=${draft.skipIfRunning} disabled=${!writable}
                            onInput=${e => setField({ skipIfRunning: e.target.checked })} /> omitir si ya hay un run activo
                    </label>
                </div>
                <div class="mt">
                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3);margin-bottom:6px">
                        Excluir cuentas del run programado</div>
                    <div class="chips">
                        ${accounts.length === 0 ? html`<span style="font-size:12.5px;color:var(--ink-3)">sin cuentas</span>` : ''}
                        ${accounts.map(a => html`<button key=${a.index} disabled=${!writable}
                            class=${'fchip' + (draft.excludedAccountIndexes.includes(a.index) ? ' on' : '')}
                            onClick=${() => toggleExcluded(a.index)}>${a.email}</button>`)}
                    </div>
                </div>
                <div class="savebar">
                    <button class="btn primary" disabled=${!writable || saving} onClick=${save}>Aplicar horario</button>
                </div>
            </div>
            <div class="card">
                <b style="font-size:13.5px">Próximas 5 ejecuciones</b>
                ${upcoming.length === 0
                    ? html`<p style="color:var(--ink-3);font-size:13px">
                        ${draft.enabled ? 'Introduce una expresión cron válida.' : 'La programación está desactivada.'}</p>`
                    : html`<ul class="next">${upcoming.map(d => html`<li key=${d.getTime()}>
                        <span></span><b>${fmtRun(d)}</b></li>`)}</ul>`}
                <p style="font-size:11.5px;color:var(--ink-3);margin-top:10px">
                    Calculadas en tu zona horaria local; el contenedor usa ${schedule.timezone ?? 'UTC'}.</p>
            </div>
        </div>
    </section>`
}
```

- [ ] **Step 2: Register in `app.js`**

```js
import { Programacion } from './views/programacion.js'
```

`VIEWS` entry: `{ id: 'schedule', label: 'Programación', component: Programacion },`

- [ ] **Step 3: Verify**

`node --check scripts/api/ui/views/programacion.js scripts/api/ui/app.js` → exit 0. With the API running: view shows the current schedule read-only (local API has `writable:false`), presets disabled, next-5 renders when a cron exists. Headless fallback: `node --check` + field-shape check against `GET /schedule` in the README.

- [ ] **Step 4: Lint and commit**

```bash
npm run lint
git add scripts/api/ui/views/programacion.js scripts/api/ui/app.js
git commit -m "feat(ui): schedule view with presets and next-run preview"
```

---

### Task 6: Configuración view — grouped form, diff, JSON tab

**Files:**
- Create: `scripts/api/ui/views/configuracion.js`
- Modify: `scripts/api/ui/app.js` (register: replace the `config` VIEWS entry)

**Interfaces:**
- Consumes: `GET /config` → `{ path, redacted, config }`; `PATCH /config` (deep-merge; arrays replace whole; `422` → `{ error, errors: string[] }`; `403` when `API_ALLOW_CONFIG_WRITE` is off); `api`/`ApiError`/`toast`.
- Produces: `export function Configuracion()`; registered as `{ id: 'config', label: 'Configuración', component: Configuracion }`.
- **Correctness rule (redaction):** the fetched config replaces secrets with the literal `***REDACTED***`. The view must (a) render those fields read-only, (b) NEVER include a `***REDACTED***` value in the outgoing patch, and (c) always save via PATCH built from a baseline-vs-draft diff — never PUT — so redacted secrets on disk are preserved.

- [ ] **Step 1: Write `views/configuracion.js`**

```js
import { html, useEffect, useMemo, useState } from '../vendor/htm-preact-standalone.module.js'
import { api, ApiError } from '../api.js'
import { toast } from '../toast.js'

const REDACTED = '***REDACTED***'

function clone(value) {
    return JSON.parse(JSON.stringify(value))
}

function getAt(obj, pathArr) {
    return pathArr.reduce((acc, key) => (acc == null ? undefined : acc[key]), obj)
}

function setAt(obj, pathArr, value) {
    let node = obj
    for (const key of pathArr.slice(0, -1)) node = node[key]
    node[pathArr[pathArr.length - 1]] = value
}

// List of {path: string[], from, to} for primitives/arrays that differ.
function diffConfig(base, draft, prefix = []) {
    const out = []
    const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(draft ?? {})])
    for (const key of keys) {
        const a = base?.[key]
        const b = draft?.[key]
        const p = [...prefix, key]
        const bothObjects = a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)
        if (bothObjects) {
            out.push(...diffConfig(a, b, p))
        } else if (JSON.stringify(a) !== JSON.stringify(b)) {
            out.push({ path: p, from: a, to: b })
        }
    }
    return out
}

// Nested object containing only the changed paths (skipping redacted values).
function buildPatch(diffs) {
    const patch = {}
    for (const d of diffs) {
        if (d.to === REDACTED) continue
        let node = patch
        for (const key of d.path.slice(0, -1)) {
            node[key] = node[key] ?? {}
            node = node[key]
        }
        node[d.path[d.path.length - 1]] = d.to
    }
    return patch
}

function Field({ path, value, onChange }) {
    const name = path[path.length - 1]
    const id = `cfg-${path.join('-')}`
    if (typeof value === 'boolean') {
        return html`<div class="frow2">
            <label for=${id}>${name}</label>
            <input id=${id} type="checkbox" checked=${value} onInput=${e => onChange(path, e.target.checked)} />
        </div>`
    }
    if (typeof value === 'number') {
        return html`<div class="frow2">
            <label for=${id}>${name}</label>
            <input id=${id} type="number" value=${value} style="width:110px"
                onInput=${e => onChange(path, e.target.value === '' ? 0 : Number(e.target.value))} />
        </div>`
    }
    if (typeof value === 'string') {
        if (value === REDACTED) {
            return html`<div class="frow2"><label>${name}</label>
                <span style="font:12px var(--mono);color:var(--ink-3)">oculto · edítalo en config.json</span></div>`
        }
        return html`<div class="frow2">
            <label for=${id}>${name}</label>
            <input id=${id} value=${value} onInput=${e => onChange(path, e.target.value)} />
        </div>`
    }
    if (Array.isArray(value)) {
        return html`<div class="frow2"><label>${name}</label>
            <span style="font-size:12px;color:var(--ink-3)">lista · editar en la pestaña JSON</span></div>`
    }
    return null
}

function Section({ path, value, onChange, depth = 0 }) {
    const entries = Object.entries(value ?? {})
    const primitives = entries.filter(([, v]) => typeof v !== 'object' || v === null || Array.isArray(v))
    const objects = entries.filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
    return html`<div>
        ${primitives.map(([k, v]) => html`<${Field} key=${k} path=${[...path, k]} value=${v} onChange=${onChange} />`)}
        ${objects.map(([k, v]) => html`<div key=${k} style=${`margin:${depth ? 8 : 14}px 0 0 ${depth * 14}px`}>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3);margin:10px 0 4px">${k}</div>
            <${Section} path=${[...path, k]} value=${v} onChange=${onChange} depth=${depth + 1} />
        </div>`)}
    </div>`
}

export function Configuracion() {
    const [baseline, setBaseline] = useState(null)
    const [draft, setDraft] = useState(null)
    const [group, setGroup] = useState(null)
    const [tab, setTab] = useState('form')
    const [jsonText, setJsonText] = useState('')
    const [showDiff, setShowDiff] = useState(false)
    const [saveErrors, setSaveErrors] = useState([])
    const [saving, setSaving] = useState(false)

    const load = () => {
        api('/config').then(d => {
            setBaseline(d.config)
            setDraft(clone(d.config))
            setJsonText(JSON.stringify(d.config, null, 2))
        }).catch(() => toast('No se pudo cargar config.json', 'err'))
    }
    useEffect(load, [])

    const groups = useMemo(() => {
        if (!draft) return []
        const objectKeys = Object.keys(draft).filter(k => draft[k] && typeof draft[k] === 'object' && !Array.isArray(draft[k]))
        return ['general', ...objectKeys]
    }, [draft])
    const activeGroup = group ?? groups[0]

    if (!baseline || !draft) {
        return html`<section class="view"><h1>Configuración</h1><p class="sub">Cargando…</p></section>`
    }

    const diffs = diffConfig(baseline, draft)
    const onChange = (path, value) => setDraft(d => {
        const next = clone(d)
        setAt(next, path, value)
        return next
    })

    const applyJson = () => {
        try {
            const parsed = JSON.parse(jsonText)
            setDraft(parsed)
            setTab('form')
            toast('JSON aplicado al borrador (sin guardar todavía)')
        } catch (err) {
            toast(`JSON no válido: ${err.message}`, 'err')
        }
    }

    const save = async () => {
        const patch = buildPatch(diffs)
        if (Object.keys(patch).length === 0) {
            toast('No hay cambios que guardar')
            return
        }
        setSaving(true)
        setSaveErrors([])
        try {
            await api('/config', { method: 'PATCH', body: patch })
            toast('Configuración guardada · se aplica en el próximo run')
            load()
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) toast('Escritura desactivada: pon API_ALLOW_CONFIG_WRITE=true y reinicia la API', 'err')
            else if (err instanceof ApiError && err.status === 422) {
                setSaveErrors(err.body?.errors ?? [err.message])
                toast('La validación rechazó los cambios', 'err')
            } else toast(err instanceof ApiError ? err.message : 'Sin conexión con la API', 'err')
        } finally {
            setSaving(false)
        }
    }

    const generalValue = Object.fromEntries(Object.entries(draft).filter(([, v]) => typeof v !== 'object' || v === null || Array.isArray(v)))

    return html`<section class="view">
        <h1>Configuración</h1>
        <p class="sub">Edición validada de config.json · los cambios se aplican en el próximo run.</p>
        <div class="toolbar">
            <button class=${'fchip' + (tab === 'form' ? ' on' : '')} onClick=${() => setTab('form')}>Formulario</button>
            <button class=${'fchip' + (tab === 'json' ? ' on' : '')} onClick=${() => {
                setJsonText(JSON.stringify(draft, null, 2))
                setTab('json')
            }}>JSON avanzado</button>
            <span style="flex:1"></span>
            <span style="font-size:12px;color:var(--ink-3)">${diffs.length ? `${diffs.length} cambio(s) sin guardar` : 'sin cambios'}</span>
        </div>
        ${tab === 'form' ? html`
            <div class="cfg2">
                <div class="cfg-nav2">
                    ${groups.map(g => html`<button key=${g} class=${activeGroup === g ? 'on' : ''}
                        onClick=${() => setGroup(g)}>${g}</button>`)}
                </div>
                <div class="card">
                    ${activeGroup === 'general'
                        ? html`<${Section} path=${[]} value=${generalValue} onChange=${onChange} />`
                        : html`<${Section} path=${[activeGroup]} value=${draft[activeGroup]} onChange=${onChange} />`}
                </div>
            </div>`
        : html`
            <div class="card">
                <textarea style="width:100%;box-sizing:border-box;min-height:50vh;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;color:var(--ink);padding:12px;font:12.5px var(--mono)"
                    value=${jsonText} onInput=${e => setJsonText(e.target.value)} aria-label="config.json"></textarea>
                <div class="savebar"><button class="btn" onClick=${applyJson}>Aplicar JSON al borrador</button></div>
            </div>`}
        ${saveErrors.length > 0 && html`<div class="card" style="margin-top:12px;border-color:rgba(239,68,68,.4)">
            <b style="font-size:13px;color:#ff8b8b">Errores de validación</b>
            <ul class="next">${saveErrors.map((e, i) => html`<li key=${i}><span style="color:#ff8b8b">${e}</span></li>`)}</ul>
        </div>`}
        <div class="savebar">
            <button class="btn" disabled=${diffs.length === 0} onClick=${() => setShowDiff(true)}>Ver diff</button>
            <button class="btn" disabled=${diffs.length === 0} onClick=${() => { setDraft(clone(baseline)); setSaveErrors([]) }}>Descartar</button>
            <button class="btn primary" disabled=${diffs.length === 0 || saving} onClick=${save}>Guardar cambios</button>
        </div>
        ${showDiff && html`<div class="overlay" onClick=${e => { if (e.target === e.currentTarget) setShowDiff(false) }}>
            <div class="modal" role="dialog" aria-label="Cambios pendientes" style="width:min(560px,92vw)">
                <h2>Cambios pendientes</h2>
                <ul class="next">${diffs.map((d, i) => html`<li key=${i}>
                    <span class="em">${d.path.join('.')}</span>
                    <b>${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}</b></li>`)}</ul>
                <div class="savebar"><button class="btn" onClick=${() => setShowDiff(false)}>Cerrar</button></div>
            </div>
        </div>`}
    </section>`
}
```

- [ ] **Step 2: Add the two CSS helpers**

Append to `scripts/api/ui/styles.css`:

```css
.cfg2 { display: grid; grid-template-columns: 190px 1fr; gap: 12px }
@media (max-width: 900px) { .cfg2 { grid-template-columns: 1fr } }
.cfg-nav2 { display: flex; flex-direction: column; gap: 2px; align-self: start }
.cfg-nav2 button { all: unset; padding: 8px 12px; border-radius: 8px; color: var(--ink-2); cursor: pointer; font-size: 13px }
.cfg-nav2 button:hover { background: var(--surface-2); color: var(--ink) }
.cfg-nav2 button:focus-visible { outline: 2px solid var(--accent) }
.cfg-nav2 button.on { background: var(--surface); color: var(--ink); border: 1px solid var(--border) }
.frow2 { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 9px 0; border-top: 1px solid var(--border) }
.frow2:first-child { border-top: none }
.frow2 label { font-size: 13px }
.frow2 input[type="text"], .frow2 input:not([type]) { background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px; color: var(--ink); padding: 6px 10px; font: 12.5px var(--mono); min-width: 200px }
.frow2 input[type="number"] { background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px; color: var(--ink); padding: 6px 10px; font: 12.5px var(--mono) }
```

- [ ] **Step 3: Register in `app.js`**

```js
import { Configuracion } from './views/configuracion.js'
```

`VIEWS` entry: `{ id: 'config', label: 'Configuración', component: Configuracion },`

- [ ] **Step 4: Verify**

`node --check scripts/api/ui/views/configuracion.js scripts/api/ui/app.js` → exit 0. With the API running: groups render from the real config.json shape (general, accountStartDelay, workers, activities, searchSettings, experimental, consoleLogFilter, proxy, webhook), redacted webhook fields show "oculto", toggling a boolean shows "1 cambio(s) sin guardar", Ver diff lists the path, Descartar resets. Saving without `API_ALLOW_CONFIG_WRITE` → 403 toast naming the variable (expected on default local config — do NOT enable the flag against the real repo config during verification).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add scripts/api/ui/views/configuracion.js scripts/api/ui/styles.css scripts/api/ui/app.js
git commit -m "feat(ui): config editor with grouped form, diff and json tab"
```

---

### Task 7: Docs + Fase 2 end-to-end verification

**Files:**
- Modify: `scripts/api/README.md` (Dashboard section + endpoint tables + env var table)
- Modify: `env.example` (document `API_ALLOW_ACCOUNT_WRITE`)

**Steps:**

- [ ] **Step 1: Update `scripts/api/README.md`**

1. In the "Dashboard" section, replace the endpoint enumeration sentence with:

```markdown
It uses the documented endpoints only: `/health` for the auth probe, `/events`
for live logs and status snapshots, `/accounts` (including the account CRUD
routes and `DELETE /sessions/:email`), `/schedule`, `/errors`, `/config`, and
the `/start`, `/stop`, `/restart` controls. Editing accounts, config, and the
schedule from the dashboard requires the matching opt-in variables
(`API_ALLOW_ACCOUNT_WRITE`, `API_ALLOW_CONFIG_WRITE`,
`API_ALLOW_SCHEDULE_WRITE`).
```

2. In the "Read endpoints" table add: `| GET | /accounts/:index | Editable non-sensitive fields of one account plus hasPassword/hasTotp flags. |`
3. In the "Control and write endpoints" table add three rows for `POST /accounts`, `PUT /accounts/:index`, `DELETE /accounts/:index` (purpose: create/update/delete an `.env` account slot; writes are atomic with an `.env.bak` backup; requires `API_ALLOW_ACCOUNT_WRITE=true` and an idle bot).
4. In the "Environment variables" table add: `| API_ALLOW_ACCOUNT_WRITE | false | Permit POST/PUT/DELETE /accounts (.env rewrites). |`

- [ ] **Step 2: Update `env.example`**

After the `#API_TOKEN=` line add:

```dotenv
# Allow the dashboard/API to create, edit and delete ACCOUNT_* blocks in this
# file (atomic rewrite with a .env.bak backup). Off by default.
#API_ALLOW_ACCOUNT_WRITE=true
```

- [ ] **Step 3: Full verification pass**

```bash
node --test scripts/api/accountEditor.test.js scripts/api/staticServer.test.js scripts/api/ui/cron.test.js
npm run lint
npm test
```

All pass, lint clean, `src/util` tests unaffected. Then the scratch-server e2e from Task 2 Step 3 once more (temp cwd, flag on): create → edit (secret kept) → delete → renumbered; `GET /config` + `PATCH /config` returns 403 without its flag; `/ui` serves the two new views.

- [ ] **Step 4: Commit**

```bash
git add scripts/api/README.md env.example
git commit -m "docs(api): document account crud, opt-in flags and fase 2 dashboard"
```
