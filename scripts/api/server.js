import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { ProcessManager } from './processManager.js'
import { buildExcludedAccountsEnv, buildSingleAccountEnv, loadAccounts, mergeAccountStats } from './accounts.js'
import { validateConfig, deepMerge, readConfig, writeConfigAtomic } from './configEditor.js'
import { readSchedule, writeSchedule, remapExclusionsAfterDelete } from './scheduleStore.js'
import { appendRun, combineRuns, historyFilePath, readRuns } from './historyStore.js'
import { deleteStoredSessions, listStoredSessions } from './sessionStore.js'
import { AccountEditorError, accountDetail, upsertAccount, deleteAccount, refreshProcessEnv, readEnvAccounts } from './accountEditor.js'
import { createUiHandler } from './staticServer.js'
import { resolveRunCommand } from './runCommand.js'
import { resolveStartSelection } from './startSelection.js'
import { RerunController } from './rerunController.js'
import { log, parseArgs, getProjectRoot, loadEnvFile, loadConfigSafe, redactSecrets, envStr, envBool } from './lib.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = getProjectRoot(__dirname)

const ENV_FILE = loadEnvFile(projectRoot) ?? path.join(projectRoot, '.env')

const cliArgs = parseArgs()

function integerSetting(name, value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (value === undefined) return fallback
    const parsed = Number(value)
    if (typeof value === 'boolean' || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        log('ERROR', `${name} must be an integer between ${min} and ${max}.`)
        process.exit(1)
    }
    return parsed
}

let pkgVersion = '0.0.0'
let pkgName = 'microsoft-rewards-script'
try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    pkgVersion = pkg.version ?? pkgVersion
    pkgName = pkg.name ?? pkgName
} catch {}

const HOST = envStr('API_HOST') ?? (typeof cliArgs.host === 'string' ? cliArgs.host : '127.0.0.1')
const PORT =
    cliArgs.port !== undefined
        ? integerSetting('--port', cliArgs.port, 3010, { max: 65535 })
        : integerSetting('API_PORT', envStr('API_PORT'), 3010, { max: 65535 })
const TOKEN = envStr('API_TOKEN') ?? (typeof cliArgs.token === 'string' ? cliArgs.token : undefined)
const CORS_ORIGIN = envStr('API_CORS_ORIGIN') ?? '*'
const LOG_BUFFER = integerSetting('API_LOG_BUFFER', envStr('API_LOG_BUFFER'), 2000)
const STOP_TIMEOUT_MS = integerSetting('API_STOP_TIMEOUT_MS', envStr('API_STOP_TIMEOUT_MS'), 15000)
const ALLOW_ENV_OVERRIDES = envBool('API_ALLOW_ENV_OVERRIDES', false)
const REVEAL_ENABLED = envBool('API_ALLOW_CONFIG_REVEAL', false)
const ALLOW_CONFIG_WRITE = envBool('API_ALLOW_CONFIG_WRITE', false)
// Writing to the crontab is a meaningfully different trust level than
// starting/stopping a run, so it gets its own opt-in flag rather than
// riding along with API_MODE=true for free.
const ALLOW_SCHEDULE_WRITE = envBool('API_ALLOW_SCHEDULE_WRITE', false)
const ALLOW_ACCOUNT_WRITE = envBool('API_ALLOW_ACCOUNT_WRITE', false)

const RUN_HISTORY = integerSetting('API_RUN_HISTORY', envStr('API_RUN_HISTORY'), 20)
const DIAG_DIR = envStr('API_DIAGNOSTICS_DIR') ?? path.join(projectRoot, 'diagnostics')

const { command, args } = resolveRunCommand({ projectRoot })

const pm = new ProcessManager({
    command,
    args,
    cwd: projectRoot,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    logBufferSize: LOG_BUFFER,
    historySize: RUN_HISTORY,
    name: pkgName,
    version: pkgVersion
})

const serveUi = createUiHandler({ root: path.join(__dirname, 'ui') })

const startedAt = Date.now()

function containsControlCharacters(value) {
    return [...value].some(character => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
    })
}

if (containsControlCharacters(HOST) || containsControlCharacters(CORS_ORIGIN)) {
    log('ERROR', 'API_HOST and API_CORS_ORIGIN must not contain control characters.')
    process.exit(1)
}

// Forward bot stdout/stderr to the API server's own output streams so that
// container logs (docker logs) continue to show the bot's output regardless
// of which mode started the run. Controller messages (run start/stop lifecycle
// events from ProcessManager) are included - they are low-volume and useful.
pm.on('log', entry => {
    const line = (entry.raw ?? entry.message ?? '') + '\n'
    if (entry.source === 'stderr') process.stderr.write(line)
    else process.stdout.write(line)
})

// Persist each completed run to disk so history survives API restarts.
// Best-effort: a write failure here must never crash the server or the run.
pm.on('run-complete', entry => {
    try {
        appendRun(projectRoot, toHistoryRecord(entry))
    } catch (error) {
        log('WARN', `History append failed: ${error.message}`)
    }
})

// Chains extra passes after a run so points that credit late - Bing daily
// offers in particular - get picked up without a manual run.
const rerunController = new RerunController({
    pm,
    projectRoot,
    readSchedule,
    loadAccounts,
    buildExcludedEnv: buildExcludedAccountsEnv
}).attach()

function toHistoryRecord(entry) {
    return {
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        exit: entry.exit,
        version: entry.run?.version ?? null,
        collected: entry.run?.collected ?? 0,
        accounts: (entry.run?.accounts ?? []).map(a => ({
            email: a.email,
            collected: a.collectedPoints ?? a.live?.gained ?? 0,
            balance: a.finalPoints ?? a.live?.balance ?? null,
            success: a.success,
            error: a.error,
            streakProtection: a.streakProtection ?? null
        }))
    }
}

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
    return 500
}

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

function applyCors(res) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key')
    res.setHeader('Access-Control-Max-Age', '86400')
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
}

function tokenFromReq(req, url) {
    const auth = req.headers['authorization']
    if (typeof auth === 'string') {
        const bearer = /^Bearer\s+(.+)$/i.exec(auth)
        if (bearer) return bearer[1].trim()
    }
    const apiKey = req.headers['x-api-key']
    if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim()
    const q = url.searchParams.get('token')
    if (q && url.pathname.replace(/\/+$/, '') === '/events') return q
    return null
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a))
    const bufB = Buffer.from(String(b))
    if (bufA.length !== bufB.length) return false
    return crypto.timingSafeEqual(bufA, bufB)
}

function isAuthorized(req, url) {
    if (!TOKEN) return true
    const provided = tokenFromReq(req, url)
    if (!provided) return false
    return safeEqual(provided, TOKEN)
}

async function readJsonBody(req, limitBytes = 1_000_000) {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', chunk => {
            size += chunk.length
            if (size > limitBytes) {
                reject(Object.assign(new Error('Request body too large.'), { code: 'BODY_TOO_LARGE' }))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim()
            if (!raw) return resolve({})
            try {
                resolve(JSON.parse(raw))
            } catch {
                reject(Object.assign(new Error('Invalid JSON body.'), { code: 'BAD_JSON' }))
            }
        })
        req.on('error', reject)
    })
}

async function readJsonObject(req) {
    const body = await readJsonBody(req)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw Object.assign(new Error('Body must be a JSON object.'), { code: 'BAD_REQUEST' })
    }
    return body
}

function readForce(body) {
    if ('force' in body && typeof body.force !== 'boolean') {
        throw Object.assign(new Error('`force` must be a boolean.'), { code: 'BAD_REQUEST' })
    }
    return body.force ?? false
}

function handleEventStream(req, res, url) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    const write = frame => {
        if (!res.writableEnded) res.write(frame)
    }
    const sendEvent = (event, data, id) => {
        let frame = ''
        if (id != null) frame += `id: ${id}\n`
        frame += `event: ${event}\n`
        frame += `data: ${JSON.stringify(data)}\n\n`
        write(frame)
    }

    sendEvent('hello', composeStatus())

    const lastEventId = Number(req.headers['last-event-id'])
    if (Number.isFinite(lastEventId) && lastEventId > 0) {
        for (const entry of pm.getLogs({ afterId: lastEventId }).logs) {
            sendEvent('log', entry, entry.id)
        }
    } else {
        const replay = Math.max(0, Math.min(Number(url.searchParams.get('replay') ?? 100) || 0, LOG_BUFFER))
        if (replay > 0) {
            for (const entry of pm.getLogs({ limit: replay }).logs) {
                sendEvent('log', entry, entry.id)
            }
        }
    }

    const onLog = entry => sendEvent('log', entry, entry.id)
    // Both listeners publish the composed status: a rerun `change` is the only
    // thing that moves the state in or out of `cooldown`, and the process
    // manager knows nothing about it.
    const onStatus = () => sendEvent('status', composeStatus())
    const onRerunChange = () => sendEvent('status', composeStatus())
    pm.on('log', onLog)
    pm.on('status', onStatus)
    rerunController.on('change', onRerunChange)

    const keepAlive = setInterval(() => write(': ping\n\n'), 15000)
    if (typeof keepAlive.unref === 'function') keepAlive.unref()

    const cleanup = () => {
        clearInterval(keepAlive)
        pm.off('log', onLog)
        pm.off('status', onStatus)
        rerunController.off('change', onRerunChange)
        if (!res.writableEnded) res.end()
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
}

const requestHandler = async (req, res) => {
    let url
    try {
        url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    } catch {
        applyCors(res)
        return sendJson(res, 400, { error: 'Invalid request URL.', code: 'BAD_REQUEST' })
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'

    applyCors(res)

    if (method === 'OPTIONS') {
        res.writeHead(204)
        return res.end()
    }

    // Dashboard SPA: static assets are served without a token. Every data
    // endpoint the SPA calls still goes through the auth gate below.
    if (serveUi(req, res, pathname)) return

    if (TOKEN && !isAuthorized(req, url)) {
        return sendJson(res, 401, {
            error: 'Unauthorized',
            hint: 'Provide the API token via Authorization: Bearer or X-API-Key. Browser EventSource may use ?token= only on /events. All endpoints require authentication while API_TOKEN is set.'
        })
    }

    try {
        // index
        if (method === 'GET' && pathname === '/') {
            return sendJson(res, 200, {
                name: pkgName,
                version: pkgVersion,
                message: 'Control API',
                authRequired: Boolean(TOKEN),
                persistence: { history: true },
                endpoints: [
                    'GET /ui (dashboard)',
                    'GET /health',
                    'GET /status',
                    'GET /points',
                    'GET /logs',
                    'GET /errors',
                    'GET /history',
                    'GET /history?persisted=1',
                    'GET /accounts',
                    'GET /accounts/:index',
                    'POST /accounts',
                    'PUT /accounts/:index',
                    'DELETE /accounts/:index',
                    'GET /sessions',
                    'GET /diagnostics',
                    'GET /events',
                    'GET /config',
                    'GET /schedule',
                    'POST /start',
                    'POST /stop',
                    'POST /restart',
                    'POST /rerun/cancel',
                    'POST /shutdown',
                    'DELETE /sessions/:email',
                    'PUT|PATCH /config',
                    'PUT|PATCH /schedule'
                ]
            })
        }

        // health
        if (method === 'GET' && pathname === '/health') {
            return sendJson(res, 200, {
                ok: true,
                name: pkgName,
                version: pkgVersion,
                state: pm.getStatus().state,
                uptimeSec: Math.round((Date.now() - startedAt) / 1000),
                authRequired: Boolean(TOKEN)
            })
        }

        // status
        if (method === 'GET' && pathname === '/status') {
            return sendJson(res, 200, composeStatus())
        }

        // point read live
        if (method === 'GET' && pathname === '/points') {
            return sendJson(res, 200, pm.getPoints())
        }

        // log read
        if (method === 'GET' && pathname === '/logs') {
            const limit = clampInt(url.searchParams.get('limit'), 1, LOG_BUFFER, 200)
            const afterId = url.searchParams.has('afterId') ? Number(url.searchParams.get('afterId')) : null
            const minLevel = url.searchParams.get('level') || null
            if (minLevel && !['debug', 'info', 'warn', 'error'].includes(minLevel)) {
                return sendJson(res, 400, {
                    error: '`level` must be one of: debug, info, warn, error.',
                    code: 'BAD_REQUEST'
                })
            }
            return sendJson(
                res,
                200,
                pm.getLogs({ limit, afterId: Number.isFinite(afterId) ? afterId : null, minLevel })
            )
        }

        // error read
        if (method === 'GET' && pathname === '/errors') {
            const limit = clampInt(url.searchParams.get('limit'), 1, LOG_BUFFER, 100)
            const includeWarnings = url.searchParams.get('warnings') !== 'false'
            return sendJson(res, 200, pm.getErrors({ limit, includeWarnings }))
        }

        // history
        if (method === 'GET' && pathname === '/history') {
            if (url.searchParams.get('persisted') === '1') {
                const limit = clampInt(url.searchParams.get('limit'), 1, 500, 100)
                const offset = clampInt(url.searchParams.get('offset'), 0, 1000000, 0)
                const { runs, total } = readRuns(projectRoot, { limit, offset })
                return sendJson(res, 200, { runs, total, count: runs.length, inMemoryOnly: false, file: historyFilePath(projectRoot) })
            }
            const limit = clampInt(url.searchParams.get('limit'), 1, RUN_HISTORY, RUN_HISTORY)
            const runs = pm.getHistory().slice(0, limit).map(toHistoryRecord)
            return sendJson(res, 200, { runs, count: runs.length, inMemoryOnly: true })
        }

        // account overview (memory + persisted history, so stats survive restarts)
        if (method === 'GET' && pathname === '/accounts') {
            const runs = combineRuns(pm.getHistory().map(toHistoryRecord), readRuns(projectRoot, { limit: 100 }).runs)
            const accounts = mergeAccountStats(loadAccounts(), runs)
            return sendJson(res, 200, { accounts, count: accounts.length })
        }

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
            // In Docker, accounts commonly arrive via compose `env_file:` as
            // container environment variables with no real .env on disk.
            // Writing through the editor there is destructive: refreshProcessEnv
            // deletes the compose-provided ACCOUNT_* vars, and anything created
            // only lives in this process's memory until the container restarts.
            // Detect that mismatch by comparing which ACCOUNT_<n>_EMAIL slots
            // exist in process.env versus what the file itself contains.
            {
                const fileSlots = new Set(readEnvAccounts(ENV_FILE).accounts.map(a => a.index))
                const envOnlySlots = Object.keys(process.env)
                    .map(key => /^ACCOUNT_(\d+)_EMAIL$/.exec(key))
                    .filter(Boolean)
                    .map(m => Number(m[1]))
                    .filter(index => !fileSlots.has(index))
                if (envOnlySlots.length > 0) {
                    return sendJson(res, 409, {
                        error: 'Accounts are provided by the container environment, not an editable .env file.',
                        code: 'ACCOUNTS_ENV_PROVIDED',
                        hint: 'Mount a real .env file to edit accounts from the dashboard.'
                    })
                }
            }
            try {
                if (method === 'DELETE') {
                    const index = Number(pathname.split('/')[2])
                    // Optional confirmation guard: the dashboard's account list
                    // can go stale after any renumbering delete, so a client
                    // may pass the email it displayed for this index. If it no
                    // longer matches, the index almost certainly points at a
                    // different account now - refuse rather than delete blind.
                    const emailParam = url.searchParams.get('email')
                    if (emailParam) {
                        const detail = accountDetail(ENV_FILE, index)
                        if (!detail || detail.email.toLowerCase() !== emailParam.toLowerCase()) {
                            return sendJson(res, 409, {
                                error: 'Account index/email mismatch — the account list may be stale. Reload and retry.',
                                code: 'ACCOUNT_MISMATCH'
                            })
                        }
                    }
                    deleteAccount(ENV_FILE, index)
                    refreshProcessEnv(ENV_FILE)
                    // Best-effort: a persisted schedule.json can still exclude
                    // stale account indexes after the delete renumbers slots.
                    // Never fail the delete itself over this.
                    try {
                        remapExclusionsAfterDelete(projectRoot, index)
                    } catch (remapErr) {
                        log('WARN', `Could not remap schedule exclusions after deleting account ${index}:`, remapErr instanceof Error ? remapErr.message : remapErr)
                    }
                    return sendJson(res, 200, { ok: true, removed: true })
                }
                const body = await readJsonBody(req)
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

        // session list
        if (method === 'GET' && pathname === '/sessions') {
            const loaded = loadConfigSafe(projectRoot)
            if (!loaded) return sendJson(res, 404, { error: 'config.json not found' })
            if (loaded.data == null)
                return sendJson(res, 500, { error: 'config.json is invalid', detail: loaded.error })

            const sessionPath = typeof loaded.data.sessionPath === 'string' ? loaded.data.sessionPath : 'sessions'
            return sendJson(res, 200, listStoredSessions(projectRoot, sessionPath))
        }

        // account-specific session delete; intentionally no delete-all route
        if (method === 'DELETE' && pathname === '/sessions') {
            return sendJson(res, 400, {
                error: 'An account email is required. Use DELETE /sessions/:email.',
                code: 'EMAIL_REQUIRED'
            })
        }

        if (method === 'DELETE' && pathname.startsWith('/sessions/')) {
            if (pm.getStatus().state !== 'idle') {
                return sendJson(res, 409, {
                    error: 'Cannot delete sessions while a bot run is active. Stop the run first.',
                    code: 'RUN_ACTIVE'
                })
            }

            let email
            try {
                email = decodeURIComponent(pathname.slice('/sessions/'.length)).trim()
            } catch {
                return sendJson(res, 400, { error: 'The session email path is not valid URL encoding.' })
            }
            if (!email || email.length > 320 || !email.includes('@') || containsControlCharacters(email)) {
                return sendJson(res, 400, {
                    error: 'A valid account email is required in DELETE /sessions/:email.',
                    code: 'INVALID_EMAIL'
                })
            }

            const loaded = loadConfigSafe(projectRoot)
            if (!loaded) return sendJson(res, 404, { error: 'config.json not found' })
            if (loaded.data == null)
                return sendJson(res, 500, { error: 'config.json is invalid', detail: loaded.error })

            const sessionPath = typeof loaded.data.sessionPath === 'string' ? loaded.data.sessionPath : 'sessions'
            const result = deleteStoredSessions(projectRoot, sessionPath, email)
            if (!result.found) {
                return sendJson(res, 404, {
                    error: `No stored sessions found for ${email}.`,
                    code: 'SESSION_NOT_FOUND'
                })
            }

            pm.note('info', `Deleted ${result.removed} stored session row(s) for ${result.email} via API.`)
            return sendJson(res, 200, { deleted: true, ...result })
        }

        // diag list
        if (method === 'GET' && pathname === '/diagnostics') {
            return sendJson(res, 200, listDiagnostics())
        }

        // diag read
        if (method === 'GET' && pathname.startsWith('/diagnostics/')) {
            return serveDiagnosticFile(res, pathname)
        }

        // conf read
        if (method === 'GET' && pathname === '/config') {
            const loaded = loadConfigSafe(projectRoot)
            if (!loaded) return sendJson(res, 404, { error: 'config.json not found' })
            if (loaded.data == null)
                return sendJson(res, 500, { error: 'config.json is invalid', detail: loaded.error })
            const reveal = REVEAL_ENABLED && Boolean(TOKEN) && url.searchParams.get('reveal') === '1'
            const data = reveal ? loaded.data : redactSecrets(loaded.data)
            return sendJson(res, 200, { path: loaded.path, redacted: !reveal, config: data })
        }

        // sched read
        if (method === 'GET' && pathname === '/schedule') {
            try {
                return sendJson(res, 200, { ...readSchedule(projectRoot), writable: ALLOW_SCHEDULE_WRITE })
            } catch (err) {
                return sendJson(res, 500, { error: err.message, code: err.code })
            }
        }

        // sched write
        if ((method === 'PUT' || method === 'PATCH') && pathname === '/schedule') {
            if (!ALLOW_SCHEDULE_WRITE) {
                return sendJson(res, 403, {
                    error: 'Schedule writes are disabled. Set API_ALLOW_SCHEDULE_WRITE=true to enable.'
                })
            }
            const body = await readJsonBody(req)
            if (typeof body !== 'object' || body === null || Array.isArray(body)) {
                return sendJson(res, 400, { error: 'Body must be a JSON object.' })
            }
            try {
                const updated = writeSchedule(projectRoot, body)
                pm.note(
                    'info',
                    `Schedule updated via API (${method}): ${updated.enabled ? `${updated.cron} (TZ ${updated.timezone})` : 'disabled'}.`
                )
                return sendJson(res, 200, { ...updated, writable: true })
            } catch (err) {
                const status = err.code === 'BAD_REQUEST' ? 400 : 500
                return sendJson(res, status, { error: err.message, code: err.code })
            }
        }

        // sse
        if (method === 'GET' && pathname === '/events') {
            return handleEventStream(req, res, url)
        }

        // start
        if (method === 'POST' && pathname === '/start') {
            const body = await readJsonObject(req)
            const overrides = {}
            if (body.args != null) overrides.args = body.args
            if (body.env != null) {
                if (!ALLOW_ENV_OVERRIDES) {
                    return sendJson(res, 403, {
                        error: 'Per-request env overrides are disabled. Set API_ALLOW_ENV_OVERRIDES=true to enable.'
                    })
                }
                overrides.env = body.env
            }
            try {
                const selection = startSelectionFor(body)
                if (Object.keys(selection.env).length) {
                    overrides.env = { ...(overrides.env || {}), ...selection.env }
                }
                rerunController.noteExternalStart()
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
        }

        // cancel a pending rerun pass without touching any running process
        if (method === 'POST' && pathname === '/rerun/cancel') {
            const pending = rerunController.getState().pending
            rerunController.cancel('cancelled from the dashboard')
            return sendJson(res, pending ? 202 : 409, {
                cancelled: pending,
                ...(pending ? {} : { error: 'No rerun pass is pending.', code: 'NOT_PENDING' })
            })
        }

        // kill proc
        if (method === 'POST' && pathname === '/stop') {
            const body = await readJsonObject(req)
            const force = readForce(body)
            try {
                // Mark the chain dead before signalling: this - not the exit code -
                // is what tells the controller a human stopped the run. On Windows
                // the tree is killed with taskkill, whose exit code is
                // indistinguishable from a crash.
                rerunController.cancel('stop requested')
                const stopping = pm.stop({ force })
                stopping.catch(() => {})
                return sendJson(res, 202, { stopping: true, force })
            } catch (err) {
                if (err.code === 'NOT_RUNNING') return sendJson(res, 409, { error: err.message, code: err.code })
                return sendJson(res, 500, { error: err.message })
            }
        }

        // restart
        if (method === 'POST' && pathname === '/restart') {
            const body = await readJsonObject(req)
            const overrides = { force: readForce(body) }
            if (body.args != null) overrides.args = body.args
            if (body.env != null) {
                if (!ALLOW_ENV_OVERRIDES) {
                    return sendJson(res, 403, {
                        error: 'Per-request env overrides are disabled. Set API_ALLOW_ENV_OVERRIDES=true to enable.'
                    })
                }
                overrides.env = body.env
            }
            try {
                const selection = startSelectionFor(body)
                if (Object.keys(selection.env).length) {
                    overrides.env = { ...(overrides.env || {}), ...selection.env }
                }
                rerunController.noteExternalStart()
                const info = await pm.restart(overrides)
                return sendJson(res, 202, {
                    restarted: true,
                    selectedAccount: selection.selectedAccount,
                    excludedAccounts: selection.excludedAccounts,
                    ...info
                })
            } catch (err) {
                if (err.code) return sendJson(res, selectionErrorStatus(err.code), { error: err.message, code: err.code })
                return sendJson(res, 500, { error: err.message })
            }
        }

        // conf
        if ((method === 'PUT' || method === 'PATCH') && pathname === '/config') {
            if (!ALLOW_CONFIG_WRITE) {
                return sendJson(res, 403, {
                    error: 'Config writes are disabled. Set API_ALLOW_CONFIG_WRITE=true to enable.'
                })
            }
            const body = await readJsonBody(req)
            if (typeof body !== 'object' || body === null || Array.isArray(body)) {
                return sendJson(res, 400, { error: 'Body must be a JSON object.' })
            }
            let candidate
            try {
                candidate = method === 'PATCH' ? deepMerge(readConfig(projectRoot).data, body) : body
            } catch (err) {
                return sendJson(res, err.code === 'BAD_REQUEST' ? 400 : 500, {
                    error: `Could not prepare config update: ${err instanceof Error ? err.message : err}`
                })
            }
            const result = await validateConfig(candidate, {
                projectRoot,
                validatorModule: envStr('API_VALIDATOR_MODULE')
            })
            if (!result.ok) {
                return sendJson(res, 422, { error: 'Config validation failed', via: result.via, errors: result.errors })
            }
            try {
                const written = writeConfigAtomic(projectRoot, result.value ?? candidate)
                pm.note('info', `config.json updated via API (${method}); applies on the next run.`)
                return sendJson(res, 200, { ok: true, path: written, via: result.via, appliesOnNextRun: true })
            } catch (err) {
                return sendJson(res, 500, {
                    error: `Could not write config: ${err instanceof Error ? err.message : err}`
                })
            }
        }

        // stop api
        if (method === 'POST' && pathname === '/shutdown') {
            const body = await readJsonObject(req)
            const force = readForce(body)
            sendJson(res, 202, { shuttingDown: true, stoppingBot: pm.getStatus().state !== 'idle' })
            setTimeout(() => void shutdown('API /shutdown', { force }), 50)
            return
        }

        return sendJson(res, 404, { error: 'Not found', path: pathname })
    } catch (err) {
        if (err && (err.code === 'BAD_JSON' || err.code === 'BODY_TOO_LARGE' || err.code === 'BAD_REQUEST')) {
            return sendJson(res, 400, { error: err.message, code: err.code })
        }
        log('ERROR', 'Unhandled request error:', err instanceof Error ? err.stack : err)
        if (!res.headersSent) return sendJson(res, 500, { error: 'Internal server error' })
    }
}

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10)
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, n))
}

// diagn
const DIAG_FILES = {
    'screenshot.png': 'image/png',
    'error.txt': 'text/plain; charset=utf-8',
    'dump.html': 'application/octet-stream'
}

function listDiagnostics() {
    let dirents
    try {
        dirents = fs
            .readdirSync(DIAG_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name.startsWith('error-'))
    } catch {
        return { dir: DIAG_DIR, count: 0, entries: [] }
    }
    const entries = dirents
        .map(d => {
            const full = path.join(DIAG_DIR, d.name)
            let files = []
            let createdAt = null
            let error = null
            try {
                files = fs.readdirSync(full)
            } catch {}
            try {
                createdAt = fs.statSync(full).mtime.toISOString()
            } catch {}
            if (files.includes('error.txt')) {
                try {
                    error = fs.readFileSync(path.join(full, 'error.txt'), 'utf8').slice(0, 2000)
                } catch {}
            }
            return {
                name: d.name,
                createdAt,
                hasScreenshot: files.includes('screenshot.png'),
                hasHtml: files.includes('dump.html'),
                hasError: files.includes('error.txt'),
                error
            }
        })
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    return { dir: DIAG_DIR, count: entries.length, entries }
}

function serveDiagnosticFile(res, pathname) {
    let parts
    try {
        parts = pathname.slice('/diagnostics/'.length).split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
        return sendJson(res, 400, { error: 'Invalid diagnostics path encoding' })
    }
    if (parts.length !== 2) return sendJson(res, 404, { error: 'Not found' })
    const [name, file] = parts
    if (!/^error-[A-Za-z0-9._:-]+$/.test(name) || !(file in DIAG_FILES)) {
        return sendJson(res, 400, { error: 'Invalid diagnostics path' })
    }
    const full = path.join(DIAG_DIR, name, file)
    if (!path.resolve(full).startsWith(path.resolve(DIAG_DIR) + path.sep)) {
        return sendJson(res, 400, { error: 'Invalid diagnostics path' })
    }
    if (!fs.existsSync(full)) return sendJson(res, 404, { error: 'Not found' })
    const headers = { 'Content-Type': DIAG_FILES[file] }
    if (file === 'dump.html') headers['Content-Disposition'] = `attachment; filename="${name}-dump.html"`
    res.writeHead(200, headers)
    fs.createReadStream(full).pipe(res)
}

// startup
const server = http.createServer(requestHandler)

server.on('error', err => {
    if (err && err.code === 'EADDRINUSE') {
        log('ERROR', `Port ${PORT} is already in use on ${HOST}. Set API_PORT to a free port.`)
        process.exit(1)
    }
    log('ERROR', 'Server error:', err instanceof Error ? err.message : err)
    process.exit(1)
})

server.listen(PORT, HOST, () => {
    log('INFO', `${pkgName} control API listening on http://${HOST}:${PORT} | dashboard at http://${HOST}:${PORT}/ui`)
    log('INFO', `Launch command: ${command} ${args.join(' ')}`.trim())
    log(
        'INFO',
        `Auth: ${TOKEN ? 'shared token required (API_TOKEN)' : 'DISABLED (no API_TOKEN set)'} | CORS origin: ${CORS_ORIGIN}`
    )
    log(
        'INFO',
        `Runtime state: memory-only | config writes: ${ALLOW_CONFIG_WRITE ? 'on' : 'off'} | schedule writes: ${ALLOW_SCHEDULE_WRITE ? 'on' : 'off'} | session deletion: account-scoped`
    )
    if (!TOKEN) {
        const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1'
        log(
            loopback ? 'WARN' : 'ERROR',
            loopback
                ? 'No API_TOKEN set - the API is open to anything on this machine. Set API_TOKEN and give the dashboard the same value as CONTROL_API_TOKEN.'
                : 'API is bound to a non-loopback address WITHOUT a token - anyone who can reach this port can start/stop the bot and read your logs. Set API_TOKEN.'
        )
    }

    const ready = {
        host: HOST,
        port: PORT,
        pid: process.pid,
        name: pkgName,
        version: pkgVersion,
        auth: Boolean(TOKEN)
    }
    process.stdout.write(`__API_READY__ ${JSON.stringify(ready)}\n`)
})

let shuttingDown = false
async function shutdown(signal, { force = false } = {}) {
    if (shuttingDown) return
    shuttingDown = true
    log('INFO', `${signal} received - shutting down.`)
    rerunController.cancel('shutting down')
    server.close()
    try {
        if (pm.getStatus().state !== 'idle') {
            log('INFO', `Stopping active bot run${force ? ' (force)' : ''}…`)
            await pm.stop({ force })
        }
    } catch {
        // ignore
    }
    process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
