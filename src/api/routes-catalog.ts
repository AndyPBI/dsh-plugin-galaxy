/**
 * Catalog routes of Plugin Galaxy.
 *
 * What this module owns:
 *   - GET /dsh-galaxy/registry,
 *   - POST /dsh-galaxy/discovery-compatibility,
 *   - the browse/search panel these endpoints serve,
 *   - read through domain/registry.ts,
 *   - read through domain/discovery-compatibility.ts.
 *
 * Both endpoints are reads of public data, but both make outbound requests, so
 * both answer 502 when the network is the problem and 400 when the request is.
 */

import { asRecord, readJsonBody, sendJson } from '../core/http.ts'
import { logEvent } from '../core/log.ts'
import { proxyHint } from '../core/net.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { HostCompatibility } from '../core/types.ts'
import { hostVersionInfo } from '../domain/compatibility.ts'
import { linkedRegistryFor } from '../domain/site.ts'
import type { DiscoveryManifestIndex } from '../domain/discovery-compatibility.ts'
import { instanceFor } from '../domain/discovery-compatibility.ts'
import { CatalogLoadError, loadRegistry } from '../domain/registry.ts'
import { NPM_NAME_RE } from '../domain/sources.ts'
import { BASE_PATH } from './host.ts'
import type { Router } from './router.ts'

/** At most this many packages per compatibility request. */
export const DISCOVERY_MAX_PACKAGES = 64

/** The compatibility request body may not exceed 32 KB. */
export const DISCOVERY_BODY_MAX_BYTES = 32 * 1024

/**
 * Register the catalog endpoints.
 *
 * @param router - the mount's router; every route is disposed with it.
 * @param runtime - per-mount state: the profile, its directory, and the caches
 *   the catalog validator and the discovery index live in.
 */
export function registerCatalogRoutes(router: Router, runtime: GalaxyRuntime): void {
  /**
   * Get /dsh-galaxy/registry — the curated catalog plus the host version.
   *
   * `hostVersion` is DETECTED (environment override, else the profile's own
   * `node_modules`, else the shared dependency anchor) rather than taken from
   * `DSH_HOST_VERSION` alone — that variable is never set by dsh, so every
   * compatibility verdict used to be permanently `unknown`. `hostVersionSource`
   * says where the number came from, and an unreadable manifest still yields no
   * version at all: an invented one would make every verdict a lie.
   */
  router.get(`${BASE_PATH}/registry`, async ({ response, url }) => {
    try {
      // `?force=1` revalidates instead of replaying the conditional-request
      // cache. Without it the route always answered from that cache, so the
      // UI's refresh button looked dead: the payload really was unchanged, but
      // nothing signalled that a fresh fetch had happened.
      const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true'
      const loaded = await loadRegistry(runtime.config.profile, runtime.dir, force, runtime)
      // Every card can link to its page on the operator's own site (domain/site.ts).
      // The base travels with the payload so the client never guesses a hostname.
      const { registry, base, source } = linkedRegistryFor(runtime, loaded)
      const host = hostVersionInfo(runtime)
      sendJson(response, 200, {
        registry,
        ...(base === undefined ? {} : { siteUrlBase: base, siteUrlSource: source }),
        ...(host === undefined ? {} : { hostVersion: host.version, hostVersionSource: host.source }),
      })
    } catch (error) {
      // A catalog failure is a failure the user can act on: say what happened,
      // whether a proxy was involved, and let the UI offer a retry. The market
      // used to substitute an old snapshot here, which looked exactly like a
      // reachable catalog with fewer plugins in it.
      const message = error instanceof Error ? error.message : String(error)
      const reason = error instanceof CatalogLoadError ? error.reason : message
      logEvent('warn', 'registry', `catalog fetch failed: ${reason}`)
      sendJson(response, 502, { error: message, reason, proxyHint: proxyHint() })
    }
  })

  /**
   * Post /dsh-galaxy/discovery-compatibility — host verdicts for up to 64 npm
   * packages. The client sends only what it is about to render, so the fan-out
   * stays proportional to the visible cards rather than to the catalog.
   */
  router.post(`${BASE_PATH}/discovery-compatibility`, async ({ request, response }) => {
    let body: unknown
    try {
      body = await readJsonBody(request, DISCOVERY_BODY_MAX_BYTES)
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    const requested = asRecord(body)?.packages
    if (!Array.isArray(requested)) {
      sendJson(response, 400, { error: 'packages must be an array of at most 64 npm package names' })
      return
    }
    if (requested.length > DISCOVERY_MAX_PACKAGES) {
      sendJson(response, 400, { error: `at most ${DISCOVERY_MAX_PACKAGES} packages may be checked at once` })
      return
    }
    const names: string[] = []
    for (const item of requested) {
      const name = typeof item === 'string' ? item.trim() : ''
      if (name === '' || !NPM_NAME_RE.test(name)) {
        sendJson(response, 400, { error: 'packages must be an array of at most 64 npm package names' })
        return
      }
      names.push(name)
    }

    try {
      const index: DiscoveryManifestIndex = instanceFor(runtime)
      const results: HostCompatibility[] = await index.lookup([...new Set(names)])
      sendJson(response, 200, { results })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logEvent('error', 'discovery-compatibility', `lookup failed: ${message}`)
      sendJson(response, 500, { error: message })
    }
  })
}
