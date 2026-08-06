import { test } from 'node:test'
import assert from 'node:assert/strict'
import { welcomeTourOptions } from './activities/api/UrlRewardOptions'

test('el welcometour se atribuye a su propio origen', () => {
    assert.deepEqual(welcomeTourOptions(), { source: 'welcomeTour', tag: 'WELCOME-TOUR' })
})

test('el origen no es el genérico de actividad, para poder distinguirlo en bySource', () => {
    assert.notEqual(welcomeTourOptions().source, 'activity')
})
