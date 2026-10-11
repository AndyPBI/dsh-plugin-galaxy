/**
 * Plugin Galaxy — the settings section.
 *
 * Everything the browser knows about the server comes from `market-data.ts`;
 * every payload type below is derived from that module's own signatures, so a
 * change to a wire shape is a compile error here rather than a silent
 * undefined at runtime. There is no module-level state and no side effect
 * outside effects: the initial load, the status poll and the user's own
 * mutations are the only things that talk to the server.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
// Icons come from the runtime resolver: the host renamed every glyph in 0.2.x
// (size suffix → weight suffix), so a static name would be gone on one of them.
import { IconRefresh, IconSearch } from './icons.ts'
import css from './Galaxy.module.css'
import { NS } from './locales.ts'
import {
  approveBuilds,
  cancelOperation,
  discoveryCompatibility,
  favoriteUrl,
  fetchChangelog,
  fetchCheck,
  fetchInstalled,
  fetchRegistry,
  fetchStatus,
  fetchUpdates,
  groupAction,
  installPlugin,
  isGalaxyApiError,
  recordFromStatus as deriveRecords,
  rollbackOperation,
  saveNote,
  setupPnpm,
  togglePlugin,
  uninstallPlugin,
  updatePlugin,
  useSkin,
} from './market-data.ts'
import { categoryEntryLabel, categoryText, isEnglishLanguage } from './categories.ts'
import type { RegistryCategory } from './market-data.ts'
// Host-service and group vocabulary shapes live with the API client; importing
// them (rather than re-declaring) keeps this file wired to the same types the
// entry point passes in.
import type {
  GroupAction,
  GroupPayload,
  LocaleServiceLike,
  ThemeServiceLike,
  ThemeSnapshot,
  ThemeStore,
  Translate,
} from './market-data.ts'
import { CommentsModal } from './CommentsModal.tsx'
import { commentCount } from './comments.ts'
import { Diagnostics } from './Diagnostics.tsx'
import { bucketOf } from './operations.ts'
import { OperationsPanel } from './OperationsPanel.tsx'
import { PresetPanel } from './preset-panel.tsx'
import { SnapshotPanel } from './snapshot-panel.tsx'

/* ------------------------------------------------------------------ *
 * Payload shapes, taken from the API client so they cannot drift
 * ------------------------------------------------------------------ */

type Registry = Awaited<ReturnType<typeof fetchRegistry>>['registry']
type RegistryPlugin = Registry['plugins'][number]
type InstalledPayload = Awaited<ReturnType<typeof fetchInstalled>>
type InstalledPlugin = InstalledPayload['installed'][number]
type UpdateStatus = Awaited<ReturnType<typeof fetchUpdates>>[number]
type GalaxyStatus = Awaited<ReturnType<typeof fetchStatus>>
type HostCompatibility = Awaited<ReturnType<typeof discoveryCompatibility>>[number]
type ChangelogPayload = Awaited<ReturnType<typeof fetchChangelog>>
type DiagnosticReport = Awaited<ReturnType<typeof fetchCheck>>
type OperationRecord = Parameters<typeof deriveRecords>[0][number]

/* ------------------------------------------------------------------ *
 * View vocabulary
 * ------------------------------------------------------------------ */

/** The four tabs of the section. */
const TAB_IDS = ['discover', 'installed', 'favorites', 'themes'] as const
type GalaxyTab = (typeof TAB_IDS)[number]

/** Locale keys of the tab labels, kept beside the ids so they cannot drift. */
const TAB_LABEL: Record<GalaxyTab, string> = {
  discover: 'tabDiscover',
  installed: 'tabInstalled',
  favorites: 'tabFavorites',
  themes: 'tabThemes',
}

const TAB_ENTRY: Record<GalaxyTab, string> = {
  discover: 'discover',
  installed: 'installed',
  favorites: 'favorites',
  themes: 'themes',
}

const FILTERS = [
  { id: 'all', label: 'filterAll' },
  { id: 'installed', label: 'filterInstalled' },
  /*
   * The entry that renders the website's recommendation list. When the catalog
   * carries a `ranking` block it IS 「推荐」 — the first `window` rows of
   * `ranking.top`, numbered 1, 2, 3… — so that is what the chip is called. A
   * catalog without one (the upstream public catalog) has no ranking to show, and
   * the same entry degrades to the plain 「未安装」 list, so the label degrades too:
   * a chip called 「推荐」 that lists thousands of unrelated plugins would be a lie.
   */
  { id: 'not-installed', label: 'filterRecommended', fallbackLabel: 'filterNotInstalled' },
  { id: 'update-available', label: 'filterUpdateable' },
  { id: 'incompatible', label: 'filterIncompatible' },
] as const
type DiscoverFilter = (typeof FILTERS)[number]['id']

/**
 * Discover cards rendered at once. The live catalog carries thousands of
 * entries; laying all of them out at once is both slow and visually unstable
 * (the grid keeps reflowing while the browser works through the tree). The
 * result count still reports the full total, and one button reveals the next
 * page.
 */
const DISCOVER_PAGE_SIZE = 60

/** 「未安装」= 推荐榜时，一次显示多少条（缺省 20；目录里可覆盖）。 */
const RECOMMEND_WINDOW = 20

/**
 * How long a mutation may run before the panel stops being quietly busy and
 * offers the operator a way out.
 *
 * Package work legitimately takes a while (resolution over a 3561-entry
 * catalog, tarball downloads, native builds), so the watchdog is not a timeout:
 * nothing is cancelled, the spinner keeps running, and the elapsed counter
 * appears next to a cancel button. Before this, a request that never answered —
 * a killed package manager holding the install lock — left the panel showing a
 * bare "busy" line forever, with every control disabled and no error to read.
 */
const MUTATION_WATCHDOG_MS = 20_000

/**
 * The point where waiting stops being useful. Deliberately longer than the
 * server's own package-manager timeout (`DSHG_INSTALL_TIMEOUT_MS`, 15 minutes by
 * default) so a slow-but-alive install is never abandoned by the panel while the
 * server still considers it running.
 */
const MUTATION_CAP_MS = 20 * 60_000

/**
 * Thrown into the mutation race when the panel stops waiting — by the operator
 * cancelling, or by the cap above. Distinguishes "we gave up" from a real
 * server failure, which must keep its own message.
 */
class MutationAbandoned extends Error {
  constructor(readonly reason: 'cancelled' | 'timeout') {
    super(`mutation abandoned: ${reason}`)
    this.name = 'MutationAbandoned'
  }
}

type SortField = 'name' | 'stars' | 'downloads' | 'added'
type SortDir = 'asc' | 'desc'
type SortKey = `${SortField}-${SortDir}`

const SORTS = [
  { id: 'name-asc', field: 'sortName', dir: 'sortAsc' },
  { id: 'name-desc', field: 'sortName', dir: 'sortDesc' },
  { id: 'stars-desc', field: 'sortStars', dir: 'sortDesc' },
  { id: 'stars-asc', field: 'sortStars', dir: 'sortAsc' },
  { id: 'downloads-desc', field: 'sortDownloads', dir: 'sortDesc' },
  { id: 'downloads-asc', field: 'sortDownloads', dir: 'sortAsc' },
  { id: 'added-desc', field: 'sortAdded', dir: 'sortDesc' },
  { id: 'added-asc', field: 'sortAdded', dir: 'sortAsc' },
] as const satisfies ReadonlyArray<{ id: SortKey; field: string; dir: string }>

/** One Discover card's data, computed once per listing render. */
interface DiscoverRow {
  /**
   * Stable, unique React key.
   *
   * The live catalog repeats display names heavily (152 names, 383 entries), so
   * `plugin.name` collided between siblings. React then reuses DOM nodes across
   * different rows — cards showed another plugin's badges and the grid reflowed,
   * which is the "layout falls apart once I filter" report. The registry index
   * makes the key unique without depending on the name.
   */
  key: string
  plugin: RegistryPlugin
  /** The installed dependency this entry maps onto, when any. */
  installed: InstalledPlugin | undefined
  /** False for a row synthesized from the installed inventory (no catalog row). */
  fromCatalog: boolean
  /**
   * True when another row in the SAME listing shares this display name. Such
   * rows are different plugins that happen to be named alike, so the card also
   * shows the owner to keep them distinguishable.
   */
  duplicateName: boolean
  update: UpdateStatus | undefined
  compatibility: HostCompatibility | undefined
  /** Install target (`url` ?? `npm` ?? name). */
  source: string
  /** Catalog entry suggested for a deprecated plugin. */
  replacement: RegistryPlugin | undefined
  /**
   * Position in the website's recommendation list (1, 2, 3…), set only in the
   * 「推荐」 view, where the order IS the published rank.
   *
   * It is counted over ranked-but-not-installed entries, before the search filter,
   * so a search inside the view still shows a plugin's real rank instead of
   * renumbering the matches.
   */
  rank?: number
}

/** One row of the Themes tab. */
interface ThemeRow {
  name: string
  installed: boolean
  active: boolean
  description?: string
}

/** Every mutation a card or row can start, handed down as ONE object. */
interface MarketActions {
  /** True while the server is busy or a mutation is in flight. */
  busy: boolean
  /** Target label of the in-flight mutation, if any. */
  pending: string | null
  install(plugin: RegistryPlugin): void
  update(name: string): void
  uninstall(name: string): void
  toggle(name: string, enabled: boolean): void
  editNote(name: string): void
  assignGroup(name: string, group: string): void
  favorite(url: string, favorited: boolean): void
  openChangelog(name: string): void
  openComments(plugin: RegistryPlugin): void
  activateTheme(name: string): void
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/** Normalize a host subsection id to a tab, or null when it names none. */
function tabFromPreferred(preferred: string | undefined): GalaxyTab | null {
  if (typeof preferred !== 'string') return null
  const head = preferred.trim().replace(/^ENTRY-/i, '').split(':')[0]!.trim().toLowerCase()
  return TAB_IDS.find(id => id === head) ?? null
}

/** Search term carried after an `id:query` colon, when the host sends one. */
function queryFromPreferred(preferred: string | undefined): string {
  if (typeof preferred !== 'string') return ''
  const separator = preferred.indexOf(':')
  return separator === -1 ? '' : preferred.slice(separator + 1).trim()
}

/** Install target accepted by `dsh plugin add` / `installPlugin`. */
function sourceSpec(plugin: RegistryPlugin): string {
  return plugin.url ?? plugin.npm ?? plugin.name
}

/** The server's message when it sent one, the thrown message otherwise. */
function errorText(error: unknown, fallback: string): string {
  if (isGalaxyApiError(error)) {
    const payload = error.payload
    if (payload !== null && typeof payload === 'object') {
      const record = payload as Record<string, unknown>
      for (const key of ['error', 'reason', 'message', 'detail']) {
        const value = record[key]
        if (typeof value === 'string' && value !== '') return value
      }
    }
    return error.message !== '' ? error.message : fallback
  }
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return fallback
}

/** Theme id of a host snapshot, or null when the host reports none. */
function readThemeId(snapshot: ThemeSnapshot | null): string | null {
  if (snapshot === null) return null
  return typeof snapshot.id === 'string' && snapshot.id !== '' ? snapshot.id : null
}

/** Host-registered themes lifted out of the theme snapshot, when it lists any. */
function readHostThemes(snapshot: ThemeSnapshot | null): ThemeRow[] {
  if (snapshot === null) return []
  const raw = (snapshot as unknown as { themes?: unknown }).themes
  if (!Array.isArray(raw)) return []
  const rows: ThemeRow[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = typeof record.id === 'string' && record.id !== ''
      ? record.id
      : typeof record.name === 'string' ? record.name : ''
    if (name === '') continue
    const description = typeof record.description === 'string' ? record.description : undefined
    rows.push({
      name,
      installed: record.installed === true,
      active: record.active === true,
      ...(description === undefined ? {} : { description }),
    })
  }
  return rows
}

/**
 * Theme bundles, recognized by the catalog categorizing an entry as a theme or
 * by the bundle name (`…-theme`, `…-skin`). The client contract exposes no
 * theme-listing endpoint — `GET /installed` is the only inventory — so the
 * Themes tab derives its candidates from it and adds any theme the host
 * registers in its own theme snapshot.
 */
const THEME_NAME = /(?:^|[-_/@])themes?(?:[-_/@]|$)|[-_](?:theme|skin)s?$/i

function isThemeBundle(name: string, entry: RegistryPlugin | undefined): boolean {
  if (entry !== undefined && typeof entry.category === 'string' && /theme/i.test(entry.category)) return true
  return THEME_NAME.test(name)
}

/** Split a combined sort key into field and direction. */
function parseSortKey(key: SortKey): { field: SortField; dir: SortDir } {
  const separator = key.lastIndexOf('-')
  return {
    field: key.slice(0, separator) as SortField,
    dir: key.slice(separator + 1) as SortDir,
  }
}

/** Human label of a dependency source kind (InstallKind). */
function kindLabel(t: Translate, kind: InstalledPlugin['kind']): string {
  switch (kind) {
    case 'npm': return t('kindNpm')
    case 'git': return t('kindGit')
    case 'local': return t('kindLocal')
    case 'tarball': return t('kindTarball')
    case 'alias': return t('kindAlias')
    default: return t('kindUnknown')
  }
}

/** Compare two Discover rows by the active sort key. */
/** `HH:MM:SS` in the viewer's own timezone, for the "refreshed at" note. */
function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour12: false })
  } catch {
    return ''
  }
}

/** 分档对应的徽标配色：S 绿色、A 中性、B/C 灰。 */
function bandClass(band: string): string {
  if (band === 'S') return css.badgeOk
  if (band === 'A') return css.badge
  return css.badgeMuted
}

/**
 * "为什么推荐" 的悬停说明：总分、档位、得分最高的几项，以及编辑推荐理由。
 *
 * 分项名保持英文键（`popularity` / `scarcity` …），因为它们是**公式的维度名**，
 * 与站点侧 `docs/plugin-ranking.md` 里的权重表一一对应；翻译它们反而对不上账。
 */
function scoreExplanation(plugin: RegistryPlugin, t: Translate): string {
  const parts = Object.entries(plugin.scoreParts ?? {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([name, value]) => `${name} ${String(Math.round(value))}`)
    .join('、')
  const head = `${t('bandLabel')} ${plugin.band ?? '—'}${plugin.score === undefined ? '' : ` · ${String(Math.round(plugin.score))}`}`
  const detail = parts === '' ? '' : ` · ${t('scorePartsLabel')}: ${parts}`
  const pin = plugin.pinReason === undefined || plugin.pinReason === '' ? '' : ` · ${t('pinBadge')}: ${plugin.pinReason}`
  return `${head}${detail}${pin}`
}

/**
 * The catalog's own identity for a row (`key`), or the same `owner/name` rule the
 * site's catalog builder uses. The recommendation list is keyed by it.
 */
function catalogKeyOf(plugin: RegistryPlugin): string | undefined {
  const explicit = typeof plugin.key === 'string' ? plugin.key.trim() : ''
  if (explicit !== '') return explicit
  const owner = (plugin.owner ?? '').trim()
  const name = (plugin.name ?? '').trim()
  if (owner === '' || name === '') return undefined
  return `${owner}/${name}`
}

/**
 * Whether a row belongs to the selected category.
 *
 * `''` means "no category filter". Rows may carry several slugs (older rows joined
 * them with `, `), so the comparison is per slug and case-insensitive: the site's
 * vocabulary is lowercase, but a hand-edited catalog need not be.
 */
function inCategory(plugin: RegistryPlugin, category: string): boolean {
  if (category === '') return true
  const wanted = category.toLowerCase()
  return (plugin.category ?? '')
    .split(',')
    .some(part => part.trim().toLowerCase() === wanted)
}

/**
 * The label a row is DISPLAYED under.
 *
 * The catalog ships `displayName` — the website's own label: monorepo entries are
 * published as `repo#subpath`, which nobody can read, and shown as `repo subpath`.
 * Older catalogs and the upstream public one carry no such field, so the raw
 * `name` is the fallback.
 *
 * Everything that reads a name for HUMANS goes through here (card title, the
 * accessible name, the "two rows share a name" hint, the search haystack).
 * Anything that reads an IDENTITY keeps using `name`/`npm`/`key`: the install
 * spec, the catalog key, the deep link and the inventory match must not follow a
 * label the website can restyle.
 */
function displayLabelOf(plugin: RegistryPlugin): string {
  const label = typeof plugin.displayName === 'string' ? plugin.displayName.trim() : ''
  return label !== '' ? label : plugin.name
}

/** `owner/repo` of a GitHub URL — the identity a git-sourced install matches on. */
function repoOf(url: string | undefined): string | undefined {
  if (typeof url !== 'string' || url === '') return undefined
  const match = /github\.com[/:]([^/#]+)\/([^/#.]+)/u.exec(url)
  return match === null ? undefined : `${match[1]}/${match[2]}`.toLowerCase()
}

/**
 * Catalog entry → installed dependency, by IDENTITY rather than display name.
 *
 * Display names are not identities in the live catalog: `dsh-knowledge` exists
 * in more than one author scope, and the entry whose package is
 * `@lemoncat7/dsh-knowledge` is a different plugin from a bare `dsh-knowledge`
 * install. Matching on the name therefore claimed a plugin was installed when
 * only a namesake was, and the "installed" filter showed two rows for one
 * dependency while omitting three real ones. Identity is the npm specifier for
 * a registry install and the repository for a git install.
 */
function matchInstalled(
  plugin: RegistryPlugin,
  byName: ReadonlyMap<string, InstalledPlugin>,
  byRepo: ReadonlyMap<string, InstalledPlugin>,
): InstalledPlugin | undefined {
  if (typeof plugin.npm === 'string' && plugin.npm !== '') {
    const exact = byName.get(plugin.npm)
    if (exact !== undefined) return exact
  }
  const repo = repoOf(plugin.url)
  return repo === undefined ? undefined : byRepo.get(repo)
}

function compareRows(a: DiscoverRow, b: DiscoverRow, field: SortField, dir: SortDir): number {
  const sign = dir === 'asc' ? 1 : -1
  const number = (value: number | undefined): number => (typeof value === 'number' ? value : -1)
  const date = (value: string | undefined): number => {
    const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
    return Number.isNaN(parsed) ? 0 : parsed
  }
  switch (field) {
    case 'stars': return sign * (number(a.plugin.stars) - number(b.plugin.stars))
    case 'downloads': return sign * (number(a.plugin.downloads) - number(b.plugin.downloads))
    case 'added': return sign * (date(a.plugin.added) - date(b.plugin.added))
    default: return sign * a.plugin.name.localeCompare(b.plugin.name)
  }
}

/** Switch state of a group's members (`on` / `off` / `mixed` / `empty`). */
function groupSwitchState(members: readonly string[], disabled: ReadonlySet<string>): 'on' | 'off' | 'mixed' | 'empty' {
  if (members.length === 0) return 'empty'
  let on = false
  let off = false
  for (const member of members) {
    if (disabled.has(member)) off = true
    else on = true
  }
  return on && off ? 'mixed' : off ? 'off' : 'on'
}

/**
 * Locale key for one progress phase reported by the server.
 *
 * The server names the operation it is running (`install`, `verify`,
 * `activate`, `done`, …); the browser turns it into a word. Unknown phases fall
 * back to the generic "working" label rather than showing a raw identifier.
 */
function phaseLabelKey(phase: string | undefined): string {
  switch (phase) {
    case 'install': return 'phaseInstall'
    case 'verify': return 'phaseVerify'
    case 'activate': return 'phaseActivate'
    case 'done': return 'phaseDone'
    case 'update': return 'phaseUpdate'
    case 'uninstall': return 'phaseUninstall'
    default: return 'busy'
  }
}

/** `已下载 3 · 已新增 1` from the counters the tracker lifted out of pnpm. */
function progressCounters(
  progress: { downloaded?: number; done?: number } | undefined,
  t: Translate,
): string {
  if (progress === undefined) return ''
  const parts: string[] = []
  if (typeof progress.downloaded === 'number') parts.push(`${t('progressDownloaded')} ${String(progress.downloaded)}`)
  if (typeof progress.done === 'number') parts.push(`${t('progressAdded')} ${String(progress.done)}`)
  return parts.join(' · ')
}

/** Catalog URL of an installed dependency, when the catalog knows the package. */
function catalogUrlFor(
  plugin: InstalledPlugin,
  catalog: ReadonlyMap<string, RegistryPlugin>,
): string | undefined {
  const url = catalog.get(plugin.name)?.url
  return url === undefined || url === '' ? undefined : url
}

/**
 * The plugin's page on the operator's website, when the catalog knows it.
 *
 * Looked up through the SAME identity map the rest of the card uses, so an
 * installed plugin and its catalog row cannot disagree about which plugin they
 * are — and so a namesake package never inherits another one's page.
 */
function siteUrlFor(
  plugin: InstalledPlugin,
  catalog: ReadonlyMap<string, RegistryPlugin>,
): string | undefined {
  const url = catalog.get(plugin.name)?.siteUrl
  return url === undefined || url === '' ? undefined : url
}

/** Whether an installed dependency is bookmarked (favorites are keyed by URL). */
function isFavorited(
  plugin: InstalledPlugin,
  catalog: ReadonlyMap<string, RegistryPlugin>,
  favorites: ReadonlySet<string>,
): boolean {
  const url = catalogUrlFor(plugin, catalog)
  return url !== undefined && favorites.has(url)
}

/* ------------------------------------------------------------------ *
 * Subcomponents
 * ------------------------------------------------------------------ */

/**
 * Search + filter + sort + reload strip shared by the Discover, Installed and
 * Favorites tabs. A tab passes only the controls it owns.
 */
function Toolbar(props: {
  t: Translate
  query: string
  onQuery: (value: string) => void
  placeholder: string
  busy: boolean
  onReload: () => void
  filter?: DiscoverFilter
  onFilter?: (value: DiscoverFilter) => void
  /** True when the catalog ships a `ranking` block: 「未安装」 then reads 「推荐」. */
  recommended?: boolean
  sort?: SortKey
  onSort?: (value: SortKey) => void
  /** Selected category slug; `''` = all categories. */
  category?: string
  onCategory?: (value: string) => void
  /** The catalog's vocabulary, in the order the site publishes it. */
  categories?: readonly RegistryCategory[]
  /** Rows per category slug, counted over the whole catalog. */
  categoryCounts?: ReadonlyMap<string, number>
  /** Whether the English labels apply to the category options. */
  english?: boolean
  children?: ReactNode
}) {
  const { t, query, onQuery, placeholder, busy, onReload, filter, onFilter, recommended, sort, onSort, category, onCategory, categories, categoryCounts } = props
  return (
    <div className={css.toolbar}>
      <Input
        className={css.search}
        icon={<IconSearch size={14} />}
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={event => onQuery(event.target.value)}
      />
      {filter !== undefined && onFilter !== undefined && (
        <div className={css.row} role="group" aria-label={t('filterLabel')}>
          {FILTERS.map(entry => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={filter === entry.id}
              className={filter === entry.id ? `${css.tab} ${css.tabActive}` : css.tab}
              onClick={() => onFilter(entry.id)}
            >
              {t('fallbackLabel' in entry && recommended !== true ? entry.fallbackLabel : entry.label)}
            </button>
          ))}
        </div>
      )}
      {sort !== undefined && onSort !== undefined && (
        <label className={css.row}>
          <span className={css.muted}>{t('sortLabel')}</span>
          <select
            className={css.select}
            value={sort}
            aria-label={t('sortLabel')}
            onChange={event => onSort(event.target.value as SortKey)}
          >
            {SORTS.map(entry => (
              <option key={entry.id} value={entry.id}>
                {`${t(entry.field)} · ${t(entry.dir)}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {/*
        * The category selector is driven by the catalog's own vocabulary, in the
        * site's order (curated first): the panel never invents a category list, so
        * a category the site adds appears here without a plugin release.
        */}
      {category !== undefined && onCategory !== undefined && categories !== undefined && categories.length > 0 && (
        <label className={css.row}>
          <span className={css.muted}>{t('categoryFilterLabel')}</span>
          <select
            className={css.select}
            value={category}
            aria-label={t('categoryFilterLabel')}
            onChange={event => onCategory(event.target.value)}
          >
            <option value=''>{t('allCategories')}</option>
            {categories.map(entry => {
              const label = categoryEntryLabel(entry, props.english === true)
              const count = categoryCounts?.get(entry.id)
              return (
                <option key={entry.id} value={entry.id}>
                  {count === undefined ? label : `${label} (${String(count)})`}
                </option>
              )
            })}
          </select>
        </label>
      )}
      {props.children}
      <span className={css.spacer} />
      <Button
        variant="outline"
        size="sm"
        icon={<IconRefresh size={13} />}
        onClick={onReload}
        disabled={busy}
        title={busy ? t('busyWait') : t('reload')}
      >
        {t('reload')}
      </Button>
    </div>
  )
}

/**
 * One Discover card: identity, description, badges (installed / update /
 * compatibility / deprecated) and the actions belonging to the entry itself.
 */
function PluginCard(props: {
  t: Translate
  row: DiscoverRow
  actions: MarketActions
  /** The catalog's category vocabulary, for the label under the title. */
  categories?: readonly RegistryCategory[]
  /** Whether the English labels apply (see `isEnglishLanguage`). */
  english?: boolean
}) {
  const { t, row, actions } = props
  const { plugin, installed, update, compatibility, replacement } = row
  /**
   * Whether this card is the market itself.
   *
   * Its own lifecycle is not managed from here: the server refuses to toggle it
   * (`isProtectedModule` → 400) and refuses to uninstall it (`/uninstall` →
   * 400, "use the self-uninstall endpoint"). Offering either button would be a
   * control that always fails, so the self card shows neither; removing the
   * market is the deliberate flow on the settings card.
   */
  const isSelf = plugin.name === NS || installed?.name === NS
  // The catalog's free-form `comments` blob is the only comment source, so the
  // count here is what the dialog will show — parsed with the same function.
  const comments = commentCount(plugin.comments ?? '')
  const status = compatibility?.status
  const compatibilityLabel = status === 'compatible'
    ? t('compatCompatible')
    : status === 'incompatible' ? t('compatIncompatible') : t('compatUnknown')
  const compatibilityClass = status === 'incompatible'
    ? `${css.badge} ${css.badgeDanger}`
    : status === 'compatible' ? `${css.badge} ${css.badgeOk}` : `${css.badge} ${css.badgeMuted}`
  return (
    <div role="listitem" className={css.cardCell}>
      <article className={css.card} aria-label={displayLabelOf(plugin)}>
        <div className={css.cardHead}>
          {row.rank !== undefined && (
            // 「推荐」视图的名次：就是这个列表的顺序（1、2、3…），搜过的视图里也保持真实名次。
            <span className={`${css.badge} ${css.rankBadge}`} title={t('rankLabel', { rank: row.rank })}>
              {`#${String(row.rank)}`}
            </span>
          )}
          <h3 className={css.cardTitle}>{displayLabelOf(plugin)}</h3>
          {installed !== undefined && (
            <span className={`${css.badge} ${css.badgeOk}`}>{t('installedBadge')}</span>
          )}
          {update?.updateAvailable === true && (
            <span className={`${css.badge} ${css.badgeWarn}`}>{t('updateAvailableBadge')}</span>
          )}
          {plugin.deprecated === true && (
            <span className={`${css.badge} ${css.badgeDanger}`}>{t('deprecatedBadge')}</span>
          )}
          {plugin.band !== undefined && (
            // 推荐分的分档与"为什么推荐"（分项 + 编辑推荐理由）。目录没带评分时不显示。
            <span className={`${css.badge} ${bandClass(plugin.band)}`} title={scoreExplanation(plugin, t)}>
              {`${t('bandLabel')} ${plugin.band}${plugin.score === undefined ? '' : ` · ${String(Math.round(plugin.score))}`}`}
            </span>
          )}
          {plugin.pinReason !== undefined && plugin.pinReason !== '' && (
            <span className={`${css.badge} ${css.badgeWarn}`} title={plugin.pinReason}>{t('pinBadge')}</span>
          )}
        </div>
        {plugin.description !== undefined && plugin.description !== '' && (
          <p className={css.cardDesc}>{plugin.description}</p>
        )}
        <div className={css.cardMeta}>
          {row.duplicateName && plugin.owner !== undefined && plugin.owner !== '' && (
            <span className={css.tag} title={plugin.url ?? plugin.name}>{`${t('ownerLabel')}: ${plugin.owner}`}</span>
          )}
          {plugin.category !== undefined && plugin.category !== '' && (
            <span className={css.tag}>{`${t('categoryLabel')}: ${categoryText(plugin.category, props.categories, props.english === true) ?? plugin.category}`}</span>
          )}
          {typeof plugin.stars === 'number' && (
            <span className={css.stars}>{`★ ${String(plugin.stars)}`}</span>
          )}
          {typeof plugin.downloads === 'number' && (
            <span>{`${t('downloadsLabel')} ${String(plugin.downloads)}`}</span>
          )}
          <span
            className={compatibilityClass}
            title={compatibility?.requirement ?? compatibility?.reason ?? t('compatNote')}
          >
            {compatibilityLabel}
          </span>
          {installed?.version !== undefined && <span>{`${t('versionLabel')}: ${installed.version}`}</span>}
        </div>
        {plugin.deprecated === true && (
          <p className={css.danger}>
            {replacement === undefined
              ? t('deprecatedBadge')
              : `${t('replacementHint')}: ${replacement.name}`}
          </p>
        )}
        <div className={css.cardActions}>
          {plugin.siteUrl !== undefined && (
            // The plugin's page on the operator's own site (domain/site.ts). A
            // plain anchor: it opens a different document, so it must stay a
            // real link (middle-click, copy address) rather than a button.
            // `.actionLink` gives it the neighbouring buttons' text metrics.
            <a
              className={`${css.link} ${css.actionLink}`}
              href={plugin.siteUrl}
              target="_blank"
              rel="noreferrer noopener"
              title={t('siteOpenHint')}
            >
              {t('siteOpen')}
            </a>
          )}
          {row.fromCatalog && (
            <Button variant="ghost" size="sm" onClick={() => actions.openComments(plugin)}>
              {comments > 0 ? `${t('commentsOpen')} (${String(comments)})` : t('commentsOpen')}
            </Button>
          )}
          <span className={css.spacer} />
          {installed === undefined
            ? (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={plugin.deprecated === true || actions.busy}
                    title={actions.busy ? t('busyWait') : t('installConfirmBody')}
                    onClick={() => actions.install(plugin)}
                  >
                    {actions.pending === row.source ? t('installing') : t('install')}
                  </Button>
                  {plugin.deprecated === true && replacement !== undefined && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actions.busy}
                      onClick={() => actions.install(replacement)}
                    >
                      {t('installReplacement')}
                    </Button>
                  )}
                </>
              )
            : (
                // An installed plugin is never offered "install": the actions
                // that make sense are its own lifecycle — enable/disable,
                // update, uninstall — and the same card shape now serves every
                // filter.
                <>
                  {!isSelf && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actions.busy}
                      onClick={() => actions.toggle(installed.name, installed.disabled)}
                    >
                      {installed.disabled ? t('enable') : t('disable')}
                    </Button>
                  )}
                  {update?.updateAvailable === true && (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={actions.busy}
                      onClick={() => actions.update(installed.name)}
                    >
                      {actions.pending === installed.name ? t('updating') : t('update')}
                    </Button>
                  )}
                  {!isSelf && (
                    // Last, and marked dangerous, matching the Installed tab.
                    // The confirmation dialog is the same one that tab uses.
                    <Button
                      variant="outline"
                      size="sm"
                      className={css.danger}
                      disabled={actions.busy}
                      onClick={() => actions.uninstall(installed.name)}
                    >
                      {actions.pending === installed.name ? t('uninstalling') : t('uninstall')}
                    </Button>
                  )}
                </>
              )}
        </div>
      </article>
    </div>
  )
}

/** One Installed row with its per-plugin actions. */
function InstalledRow(props: {
  t: Translate
  plugin: InstalledPlugin
  note: string | undefined
  update: UpdateStatus | undefined
  group: string | undefined
  groupNames: string[]
  favorited: boolean
  catalogUrl: string | undefined
  siteUrl: string | undefined
  actions: MarketActions
}) {
  const { t, plugin, note, update, group, groupNames, favorited, catalogUrl, siteUrl, actions } = props
  const enabled = plugin.disabled !== true
  const pending = actions.pending === plugin.name
  /**
   * Whether this row is the market itself.
   *
   * The server refuses to toggle it (`isProtectedModule` → 400) and refuses to
   * uninstall it (`/uninstall` → 400, "use the self-uninstall endpoint"), so both
   * buttons could only ever fail. The card surface hides them for the same
   * reason; this list is now the installed surface, so it has to as well.
   */
  const isSelf = plugin.name === NS
  return (
    <div role="listitem" className={css.listRow}>
      <div className={css.stack}>
        <div className={css.row}>
          <span className={css.cardTitle}>{plugin.name}</span>
          <span className={css.badge}>{plugin.version ?? t('notInstalled')}</span>
          <span className={css.tag}>{`${t('sourceLabel')}: ${kindLabel(t, plugin.kind)}`}</span>
          {plugin.bundle && <span className={`${css.badge} ${css.badgeMuted}`}>{t('bundleBadge')}</span>}
          {!enabled && <span className={`${css.badge} ${css.badgeWarn}`}>{t('disabledBadge')}</span>}
          {update?.updateAvailable === true && (
            <span className={`${css.badge} ${css.badgeOk}`}>{t('updateAvailableBadge')}</span>
          )}
        </div>
        <span className={`${css.muted} ${css.ellipsis}`}>{plugin.spec}</span>
        {note !== undefined && note !== '' && <span className={css.hint}>{note}</span>}
      </div>
      {/* `.listActions` keeps the buttons at their natural width and lets them
          move to a line of their own; `.spacer` is unnecessary once the action
          group takes `margin-left:auto` itself. */}
      <div className={`${css.cardActions} ${css.listActions}`}>
        {siteUrl !== undefined && (
          <a
            className={`${css.link} ${css.actionLink}`}
            href={siteUrl}
            target="_blank"
            rel="noreferrer noopener"
            title={t('siteOpenHint')}
          >
            {t('siteOpen')}
          </a>
        )}
        {!isSelf && (
          <Button
            variant={enabled ? 'outline' : 'primary'}
            size="sm"
            disabled={actions.busy}
            onClick={() => actions.toggle(plugin.name, !enabled)}
          >
            {enabled ? t('disable') : t('enable')}
          </Button>
        )}
        {update?.updateAvailable === true && (
          <Button
            variant="primary"
            size="sm"
            disabled={actions.busy}
            onClick={() => actions.update(plugin.name)}
          >
            {pending ? t('updating') : t('update')}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => actions.editNote(plugin.name)}>
          {note !== undefined && note !== '' ? t('noteEdit') : t('noteAdd')}
        </Button>
        <label className={css.row}>
          <span className={css.muted}>{t('groupAssign')}</span>
          <select
            className={css.select}
            value={group ?? ''}
            aria-label={`${t('groupAssign')} ${plugin.name}`}
            disabled={actions.busy}
            onChange={event => actions.assignGroup(plugin.name, event.target.value)}
          >
            <option value="">{t('ungrouped')}</option>
            {groupNames.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        {catalogUrl === undefined
          ? (
              // Favorites are keyed by catalog URL; without one the server has
              // nothing to bookmark, so the control explains itself instead of
              // silently disappearing.
              <Button
                variant="ghost"
                size="sm"
                disabled
                title={t('favoriteUnavailable')}
                aria-label={t('favoriteUnavailable')}
              >
                {t('favoriteAdd')}
              </Button>
            )
          : (
              <Button variant="ghost" size="sm" onClick={() => actions.favorite(catalogUrl, !favorited)}>
                {favorited ? t('favoriteRemove') : t('favoriteAdd')}
              </Button>
            )}
        <Button variant="ghost" size="sm" onClick={() => actions.openChangelog(plugin.name)}>
          {t('changelogOpen')}
        </Button>
        {!isSelf && (
          <Button
            variant="outline"
            size="sm"
            className={css.danger}
            disabled={actions.busy}
            onClick={() => actions.uninstall(plugin.name)}
          >
            {pending ? t('uninstalling') : t('uninstall')}
          </Button>
        )}
      </div>
    </div>
  )
}

/** One Favorites row: the catalog entry when matched, the raw URL when not. */
function FavoriteRow(props: {
  t: Translate
  url: string
  plugin: RegistryPlugin | undefined
  actions: MarketActions
}) {
  const { t, url, plugin, actions } = props
  if (plugin === undefined) {
    return (
      <div role="listitem" className={css.card}>
        <div className={css.cardHead}>
          <span className={css.cardTitle}>{t('favoritesUnmatched')}</span>
        </div>
        <p className={`${css.muted} ${css.ellipsis}`}>{url}</p>
        <div className={css.cardActions}>
          <Button variant="ghost" size="sm" onClick={() => actions.favorite(url, false)}>
            {t('favoriteRemove')}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div role="listitem" className={css.card}>
      <div className={css.cardHead}>
        <span className={css.cardTitle}>{plugin.name}</span>
        {plugin.deprecated === true && (
          <span className={`${css.badge} ${css.badgeDanger}`}>{t('deprecatedBadge')}</span>
        )}
      </div>
      {plugin.description !== undefined && plugin.description !== '' && (
        <p className={css.cardDesc}>{plugin.description}</p>
      )}
      <div className={css.cardActions}>
        <Button
          variant="primary"
          size="sm"
          disabled={plugin.deprecated === true || actions.busy}
          onClick={() => actions.install(plugin)}
        >
          {t('install')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => actions.favorite(url, false)}>
          {t('favoriteRemove')}
        </Button>
      </div>
    </div>
  )
}

/** One Themes card: active state comes from the host, activation from useSkin. */
function ThemeCard(props: {
  t: Translate
  row: ThemeRow
  actions: MarketActions
}) {
  const { t, row, actions } = props
  return (
    <div role="listitem">
      <article className={css.card} aria-label={row.name}>
        <div className={css.cardHead}>
          <h3 className={css.cardTitle}>{row.name}</h3>
          {row.active && <span className={`${css.badge} ${css.badgeOk}`}>{t('themeActive')}</span>}
          {!row.active && row.installed && (
            <span className={`${css.badge} ${css.badgeMuted}`}>{t('themeInstalled')}</span>
          )}
        </div>
        {row.description !== undefined && row.description !== '' && (
          <p className={css.cardDesc}>{row.description}</p>
        )}
        <div className={css.cardActions}>
          <span className={css.spacer} />
          <Button
            variant="primary"
            size="sm"
            disabled={row.active || actions.busy}
            onClick={() => actions.activateTheme(row.name)}
          >
            {row.active ? t('themeActive') : t('themeApply')}
          </Button>
        </div>
      </article>
    </div>
  )
}

/**
 * Group editor: create / rename / delete groups, toggle a
 * whole group, and drop single members. It owns only its draft text; every
 * mutation is handed to the shared actions object so the server stays the
 * source of truth.
 */
function GroupEditor(props: {
  t: Translate
  groups: Record<string, string[]>
  groupOrder: string[]
  disabled: ReadonlySet<string>
  busy: boolean
  onCreate: (name: string) => void
  onRename: (name: string, next: string) => void
  onDelete: (name: string) => void
  onToggleAll: (name: string, enabled: boolean) => void
  onRemoveMember: (group: string, member: string) => void
}) {
  const { t, groups, groupOrder, disabled, busy, onCreate, onRename, onDelete, onToggleAll, onRemoveMember } = props
  const [draftName, setDraftName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const names = groupOrder.length > 0 ? groupOrder : Object.keys(groups)
  const create = (): void => {
    const name = draftName.trim()
    if (name === '') return
    onCreate(name)
    setDraftName('')
  }
  return (
    <section className={css.section} aria-label={t('groupSection')}>
      <div className={css.sectionHeader}>{t('groupSection')}</div>
      <div className={css.formRow}>
        <Input
          className={css.search}
          value={draftName}
          placeholder={t('groupNamePh')}
          aria-label={t('groupNamePh')}
          onChange={event => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') create()
          }}
        />
        <Button variant="outline" size="sm" disabled={busy || draftName.trim() === ''} onClick={create}>
          {t('groupNew')}
        </Button>
      </div>
      {names.length === 0
        ? (
            <div className={css.empty}>
              <div className={css.emptyTitle}>{t('noGroups')}</div>
            </div>
          )
        : (
            <div className={css.list}>
              {names.map(name => {
                const members = groups[name] ?? []
                const state = groupSwitchState(members, disabled)
                return (
                  <div key={name} className={css.card}>
                    <div className={css.row}>
                      {renaming === name
                        ? (
                            <>
                              <Input
                                className={css.search}
                                value={renameDraft}
                                placeholder={t('groupNamePh')}
                                aria-label={`${t('groupRename')} ${name}`}
                                onChange={event => setRenameDraft(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key !== 'Enter' || renameDraft.trim() === '') return
                                  onRename(name, renameDraft.trim())
                                  setRenaming(null)
                                }}
                              />
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={busy || renameDraft.trim() === ''}
                                onClick={() => {
                                  onRename(name, renameDraft.trim())
                                  setRenaming(null)
                                }}
                              >
                                {t('save')}
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                                {t('cancel')}
                              </Button>
                            </>
                          )
                        : (
                            <>
                              <span className={css.cardTitle}>{name}</span>
                              <span className={css.badge}>
                                {t('groupMembers', { count: members.length })}
                              </span>
                              {state === 'mixed' && (
                                <span className={`${css.badge} ${css.badgeWarn}`}>{t('groupMixed')}</span>
                              )}
                              <span className={css.spacer} />
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy || state === 'empty'}
                                onClick={() => onToggleAll(name, state === 'off')}
                              >
                                {t('groupToggleAll')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setRenaming(name)
                                  setRenameDraft(name)
                                }}
                              >
                                {t('groupRename')}
                              </Button>
                              {deleting === name
                                ? (
                                    <>
                                      <Button
                                        variant="primary"
                                        size="sm"
                                        className={css.danger}
                                        disabled={busy}
                                        onClick={() => {
                                          onDelete(name)
                                          setDeleting(null)
                                        }}
                                      >
                                        {t('groupConfirmDelete')}
                                      </Button>
                                      <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
                                        {t('cancel')}
                                      </Button>
                                    </>
                                  )
                                : (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className={css.danger}
                                      onClick={() => setDeleting(name)}
                                    >
                                      {t('groupDelete')}
                                    </Button>
                                  )}
                            </>
                          )}
                    </div>
                    {members.length === 0
                      ? <span className={css.muted}>{t('groupEmpty')}</span>
                      : (
                          <div className={css.cardMeta}>
                            {members.map(member => (
                              <span key={member} className={css.tag}>
                                {member}
                                <button
                                  type="button"
                                  aria-label={`${t('groupRemove')} ${member}`}
                                  disabled={busy}
                                  onClick={() => onRemoveMember(name, member)}
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                  </div>
                )
              })}
            </div>
          )}
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Section
 * ------------------------------------------------------------------ */

/**
 * Render the galaxy's main panel: Discover / Installed / Favorites / Themes.
 * @param props.t - translator bound to this plugin's namespace.
 * @param props.locale - locale service (a change re-renders so `t` re-reads it).
 * @param props.theme - theme service, read for the host's active theme.
 * @param props.themeStore - subscribable theme snapshot.
 * @param props.preferredSubsectionId - optional host-provided start tab.
 */
export function MarketSection(props: {
  t: Translate
  locale: LocaleServiceLike
  theme: ThemeServiceLike
  themeStore: ThemeStore
  preferredSubsectionId?: string
}) {
  const t = props.t
  const { locale, theme, themeStore } = props

  /**
   * The host locale service is a class instance whose `subscribe` reads
   * `this.listeners`: passing the method itself to `useSyncExternalStore`
   * would call it detached and throw. The wrapper also keeps the subscription
   * identity stable, so React does not re-subscribe on every render.
   */
  const subscribeLocale = useCallback(
    (callback: () => void) => locale.subscribe(callback),
    [locale],
  )
  const subscribeTheme = useCallback(
    (callback: () => void) => themeStore.subscribe(callback),
    [themeStore],
  )

  // `t` reads the active locale at call time and is stable per namespace, so
  // the subscription — not the returned value — is what refreshes the strings.
  // The third argument is `getServerSnapshot`: without it React throws
  // "Missing getServerSnapshot" whenever this tree is rendered outside the
  // browser (a server render, or the render-to-string smoke test), instead of
  // degrading. In the browser it is never called.
  const activeLanguage = useSyncExternalStore(
    subscribeLocale,
    () => locale.getSnapshot().active,
    () => locale.getSnapshot().active,
  )
  // Category labels come from the catalog in both languages; the badge and the
  // search index pick the one the active locale reads.
  const english = isEnglishLanguage(activeLanguage)
  // Only the active theme id is subscribed to: comparing a primitive keeps
  // React's Object.is check stable even when the host rebuilds its snapshot.
  const readActiveThemeId = useCallback(
    () => readThemeId(themeStore.getSnapshot()),
    [themeStore],
  )
  const storeThemeId = useSyncExternalStore(subscribeTheme, readActiveThemeId, readActiveThemeId)
  const hostThemeSnapshot = theme.getTheme()
  const activeThemeId = storeThemeId ?? readThemeId(hostThemeSnapshot)

  const [tab, setTab] = useState<GalaxyTab>(() => {
    const preferred = tabFromPreferred(props.preferredSubsectionId)
    // 「已安装」 is a FILTER now, not a tab: the filter row carries it, and it
    // renders the list form. Everything else keeps its tab (reachable only
    // through the host's deep link, since the tab bar is gone).
    return preferred === 'installed' ? 'discover' : (preferred ?? 'discover')
  })
  const [discoverQuery, setDiscoverQuery] = useState('')
  const [favoritesQuery, setFavoritesQuery] = useState('')
  const [filter, setFilter] = useState<DiscoverFilter>(
    () => (tabFromPreferred(props.preferredSubsectionId) === 'installed' ? 'installed' : 'all'),
  )
  const [sort, setSort] = useState<SortKey>('name-asc')
  // '' = no category filter. Kept as a slug (not a label) because the site owns
  // the vocabulary and may relabel a category without changing its rows.
  const [category, setCategory] = useState('')
  const [installedView, setInstalledView] = useState<'list' | 'groups'>('list')

  const [registry, setRegistry] = useState<Registry | null>(null)
  const [registryLoading, setRegistryLoading] = useState(true)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [inventory, setInventory] = useState<InstalledPayload | null>(null)
  const [inventoryError, setInventoryError] = useState<string | null>(null)
  const [updates, setUpdates] = useState<Record<string, UpdateStatus>>({})
  const [compatibility, setCompatibility] = useState<Record<string, HostCompatibility>>({})
  const [status, setStatus] = useState<GalaxyStatus | null>(null)
  const [records, setRecords] = useState<OperationRecord[]>([])
  const [serverBusy, setServerBusy] = useState(false)
  const [pendingTarget, setPendingTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * Rollback tokens by `<kind>:<name>`.
   *
   * A rollback token is minted by the server per mutation and is the only
   * value `POST /dsh-galaxy/rollback` accepts; operation records are derived
   * from `GET /status`, which never carries one. Mutations therefore park
   * their token here and the records handed to the operations panel are
   * annotated with it, so the rollback action is reachable from the UI.
   */
  const rollbackTokens = useRef(new Map<string, string>())
  /** Rollback token by record key, plus the record key format used everywhere. */
  const rollbackKey = useCallback((kind: string, name: string): string => `${kind}:${name.trim()}`, [])
  const rememberRollback = useCallback((response: unknown, kind: string, name: string): void => {
    const token = (response as { rollbackToken?: unknown } | null | undefined)?.rollbackToken
    if (typeof token === 'string' && token !== '') rollbackTokens.current.set(rollbackKey(kind, name), token)
  }, [rollbackKey])

  const [confirmInstall, setConfirmInstall] = useState<RegistryPlugin | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  const [noteFor, setNoteFor] = useState<{ name: string; draft: string } | null>(null)
  const [changelog, setChangelog] = useState<{
    name: string
    state: 'loading' | 'ready' | 'fail'
    payload: ChangelogPayload | null
  } | null>(null)
  const [commentsFor, setCommentsFor] = useState<RegistryPlugin | null>(null)
  const [rollbackFor, setRollbackFor] = useState<OperationRecord | null>(null)
  const [opsOpen, setOpsOpen] = useState(false)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [report, setReport] = useState<DiagnosticReport | null>(null)

  const anyBusy = serverBusy || pendingTarget !== null

  /**
   * Rows rendered at once, and the manual-refresh state.
   *
   * The live catalog has 3561 entries. Rendering every card at once produces tens
   * of thousands of DOM nodes, which is what made the grid look unstable while
   * the browser laid it out; the list renders a page at a time instead and the
   * count above it still reports the full total.
   */
  const [visibleRows, setVisibleRows] = useState(DISCOVER_PAGE_SIZE)
  const [reloadBusy, setReloadBusy] = useState(false)
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)

  // Preferred subsection: applied on mount and whenever the host changes it.
  useEffect(() => {
    const preferred = props.preferredSubsectionId
    if (preferred === undefined) return
    const next = tabFromPreferred(preferred)
    if (next === 'installed') {
      // The filter row owns this surface now.
      setTab('discover')
      setFilter('installed')
    } else if (next !== null) {
      setTab(next)
    }
    const query = queryFromPreferred(preferred)
    if (query === '') return
    // 已安装 shares the discover view's search box (it is a filter now).
    if (next === 'installed') setDiscoverQuery(query)
    else if (next === 'favorites') setFavoritesQuery(query)
    else setDiscoverQuery(query)
  }, [props.preferredSubsectionId])

  /* reads  —— */

  const loadRegistry = useCallback(async (force?: boolean): Promise<void> => {
    setRegistryLoading(true)
    try {
      const payload = await fetchRegistry(force)
      setRegistry(payload.registry)
      setRegistryError(null)
    } catch (failure) {
      setRegistryError(errorText(failure, t('loadFail')))
    } finally {
      setRegistryLoading(false)
    }
  }, [t])

  const refreshInventory = useCallback(async (): Promise<void> => {
    try {
      const payload = await fetchInstalled()
      setInventory(payload)
      setInventoryError(null)
    } catch (failure) {
      setInventoryError(errorText(failure, t('installedLoadFail')))
    }
  }, [t])

  const refreshUpdates = useCallback(async (force?: boolean): Promise<void> => {
    try {
      const list = await fetchUpdates(force)
      const map: Record<string, UpdateStatus> = {}
      for (const item of list) map[item.name] = item
      setUpdates(map)
    } catch {
      // Update checks are advisory: an unreachable registry must not turn the
      // Installed tab into an error page.
    }
  }, [])

  useEffect(() => {
    void loadRegistry()
    void refreshInventory()
    void refreshUpdates()
  }, [loadRegistry, refreshInventory, refreshUpdates])

  /**
   * Status poll: 1500 ms while something
   * runs, 3000 ms when idle. The in-flight ref guarantees requests never
   * overlap, and the busy→idle edge is what refreshes the inventory, so a
   * finished operation shows up without a manual reload.
   */
  const pollInFlight = useRef(false)
  const lastBusy = useRef(false)
  const pollOnce = useCallback(async (): Promise<void> => {
    if (pollInFlight.current) return
    pollInFlight.current = true
    try {
      const next = await fetchStatus()
      setStatus(next)
      setRecords(previous => deriveRecords(previous, next, next.boot))
      setServerBusy(next.busy === true)
      if (lastBusy.current && next.busy !== true) await refreshInventory()
      lastBusy.current = next.busy === true
    } catch {
      // A failed poll keeps the previous snapshot; the next tick retries.
    } finally {
      pollInFlight.current = false
    }
  }, [refreshInventory])
  useEffect(() => {
    void pollOnce()
    const timer = setInterval(() => { void pollOnce() }, anyBusy ? 1500 : 3000)
    return () => clearInterval(timer)
  }, [anyBusy, pollOnce])

  /* —— mutations (optimistic, and self-healing when they fail) —— */

  /**
   * Run one mutation, then re-read the lists from the server either way: on
   * success to pick up the new state, on failure because the optimistic view
   * is no longer trustworthy.
   * @param target - row label shown while the mutation runs.
   * @param task - the request itself.
   * @param failureKey - locale key used when the server sends no message.
   */
  /**
   * A change the RUNNING host has not picked up yet.
   *
   * Uninstalling a package cannot unload a plugin the host already mounted, so
   * the market list clears while the sidebar keeps its entry until the process
   * restarts. Reporting that state is the whole point: without it the user sees
   * "the plugin is still in the sidebar" and concludes the uninstall failed. The
   * notice stays until dismissed or superseded, because it remains true until
   * the restart happens.
   */
  const [restartNotice, setRestartNotice] = useState<string | null>(null)
  /** Neutral (warn) notice: used when the operator cancels their own wait. */
  const [notice, setNotice] = useState<string | null>(null)
  /** When the in-flight mutation started, for the elapsed indicator. */
  const [pendingSince, setPendingSince] = useState<number | null>(null)
  const [pendingElapsed, setPendingElapsed] = useState(0)
  /**
   * True once the watchdog fired: the operation is taking long enough that the
   * operator must be offered a way out instead of a silent "busy".
   */
  const [pendingStalled, setPendingStalled] = useState(false)
  /**
   * Abandons the wait for the in-flight mutation.
   *
   * A mutation request can end without ever answering — a killed package
   * manager used to leave the HTTP response pending forever — and the panel
   * then sat on "busy" with every control disabled and nothing to read. The
   * wait is therefore RACED against this hook, so the UI always reaches a
   * conclusion; the abandoned request is still collected in the background and
   * its failure swallowed (see `mutate`).
   */
  const abandonRef = useRef<((reason: 'cancelled' | 'timeout') => void) | null>(null)

  // Tick the elapsed counter only while something is actually running.
  useEffect(() => {
    if (pendingSince === null) return undefined
    const tick = (): void => { setPendingElapsed(Math.max(0, Math.round((Date.now() - pendingSince) / 1000))) }
    tick()
    const timer = setInterval(tick, 1_000)
    return () => { clearInterval(timer) }
  }, [pendingSince])

  const mutate = useCallback(async (
    target: string,
    task: () => Promise<unknown>,
    failureKey?: string,
  ): Promise<void> => {
    setPendingTarget(target)
    setPendingSince(Date.now())
    setPendingStalled(false)
    setError(null)
    setNotice(null)
    let settled = false
    const abandoned = new Promise<never>((_resolve, reject) => {
      abandonRef.current = (reason) => {
        if (settled) return
        reject(new MutationAbandoned(reason))
      }
    })
    // The race owns the outcome from here on, so a late rejection of the
    // original request must not become an unhandled rejection.
    const running = task()
    running.catch(() => undefined)
    const watchdog = setTimeout(() => { setPendingStalled(true) }, MUTATION_WATCHDOG_MS)
    const cap = setTimeout(() => {
      // Past the server's own 15-minute package-manager timeout, so a reply is
      // not merely late: stop waiting, and ask it to end the work as well.
      void cancelOperation().catch(() => undefined)
      abandonRef.current?.('timeout')
    }, MUTATION_CAP_MS)
    try {
      const response = await Promise.race([running, abandoned])
      // Both spellings are accepted: install/update/uninstall answer
      // `needsRestart`, toggle has always answered `restart`.
      const record = typeof response === 'object' && response !== null
        ? response as { needsRestart?: unknown; restart?: unknown }
        : undefined
      if (record?.needsRestart === true || record?.restart === true) setRestartNotice(target)
    } catch (failure) {
      if (failure instanceof MutationAbandoned) {
        if (failure.reason === 'cancelled') setNotice(t('mutationCancelled'))
        else setError(t('mutationTimedOut', { minutes: String(Math.round(MUTATION_CAP_MS / 60_000)) }))
      } else {
        setError(errorText(failure, t(failureKey ?? 'errorGeneric')))
      }
    } finally {
      settled = true
      abandonRef.current = null
      clearTimeout(watchdog)
      clearTimeout(cap)
      setPendingTarget(null)
      setPendingSince(null)
      setPendingStalled(false)
      void refreshInventory()
      void refreshUpdates()
    }
  }, [refreshInventory, refreshUpdates, t])

  /**
   * The operator's way out of a stalled mutation.
   *
   * The server owns the child process, so tell it first (`/cancel` kills the
   * process group and makes the pending request settle), then stop waiting
   * here. Both are best-effort: if `/cancel` itself fails there is nothing
   * useful left to do about it — the panel is already free.
   */
  /** Last few output lines of the running package command. */
  const recentOutput = useMemo(
    () => (status?.progress?.lines ?? []).slice(-4),
    [status],
  )

  const cancelPending = useCallback((): void => {
    void cancelOperation().catch(() => undefined)
    const abandon = abandonRef.current
    // With no local wait to abandon (the server-side hint), say that the
    // request went out — otherwise the click would look like it did nothing
    // until the next poll.
    if (abandon === null) setNotice(t('cancelRequested'))
    else abandon('cancelled')
  }, [t])

  const runInstall = useCallback((plugin: RegistryPlugin): void => {
    const spec = sourceSpec(plugin)
    void mutate(spec, async () => {
      const response = await installPlugin(spec)
      rememberRollback(response, 'install', response.name ?? spec)
      return response
    })
  }, [mutate, rememberRollback])

  const runGroup = useCallback((action: GroupAction, payload?: GroupPayload): void => {
    void mutate(`group:${payload?.name ?? ''}`, () => groupAction(action, payload), 'groupFail')
  }, [mutate])

  const assignGroup = useCallback((name: string, group: string): void => {
    const groups = inventory?.groups ?? {}
    const removals = Object.entries(groups)
      .filter(([other, members]) => other !== group && members.includes(name))
      .map(([other, members]) => ({ other, members: members.filter(member => member !== name) }))
    const additions = group === '' ? [] : [...new Set([...(groups[group] ?? []), name])]
    void mutate(`group:${name}`, async () => {
      for (const removal of removals) {
        await groupAction('set-members', { name: removal.other, members: removal.members })
      }
      if (group !== '') await groupAction('set-members', { name: group, members: additions })
    }, 'groupFail')
  }, [inventory, mutate])

  const openChangelog = useCallback((name: string): void => {
    setChangelog({ name, state: 'loading', payload: null })
    fetchChangelog(name).then(
      payload => setChangelog(current => current !== null && current.name === name
        ? { name, state: 'ready', payload }
        : current),
      () => setChangelog(current => current !== null && current.name === name
        ? { name, state: 'fail', payload: null }
        : current),
    )
  }, [])

  const loadDiagnostics = useCallback((): void => {
    fetchCheck().then(
      next => setReport(next),
      failure => setError(errorText(failure, t('errorGeneric'))),
    )
  }, [t])

  const actions = useMemo<MarketActions>(() => ({
    busy: anyBusy,
    pending: pendingTarget,
    install: plugin => setConfirmInstall(plugin),
    update: name => {
      void mutate(name, async () => {
        const response = await updatePlugin(name)
        rememberRollback(response, 'update', name)
        return response
      })
    },
    uninstall: name => setConfirmUninstall(name),
    toggle: (name, enabled) => { void mutate(name, () => togglePlugin(name, enabled), 'toggleFail') },
    editNote: name => setNoteFor({ name, draft: inventory?.notes[name] ?? '' }),
    assignGroup,
    favorite: (url, favorited) => {
      void mutate(`favorite:${url}`, () => favoriteUrl(url, favorited), 'favoriteFailed')
    },
    openChangelog,
    openComments: plugin => setCommentsFor(plugin),
    activateTheme: name => {
      void mutate(`theme:${name}`, async () => {
        try {
          await useSkin(name)
        } catch (failure) {
          // Re-throw the server's own message: "restart to apply" is the
          // actionable half of a failed theme switch.
          throw new Error(errorText(failure, t('themeFail')))
        }
      }, 'themeFail')
    },
  }), [anyBusy, pendingTarget, mutate, inventory, assignGroup, openChangelog, t])

  /* —— derived listings —— */

  const installedByName = useMemo(() => {
    const map = new Map<string, InstalledPlugin>()
    for (const plugin of inventory?.installed ?? []) map.set(plugin.name, plugin)
    return map
  }, [inventory])

  /** Installed dependencies indexed by repository, for git-sourced installs. */
  const installedByRepo = useMemo(() => {
    const map = new Map<string, InstalledPlugin>()
    for (const plugin of inventory?.installed ?? []) {
      if (typeof plugin.repo === 'string' && plugin.repo !== '') map.set(plugin.repo.toLowerCase(), plugin)
    }
    return map
  }, [inventory])

  const catalogByUrl = useMemo(() => {
    const map = new Map<string, RegistryPlugin>()
    for (const plugin of registry?.plugins ?? []) {
      if (typeof plugin.url === 'string' && plugin.url !== '') map.set(plugin.url, plugin)
    }
    return map
  }, [registry])

  /** Catalog entries indexed by package name and by catalog name. */
  const catalogByPackage = useMemo(() => {
    const map = new Map<string, RegistryPlugin>()
    for (const plugin of registry?.plugins ?? []) {
      map.set(plugin.name, plugin)
      if (typeof plugin.npm === 'string' && plugin.npm !== '') map.set(plugin.npm, plugin)
    }
    return map
  }, [registry])

  /** Catalog entries indexed by repository, for git-sourced installs. */
  const catalogByRepo = useMemo(() => {
    const map = new Map<string, RegistryPlugin>()
    for (const plugin of registry?.plugins ?? []) {
      const repo = repoOf(plugin.url)
      if (repo !== undefined && !map.has(repo)) map.set(repo, plugin)
    }
    return map
  }, [registry])

  const favoriteSet = useMemo(() => new Set<string>(inventory?.favorites ?? []), [inventory])

  const discoverRows = useMemo<DiscoverRow[]>(() => {
    const entries = registry?.plugins ?? []
    const query = discoverQuery.trim().toLowerCase()
    const rows: DiscoverRow[] = []

    /** Append one row, deriving its unique key and its installed match. */
    const push = (
      plugin: RegistryPlugin,
      index: number,
      fromCatalog: boolean,
      installed: InstalledPlugin | undefined,
      rank?: number,
    ): void => {
      const identity = typeof plugin.npm === 'string' && plugin.npm !== '' ? plugin.npm : plugin.name
      rows.push({
        key: `${identity}::${String(index)}`,
        plugin,
        installed,
        fromCatalog,
        duplicateName: false,
        update: installed === undefined ? undefined : updates[installed.name],
        compatibility: compatibility[identity],
        source: sourceSpec(plugin),
        replacement: plugin.replacement === undefined ? undefined : catalogByPackage.get(plugin.replacement),
        ...(rank === undefined ? {} : { rank }),
      })
    }

    if (filter === 'installed') {
      // Driven by the INVENTORY, not by the catalog.
      //
      // A real profile's plugins are largely absent from the curated catalog
      // (private plugins, or packages installed straight from npm), so a
      // catalog-driven filter answered with two rows for one plugin — two
      // authors sharing a display name — while silently omitting the rest.
      // The installed set is the ground truth for "installed".
      for (const [index, installed] of (inventory?.installed ?? []).entries()) {
        const haystack = `${installed.name} ${installed.spec} ${installed.repo ?? ''}`.toLowerCase()
        if (query !== '' && !haystack.includes(query)) continue
        const repo = typeof installed.repo === 'string' ? installed.repo.toLowerCase() : undefined
        const entry = catalogByPackage.get(installed.name)
          ?? (repo === undefined ? undefined : catalogByRepo.get(repo))
        // A catalog row is used for METADATA only; without one the card is built
        // from what the profile actually knows, rather than being dropped.
        if (entry === undefined) push({ name: installed.name, npm: installed.name }, index, false, installed)
        else push(entry, index, true, installed)
      }
    } else if (filter === 'not-installed' && registry?.ranking !== undefined) {
      /*
       * 推荐榜：只显示线上评选出的前 N 条（默认 20），卡片上印 1、2、3… 的名次。
       *
       * 顺序**完全由目录给的 `ranking.top` 决定**（那是站点侧算好的名次），这里不重排；
       * `top` 比窗口更长，正是为了先跳过已安装的、再取前 N——所以装掉一个会自动补上下一个，
       * 而榜单本身与"谁已安装"无关。不在榜上的插件仍然可以在「全部」里搜到。
       */
      const window = Math.max(1, registry.ranking.window ?? RECOMMEND_WINDOW)
      const byKey = new Map<string, RegistryPlugin>()
      for (const plugin of entries) {
        const key = catalogKeyOf(plugin)
        if (key !== undefined && !byKey.has(key)) byKey.set(key, plugin)
      }
      let rank = 0
      let shown = 0
      for (const key of registry.ranking.top) {
        if (shown >= window) break
        const plugin = byKey.get(key)
        if (plugin === undefined) continue
        const installed = matchInstalled(plugin, installedByName, installedByRepo)
        if (installed !== undefined) continue
        // 搜索同时认展示名与原始名：官网「archify integrations」，原始「archify#integrations/…」
        const haystack = [displayLabelOf(plugin), plugin.name, plugin.npm ?? '', plugin.category ?? '', categoryText(plugin.category, registry?.categories, english) ?? '', plugin.description ?? '', plugin.owner ?? '']
          .join(' ')
          .toLowerCase()
        // 名次在搜索之前就定下来：搜过的视图里仍是它真实的名次，而不是"第 1 个匹配"。
        rank += 1
        if (!inCategory(plugin, category)) continue
        if (query !== '' && !haystack.includes(query)) continue
        push(plugin, rank, true, installed, rank)
        shown += 1
      }
    } else {
      for (const [index, plugin] of entries.entries()) {
        const installed = matchInstalled(plugin, installedByName, installedByRepo)
        const identity = typeof plugin.npm === 'string' && plugin.npm !== '' ? plugin.npm : plugin.name
        const haystack = [displayLabelOf(plugin), plugin.name, plugin.npm ?? '', plugin.category ?? '', categoryText(plugin.category, registry?.categories, english) ?? '', plugin.description ?? '', plugin.owner ?? '']
          .join(' ')
          .toLowerCase()
        if (!inCategory(plugin, category)) continue
        if (query !== '' && !haystack.includes(query)) continue
        if (filter === 'not-installed' && installed !== undefined) continue
        if (filter === 'update-available' && updates[installed?.name ?? '']?.updateAvailable !== true) continue
        // The compatibility verdict is NOT applied here: it arrives
        // asynchronously, and a filter that only keeps rows with a verdict would
        // never ask for the verdicts it needs (no rows → no requests → no rows).
        push(plugin, index, true, installed)
      }
    }

    // Flag names that repeat inside THIS listing: those cards must show their
    // owner, because two rows called `dsh-knowledge` are different plugins.
    const counts = new Map<string, number>()
    for (const row of rows) {
      const label = displayLabelOf(row.plugin)
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    for (const row of rows) row.duplicateName = (counts.get(row.plugin.name) ?? 0) > 1

    // 推荐榜的名次**就是**目录给的顺序：再按"名称/星数"排一次会把名次打乱
    // （实测未安装视图变成 one/three/two）。排序只在普通列表里生效。
    if (!(filter === 'not-installed' && registry?.ranking !== undefined)) {
      const { field, dir } = parseSortKey(sort)
      rows.sort((left, right) => compareRows(left, right, field, dir))
    }
    return rows
  }, [
    registry, inventory, installedByName, installedByRepo, catalogByPackage, catalogByRepo,
    updates, compatibility, discoverQuery, filter, sort, category,
  ])

  /**
   * Candidates after the synchronous filters, before the verdict filter.
   *
   * The compatibility verdict is applied on top of this set once it arrives, so
   * the request below can ask about exactly these rows.
   */
  /*
   * Rows per category slug, counted over the whole catalog — the number the
   * selector shows next to a label. Counted from the rows the panel holds rather
   * than the vocabulary's `count`: the two agree on a healthy catalog (gate
   * 11.4), and when they disagree the number should describe what selecting the
   * category will actually show.
   */
  const countsByCategory = useMemo(() => {
    const counts = new Map<string, number>()
    for (const plugin of registry?.plugins ?? []) {
      for (const part of (plugin.category ?? '').split(',')) {
        const slug = part.trim()
        if (slug !== '') counts.set(slug, (counts.get(slug) ?? 0) + 1)
      }
    }
    return counts
  }, [registry])

  const matchedDiscoverRows = useMemo(
    () => (filter === 'incompatible'
      ? discoverRows.filter(row => row.compatibility?.status === 'incompatible')
      : discoverRows),
    [discoverRows, filter],
  )

  /**
   * The slice actually laid out, plus its page control.
   *
   * `visibleRows` resets whenever the listing changes shape, so switching filter
   * or typing a query never leaves the view scrolled into a stale page.
   */
  const visibleDiscoverRows = useMemo(
    () => matchedDiscoverRows.slice(0, visibleRows),
    [matchedDiscoverRows, visibleRows],
  )
  /**
   * True while 「推荐」 renders the website's published ranking.
   *
   * That view's order IS `ranking.top` (the listing memo skips sorting for it on
   * purpose), so the sort control has nothing to act on there: showing it would be
   * a control that provably does nothing. The other filters keep it.
   */
  const recommendationAvailable = registry?.ranking !== undefined
  const rankingView = filter === 'not-installed' && recommendationAvailable
  /**
   * The operations section exists only while it has something to say: an idle
   * panel shows no strip at all (the old always-on 「共 0 条记录」 line is what got
   * removed). It opens itself while a mutation runs, so progress, cancel and
   * rollback stay visible.
   */
  const operationsBusy = records.some(record => bucketOf(record) === 'busy')
  const showOperations = records.length > 0 || operationsBusy
  useEffect(() => {
    if (operationsBusy) setOpsOpen(true)
  }, [operationsBusy])
  useEffect(() => {
    setVisibleRows(DISCOVER_PAGE_SIZE)
  }, [filter, discoverQuery, sort, registry])

  // ONE batched request per rendered candidate set — never one per card.
  const requestedCompatibility = useRef(new Set<string>())
  /**
   * Liveness guard for the in-flight verdict request.
   *
   * This is deliberately NOT the effect's own cleanup flag. The effect re-runs
   * whenever the row set changes — and it changes for reasons unrelated to the
   * request, such as the update list arriving a moment after the catalog. A
   * per-run `cancelled` flag therefore discarded verdicts that were already in
   * flight, while their names stayed marked as "asked", so they were never
   * requested again: the compatibility badge stayed "unknown" and the
   * "incompatible" filter matched nothing, intermittently and depending on
   * timing. Only unmount may abandon a request.
   */
  const verdictsAlive = useRef(true)
  useEffect(() => () => { verdictsAlive.current = false }, [])

  useEffect(() => {
    if (tab !== 'discover') return
    // Ask about what is on screen plus one page ahead: forecasting all 3561
    // catalog entries would fire dozens of batched requests for cards nobody can
    // reach yet, while asking only about VISIBLE rows would starve the
    // "incompatible" filter (its visible set is empty until verdicts arrive).
    const scope = discoverRows.slice(0, visibleRows + DISCOVER_PAGE_SIZE)
    const missing = [...new Set(scope.map(row => row.plugin.npm ?? row.plugin.name))]
      .filter(name => name !== '' && !requestedCompatibility.current.has(name))
    if (missing.length === 0) return
    for (const name of missing) requestedCompatibility.current.add(name)
    void (async () => {
      try {
        for (let offset = 0; offset < missing.length; offset += 64) {
          const chunk = missing.slice(offset, offset + 64)
          const results = await discoveryCompatibility(chunk)
          if (!verdictsAlive.current) return
          setCompatibility(previous => {
            const next = { ...previous }
            for (const item of results) next[item.name] = item
            return next
          })
        }
      } catch {
        // A failed forecast leaves the badge "unknown"; release the names so a
        // later listing can ask again instead of pinning them forever.
        for (const name of missing) requestedCompatibility.current.delete(name)
      }
    })()
  }, [tab, discoverRows, visibleRows])

  // Rows for the retained-but-unreachable installed LIST surface (`tab ===
  // 'installed'`): the card grid builds its own rows from the inventory.
  const installedRows = useMemo(() => {
    const query = discoverQuery.trim().toLowerCase()
    return (inventory?.installed ?? [])
      .filter(plugin => query === '' || plugin.name.toLowerCase().includes(query))
      .sort((left, right) => left.name.localeCompare(right.name))
  }, [inventory, discoverQuery])

  const favoriteRows = useMemo(() => {
    const query = favoritesQuery.trim().toLowerCase()
    return (inventory?.favorites ?? [])
      .filter(url => query === '' || url.toLowerCase().includes(query))
      .map(url => ({ url, plugin: catalogByUrl.get(url) }))
  }, [inventory, favoritesQuery, catalogByUrl])

  const themeRows = useMemo<ThemeRow[]>(() => {
    const rows = new Map<string, ThemeRow>()
    for (const plugin of inventory?.installed ?? []) {
      const entry = catalogByPackage.get(plugin.name)
      if (!isThemeBundle(plugin.name, entry)) continue
      rows.set(plugin.name, {
        name: plugin.name,
        installed: true,
        active: activeThemeId === plugin.name,
        ...(entry?.description === undefined ? {} : { description: entry.description }),
      })
    }
    for (const hostTheme of readHostThemes(hostThemeSnapshot)) {
      if (!rows.has(hostTheme.name)) rows.set(hostTheme.name, hostTheme)
    }
    return [...rows.values()].map(row => ({ ...row, active: row.active || activeThemeId === row.name }))
  }, [inventory, catalogByPackage, activeThemeId, hostThemeSnapshot])

  const disabledSet = useMemo(() => new Set<string>(inventory?.disabled ?? []), [inventory])

  const groupNames = useMemo(
    () => (inventory?.groupOrder.length ? inventory.groupOrder : Object.keys(inventory?.groups ?? {})),
    [inventory],
  )

  const groupOf = useCallback((name: string): string | undefined => {
    for (const [group, members] of Object.entries(inventory?.groups ?? {})) {
      if (members.includes(name)) return group
    }
    return undefined
  }, [inventory])

  /** Re-read everything a change may have touched (used by panels and reload). */
  const patchInventory = useCallback((): void => {
    void refreshInventory()
    void refreshUpdates(true)
  }, [refreshInventory, refreshUpdates])

  /**
   * Manual refresh (the toolbar button).
   *
   * It forces the catalog revalidation and re-reads the inventory and update
   * verdicts, and — just as important — it reports that it ran. The previous
   * implementation replayed a conditional request, got the same bytes back, and
   * changed nothing on screen, so the button looked broken even though it was
   * working.
   */
  const reloadAll = useCallback(async (): Promise<void> => {
    setReloadBusy(true)
    try {
      await Promise.all([
        loadRegistry(true),
        refreshInventory(),
        refreshUpdates(true),
      ])
      setRefreshedAt(Date.now())
    } finally {
      setReloadBusy(false)
    }
  }, [loadRegistry, refreshInventory, refreshUpdates])

  /* —— render —— */

  return (
    <div className={css.root} data-entry="galaxy-section">
      <p className={css.sub}>{t('subtitle')}</p>

      {/*
        The tab bar and the status strip that used to sit here are gone: the
        panel opens straight into the marketplace, and 「已安装」 is reached
        through the filter row instead of a tab (it renders the list form).
        收藏 / 主题 / 快照 / 预设 / 诊断 keep their code and remain reachable
        through the host's `preferredSubsectionId` deep link, but the panel no
        longer advertises them.
      */}

      {/* Only while there is something to report: an idle panel shows no strip. */}
      {showOperations && (
      <section className={css.panel} data-entry="operations">
        <div className={css.panelHeader}>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={opsOpen}
            onClick={() => setOpsOpen(open => !open)}
          >
            {`${opsOpen ? t('opsHide') : t('opsShow')} · ${t('sectionOperations')}`}
          </Button>
          <span className={css.count}>{t('opsCount', { count: records.length })}</span>
          {/* The plugin/host version lines and the snapshot/preset/diagnostics
              buttons that used to sit here were part of the removed strip. The
              actions themselves stay in the code and are still reachable through
              the host's `preferredSubsectionId` deep link. */}
          <span className={css.spacer} />
        </div>
        {opsOpen && (
          <div className={css.panelBody}>
            <OperationsPanel
              t={t}
              records={records.map((record) => {
                const token = rollbackTokens.current.get(rollbackKey(record.kind, record.name))
                return token === undefined
                  ? record
                  : { ...record, rollbackToken: token } as OperationRecord & { rollbackToken?: string }
              })}
              onRollback={record => setRollbackFor(record)}
              onCancel={() => {
                void cancelOperation().catch(failure => setError(errorText(failure, t('errorGeneric'))))
              }}
              onApproveBuilds={packages => {
                void approveBuilds(packages).catch(failure => setError(errorText(failure, t('errorGeneric'))))
              }}
              onSetupPnpm={() => {
                void setupPnpm().catch(failure => setError(errorText(failure, t('errorGeneric'))))
              }}
            />
          </div>
        )}
      </section>
      )}

      {error !== null && (
        <p className={`${css.banner} ${css.bannerError}`} role="alert">{error}</p>
      )}

      {restartNotice !== null && (
        // Deliberately not an error: the operation succeeded. It states why the
        // sidebar still shows the plugin and what makes it go away.
        <div className={`${css.banner} ${css.bannerWarn}`} role="status">
          <span className={css.stack}>
            <span>{`${t('restartNeededTitle')} · ${restartNotice}`}</span>
            <span className={css.muted}>{t('restartNeededBody')}</span>
          </span>
          <span className={css.spacer} />
          <Button variant="ghost" size="sm" onClick={() => { setRestartNotice(null) }}>
            {t('close')}
          </Button>
        </div>
      )}

      {tab === 'discover' && (
        // No tablist above it any more, so this is a plain region, not a tabpanel.
        <section
          aria-label={t('tabDiscover')}
          data-entry={TAB_ENTRY.discover}
          className={css.section}
        >
          <Toolbar
            t={t}
            // Every filter shares one search box and one card grid — including
            // 已安装, whose rows are built from the installed inventory.
            query={discoverQuery}
            onQuery={setDiscoverQuery}
            placeholder={t('searchPh')}
            busy={reloadBusy}
            onReload={() => { void reloadAll() }}
            filter={filter}
            onFilter={setFilter}
            recommended={recommendationAvailable}
            sort={rankingView ? undefined : sort}
            onSort={setSort}
            category={category}
            onCategory={setCategory}
            categories={registry?.categories}
            categoryCounts={countsByCategory}
            english={english}
          />
          {registryLoading && registry === null && (
            <div className={css.spinnerWrap} role="status">
              <span className={css.spinner} aria-hidden="true" />
              {t('catalogLoading')}
            </div>
          )}
          {registryError !== null && (
            <div className={css.empty}>
              <div className={css.emptyTitle}>{t('loadFail')}</div>
              <div className={css.emptyHint}>{registryError}</div>
              <Button variant="outline" size="sm" onClick={() => { void loadRegistry(true) }}>
                {t('loadRetry')}
              </Button>
            </div>
          )}
          {registryError === null && !(registryLoading && registry === null) && (
            <>
              <p className={css.count}>
                {t('resultCount', { count: matchedDiscoverRows.length })}
                {rankingView && (
                  // 推荐榜是有意截断的：不在榜上的插件仍然可以在「全部」里搜到。
                  <span className={css.muted}>{` · ${t('recommendNote', { count: matchedDiscoverRows.length })}`}</span>
                )}
                {refreshedAt !== null && (
                  <span className={css.muted}>
                    {` · ${reloadBusy ? t('reloadBusy') : t('refreshedAt', { time: formatTime(refreshedAt) })}`}
                  </span>
                )}
              </p>
              {matchedDiscoverRows.length === 0
                ? (
                    <div className={css.empty}>
                      <div className={css.emptyTitle}>{category === '' ? t('noMatch') : t('categoryEmpty')}</div>
                      <div className={css.emptyHint}>
                        {category !== '' && rankingView ? t('categoryEmptyRecommended') : t('emptyHint')}
                      </div>
                    </div>
                  )
                : (
                    <>
                      <div className={css.cardGrid} role="list">
                        {visibleDiscoverRows.map(row => (
                          <PluginCard key={row.key} t={t} row={row} actions={actions} categories={registry?.categories} english={english} />
                        ))}
                      </div>
                      {matchedDiscoverRows.length > visibleDiscoverRows.length && (
                        <div className={css.row}>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => { setVisibleRows(count => count + DISCOVER_PAGE_SIZE) }}
                          >
                            {t('showMore', { count: matchedDiscoverRows.length - visibleDiscoverRows.length })}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
            </>
          )}
        </section>
      )}

      {/*
        The installed LIST surface (rows with toggle / note / favorite /
        changelog / uninstall, plus the group editor).
        「已安装」 now renders the same CARD grid as every other filter, so this
        branch is retained-but-unreachable: `tab` never becomes 'installed'
        (the host's `preferredSubsectionId: 'installed'` deep link maps to the
        filter instead). Kept per the standing "keep the code, drop the entry"
        policy, like the favorites/themes sections below.
      */}
      {tab === 'installed' && (
        <section
          aria-label={t('tabInstalled')}
          data-entry={TAB_ENTRY.installed}
          className={css.section}
        >
          <div className={css.row} role="group" aria-label={t('groupSection')}>
            <button
              type="button"
              aria-pressed={installedView === 'list'}
              className={installedView === 'list' ? `${css.tab} ${css.tabActive}` : css.tab}
              onClick={() => setInstalledView('list')}
            >
              {t('tabList')}
            </button>
            <button
              type="button"
              aria-pressed={installedView === 'groups'}
              className={installedView === 'groups' ? `${css.tab} ${css.tabActive}` : css.tab}
              onClick={() => setInstalledView('groups')}
            >
              {t('tabGroups')}
            </button>
          </div>
          {inventoryError !== null && (
            <p className={`${css.banner} ${css.bannerError}`}>{t('installedLoadFail')}</p>
          )}
          <p className={css.count}>{t('installedCount', { count: installedRows.length })}</p>
          {inventory !== null && inventory.installed.length === 0 && (
            <div className={css.empty}>
              <div className={css.emptyTitle}>{t('installedEmpty')}</div>
            </div>
          )}
          {installedView === 'groups'
            ? (
                <GroupEditor
                  t={t}
                  groups={inventory?.groups ?? {}}
                  groupOrder={inventory?.groupOrder ?? []}
                  disabled={disabledSet}
                  busy={anyBusy}
                  onCreate={name => runGroup('create', { name })}
                  onRename={(name, next) => runGroup('rename', { name, newName: next })}
                  onDelete={name => runGroup('delete', { name })}
                  onToggleAll={(name, enabled) => runGroup('toggle', { name, enabled })}
                  onRemoveMember={(group, member) => {
                    const members = (inventory?.groups[group] ?? []).filter(entry => entry !== member)
                    runGroup('set-members', { name: group, members })
                  }}
                />
              )
            : (
                <div className={css.list} role="list">
                  {installedRows.map(plugin => (
                    <InstalledRow
                      key={plugin.name}
                      t={t}
                      plugin={plugin}
                      note={inventory?.notes[plugin.name]}
                      update={updates[plugin.name]}
                      group={groupOf(plugin.name)}
                      groupNames={groupNames}
                      favorited={isFavorited(plugin, catalogByPackage, favoriteSet)}
                      catalogUrl={catalogUrlFor(plugin, catalogByPackage)}
                      siteUrl={siteUrlFor(plugin, catalogByPackage)}
                      actions={actions}
                    />
                  ))}
                </div>
              )}
        </section>
      )}

      {tab === 'favorites' && (
        <section
          role="tabpanel"
          aria-label={t('tabFavorites')}
          data-entry={TAB_ENTRY.favorites}
          className={css.section}
        >
          <Toolbar
            t={t}
            query={favoritesQuery}
            onQuery={setFavoritesQuery}
            placeholder={t('searchFavoritesPh')}
            busy={reloadBusy}
            onReload={() => { void reloadAll() }}
          />
          <p className={css.count}>{t('favoritesCount', { count: favoriteRows.length })}</p>
          {favoriteRows.length === 0
            ? (
                <div className={css.empty}>
                  <div className={css.emptyTitle}>{t('favoritesEmpty')}</div>
                </div>
              )
            : (
                <div className={css.cardGrid} role="list">
                  {favoriteRows.map(row => (
                    <FavoriteRow key={row.url} t={t} url={row.url} plugin={row.plugin} actions={actions} />
                  ))}
                </div>
              )}
        </section>
      )}

      {tab === 'themes' && (
        <section
          role="tabpanel"
          aria-label={t('tabThemes')}
          data-entry={TAB_ENTRY.themes}
          className={css.section}
        >
          <div className={css.toolbar}>
            {activeThemeId !== null && (
              <span className={css.count}>{`${t('themeHostActive')}: ${activeThemeId}`}</span>
            )}
            <span className={css.spacer} />
            <Button
              variant="outline"
              size="sm"
              icon={<IconRefresh size={13} />}
              onClick={patchInventory}
              disabled={anyBusy}
            >
              {t('reload')}
            </Button>
          </div>
          <p className={css.count}>{t('themeResultCount', { count: themeRows.length })}</p>
          {themeRows.length === 0
            ? (
                <div className={css.empty}>
                  <div className={css.emptyTitle}>{t('themesEmpty')}</div>
                </div>
              )
            : (
                <div className={css.cardGrid} role="list">
                  {themeRows.map(row => (
                    <ThemeCard key={row.name} t={t} row={row} actions={actions} />
                  ))}
                </div>
              )}
        </section>
      )}

      {/* —— Dialogs —— */}

      <Modal
        open={confirmInstall !== null}
        onClose={() => setConfirmInstall(null)}
        title={t('installConfirmTitle')}
        closeLabel={t('close')}
        footer={(
          <>
            <Button variant="outline" size="sm" onClick={() => setConfirmInstall(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={anyBusy}
              onClick={() => {
                if (confirmInstall !== null) runInstall(confirmInstall)
                setConfirmInstall(null)
              }}
            >
              {t('installConfirmAction')}
            </Button>
          </>
        )}
      >
        <div className={css.modalBody}>
          <code className={css.code}>{confirmInstall === null ? '' : sourceSpec(confirmInstall)}</code>
          <p className={css.hint}>{t('installConfirmBody')}</p>
        </div>
      </Modal>

      <Modal
        open={confirmUninstall !== null}
        onClose={() => setConfirmUninstall(null)}
        title={t('uninstallConfirmTitle')}
        closeLabel={t('close')}
        footer={(
          <>
            <Button variant="outline" size="sm" onClick={() => setConfirmUninstall(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              className={css.danger}
              disabled={anyBusy}
              onClick={() => {
                const name = confirmUninstall
                setConfirmUninstall(null)
                if (name !== null) {
                  void mutate(name, async () => {
                    const response = await uninstallPlugin(name)
                    rememberRollback(response, 'uninstall', name)
                    return response
                  })
                }
              }}
            >
              {t('uninstallConfirmAction')}
            </Button>
          </>
        )}
      >
        <div className={css.modalBody}>
          <p>{t('uninstallConfirmBody', { name: confirmUninstall ?? '' })}</p>
        </div>
      </Modal>

      <Modal
        open={noteFor !== null}
        onClose={() => setNoteFor(null)}
        title={t('noteEdit')}
        closeLabel={t('close')}
        footer={(
          <>
            <Button variant="outline" size="sm" onClick={() => setNoteFor(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={anyBusy}
              onClick={() => {
                const target = noteFor
                setNoteFor(null)
                if (target !== null) void mutate(target.name, () => saveNote(target.name, target.draft), 'noteFail')
              }}
            >
              {t('noteSave')}
            </Button>
          </>
        )}
      >
        <div className={css.modalBody}>
          <label className={css.field}>
            <span className={css.label}>{noteFor?.name ?? ''}</span>
            <Input
              className={css.search}
              value={noteFor?.draft ?? ''}
              maxLength={200}
              placeholder={t('notePlaceholder')}
              aria-label={t('notePlaceholder')}
              onChange={event => setNoteFor(current => current === null
                ? current
                : { name: current.name, draft: event.target.value })}
            />
          </label>
          <p className={css.hint}>{t('notePlaceholder')}</p>
        </div>
      </Modal>

      <Modal
        open={changelog !== null}
        onClose={() => setChangelog(null)}
        title={changelog === null ? t('changelogTitle') : `${t('changelogTitle')} — ${changelog.name}`}
        closeLabel={t('close')}
        footer={(
          <Button variant="outline" size="sm" onClick={() => setChangelog(null)}>
            {t('close')}
          </Button>
        )}
      >
        <div className={css.modalBody}>
          {changelog !== null && changelog.state === 'loading' && (
            <div className={css.spinnerWrap} role="status">
              <span className={css.spinner} aria-hidden="true" />
              {t('changelogLoading')}
            </div>
          )}
          {changelog !== null && changelog.state === 'fail' && (
            <p className={`${css.banner} ${css.bannerError}`}>{t('changelogFail')}</p>
          )}
          {changelog !== null && changelog.state === 'ready' && changelog.payload !== null && (
            <div className={css.stack}>
              <p className={css.count}>
                {`${t('changelogCurrent')}: ${changelog.payload.current ?? '—'} · ${t('changelogLatest')}: ${changelog.payload.latest ?? '—'}`}
              </p>
              {changelog.payload.releases.length === 0 && changelog.payload.commits.length === 0 && (
                <div className={css.empty}>
                  <div className={css.emptyTitle}>{t('changelogEmpty')}</div>
                </div>
              )}
              {changelog.payload.releases.map(release => (
                <article key={release.tag} className={css.card}>
                  <div className={css.cardHead}>
                    <span className={css.cardTitle}>{release.tag}</span>
                    {release.name !== undefined && <span className={css.muted}>{release.name}</span>}
                    {release.publishedAt !== undefined && (
                      <span className={css.count}>{release.publishedAt}</span>
                    )}
                  </div>
                  <p className={css.cardDesc}>{release.body}</p>
                </article>
              ))}
              {changelog.payload.commits.length > 0 && (
                <>
                  <div className={css.sectionHeader}>{t('changelogCommits')}</div>
                  <div className={css.list} role="list">
                    {changelog.payload.commits.map(commit => (
                      <div role="listitem" key={commit.sha} className={css.row}>
                        <span className={css.code}>{commit.sha.slice(0, 7)}</span>
                        <span>{commit.message}</span>
                        {commit.date !== undefined && <span className={css.count}>{commit.date}</span>}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {changelog.payload.truncated === true && (
                <p className={css.count}>{t('changelogTruncated')}</p>
              )}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={rollbackFor !== null}
        onClose={() => setRollbackFor(null)}
        title={t('rollbackConfirmTitle')}
        closeLabel={t('close')}
        footer={(
          <>
            <Button variant="outline" size="sm" onClick={() => setRollbackFor(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={anyBusy}
              onClick={() => {
                const record = rollbackFor
                setRollbackFor(null)
                if (record !== null) {
                  // The server only accepts the token it minted; fall back to
                  // the record id so a stale panel still gets a clear 409.
                  const token = rollbackTokens.current.get(rollbackKey(record.kind, record.name)) ?? record.id
                  void mutate(`rollback:${record.id}`, () => rollbackOperation(token))
                }
              }}
            >
              {t('rollbackConfirmAction')}
            </Button>
          </>
        )}
      >
        <div className={css.modalBody}>
          <p>{t('rollbackConfirmBody')}</p>
        </div>
      </Modal>

      <Modal
        open={diagnosticsOpen}
        onClose={() => setDiagnosticsOpen(false)}
        title={t('panelDiagnostics')}
        closeLabel={t('close')}
      >
        <div className={css.modalBody}>
          <Diagnostics t={t} report={report} onRefresh={loadDiagnostics} />
        </div>
      </Modal>

      <CommentsModal
        t={t}
        open={commentsFor !== null}
        plugin={commentsFor}
        onClose={() => setCommentsFor(null)}
      />

      <SnapshotPanel
        t={t}
        open={snapshotOpen}
        onClose={() => setSnapshotOpen(false)}
        onChanged={patchInventory}
      />

      <PresetPanel
        t={t}
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        onChanged={patchInventory}
      />

      {notice !== null && (
        // Neutral, not an error: the operator chose to stop waiting.
        <div className={`${css.banner} ${css.bannerWarn}`} role="status">
          <span className={css.stack}>
            <span>{notice}</span>
          </span>
          <span className={css.spacer} />
          <Button variant="ghost" size="sm" onClick={() => { setNotice(null) }}>
            {t('close')}
          </Button>
        </div>
      )}

      {pendingTarget === null && serverBusy && (
        // Something is running server-side that this page is not waiting for:
        // an operation started in another window, or one that was already
        // running when the page was reloaded. Every control is disabled, so the
        // way out has to be visible here — not only in the Operations panel.
        <div className={css.progress} role="status">
          <span className={css.progressText}>{t('busyServerSide')}</span>
          <span className={css.row}>
            <span className={css.progressText}>{t('busyStalled')}</span>
            <Button variant="outline" size="sm" onClick={cancelPending}>
              {t('cancel')}
            </Button>
          </span>
        </div>
      )}

      {pendingTarget !== null && (
        <div className={css.progress} role="status">
          <span className={css.progressText}>
            {[
              `${t(phaseLabelKey(status?.progress?.phase))} ${pendingTarget}`,
              t('busyElapsed', { seconds: String(pendingElapsed) }),
              progressCounters(status?.progress, t),
            ].filter(part => part !== '').join(' · ')}
          </span>
          {recentOutput.length > 0 && (
            // The child's OWN words, newest last. This is what makes a long
            // install judgeable: `Progress: resolved 173, reused 54, …` and the
            // CLI's stage notes show it moving — or stuck — without the log file.
            <>
              <span className={css.progressText}>{t('progressOutput')}</span>
              <pre className={css.progressLog} aria-label={t('progressOutput')}>{recentOutput.join('\n')}</pre>
            </>
          )}
          {pendingStalled && (
            // The way out of a request that may never answer. `/cancel` kills
            // the package-manager process group server-side, which is also what
            // makes the pending request settle.
            <span className={css.row}>
              <span className={css.progressText}>{t('busyStalled')}</span>
              <Button variant="outline" size="sm" onClick={cancelPending}>
                {t('cancel')}
              </Button>
            </span>
          )}
        </div>
      )}
    </div>
  )
}
