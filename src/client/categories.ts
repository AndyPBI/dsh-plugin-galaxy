/**
 * The category labels the panel shows.
 *
 * The site owns the vocabulary: a row carries a `category` SLUG (`curated`) and
 * the catalog ships the table that maps it to what users read (`甄选` /
 * `Featured`). The panel used to print the slug, so a newly added category showed
 * up as its id and the site could not rename one without the two surfaces
 * disagreeing — the same failure `displayName` had for plugin names.
 *
 * Pure and language-explicit: the badge reads it during render and the search
 * index reads it again, so it must not look anything up on its own.
 */

import type { RegistryCategory } from './market-data.ts'

/** Whether a host language value (`en`, `en-US`, `en-GB`) selects the English labels. */
export function isEnglishLanguage(language: string | undefined): boolean {
  return typeof language === 'string' && /^en\b/iu.test(language.trim())
}

/** One slug resolved against the published table. */
function oneLabel(slug: string, categories: readonly RegistryCategory[] | undefined, english: boolean): string {
  const entry = categories?.find(candidate => candidate.id.toLowerCase() === slug.toLowerCase())
  if (entry === undefined) return slug
  const preferred = english ? entry.labelEn : entry.label
  const fallback = english ? entry.label : entry.labelEn
  const chosen = preferred !== undefined && preferred !== '' ? preferred : fallback
  return chosen !== undefined && chosen !== '' ? chosen : slug
}

/**
 * The label(s) for a row's `category`, or `undefined` when it has none.
 *
 * A row may carry several slugs (older rows joined them with `, `), and each one
 * is resolved independently: an unknown slug stays as-is rather than blanking the
 * badge, so a site-side addition still shows something useful before the table
 * arrives.
 */
export function categoryText(
  category: string | undefined,
  categories: readonly RegistryCategory[] | undefined,
  english: boolean,
): string | undefined {
  if (typeof category !== 'string') return undefined
  const slugs = category.split(',').map(part => part.trim()).filter(part => part !== '')
  if (slugs.length === 0) return undefined
  const labels = slugs.map(slug => oneLabel(slug, categories, english))
  return labels.join(english ? ', ' : '、')
}
