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
