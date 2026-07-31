import fs from 'node:fs'
import path from 'node:path'

export function historyFilePath(projectRoot) {
    const override = process.env.HISTORY_FILE
    if (override && override.trim().length) return path.resolve(override.trim())
    return path.join(projectRoot, 'data', 'history.ndjson')
}

function readAll(projectRoot) {
    const file = historyFilePath(projectRoot)
    let text
    try {
        text = fs.readFileSync(file, 'utf8')
    } catch {
        return []
    }
    const runs = []
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
            const parsed = JSON.parse(line)
            if (parsed && typeof parsed === 'object' && typeof parsed.startedAt === 'string') runs.push(parsed)
        } catch {
            // Corrupt or partial line (e.g. crash mid-append): skip, never crash a read.
        }
    }
    return runs
}

export function appendRun(projectRoot, record) {
    if (!record || typeof record.startedAt !== 'string') return false
    const file = historyFilePath(projectRoot)
    const existing = readAll(projectRoot)
    const last = existing[existing.length - 1]
    if (last && last.startedAt === record.startedAt) return false
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(record) + '\n')
    return true
}

// Merge in-memory runs (lost on restart) with persisted NDJSON runs so
// account stats survive container restarts. Memory wins on same startedAt.
export function combineRuns(memoryRuns, persistedRuns) {
    const byStart = new Map()
    for (const source of [persistedRuns, memoryRuns]) {
        for (const run of source || []) {
            if (!run || typeof run.startedAt !== 'string') continue
            byStart.set(run.startedAt, run)
        }
    }
    return [...byStart.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
}

export function readRuns(projectRoot, { limit = 100, offset = 0 } = {}) {
    const all = readAll(projectRoot)
    const newestFirst = all.slice().reverse()
    return {
        runs: newestFirst.slice(offset, offset + limit),
        total: all.length
    }
}
