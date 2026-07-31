import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import path from 'path'
import { validateConfig } from './Validator'

function loadRawConfig(): Record<string, unknown> {
    const file = path.join(__dirname, '../../config.json')
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

test('activities.quiz defaults to true when absent', () => {
    const raw = loadRawConfig()
    delete (raw.activities as Record<string, unknown>).quiz
    const config = validateConfig(raw)
    assert.strictEqual(config.activities.quiz, true)
})

test('activities.quiz=false is respected', () => {
    const raw = loadRawConfig()
    ;(raw.activities as Record<string, unknown>).quiz = false
    const config = validateConfig(raw)
    assert.strictEqual(config.activities.quiz, false)
})

test('searchSettings.crossAccountQueryDedup defaults to true when absent', () => {
    const raw = loadRawConfig()
    delete (raw.searchSettings as Record<string, unknown>).crossAccountQueryDedup
    const config = validateConfig(raw)
    assert.strictEqual(config.searchSettings.crossAccountQueryDedup, true)
})
