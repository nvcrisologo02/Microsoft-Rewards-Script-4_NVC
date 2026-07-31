import fs from 'fs'
import path from 'path'

import { normalizeQueryKey } from './QueryEngine'

const FILE_EXT = '.ndjson'
const DAY_MS = 24 * 60 * 60 * 1000

function dateKey(date = new Date()): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

/**
 * Shared, file-backed record of search queries used today across all accounts.
 * One NDJSON file per day (one normalized query key per line); appends are
 * atomic enough for the parallel cluster processes. All fs errors degrade
 * silently to per-session dedup behavior.
 */
export class SearchQueryLedger {
    constructor(private readonly baseDir: string) {}

    private todayFile(): string {
        return path.join(this.baseDir, `${dateKey()}${FILE_EXT}`)
    }

    load(): Set<string> {
        const seen = new Set<string>()
        try {
            const raw = fs.readFileSync(this.todayFile(), 'utf-8')
            for (const line of raw.split('\n')) {
                const key = line.trim()
                if (key) seen.add(key)
            }
        } catch {
            // Missing file or unreadable: start empty
        }
        return seen
    }

    record(query: string): void {
        const key = normalizeQueryKey(query)
        if (!key) return
        try {
            fs.mkdirSync(this.baseDir, { recursive: true })
            fs.appendFileSync(this.todayFile(), `${key}\n`, 'utf-8')
        } catch {
            // Unwritable: dedup degrades to per-session
        }
    }

    cleanup(maxAgeDays = 7): void {
        try {
            const cutoff = Date.now() - maxAgeDays * DAY_MS
            for (const file of fs.readdirSync(this.baseDir)) {
                if (!file.endsWith(FILE_EXT)) continue
                const stamp = Date.parse(file.slice(0, -FILE_EXT.length))
                if (!Number.isNaN(stamp) && stamp < cutoff) {
                    fs.rmSync(path.join(this.baseDir, file), { force: true })
                }
            }
        } catch {
            // Directory missing: nothing to clean
        }
    }
}
