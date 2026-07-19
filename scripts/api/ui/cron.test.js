import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCron, nextRuns } from './cron.js'

// Wed 2026-07-15 12:00:00 local time
const FROM = new Date(2026, 6, 15, 12, 0, 0)

test('parseCron accepts numeric fields and rejects junk', () => {
    assert.notEqual(parseCron('0 7 * * *'), null)
    assert.notEqual(parseCron('*/15 2-4 1,15 * 1-5'), null)
    assert.equal(parseCron('@daily'), null)
    assert.equal(parseCron('0 7 * *'), null)
    assert.equal(parseCron('61 7 * * *'), null)
    assert.equal(parseCron('0 7 * * MON'), null)
})

test('daily at 07:00 → next is tomorrow 07:00 when asked after 07:00', () => {
    const runs = nextRuns('0 7 * * *', FROM, 3)
    assert.equal(runs.length, 3)
    assert.deepEqual(
        runs.map(d => [d.getDate(), d.getHours(), d.getMinutes()]),
        [[16, 7, 0], [17, 7, 0], [18, 7, 0]]
    )
})

test('twice daily 07:00/19:00 from noon → 19:00 today first', () => {
    const runs = nextRuns('0 7,19 * * *', FROM, 2)
    assert.deepEqual(runs.map(d => [d.getDate(), d.getHours()]), [[15, 19], [16, 7]])
})

test('weekdays only skips the weekend', () => {
    // FROM is Wednesday; ask for 4 → Thu, Fri, Mon, Tue
    const runs = nextRuns('0 7 * * 1-5', FROM, 4)
    assert.deepEqual(runs.map(d => d.getDay()), [4, 5, 1, 2])
})

test('step minutes */15', () => {
    const runs = nextRuns('*/15 * * * *', FROM, 2)
    assert.deepEqual(runs.map(d => d.getMinutes()), [15, 30])
})

test('dow 7 is treated as Sunday', () => {
    const runs = nextRuns('0 7 * * 7', FROM, 1)
    assert.equal(runs[0].getDay(), 0)
})

test('invalid expression → empty', () => {
    assert.deepEqual(nextRuns('nope', FROM, 5), [])
})

test('dom and dow both restricted → standard OR semantics', () => {
    // FROM is Wed 2026-07-15. '0 7 20 * 1' fires on every Monday AND on the 20th.
    // First 3 matches: Jul 20 (20th + Monday), Jul 27 (Monday), Aug 3 (Monday)
    const runs = nextRuns('0 7 20 * 1', FROM, 3)
    assert.deepEqual(
        runs.map(d => [d.getDate(), d.getDay()]),
        [[20, 1], [27, 1], [3, 1]]
    )

    // The 20th of August 2026 is a Thursday — reachable only via the dom half of OR.
    // First 3 matches after FROM for '0 7 20 8 1': Aug 3 (Monday), Aug 10 (Monday), Aug 17 (Monday)
    // This test would fail if AND-only semantics were used (since Aug 20 is Thursday, not Monday)
    const orOnly = nextRuns('0 7 20 8 1', FROM, 1)
    assert.deepEqual([orOnly[0].getDate(), orOnly[0].getMonth()], [3, 7])
})
