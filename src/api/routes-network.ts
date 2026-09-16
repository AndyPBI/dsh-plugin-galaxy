/**
 * Network, update-channel and region routes.
 *
 * Endpoint prefixes are owned by `docs/implementation-contract.md` §4; no
 * other module registers these five paths.
 *
 *  - `GET /dsh-galaxy/updates` → UpdateStatus[] (`?force=1`)
 *  - `GET /dsh-galaxy/changelog` → ChangelogPayload (`?name=`)
 *  - `POST /dsh-galaxy/channel` → `{channel}` (STATE write)
 *  - `POST /dsh-galaxy/region` → `{region}` (STATE write + cache invalidation)
 *  - `POST /dsh-galaxy/github-proxy` → `{proxy}` (STATE write, 409 when operator-managed)
 *
 * Every POST is same-origin (the router enforces it) and takes the `write`
 * mutation lock, since each one only rewrites the galaxy's own state file.
 * Status codes follow the contract: 400 invalid input, 409 conflict with an
 * operator-managed setting.
 */

import { asRecord, boolParam, readJsonBody, sendJson } from '../core/http.ts'
import { logEvent } from '../core/log.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import { setChannel } from '../core/state.ts'
import { updateNotesFor } from '../domain/changelog.ts'
import { asChannel } from '../domain/channels.ts'
import {
  applyRegion,
  asRegion,
  forgetCatalog,
  githubProxyManaged,
  normalizeGithubProxy,
  setCustomGithubProxy,
} from '../domain/regions.ts'
import { checkUpdates, invalidateUpdates } from '../domain/updates.ts'
import { BASE_PATH } from './host.ts'
import type { Router } from './router.ts'

/** Parse a comma-separated `names` query parameter. */
function namesParam(url: URL): string[] {
  return (url.searchParams.get('names') ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '')
}

/**
 * Register the five network endpoints on this mount's router.
 *
 * Routes are registered individually so that unmounting the plugin disposes
 * every one of them.
 */
export function registerNetworkRoutes(router: Router, runtime: GalaxyRuntime): void {
  /**
   * The update listing. Read-only and safe to poll: without `force` it is
   * served from the 30-minute TTL cache. With
   * `?force=1` the cached listing is dropped first so the recomputed answer
   * is what every later caller sees too.
   */
  router.get(`${BASE_PATH}/updates`, async ({ response, url }) => {
    const force = boolParam(url, 'force')
    if (force) invalidateUpdates(runtime)
    const names = namesParam(url)
    const updates = await checkUpdates(
      runtime.config.profile,
      runtime.dir,
      { force, ...(names.length === 0 ? {} : { names }) },
      runtime,
    )
    sendJson(response, 200, updates)
  })

  /**
   * Release notes for one plugin, resolved from the catalog side's daily
   * probe. `updateNotesFor` never throws, so "no notes published" and "the
   * notes could not be loaded" both answer 200 with an empty payload — the
   * dialog shows a neutral statement rather than an error banner.
   */
  router.get(`${BASE_PATH}/changelog`, async ({ response, url }) => {
    const name = (url.searchParams.get('name') ?? '').trim()
    if (name === '') {
      sendJson(response, 400, { error: 'name query parameter is required' })
      return
    }
    const payload = await updateNotesFor(name, {
      runtime,
      profile: runtime.config.profile,
      dir: runtime.dir,
      current: url.searchParams.get('current'),
      latest: url.searchParams.get('latest'),
    })
    sendJson(response, 200, payload)
  })

  /**
   * Which release channel the galaxy offers ITSELF from. Other plugins are
   * never pulled from a prerelease on the strength of this setting, which is
   * why the cached listing must be dropped: it was computed for the old
   * channel and would otherwise keep answering for a setting that no longer
   * applies.
   */
  router.post(`${BASE_PATH}/channel`, async ({ request, response }) => {
    const wanted = asChannel(asRecord(await readJsonBody(request))?.channel)
    if (wanted === undefined) {
      sendJson(response, 400, { error: 'channel must be "stable", "beta" or "dev"' })
      return
    }
    await runtime.locks.withLock('write', 'channel', () => {
      setChannel(runtime.dir, wanted)
    })
    invalidateUpdates(runtime)
    logEvent('info', 'channel', `release channel set to ${wanted}`)
    sendJson(response, 200, { ok: true, channel: wanted })
  })

  /**
   * Which mirrors every outbound request uses. Both caches were filled from
   * the other region's origins: the catalog validator in particular is scoped
   * to the URL that issued it and is meaningless against the new one.
   */
  router.post(`${BASE_PATH}/region`, async ({ request, response }) => {
    const wanted = asRegion(asRecord(await readJsonBody(request))?.region)
    if (wanted === undefined) {
      sendJson(response, 400, { error: 'region must be "global" or "china"' })
      return
    }
    await runtime.locks.withLock('write', 'region', () => {
      applyRegion(runtime, wanted)
    })
    forgetCatalog(runtime)
    invalidateUpdates(runtime)
    sendJson(response, 200, { ok: true, region: wanted })
  })

  /**
   * Last-resort GitHub prefix for networks where every built-in route is
   * unavailable. It is one escape hatch, not three service-level knobs; the
   * service ordering itself remains maintained by the routing table.
   *
   * While `DSHG_GITHUB_PROXY` is set the route is operator-managed and the UI
   * is refused with 409, because a browser must not be able to overrule a
   * statement about this machine's network.
   */
  router.post(`${BASE_PATH}/github-proxy`, async ({ request, response }) => {
    if (githubProxyManaged()) {
      sendJson(response, 409, { error: 'the GitHub proxy is managed by DSHG_GITHUB_PROXY' })
      return
    }
    const value = asRecord(await readJsonBody(request))?.proxy
    if (value !== undefined && value !== null && typeof value !== 'string') {
      sendJson(response, 400, { error: 'proxy must be an http(s) URL prefix or null' })
      return
    }
    // An absent, null or empty value clears the custom route and restores
    // automatic routing.
    const cleared = value === undefined || value === null || value.trim() === ''
    const wanted = cleared ? null : normalizeGithubProxy(value)
    if (wanted === null && !cleared) {
      sendJson(response, 400, {
        error: 'proxy must be an http(s) URL prefix without credentials, query parameters, or a fragment',
      })
      return
    }
    await runtime.locks.withLock('write', 'github-proxy', () => {
      setCustomGithubProxy(runtime, wanted)
    })
    invalidateUpdates(runtime)
    sendJson(response, 200, { ok: true, proxy: wanted })
  })
}
