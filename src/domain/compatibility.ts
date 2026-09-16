/**
 * Host-compatibility evaluation.
 *
 * What this module owns:
 *   - the verdict computed from a plugin's public
 *    manifest (status / basis / requirement /
 *    declarations),
 *   - the pre-install compatibility forecast on the
 *    plugin cards,
 *   - the shared vocabulary of that endpoint,
 *   - the "what risk does this install add?" diff.
 *
 * The comparison is deliberately small: a handful of npm range shapes are
 * understood (`^`, `~`, `>=`, `>`, `<`, `<=`, exact, `*`, `||`, hyphen ranges
 * and x-ranges). A range this module cannot parse makes a verdict `unknown`,
 * never `compatible`: claiming compatibility from a document we did not
 * understand is the one answer that can break someone's host.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '../core/paths.ts'
import type { CompatRisk, HostCompatibility, NpmManifest } from '../core/types.ts'

/** A fully resolved version, with prerelease identifiers split out. */
interface Version {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

/** A version as written in a range, where parts may have been omitted. */
interface PartialVersion extends Version {
  minorGiven: boolean
  patchGiven: boolean
}

interface Comparator {
  op: '=' | '<' | '<=' | '>' | '>='
  version: Version
}

/** Outcome of evaluating one declaration against the host version. */
type RangeOutcome = 'accept' | 'reject' | 'unknown'

const VERSION_RE = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** The host version this process runs under, when the host told us. */
export function hostVersionFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.DSH_HOST_VERSION
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

/** Where a detected host version was read from. */
export type HostVersionSource = 'env' | 'profile' | 'anchor'

/** A host version plus provenance, so a UI can say where the number came from. */
export interface HostVersionInfo {
  version: string
  source: HostVersionSource
}

/**
 * Package manifests that carry the running host version, most specific first.
 *
 * All four are published from the same release line, so any of them identifies
 * the release the profile was built for. `@deepseek-ai/cordis` is deliberately
 * NOT here: its version line (4.x) is unrelated to the host release, and using
 * it as an anchor would report "host 4.0.2".
 */
const HOST_PACKAGE_NAMES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh',
] as const

/** Cache slot of the resolved host version (it cannot change while we run). */
const HOST_VERSION_KEY = 'host.version'

/** Read one package manifest's `version`; unreadable or malformed means unknown. */
function readPackageVersion(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' && version.trim() !== '' ? version.trim() : undefined
  } catch {
    // No file, no permission, not JSON: all of them simply mean "not here".
    return undefined
  }
}

/**
 * The running host's version.
 *
 * The host never sets `DSH_HOST_VERSION` (the variable exists in this plugin,
 * not in dsh), so relying on the environment alone left every compatibility
 * verdict `unknown` — permanently, on every host. The version IS knowable: the
 * profile's dependency anchor installs the host packages next to the profile
 * (`<dsh home>/profiles/node_modules/@deepseek-ai/dsh-base`), and a profile may
 * even carry its own copy.
 *
 * Order: the explicit environment override wins, then the profile's own
 * `node_modules`, then the shared anchor. Nothing is inferred from a file name
 * or a timestamp — an unreadable manifest means `undefined`, because a wrong
 * version would make every verdict built on it a lie.
 *
 * @param profileDir - resolved profile directory, when the caller has one.
 */
export function detectHostVersion(profileDir?: string): HostVersionInfo | undefined {
  const explicit = hostVersionFromEnv()
  if (explicit !== undefined) return { version: explicit, source: 'env' }
  const roots: Array<{ root: string; source: HostVersionSource }> = []
  if (profileDir !== undefined && profileDir.trim() !== '') {
    roots.push({ root: profileDir, source: 'profile' })
  }
  try {
    roots.push({ root: join(resolveDshHome(), 'profiles'), source: 'anchor' })
  } catch {
    // An unresolvable home simply means there is no anchor to read.
  }
  for (const { root, source } of roots) {
    for (const name of HOST_PACKAGE_NAMES) {
      const version = readPackageVersion(join(root, 'node_modules', name, 'package.json'))
      if (version !== undefined) return { version, source }
    }
  }
  return undefined
}

/**
 * The INSTALLED version of one package in this profile (or the shared anchor).
 *
 * Needed because a `peerDependencies` range names a *package*, not the DSH
 * release: `"@deepseek-ai/cordis": "^4.0.1"` compares against the cordis that is
 * installed (4.0.2), not against "DSH 0.1.5". Judging it against the host
 * version reported every peer-declaring plugin as incompatible the moment the
 * host version became known.
 *
 * @param name - package name to look up.
 * @param profileDir - resolved profile directory, when the caller has one.
 */
export function installedVersionOf(name: string, profileDir?: string): string | undefined {
  const roots: string[] = []
  if (profileDir !== undefined && profileDir.trim() !== '') roots.push(profileDir)
  try {
    roots.push(join(resolveDshHome(), 'profiles'))
  } catch {
    // No resolvable home: only a profile-local lookup remains possible.
  }
  for (const root of roots) {
    const version = readPackageVersion(join(root, 'node_modules', ...name.split('/'), 'package.json'))
    if (version !== undefined) return version
  }
  return undefined
}

/** Structural runtime surface needed to resolve and memoize the host version. */
export interface HostVersionRuntimeLike {
  config: { profileDirectory: string }
  cache<T>(key: string): T | undefined
  setCache(key: string, value: unknown): void
}

/**
 * {@link detectHostVersion}, resolved once per mount.
 *
 * Polled routes (`/status`, `/registry`) ask for this on every request, and the
 * answer cannot change while the process lives.
 */
export function hostVersionInfo(runtime: HostVersionRuntimeLike): HostVersionInfo | undefined {
  const cached = runtime.cache<HostVersionInfo | null>(HOST_VERSION_KEY)
  if (cached !== undefined) return cached === null ? undefined : cached
  const detected = detectHostVersion(runtime.config.profileDirectory)
  runtime.setCache(HOST_VERSION_KEY, detected ?? null)
  return detected
}

function parsePartialVersion(text: string): PartialVersion | undefined {
  const match = VERSION_RE.exec(text.trim())
  if (match === null) return undefined
  const major = Number(match[1])
  if (!Number.isFinite(major)) return undefined
  const part = (raw: string | undefined): { value: number; given: boolean } => {
    if (raw === undefined || raw === 'x' || raw === 'X' || raw === '*') return { value: 0, given: false }
    const value = Number(raw)
    return Number.isFinite(value) ? { value, given: true } : { value: 0, given: false }
  }
  const minor = part(match[2])
  const patch = part(match[3])
  const prerelease = (match[4] ?? '').split('.').filter(identifier => identifier !== '')
  return {
    major,
    minor: minor.value,
    patch: patch.value,
    prerelease,
    // npm treats a major-only `1` as `1.x`, but `1.x` and an omitted minor are
    // the same statement, so one flag covers both spellings.
    minorGiven: minor.given,
    patchGiven: patch.given,
  }
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0
  // A release outranks any prerelease of the same version (1.0.0 > 1.0.0-rc.1).
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a) ? Number(a) : null
    const bNumeric = /^\d+$/.test(b) ? Number(b) : null
    if (aNumeric !== null && bNumeric !== null) {
      if (aNumeric !== bNumeric) return aNumeric < bNumeric ? -1 : 1
      continue
    }
    // Numeric identifiers always sort before alphanumeric ones.
    if (aNumeric !== null) return -1
    if (bNumeric !== null) return 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

function compareVersions(left: Version, right: Version): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

function atLeast(version: PartialVersion): Comparator {
  return { op: '>=', version: { major: version.major, minor: version.minor, patch: version.patch, prerelease: version.prerelease } }
}

function exact(version: PartialVersion): Comparator {
  return { op: '=', version: { major: version.major, minor: version.minor, patch: version.patch, prerelease: version.prerelease } }
}

function upper(major: number, minor: number, patch: number): Comparator {
  return { op: '<', version: { major, minor, patch, prerelease: [] } }
}

/** The exclusive ceiling `^` implies, following npm's 0.x special cases. */
function caretCeiling(version: PartialVersion): Comparator {
  if (version.major > 0) return upper(version.major + 1, 0, 0)
  if (!version.minorGiven) return upper(1, 0, 0)
  if (version.minor > 0 || !version.patchGiven) return upper(0, version.minor + 1, 0)
  return upper(0, 0, version.patch + 1)
}

/** The exclusive ceiling `~` implies. */
function tildeCeiling(version: PartialVersion): Comparator {
  if (!version.minorGiven) return upper(version.major + 1, 0, 0)
  return upper(version.major, version.minor + 1, 0)
}

/** Comparators for an exact or partial version (`1.2.3`, `1.2`, `1.x`). */
function exactComparators(version: PartialVersion): Comparator[] {
  if (!version.minorGiven) return [atLeast(version), upper(version.major + 1, 0, 0)]
  if (!version.patchGiven) return [atLeast(version), upper(version.major, version.minor + 1, 0)]
  return [exact(version)]
}

/** Build the comparator set one range token stands for, or undefined. */
function comparatorsForToken(token: string): Comparator[] | undefined {
  const match = /^(\^|~|>=|<=|>|<|=)?(.*)$/u.exec(token)
  if (match === null) return undefined
  const op = match[1] ?? ''
  const body = (match[2] ?? '').trim()
  if (body === '' || body === '*' || body === 'x' || body === 'X') return []
  const version = parsePartialVersion(body)
  if (version === undefined) return undefined
  switch (op) {
    case '':
    case '=':
      return exactComparators(version)
    case '^':
      return [atLeast(version), caretCeiling(version)]
    case '~':
      return [atLeast(version), tildeCeiling(version)]
    case '>=':
      return [atLeast(version)]
    case '<':
      return [{ op: '<', version: exact(version).version }]
    case '>':
      // `>1.2` means "after every 1.2.x", so the floor moves up a step: to the
      // next minor when only the patch was omitted, to the next major when the
      // minor was omitted too.
      if (!version.patchGiven) {
        return !version.minorGiven
          ? [{ op: '>=', version: { major: version.major + 1, minor: 0, patch: 0, prerelease: [] } }]
          : [{ op: '>=', version: { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] } }]
      }
      return [{ op: '>', version: exact(version).version }]
    case '<=':
      // `<=1.2` means "no later than any 1.2.x", so the ceiling moves up.
      if (!version.patchGiven) {
        return !version.minorGiven
          ? [upper(version.major + 1, 0, 0)]
          : [upper(version.major, version.minor + 1, 0)]
      }
      return [{ op: '<=', version: exact(version).version }]
    default:
      return undefined
  }
}

function comparatorsForAlternative(alternative: string): Comparator[] | undefined {
  const trimmed = alternative.trim()
  if (trimmed === '') return []
  // Hyphen range: `1.2.3 - 2.0.0`. A partial upper bound widens the band,
  // matching npm (`1.2.3 - 2.3` accepts every 2.3.x).
  const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(trimmed)
  if (hyphen !== null) {
    const lower = parsePartialVersion(hyphen[1] as string)
    const upperBound = parsePartialVersion(hyphen[2] as string)
    if (lower === undefined || upperBound === undefined) return undefined
    if (!upperBound.patchGiven) {
      return !upperBound.minorGiven
        ? [atLeast(lower), upper(upperBound.major + 1, 0, 0)]
        : [atLeast(lower), upper(upperBound.major, upperBound.minor + 1, 0)]
    }
    return [atLeast(lower), { op: '<=', version: exact(upperBound).version }]
  }
  const comparators: Comparator[] = []
  for (const token of trimmed.split(/\s+/u)) {
    if (token === '') continue
    const built = comparatorsForToken(token)
    if (built === undefined) return undefined
    comparators.push(...built)
  }
  return comparators
}

/** Parse a range into alternatives (OR-ed); every alternative is AND-ed. */
function parseRange(range: string): Comparator[][] | undefined {
  const alternatives: Comparator[][] = []
  for (const rawAlternative of range.split('||')) {
    const comparators = comparatorsForAlternative(rawAlternative)
    if (comparators === undefined) return undefined
    alternatives.push(comparators)
  }
  return alternatives.length === 0 ? undefined : alternatives
}

function satisfiesComparator(version: Version, comparator: Comparator): boolean {
  const order = compareVersions(version, comparator.version)
  if (comparator.op === '=') return order === 0
  if (comparator.op === '<') return order < 0
  if (comparator.op === '<=') return order <= 0
  if (comparator.op === '>') return order > 0
  return order >= 0
}

function satisfiesAlternative(version: Version, comparators: Comparator[]): boolean {
  for (const comparator of comparators) {
    if (!satisfiesComparator(version, comparator)) return false
  }
  // npm semantics: a prerelease only matches when some comparator in the
  // alternative names a prerelease of the same [major, minor, patch]. Without
  // this, `0.2.0-rc.1` would silently satisfy `>=0.1.0`.
  if (version.prerelease.length === 0) return true
  return comparators.some(comparator =>
    comparator.version.prerelease.length > 0
    && comparator.version.major === version.major
    && comparator.version.minor === version.minor
    && comparator.version.patch === version.patch)
}

/**
 * Whether `range` accepts `hostVersion`.
 *
 * @returns `true`/`false` for a range this module understands, and `null` when
 *   it does not understand the range or the host version — an inconclusive
 *   answer that callers must not render as compatibility.
 */
export function satisfiesHostRange(hostVersion: string, range: string): boolean | null {
  const version = parsePartialVersion(hostVersion)
  if (version === undefined) return null
  const alternatives = parseRange(range)
  if (alternatives === undefined) return null
  return alternatives.some(alternative => satisfiesAlternative(version, alternative))
}

function evaluateRange(hostVersion: string, range: string): RangeOutcome {
  const satisfied = satisfiesHostRange(hostVersion, range)
  return satisfied === null ? 'unknown' : satisfied ? 'accept' : 'reject'
}

/**
 * The host verdict for one npm manifest.
 *
 * Every declaration is conjunctive: an explicit `dsh.hostVersion` and every
 * declared peer range must accept the host version. One rejection is enough
 * for `incompatible`; nothing declared at all is `unknown`, as is a manifest
 * whose ranges or host version cannot be understood.
 *
 * @param manifest - the package manifest, or null when it could not be read.
 * @param hostVersion - the running DSH version; blank means "not known here",
 *   which yields `unknown` rather than an invented answer.
 */
/** Optional inputs for {@link deriveHostCompatibility}. */
export interface CompatibilityOptions {
  /**
   * Installed version of a peer dependency, when the caller can resolve one.
   * An unresolvable peer is NOT a rejection: the peer may simply not be
   * installed here (it can be a sibling plugin added later), and inventing a
   * mismatch from a missing package is how the column became untrustworthy.
   */
  peerVersion?: (name: string) => string | undefined
}

export function deriveHostCompatibility(
  manifest: NpmManifest | null | undefined,
  hostVersion: string,
  options: CompatibilityOptions = {},
): HostCompatibility {
  const name = typeof manifest?.name === 'string' ? manifest.name.trim() : ''
  if (manifest === null || manifest === undefined) {
    return { name, status: 'unknown', basis: 'none', reason: 'no manifest was available for this package' }
  }

  const declarations: Record<string, string> = {}
  // TWO spellings, because both are in the wild: `dsh.hostVersion` is what this
  // plugin publishes, while `dsh.engines.dsh` is the convention other DSH
  // plugins use (e.g. the aggregate web UI declares `>=0.1.5-rc.1` there). A
  // reader that knew only one of them reported `unknown` for half the catalog.
  const hostRange = typeof manifest.dsh?.hostVersion === 'string' ? manifest.dsh.hostVersion.trim() : ''
  if (hostRange !== '') declarations['dsh.hostVersion'] = hostRange
  const enginesRange = typeof manifest.dsh?.engines?.dsh === 'string'
    ? manifest.dsh.engines.dsh.trim()
    : (typeof manifest.engines?.dsh === 'string' ? manifest.engines.dsh.trim() : '')
  if (enginesRange !== '' && enginesRange !== hostRange) declarations['dsh.engines.dsh'] = enginesRange
  for (const [dependency, rawRange] of Object.entries(manifest.peerDependencies ?? {})) {
    if (typeof rawRange !== 'string') continue
    const range = rawRange.trim()
    if (range === '') continue
    declarations[dependency] = range
  }

  const keys = Object.keys(declarations)
  if (keys.length === 0) {
    return {
      name,
      status: 'unknown',
      basis: 'none',
      reason: 'the package declares no host version requirement',
    }
  }
  /** Peers named but not installed here: reported, never treated as failures. */
  const unresolvedPeers: string[] = []
  const requirement = [...new Set(Object.values(declarations))].join(' && ')
  const version = hostVersion.trim()
  if (version === '') {
    return {
      name,
      status: 'unknown',
      basis: 'manifest',
      requirement,
      declarations,
      reason: 'the running DSH version is unknown, so declared ranges cannot be evaluated',
    }
  }

  const rejected: string[] = []
  let undecided = 0
  let checked = 0
  for (const [dependency, range] of Object.entries(declarations)) {
    // A `dsh.*` key is the host release; anything else names a package whose own
    // installed version is the only meaningful thing to compare against.
    const against = dependency.startsWith('dsh.') ? version : options.peerVersion?.(dependency)
    if (against === undefined) {
      unresolvedPeers.push(dependency)
      continue
    }
    checked += 1
    const outcome = evaluateRange(against, range)
    if (outcome === 'reject') rejected.push(dependency)
    else if (outcome === 'unknown') undecided += 1
  }

  if (rejected.length > 0) {
    const failing = [...new Set(rejected.map(dependency => declarations[dependency] as string))].join(' && ')
    const basis = rejected[0].startsWith('dsh.') ? 'host-version' : 'peer'
    return {
      name,
      status: 'incompatible',
      basis,
      requirement: failing,
      declarations,
      reason: `${rejected.join(', ')} does not accept DSH ${version} (requires ${failing})`,
    }
  }
  if (undecided > 0) {
    return {
      name,
      status: 'unknown',
      basis: 'manifest',
      requirement,
      declarations,
      reason: 'at least one declared range could not be understood',
    }
  }
  if (checked === 0) {
    // Peer-only manifest whose peers are not installed here: nothing was
    // actually judged, so say so instead of claiming compatibility.
    return {
      name,
      status: 'unknown',
      basis: 'manifest',
      requirement,
      declarations,
      reason: `no declared range could be checked (not installed here: ${unresolvedPeers.join(', ')})`,
    }
  }
  return {
    name,
    status: 'compatible',
    basis: keys.some(key => key.startsWith('dsh.')) ? 'host-version' : 'peer',
    requirement,
    declarations,
    ...(unresolvedPeers.length === 0
      ? {}
      : { reason: `not evaluated here (not installed in this profile): ${unresolvedPeers.join(', ')}` }),
  }
}

/**
 * Risks an operation introduced: entries that are incompatible after it and
 * were not incompatible before.
 *
 * This is what makes a compatibility warning actionable — a profile that was
 * already broken is not this install's doing, and the install that just ran is
 * exactly the thing a rollback can undo.
 *
 * @param before - verdicts captured before the mutation.
 * @param after - verdicts captured after it.
 */
export function introducedRisks(
  before: readonly HostCompatibility[],
  after: readonly HostCompatibility[],
): CompatRisk[] {
  const previous = new Map<string, HostCompatibility>()
  for (const entry of before) previous.set(entry.name, entry)
  const hostVersion = hostVersionFromEnv() ?? ''
  const risks: CompatRisk[] = []
  for (const entry of after) {
    if (entry.status !== 'incompatible') continue
    const prior = previous.get(entry.name)
    if (prior !== undefined && prior.status === 'incompatible') continue
    risks.push({
      name: entry.name,
      requirement: entry.requirement ?? 'host compatibility',
      hostVersion,
      severity: 'error',
      detail: entry.reason ?? `${entry.name} does not accept this host version`,
    })
  }
  return risks
}
