/**
 * Which catalog (and which plugin website) this profile reads, and which layer
 * decided it.
 *
 * This is the one setting whose absence made a healthy panel look broken: the
 * values live in the profile's state file and can only be overridden from the
 * environment, so a packaged app that never had them set silently fell back to
 * the built-in public catalog — 4508 rows, no `ranking` block, a MAP-shaped
 * category vocabulary — and the panel showed no featured category and no category
 * selector at all. Reading it is shared between the status payload (what the
 * settings card shows) and the route that writes it.
 *
 * Precedence is reported, not guessed: `DSHG_REGISTRY_URL` wins over the stored
 * value (see `catalogUrl` in the loader), so a save can legitimately appear to do
 * nothing — the card then explains why instead of looking broken.
 */

import { readGalaxyState } from '../core/state.ts'
import { catalogUrl as resolveCatalogUrl } from './registry.ts'

export interface CatalogSourceView {
  /** The profile's stored value; empty when unset. */
  catalogUrl: string
  siteUrl: string
  /** True when an environment variable overrides the stored value. */
  envCatalog: boolean
  envSite: boolean
  /** The URL actually in use right now. */
  effectiveCatalogUrl: string
  catalogSource: 'env' | 'profile' | 'default'
}

/** Read the stored values, the environment overrides, and what wins. */
export function catalogSourceView(dir: string, env: NodeJS.ProcessEnv = process.env): CatalogSourceView {
  const state = readGalaxyState(dir)
  const envCatalog = (env.DSHG_REGISTRY_URL ?? '').trim() !== ''
  const envSite = (env.DSHG_SITE_URL ?? '').trim() !== ''
  const stored = typeof state.catalogUrl === 'string' ? state.catalogUrl : ''
  return {
    catalogUrl: stored,
    siteUrl: typeof state.siteUrl === 'string' ? state.siteUrl : '',
    envCatalog,
    envSite,
    effectiveCatalogUrl: resolveCatalogUrl(env, state),
    catalogSource: envCatalog ? 'env' : (stored !== '' ? 'profile' : 'default'),
  }
}
