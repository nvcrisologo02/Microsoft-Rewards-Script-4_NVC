import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FatalErrorGuard } from './FatalErrorGuard'

const boom = (): Error => new Error('boom')

test('sin error fatal, el guard devuelve el resultado del trabajo', async () => {
    const guard = new FatalErrorGuard()
    assert.equal(await guard.guard(Promise.resolve('ok')), 'ok')
})

test('el guard no interfiere con un rechazo normal del trabajo', async () => {
    const guard = new FatalErrorGuard()
    await assert.rejects(guard.guard(Promise.reject(new Error('flow failed'))), /flow failed/)
})

test('report rechaza el trabajo en vuelo con el error fatal', async () => {
    const guard = new FatalErrorGuard()
    const inFlight = guard.guard(new Promise(() => {})) // nunca se resuelve por sí solo
    assert.equal(guard.report(boom()), true)
    await assert.rejects(inFlight, /boom/)
})

test('report devuelve false si no hay trabajo en vuelo: el proceso debe morir', () => {
    assert.equal(new FatalErrorGuard().report(boom()), false)
})

test('el guard se desregistra al terminar, así que un fatal posterior no se absorbe', async () => {
    const guard = new FatalErrorGuard()
    await guard.guard(Promise.resolve('ok'))
    assert.equal(guard.report(boom()), false)
})

test('pasado el límite de errores absorbidos, report devuelve false', async () => {
    const guard = new FatalErrorGuard(2)
    for (let attempt = 1; attempt <= 2; attempt++) {
        const inFlight = guard.guard(new Promise(() => {}))
        assert.equal(guard.report(boom()), true, `intento ${attempt} debería absorberse`)
        await assert.rejects(inFlight, /boom/)
    }

    const inFlight = guard.guard(new Promise(() => {}))
    assert.equal(guard.report(boom()), false)
    // El trabajo sigue vivo: quien decide ahora es el proceso, no el guard.
    assert.equal(await Promise.race([inFlight, Promise.resolve('pendiente')]), 'pendiente')
})

test('un rechazo tardío del trabajo abandonado no queda sin manejar', async () => {
    const guard = new FatalErrorGuard()
    let rejectWork!: (error: Error) => void
    const work = new Promise<never>((_, reject) => {
        rejectWork = reject
    })

    const inFlight = guard.guard(work)
    guard.report(boom())
    await assert.rejects(inFlight, /boom/)

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    rejectWork(new Error('tarde'))
    await new Promise(resolve => setImmediate(resolve))
    process.off('unhandledRejection', onUnhandled)

    assert.deepEqual(unhandled, [])
})
