import test from 'node:test'
import assert from 'node:assert/strict'

import { combineRuns } from './historyStore.js'

function run(startedAt, collected) {
    return {
        startedAt,
        endedAt: startedAt,
        collected,
        accounts: [{ email: 'a@x.com', collected, balance: 100, success: true, error: null, streakProtection: null }]
    }
}

test('memoria vacía → devuelve los runs persistidos (sobrevive un reinicio)', () => {
    const persisted = [run('2026-07-02T07:00:00.000Z', 200), run('2026-07-01T07:00:00.000Z', 100)]
    const combined = combineRuns([], persisted)
    assert.equal(combined.length, 2)
    assert.equal(combined[0].collected, 200)
})

test('runs solapados (mismo startedAt) no se duplican y gana la versión en memoria', () => {
    const shared = '2026-07-02T07:00:00.000Z'
    const memory = [{ ...run(shared, 200), fromMemory: true }]
    const persisted = [run(shared, 200), run('2026-07-01T07:00:00.000Z', 100)]
    const combined = combineRuns(memory, persisted)
    assert.equal(combined.length, 2)
    assert.equal(combined[0].fromMemory, true)
})

test('orden más reciente primero aunque las fuentes vengan intercaladas', () => {
    const memory = [run('2026-07-02T07:00:00.000Z', 200)]
    const persisted = [run('2026-07-03T07:00:00.000Z', 300), run('2026-07-01T07:00:00.000Z', 100)]
    const combined = combineRuns(memory, persisted)
    assert.deepEqual(
        combined.map(r => r.collected),
        [300, 200, 100]
    )
})

test('entradas sin startedAt válido se ignoran', () => {
    const combined = combineRuns([{ collected: 1 }], [run('2026-07-01T07:00:00.000Z', 100), null])
    assert.equal(combined.length, 1)
    assert.equal(combined[0].collected, 100)
})
