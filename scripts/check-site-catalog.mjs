#!/usr/bin/env node
/**
 * Validate the website's plugin catalog (`public/assets/plugins/catalog.json`).
 *
 * This file is the CONTRACT between the two projects: the galaxy reads it as its
 * catalog, links every row to `<site>/#/ai/p/<key>`, and renders the 「未安装」
 * view from its `ranking` block, so a broken key, a missing install spec or a
 * stale recommendation block shows up as a wrong link, an uninstallable card or a
 * silently short recommendation list rather than as an error. Run it before
 * uploading, and after every regeneration.
 *
 * Checks:
 *   1. the JSON shape the galaxy's loader accepts (`plugins[]`, each row with a
 *      source: `npm` | `url` | `tarball`);
 *   2. `key` present and UNIQUE (the deep link's identity — names are not unique);
 *   3. `key === owner/name` (the rule both sides derive, so they cannot drift);
 *   4. arrays/objects that the client destructures (`categories`, `counts`);
 *   5. every `category` resolves to a declared category;
 *   6. prints the derived deep links, so a human can open one and see the page;
 *   7. the recommendation block the panel's 「推荐」 view renders
 *      (`ranking{version,window,listN,top,pins}` plus per-row `score`/`band`/
 *      `scoreParts`/`pinReason`), including the sidecar `ranking.json`;
 *   8. the panel's derivation, REPLAYED: skip installed rows, take `window` rows in
 *      the published order (`top` is longer than the window, so skipping a row
 *      pulls the next one up). This is the half the website cannot see — its own
 *      page sorts by score, the panel renders the window in `top` order;
 *   9. loader parity, for a URL target: the galaxy's real loader parses the same
 *      payload into the same order and the same rows, which is what catches a
 *      parser drifting away from an artifact the website still considers valid;
 *  10. wording parity for the one label both surfaces paint on the badge (the
 *      website's `ai.band.label` vs the panel's `bandLabel`) — skipped when the
 *      sibling checkout is absent.
 *
 * Usage:
 *   node scripts/check-site-catalog.mjs [--catalog <path|url>] [--sidecar <path|url>] [--installed a,b]
 *
 * Defaults to the sibling website checkout. `--catalog <url>` (or a URL in
 * DSHG_REGISTRY_URL) also runs check 9 against the deployed artifact.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')

const isUrl = value => /^https?:\/\//iu.test(value)

function arg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 || process.argv[index + 1] === undefined ? undefined : process.argv[index + 1]
}

/** Default: the sibling website project, when it is checked out next to this one. */
const rawTarget = arg('--catalog')
  ?? (isUrl(process.env.DSHG_REGISTRY_URL ?? '')
    ? process.env.DSHG_REGISTRY_URL
    : join(workspace, '..', 'PBISimulation-Frontend', 'public', 'assets', 'plugins', 'catalog.json'))
const catalogTarget = isUrl(rawTarget) ? rawTarget : resolve(rawTarget)
const sidecarTarget = arg('--sidecar')
  ?? (isUrl(catalogTarget) ? new URL('ranking.json', catalogTarget).href : join(dirname(catalogTarget), 'ranking.json'))
const siteUrl = (process.env.DSHG_SITE_URL ?? 'https://www.yhaigc.cn').replace(/\/+$/u, '')

/**
 * Read one JSON artifact, from a file or from the site.
 *
 * The website's nginx/netlify configs fall back to `index.html` for unknown
 * paths, so a missing artifact answers `200` with HTML. That is not "no file":
 * it is a deployment fault, and it must not read as an empty catalog.
 */
async function loadJson(target, label) {
  if (isUrl(target)) {
    const response = await fetch(target, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`${label}: HTTP ${String(response.status)} (${target})`)
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`${label}: not JSON — an SPA fallback to index.html looks exactly like this (${target})`)
    }
  }
  if (!existsSync(target)) return undefined
  return JSON.parse(readFileSync(target, 'utf8'))
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** The web profile's dependency names: what the panel treats as already installed. */
function profileInstalledNames() {
  const file = join(process.env.DSHG_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web', 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    return Object.keys(manifest?.dependencies ?? {})
  } catch {
    return []
  }
}

let parsed
try {
  parsed = await loadJson(catalogTarget, 'catalog')
} catch (error) {
  console.error(`FAIL  the catalog could not be read: ${error.message}`)
  process.exit(1)
}
if (parsed === undefined) {
  console.error(`SKIP  no catalog at ${catalogTarget} (pass --catalog <path|url>)`)
  process.exit(2)
}

const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : []
check('the catalog is an object with a non-empty plugins[] array', plugins.length > 0, `${String(plugins.length)} row(s)`)

/* ---- 1. every row is installable by the galaxy's loader ---- */
const uninstallable = plugins.filter(row =>
  typeof row?.name !== 'string' || row.name === ''
  || (typeof row.npm !== 'string' && typeof row.url !== 'string' && typeof row.tarball !== 'string'))
check('every row has a name and an install source (npm | url | tarball)', uninstallable.length === 0,
  uninstallable.length === 0 ? undefined : uninstallable.slice(0, 3).map(row => String(row?.key ?? row?.name)).join(', '))

/* ---- 2. keys are unique, and present ---- */
const keys = plugins.map(row => row?.key)
const missingKeys = keys.filter(key => typeof key !== 'string' || key.trim() === '')
check('every row carries a key', missingKeys.length === 0, `${String(missingKeys.length)} without one`)

const seen = new Map()
const duplicates = []
for (const key of keys) {
  if (typeof key !== 'string') continue
  if (seen.has(key)) duplicates.push(key)
  else seen.set(key, true)
}
// A deep link cannot identify a plugin without this: two rows sharing a key means
// one of them is unreachable and the other is ambiguous.
check('keys are unique', duplicates.length === 0, duplicates.slice(0, 3).join(', '))

/* ---- 3. key === owner/name, the rule the galaxy derives ---- */
const drifted = plugins.filter(row =>
  typeof row?.key === 'string' && typeof row.owner === 'string' && typeof row.name === 'string'
  && row.key !== `${row.owner}/${row.name}`)
check('every key is exactly `owner/name` (the rule the galaxy derives)', drifted.length === 0,
  drifted.length === 0 ? undefined : drifted.slice(0, 3).map(row => `${row.key} ≠ ${row.owner}/${row.name}`).join('; '))

/* ---- 4. the shapes the client destructures ---- */
check('categories[] is present and non-empty',
  Array.isArray(parsed?.categories) && parsed.categories.length > 0,
  `${String(Array.isArray(parsed?.categories) ? parsed.categories.length : 0)} category(ies)`)
check('counts is an object', typeof parsed?.counts === 'object' && parsed.counts !== null)
check('counts.plugins matches the row count',
  parsed?.counts?.plugins === undefined || parsed.counts.plugins === plugins.length,
  `counts.plugins=${String(parsed?.counts?.plugins)} rows=${String(plugins.length)}`)

/* ---- 5. every category resolves ---- */
const declared = new Set((Array.isArray(parsed?.categories) ? parsed.categories : []).map(category => category?.id))
const unresolved = plugins.filter(row => typeof row?.category === 'string' && !declared.has(row.category))
check('every row\'s category is declared in categories[]', unresolved.length === 0,
  unresolved.length === 0 ? `${String(declared.size)} declared` : unresolved.slice(0, 3).map(row => row.category).join(', '))

/* ---- 7. the recommendation block the panel's 「未安装」 view renders ---- */
const rowByKey = new Map(plugins.filter(row => typeof row?.key === 'string').map(row => [row.key, row]))
const ranking = parsed?.ranking
const top = Array.isArray(ranking?.top) ? ranking.top.filter(key => typeof key === 'string' && key.trim() !== '') : []
const window = Number.isInteger(ranking?.window) && ranking.window > 0 ? ranking.window : 0
const pins = Array.isArray(ranking?.pins) ? ranking.pins : []

/*
 * These mirror the website's own guard (`src/__tests__/build/plugin-catalog.test.ts`,
 * 「插件目录：推荐块（DSH 星系的「未安装」视图依赖）」) from the CONSUMER side: a
 * catalog rebuilt without rerunning `catalog:ranking` looks perfectly healthy on
 * the website — only the panel loses its ranking — and a recommendation block that
 * drifted from the rows looks perfectly healthy in the panel.
 */
check('7.1  the catalog carries the panel\'s recommendation block (ranking{…})',
  ranking !== undefined && typeof ranking === 'object' && ranking !== null)
check('7.2  ranking.version matches the rows\' scoreVersion',
  typeof ranking?.version === 'string' && ranking.version !== ''
  && plugins.every(row => row?.scoreVersion === undefined || row.scoreVersion === ranking.version),
  `version=${String(ranking?.version)}`)
check('7.3  ranking.window is a positive integer', window > 0, `window=${String(ranking?.window)}`)
check('7.4  ranking.top is a non-empty key list', top.length > 0, `${String(top.length)} key(s)`)
check('7.5  top is longer than the window (skipping an installed row pulls the next one up)',
  top.length > window, `${String(top.length)} > ${String(window)}`)
check('7.6  top carries no duplicate key (a duplicate renders one card twice)',
  new Set(top).size === top.length)
const unresolvedTop = top.filter(key => !rowByKey.has(key))
check('7.7  every top key resolves to a row (an unresolved key shrinks the panel silently)',
  unresolvedTop.length === 0, unresolvedTop.slice(0, 3).join(', '))
check('7.8  every pin resolves to a row and carries a reason',
  pins.every(pin => rowByKey.has(pin?.key) && typeof pin?.reason === 'string' && pin.reason.trim() !== ''),
  `${String(pins.length)} pin(s)`)
check('7.9  every pinned row carries pinReason (the badge reads the row, not the block)',
  pins.every(pin => typeof rowByKey.get(pin?.key)?.pinReason === 'string' && rowByKey.get(pin?.key).pinReason !== ''))
const pinsOutside = pins.filter(pin => top.indexOf(pin?.key) >= window)
check('7.10 pins sit inside the window (a pin past `window` is never displayed)',
  pinsOutside.length === 0, pinsOutside.map(pin => pin?.key).join(', '))
check('7.11 ranking.listN matches the published list length when present',
  ranking?.listN === undefined || ranking.listN === top.length,
  `listN=${String(ranking?.listN)} top=${String(top.length)}`)

// `curated` is excluded on purpose: the hand-picked 甄选 plugins are pinned to the top of
// the site and deliberately unranked, so they carry no score / band / scoreParts. Every
// OTHER row must have all three — that is what this check really guards, namely that
// `catalog:ranking` was not run after `catalog:build` and silently wiped the whole block.
const unranked = plugins.filter(row =>
  row?.category !== 'curated'
  && (typeof row?.score !== 'number' || typeof row?.band !== 'string'
    || typeof row?.scoreParts !== 'object' || row.scoreParts === null))
check('7.12 every ranked row carries score / band / scoreParts (panel badge + hover explanation)',
  unranked.length === 0, unranked.slice(0, 3).map(row => row?.key).join(', '))
const outOfRange = plugins.filter(row => typeof row?.score === 'number' && (row.score < 0 || row.score > 100))
check('7.13 every score is inside 0..100', outOfRange.length === 0,
  outOfRange.slice(0, 3).map(row => `${String(row.key)}: ${String(row.score)}`).join(', '))
// The badge shows `score`, the hover explanation shows the parts: if they do not add
// up, the panel contradicts itself inside one tooltip.
const driftedParts = plugins.filter(row => {
  if (typeof row?.score !== 'number' || typeof row?.scoreParts !== 'object' || row.scoreParts === null) return false
  const sum = Object.values(row.scoreParts).reduce((total, part) => total + (typeof part === 'number' ? part : 0), 0)
  return Math.abs(sum - row.score) > 0.05
})
check('7.14 scoreParts add up to score (badge and tooltip must not disagree)',
  driftedParts.length === 0, driftedParts.slice(0, 3).map(row => `${String(row.key)}: ${String(row.score)}`).join(', '))

/*
 * The row level of the same story: `displayName` is what the card title, the
 * search index and the website all show. It is DATA, not a frontend rule —
 * before it existed, the website printed `repoᅩsubpath` nicely and the panel
 * printed the raw `name`, and "renaming a plugin on the website" never reached
 * the panel. `name` must stay raw: `key === owner/name` is the identity contract.
 */
const noLabel = plugins.filter(row => typeof row?.displayName !== 'string' || row.displayName.trim() === '')
check('7.18 every row carries a non-empty displayName (the label both surfaces show)',
  noLabel.length === 0, noLabel.slice(0, 3).map(row => String(row?.key)).join(', '))
const hashedLabel = plugins.filter(row => typeof row?.displayName === 'string' && row.displayName.includes('#'))
check('7.19 no displayName still contains `#` (the reader-facing label is readable)',
  hashedLabel.length === 0, hashedLabel.slice(0, 3).map(row => `${String(row?.key)}: ${String(row?.displayName)}`).join(', '))

/* ---- 7b. the sidecar `ranking.json` must agree with the block ---- */
let sidecar
let sidecarError
try {
  sidecar = await loadJson(sidecarTarget, 'ranking sidecar')
} catch (error) {
  sidecarError = error.message
}
if (sidecar === undefined) {
  // Neither unreadable nor absent is a reason to skip the three checks below: a
  // build that forgot the sidecar is exactly what the website's own guard catches.
  check('7.15 the ranking sidecar (ranking.json) is published next to the catalog', false,
    sidecarError ?? `not found at ${sidecarTarget}`)
} else {
  const sidecarTop = Array.isArray(sidecar?.top) ? sidecar.top : []
  check('7.15 the sidecar\'s key order matches ranking.top',
    sidecarTop.map(row => row?.key).join('\u0000') === top.join('\u0000'),
    `${String(sidecarTop.length)} vs ${String(top.length)}`)
  check('7.16 the sidecar\'s ranks are 1..N',
    sidecarTop.every((row, index) => row?.rank === index + 1))
  const mismatched = sidecarTop.filter(row => {
    const catalogRow = rowByKey.get(row?.key)
    return catalogRow === undefined || catalogRow.score !== row?.score || catalogRow.band !== row?.band
  })
  check('7.17 the sidecar\'s score/band match the catalog rows', mismatched.length === 0,
    mismatched.slice(0, 3).map(row => String(row?.key)).join(', '))
}

/* ---- 8. replay the panel's derivation ---- */
const identityOf = row => (typeof row?.npm === 'string' && row.npm !== '' ? row.npm : row?.name)
const pinnedKeys = new Set(pins.map(pin => pin?.key))

/**
 * The panel's 「未安装」 view, replayed exactly as `MarketSection.tsx` does it:
 * walk `top` in the published order, skip anything already installed, stop at
 * `window` rows. No re-sorting — that is the whole point of publishing a rank.
 */
function replay(installed) {
  const visible = []
  for (const key of top) {
    if (visible.length >= window) break
    const row = rowByKey.get(key)
    if (row === undefined) continue
    if (installed.has(identityOf(row)) || installed.has(row?.name)) continue
    visible.push(row)
  }
  return visible
}

const empty = replay(new Set())
check('8.1  with nothing installed the window fills from the top of the list',
  empty.length === Math.min(window, top.length), `${String(empty.length)} row(s)`)
const names = empty.map(row => row?.name)
check('8.2  the window carries no duplicate display name',
  new Set(names).size === names.length,
  names.filter((name, index) => names.indexOf(name) !== index).join(', '))
const perCategory = new Map()
for (const row of empty) {
  if (pinnedKeys.has(row?.key)) continue // a pin is an editorial exception, not a category slot
  perCategory.set(row?.category, (perCategory.get(row?.category) ?? 0) + 1)
}
const overCap = [...perCategory.entries()].filter(([, count]) => count > 2)
check('8.3  no category takes more than 2 non-pinned slots in the window',
  overCap.length === 0, overCap.map(([category, count]) => `${String(category)}=${String(count)}`).join(', '))

const skippedKeys = top.slice(0, 3)
const syntheticInstalled = new Set(skippedKeys.map(key => identityOf(rowByKey.get(key))))
const compensated = replay(syntheticInstalled)
check('8.4  skipping 3 installed rows still fills the window (compensation)',
  compensated.length === window && compensated.every(row => !skippedKeys.includes(row?.key)),
  `${String(compensated.length)} row(s)`)

const override = arg('--installed')
const profileNames = override === undefined ? profileInstalledNames() : override.split(',').map(name => name.trim()).filter(Boolean)
const installedNow = replay(new Set(profileNames))
console.log(`\n「未安装」窗口实测（已装 ${String(profileNames.length)} 个：${profileNames.join(', ') || '无'}）`)
for (const [index, row] of installedNow.entries()) {
  const score = typeof row?.score === 'number' ? row.score.toFixed(2).padStart(6) : '     -'
  const band = typeof row?.band === 'string' ? row.band : '?'
  const pin = pinnedKeys.has(row?.key) ? ' 🖊' : ''
  console.log(`  ${String(index + 1).padStart(2)}. ${score} ${band} ${String(row?.name ?? '')}${pin}`)
}
check('8.5  the real profile\'s installed set still leaves a full window',
  installedNow.length === Math.min(window, top.length), `${String(installedNow.length)} row(s)`)
const installedShown = installedNow.filter(row => profileNames.includes(identityOf(row)) || profileNames.includes(row?.name))
check('8.6  no installed plugin is offered as a recommendation', installedShown.length === 0,
  installedShown.map(row => row?.name).join(', '))

/* ---- 9. loader parity: the galaxy's own parser, on the same payload ---- */
if (isUrl(catalogTarget)) {
  const built = join(workspace, 'lib', 'domain', 'registry.js')
  if (!existsSync(built)) {
    console.log('\nSKIP  loader parity: no built lib/domain/registry.js (run `npm run build` first)')
  } else {
    console.log('')
    process.env.DSHG_REGISTRY_URL = catalogTarget
    const { loadRegistry } = await import('../lib/domain/registry.js')
    const registry = await loadRegistry('web', '', true, undefined)
    check('9.1  the loader returns the same row count', registry.count === plugins.length,
      `${String(registry.count)} vs ${String(plugins.length)}`)
    check('9.2  the loader keeps ranking.version and window',
      registry.ranking?.version === ranking?.version && registry.ranking?.window === ranking?.window,
      `version=${String(registry.ranking?.version)} window=${String(registry.ranking?.window)}`)
    check('9.3  the loader keeps the published order (keys-only `top`, same length)',
      Array.isArray(registry.ranking?.top) && registry.ranking.top.join('\u0000') === top.join('\u0000'),
      `${String(registry.ranking?.top?.length)} vs ${String(top.length)}`)
    const loadedByKey = new Map(registry.plugins.map(row => [row.key, row]))
    const unresolvedLoaded = top.filter(key => !loadedByKey.has(key))
    check('9.4  every top key resolves through the loader\'s own rows',
      unresolvedLoaded.length === 0, unresolvedLoaded.slice(0, 3).join(', '))
    /*
     * Parity, not "every row is scored": `curated` rows are published unranked on
     * purpose (see 7.12), so the check asks what the loader really owes — a field
     * the payload carries survives the per-row rebuild — plus the ranked-row
     * requirement mirrored from 7.12 after that rebuild.
     */
    const payloadByKey = new Map(plugins.map(row => [row?.key, row]))
    const dropped = registry.plugins.filter(row => {
      const source = payloadByKey.get(row.key)
      if (source === undefined) return false
      if (typeof source.score === 'number' && typeof row.score !== 'number') return true
      if (typeof source.band === 'string' && typeof row.band !== 'string') return true
      return source.scoreParts !== undefined && row.scoreParts === undefined
    })
    check('9.5  the loader keeps score / band / scoreParts for every scored row',
      dropped.length === 0, dropped.slice(0, 3).map(row => row.name).join(', '))
    const loaderUnranked = registry.plugins.filter(row =>
      row.category !== 'curated'
      && (typeof row.score !== 'number' || typeof row.band !== 'string'
        || typeof row.scoreParts !== 'object' || row.scoreParts === null))
    check('9.5b the loader keeps every ranked row scored (7.12 after the rebuild)',
      loaderUnranked.length === 0, loaderUnranked.slice(0, 3).map(row => row.name).join(', '))
    /*
     * The vocabulary must survive the same rebuild the rows do: the panel looks a
     * row's slug up in it, so a loader that drops the objects (a `typeof item ===
     * 'string'` filter did exactly that) puts raw slugs back on every card.
     */
    const loadedVocabulary = Array.isArray(registry.categories) ? registry.categories : []
    // Read from the payload here: section 11's list is declared further down, and a
    // forward reference inside a `const` would be a TDZ crash.
    const payloadVocabulary = Array.isArray(parsed?.categories)
      ? parsed.categories.filter(entry => entry !== null && typeof entry === 'object')
      : []
    check('9.7  the loader keeps the category vocabulary (ids + labels)',
      loadedVocabulary.length === payloadVocabulary.length
      && payloadVocabulary.every((entry, index) => loadedVocabulary[index]?.id === entry.id
        && loadedVocabulary[index]?.label === entry.label
        && loadedVocabulary[index]?.labelEn === entry.labelEn),
      `${String(loadedVocabulary.length)} vs ${String(payloadVocabulary.length)}`)
    check('9.6  the loader parses the pins (key + reason)',
      Array.isArray(registry.ranking?.pins) && registry.ranking.pins.length === pins.length
      && registry.ranking.pins.every(pin => typeof pin.key === 'string' && typeof pin.reason === 'string'),
      `${String(registry.ranking?.pins?.length)} vs ${String(pins.length)}`)
  }
} else {
  console.log('\nSKIP  loader parity: pass `--catalog <url>` (or a URL in DSHG_REGISTRY_URL) to run it against a served payload')
}

/* ---- 10. wording parity for the label both surfaces paint ---- */
/*
 * The badge (`推荐 S · 90`) and the hover explanation are the only two things that
 * appear on BOTH surfaces: the website stops at the badge, the panel continues with
 * the parts and the editor's reason. So the band label must be the same word in
 * both projects, or the same plugin reads differently depending on where you look.
 * Its format string is code on both sides and is compared in the unit tests.
 */
const sibling = join(workspace, '..', 'PBISimulation-Frontend')
const siteZhFile = join(sibling, 'src', 'i18n', 'zh.json')
const siteEnFile = join(sibling, 'src', 'i18n', 'en.json')
if (existsSync(siteZhFile) && existsSync(siteEnFile)) {
  const halves = readFileSync(join(workspace, 'src', 'client', 'locales-market.ts'), 'utf8').split(/satisfies Dict/u)
  const panelLabel = half => /bandLabel: '([^']*)'/u.exec(half ?? '')?.[1]
  const siteLabel = file => JSON.parse(readFileSync(file, 'utf8'))?.ai?.band?.label
  for (const [language, panelHalf, siteFile] of [['zh', halves[0], siteZhFile], ['en', halves[1], siteEnFile]]) {
    const panel = panelLabel(panelHalf)
    const site = siteLabel(siteFile)
    check(`10.1 ${language}: the band label is the same word on both surfaces`,
      typeof panel === 'string' && panel === site, `panel=${String(panel)} site=${String(site)}`)
  }
} else {
  console.log('SKIP  wording parity: the sibling website checkout is not present')
}

/* ---- 11. the category vocabulary the panel paints ---- */

/*
 * Rows carry a slug; the site ships the labels users read (`甄选` / `Featured`).
 * The panel resolves the slug through this table, so a table that is missing an
 * entry, a label, or a truthful count shows up as a raw slug on a card — the
 * same class of drift `displayName` had for plugin names.
 */
const categoryEntries = Array.isArray(parsed?.categories) ? parsed.categories.filter(entry => entry !== null && typeof entry === 'object') : []
const badCategoryIds = categoryEntries.filter(entry => typeof entry.id !== 'string' || entry.id.trim() === '')
check('11.1 every categories[] entry carries a non-empty id',
  badCategoryIds.length === 0, `${String(categoryEntries.length)} entr(ies)`)
const unlabelled = categoryEntries.filter(entry =>
  typeof entry.label !== 'string' || entry.label.trim() === ''
  || typeof entry.labelEn !== 'string' || entry.labelEn.trim() === '')
check('11.2 every category carries both labels (zh + en, so the panel never shows a slug)',
  unlabelled.length === 0, unlabelled.slice(0, 3).map(entry => String(entry.id)).join(', '))
const labelCounts = new Map()
for (const entry of categoryEntries) {
  for (const key of ['label', 'labelEn']) {
    const label = typeof entry[key] === 'string' ? entry[key].trim() : ''
    if (label !== '') labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1)
  }
}
const repeatedLabels = [...labelCounts].filter(([, count]) => count > 1).map(([label]) => label)
check('11.3 category labels are distinct (two categories must not read the same)',
  repeatedLabels.length === 0, repeatedLabels.slice(0, 3).join(', '))
const rowCounts = new Map()
for (const row of plugins) {
  const slug = typeof row?.category === 'string' ? row.category : ''
  if (slug !== '') rowCounts.set(slug, (rowCounts.get(slug) ?? 0) + 1)
}
const miscounted = categoryEntries.filter(entry =>
  typeof entry.count === 'number' && entry.count !== (rowCounts.get(entry.id) ?? 0))
check('11.4 each category\'s published count matches its rows',
  miscounted.length === 0,
  miscounted.slice(0, 3).map(entry => `${String(entry.id)}: ${String(entry.count)} vs ${String(rowCounts.get(entry.id) ?? 0)}`).join(', '))
const emptyCategories = categoryEntries.filter(entry => (rowCounts.get(entry.id) ?? 0) === 0)
check('11.5 no declared category is empty (a vocabulary entry with no rows is dead weight)',
  emptyCategories.length === 0, emptyCategories.slice(0, 3).map(entry => String(entry.id)).join(', '))

/* ---- 6. show a few deep links a human can open ---- */
const sample = plugins
  .filter(row => typeof row?.key === 'string')
  .sort((left, right) => (right.stars ?? 0) - (left.stars ?? 0))
  .slice(0, 5)
console.log('\n深链样例（点开应直接看到该插件详情）：')
for (const row of sample) {
  console.log(`  ${String(row.stars ?? 0).padStart(6)}★ ${row.name}\n          ${siteUrl}/#/ai/p/${encodeURIComponent(row.key)}`)
}

console.log('')
console.log(failures === 0
  ? `SITE CATALOG: PASS — ${String(plugins.length)} plugin(s), ${String(declared.size)} category(ies), ${String(seen.size)} unique key(s), window ${String(window)}/${String(top.length)} with ${String(pins.length)} pin(s)`
  : `SITE CATALOG: FAIL (${String(failures)})`)
process.exit(failures === 0 ? 0 : 1)
