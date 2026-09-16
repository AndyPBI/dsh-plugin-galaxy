/**
 * Outbound HTTP for the galaxy's own server-side calls.
 *
 * Node's global `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY` entirely, and
 * `setGlobalDispatcher` from the `undici` package cannot fix that because
 * `globalThis.fetch` runs on Node's internal copy of undici. So the galaxy
 * calls undici's own `fetch` with an explicit dispatcher. The scope is
 * deliberate: only requests made by this module change, and the host's own
 * networking is left exactly as the host configured it.
 */

import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

/**
 * Proxy URLs resolved from the process environment: standard variables first,
 * npm's own config (`npm_config_https_proxy` / `npm_config_proxy`) as the
 * fallback. Blank-is-unset is stricter than undici's truthiness test, and
 * scheme-less `host:port` values (common in Windows proxy fields) default to
 * `http://`.
 */
export function proxyFromEnv(env: Record<string, string | undefined> = process.env): {
  http: string | null
  https: string | null
} {
  const pick = (raw: string | undefined): string | null => {
    const value = raw?.trim()
    if (value === undefined || value === '') return null
    return /^[a-z][a-z\d+.-]*:\/\//iu.test(value) ? value : `http://${value}`
  }
  const https = pick(env.https_proxy ?? env.HTTPS_PROXY) ?? pick(env.npm_config_https_proxy)
  const http = pick(env.http_proxy ?? env.HTTP_PROXY) ?? pick(env.npm_config_proxy)
  return { http, https }
}

/** The proxy this process would use for outbound calls, if any. */
export function configuredProxy(env: Record<string, string | undefined> = process.env): string | null {
  const { http, https } = proxyFromEnv(env)
  return https ?? http
}

/** Built once and reused: an agent per request would drop connection reuse. */
let agent: EnvHttpProxyAgent | null = null

/** Reset the cached agent (used by tests that mutate the environment). */
export function resetProxyAgent(): void {
  agent = null
}

/**
 * Fetch through the proxy this machine is configured to use, falling back to
 * the global fetch when no proxy is set.
 */
export async function marketFetch(
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
): Promise<Response> {
  const { http, https } = proxyFromEnv()
  if (http === null && https === null) return await fetch(url, init)
  agent ??= new EnvHttpProxyAgent({ httpProxy: http ?? undefined, httpsProxy: https ?? undefined })
  return await undiciFetch(url, { ...init, dispatcher: agent }) as unknown as Response
}

/** Request descriptor accepted by {@link fetchJson}. */
export interface JsonRequest {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** Credentials for basic-auth endpoints (WebDAV). */
  auth?: { username: string; password: string }
}

/** Outcome of {@link fetchJson}. */
export interface JsonResponse {
  ok: boolean
  status: number
  /** Parsed JSON when the body was JSON, otherwise the raw text. */
  body: unknown
  text: string
  headers: Record<string, string>
  error?: string
}

/** Fetch a URL with a hard timeout and return its body plus status. */
export async function fetchJson(request: JsonRequest): Promise<JsonResponse> {
  const timeoutMs = request.timeoutMs ?? 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  const headers: Record<string, string> = { ...request.headers }
  if (request.auth !== undefined) {
    const token = Buffer.from(`${request.auth.username}:${request.auth.password}`, 'utf8').toString('base64')
    headers.authorization = `Basic ${token}`
  }
  try {
    const response = await marketFetch(request.url, {
      signal: controller.signal,
      ...(request.method === undefined ? {} : { method: request.method }),
      headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    } as { signal: AbortSignal; headers: Record<string, string> })
    const text = await response.text()
    let body: unknown = text
    try {
      body = text === '' ? undefined : JSON.parse(text) as unknown
    } catch { /* non-JSON payloads stay as text */ }
    const collected: Record<string, string> = {}
    response.headers.forEach((value, key) => { collected[key.toLowerCase()] = value })
    return { ok: response.ok, status: response.status, body, text, headers: collected }
  } catch (error) {
    const aborted = (error as { name?: string }).name === 'AbortError'
    return {
      ok: false,
      status: 0,
      body: undefined,
      text: '',
      headers: {},
      error: aborted ? `timed out after ${timeoutMs}ms` : `${(error as Error).message}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Human-readable proxy context appended to outbound failure messages. */
export function proxyHint(): string {
  const proxy = configuredProxy()
  return proxy === null
    ? 'no HTTP(S)_PROXY is configured for this process'
    : `requests were routed through ${proxy}`
}
