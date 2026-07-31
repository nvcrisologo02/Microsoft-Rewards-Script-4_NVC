import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SearchQueryLedger } from './SearchQueryLedger'

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'))
}

test('load() returns empty set when directory does not exist', () => {
    const ledger = new SearchQueryLedger(path.join(tmpDir(), 'missing'))
    assert.strictEqual(ledger.load().size, 0)
})

test('record() then load() round-trips normalized queries', () => {
    const ledger = new SearchQueryLedger(tmpDir())
    ledger.record('  Real  Madrid ')
    ledger.record('elecciones España')
    const seen = ledger.load()
    assert.strictEqual(seen.size, 2)
    assert.ok(seen.has('real madrid'))
    assert.ok(seen.has('elecciones españa'))
})

test('record() ignores empty queries', () => {
    const ledger = new SearchQueryLedger(tmpDir())
    ledger.record('   ')
    assert.strictEqual(ledger.load().size, 0)
})

test('two ledger instances share the same file (cross-account view)', () => {
    const dir = tmpDir()
    const a = new SearchQueryLedger(dir)
    const b = new SearchQueryLedger(dir)
    a.record('quijote')
    assert.ok(b.load().has('quijote'))
})

test('cleanup() removes files older than maxAgeDays and keeps today', () => {
    const dir = tmpDir()
    const ledger = new SearchQueryLedger(dir)
    ledger.record('hoy')
    fs.writeFileSync(path.join(dir, '2020-01-01.ndjson'), 'viejo\n', 'utf-8')
    ledger.cleanup(7)
    assert.ok(!fs.existsSync(path.join(dir, '2020-01-01.ndjson')))
    assert.ok(ledger.load().has('hoy'))
})

test('cleanup() on missing directory does not throw', () => {
    const ledger = new SearchQueryLedger(path.join(tmpDir(), 'missing'))
    assert.doesNotThrow(() => ledger.cleanup())
})
