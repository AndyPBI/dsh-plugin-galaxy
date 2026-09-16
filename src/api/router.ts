/**
 * Route registration and dispatch.
 *
 * Each endpoint is registered with the host web server individually, so that
 * unmounting the plugin disposes every route it added. The router owns the
 * cross-cutting behaviour that must never be forgotten on a new endpoint:
 *
 *   - method allow-listing (405 instead of a silent fall-through),
 *   - `sameOrigin` for mutating routes and
 *     `loopbackRequest` for destructive ones,
 *   - uniform error translation (thrown handler → logged + JSON 500).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from '../core/http.ts'
import { loopbackRequest, sameOrigin } from '../core/http.ts'
import { logEvent } from '../core/log.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { GalaxyHost } from './host.ts'

/** Per-request context handed to every handler. */
export interface HandlerContext {
  request: IncomingMessage
  response: ServerResponse
  /** Parsed request URL (never throws — a malformed URL falls back to `/`). */
  url: URL
  runtime: GalaxyRuntime
  /** The path this route was registered under. */
  routePath: string
  /** Remainder of the path after a prefix match (empty for exact routes). */
  rest: string
}

export type Handler = (context: HandlerContext) => Promise<void> | void

export interface RouteOptions {
  /** Accepted HTTP methods; anything else answers 405. */
  methods?: string[]
  /** Require a matching Origin header. */
  sameOrigin?: boolean
  /** Require a loopback peer that was not proxied. */
  loopback?: boolean
  kind?: 'exact' | 'prefix'
}

export class Router {
  private readonly disposers: Array<() => void> = []
  private routeCount = 0

  constructor(
    /**
     * The host this router registers with. Public so route groups that need a
     * host service (hot mount, loader entry toggling) can be handed it
     * explicitly instead of recovering it structurally.
     */
    readonly host: GalaxyHost,
    private readonly runtime: GalaxyRuntime,
  ) {}

  /** Number of routes registered so far. */
  get size(): number {
    return this.routeCount
  }

  /** Register one endpoint. */
  route(path: string, handler: Handler, options: RouteOptions = {}): void {
    const methods = options.methods ?? ['GET']
    const kind = options.kind ?? 'exact'
    const wrapped = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const method = request.method ?? 'GET'
      if (!methods.includes(method)) {
        response.writeHead(405, { allow: methods.join(', ') })
        response.end()
        return
      }
      if (options.loopback === true && !loopbackRequest(request)) {
        sendJson(response, 403, { error: 'this endpoint is only reachable from the local host' })
        return
      }
      if (options.sameOrigin === true && !sameOrigin(request)) {
        sendJson(response, 403, { error: 'untrusted origin' })
        return
      }
      let url: URL
      try {
        url = new URL(request.url ?? '/', 'http://localhost')
      } catch {
        url = new URL('/', 'http://localhost')
      }
      const rawPath = url.pathname
      const rest = kind === 'prefix' && rawPath.startsWith(path) ? rawPath.slice(path.length) : ''
      try {
        await handler({ request, response, url, runtime: this.runtime, routePath: path, rest })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logEvent('error', 'route', `${method} ${path} failed: ${message}`)
        this.host.logger?.warn(`[dsh-plugin-galaxy] ${method} ${path} failed: ${message}`)
        if (!response.headersSent) sendJson(response, 500, { error: message })
        else response.end()
      }
    }
    this.disposers.push(this.host.webServer.register({ kind, path, handler: wrapped }))
    this.routeCount += 1
  }

  /** Register a GET endpoint. */
  get(path: string, handler: Handler, options: Omit<RouteOptions, 'methods'> = {}): void {
    this.route(path, handler, { ...options, methods: ['GET'] })
  }

  /** Register a POST endpoint that requires a same-origin caller by default. */
  post(path: string, handler: Handler, options: Omit<RouteOptions, 'methods'> = {}): void {
    this.route(path, handler, { sameOrigin: true, ...options, methods: ['POST'] })
  }

  /** Register an endpoint accepting several methods. */
  methods(path: string, methods: string[], handler: Handler, options: Omit<RouteOptions, 'methods'> = {}): void {
    this.route(path, handler, { ...options, methods })
  }

  /** Dispose every route registered through this router. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        logEvent('warn', 'route', `route disposer failed: ${(error as Error).message}`)
      }
    }
  }
}
