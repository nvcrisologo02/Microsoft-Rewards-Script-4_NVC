import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Socket } from 'node:net'
import { TLSSocket } from 'node:tls'
import { coercePeerCertificate, installTlsPeerCertificateGuard } from './TlsGuard'

// Referencia al método sin parchear, capturada antes de instalar el guard, para que
// los casos "sin guard" no dependan del orden de ejecución de los tests.
const originalGetPeerCertificate = TLSSocket.prototype.getPeerCertificate

/** Un socket TLS cuyo handle ya no existe: es el estado de un socket keep-alive muerto. */
function handlelessSocket(): TLSSocket {
    const socket = new TLSSocket(new Socket())
    socket.on('error', () => {
        /* el socket se destruye a propósito */
    })
    socket.destroy()
    return socket
}

/** Exactamente lo que hace captureSecurityDetails() de patchright/playwright. */
function readAsPlaywrightDoes(socket: TLSSocket): { subjectName: unknown; issuer: unknown } {
    const peerCertificate = socket.getPeerCertificate()
    return { subjectName: peerCertificate.subject.CN, issuer: peerCertificate.issuer.CN }
}

test('node devuelve null al pedir el certificado de un socket sin handle', () => {
    assert.equal(originalGetPeerCertificate.call(handlelessSocket()), null)
})

test('sin el guard, leer subject como hace playwright lanza TypeError', () => {
    const socket = handlelessSocket()
    assert.throws(
        () => (originalGetPeerCertificate.call(socket) as { subject: { CN: string } }).subject.CN,
        TypeError
    )
})

test('con el guard, leer subject e issuer en un socket sin handle no lanza', () => {
    installTlsPeerCertificateGuard()
    const details = readAsPlaywrightDoes(handlelessSocket())
    assert.deepEqual(details, { subjectName: undefined, issuer: undefined })
})

test('el guard deja pasar el certificado real sin modificarlo', () => {
    const real = { subject: { CN: 'rewards.bing.com' }, issuer: { CN: 'Microsoft RSA TLS CA' } }
    assert.equal(coercePeerCertificate(real), real)
})

test('el guard es idempotente: instalarlo dos veces no vuelve a envolverlo', () => {
    installTlsPeerCertificateGuard()
    const afterFirst = TLSSocket.prototype.getPeerCertificate
    installTlsPeerCertificateGuard()
    assert.equal(TLSSocket.prototype.getPeerCertificate, afterFirst)
})
