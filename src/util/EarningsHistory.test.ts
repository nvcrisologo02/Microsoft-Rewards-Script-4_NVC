import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EarningsHistory } from './EarningsHistory'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'earnings-test-'))

test('zeroStreak es 0 sin historial', () => {
    assert.equal(new EarningsHistory(tmpDir()).zeroStreak('a@b.com'), 0)
})

test('cuenta ejecuciones consecutivas a cero', () => {
    const h = new EarningsHistory(tmpDir())
    h.record('a@b.com', 0)
    h.record('a@b.com', 0)
    assert.equal(h.zeroStreak('a@b.com'), 2)
})

test('una ejecución con puntos rompe la racha', () => {
    const h = new EarningsHistory(tmpDir())
    h.record('a@b.com', 0)
    h.record('a@b.com', 30)
    h.record('a@b.com', 0)
    assert.equal(h.zeroStreak('a@b.com'), 1)
})

test('las cuentas no se mezclan', () => {
    const h = new EarningsHistory(tmpDir())
    h.record('a@b.com', 0)
    h.record('c@d.com', 50)
    assert.equal(h.zeroStreak('a@b.com'), 1)
    assert.equal(h.zeroStreak('c@d.com'), 0)
})

test('un directorio no escribible no lanza', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'collide')
    fs.writeFileSync(file, 'x', 'utf-8')
    const h = new EarningsHistory(file)
    assert.doesNotThrow(() => h.record('a@b.com', 0))
    assert.equal(h.zeroStreak('a@b.com'), 0)
})
