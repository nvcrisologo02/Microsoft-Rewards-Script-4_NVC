import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { remapIndexes, remapExclusionsAfterDelete } from './scheduleStore.js'

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
