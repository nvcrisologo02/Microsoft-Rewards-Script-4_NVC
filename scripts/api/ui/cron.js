// Pure numeric five-field cron parsing (mirrors the server-side parser's accepted
// grammar: *, numbers, lists, ranges, steps; no names, no macros).

const BOUNDS = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // day of month
    { min: 1, max: 12 }, // month
    { min: 0, max: 7 }   // day of week (7 == 0 == Sunday)
]

function parseField(field, { min, max }) {
    const out = new Set()
    for (const part of field.split(',')) {
        const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
        if (!m) return null
        const step = m[2] === undefined ? 1 : Number(m[2])
        if (!Number.isInteger(step) || step < 1) return null
        let lo
        let hi
        if (m[1] === '*') {
            lo = min
            hi = max
        } else if (m[1].includes('-')) {
            const [a, b] = m[1].split('-').map(Number)
            lo = a
            hi = b
        } else {
            lo = Number(m[1])
            hi = m[2] === undefined ? lo : max
        }
        if (lo < min || hi > max || lo > hi) return null
        for (let v = lo; v <= hi; v += step) out.add(v)
    }
    return out.size ? out : null
}

export function parseCron(expr) {
    if (typeof expr !== 'string') return null
    const fields = expr.trim().split(/\s+/)
    if (fields.length !== 5) return null
    const parsed = fields.map((field, i) => parseField(field, BOUNDS[i]))
    if (parsed.some(set => set === null)) return null
    const [minute, hour, dom, month, dow] = parsed
    if (dow.has(7)) dow.add(0)
    return { minute, hour, dom, month, dow }
}

export function nextRuns(expr, from, count = 5) {
    const cron = parseCron(expr)
    if (!cron) return []
    const dowIsAll = [0, 1, 2, 3, 4, 5, 6].every(d => cron.dow.has(d))
    const domIsAll = cron.dom.size === 31

    const runs = []
    const cursor = new Date(from.getTime())
    cursor.setSeconds(0, 0)
    cursor.setMinutes(cursor.getMinutes() + 1)
    const limit = new Date(from.getTime() + 366 * 24 * 3600 * 1000)

    while (runs.length < count && cursor <= limit) {
        const monthOk = cron.month.has(cursor.getMonth() + 1)
        const domOk = cron.dom.has(cursor.getDate())
        const dowOk = cron.dow.has(cursor.getDay())
        // standard cron: when both dom and dow are restricted, either may match
        const dayOk = !domIsAll && !dowIsAll ? domOk || dowOk : domOk && dowOk
        if (monthOk && dayOk && cron.hour.has(cursor.getHours()) && cron.minute.has(cursor.getMinutes())) {
            runs.push(new Date(cursor.getTime()))
        }
        cursor.setMinutes(cursor.getMinutes() + 1)
    }
    return runs
}
