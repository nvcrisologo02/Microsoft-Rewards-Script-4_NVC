import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveStartSelection } from './startSelection.js'

const ACCOUNTS = [
    { index: 1, email: 'uno@example.com' },
    { index: 2, email: 'dos@example.com' }
]

function deps({ excludedAccountIndexes = [], scheduleError = null } = {}) {
    return {
        projectRoot: '/tmp/fake',
        readSchedule: () => {
            if (scheduleError) throw scheduleError
            return { excludedAccountIndexes, autoRerun: { enabled: true, delayMinutes: 5, maxPasses: 3 } }
        },
        buildSingleEnv: index => ({
            env: { SINGLE: String(index) },
            account: ACCOUNTS.find(a => a.index === index)
        }),
        buildExcludedEnv: list => {
            if (list.length >= ACCOUNTS.length) {
                throw Object.assign(new Error('A scheduled run cannot exclude every configured account.'), {
                    code: 'BAD_REQUEST'
                })
            }
            return {
                env: { EXCLUDED: list.join(',') },
                excludedAccounts: ACCOUNTS.filter(a => list.includes(a.index)),
                includedAccounts: ACCOUNTS.filter(a => !list.includes(a.index))
            }
        }
    }
}

test('an empty body applies the persisted pauses', () => {
    const result = resolveStartSelection({}, deps({ excludedAccountIndexes: [2] }))
    assert.equal(result.env.EXCLUDED, '2')
    assert.deepEqual(result.excludedAccounts, [{ index: 2, email: 'dos@example.com' }])
    assert.equal(result.selectedAccount, null)
})

test('an empty body with nothing paused adds no environment override', () => {
    const result = resolveStartSelection({}, deps())
    assert.deepEqual(result.env, {})
    assert.deepEqual(result.excludedAccounts, [])
})

test('an explicit empty exclusion list overrides the pauses', () => {
    const result = resolveStartSelection({ excludedAccountIndexes: [] }, deps({ excludedAccountIndexes: [2] }))
    assert.equal(result.env.EXCLUDED, '')
    assert.deepEqual(result.excludedAccounts, [])
})

test('an explicit accountIndex runs even a paused account', () => {
    const result = resolveStartSelection({ accountIndex: 2 }, deps({ excludedAccountIndexes: [2] }))
    assert.equal(result.env.SINGLE, '2')
    assert.deepEqual(result.selectedAccount, { index: 2, email: 'dos@example.com' })
})

test('accountIndex and excludedAccountIndexes together are rejected', () => {
    assert.throws(
        () => resolveStartSelection({ accountIndex: 1, excludedAccountIndexes: [2] }, deps()),
        err => err.code === 'BAD_REQUEST'
    )
})

test('pausing every account is reported as ALL_PAUSED, not a generic bad request', () => {
    assert.throws(
        () => resolveStartSelection({}, deps({ excludedAccountIndexes: [1, 2] })),
        err => err.code === 'ALL_PAUSED'
    )
})

test('a corrupt schedule refuses the implicit start instead of running paused accounts', () => {
    assert.throws(
        () =>
            resolveStartSelection(
                {},
                deps({ scheduleError: Object.assign(new Error('corrupt'), { code: 'CORRUPT_SCHEDULE' }) })
            ),
        err => err.code === 'CORRUPT_SCHEDULE'
    )
})

test('an explicit selection works even when the schedule is corrupt', () => {
    const result = resolveStartSelection(
        { accountIndex: 1 },
        deps({ scheduleError: Object.assign(new Error('corrupt'), { code: 'CORRUPT_SCHEDULE' }) })
    )
    assert.equal(result.env.SINGLE, '1')
})
