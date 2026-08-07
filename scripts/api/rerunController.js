import { EventEmitter } from 'node:events'

/**
 * Decides whether a finished run deserves another pass, and with which
 * accounts. Pure on purpose: every behavioural rule of the rerun feature lives
 * here, so it can be tested without processes, timers or files.
 *
 * An account is worth retrying when it gained points (there is likely more
 * pending - Bing daily offers in particular credit asynchronously, after the
 * account has already been closed) or when it failed outright (it almost
 * certainly left points untouched, and nothing retries it today).
 *
 * A run killed mid-account (the child died before logging ACCOUNT-END or
 * ACCOUNT-ERROR) leaves that account with no outcome at all, which is neither
 * of the two. Only a run that never reached RUN-END may treat that silence as
 * a failure, so a clean run keeps ignoring accounts it deliberately skipped.
 */
export function decideNextPass({
    runAccounts = [],
    knownAccounts = [],
    excludedAccountIndexes = [],
    autoRerun,
    pass = 1,
    cancelled = false,
    runFinished = true
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
                    const interrupted = !runFinished && account?.success == null
                    return gained > 0 || account?.success === false || interrupted
                })
                .map(account => indexByEmail.get(String(account?.email ?? '').toLowerCase()))
                .filter(index => index !== undefined && !paused.has(index))
        )
    ].sort((a, b) => a - b)

    if (!accountIndexes.length) return nothing('nothing-pending')

    return { shouldRerun: true, accountIndexes, delayMs, reason: 'pending' }
}

/**
 * Owns the multi-pass chain: which pass we are on, whether one is pending, and
 * the timer in between. Deliberately separate from ProcessManager, whose state
 * machine describes a single child process - folding the chain into it would
 * make its `state !== 'idle'` start guard ambiguous.
 */
export class RerunController extends EventEmitter {
    constructor({
        pm,
        projectRoot,
        readSchedule,
        loadAccounts,
        buildExcludedEnv,
        setTimer = setTimeout,
        clearTimer = clearTimeout
    }) {
        super()
        this.pm = pm
        this.projectRoot = projectRoot
        this.readSchedule = readSchedule
        this.loadAccounts = loadAccounts
        this.buildExcludedEnv = buildExcludedEnv
        this.setTimer = setTimer
        this.clearTimer = clearTimer

        this.pass = 1
        this.chainId = null
        this.maxPasses = null
        this.cancelled = false
        this._timer = null
        this._pendingIndexes = []
        this._nextPassAt = null
    }

    attach() {
        this.pm.on('run-complete', entry => this._onRunComplete(entry))
        return this
    }

    getState() {
        return {
            pending: this._timer != null,
            pass: this.pass,
            chainId: this.chainId,
            maxPasses: this.maxPasses,
            nextPassAt: this._nextPassAt,
            accountIndexes: [...this._pendingIndexes]
        }
    }

    /** A run this controller did not start: cron, the dashboard, RUN_ON_START. */
    noteExternalStart() {
        this._clearPending()
        this.pass = 1
        this.chainId = null
        this.cancelled = false
        this.emit('change')
    }

    cancel(reason) {
        const wasPending = this._timer != null
        this._clearPending()
        this.cancelled = true
        if (reason) this._note('info', `Rerun chain cancelled (${reason}).`)
        if (wasPending) this.emit('change')
    }

    _clearPending() {
        if (this._timer != null) this.clearTimer(this._timer)
        this._timer = null
        this._pendingIndexes = []
        this._nextPassAt = null
    }

    _note(level, message) {
        try {
            this.pm.note(level, `[AUTO-RERUN] ${message}`)
        } catch {
            /* logging must never break the chain */
        }
    }

    _onRunComplete(entry) {
        try {
            // The first pass of a chain names it. Later passes inherit the id,
            // which is what lets the dashboard aggregate them as one run.
            if (this.chainId == null && typeof entry?.startedAt === 'string') {
                this.chainId = entry.startedAt
            }

            let schedule
            try {
                schedule = this.readSchedule(this.projectRoot)
            } catch (error) {
                // Rather run nothing than run accounts the user paused.
                this._note('warn', `Could not read the schedule (${error.message}); not scheduling another pass.`)
                this._clearPending()
                return
            }

            this.maxPasses = schedule.autoRerun?.maxPasses ?? null

            const decision = decideNextPass({
                runAccounts: entry?.run?.accounts ?? [],
                knownAccounts: this.loadAccounts(),
                excludedAccountIndexes: schedule.excludedAccountIndexes ?? [],
                autoRerun: schedule.autoRerun,
                pass: this.pass,
                // No RUN-END means the child died mid-run; the account it was on
                // never got to report an outcome and would otherwise be dropped.
                runFinished: entry?.run?.finished !== false,
                // A signalled exit means something killed the child - a container
                // shutdown, or a stop on a platform where the explicit cancel
                // never reached us. Either way, do not chain another pass.
                cancelled: this.cancelled || Boolean(entry?.exit?.signal)
            })

            this.cancelled = false

            if (!decision.shouldRerun) {
                this._clearPending()
                if (decision.reason === 'nothing-pending') {
                    this._note('info', `Nothing left to collect after pass ${this.pass}; chain finished.`)
                } else if (decision.reason === 'max-passes') {
                    this._note('info', `Reached the ${schedule.autoRerun?.maxPasses} pass limit; chain finished.`)
                }
                return
            }

            this._pendingIndexes = decision.accountIndexes
            this._nextPassAt = new Date(Date.now() + decision.delayMs).toISOString()
            this._timer = this.setTimer(() => this._startNextPass(), decision.delayMs)
            if (typeof this._timer?.unref === 'function') this._timer.unref()

            this._note(
                'info',
                `Pass ${this.pass} done. Scheduling pass ${this.pass + 1} of ${schedule.autoRerun?.maxPasses} in ` +
                    `${decision.delayMs / 60_000} min for ACCOUNT_${decision.accountIndexes.join(', ACCOUNT_')}.`
            )
            this.emit('change')
        } catch (error) {
            this._note('warn', `Unexpected failure while planning the next pass: ${error.message}`)
            this._clearPending()
        }
    }

    _startNextPass() {
        const indexes = [...this._pendingIndexes]
        this._clearPending()

        try {
            // Re-read now, not at decision time: pausing an account during the
            // cooldown must take effect on the pass about to start.
            const schedule = this.readSchedule(this.projectRoot)
            const paused = new Set(schedule.excludedAccountIndexes ?? [])
            const wanted = new Set(indexes.filter(index => !paused.has(index)))

            if (!wanted.size) {
                this._note('info', 'Every account for this pass is now paused; chain finished.')
                this.emit('change')
                return
            }

            const excluded = this.loadAccounts()
                .map(account => account.index)
                .filter(index => !wanted.has(index))

            const selection = this.buildExcludedEnv(excluded)
            this.pass += 1
            this.pm.start({ env: { ...selection.env, RERUN_PASS: String(this.pass) } })
            this._note('info', `Pass ${this.pass} started.`)
        } catch (error) {
            if (error?.code === 'ALREADY_RUNNING') {
                this._note('info', 'Another run is already in progress; abandoning the rerun chain.')
            } else {
                this._note('warn', `Could not start the next pass: ${error.message}`)
            }
        } finally {
            this.emit('change')
        }
    }
}
