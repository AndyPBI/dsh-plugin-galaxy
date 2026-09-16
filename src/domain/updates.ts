/**
 * Update detection: what the profile has against the source of truth.
 *
 * Per plugin the comparison is by source: a git spec compares its pinned
 * commit (from the spec or the lockfile) against the remote HEAD, an npm spec
 * compares its installed version against the registry dist-tag, and a local
 * source is reported as such rather than guessed at.
 *
 * Two rules shape the result:
 *   - `updateAvailable` is strictly one-directional: it means "a NEWER
 *     version exists". A version that differs but is not newer is reported as
 *     `channelSwitch` on its own field, because a plain `!==` would let every
 *     caller of `updateAvailable` announce a downgrade as an upgrade.
 *   - Only the galaxy package itself follows the release-channel setting;
 *     every other plugin is compared against `latest`. Opting into early
 *     builds is volunteering to try THIS plugin early, not a licence to pull
 *     every other author's unreleased work.
 *
 * The cache, the registry base and the active region live in `GalaxyRuntime`
 * (`runtime.cache('updates.cache')`), not in module state, so two mounts in one
 * process cannot read each other's answers.
 */

import { join } from 'node:path'
import { readJsonFile } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import { fetchJson } from '../core/net.ts'
import {
  installedPackageDir,
  isInstalled,
  readInstalled,
  readInstalledVersion,
  readLockfile,
  specKind,
  specRepo,
} from '../core/profile.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import { readGalaxyState } from '../core/state.ts'
import type { Channel, Region, UpdateStatus } from '../core/types.ts'
import { resolveHeadCommit } from './accelerate.ts'
import { channelFromVersion, channelTags } from './channels.ts'
import { loadRegistry } from './registry.ts'
import { resolveRegion, routesFor } from './regions.ts'

/** How long one full listing is reused. */
export const UPDATES_TTL_MS = 30 * 60 * 1000

const CACHE_KEY = 'updates.cache'
const NPM_TIMEOUT_MS = 10_000

/** Outbound politeness for a profile with many plugins. */
const CONCURRENCY = 6

/** The only package whose updates follow the release-channel setting. */
const SELF_NAMES: ReadonlySet<string> = new Set(['dsh-plugin-galaxy'])

const NPM_NAME_RE = /^(@[A-Za-z0-9-~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9-~][A-Za-z0-9._~-]*$/u
const EXACT_VERSION_RE = /^=?(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u

/** Options accepted by {@link checkUpdates}. */
export interface CheckUpdatesOptions {
  /** Ignore the TTL cache and ask the sources again. */
  force?: boolean
  /** Restrict the answer to these package names (the full listing is cached). */
  names?: string[]
}

interface UpdatesCacheEntry {
  /** Profile directory + region + channel the listing was computed for. */
  key: string
  at: number
  data: UpdateStatus[]
}

/* ------------------------------------------------------------------ *
 * Version comparison
 * ------------------------------------------------------------------ */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

function parseSemver(version: string): { core: number[]; pre: string[] } | null {
  const match = SEMVER_RE.exec(version.trim())
  if (match === null) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Semver precedence: negative / 0 / positive like a comparator, or null when
 * either side is not a plain semver version. Build metadata is ignored, a
 * release outranks any prerelease of the same core, and prerelease identifiers
 * compare numerically when both are numeric (so `rc.10` > `rc.9`).
 */
export function compareVersions(left: string, right: string): number | null {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (a === null || b === null) return null
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return (a.core[index] as number) - (b.core[index] as number)
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const numericX = /^\d+$/u.test(x)
    const numericY = /^\d+$/u.test(y)
    if (numericX && numericY) return Number(x) - Number(y)
    if (numericX !== numericY) return numericX ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * True only when the candidate is semantically HIGHER than what is installed.
 *
 * A plain `!==` also fires when a package's `latest` dist-tag is left pointing
 * at an OLDER release than the pinned install — clicking "update" would then
 * rewrite the exact pin to `@latest` and downgrade the profile. Undecidable
 * inputs (missing or non-semver versions) report no update: without a
 * direction we cannot promise the "update" is not a downgrade.
 */
export function isUpgrade(installed: string | null | undefined, latest: string | null | undefined): boolean {
  if (installed === null || installed === undefined || latest === null || latest === undefined) return false
  const comparison = compareVersions(latest, installed)
  return comparison !== null && comparison > 0
}

/* ------------------------------------------------------------------ *
 * Registry reads
 * ------------------------------------------------------------------ */

/** One dist-tag's version, or null when it is unpublished or unreachable. */
async function npmTagVersion(name: string, tag: string, region: Region): Promise<string | null> {
  const base = routesFor(region).npm
  const response = await fetchJson({
    url: `${base}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
    headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-galaxy' },
    timeoutMs: NPM_TIMEOUT_MS,
  })
  if (!response.ok) return null
  const body = response.body
  if (typeof body !== 'object' || body === null) return null
  const version = (body as { version?: unknown }).version
  return typeof version === 'string' && version !== '' ? version : null
}

/** The registry's current `latest` version, or null when it cannot be read. */
export async function fetchNpmLatest(name: string, region: Region = 'global'): Promise<string | null> {
  try {
    return await npmTagVersion(name, 'latest', region)
  } catch {
    return null
  }
}

/**
 * The newest build a channel subscriber should be offered.
 *
 * See `channelTags` for why a channel is a set: following the single `beta`
 * tag literally would walk a subscriber backwards once a release ships, and
 * narrowing the set is the only way back off a channel.
 */
export async function versionOnChannel(
  name: string,
  channel: Channel,
  region: Region = 'global',
): Promise<string | null> {
  let best: string | null = null
  for (const tag of channelTags(channel)) {
    let candidate: string | null = null
    try {
      candidate = await npmTagVersion(name, tag, region)
    } catch {
      // An unpublished tag is the ordinary case for a channel nobody has cut
      // a build on yet; a registry hiccup must not take the check down.
      candidate = null
    }
    if (candidate !== null && (best === null || isUpgrade(best, candidate))) best = candidate
  }
  return best
}

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

/** The installed version, or undefined when the package tree is unreadable. */
export function readInstalledVersionSafe(profile: string, name: string, explicitDir?: string): string | undefined {
  try {
    return readInstalledVersion(profile, name, explicitDir)
  } catch {
    return undefined
  }
}

/** Drop the cached listing (after a channel/region/proxy change or a mutation). */
export function invalidateUpdates(runtime: GalaxyRuntime): void {
  runtime.caches.delete(CACHE_KEY)
}

/** The exact version a spec pins, when it pins one (`1.2.3`, `=1.2.3`). */
function exactPin(spec: string): string | null {
  const trimmed = spec.trim()
  return EXACT_VERSION_RE.test(trimmed) ? trimmed.replace(/^=/u, '') : null
}

/** The registry package behind an `npm:` alias spec, when it parses. */
function aliasTarget(spec: string): string | null {
  const alias = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.+))?$/u.exec(spec.trim())
  const name = alias?.[1]?.trim()
  return name !== undefined && NPM_NAME_RE.test(name) ? name : null
}

/** True when the spec may be compared against the npm registry by name. */
function isNpmComparable(name: string, spec: string): boolean {
  if (!NPM_NAME_RE.test(name)) return false
  const trimmed = spec.trim()
  if (trimmed.startsWith('npm:')) return aliasTarget(trimmed) !== null
  return !/^(?:git\+|git:|ssh:|https?:|file:|link:|workspace:|portal:|\.|\/)/iu.test(trimmed)
}

/**
 * Local-source prefixes `core/profile.ts`'s `specKind` does not classify.
 *
 * `link:`, `workspace:` and `portal:` are all development sources — a
 * checkout, not a published package — and none of them may be compared
 * against a registry. Left to `specKind` alone, `link:` lands in `unknown` and
 * the row loses the "installed from a local source" explanation it deserves.
 */
function localKindOf(spec: string): 'local' | null {
  const trimmed = spec.trim().toLowerCase()
  return trimmed.startsWith('link:') || trimmed.startsWith('workspace:') || trimmed.startsWith('portal:')
    ? 'local'
    : null
}

/** The `#selector` of a git spec, without the `#`. */
function selectorOf(spec: string): string | null {
  const hash = spec.indexOf('#')
  return hash === -1 ? null : spec.slice(hash + 1)
}

/**
 * Pinned commit per `owner/repo` from the profile lockfile's codeload tarball
 * URLs. A mutable `github:` shortcut keeps its commit here, which is why this
 * read is part of every git comparison.
 */
function readLockCommits(profile: string, dir: string): Map<string, string> {
  const commits = new Map<string, string>()
  const lock = readLockfile(profile, dir)
  if (lock === null) return commits
  for (const match of lock.matchAll(/codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})/gu)) {
    commits.set(match[1].toLowerCase(), match[2])
  }
  return commits
}

/** The package name an installed tree identifies itself by, when readable. */
function installedPackageName(profile: string, name: string, dir: string): string | undefined {
  const manifest = readJsonFile<{ name?: unknown }>(join(installedPackageDir(profile, name, dir), 'package.json'))
  return typeof manifest?.name === 'string' ? manifest.name : undefined
}

/**
 * Verified git→npm targets from the curated catalog, keyed by repository.
 *
 * A migration changes package name and provenance, so only repository
 * evidence carried by the catalog may authorize it. The lookup is best effort:
 * an unreachable catalog means "no migration hint", never a failed listing.
 */
async function catalogMigrations(
  profile: string,
  dir: string,
  repos: readonly string[],
): Promise<Map<string, string>> {
  const migrations = new Map<string, string>()
  if (repos.length === 0) return migrations
  try {
    const registry = await loadRegistry(profile, dir)
    for (const plugin of registry.plugins) {
      const npm = typeof plugin.npm === 'string' ? plugin.npm.trim() : ''
      if (npm === '' || !NPM_NAME_RE.test(npm)) continue
      const url = typeof plugin.url === 'string' ? plugin.url : ''
      const repo = url === '' ? undefined : specRepo(url)
      if (repo === undefined) continue
      const key = repo.split('#')[0].toLowerCase()
      if (!migrations.has(key)) migrations.set(key, npm)
    }
  } catch (error) {
    logEvent('warn', 'updates', `catalog migration lookup failed — ${(error as Error).message}`)
  }
  return migrations
}

/** Run `worker` over `items` with a bounded number of concurrent calls. */
async function mapLimited<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index] as T)
    }
  })
  await Promise.all(runners)
  return results
}

/* ------------------------------------------------------------------ *
 * Per-source comparison
 * ------------------------------------------------------------------ */

interface CheckContext {
  profile: string
  dir: string
  region: Region
  channel: Channel
  runtime?: GalaxyRuntime | undefined
  lockCommits: Map<string, string>
  migrations: Map<string, string>
}

async function npmStatus(
  name: string,
  spec: string,
  version: string | undefined,
  context: CheckContext,
): Promise<UpdateStatus> {
  const registryName = aliasTarget(spec) ?? name
  const followsChannel = SELF_NAMES.has(name)
  const latest = followsChannel
    ? await versionOnChannel(registryName, context.channel, context.region)
    : await fetchNpmLatest(registryName, context.region)
  const upgrade = isUpgrade(version, latest)
  const status: UpdateStatus = {
    name,
    kind: 'npm',
    updateAvailable: upgrade,
    checkedAt: Date.now(),
  }
  if (version !== undefined) status.current = version
  if (latest !== null) status.latest = latest
  // A difference in the other direction is a channel switch, under its own
  // field: it is the only way back off a channel the user has just left.
  if (followsChannel && !upgrade && version !== undefined && latest !== null && version !== latest) {
    status.channelSwitch = context.channel
  }
  if (!upgrade && latest === null) status.reason = 'the registry did not answer for this package'
  // A recorded exact pin that no longer matches the installed tree must be
  // rewritten before an update can be applied.
  const pinned = exactPin(spec)
  if (pinned !== null && version !== undefined && version !== pinned) status.restoreRequired = true
  return status
}

async function gitStatus(name: string, spec: string, version: string | undefined, context: CheckContext): Promise<UpdateStatus> {
  const repo = specRepo(spec)
  const selector = selectorOf(spec)
  const pinned = selector !== null && /^[0-9a-f]{40}$/iu.test(selector) ? selector.toLowerCase() : null
  const ref = selector === null || pinned !== null || selector.startsWith('path:') ? undefined : selector
  const status: UpdateStatus = { name, kind: 'git', updateAvailable: false, checkedAt: Date.now() }
  if (version !== undefined) status.current = version
  if (repo === undefined) {
    status.reason = 'this Git host has no supported route for a HEAD comparison'
    return status
  }
  const lockCommit = context.lockCommits.get(repo.toLowerCase()) ?? null
  const current = pinned ?? lockCommit
  const latest = await resolveHeadCommit(repo, context.region, context.runtime, ref)
  if (current !== null) status.current = current
  if (latest !== null) status.latest = latest
  status.updateAvailable = current !== null && latest !== null && current !== latest
  if (pinned !== null && lockCommit !== null && lockCommit !== pinned) status.restoreRequired = true
  // An explicit branch/tag/commit is the user's choice and is never migrated.
  const migration = selector === null || selector.startsWith('path:')
    ? context.migrations.get(repo.split('#')[0].toLowerCase())
    : undefined
  if (migration !== undefined) {
    status.sourceMigration = { from: repo, to: `${migration}@latest`, packageName: migration }
    status.updateAvailable = false
  }
  return status
}

/**
 * The re-install spec an update should use.
 *
 * The version is PINNED to the one the update checker just reported, and that is
 * the point: `pkg@latest` is resolved by pnpm against its OWN cached registry
 * metadata, which can still call the old version latest. The update then exits 0
 * having added nothing — specifier, installed version and lockfile all unchanged
 * — while the operator is told it succeeded. Measured on a real profile:
 * `add @linxin666/dsh-client-ui-skill-explorer@latest` with the registry (and
 * `pnpm view`) reporting 0.3.21 downloaded 0 and kept 0.3.20. Asking for the
 * exact version either installs it or fails loudly.
 *
 * Specs whose identity is not an npm range are returned untouched: rewriting
 * `github:owner/repo`, a git URL, a tarball or a `file:`/`link:` source by name
 * is what previously installed an unrelated package that shared the name.
 *
 * @param name - installed package name.
 * @param spec - the dependency specifier recorded in the profile manifest.
 * @param latest - the version the checker reported, when it is known.
 * @returns the spec to hand to `dsh plugin add`.
 */
export function updateSpecFor(name: string, spec: string, latest?: string): string {
  const pinned = typeof latest === 'string' ? latest.trim() : ''
  if (/^(?:link|file):/iu.test(spec)) return spec
  if (spec.endsWith('.tgz') || spec.endsWith('.tar.gz')) return spec
  if (/^github:/iu.test(spec) || /github\.com/iu.test(spec)) return spec
  if (/^(?:git\+|git:|ssh:)/iu.test(spec)) return spec
  if (/^https?:/iu.test(spec) && !/npmjs/iu.test(spec)) return spec
  return pinned === '' ? `${name}@latest` : `${name}@${pinned}`
}

function localStatus(name: string, spec: string, version: string | undefined, context: CheckContext): UpdateStatus {
  const status: UpdateStatus = { name, kind: 'local', updateAvailable: false, checkedAt: Date.now() }
  if (version !== undefined) status.current = version
  if (spec.toLowerCase().startsWith('link:')) {
    status.reason = 'development link — not compared against a registry'
    return status
  }
  const present = isInstalled(context.profile, name, context.dir)
  const declared = present ? installedPackageName(context.profile, name, context.dir) : undefined
  if (!present) {
    status.kind = 'restore'
    status.restoreRequired = true
    status.reason = 'the recorded local source is not installed'
    return status
  }
  if (declared !== undefined && declared !== name) {
    // The spec no longer describes the package it points at: the dependency
    // must be rewritten/restored rather than updated.
    status.kind = 'restore'
    status.restoreRequired = true
    status.reason = `the installed package identifies itself as ${declared}`
    return status
  }
  status.reason = 'installed from a local source'
  return status
}

async function statusFor(name: string, spec: string, context: CheckContext): Promise<UpdateStatus> {
  const version = readInstalledVersionSafe(context.profile, name, context.dir)
  const kind = localKindOf(spec) ?? specKind(spec)
  try {
    if (kind === 'git') return await gitStatus(name, spec, version, context)
    if (kind === 'local') return localStatus(name, spec, version, context)
    if (kind === 'npm' || kind === 'alias' || (kind === 'unknown' && isNpmComparable(name, spec))) {
      return await npmStatus(name, spec, version, context)
    }
    const status: UpdateStatus = { name, kind: 'unknown', updateAvailable: false, checkedAt: Date.now() }
    if (version !== undefined) status.current = version
    status.reason = kind === 'tarball'
      ? 'pinned tarball source — nothing to compare'
      : 'unrecognized source spec'
    return status
  } catch (error) {
    // One plugin's failed check must not fail the listing.
    logEvent('warn', 'updates', `${name}: update check failed — ${(error as Error).message}`)
    const status: UpdateStatus = { name, kind: 'unknown', updateAvailable: false, checkedAt: Date.now() }
    if (version !== undefined) status.current = version
    status.reason = 'the check could not be completed'
    return status
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Per-plugin update checks, cached for {@link UPDATES_TTL_MS}.
 *
 * The cache key contains the profile directory, the region and the channel:
 * a mirror can lag the official registry by minutes and switching channels
 * must change the answer immediately, so answers gathered under one routing
 * decision are not answers under another.
 *
 * @param profile - profile name.
 * @param dir - resolved profile directory.
 * @param options - `force` bypasses the cache, `names` narrows the answer
 *   (the full listing is what gets cached, so a narrowed answer cannot poison
 *   the next full one).
 * @param runtime - when present, owns the cache and provides the region,
 *   channel and route preferences.
 */
export async function checkUpdates(
  profile: string,
  dir: string,
  options: CheckUpdatesOptions = {},
  runtime?: GalaxyRuntime,
): Promise<UpdateStatus[]> {
  const region: Region = runtime === undefined ? 'global' : resolveRegion(runtime)
  const channel: Channel = runtime === undefined
    ? 'stable'
    : readGalaxyState(runtime.dir).channel ?? channelFromVersion(runtime.version)
  const key = `${dir}\u0000${region}\u0000${channel}`

  const cached = runtime?.cache<UpdatesCacheEntry>(CACHE_KEY)
  let statuses: UpdateStatus[]
  if (options.force !== true && cached !== undefined && cached.key === key && Date.now() - cached.at < UPDATES_TTL_MS) {
    statuses = cached.data
  } else {
    statuses = await collectStatuses(profile, dir, region, channel, runtime)
    runtime?.setCache(CACHE_KEY, { key, at: Date.now(), data: statuses } satisfies UpdatesCacheEntry)
  }

  const wanted = options.names
  if (wanted === undefined || wanted.length === 0) return [...statuses]
  const selected = new Set(wanted)
  return statuses.filter(status => selected.has(status.name))
}

/** Compute the full, sorted listing for one profile. */
async function collectStatuses(
  profile: string,
  dir: string,
  region: Region,
  channel: Channel,
  runtime?: GalaxyRuntime,
): Promise<UpdateStatus[]> {
  const declared = readInstalled(profile, dir)
  const entries = Object.entries(declared)
  if (entries.length === 0) return []

  // Only a git source can be migrated, and a migration hint is worth a catalog
  // read only when at least one is installed.
  const repos = entries
    .filter(([, spec]) => specKind(spec) === 'git')
    .map(([, spec]) => specRepo(spec)?.split('#')[0] ?? '')
    .filter(repo => repo !== '')
  const context: CheckContext = {
    profile,
    dir,
    region,
    channel,
    runtime,
    lockCommits: readLockCommits(profile, dir),
    migrations: await catalogMigrations(profile, dir, repos),
  }

  const statuses = await mapLimited(entries, CONCURRENCY, async ([name, spec]) => statusFor(name, spec, context))
  return statuses.sort((left, right) => left.name.localeCompare(right.name))
}
