/**
 * Download regions: which route the galaxy's own network requests take.
 *
 * Almost every external request the galaxy makes lands on npm's registry or
 * on GitHub — the plugin catalog, update checks, package downloads, author
 * avatars, README screenshots. From mainland China several of those are slow,
 * which is why this is ONE setting rather than a row of them: "npm mirror",
 * "GitHub proxy" and "image proxy" are three spellings of a single question,
 * which is where the user is.
 *
 * {@link REGION_TABLE} is the single source of truth. Every consumer asks it
 * rather than reaching for a hard-coded host, so adding a region is a table
 * entry instead of a search across six modules.
 *
 * Each route has an environment escape hatch, following the operator-owned
 * `DSHG_*` variables (config-index):
 *   - `DSHG_REGISTRY_URL` replaces the catalog candidate list,
 *   - `DSHG_NPM_MIRROR` replaces the npm registry base,
 *   - `DSHG_GITHUB_PROXY` is an operator-managed GitHub prefix proxy
 *     (while it is set the UI cannot change the route: see
 * {@link githubProxyManaged} and the 409 on),
 *   - `DSHG_UPDATES_ORIGIN` names the release-notes origin
 *     ({@link updatesOrigin}).
 *
 * Persistence of the user's own choice goes through `core/state.ts`
 * (`updateGalaxyState` / `readGalaxyState`); the checked-in table is never
 * mutated.
 */

import { logEvent } from '../core/log.ts'
import { readGalaxyState, updateGalaxyState } from '../core/state.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { GithubService, Region } from '../core/types.ts'

export type { GithubService, Region }

/** Every region a user may pick. */
export const REGIONS: readonly Region[] = ['global', 'china']

/** Narrow an untrusted value to a {@link Region}, or `undefined`. */
export function asRegion(value: unknown): Region | undefined {
  return value === 'global' || value === 'china' ? value : undefined
}

/**
 * The three GitHub transports behind one routing candidate.
 *
 * They fail independently on filtered networks (raw content commonly needs a
 * proxy while git advertisements stay reachable), so a candidate carries a
 * base per transport instead of one hostname.
 */
export interface GithubRoutes {
  /** Base for raw file reads (`raw.githubusercontent.com`-family). */
  raw: string
  /** Base for tarball downloads (`codeload.github.com`-family). */
  codeload: string
  /** Base for git smart-HTTP (`github.com`-family). */
  git: string
}

/** Where one region sends each kind of request. */
export interface RegionRoutes {
  /**
   * Catalog candidates in order; later entries are fallbacks.
   *
   * The catalog is the FIRST request the galaxy makes, so a mirror that has
   * gone down must mean a slow galaxy rather than an empty one — every region
   * ends its list at an address that has always worked. China's first entry
   * is the npm-carried catalog packument (`dsh-plugin-catalog`), which rides
   * the same mirror as every plugin; the origin JSON is the fallback.
   */
  catalog: string[]
  /** npm registry base, no trailing slash. */
  npm: string
  /**
   * GitHub candidates in order; each triple is one prefix proxy (or the
   * canonical direct bases). A list normally ends in the direct candidate.
   */
  github: GithubRoutes[]
}

/** The public npm registry. */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'

/** The Tencent Cloud npm mirror documented for the China region. */
export const CHINA_NPM_MIRROR = 'https://mirrors.cloud.tencent.com/npm'

/** The catalog's stable public address (a custom domain, not a repo path). */
export const CATALOG_ORIGIN = 'https://awesome-dsh-plugin.com/plugins.json'

/**
 * The npm package carrying the same catalog, used as China's first route.
 *
 * A package rather than a file URL, because the catalog's own host is the
 * problem being solved: it is served from GitHub Pages, and public GitHub
 * proxies refuse hostnames that are not github.com's own. Published to npm it
 * reaches mainland China through the same mirror as every plugin.
 */
export const CATALOG_PACKAGE = 'dsh-plugin-catalog'

/** The default release-notes origin (beside `plugins.json`). */
export const DEFAULT_UPDATES_ORIGIN = 'https://awesome-dsh-plugin.com/updates.json'

/** Canonical (unproxied) GitHub bases. */
export const GITHUB_DIRECT: GithubRoutes = {
  raw: 'https://raw.githubusercontent.com',
  codeload: 'https://codeload.github.com',
  git: 'https://github.com',
}

/**
 * Public prefix proxies documented for the China region, in preference order.
 *
 * What such a proxy accepts is a list of GitHub SERVICES, not a hostname
 * test: re-measured, `raw.githubusercontent.com` content is served while a
 * plain `github.com/owner/repo` page is refused. That policy belongs to the
 * operator and can change, which is why the candidates are a table plus the
 * `DSHG_GITHUB_PROXY` escape hatch rather than an inferred rule.
 */
export const CHINA_GITHUB_PROXIES: readonly string[] = ['https://gh-proxy.com', 'https://ghfast.top']

/** Wrap the canonical GitHub bases in one prefix proxy. */
export function proxiedGithubRoutes(proxy: string): GithubRoutes {
  const prefix = proxy.replace(/\/+$/u, '')
  return {
    raw: `${prefix}/${GITHUB_DIRECT.raw}`,
    codeload: `${prefix}/${GITHUB_DIRECT.codeload}`,
    git: `${prefix}/${GITHUB_DIRECT.git}`,
  }
}

/**
 * The routing table. Treat as immutable: `routesFor` hands out copies.
 */
export const REGION_TABLE: Record<Region, RegionRoutes> = {
  global: {
    catalog: [CATALOG_ORIGIN],
    npm: DEFAULT_NPM_REGISTRY,
    github: [{ ...GITHUB_DIRECT }],
  },
  china: {
    catalog: [`${CHINA_NPM_MIRROR}/${CATALOG_PACKAGE}/latest`, CATALOG_ORIGIN],
    npm: CHINA_NPM_MIRROR,
    github: [...CHINA_GITHUB_PROXIES.map(proxiedGithubRoutes), { ...GITHUB_DIRECT }],
  },
}

/** Read an environment override, treating blank as unset. */
function override(env: Record<string, string | undefined>, name: string): string | null {
  const raw = env[name]
  return raw !== undefined && raw.trim() !== '' ? raw.trim().replace(/\/+$/u, '') : null
}

/**
 * The operator-owned GitHub prefix proxy from the environment, if any.
 *
 * A scheme-less value (`gh-proxy.com`, common in hand-written service files)
 * is read as HTTPS: a prefix proxy is always reached over TLS, and refusing
 * the value outright would leave the operator with no route at all.
 */
function envGithubProxy(env: Record<string, string | undefined>): string | null {
  const raw = override(env, 'DSHG_GITHUB_PROXY')
  if (raw === null) return null
  return /^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`
}

/**
 * Normalize a user-maintained prefix, or reject it.
 *
 * Public mirrors receive the complete destination URL in their path. Only
 * http(s) prefixes without embedded credentials or query fragments are safe
 * to persist and show again in the settings UI.
 */
export function normalizeGithubProxy(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw === '' || raw.includes('\\')) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    if (parsed.username !== '' || parsed.password !== '') return null
    if (parsed.search !== '' || parsed.hash !== '') return null
    if (parsed.hostname === '') return null
    const path = parsed.pathname.replace(/\/+$/u, '')
    return `${parsed.origin}${path}`
  } catch {
    return null
  }
}

/**
 * Whether the operator-owned environment variable disables UI changes.
 *
 * A proxy set in the environment is a statement about this machine's network,
 * so the browser is not allowed to overrule it: answers 409.
 */
export function githubProxyManaged(env: Record<string, string | undefined> = process.env): boolean {
  return envGithubProxy(env) !== null
}

/**
 * The routes for a region, with environment overrides applied.
 *
 * Overrides win over the table because they are the user's statement about
 * their own network, and they are the way out when a public proxy dies.
 * `DSHG_REGISTRY_URL` REPLACES the catalog list rather than heading it:
 * someone pointing the galaxy at their own catalog does not want it quietly
 * reverting to ours when theirs is briefly unreachable.
 *
 * The runtime-managed custom proxy is applied by {@link effectiveRoutes};
 * this function is the operator/environment view only.
 */
export function routesFor(
  region: Region,
  env: Record<string, string | undefined> = process.env,
): RegionRoutes {
  const base = REGION_TABLE[region]
  const npmMirror = override(env, 'DSHG_NPM_MIRROR')
  const githubProxy = envGithubProxy(env)
  const npm = npmMirror ?? base.npm
  const catalog = override(env, 'DSHG_REGISTRY_URL')
  return {
    npm,
    github: githubProxy === null
      ? base.github.map(candidate => ({ ...candidate }))
      : [proxiedGithubRoutes(githubProxy), { ...GITHUB_DIRECT }],
    // A named catalog REPLACES the list rather than joining it. Otherwise the
    // npm-carried candidate is rebuilt against the resolved registry, so an
    // npm override moves the catalog to the same mirror it moved everything
    // else to.
    catalog: catalog !== null
      ? [catalog]
      : base.catalog.map(entry => (region === 'china' && entry.startsWith(CHINA_NPM_MIRROR)
        ? `${npm}/${CATALOG_PACKAGE}/latest`
        : entry)),
  }
}

/** The runtime-managed (UI) custom proxy, or null when none is recorded. */
export function customGithubProxy(runtime: GalaxyRuntime): string | null {
  const fromEnv = envGithubProxy(process.env)
  if (fromEnv !== null) return fromEnv
  const cached = runtime.cache<{ proxy: string | null }>(PROXY_CACHE_KEY)
  if (cached !== undefined) return cached.proxy
  const stored = readGalaxyState(runtime.dir).githubProxy
  const proxy = stored === undefined ? null : normalizeGithubProxy(stored)
  runtime.setCache(PROXY_CACHE_KEY, { proxy })
  return proxy
}

/**
 * The routes actually in force for a region in this runtime.
 *
 * A UI-configured proxy replaces the table's GitHub candidates with itself
 * followed by the direct escape path — the same shape a region table has, so
 * every consumer keeps walking one list.
 */
export function effectiveRoutes(
  region: Region,
  runtime?: GalaxyRuntime,
  env: Record<string, string | undefined> = process.env,
): RegionRoutes {
  const base = routesFor(region, env)
  const custom = runtime === undefined ? envGithubProxy(env) : customGithubProxy(runtime)
  if (custom === null) return base
  return { ...base, github: [proxiedGithubRoutes(custom), { ...GITHUB_DIRECT }] }
}

/** The region in force for this runtime; `global` when nothing is recorded. */
export function resolveRegion(runtime: GalaxyRuntime): Region {
  return readGalaxyState(runtime.dir).region ?? 'global'
}

/**
 * Record a region chosen by hand and make this runtime follow it.
 *
 * Persistence is the point: the choice survives a restart, and a setting that
 * forgets is a setting the user has to make again every boot. Callers are
 * responsible for their own caches — follows this with
 * {@link forgetCatalog} and `invalidateUpdates`.
 */
export function applyRegion(runtime: GalaxyRuntime, region: Region): void {
  updateGalaxyState(runtime.dir, (state) => {
    state.region = region
    // A choice made by hand is no longer the probe's choice, so the one-time
    // explanation stops being offered.
    state.regionAuto = false
  })
  runtime.setCache(PREFERRED_CACHE_KEY, new Map<string, string>())
  logEvent('info', 'region', `download region set to ${region}`)
}

/**
 * Drop the catalog caches after a routing change.
 *
 * The catalog validator is scoped to the URL that issued it (ETag /
 * Last-Modified / version), so it is meaningless against another origin. The
 * convention is a key prefix rather than a private handle into group A's
 * module: every catalog cache slot is named `catalog…` so a region change can
 * clear it without importing its owner.
 */
export function forgetCatalog(runtime: GalaxyRuntime): void {
  let cleared = 0
  for (const key of [...runtime.caches.keys()]) {
    if (!key.startsWith('catalog')) continue
    runtime.caches.delete(key)
    cleared += 1
  }
  logEvent('info', 'region', `catalog caches dropped after a routing change (${cleared})`)
}

/**
 * Apply (or clear) the persisted UI escape route.
 *
 * `null` restores automatic routing. The value is normalized first, so a
 * malformed prefix is a caller error rather than a poisoned state file.
 */
export function setCustomGithubProxy(runtime: GalaxyRuntime, proxy: string | null): void {
  const next = proxy === null ? null : normalizeGithubProxy(proxy)
  updateGalaxyState(runtime.dir, (state) => {
    if (next === null) delete state.githubProxy
    else state.githubProxy = next
  })
  runtime.setCache(PROXY_CACHE_KEY, { proxy: next })
  // Learned winners were learned on the old route list.
  runtime.setCache(PREFERRED_CACHE_KEY, new Map<string, string>())
  logEvent('info', 'region', next === null
    ? 'custom GitHub route cleared; automatic routing restored'
    : 'custom GitHub route updated')
}

/** The canonical hostnames each GitHub service may carry. */
const SERVICE_HOSTS: Record<GithubService, readonly string[]> = {
  git: ['github.com', 'codeload.github.com'],
  raw: ['raw.githubusercontent.com', 'github.com', 'codeload.github.com', 'objects.githubusercontent.com'],
  avatar: ['avatars.githubusercontent.com', 'github.com'],
}

/**
 * Wrap a github.com-family URL in the operator-managed prefix proxy.
 *
 * The proxy takes the full absolute URL as its path (`{proxy}/{url}`) rather
 * than a rewritten hostname, so the same joining rule works for every GitHub
 * service. A URL whose host does not belong to the named service is returned
 * unchanged: a prefix proxy must never be handed an arbitrary origin.
 *
 * @param url - an absolute http(s) URL.
 * @param service - which GitHub surface the URL belongs to.
 * @returns the proxied URL, or `url` unchanged when there is no proxy.
 */
export function applyGithubProxy(url: string, service: GithubService): string {
  const proxy = envGithubProxy(process.env)
  return proxy === null ? url : prefixThroughProxy(proxy, url, service)
}

/** {@link applyGithubProxy} against the proxy the runtime is actually using. */
export function applyGithubProxyFor(runtime: GalaxyRuntime, url: string, service: GithubService): string {
  const proxy = customGithubProxy(runtime)
  return proxy === null ? url : prefixThroughProxy(proxy, url, service)
}

/** Prefix `url` when its host belongs to `service`; otherwise return it as-is. */
function prefixThroughProxy(proxy: string, url: string, service: GithubService): string {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (!SERVICE_HOSTS[service].includes(host)) return url
  } catch {
    return url
  }
  return `${proxy.replace(/\/+$/u, '')}/${url}`
}

/**
 * The transports a routing candidate carries.
 *
 * `avatar` is deliberately absent: the table routes downloads and metadata,
 * while avatar URLs come from the catalog fully formed and are only ever
 * prefixed by {@link applyGithubProxy} (which knows that service's hosts).
 */
export type GithubRouteService = 'git' | 'raw' | 'codeload'

/**
 * Ordered candidate bases for one GitHub service, learned winner first.
 *
 * The verified route is remembered per service so a proxy that answered once
 * is tried first next time, without changing the candidates of the other
 * services (they fail independently).
 */
export function githubRoutesFor(
  service: GithubRouteService,
  region: Region,
  runtime?: GalaxyRuntime,
): string[] {
  const routes = effectiveRoutes(region, runtime).github.map(candidate => candidate[service])
  const preferred = runtime?.cache<Map<string, string>>(PREFERRED_CACHE_KEY)?.get(service)
  if (preferred === undefined) return routes
  const index = routes.indexOf(preferred)
  if (index <= 0) return routes
  return [routes[index] as string, ...routes.slice(0, index), ...routes.slice(index + 1)]
}

/** Remember one verified route without changing the other services. */
export function rememberGithubRoute(
  runtime: GalaxyRuntime | undefined,
  service: GithubRouteService,
  route: string,
): void {
  if (runtime === undefined) return
  const learned = runtime.cache<Map<string, string>>(PREFERRED_CACHE_KEY) ?? new Map<string, string>()
  learned.set(service, route)
  runtime.setCache(PREFERRED_CACHE_KEY, learned)
}

/** The release-notes origin, honouring `DSHG_UPDATES_ORIGIN`. */
export function updatesOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = env.DSHG_UPDATES_ORIGIN
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : DEFAULT_UPDATES_ORIGIN
}

const PROXY_CACHE_KEY = 'network.githubProxy'
const PREFERRED_CACHE_KEY = 'network.githubPreferred'
