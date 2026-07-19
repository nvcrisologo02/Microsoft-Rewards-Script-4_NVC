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
