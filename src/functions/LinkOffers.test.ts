import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterLinkOfferUrls, linkOfferVisitKey } from './Workers'

const NEWS = 'https://www.bing.com/search?q=Bing%20news%20quiz&form=ML2BF3&PROGRAMNAME=BingDailyOfferIN'
const PUZZLE = 'https://www.bing.com/spotlight/imagepuzzle?form=ML2BF0&PROGRAMNAME=BingDailyOfferIN'
const DONE = 'https://www.bing.com/search?q=coral&form=ML2UYA&PROGRAMNAME=BingDailyOfferIN&rnoreward=1'

test('mantiene las ofertas pendientes', () => {
    assert.deepEqual(filterLinkOfferUrls([NEWS, PUZZLE]), [NEWS, PUZZLE])
})

test('descarta las ya completadas (rnoreward=1)', () => {
    assert.deepEqual(filterLinkOfferUrls([DONE]), [])
})

test('ignora enlaces sin PROGRAMNAME', () => {
    assert.deepEqual(filterLinkOfferUrls(['https://www.bing.com/search?q=algo']), [])
})

test('deduplica por código form', () => {
    const other = 'https://www.bing.com/spotlight/imagepuzzle?form=ML2BF0&PROGRAMNAME=BingDailyOfferIN&x=1'
    assert.deepEqual(filterLinkOfferUrls([PUZZLE, other]), [PUZZLE])
})

test('la clave de visita combina cuenta y form, en minúsculas', () => {
    assert.equal(linkOfferVisitKey('User@Example.com', NEWS), 'user@example.com|ml2bf3')
})

test('la clave distingue cuentas', () => {
    assert.notEqual(linkOfferVisitKey('a@b.com', NEWS), linkOfferVisitKey('c@d.com', NEWS))
})
