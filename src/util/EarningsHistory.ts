import fs from 'fs'
import path from 'path'

const FILE = 'earnings.ndjson'
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
 */
export class EarningsHistory {
    constructor(private readonly baseDir: string) {}

    private get file(): string {
        return path.join(this.baseDir, FILE)
    }

    private read(): Entry[] {
        try {
            return fs
                .readFileSync(this.file, 'utf-8')
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .map(line => JSON.parse(line) as Entry)
                .filter(entry => entry && typeof entry.email === 'string' && typeof entry.gained === 'number')
        } catch {
            return []
        }
    }

    record(email: string, gained: number): void {
        const key = email.trim().toLowerCase()
        if (!key) return
        try {
            fs.mkdirSync(this.baseDir, { recursive: true })
            fs.appendFileSync(this.file, `${JSON.stringify({ email: key, gained })}\n`, 'utf-8')
            this.prune()
        } catch {
            // History is best-effort
        }
    }

    /** Consecutive most-recent runs where this account earned nothing. */
    zeroStreak(email: string): number {
        const key = email.trim().toLowerCase()
        const mine = this.read().filter(entry => entry.email === key)
        let streak = 0
        for (let i = mine.length - 1; i >= 0; i--) {
            const entry = mine[i]
            if (!entry || entry.gained > 0) break
            streak++
        }
        return streak
    }

    /**
     * Keeps only the newest MAX_ENTRIES_PER_ACCOUNT entries per account, preserving
     * overall chronological order. Walks the log from newest to oldest, counting how
     * many entries have been kept per account so far, so the decision to keep or drop
     * an entry depends only on its position in the stream - never on object identity.
     */
    private prune(): void {
        try {
            const entries = this.read()
            const keptCountByEmail = new Map<string, number>()
            const keptReversed: Entry[] = []
            for (let i = entries.length - 1; i >= 0; i--) {
                const entry = entries[i]
                if (!entry) continue
                const keptCount = keptCountByEmail.get(entry.email) ?? 0
                if (keptCount >= MAX_ENTRIES_PER_ACCOUNT) continue
                keptCountByEmail.set(entry.email, keptCount + 1)
                keptReversed.push(entry)
            }
            if (keptReversed.length === entries.length) return
            const kept = keptReversed.reverse()
            fs.writeFileSync(this.file, kept.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf-8')
        } catch {
            // Pruning is best-effort
        }
    }
}
