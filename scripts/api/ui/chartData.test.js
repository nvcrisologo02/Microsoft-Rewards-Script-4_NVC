// Pin a non-UTC zone so local-day bucketing regressions fail everywhere.
process.env.TZ = 'Europe/Madrid'

import test from 'node:test'
import assert from 'node:assert/strict'

import { aggregateDaily, totalsByAccount } from './chartData.js'

const NOW = new Date(2026, 6, 19, 12, 0, 0) // Sun 19 Jul 2026 local

function run(startedAtLocal, collected, accounts) {
    return { startedAt: startedAtLocal.toISOString(), collected, accounts }
}

test('aggregateDaily zero-fills and sums by local day, oldest first', () => {
    const runs = [
        run(new Date(2026, 6, 18, 7, 0), 100),
        run(new Date(2026, 6, 18, 19, 0), 50),
        run(new Date(2026, 6, 19, 7, 0), 200)
    ]
    const days = aggregateDaily(runs, 3, NOW)
    assert.equal(days.length, 3)
    assert.deepEqual(days.map(d => d.points), [0, 150, 200])
    assert.equal(days[2].key, '2026-07-19')
})

test('aggregateDaily ignores runs outside the window', () => {
    const runs = [run(new Date(2026, 5, 1, 7, 0), 999), run(new Date(2026, 6, 19, 7, 0), 10)]
    const days = aggregateDaily(runs, 7, NOW)
    assert.equal(days.reduce((a, d) => a + d.points, 0), 10)
})

test('totalsByAccount sums, counts runs and failures, sorts desc', () => {
    const runs = [
        run(new Date(2026, 6, 18, 7, 0), 0, [
            { email: 'a@x.com', collected: 100, success: true },
            { email: 'b@x.com', collected: 300, success: true }
        ]),
        run(new Date(2026, 6, 19, 7, 0), 0, [
            { email: 'a@x.com', collected: 50, success: false }
        ])
    ]
    const totals = totalsByAccount(runs)
    assert.deepEqual(totals[0], { email: 'b@x.com', points: 300, runs: 1, failures: 0 })
    assert.deepEqual(totals[1], { email: 'a@x.com', points: 150, runs: 2, failures: 1 })
})

test('empty input → empty outputs', () => {
    assert.deepEqual(totalsByAccount([]), [])
    assert.equal(aggregateDaily([], 5, NOW).length, 5)
})

test('runs near UTC midnight bucket into the LOCAL day', () => {
    // 22:30 UTC on Jul 17 is 00:30 LOCAL Jul 18 in Europe/Madrid (UTC+2 in summer).
    const runs = [{ startedAt: '2026-07-17T22:30:00.000Z', collected: 42, accounts: [] }]
    const days = aggregateDaily(runs, 3, NOW)
    const jul18 = days.find(d => d.key === '2026-07-18')
    assert.equal(jul18.points, 42)
    assert.equal(days.find(d => d.key === '2026-07-17')?.points ?? 0, 0)
})
