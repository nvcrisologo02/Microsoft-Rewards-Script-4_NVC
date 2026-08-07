// An error that escapes into the event loop (a throw inside an EventEmitter callback, a
// rejected promise nobody awaited) bypasses the per-account try/catch in runTasks, so the
// only thing left to handle it is the process-wide uncaughtException hook — which used to
// kill the run, taking every account still queued with it.
//
// This guard turns such an error back into a rejection of the account currently in flight,
// which is exactly what the existing per-account catch already knows how to recover from:
// the account is logged as ACCOUNT-ERROR, the rerun chain picks it up, and the loop moves
// on to the next account.
//
// Node documents process state as undefined after an uncaught exception, so this is not a
// blank cheque: the abandoned work keeps whatever browser it had open until the process
// ends, so after `maxHandled` absorbed errors the guard declines and the process exits.

export class FatalErrorGuard {
    private readonly pending = new Set<(error: Error) => void>()
    private handled = 0

    constructor(private readonly maxHandled = 3) {}

    /** Awaits `work`, but rejects instead if a fatal error is reported while it is in flight. */
    async guard<T>(work: Promise<T>): Promise<T> {
        let reject!: (error: Error) => void
        const fatal = new Promise<never>((_, rejectFatal) => {
            reject = rejectFatal
        })

        this.pending.add(reject)
        try {
            // Promise.race keeps a handler attached to `work`, so a late rejection of the
            // abandoned account cannot resurface as an unhandledRejection.
            return await Promise.race([work, fatal])
        } finally {
            this.pending.delete(reject)
        }
    }

    /**
     * Hands a fatal error to the work in flight. Returns false when nobody can take it —
     * nothing is running, or this run already absorbed too many — meaning the caller
     * should let the process die.
     */
    report(error: Error): boolean {
        if (this.pending.size === 0) return false
        if (this.handled >= this.maxHandled) return false

        this.handled++
        for (const reject of [...this.pending]) reject(error)
        return true
    }
}

/** Shared by the account loop and the process-wide error hooks in index.ts. */
export const fatalErrorGuard = new FatalErrorGuard()
