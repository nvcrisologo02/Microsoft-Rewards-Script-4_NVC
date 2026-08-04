import test from 'node:test'
import assert from 'node:assert/strict'

import { decideNextPass } from './rerunController.js'

const KNOWN = [
    { index: 1, email: 'uno@example.com' },
    { index: 2, email: 'dos@example.com' },
    { index: 3, email: 'tres@example.com' }
]

const AUTO_RERUN = { enabled: true, delayMinutes: 5, maxPasses: 3 }

function acc(email, patch = {}) {
    return { email, collectedPoints: 0, success: true, error: null, live: { gained: 0 }, ...patch }
}

function decide(patch = {}) {
    return decideNextPass({
        runAccounts: [],
        knownAccounts: KNOWN,
        excludedAccountIndexes: [],
        autoRerun: AUTO_RERUN,
        pass: 1,
        cancelled: false,
        ...patch
    })
}

test('no rerun when every account finished with zero points', () => {
    const result = decide({ runAccounts: [acc('uno@example.com'), acc('dos@example.com')] })
    assert.equal(result.shouldRerun, false)
    assert.equal(result.reason, 'nothing-pending')
    assert.deepEqual(result.accountIndexes, [])
})

test('only the accounts that gained points go into the next pass', () => {
    const result = decide({
        runAccounts: [
            acc('uno@example.com', { collectedPoints: 30 }),
            acc('dos@example.com'),
            acc('tres@example.com', { collectedPoints: 5 })
        ]
    })
    assert.equal(result.shouldRerun, true)
    assert.equal(result.reason, 'pending')
    assert.deepEqual(result.accountIndexes, [1, 3])
    assert.equal(result.delayMs, 5 * 60_000)
})

test('an account that failed with zero points is still retried', () => {
    const result = decide({
        runAccounts: [acc('dos@example.com', { success: false, error: 'Flow failed' })]
    })
    assert.equal(result.shouldRerun, true)
    assert.deepEqual(result.accountIndexes, [2])
})

test('live.gained counts when the ACCOUNT-END line never arrived', () => {
    const result = decide({
        runAccounts: [
            { email: 'uno@example.com', collectedPoints: null, success: null, error: null, live: { gained: 12 } }
        ]
    })
    assert.equal(result.shouldRerun, true)
    assert.deepEqual(result.accountIndexes, [1])
})

test('a paused account never enters a rerun, even after gaining points', () => {
    const result = decide({
        runAccounts: [acc('uno@example.com', { collectedPoints: 30 }), acc('dos@example.com', { collectedPoints: 10 })],
        excludedAccountIndexes: [1]
    })
    assert.equal(result.shouldRerun, true)
    assert.deepEqual(result.accountIndexes, [2])
})

test('no rerun once the pass count reaches maxPasses', () => {
    const runAccounts = [acc('uno@example.com', { collectedPoints: 30 })]
    assert.equal(decide({ runAccounts, pass: 2 }).shouldRerun, true)
    const capped = decide({ runAccounts, pass: 3 })
    assert.equal(capped.shouldRerun, false)
    assert.equal(capped.reason, 'max-passes')
})

test('maxPasses of 1 disables reruns outright', () => {
    const result = decide({
        runAccounts: [acc('uno@example.com', { collectedPoints: 30 })],
        autoRerun: { ...AUTO_RERUN, maxPasses: 1 }
    })
    assert.equal(result.shouldRerun, false)
    assert.equal(result.reason, 'max-passes')
})

test('a run stopped by the user does not trigger a rerun', () => {
    const result = decide({
        runAccounts: [acc('uno@example.com', { collectedPoints: 30 })],
        cancelled: true
    })
    assert.equal(result.shouldRerun, false)
    assert.equal(result.reason, 'stopped')
})

test('autoRerun.enabled false disables reruns', () => {
    const result = decide({
        runAccounts: [acc('uno@example.com', { collectedPoints: 30 })],
        autoRerun: { ...AUTO_RERUN, enabled: false }
    })
    assert.equal(result.shouldRerun, false)
    assert.equal(result.reason, 'disabled')
})

test('accounts are matched by email regardless of case, and unknown emails are dropped', () => {
    const result = decide({
        runAccounts: [
            acc('UNO@Example.com', { collectedPoints: 30 }),
            acc('fantasma@example.com', { collectedPoints: 30 })
        ]
    })
    assert.deepEqual(result.accountIndexes, [1])
})

test('the delay follows autoRerun.delayMinutes', () => {
    const result = decide({
        runAccounts: [acc('uno@example.com', { collectedPoints: 30 })],
        autoRerun: { ...AUTO_RERUN, delayMinutes: 12 }
    })
    assert.equal(result.delayMs, 12 * 60_000)
})
