import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
    AccountEditorError,
    readEnvAccounts,
    accountDetail,
    upsertAccount,
    deleteAccount,
    refreshProcessEnv
} from './accountEditor.js'

function makeEnv(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-env-'))
    const envPath = path.join(dir, '.env')
    if (content !== null) fs.writeFileSync(envPath, content)
    return { dir, envPath }
}

const SAMPLE = [
    '# Account Credentials',
    'API_PORT=3010',
    '',
    '# Account 1',
    'ACCOUNT_1_EMAIL=a@example.com',
    'ACCOUNT_1_PASSWORD=secret-a',
    'ACCOUNT_1_GEO_LOCALE=ES',
    '#ACCOUNT_1_TOTP_SECRET=',
    '',
    'ACCOUNT_2_EMAIL=b@example.com',
    'ACCOUNT_2_PASSWORD=secret-b',
    'ACCOUNT_2_CUSTOM_FLAG=yes',
    '',
    'TRAILING=1'
].join('\n')

test('readEnvAccounts parses active lines, ignores comments', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        const { accounts } = readEnvAccounts(envPath)
        assert.equal(accounts.length, 2)
        assert.equal(accounts[0].fields.EMAIL, 'a@example.com')
        assert.equal(accounts[0].fields.TOTP_SECRET, undefined)
        assert.equal(accounts[1].fields.CUSTOM_FLAG, 'yes')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('accountDetail exposes flags but never secrets', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        const d = accountDetail(envPath, 1)
        assert.equal(d.email, 'a@example.com')
        assert.equal(d.hasPassword, true)
        assert.equal(d.hasTotp, false)
        assert.equal(JSON.stringify(d).includes('secret-a'), false)
        assert.equal(accountDetail(envPath, 9), null)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('create appends a new dense slot and preserves other lines', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        const { index } = upsertAccount(envPath, null, { email: 'c@example.com', password: 'secret-c' })
        assert.equal(index, 3)
        const text = fs.readFileSync(envPath, 'utf8')
        assert.match(text, /ACCOUNT_3_EMAIL=c@example\.com/)
        assert.match(text, /API_PORT=3010/)
        assert.match(text, /TRAILING=1/)
        assert.match(text, /#ACCOUNT_1_TOTP_SECRET=/)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('edit with omitted secret keeps the old password', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        upsertAccount(envPath, 1, { email: 'a2@example.com', password: '' })
        const { accounts } = readEnvAccounts(envPath)
        assert.equal(accounts[0].fields.EMAIL, 'a2@example.com')
        assert.equal(accounts[0].fields.PASSWORD, 'secret-a')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('delete renumbers densely and preserves unknown suffixes', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        deleteAccount(envPath, 1)
        const { accounts } = readEnvAccounts(envPath)
        assert.equal(accounts.length, 1)
        assert.equal(accounts[0].index, 1)
        assert.equal(accounts[0].fields.EMAIL, 'b@example.com')
        assert.equal(accounts[0].fields.CUSTOM_FLAG, 'yes')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('writes create a .bak backup and no stray temp files', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        upsertAccount(envPath, null, { email: 'c@example.com', password: 'x' })
        assert.equal(fs.existsSync(envPath + '.bak'), true)
        const stray = fs.readdirSync(dir).filter(f => f.includes('.tmp'))
        assert.deepEqual(stray, [])
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('rejects newline injection and missing create fields', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        assert.throws(() => upsertAccount(envPath, null, { email: 'x@example.com', password: 'a\nINJECTED=1' }), AccountEditorError)
        assert.throws(() => upsertAccount(envPath, null, { email: 'no-password@example.com' }), AccountEditorError)
        assert.throws(() => upsertAccount(envPath, null, { email: 'not-an-email', password: 'x' }), AccountEditorError)
        assert.throws(() => upsertAccount(envPath, 9, { email: 'x@example.com' }), AccountEditorError)
        assert.throws(() => deleteAccount(envPath, 9), AccountEditorError)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('refreshProcessEnv replaces stale ACCOUNT_* keys', () => {
    const { dir, envPath } = makeEnv(SAMPLE)
    try {
        const env = { ACCOUNT_1_EMAIL: 'stale@example.com', ACCOUNT_9_EMAIL: 'ghost@example.com', OTHER: 'keep' }
        refreshProcessEnv(envPath, env)
        assert.equal(env.ACCOUNT_1_EMAIL, 'a@example.com')
        assert.equal(env.ACCOUNT_9_EMAIL, undefined)
        assert.equal(env.OTHER, 'keep')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('missing file: read returns empty, create makes slot 1', () => {
    const { dir, envPath } = makeEnv(null)
    try {
        assert.deepEqual(readEnvAccounts(envPath).accounts, [])
        const { index } = upsertAccount(envPath, null, { email: 'a@example.com', password: 'x' })
        assert.equal(index, 1)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('editing account 1 in [1,3] file leaves ACCOUNT_3_* intact', () => {
    const { dir, envPath } = makeEnv([
        'ACCOUNT_1_EMAIL=first@example.com',
        'ACCOUNT_1_PASSWORD=pass-1',
        '',
        'ACCOUNT_3_EMAIL=third@example.com',
        'ACCOUNT_3_PASSWORD=pass-3'
    ].join('\n'))
    try {
        upsertAccount(envPath, 1, { email: 'first-new@example.com' })
        const d3 = accountDetail(envPath, 3)
        assert.equal(d3.email, 'third@example.com')
        const text = fs.readFileSync(envPath, 'utf8')
        assert.match(text, /ACCOUNT_3_EMAIL=third@example\.com/)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('upsertAccount edit preserves the target index', () => {
    const { dir, envPath } = makeEnv([
        'ACCOUNT_1_EMAIL=first@example.com',
        'ACCOUNT_1_PASSWORD=pass-1',
        '',
        'ACCOUNT_3_EMAIL=third@example.com',
        'ACCOUNT_3_PASSWORD=pass-3'
    ].join('\n'))
    try {
        const { index } = upsertAccount(envPath, 3, { email: 'third-new@example.com' })
        assert.equal(index, 3)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('creating in [1,3] file returns next available index', () => {
    const { dir, envPath } = makeEnv([
        'ACCOUNT_1_EMAIL=first@example.com',
        'ACCOUNT_1_PASSWORD=pass-1',
        '',
        'ACCOUNT_3_EMAIL=third@example.com',
        'ACCOUNT_3_PASSWORD=pass-3'
    ].join('\n'))
    try {
        const { index } = upsertAccount(envPath, null, { email: 'fourth@example.com', password: 'pass-4' })
        assert.equal(index, 4)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('deleting account 1 in [1,3] file densely renumbers to [1]', () => {
    const { dir, envPath } = makeEnv([
        'ACCOUNT_1_EMAIL=first@example.com',
        'ACCOUNT_1_PASSWORD=pass-1',
        '',
        'ACCOUNT_3_EMAIL=third@example.com',
        'ACCOUNT_3_PASSWORD=pass-3'
    ].join('\n'))
    try {
        deleteAccount(envPath, 1)
        const { accounts } = readEnvAccounts(envPath)
        assert.equal(accounts.length, 1)
        assert.equal(accounts[0].index, 1)
        assert.equal(accounts[0].fields.EMAIL, 'third@example.com')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('readEnvAccounts strips surrounding quotes and tolerates spaces around =, matching loadEnvFile', () => {
    const { dir, envPath } = makeEnv([
        'ACCOUNT_1_EMAIL=quoted@example.com',
        'ACCOUNT_1_PASSWORD="my secret"',
        '',
        'ACCOUNT_2_EMAIL = spaced@example.com',
        "ACCOUNT_2_PASSWORD = 'also secret'"
    ].join('\n'))
    try {
        const { accounts } = readEnvAccounts(envPath)
        assert.equal(accounts[0].fields.PASSWORD, 'my secret')
        assert.equal(accounts[1].fields.EMAIL, 'spaced@example.com')
        assert.equal(accounts[1].fields.PASSWORD, 'also secret')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('refreshProcessEnv sets the unquoted password for quoted/spaced accounts', () => {
    const { dir, envPath } = makeEnv([
        'ACCOUNT_1_EMAIL=quoted@example.com',
        'ACCOUNT_1_PASSWORD="my secret"',
        '',
        'ACCOUNT_2_EMAIL = spaced@example.com',
        "ACCOUNT_2_PASSWORD = 'also secret'"
    ].join('\n'))
    try {
        const env = {}
        refreshProcessEnv(envPath, env)
        assert.equal(env.ACCOUNT_1_PASSWORD, 'my secret')
        assert.equal(env.ACCOUNT_2_EMAIL, 'spaced@example.com')
        assert.equal(env.ACCOUNT_2_PASSWORD, 'also secret')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('editing a quoted/spaced account writes the value back unquoted (self-healing round-trip)', () => {
    const { dir, envPath } = makeEnv([
        'ACCOUNT_1_EMAIL=quoted@example.com',
        'ACCOUNT_1_PASSWORD="my secret"',
        '',
        'ACCOUNT_2_EMAIL = spaced@example.com',
        "ACCOUNT_2_PASSWORD = 'also secret'"
    ].join('\n'))
    try {
        upsertAccount(envPath, 1, { email: 'quoted@example.com', recoveryEmail: 'r@example.com' })
        const text = fs.readFileSync(envPath, 'utf8')
        assert.match(text, /^ACCOUNT_1_PASSWORD=my secret$/m)
        const { accounts } = readEnvAccounts(envPath)
        assert.equal(accounts[0].fields.PASSWORD, 'my secret')
        assert.equal(accounts[1].fields.EMAIL, 'spaced@example.com')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('refreshProcessEnv on [1,3] file sets ACCOUNT_3 but not ACCOUNT_2', () => {
    const { dir, envPath } = makeEnv([
        'ACCOUNT_1_EMAIL=first@example.com',
        'ACCOUNT_1_PASSWORD=pass-1',
        '',
        'ACCOUNT_3_EMAIL=third@example.com',
        'ACCOUNT_3_PASSWORD=pass-3'
    ].join('\n'))
    try {
        const env = { OTHER: 'keep' }
        refreshProcessEnv(envPath, env)
        assert.equal(env.ACCOUNT_1_EMAIL, 'first@example.com')
        assert.equal(env.ACCOUNT_3_EMAIL, 'third@example.com')
        assert.equal(env.ACCOUNT_2_EMAIL, undefined)
        assert.equal(env.OTHER, 'keep')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
