/**
 * The mutation guard, in every shape a caller can arrive in.
 *
 * It defends the loopback routes against CSRF from an arbitrary web page: a
 * browser attaches `Origin` to every cross-origin POST, so a matching origin is
 * the ordinary browser case. The packaged desktop shell is the reason this file
 * exists — it loads the UI from `dsh-app://app` and forwards application requests
 * to the host with `host`/`origin`/`cookie`/`sec-fetch-site` deleted
 * (`apps/desktop/src/web-document.ts` → `forwardWebRequest`), so every mutation
 * from the desktop UI arrives with no `Origin`. The old rule rejected those, which
 * is why the panel could list plugins but not install one inside the desktop app.
 *
 * Every allowance beyond a matching origin requires a loopback socket, so a remote
 * caller gains nothing by omitting or spoofing the header.
 */

import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'

import { loopbackRequest, sameOrigin } from '../src/core/http.ts'

/** A request with just the fields the guard reads. */
function request(headers: Record<string, string>, remoteAddress = '127.0.0.1'): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

describe('sameOrigin', () => {
  it('accepts a matching origin (browsers, the web shape)', () => {
    expect(sameOrigin(request({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }))).toBe(true)
    expect(sameOrigin(request({ host: 'localhost:3080', origin: 'http://localhost:3080' }))).toBe(true)
  })

  it('rejects a mismatched origin, however plausible', () => {
    expect(sameOrigin(request({ host: '127.0.0.1:3080', origin: 'https://evil.example' }))).toBe(false)
    expect(sameOrigin(request({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' }))).toBe(false)
    expect(sameOrigin(request({ host: '127.0.0.1:3080', origin: 'null' }))).toBe(false)
  })

  it('accepts the desktop shell, which forwards requests without an Origin', () => {
    // This is the reported defect: the shell strips origin/host and injects its
    // own cookie, so the request arrives bare from loopback.
    expect(sameOrigin(request({ host: '127.0.0.1:51234' }))).toBe(true)
  })

  it('accepts the desktop app origin when a shell forwards it verbatim', () => {
    expect(sameOrigin(request({ host: '127.0.0.1:51234', origin: 'dsh-app://app' }))).toBe(true)
  })

  it('never accepts those two cases from a remote socket', () => {
    for (const remote of ['10.0.0.5', '192.168.1.20', '::1']) {
      const bare = request({ host: '127.0.0.1:51234' }, remote)
      const app = request({ host: '127.0.0.1:51234', origin: 'dsh-app://app' }, remote)
      // ::1 IS loopback (loopbackRequest accepts it) — assert the helper's verdict,
      // not a hard-coded one, so the two functions cannot drift apart.
      const expected = loopbackRequest(bare)
      expect(sameOrigin(bare), `bare from ${remote}`).toBe(expected)
      expect(sameOrigin(app), `dsh-app from ${remote}`).toBe(expected)
    }
    // The interesting case: a genuinely remote socket is refused both ways.
    expect(sameOrigin(request({ host: '127.0.0.1:51234' }, '10.0.0.5'))).toBe(false)
    expect(sameOrigin(request({ host: '127.0.0.1:51234', origin: 'dsh-app://app' }, '10.0.0.5'))).toBe(false)
  })

  it('refuses a bare request that a proxy forwarded', () => {
    expect(sameOrigin(request({ host: '127.0.0.1:51234', 'x-forwarded-for': '203.0.113.7' }))).toBe(false)
  })

  it('refuses a present origin when the host header is missing', () => {
    expect(sameOrigin(request({ origin: 'http://127.0.0.1:3080' }))).toBe(false)
  })
})
