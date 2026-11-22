/**
 * The per-plugin intro text published on the operator's website.
 *
 * The plugin catalog and the website catalog are two projections of the same
 * directory, but only the site's copy carries the reader-facing prose
 * (`desc` / `descFull`, plus the English `descEn`). The card's 简介 dialog reads
 * that copy from the site's own `/assets/plugins/catalog.json`, keyed by the
 * same `owner/name` the site uses for its plugin page, so a renamed or newly
 * written intro appears without a plugin release.
 *
 * The fetch lives on the server for two reasons: the site is a static file with
 * no CORS headers, and one cached download (~550 KB for the whole directory)
 * serves every card's dialog instead of one request per click.
 */

import { fetchJson } from '../core/net.ts'

/** The prose one plugin has on the site. */
export interface SiteIntro {
  /** `owner/name`, the site's own key for the page. */
  key: string
  name?: string
  /** The short card line (`desc`). */
  description?: string
  /** The full intro (`descFull`) — the dialog's preferred text. */
  descriptionFull?: string
  /** The English full intro (`descEn`), when the site ships one. */
  descriptionEn?: string
}

/** Static catalog path, beside the site's app assets. */
export const SITE_CATALOG_PATH = '/assets/plugins/catalog.json'

/** One hour is long for prose that changes with the site's deploy cadence. */
export const SITE_INTRO_TTL_MS = 10 * 60 * 1000

interface IntroIndex {
  byKey: Map<string, SiteIntro>
  byName: Map<string, SiteIntro>
}

let cache: (IntroIndex & { base: string; at: number }) | null = null
let pending: { base: string; promise: Promise<IntroIndex> } | null = null

/** Drop the cached site catalog (tests, and a forced revalidation). */
export function clearSiteIntroCache(): void {
  cache = null
  pending = null
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    // The site's copy is prose; keep a literal line break where it has one and
    // drop the one long entry that carries markup rather than text.
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .trim()
  return clean === '' ? undefined : clean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Turn one site catalog into the lookup the route uses. Pure so the mapping
 * (short/full/English, key/name fallbacks) can be tested without the network.
 */
export function indexSiteCatalog(value: unknown): IntroIndex {
  const byKey = new Map<string, SiteIntro>()
  const byName = new Map<string, SiteIntro>()
  const root = record(value)
  const plugins = root?.plugins
  if (!Array.isArray(plugins)) return { byKey, byName }
  for (const item of plugins) {
    const row = record(item)
    if (row === undefined) continue
    const key = text(row.key)
    const name = text(row.name)
    const description = text(row.desc)
    const descriptionFull = text(row.descFull)
    const descriptionEn = text(row.descEn)
    if (key === undefined && name === undefined) continue
    const intro: SiteIntro = {
      key: key ?? name ?? '',
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(descriptionFull === undefined ? {} : { descriptionFull }),
      ...(descriptionEn === undefined ? {} : { descriptionEn }),
    }
    if (key !== undefined && !byKey.has(key)) byKey.set(key, intro)
    if (name !== undefined && !byName.has(name)) byName.set(name, intro)
  }
  return { byKey, byName }
}

async function download(base: string, force: boolean): Promise<IntroIndex> {
  if (!force && cache !== null && cache.base === base && Date.now() - cache.at < SITE_INTRO_TTL_MS) {
    return cache
  }
  if (!force && pending !== null && pending.base === base) return await pending.promise
  const url = `${base.replace(/\/+$/u, '')}${SITE_CATALOG_PATH}`
  const promise = (async (): Promise<IntroIndex> => {
    const response = await fetchJson({
      url,
      timeoutMs: 15_000,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      throw new Error(response.error ?? `site catalog answered HTTP ${String(response.status)}`)
    }
    const index = indexSiteCatalog(response.body)
    cache = { ...index, base, at: Date.now() }
    return index
  })()
  pending = { base, promise }
  try {
    return await promise
  } finally {
    if (pending?.promise === promise) pending = null
  }
}

/**
 * The site's intro for one plugin, preferring its `owner/name` key and falling
 * back to the display name (the installed-only rows have no key).
 */
export async function findSiteIntro(
  base: string,
  query: { key?: string | undefined; name?: string | undefined },
  force = false,
): Promise<SiteIntro | undefined> {
  const index = await download(base, force)
  const key = query.key?.trim()
  if (key !== undefined && key !== '') {
    const exact = index.byKey.get(key)
    if (exact !== undefined) return exact
  }
  const name = query.name?.trim()
  if (name !== undefined && name !== '') {
    return index.byName.get(name) ?? index.byKey.get(name)
  }
  return undefined
}
