import test from 'node:test'
import assert from 'node:assert/strict'

import { parseLogLine, createRunState, applyLogToRunState, summarizeRunState } from './logParser.js'

const BASE = '[2026-08-05T10:00:00.000Z] [main] [INFO] MAIN [RUN-START] Starting Microsoft Rewards Script | v1.0.0 | Accounts: 3 | Clusters: 1'

function summarize(line) {
    const state = createRunState()
    applyLogToRunState(state, parseLogLine(line, 'stdout'))
    return summarizeRunState(state)
}

// The bot appends " | Pass: N" to RUN-START on automatic rerun passes. The
// parser matches this line by prefix, so the marker is only safe at the end -
// this test fails the moment someone moves it into the middle.
test('the rerun pass marker leaves RUN-START parseable', () => {
    const plain = summarize(BASE)
    assert.equal(plain.version, '1.0.0')
    assert.equal(plain.accountsTotal, 3)

    const withPass = summarize(`${BASE} | Pass: 2`)
    assert.equal(withPass.version, '1.0.0')
    assert.equal(withPass.accountsTotal, 3)
})
