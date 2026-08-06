import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { decideNextPass, RerunController } from './rerunController.js'

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

class FakePm extends EventEmitter {
    constructor() {
        super()
        this.starts = []
        this.notes = []
        this.startError = null
    }
    start(overrides) {
        if (this.startError) throw this.startError
        this.starts.push(overrides)
        return { pid: 1234 }
    }
    note(level, message) {
        this.notes.push({ level, message })
    }
}

function makeHarness({ schedule, accounts = KNOWN, scheduleError = null } = {}) {
    const pm = new FakePm()
    const timers = []
    const controller = new RerunController({
        pm,
        projectRoot: '/tmp/fake',
        readSchedule: () => {
            if (scheduleError) throw scheduleError
            return {
                excludedAccountIndexes: [],
                autoRerun: AUTO_RERUN,
                ...schedule
            }
        },
        loadAccounts: () => accounts,
        buildExcludedEnv: excluded => ({
            env: { EXCLUDED: excluded.join(',') },
            includedAccounts: accounts.filter(a => !excluded.includes(a.index)),
            excludedAccounts: accounts.filter(a => excluded.includes(a.index))
        }),
        setTimer: (fn, ms) => {
            const handle = { fn, ms, cleared: false }
            timers.push(handle)
            return handle
        },
        clearTimer: handle => {
            if (handle) handle.cleared = true
        }
    }).attach()
    return { pm, controller, timers, fire: () => timers.at(-1).fn() }
}

function completion(runAccounts) {
    return { startedAt: 'x', endedAt: 'y', exit: { code: 0 }, run: { accounts: runAccounts } }
}

test('a completed run with pending accounts schedules the next pass', () => {
    const { pm, controller, timers } = makeHarness()
    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))

    assert.equal(timers.length, 1)
    assert.equal(timers[0].ms, 5 * 60_000)
    assert.equal(controller.getState().pending, true)
    assert.deepEqual(controller.getState().accountIndexes, [1])
    assert.equal(pm.starts.length, 0, 'must not start before the cooldown elapses')
})

test('firing the timer starts the next pass with the other accounts excluded', () => {
    const { pm, fire } = makeHarness()
    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))
    fire()

    assert.equal(pm.starts.length, 1)
    assert.equal(pm.starts[0].env.EXCLUDED, '2,3')
    assert.equal(pm.starts[0].env.RERUN_PASS, '2')
})

test('the pass counter advances and stops at maxPasses', () => {
    const { pm, controller, fire } = makeHarness()
    const gained = completion([acc('uno@example.com', { collectedPoints: 30 })])

    pm.emit('run-complete', gained)
    fire()
    assert.equal(pm.starts[0].env.RERUN_PASS, '2')

    pm.emit('run-complete', gained)
    fire()
    assert.equal(pm.starts[1].env.RERUN_PASS, '3')

    pm.emit('run-complete', gained)
    assert.equal(pm.starts.length, 2, 'maxPasses of 3 allows no fourth pass')
    assert.equal(controller.getState().pending, false)
})

test('a run killed by a signal is treated as stopped, not as a candidate', () => {
    const { pm, controller, timers } = makeHarness()
    pm.emit('run-complete', {
        exit: { code: null, signal: 'SIGTERM' },
        run: { accounts: [acc('uno@example.com', { collectedPoints: 30 })] }
    })

    assert.equal(timers.length, 0)
    assert.equal(controller.getState().pending, false)
})

test('noteExternalStart resets the chain and clears any pending timer', () => {
    const { pm, controller, timers } = makeHarness()
    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))
    assert.equal(controller.getState().pending, true)

    controller.noteExternalStart()

    assert.equal(timers[0].cleared, true)
    assert.equal(controller.getState().pending, false)
    assert.equal(controller.getState().pass, 1)
})

test('cancel stops the chain so the completing run schedules nothing', () => {
    const { pm, controller, timers } = makeHarness()
    controller.cancel('stopped by user')
    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))

    assert.equal(timers.length, 0)
    assert.equal(controller.getState().pending, false)
})

test('a corrupt schedule cancels the chain rather than running paused accounts', () => {
    const { pm, controller, timers } = makeHarness({
        scheduleError: Object.assign(new Error('schedule.json is corrupt'), { code: 'CORRUPT_SCHEDULE' })
    })
    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))

    assert.equal(timers.length, 0)
    assert.equal(controller.getState().pending, false)
    assert.match(pm.notes.at(-1).message, /corrupt/i)
})

test('an ALREADY_RUNNING start abandons the chain without throwing', () => {
    const { pm, controller, fire } = makeHarness()
    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))
    pm.startError = Object.assign(new Error('Cannot start: a run is already running.'), { code: 'ALREADY_RUNNING' })

    assert.doesNotThrow(() => fire())
    assert.equal(controller.getState().pending, false)
})

test('change events fire when a pass is scheduled and when it is cancelled', () => {
    const { pm, controller } = makeHarness()
    let changes = 0
    controller.on('change', () => changes++)

    pm.emit('run-complete', completion([acc('uno@example.com', { collectedPoints: 30 })]))
    assert.equal(changes, 1)

    controller.noteExternalStart()
    assert.equal(changes, 2)
})

test('the schedule is re-read at fire time so a mid-cooldown pause takes effect', () => {
    const pm = new FakePm()
    const timers = []
    let excluded = []
    new RerunController({
        pm,
        projectRoot: '/tmp/fake',
        readSchedule: () => ({ excludedAccountIndexes: excluded, autoRerun: AUTO_RERUN }),
        loadAccounts: () => KNOWN,
        buildExcludedEnv: list => ({ env: { EXCLUDED: list.join(',') }, includedAccounts: [], excludedAccounts: [] }),
        setTimer: (fn, ms) => {
            const handle = { fn, ms }
            timers.push(handle)
            return handle
        },
        clearTimer: () => {}
    }).attach()

    pm.emit(
        'run-complete',
        completion([acc('uno@example.com', { collectedPoints: 30 }), acc('dos@example.com', { collectedPoints: 30 })])
    )
    excluded = [1]
    timers.at(-1).fn()

    assert.equal(pm.starts[0].env.EXCLUDED, '1,3', 'account 1 was paused during the cooldown')
})

const CHAIN_START = {
    startedAt: '2026-08-05T05:49:00.000Z',
    endedAt: '2026-08-05T09:54:00.000Z',
    exit: { code: 0 },
    run: { accounts: [acc('uno@example.com', { collectedPoints: 30 })] }
}

test('la primera pasada fija el chainId a su propio startedAt', () => {
    const { pm, controller } = makeHarness()
    pm.emit('run-complete', CHAIN_START)
    assert.equal(controller.getState().chainId, '2026-08-05T05:49:00.000Z')
})

test('las pasadas siguientes heredan el chainId de la primera', () => {
    const { pm, controller, fire } = makeHarness()
    pm.emit('run-complete', CHAIN_START)
    fire()
    pm.emit('run-complete', {
        startedAt: '2026-08-05T09:59:00.000Z',
        endedAt: '2026-08-05T10:24:00.000Z',
        exit: { code: 0 },
        run: { accounts: [acc('uno@example.com', { collectedPoints: 20 })] }
    })
    assert.equal(controller.getState().chainId, '2026-08-05T05:49:00.000Z')
    assert.equal(controller.getState().pass, 2)
})

test('noteExternalStart estrena cadena', () => {
    const { pm, controller } = makeHarness()
    pm.emit('run-complete', CHAIN_START)
    assert.equal(controller.getState().chainId, '2026-08-05T05:49:00.000Z')

    controller.noteExternalStart()
    assert.equal(controller.getState().chainId, null)
    assert.equal(controller.getState().pass, 1)
})
