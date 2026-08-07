import { TLSSocket } from 'node:tls'
import type { DetailedPeerCertificate, PeerCertificate } from 'node:tls'

// Playwright's APIRequestContext (page.request.*) records TLS security details from the
// http client's 'socket' event: captureSecurityDetails() reads peerCertificate.subject.CN
// without a null check. Node's TLSSocket.getPeerCertificate() returns null whenever the
// socket has no handle left, so a keep-alive socket the peer already tore down (the
// request.reusedSocket branch) makes that dereference throw a TypeError *synchronously
// inside an EventEmitter callback*. It never reaches request.on('error'), so it surfaces
// as an uncaughtException and kills the whole run.
//
// The certificate of a dead socket carries no information anyway, so we hand Playwright
// the empty shape it expects instead of null; securityDetails ends up with undefined
// fields, which is what an unverified connection deserves. Present in playwright-core and
// patchright-core 1.61.1 alike, so there is no version to upgrade to.

type AnyPeerCertificate = PeerCertificate | DetailedPeerCertificate

const GUARD_FLAG = Symbol.for('microsoft-rewards-script.tlsPeerCertificateGuard')

/** Passes a real certificate straight through; replaces a missing one with the shape callers dereference. */
export function coercePeerCertificate<T>(raw: T): T | AnyPeerCertificate {
    return raw ?? ({ subject: {}, issuer: {} } as unknown as PeerCertificate)
}

export function installTlsPeerCertificateGuard(): void {
    const proto = TLSSocket.prototype as unknown as Record<symbol, unknown>
    if (proto[GUARD_FLAG]) return

    const original = TLSSocket.prototype.getPeerCertificate
    const guarded = function (this: TLSSocket, detailed?: boolean): AnyPeerCertificate {
        return coercePeerCertificate(original.call(this, detailed as true))
    }

    TLSSocket.prototype.getPeerCertificate = guarded as typeof TLSSocket.prototype.getPeerCertificate
    proto[GUARD_FLAG] = true
}
