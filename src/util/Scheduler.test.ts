import test from 'node:test'
import assert from 'node:assert/strict'

import { runScheduled } from './Scheduler'

const noWait = async (): Promise<void> => {}
const noJitter = (): number => 0

test('nunca supera maxConcurrent y procesa todos los ítems una vez', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i)
    const seen: number[] = []
    let active = 0
    let maxObserved = 0

    await runScheduled(
        items,
        async item => {
            active++
            maxObserved = Math.max(maxObserved, active)
            await Promise.resolve()
            seen.push(item as number)
            active--
        },
        { maxConcurrent: 3, shuffle: false, jitterMs: noJitter, wait: noWait }
    )

    assert.equal(maxObserved, 3, 'la concurrencia máxima observada debe ser 3')
    assert.equal(seen.length, 10, 'deben procesarse los 10 ítems')
    assert.deepEqual([...seen].sort((a, b) => a - b), items, 'cada ítem exactamente una vez')
})

test('rellena hasta agotar la cola aunque las tareas tarden distinto', async () => {
    const items = [0, 1, 2, 3, 4]
    const done: number[] = []

    await runScheduled(
        items,
        async item => {
            const n = item as number
            await new Promise<void>(r => setTimeout(r, n % 2 === 0 ? 5 : 1))
            done.push(n)
        },
        { maxConcurrent: 2, shuffle: false, jitterMs: noJitter, wait: noWait }
    )

    assert.equal(done.length, 5)
    assert.deepEqual([...done].sort((a, b) => a - b), items)
})

test('un fallo no detiene el pool y se reporta por onError', async () => {
    const items = [0, 1, 2]
    const done: number[] = []
    const errors: unknown[] = []

    await runScheduled(
        items,
        async item => {
            if (item === 1) throw new Error('boom')
            done.push(item as number)
        },
        {
            maxConcurrent: 2,
            shuffle: false,
            jitterMs: noJitter,
            wait: noWait,
            onError: (_item, error) => errors.push(error)
        }
    )

    assert.deepEqual([...done].sort((a, b) => a - b), [0, 2], 'las tareas sanas se completan')
    assert.equal(errors.length, 1, 'onError se invoca una vez')
})

test('jitterMs se invoca una vez por lanzamiento', async () => {
    const items = [0, 1, 2, 3]
    let jitterCalls = 0

    await runScheduled(items, async () => {}, {
        maxConcurrent: 2,
        shuffle: false,
        jitterMs: () => {
            jitterCalls++
            return 0
        },
        wait: noWait
    })

    assert.equal(jitterCalls, 4, 'una llamada a jitterMs por cada ítem lanzado')
})

test('shuffle usa shuffleArray inyectado sin perder ítems', async () => {
    const items = [1, 2, 3, 4, 5]
    const seen: number[] = []

    await runScheduled(
        items,
        async item => {
            seen.push(item as number)
        },
        {
            maxConcurrent: 5,
            shuffle: true,
            jitterMs: noJitter,
            wait: noWait,
            shuffleArray: <T>(a: T[]): T[] => [...a].reverse()
        }
    )

    assert.deepEqual([...seen].sort((a, b) => a - b), items, 'no se pierde ni duplica ningún ítem')
})
