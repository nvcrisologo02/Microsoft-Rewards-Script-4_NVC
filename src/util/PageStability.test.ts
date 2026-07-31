import test from 'node:test'
import assert from 'node:assert/strict'

import { isNavigationRaceError, retryOnNavigation } from './PageStability'

const NAV_ERROR = new Error(
    'page.content: Unable to retrieve content because the page is navigating and changing the content.'
)

test('isNavigationRaceError reconoce el error de navegación de Playwright', () => {
    assert.equal(isNavigationRaceError(NAV_ERROR), true)
    assert.equal(isNavigationRaceError(new Error('net::ERR_CONNECTION_RESET')), false)
    assert.equal(isNavigationRaceError(undefined), false)
})

test('resuelve a la primera si no hay error', async () => {
    let calls = 0
    const result = await retryOnNavigation(async () => {
        calls++
        return 'html'
    })
    assert.equal(result, 'html')
    assert.equal(calls, 1)
})

test('reintenta tras error de navegación y devuelve el resultado', async () => {
    let calls = 0
    const result = await retryOnNavigation(
        async () => {
            calls++
            if (calls < 3) throw NAV_ERROR
            return 'html'
        },
        { wait: async () => {} }
    )
    assert.equal(result, 'html')
    assert.equal(calls, 3)
})

test('errores que no son de navegación se relanzan sin reintentar', async () => {
    let calls = 0
    await assert.rejects(
        retryOnNavigation(
            async () => {
                calls++
                throw new Error('boom')
            },
            { wait: async () => {} }
        ),
        /boom/
    )
    assert.equal(calls, 1)
})

test('agotados los intentos, lanza el último error de navegación', async () => {
    let calls = 0
    await assert.rejects(
        retryOnNavigation(
            async () => {
                calls++
                throw NAV_ERROR
            },
            { attempts: 3, wait: async () => {} }
        ),
        /navigating and changing/
    )
    assert.equal(calls, 3)
})

test('espera entre reintentos con el delay configurado', async () => {
    const waits: number[] = []
    let calls = 0
    await retryOnNavigation(
        async () => {
            calls++
            if (calls < 2) throw NAV_ERROR
            return 'ok'
        },
        { delayMs: 1500, wait: async (delay: number) => { waits.push(delay) } }
    )
    assert.deepEqual(waits, [1500])
})
