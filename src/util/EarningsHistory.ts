import fs from 'fs'
import path from 'path'

const MAX_ENTRIES_PER_ACCOUNT = 30

export const ZERO_STREAK_ALERT_THRESHOLD = 3

interface Entry {
    email: string
    gained: number
}

/**
 * Append-only record of what each account earned per run, used to notice when a
 * mechanism silently stops producing points. All filesystem errors degrade to
 * "no history" rather than failing a run.
 *
 * Storage is one NDJSON file per account (named after a filesystem-safe slug of the
 * email) rather than a single shared file. The deployment runs multiple cluster
 * processes concurrently, each owning a disjoint set of accounts, so a given account's
 * file is only ever touched by one process at a time - append + prune cannot race with
 * another process the way a shared file's read-modify-write would.
 */
export class EarningsHistory {
    constructor(private readonly baseDir: string) {}

    private key(email: string): string {
        return email.trim().toLowerCase()
    }

    private fileFor(email: string): string {
        const slug = this.key(email).replace(/[^a-z0-9]/g, '_')
        return path.join(this.baseDir, `${slug}.ndjson`)
    }

    /**
     * Parses each line independently so a single torn/malformed line (e.g. from a
     * process killed mid-write) is skipped without discarding the rest of the file.
     * Only a missing/unreadable file degrades to "no history".
     */
    private read(email: string): Entry[] {
        let raw: string
        try {
            raw = fs.readFileSync(this.fileFor(email), 'utf-8')
        } catch {
            return []
        }

        const entries: Entry[] = []
        for (const rawLine of raw.split('\n')) {
            const line = rawLine.trim()
            if (!line) continue
            try {
                const entry = JSON.parse(line) as Entry
                if (entry && typeof entry.email === 'string' && typeof entry.gained === 'number') {
                    entries.push(entry)
                }
            } catch {
                // Skip this one malformed line; the rest of the file is still valid
            }
        }
        return entries
    }

    record(email: string, gained: number): void {
        const key = this.key(email)
        if (!key) return
        try {
            fs.mkdirSync(this.baseDir, { recursive: true })
            fs.appendFileSync(this.fileFor(email), `${JSON.stringify({ email: key, gained })}\n`, 'utf-8')
            this.prune(email)
        } catch {
            // History is best-effort
        }
    }

    /** Consecutive most-recent runs where this account earned nothing. */
    zeroStreak(email: string): number {
        const mine = this.read(email)
        let streak = 0
        for (let i = mine.length - 1; i >= 0; i--) {
            const entry = mine[i]
            if (!entry || entry.gained > 0) break
            streak++
        }
        return streak
    }

    /** Keeps only the newest MAX_ENTRIES_PER_ACCOUNT entries for this account. */
    private prune(email: string): void {
        try {
            const entries = this.read(email)
            if (entries.length <= MAX_ENTRIES_PER_ACCOUNT) return
            const kept = entries.slice(entries.length - MAX_ENTRIES_PER_ACCOUNT)
            fs.writeFileSync(this.fileFor(email), kept.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf-8')
        } catch {
            // Pruning is best-effort
        }
    }
}
