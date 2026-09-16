/**
 * Official-site linkage: every plugin in the galaxy can point at its page on the
 * operator's own website.
 *
 * The association is a KEY, not a name. Names are not unique in a catalog of
 * thousands (the live catalog has 152 duplicated display names), so a link built
 * from `name` can silently open the wrong plugin. The site's directory already
 * carries `key = owner/name` for exactly this reason, and this module derives the
 * same key from the same row fields — so both sides agree by construction.
 *
 * Where the website lives is discovered, not hard-coded:
 *
 *  - `DSHG_SITE_URL` names it explicitly (any site, any path);
 *  - otherwise a catalog served BY a site implies that site's origin — but only
 *    for rows that actually carry a `key`, which is the marker of a site-built
 *    catalog. An upstream catalog (no `key` field) therefore never grows links
 *    to a site that has never heard of those plugins.
 *
 * A row without a link simply keeps its other actions; nothing is invented.
 */

import type { GalaxyRuntime } from '../core/runtime.ts'
import { readGalaxyState } from '../core/state.ts'
import type { Registry, RegistryPlugin } from '../core/types.ts'

/** Explicit base of the operator's plugin site, e.g. `https://www.yhaigc.cn`. */
export const SITE_URL_ENV = 'DSHG_SITE_URL'

/** Path the plugin pages live under, as the site's hash router defines it. */
const SITE_PLUGIN_PATH = '#/ai/p/'

/** Where a resolved base came from, for diagnostics. */
export type SiteBaseSource = 'env' | 'state' | 'catalog-origin'

export interface SiteBase {
  /** Normalized base without a trailing slash. */
  base: string
  source: SiteBaseSource
}

/** Drop a trailing slash so `<base>/#/ai/p/x` never becomes `//#/ai/p/x`. */
function normalizeBase(value: string): string | undefined {
  const trimmed = value.trim().replace(/\/+$/u, '')
  if (trimmed === '') return undefined
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return trimmed
  } catch {
    return undefined
  }
}

/**
 * The site base in force, or undefined when there is none.
 *
 * Precedence: the explicit `DSHG_SITE_URL`, then this profile's own stored
 * `siteUrl`, then the origin the (env- or profile-configured) catalog is served
 * from — which is how a self-hosted catalog links back to its own site without
 * any extra configuration.
 */
export function siteBase(
  env: NodeJS.ProcessEnv = process.env,
  state?: { siteUrl?: string; catalogUrl?: string },
): SiteBase | undefined {
  const fromEnv = normalizeBase(env[SITE_URL_ENV] ?? '')
  if (fromEnv !== undefined) return { base: fromEnv, source: 'env' }
  const fromState = normalizeBase(state?.siteUrl ?? '')
  if (fromState !== undefined) return { base: fromState, source: 'state' }
  const envCatalog = (env.DSHG_REGISTRY_URL ?? '').trim()
  const catalog = envCatalog !== '' ? envCatalog : (state?.catalogUrl ?? '')
  if (catalog.trim() === '') return undefined
  try {
    const url = new URL(catalog.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return { base: normalizeBase(url.origin) ?? url.origin, source: 'catalog-origin' }
  } catch {
    return undefined
  }
}

/**
 * The site's key for one catalog row.
 *
 * `owner/name` — the row's own fields, exactly as the site's catalog builder
 * composes it. A catalog that ships its own `key` wins, because that is the
 * site's own spelling of the same thing.
 */
export function siteKeyOf(plugin: RegistryPlugin): string | undefined {
  const explicit = typeof (plugin as { key?: unknown }).key === 'string'
    ? ((plugin as { key?: string }).key ?? '').trim()
    : ''
  if (explicit !== '') return explicit
  const owner = (plugin.owner ?? '').trim()
  const name = (plugin.name ?? '').trim()
  if (owner === '' || name === '') return undefined
  return `${owner}/${name}`
}

/** The plugin's page on the site, or undefined when it has none. */
export function siteUrlFor(plugin: RegistryPlugin, resolved: SiteBase | undefined): string | undefined {
  if (resolved === undefined) return undefined
  // A derived base is trusted only for rows the site itself published (they carry
  // `key`); an explicit base is the operator saying "link everything there".
  const hasSiteKey = typeof (plugin as { key?: unknown }).key === 'string'
    && ((plugin as { key?: string }).key ?? '').trim() !== ''
  if (resolved.source === 'catalog-origin' && !hasSiteKey) return undefined
  const key = siteKeyOf(plugin)
  if (key === undefined) return undefined
  return `${resolved.base}/${SITE_PLUGIN_PATH}${encodeURIComponent(key)}`
}

/** The registry with `siteUrl` attached to every row that has a page. */
export interface SiteLinkedRegistry {
  registry: Registry
  /** The base in force, when there is one. */
  base?: string
  /** Where that base came from (`env` = explicit, `catalog-origin` = derived). */
  source?: SiteBaseSource
  /** True when at least one row actually received a link. */
  linked: boolean
}

/** Attach links to every eligible row. One implementation, two resolvers. */
function attach(registry: Registry, resolved: SiteBase | undefined): SiteLinkedRegistry {
  if (resolved === undefined) return { registry, linked: false }
  let linked = false
  const plugins = registry.plugins.map((plugin) => {
    const siteUrl = siteUrlFor(plugin, resolved)
    if (siteUrl === undefined) return plugin
    linked = true
    return { ...plugin, siteUrl }
  })
  return { registry: { ...registry, plugins }, base: resolved.base, source: resolved.source, linked }
}

/**
 * Attach the official page to each catalog row, resolving the site from the
 * environment (see the module header). Pure and total: a registry with no rows,
 * or no site base, comes back with `linked: false`.
 */
export function withSiteLinks(registry: Registry, env: NodeJS.ProcessEnv = process.env): SiteLinkedRegistry {
  return attach(registry, siteBase(env))
}

/** Structural runtime surface needed to cache the resolved base per mount. */
interface SiteRuntimeLike {
  cache<T>(key: string): T | undefined
  setCache(key: string, value: unknown): void
}

const SITE_CACHE_KEY = 'site-base'

/**
 * The site base for this mount, resolved once.
 *
 * Both the environment and the catalog URL are fixed at boot, and `/registry` is
 * polled, so re-parsing them per request would be pure overhead.
 */
export function siteBaseFor(runtime: SiteRuntimeLike & { dir?: string }, env: NodeJS.ProcessEnv = process.env): SiteBase | undefined {
  const cached = runtime.cache<SiteBase | null>(SITE_CACHE_KEY)
  if (cached !== undefined) return cached === null ? undefined : cached
  let state: { siteUrl?: string; catalogUrl?: string } | undefined
  if (typeof runtime.dir === 'string' && runtime.dir !== '') {
    try {
      state = readGalaxyState(runtime.dir)
    } catch {
      // An unreadable state file simply means "no profile-scoped override".
    }
  }
  const resolved = siteBase(env, state)
  runtime.setCache(SITE_CACHE_KEY, resolved ?? null)
  return resolved
}

/** {@link withSiteLinks} for callers that have a mount runtime instead of an env. */
export function linkedRegistryFor(runtime: GalaxyRuntime & SiteRuntimeLike, registry: Registry): SiteLinkedRegistry {
  return attach(registry, siteBaseFor(runtime))
}
