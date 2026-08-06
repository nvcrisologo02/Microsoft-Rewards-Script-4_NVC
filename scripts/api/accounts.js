import { accountIndexesFromEnv, envStrFrom } from '../env.js'

function sanitizeProxyUrl(value) {
    try {
        const url = new URL(value)
        url.username = ''
        url.password = ''
        return url.toString().replace(/\/$/, '')
    } catch {
        return value.replace(/^(?:[^/@\s]+@|([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@)/i, '$1')
    }
}

/**
 * Returns the configured accounts without exposing passwords, recovery
 * addresses, TOTP secrets, or proxy credentials. This API is intended for the
 * local dashboard, so account email addresses are returned in full.
 */
export function loadAccounts(sourceEnv = process.env) {
    const accounts = []

    for (const i of accountIndexesFromEnv(sourceEnv)) {
        const email = envStrFrom(sourceEnv, `ACCOUNT_${i}_EMAIL`)
        if (!email) continue

        const proxyUrl = envStrFrom(sourceEnv, `ACCOUNT_${i}_PROXY_URL`)
        accounts.push({
            index: i,
            email,
            emailKey: email, // internal history join key; removed before returning the response
            geoLocale: envStrFrom(sourceEnv, `ACCOUNT_${i}_GEO_LOCALE`) ?? 'auto',
            langCode: envStrFrom(sourceEnv, `ACCOUNT_${i}_LANG_CODE`) ?? 'en',
            hasRecoveryEmail: Boolean(envStrFrom(sourceEnv, `ACCOUNT_${i}_RECOVERY_EMAIL`)),
            hasTotp: Boolean(envStrFrom(sourceEnv, `ACCOUNT_${i}_TOTP_SECRET`)),
            proxy: proxyUrl
                ? {
                      url: sanitizeProxyUrl(proxyUrl),
                      port: envStrFrom(sourceEnv, `ACCOUNT_${i}_PROXY_PORT`) ?? null,
                      hasCredentials: Boolean(
                          envStrFrom(sourceEnv, `ACCOUNT_${i}_PROXY_USERNAME`) &&
                          envStrFrom(sourceEnv, `ACCOUNT_${i}_PROXY_PASSWORD`)
                      )
                  }
                : null
        })
    }
    return accounts
}

/**
 * Builds a child-process-only environment override that runs exactly one
 * configured account. The selected slot is remapped to ACCOUNT_1_* in the
 * isolated child environment. No secret values leave the API process.
 */
export function buildSingleAccountEnv(accountIndex, sourceEnv = process.env) {
    const index = Number(accountIndex)
    if (!Number.isSafeInteger(index) || index < 1) {
        const err = new Error('`accountIndex` must be a positive integer.')
        err.code = 'BAD_REQUEST'
        throw err
    }

    const selectedPrefix = `ACCOUNT_${index}_`
    const selected = Object.entries(sourceEnv).filter(([key]) => key.startsWith(selectedPrefix))
    const email = envStrFrom(sourceEnv, `${selectedPrefix}EMAIL`)
    if (!email) {
        const err = new Error(`ACCOUNT_${index} is not configured.`)
        err.code = 'BAD_REQUEST'
        throw err
    }

    const env = {}

    // Blank every configured account variable in the child environment first.
    // Empty strings are treated as unset by the bot's env parser.
    for (const key of Object.keys(sourceEnv)) {
        if (/^ACCOUNT_\d+_/.test(key)) env[key] = ''
    }

    // Copy the chosen slot into slot 1, including any future ACCOUNT_N_* fields
    // not known by this API yet (password, browser settings, proxy fields, etc.).
    for (const [key, value] of selected) {
        const suffix = key.slice(selectedPrefix.length)
        env[`ACCOUNT_1_${suffix}`] = value
    }

    return {
        env,
        account: { index, email }
    }
}

/**
 * Builds a dense child-process account environment with selected configured
 * slots excluded. Remaining slots are remapped to ACCOUNT_1..N.
 */
export function buildExcludedAccountsEnv(excludedAccountIndexes, sourceEnv = process.env) {
    if (!Array.isArray(excludedAccountIndexes)) {
        const err = new Error('`excludedAccountIndexes` must be an array of positive integers.')
        err.code = 'BAD_REQUEST'
        throw err
    }

    const excluded = [...new Set(excludedAccountIndexes.map(Number))]
    if (excluded.some(index => !Number.isSafeInteger(index) || index < 1)) {
        const err = new Error('`excludedAccountIndexes` must contain only positive integers.')
        err.code = 'BAD_REQUEST'
        throw err
    }

    const accounts = loadAccounts(sourceEnv)
    const knownIndexes = new Set(accounts.map(account => account.index))
    const unknown = excluded.filter(index => !knownIndexes.has(index))
    if (unknown.length) {
        const err = new Error(
            `Unknown account slot${unknown.length === 1 ? '' : 's'}: ${unknown.map(index => `ACCOUNT_${index}`).join(', ')}.`
        )
        err.code = 'BAD_REQUEST'
        throw err
    }

    const excludedSet = new Set(excluded)
    const included = accounts.filter(account => !excludedSet.has(account.index))
    if (!included.length) {
        const err = new Error('A scheduled run cannot exclude every configured account.')
        err.code = 'BAD_REQUEST'
        throw err
    }

    const env = {}
    for (const key of Object.keys(sourceEnv)) {
        if (/^ACCOUNT_\d+_/.test(key)) env[key] = ''
    }

    included.forEach((account, position) => {
        const sourcePrefix = `ACCOUNT_${account.index}_`
        const targetPrefix = `ACCOUNT_${position + 1}_`
        for (const [key, value] of Object.entries(sourceEnv)) {
            if (!key.startsWith(sourcePrefix)) continue
            env[`${targetPrefix}${key.slice(sourcePrefix.length)}`] = value
        }
    })

    return {
        env,
        excludedAccounts: accounts
            .filter(account => excludedSet.has(account.index))
            .map(({ index, email }) => ({ index, email })),
        includedAccounts: included.map(({ index, email }) => ({ index, email }))
    }
}

/**
 * Groups an account's per-pass records into chains before its stats are computed.
 *
 * A rerun chain runs the same account several times, and its last pass is by
 * construction the one that finds nothing left - so reading only the most recent
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
        // that carries the protection object with a null counter inside hide a
        // counter that is still there, a few records further back.
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
