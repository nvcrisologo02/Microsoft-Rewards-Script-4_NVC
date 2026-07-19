// Pure data transforms for the Ejecuciones charts. No DOM, node-testable.

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

function dayKey(date) {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

export function aggregateDaily(runs, days, now = new Date()) {
    const byDay = new Map()
    for (const run of runs ?? []) {
        const started = new Date(run.startedAt)
        if (Number.isNaN(started.getTime())) continue
        const key = dayKey(started)
        byDay.set(key, (byDay.get(key) ?? 0) + (run.collected ?? 0))
    }
    const out = []
    for (let i = days - 1; i >= 0; i--) {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
        const key = dayKey(date)
        out.push({ key, label: `${date.getDate()} ${MONTHS[date.getMonth()]}`, points: byDay.get(key) ?? 0 })
    }
    return out
}

export function totalsByAccount(runs) {
    const byEmail = new Map()
    for (const run of runs ?? []) {
        for (const account of run.accounts ?? []) {
            if (!account?.email) continue
            const entry = byEmail.get(account.email) ?? { email: account.email, points: 0, runs: 0, failures: 0 }
            entry.points += account.collected ?? 0
            entry.runs += 1
            if (account.success === false) entry.failures += 1
            byEmail.set(account.email, entry)
        }
    }
    return [...byEmail.values()].sort((a, b) => b.points - a.points)
}
