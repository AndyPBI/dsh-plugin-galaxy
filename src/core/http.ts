/**
 * Minimal HTTP helpers shared by every galaxy route: JSON serialization,
 * same-origin enforcement for mutating endpoints, loopback-only guards for
 * destructive endpoints, and size-capped body readers.
 *
 * Browser pages on other origins must not be able to drive
 * this API, because the plugin runs with the host's filesystem and process
 * privileges. Every mutating route passes through `sameOrigin`; the
 * destructive ones (restart, backup download) additionally require a loopback
 * peer and reject proxied forwards.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Write a JSON payload with no-store caching. */
export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Write a plain-text payload. */
export function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Write a downloadable attachment (backup JSON, log export). */
export function sendAttachment(
  response: ServerResponse,
  filename: string,
  contentType: string,
  body: string,
): void {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': contentType,
    'content-disposition': `attachment; filename="${filename.replace(/"/gu, '')}"`,
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * Whether a mutating request may proceed.
 *
 * The guard defends the loopback routes against CSRF from an arbitrary web page,
 * and browsers attach `Origin` to every cross-origin POST — so a *matching*
 * origin is the ordinary browser case, and its absence is itself meaningful.
 *
 * The packaged desktop shell needs the two extra cases: it loads the UI from
 * `dsh-app://app` and forwards application requests to the host with
 * `host`/`origin`/`cookie`/`sec-fetch-site` **deleted** and its own authenticated
 * cookie injected (`apps/desktop/src/web-document.ts` → `forwardWebRequest`).
 * Every mutation from the desktop UI therefore arrives with no `Origin` at all,
 * which the old rule rejected — the panel could list plugins but not install,
 * update, uninstall or toggle any of them (#2026-10).
 *
 * Both extra cases require the socket to be loopback, so a remote caller cannot
 * reach them by omitting or spoofing the header, and destructive routes still
 * require loopback on top. `Origin: null` (sandboxed frame, `file://`) is a
 * present-but-unparseable value and stays untrusted.
 *
 * @param request - Incoming request to judge.
 * @returns true when the caller is same-origin, or the owned desktop shell on loopback.
 */
export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined) {
    // No Origin: the desktop shell strips it; anything else that omits it must
    // at least be on this machine.
    return loopbackRequest(request)
  }
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    if (parsed.host === host) return true
    // An older/other shell path may forward the app origin verbatim.
    return parsed.protocol === 'dsh-app:' && loopbackRequest(request) && host !== ''
  } catch {
    return false
  }
}

/**
 * True when the request arrived over the loopback interface and was not
 * forwarded by a proxy. `x-forwarded-for` disqualifies the request even from
 * loopback, because a reverse proxy on the same machine would let a remote
 * client reach the destructive routes.
 */
export function loopbackRequest(request: IncomingMessage): boolean {
  if (request.headers['x-forwarded-for'] !== undefined) return false
  if (request.headers['x-real-ip'] !== undefined) return false
  const address = request.socket.remoteAddress ?? ''
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

/**
 * Guard for destructive routes that a user triggers with a real page action:
 * loopback AND a matching Origin. `<a download>` navigation sends no Origin,
 * so download-shaped routes use `loopbackRequest` alone.
 */
export function trustedRequest(request: IncomingMessage): boolean {
  return loopbackRequest(request) && sameOrigin(request)
}

/** Read a request body into a buffer, rejecting anything over the cap. */
export async function readBody(request: IncomingMessage, maxBytes = 4096): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Read and parse a JSON request body, rejecting anything over the cap. */
export async function readJsonBody(request: IncomingMessage, maxBytes = 4096): Promise<unknown> {
  const raw = await readBody(request, maxBytes)
  if (raw.length === 0) return undefined
  return JSON.parse(raw.toString('utf8')) as unknown
}

/** Narrow an unknown JSON body to a string-keyed record. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a string field of a JSON body, trimmed; `undefined` when absent. */
export function stringField(body: unknown, key: string): string | undefined {
  const record = asRecord(body)
  const value = record?.[key]
  return typeof value === 'string' ? value.trim() : undefined
}

/** Read a boolean field of a JSON body; `undefined` when absent or not boolean. */
export function booleanField(body: unknown, key: string): boolean | undefined {
  const value = asRecord(body)?.[key]
  return typeof value === 'boolean' ? value : undefined
}

/** Read a string-array field of a JSON body. */
export function stringArrayField(body: unknown, key: string): string[] | undefined {
  const value = asRecord(body)?.[key]
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

/** Parse a query parameter as a positive integer, or return the fallback. */
export function intParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key)
  if (raw === null) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

/** Parse a query parameter as a boolean flag (`1`, `true`, `yes`). */
export function boolParam(url: URL, key: string): boolean {
  const raw = url.searchParams.get(key)
  return raw === '1' || raw === 'true' || raw === 'yes'
}
