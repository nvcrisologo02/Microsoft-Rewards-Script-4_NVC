import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { appendRun, historyFilePath, readRuns } from './historyStore.js'

function makeRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-hist-'))
}

function record(startedAt, collected) {
    return {
        startedAt,
        endedAt: startedAt,
        exit: { code: 0, signal: null, at: startedAt },
        version: '4.0.3',
        collected,
        accounts: [{ email: 'a@x.com', collected, success: true, error: null, streakProtection: null }]
    }
}

test('append creates data dir and file, read returns newest first', () => {
    const root = makeRoot()
    try {
        assert.equal(appendRun(root, record('2026-07-01T07:00:00.000Z', 100)), true)
        assert.equal(appendRun(root, record('2026-07-02T07:00:00.000Z', 200)), true)
        const { runs, total } = readRuns(root)
        assert.equal(total, 2)
        assert.equal(runs[0].collected, 200)
        assert.equal(runs[1].collected, 100)
        assert.equal(fs.existsSync(historyFilePath(root)), true)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('duplicate startedAt against the last line is skipped', () => {
    const root = makeRoot()
    try {
        appendRun(root, record('2026-07-01T07:00:00.000Z', 100))
        assert.equal(appendRun(root, record('2026-07-01T07:00:00.000Z', 100)), false)
        assert.equal(readRuns(root).total, 1)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('corrupt lines are skipped without crashing', () => {
    const root = makeRoot()
    try {
        appendRun(root, record('2026-07-01T07:00:00.000Z', 100))
        fs.appendFileSync(historyFilePath(root), 'NOT-JSON{{{\n')
        appendRun(root, record('2026-07-02T07:00:00.000Z', 200))
        const { runs, total } = readRuns(root)
        assert.equal(total, 2)
        assert.equal(runs[0].collected, 200)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('limit and offset paginate newest-first', () => {
    const root = makeRoot()
    try {
        for (let i = 1; i <= 5; i++) appendRun(root, record(`2026-07-0${i}T07:00:00.000Z`, i * 10))
        const page = readRuns(root, { limit: 2, offset: 1 })
        assert.equal(page.total, 5)
        assert.deepEqual(page.runs.map(r => r.collected), [40, 30])
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('missing file reads empty', () => {
    const root = makeRoot()
    try {
        assert.deepEqual(readRuns(root), { runs: [], total: 0 })
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('HISTORY_FILE env override redirects all operations', () => {
    const root = makeRoot()
    const override = path.join(root, 'elsewhere', 'runs.ndjson')
    process.env.HISTORY_FILE = override
    try {
        assert.equal(historyFilePath(root), path.resolve(override))
        appendRun(root, record('2026-07-01T07:00:00.000Z', 100))
        assert.equal(fs.existsSync(override), true)
        assert.equal(fs.existsSync(path.join(root, 'data', 'history.ndjson')), false)
        assert.equal(readRuns(root).total, 1)
    } finally {
        delete process.env.HISTORY_FILE
        fs.rmSync(root, { recursive: true, force: true })
    }
})
