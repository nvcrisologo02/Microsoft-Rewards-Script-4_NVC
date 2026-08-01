import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fingerprintMatchesLocale } from './Browser'

const fpWith = (languages: string[], header: string) =>
    ({
        fingerprint: { navigator: { language: languages[0], languages } },
        headers: { 'accept-language': header }
    }) as never

test('matches when no locale is requested', () => {
    assert.equal(fingerprintMatchesLocale(fpWith(['en-US'], 'en-US'), undefined), true)
})

test('matches when the fingerprint language shares the requested language', () => {
    assert.equal(fingerprintMatchesLocale(fpWith(['es-ES'], 'es-ES,es;q=0.9'), 'es-ES'), true)
    assert.equal(fingerprintMatchesLocale(fpWith(['es-419'], 'es-419'), 'es'), true)
})

test('does not match a different language', () => {
    assert.equal(fingerprintMatchesLocale(fpWith(['en-US'], 'en-US'), 'es-ES'), false)
})

test('does not match when the accept-language header disagrees', () => {
    assert.equal(fingerprintMatchesLocale(fpWith(['es-ES'], 'en-US,en;q=0.9'), 'es-ES'), false)
})

test('treats a missing fingerprint as a mismatch', () => {
    assert.equal(fingerprintMatchesLocale(null as never, 'es-ES'), false)
})
