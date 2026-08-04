import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
    remapIndexes,
    remapExclusionsAfterDelete,
    readSchedule,
    writeSchedule,
    AUTO_RERUN_LIMITS
} from './scheduleStore.js'

test('remapIndexes drops the deleted index and shifts higher ones down', () => {
    assert.deepEqual(remapIndexes([2, 3, 5], 3), [2, 4])
    assert.deepEqual(remapIndexes([1, 2, 3, 5], 1), [1, 2, 4])
    assert.deepEqual(remapIndexes([2, 3, 5], 5), [2, 3])
})

test('remapExclusionsAfterDelete returns null when no schedule.json exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-sched-'))
    const prior = process.env.SCHEDULE_FILE
    process.env.SCHEDULE_FILE = path.join(dir, 'schedule.json')
    try {
        assert.equal(remapExclusionsAfterDelete(dir, 2), null)
    } finally {
        if (prior === undefined) delete process.env.SCHEDULE_FILE
        else process.env.SCHEDULE_FILE = prior
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('remapExclusionsAfterDelete rewrites the persisted file atomically, file-only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-sched-'))
    const file = path.join(dir, 'schedule.json')
    const prior = process.env.SCHEDULE_FILE
    process.env.SCHEDULE_FILE = file
    fs.writeFileSync(file, JSON.stringify({
        enabled: true,
        cron: '0 7 * * *',
        skipIfRunning: true,
        excludedAccountIndexes: [2, 3, 5],
        updatedAt: '2026-01-01T00:00:00.000Z'
    }, null, 2))
    try {
        const next = remapExclusionsAfterDelete(dir, 3)
        assert.deepEqual(next, [2, 4])
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
        assert.deepEqual(saved.excludedAccountIndexes, [2, 4])
        // Untouched fields survive the rewrite.
        assert.equal(saved.cron, '0 7 * * *')
        assert.equal(saved.enabled, true)
        const stray = fs.readdirSync(dir).filter(f => f.includes('.tmp'))
        assert.deepEqual(stray, [])
    } finally {
        if (prior === undefined) delete process.env.SCHEDULE_FILE
        else process.env.SCHEDULE_FILE = prior
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

function withTempSchedule(contents, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-autorerun-'))
    const file = path.join(dir, 'schedule.json')
    const prior = process.env.SCHEDULE_FILE
    process.env.SCHEDULE_FILE = file
    if (contents !== null) fs.writeFileSync(file, JSON.stringify(contents, null, 2))
    try {
        return fn(dir, file)
    } finally {
        if (prior === undefined) delete process.env.SCHEDULE_FILE
        else process.env.SCHEDULE_FILE = prior
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

test('readSchedule defaults autoRerun when no override file exists', () => {
    withTempSchedule(null, dir => {
        const prior = { ...process.env }
        delete process.env.AUTO_RERUN
        delete process.env.AUTO_RERUN_DELAY_MINUTES
        delete process.env.AUTO_RERUN_MAX_PASSES
        try {
            assert.deepEqual(readSchedule(dir).autoRerun, { enabled: true, delayMinutes: 5, maxPasses: 3 })
        } finally {
            process.env = prior
        }
    })
})

test('readSchedule takes autoRerun defaults from the environment', () => {
    withTempSchedule(null, dir => {
        const prior = { ...process.env }
        process.env.AUTO_RERUN = 'false'
        process.env.AUTO_RERUN_DELAY_MINUTES = '9'
        process.env.AUTO_RERUN_MAX_PASSES = '4'
        try {
            assert.deepEqual(readSchedule(dir).autoRerun, { enabled: false, delayMinutes: 9, maxPasses: 4 })
        } finally {
            process.env = prior
        }
    })
})

test('readSchedule prefers the persisted autoRerun override over the environment', () => {
    const saved = {
        enabled: false,
        cron: null,
        skipIfRunning: true,
        excludedAccountIndexes: [],
        autoRerun: { enabled: false, delayMinutes: 15, maxPasses: 2 }
    }
    withTempSchedule(saved, dir => {
        const prior = { ...process.env }
        process.env.AUTO_RERUN_DELAY_MINUTES = '5'
        try {
            assert.deepEqual(readSchedule(dir).autoRerun, { enabled: false, delayMinutes: 15, maxPasses: 2 })
        } finally {
            process.env = prior
        }
    })
})

test('readSchedule rejects an out-of-range autoRerun override', () => {
    const saved = {
        enabled: false,
        cron: null,
        skipIfRunning: true,
        excludedAccountIndexes: [],
        autoRerun: { enabled: true, delayMinutes: 0, maxPasses: 3 }
    }
    withTempSchedule(saved, dir => {
        assert.throws(() => readSchedule(dir), err => err.code === 'CORRUPT_SCHEDULE')
    })
})

test('writeSchedule merges a partial autoRerun patch over the current value', () => {
    withTempSchedule(null, dir => {
        const prior = { ...process.env }
        delete process.env.AUTO_RERUN
        delete process.env.AUTO_RERUN_DELAY_MINUTES
        delete process.env.AUTO_RERUN_MAX_PASSES
        try {
            const updated = writeSchedule(dir, { autoRerun: { delayMinutes: 10 } })
            assert.deepEqual(updated.autoRerun, { enabled: true, delayMinutes: 10, maxPasses: 3 })
            assert.deepEqual(readSchedule(dir).autoRerun, { enabled: true, delayMinutes: 10, maxPasses: 3 })
        } finally {
            process.env = prior
        }
    })
})

test('writeSchedule rejects an invalid autoRerun patch with BAD_REQUEST', () => {
    withTempSchedule(null, dir => {
        assert.throws(
            () => writeSchedule(dir, { autoRerun: { maxPasses: 99 } }),
            err => err.code === 'BAD_REQUEST'
        )
        assert.throws(
            () => writeSchedule(dir, { autoRerun: { enabled: 'yes' } }),
            err => err.code === 'BAD_REQUEST'
        )
    })
})

test('AUTO_RERUN_LIMITS documents the accepted ranges', () => {
    assert.deepEqual(AUTO_RERUN_LIMITS, {
        delayMinutes: { min: 1, max: 120 },
        maxPasses: { min: 1, max: 10 }
    })
})
