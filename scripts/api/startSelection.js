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
