import { test } from 'node:test'
import assert from 'node:assert/strict'
import { welcomeTourOptions } from './activities/api/UrlRewardOptions'
import { resolveTourDestination } from './activities/browser/WelcomeTour'

test('el welcometour se atribuye a su propio origen', () => {
    assert.deepEqual(welcomeTourOptions(), { source: 'welcomeTour', tag: 'WELCOME-TOUR' })
})

test('el origen no es el genérico de actividad, para poder distinguirlo en bySource', () => {
    assert.notEqual(welcomeTourOptions().source, 'activity')
})

test('una URL https absoluta se acepta tal cual', () => {
    assert.equal(
        resolveTourDestination({ destinationUrl: 'https://rewards.bing.com/welcome' }),
        'https://rewards.bing.com/welcome'
    )
})

test('http tambien vale', () => {
    assert.equal(resolveTourDestination({ destinationUrl: 'http://example.com/a' }), 'http://example.com/a')
})

test('recorta los espacios alrededor', () => {
    assert.equal(resolveTourDestination({ destinationUrl: '  https://a.test/b  ' }), 'https://a.test/b')
})

test('sin destino no hay nada que visitar', () => {
    assert.equal(resolveTourDestination({ destinationUrl: '' }), null)
    assert.equal(resolveTourDestination({ destinationUrl: '   ' }), null)
    assert.equal(resolveTourDestination({ destinationUrl: undefined as unknown as string }), null)
})

test('una URL relativa no basta: no sabemos contra que origen resolverla', () => {
    assert.equal(resolveTourDestination({ destinationUrl: '/earn/tour' }), null)
})

test('rechaza esquemas que no son http', () => {
    assert.equal(resolveTourDestination({ destinationUrl: 'javascript:alert(1)' }), null)
    assert.equal(resolveTourDestination({ destinationUrl: 'file:///etc/passwd' }), null)
})
