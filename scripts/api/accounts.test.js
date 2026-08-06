import test from 'node:test'
import assert from 'node:assert/strict'

import { mergeAccountStats } from './accounts.js'

const ACCOUNTS = [{ index: 1, email: 'uno@example.com', emailKey: 'uno@example.com' }]

/** Newest-first, the order combineRuns hands to mergeAccountStats. */
function run(startedAt, { chainId, pass, collected, balance, success = true, streak } = {}) {
    return {
        startedAt,
        endedAt: startedAt,
        ...(chainId !== undefined ? { chainId } : {}),
        ...(pass !== undefined ? { pass } : {}),
        accounts: [
            {
                email: 'uno@example.com',
                collected,
                balance,
                success,
                error: null,
                streakProtection: streak === undefined ? null : streak
            }
        ]
    }
}

test('las pasadas de una cadena se agregan en un solo run', () => {
    const runs = [
        run('2026-08-05T10:30:00Z', { chainId: 'C1', pass: 3, collected: 0, balance: 120 }),
        run('2026-08-05T09:59:00Z', { chainId: 'C1', pass: 2, collected: 20, balance: 120 }),
        run('2026-08-05T05:49:00Z', { chainId: 'C1', pass: 1, collected: 30, balance: 100 })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.runs, 1, 'una cadena es un run')
    assert.equal(a.lastCollected, 50, 'suma de las tres pasadas')
    assert.equal(a.totalCollected, 50)
})

test('el balance de la cadena es el ultimo valor no nulo', () => {
    const runs = [
        run('2026-08-05T10:30:00Z', { chainId: 'C1', pass: 3, collected: 0, balance: null }),
        run('2026-08-05T09:59:00Z', { chainId: 'C1', pass: 2, collected: 20, balance: 120 })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.lastBalance, 120)
})

test('los registros antiguos sin chainId son cada uno su propia cadena', () => {
    const runs = [
        run('2026-08-04T05:49:00Z', { collected: 40, balance: 90 }),
        run('2026-08-03T05:49:00Z', { collected: 35, balance: 50 })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.runs, 2)
    assert.equal(a.lastCollected, 40)
    assert.equal(a.totalCollected, 75)
})

test('registros con y sin chainId conviven', () => {
    const runs = [
        run('2026-08-05T09:59:00Z', { chainId: 'C1', pass: 2, collected: 20, balance: 120 }),
        run('2026-08-05T05:49:00Z', { chainId: 'C1', pass: 1, collected: 30, balance: 100 }),
        run('2026-08-04T05:49:00Z', { collected: 40, balance: 70 })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.runs, 2, 'una cadena de dos pasadas mas un registro antiguo')
    assert.equal(a.lastCollected, 50)
    assert.equal(a.totalCollected, 90)
})

test('el exito de la cadena es el de su ultima pasada', () => {
    const runs = [
        run('2026-08-05T09:59:00Z', { chainId: 'C1', pass: 2, collected: 0, balance: 120, success: false }),
        run('2026-08-05T05:49:00Z', { chainId: 'C1', pass: 1, collected: 30, balance: 100, success: true })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.lastSuccess, false)
})

test('el contador de racha sobrevive a registros que lo traen a null', () => {
    const withCounter = { enabled: true, remainingDays: 2, streakCounter: 21, updatedAt: null }
    const withoutCounter = { enabled: true, remainingDays: 2, streakCounter: null, updatedAt: null }
    const runs = [
        run('2026-08-05T09:59:00Z', { chainId: 'C1', pass: 2, collected: 0, balance: 120, streak: withoutCounter }),
        run('2026-08-05T05:49:00Z', { chainId: 'C1', pass: 1, collected: 30, balance: 100, streak: withoutCounter }),
        run('2026-08-04T05:49:00Z', { collected: 40, balance: 70, streak: withCounter })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.streakCounter, 21, 'retrocede hasta el registro que si lo tiene')
    assert.equal(a.streakProtection.remainingDays, 2)
})

test('sin ningun contador en el historial, streakCounter queda a null', () => {
    const runs = [run('2026-08-05T05:49:00Z', { collected: 10, balance: 20 })]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.streakCounter, null)
    assert.equal(a.streakProtection, null)
})

test('successStreak cuenta cadenas consecutivas correctas', () => {
    const runs = [
        run('2026-08-05T09:59:00Z', { chainId: 'C1', pass: 2, collected: 0, balance: 120 }),
        run('2026-08-05T05:49:00Z', { chainId: 'C1', pass: 1, collected: 30, balance: 100 }),
        run('2026-08-04T05:49:00Z', { chainId: 'C0', pass: 1, collected: 40, balance: 70, success: false })
    ]
    const [a] = mergeAccountStats(ACCOUNTS, runs)
    assert.equal(a.successStreak, 1, 'la cadena de ayer fallo y corta la racha')
})

test('no expone la clave interna emailKey', () => {
    const [a] = mergeAccountStats(ACCOUNTS, [run('2026-08-05T05:49:00Z', { collected: 10, balance: 20 })])
    assert.equal('emailKey' in a, false)
})
