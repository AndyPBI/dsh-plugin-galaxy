/**
 * Host contract consumed by Plugin Galaxy.
 *
 * These are structural subsets of the DSH host services, declared locally so
 * that the plugin compiles without depending on the host's internal type
 * packages. `webServer.register` is the only capability the HTTP layer needs:
 * it takes a route description and returns a disposer, so unmounting the
 * plugin unmounts every route it added.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Route shape accepted by the host web server. */
export interface HostRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

/** Structural subset of the host's `webServer` service. */
export interface HostWebServer {
  register(route: HostRoute): () => void
}

/** Structural subset of the host's `loader` service (hot mount/unmount). */
export interface HostLoader {
  /** Loader entries, when the host exposes them for entry toggling. */
  entries?: () => unknown
  [key: string]: unknown
}

/** Optional host logger. */
export interface HostLogger {
  debug?(message: string): void
  info?(message: string): void
  warn(message: string): void
  error?(message: string): void
}

/**
 * Services the route layer is handed.
 *
 * Deliberately NOT the cordis context itself. On a real Context every service
 * property outside this plugin's `inject` list is guarded — reading one throws
 * `cannot get property "x" without inject` — so a `.ctx`/`.loader` convenience
 * field here is a trap: the read happens while routes are being registered, and
 * the throw silently truncates the route table. Callers pass only values they
 * were actually injected with.
 */
export interface GalaxyHost {
  webServer: HostWebServer
  logger?: HostLogger
}

/** Base path of every galaxy endpoint. */
export const BASE_PATH = '/dsh-galaxy'

/** Public, versioned update API base path. */
export const V1_PATH = `${BASE_PATH}/api/v1`
