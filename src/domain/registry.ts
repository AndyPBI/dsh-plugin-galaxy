/**
 * Curated catalog access.
 *
 * What this module owns:
 *   - the external catalog (JSON over HTTPS, or the
 *    published npm package carried in the profile),
 *   - the catalog payload handed to the browser,
 *   - one validated catalog entry,
 *   - the ETag/Last-Modified memo (per runtime),
 *   - the browse/search panel's first request,
 *   - GET /dsh-galaxy/registry.
 *
 * The catalog is revalidated on every call. The validator this module keeps
 * lets the origin answer "still the same" (304) instead of resending the whole
 * document; it is NEVER used to answer when the origin could not be reached,
 * because an unreachable origin has confirmed nothing. A failed fetch is a
 * failure the caller can show and the user can retry.
 */

import { fetchJson, proxyHint } from '../core/net.ts'
import { logEvent } from '../core/log.ts'
import { profileDir } from '../core/paths.ts'
import { readGalaxyState } from '../core/state.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { Registry, RegistryCategory, RegistryPlugin } from '../core/types.ts'
import { catalogFromPackage } from './catalog-npm.ts'

/** Cache key inside `GalaxyRuntime` for the catalog validators. */
const CACHE_KEY = 'catalog.validators'

/** The curated catalog's stable public address. */
export const DEFAULT_CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'

/**
 * How long to wait for the catalog. A far-away link carrying a few hundred
 * kilobytes over TLS is not a four-second job, and a cut-off that WOULD have
 * answered is more expensive than a slow first paint.
 */
const FETCH_TIMEOUT_MS = 15_000

/** A failure with the facts needed to classify it, for the 502 payload. */
export class CatalogLoadError extends Error {
  /** The underlying cause: `HTTP 404`, a transport message, a parse error. */
  readonly reason: string

  constructor(reason: string, message: string) {
    super(message)
    this.name = 'CatalogLoadError'
    this.reason = reason
  }
}

/**
 * What this process remembers about the catalog it was last served, with the
 * validator identifying that exact body. The URL is stored alongside the
 * validator so a validator is never sent to a different origin than the one
 * that issued it. `version` is the published catalog version (the payload's
 * own `updated` stamp): meaningless to an HTTP origin, but the equivalent of
 * an ETag for a versioned source and what a log or a rollback would name.
 */
interface CatalogValidation {
  url: string
  etag: string | null
  modified: string | null
  version: string | null
  data: Registry
}

/** The catalog URL in force: the environment override, else the public one. */
export function catalogUrl(env: NodeJS.ProcessEnv = process.env, state?: { catalogUrl?: string }): string {
  const raw = env.DSHG_REGISTRY_URL
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (trimmed !== '') return trimmed
  // Profile-scoped second: a deployment copies the profile, and the catalog a
  // server reads is part of that deployment — not of whoever launched the
  // process. The environment still wins, so ops keeps the last word.
  const stored = typeof state?.catalogUrl === 'string' ? state.catalogUrl.trim() : ''
  return stored === '' ? DEFAULT_CATALOG_URL : stored
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** One catalog entry, or undefined when it cannot be installed at all. */
function asRegistryPlugin(value: unknown): RegistryPlugin | undefined {
  const record = asObject(value)
  if (record === undefined) return undefined
  const name = nonEmptyString(record.name)
  if (name === undefined) return undefined
  const url = nonEmptyString(record.url)
  const npm = nonEmptyString(record.npm)
  const tarball = nonEmptyString(record.tarball)
  // A row that names no source at all cannot be installed; a catalog is not a
  // reading list, so it is dropped rather than rendered as a dead card.
  if (url === undefined && npm === undefined && tarball === undefined) return undefined

  const plugin: RegistryPlugin = { name }
  if (url !== undefined) plugin.url = url
  if (npm !== undefined) plugin.npm = npm
  if (tarball !== undefined) plugin.tarball = tarball
  // The label the site shows (`repo#subpath` → `repo subpath`). Rows are rebuilt
  // field by field, so a field that is not copied here is a field the panel
  // silently loses — that is how monorepo entries ended up displayed with the
  // raw `#` while the website showed a readable name.
  const displayName = nonEmptyString(record.displayName)
  if (displayName !== undefined) plugin.displayName = displayName
  const owner = nonEmptyString(record.owner)
  if (owner !== undefined) plugin.owner = owner
  const category = record.category
  if (typeof category === 'string' && category.trim() !== '') {
    plugin.category = category.trim()
  } else if (Array.isArray(category)) {
    const categories = category.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    if (categories.length > 0) plugin.category = categories.join(', ')
  }
  const description = nonEmptyString(record.description)
  if (description !== undefined) plugin.description = description
  if (typeof record.stars === 'number' && Number.isFinite(record.stars)) plugin.stars = record.stars
  if (typeof record.downloads === 'number' && Number.isFinite(record.downloads)) plugin.downloads = record.downloads
  const install = nonEmptyString(record.install)
  if (install !== undefined) plugin.install = install
  const added = nonEmptyString(record.added)
  if (added !== undefined) plugin.added = added
  if (typeof record.deprecated === 'boolean') plugin.deprecated = record.deprecated
  const replacement = nonEmptyString(record.replacement)
  if (replacement !== undefined) plugin.replacement = replacement
  if (Array.isArray(record.screenshots)) {
    const screenshots = record.screenshots.filter((item): item is string => typeof item === 'string')
    if (screenshots.length > 0) plugin.screenshots = screenshots
  }
  const comments = nonEmptyString(record.comments)
  if (comments !== undefined) plugin.comments = comments
  const hostVersion = nonEmptyString(record.hostVersion)
  if (hostVersion !== undefined) plugin.hostVersion = hostVersion
  const homepage = nonEmptyString(record.homepage)
  if (homepage !== undefined) plugin.homepage = homepage
  // The site-built catalog's own identity for this row. Dropping it here (this
  // builds rows field by field, so unknown keys do not survive) silently disabled
  // every official-site link: `siteUrlFor` trusts a catalog-origin base only for
  // rows that carry a `key`.
  const key = nonEmptyString(record.key)
  if (key !== undefined) plugin.key = key
  // Recommendation fields, when the catalog ships them. Dropped here they would
  // be invisible to the whole UI (this builder only copies known fields).
  if (typeof record.score === 'number' && Number.isFinite(record.score)) plugin.score = record.score
  const band = nonEmptyString(record.band)
  if (band !== undefined) plugin.band = band
  const scoreVersion = nonEmptyString(record.scoreVersion)
  if (scoreVersion !== undefined) plugin.scoreVersion = scoreVersion
  const pinReason = nonEmptyString(record.pinReason)
  if (pinReason !== undefined) plugin.pinReason = pinReason
  const parts = asObject(record.scoreParts)
  if (parts !== undefined) {
    const scoreParts: Record<string, number> = {}
    for (const [name, value] of Object.entries(parts)) {
      if (typeof value === 'number' && Number.isFinite(value)) scoreParts[name] = value
    }
    if (Object.keys(scoreParts).length > 0) plugin.scoreParts = scoreParts
  }
  return plugin
}

/**
 * Validate an untrusted catalog payload.
 *
 * The catalog is an external document that grows by hundreds of entries a
 * day, so one malformed row must cost that row and nothing else: entries
 * without a usable name or without any installable source are dropped, and
 * the number dropped is logged. A payload that is not an object with a
 * `plugins` array is not a catalog at all and throws.
 */
/**
 * Parse a catalog's recommendation block, or undefined when it carries none.
 *
 * `top` is kept in the order the site published — that order IS the ranking, so
 * it is never re-sorted here.
 */
function asRegistryRanking(value: unknown): Registry['ranking'] {
  const record = asObject(value)
  if (record === undefined) return undefined
  const version = nonEmptyString(record.version) ?? 'unknown'
  const top = Array.isArray(record.top)
    ? record.top.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
  if (top.length === 0) return undefined
  const pins: Array<{ key: string; reason: string }> = []
  if (Array.isArray(record.pins)) {
    for (const pin of record.pins) {
      const entry = asObject(pin)
      if (entry === undefined) continue
      const key = nonEmptyString(entry.key)
      if (key === undefined) continue
      pins.push({ key, reason: nonEmptyString(entry.reason) ?? '' })
    }
  }
  const window = typeof record.window === 'number' && Number.isFinite(record.window) && record.window > 0
    ? Math.floor(record.window)
    : undefined
  return {
    version,
    top,
    ...(nonEmptyString(record.generatedAt) === undefined ? {} : { generatedAt: nonEmptyString(record.generatedAt) as string }),
    ...(window === undefined ? {} : { window }),
    ...(pins.length === 0 ? {} : { pins }),
  }
}

function asRegistry(value: unknown): Registry {
  const record = asObject(value)
  if (record === undefined) throw new Error('the catalog payload is not a JSON object')
  if (!Array.isArray(record.plugins)) throw new Error('the catalog payload carries no plugins array')

  const plugins: RegistryPlugin[] = []
  let dropped = 0
  for (const item of record.plugins) {
    const plugin = asRegistryPlugin(item)
    if (plugin === undefined) {
      dropped += 1
      continue
    }
    plugins.push(plugin)
  }
  if (dropped > 0) {
    logEvent('warn', 'registry', `dropped ${dropped} catalog ${dropped === 1 ? 'entry' : 'entries'} with no usable name or source`)
  }
  if (plugins.length === 0) {
    logEvent('warn', 'registry', 'the catalog carries no usable plugin entries')
  }

  const registry: Registry = { plugins, count: plugins.length }
  const updated = nonEmptyString(record.updated)
  if (updated !== undefined) registry.updated = updated
  // The vocabulary the rows' `category` slugs are drawn from. The site ships
  // objects `{id,label,labelEn,count}`; older catalogs shipped a bare string
  // list, so both normalize here — dropping the objects (a `typeof item ===
  // 'string'` filter did exactly that) is how every card fell back to printing
  // the raw slug.
  const categories = normalizeCategories(record.categories)
  if (categories.length > 0) registry.categories = categories
  // The recommendation block must survive this rebuild: it is what the "未安装"
  // view renders, and a catalog that ships one should not have it silently
  // dropped (the same way the per-row `key` was, which disabled every site link).
  const ranking = asRegistryRanking(record.ranking)
  if (ranking !== undefined) registry.ranking = ranking
  return registry
}

/**
 * Normalize a catalog's category vocabulary into {@link RegistryCategory}[].
 *
 * Two shapes are in the wild and both must work, because the panel's category
 * surfaces are entirely data-driven — a dropped vocabulary is an invisible
 * selector and no featured chip:
 *
 *   - the community site ships an ARRAY of objects: `[{ id, label, labelEn, count }]`
 *   - the public aggregate ships a MAP keyed by slug: `{ agi: { zh, en } }`
 *
 * Older catalogs shipped bare strings in either position, which become an id-only
 * entry (the label then falls back to the slug). Label keys are read in the order
 * `label` → `zh` → `name`, and `labelEn` → `en`, so neither vocabulary has to be
 * rewritten to fit this plugin.
 */
export function normalizeCategories(input: unknown): RegistryCategory[] {
  const items: unknown[] = Array.isArray(input)
    ? input
    : (input !== null && typeof input === 'object'
        ? Object.entries(input as Record<string, unknown>).map(([id, value]) => (
            value !== null && typeof value === 'object'
              ? { id, ...(value as Record<string, unknown>) }
              : { id, label: value }
          ))
        : [])

  const categories: RegistryCategory[] = []
  for (const item of items) {
    if (typeof item === 'string') {
      const id = item.trim()
      if (id !== '') categories.push({ id })
      continue
    }
    if (item === null || typeof item !== 'object') continue
    const entry = item as {
      id?: unknown
      label?: unknown
      labelEn?: unknown
      zh?: unknown
      en?: unknown
      name?: unknown
      count?: unknown
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '') continue
    const label = nonEmptyString(entry.label) ?? nonEmptyString(entry.zh) ?? nonEmptyString(entry.name)
    const labelEn = nonEmptyString(entry.labelEn) ?? nonEmptyString(entry.en)
    categories.push({
      id,
      ...(label === undefined ? {} : { label }),
      ...(labelEn === undefined ? {} : { labelEn }),
      ...(typeof entry.count === 'number' && Number.isFinite(entry.count) ? { count: entry.count } : {}),
    })
  }
  return categories
}

/** The validator held for `url`, when one is held at all. */
function validatorFor(url: string, runtime?: GalaxyRuntime): CatalogValidation | undefined {
  if (runtime === undefined) return undefined
  const stored = runtime.cache<CatalogValidation>(CACHE_KEY)
  return stored !== undefined && stored.url === url ? stored : undefined
}

/**
 * Remember the served catalog and its validator.
 *
 * Without a runtime there is nowhere to keep it: per the module contract the
 * validators live in `GalaxyRuntime`, so a caller that passes no runtime
 * simply makes an unconditional request every time. That is deliberate — the
 * alternative, a module-level memo, is exactly the process-wide state the
 * contract forbids, and a stale process-wide catalog is indistinguishable
 * from a fresh one on screen.
 */
function storeValidator(runtime: GalaxyRuntime | undefined, value: CatalogValidation): void {
  if (runtime === undefined) return
  runtime.setCache(CACHE_KEY, value)
}

/**
 * One revalidated fetch of the catalog URL.
 *
 * A transport failure or a 5xx answer is retried once: those are the shapes a
 * long, lossy path produces, and with nothing behind this call a transient
 * failure is a market with no plugins in it. A 4xx answer, unparseable JSON or
 * an invalid payload is not retried — the same question would get the same
 * answer.
 */
async function fetchRegistry(url: string, force: boolean, runtime?: GalaxyRuntime): Promise<Registry> {
  // A validator only travels to the origin that issued it. `force` skips
  // revalidation entirely, which is what the UI's explicit refresh asks for.
  const reusable = force ? undefined : validatorFor(url, runtime)
  const headers: Record<string, string> = { accept: 'application/json' }
  // ETag first: it is exact, while a date has one-second resolution and a
  // catalog republished twice inside the same second would validate as
  // unchanged. Only one is sent — an origin given both must satisfy both,
  // which turns a weak ETag match into an unnecessary full download.
  if (reusable !== undefined && reusable.etag !== null) headers['if-none-match'] = reusable.etag
  else if (reusable !== undefined && reusable.modified !== null) headers['if-modified-since'] = reusable.modified

  let lastMessage = 'the catalog could not be fetched'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchJson({ url, headers, timeoutMs: FETCH_TIMEOUT_MS })
    if (response.status === 304) {
      // Only reachable when a validator was sent, so `reusable` exists;
      // guarded anyway, because answering a 304 with nothing to reuse would
      // otherwise surface as a confusing parse error on an empty body.
      if (reusable === undefined) throw new Error('the catalog answered "not modified" with nothing to revalidate')
      return reusable.data
    }
    if (response.ok) {
      const registry = asRegistry(response.body)
      storeValidator(runtime, {
        url,
        etag: response.headers.etag ?? null,
        modified: response.headers['last-modified'] ?? null,
        version: registry.updated ?? null,
        data: registry,
      })
      return registry
    }
    lastMessage = response.error !== undefined && response.error !== ''
      ? response.error
      : `HTTP ${response.status}`
    const transient = response.status === 0 || response.status >= 500
    if (!transient) throw new Error(lastMessage)
  }
  throw new Error(lastMessage)
}

/**
 * The catalog, revalidated against its origin on every call.
 *
 * @param profile - profile name, used to locate the profile when `dir` is blank.
 * @param dir - resolved profile directory.
 * @param force - skip conditional revalidation (an explicit user refresh).
 * @param runtime - per-mount state holding the ETag/Last-Modified memo. The
 *   published contract calls this function with three arguments; the fourth is
 *   optional and its absence only means no validator is reused.
 * @throws {CatalogLoadError} when neither the origin nor the installed catalog
 *   package can supply a catalog. The message names the reason and
 *   `proxyHint()`, so a bug report can tell a blocked proxy from a slow link.
 */
export async function loadRegistry(
  profile: string,
  dir: string,
  force?: boolean,
  runtime?: GalaxyRuntime,
): Promise<Registry> {
  const directory = dir.trim() === '' ? profileDir(profile) : dir
  const url = catalogUrl(process.env, readGalaxyState(directory))
  const started = Date.now()
  let reason = 'the catalog could not be fetched'

  try {
    return await fetchRegistry(url, force === true, runtime)
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }

  // Fallback, and why it is acceptable: this reads the catalog that ships
  // INSIDE the published `dsh-plugin-catalog` package, from the profile's own
  // node_modules. It is not a cached network response and not a bundled
  // publish-time snapshot of the live file — it is an artifact the package
  // manager already placed on this machine, version-pinned and integrity-
  // checked, and the only download it can save is the one that just failed.
  // It is never silent: the attempt is logged and the returned payload is
  // tagged with `source`, so the UI can show that it is not the live catalog.
  const packaged = catalogFromPackage(directory)
  if (packaged !== undefined) {
    logEvent('warn', 'registry', `live catalog unreachable (${reason}); using the installed ${packaged.source ?? 'catalog package'} instead`)
    return packaged
  }

  const elapsed = Math.round((Date.now() - started) / 1000)
  throw new CatalogLoadError(
    reason,
    `catalog fetch failed: ${reason} · ${proxyHint()} (${elapsed}s)`,
  )
}

/**
 * Drop the cached validators so the next call is unconditional.
 *
 * Called when the download region changes: a validator issued by one origin
 * must never be replayed to another, and a 304 from an origin whose body this
 * process has never seen would be answered with someone else's catalog.
 */
export function forgetCatalog(runtime?: GalaxyRuntime): void {
  if (runtime === undefined) return
  runtime.caches.delete(CACHE_KEY)
  logEvent('info', 'registry', 'forgot the cached catalog validators')
}
