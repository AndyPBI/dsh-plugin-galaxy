/**
 * Peer-range classification and the log-export state snapshot.
 *
 * This module owns the one semver-range implementation of the project. It is
 * deliberately dependency-free (no `semver` package): the checks run on every
 * market open and only ever compare already-resolved versions against the
 * ranges plugins declare, which is the small, well-defined subset of range
 * grammar implemented below (`^`, `~`, `>=`, `<=`, `>`, `<`, `=`, exact,
 * partial and wildcard versions, whitespace-separated conjunctions, `||`
 * alternatives and hyphen ranges).
 *
 * `checkProfile` is the diagnostics entry point used by the panel; it
 * delegates to ./diagnostics.ts so the report has exactly one implementation.
 * `profileSnapshotLines` renders the `## profile state` section the log export
 * prepends to a bug report.
 *
 * Import-cycle note: ./diagnostics.ts imports `classifyPeer` from here while
 * this module imports `analyzeProfile`/`renderDiagnostics` from there. Both
 * directions are used only inside function bodies, never during module
 * evaluation, so the ESM cycle resolves safely through live bindings.
 */

import { join } from 'node:path'
import { fileExists } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import {
  isInstalled,
  readBundleNames,
  readInstalledVersion,
  readManifestDeps,
  resolveProfileDir,
} from '../core/profile.ts'
import type { DiagnosticReport, PeerMismatch } from '../core/types.ts'
// Call-time-only dependency on ./diagnostics.ts (see the import-cycle note).
import { analyzeProfile, renderDiagnostics } from './diagnostics.ts'

/* ------------------------------------------------------------------ *
 * Semver primitives
 * ------------------------------------------------------------------ */

/** A complete `x.y.z[-pre]` version. */
interface ParsedVersion {
  major: number
  minor: number
  patch: number
  pre: string[]
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION_RE.exec(text.trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function versionOf(major: number, minor: number, patch: number, pre: string[] = []): ParsedVersion {
  return { major, minor, patch, pre }
}

/** Semver prerelease ordering: identifiers compare numerically when both are. */
function comparePre(left: readonly string[], right: readonly string[]): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return b === undefined ? 0 : -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = /^\d+$/u.test(a)
    const bNumeric = /^\d+$/u.test(b)
    if (aNumeric && bNumeric) return Number(a) - Number(b)
    if (aNumeric) return -1
    if (bNumeric) return 1
    return a < b ? -1 : 1
  }
  return 0
}

function compareParsed(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  return comparePre(left.pre, right.pre)
}

/**
 * Compare two complete version strings: negative, zero or positive. A string
 * that is not a version falls back to a stable lexical comparison so callers
 * always receive a usable ordering.
 */
export function compareSemver(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return left < right ? -1 : left > right ? 1 : 0
  return compareParsed(a, b)
}

/** A range target: `x.y.z`/`1.2`/`1.x`/`*`, with the written levels tracked. */
interface ParsedPartial {
  /** Numeric levels actually written; 0 for a bare wildcard. */
  levels: number
  major: number
  minor: number
  patch: number
  pre: string[]
}

const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

function parsePartial(text: string): ParsedPartial | null {
  const match = PARTIAL_RE.exec(text.trim())
  if (match === null) return null
  const raw = [match[1], match[2], match[3]].filter((part): part is string => part !== undefined)
  let levels = 0
  for (const part of raw) {
    if (part === 'x' || part === 'X' || part === '*') break
    levels += 1
  }
  const at = (index: number): number => (index < levels ? Number(raw[index]) : 0)
  return {
    levels,
    major: at(0),
    minor: at(1),
    patch: at(2),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function partialOf(major: number, minor: number, patch: number): ParsedPartial {
  return { levels: 3, major, minor, patch, pre: [] }
}

/** One operator plus its target. */
interface Comparator {
  op: string
  target: ParsedPartial
}

/**
 * Evaluate one comparator against a version.
 *
 * Partial targets follow npm: `1.2` is the `>=1.2.0 <1.3.0` interval, `1` is
 * `>=1.0.0 <2.0.0`, `>1.2` starts at `1.3.0` and `<=1.2` ends before `1.3.0`.
 */
function matchesComparator(version: ParsedVersion, op: string, target: ParsedPartial): boolean {
  const lower = versionOf(target.major, target.minor, target.patch, target.pre)
  const at = (major: number, minor: number, patch: number): number =>
    compareParsed(version, versionOf(major, minor, patch))
  switch (op) {
    case '':
    case '=':
      if (target.levels === 0) return true
      if (target.levels === 1) return at(target.major, 0, 0) >= 0 && at(target.major + 1, 0, 0) < 0
      if (target.levels === 2) {
        return at(target.major, target.minor, 0) >= 0 && at(target.major, target.minor + 1, 0) < 0
      }
      return compareParsed(version, lower) === 0
    case '>':
      if (target.levels === 1) return at(target.major + 1, 0, 0) >= 0
      if (target.levels === 2) return at(target.major, target.minor + 1, 0) >= 0
      return compareParsed(version, lower) > 0
    case '>=':
      return target.levels === 0 ? true : compareParsed(version, lower) >= 0
    case '<':
      return target.levels === 0 ? false : compareParsed(version, lower) < 0
    case '<=':
      if (target.levels === 0) return true
      if (target.levels === 1) return at(target.major + 1, 0, 0) < 0
      if (target.levels === 2) return at(target.major, target.minor + 1, 0) < 0
      return compareParsed(version, lower) <= 0
    case '^': {
      if (target.levels === 0) return true
      if (compareParsed(version, lower) < 0) return false
      if (target.major > 0) return at(target.major + 1, 0, 0) < 0
      if (target.levels === 1) return at(1, 0, 0) < 0
      if (target.minor > 0) return at(0, target.minor + 1, 0) < 0
      if (target.levels === 2) return at(0, 1, 0) < 0
      return at(0, 0, target.patch + 1) < 0
    }
    case '~':
      if (target.levels === 0) return true
      if (compareParsed(version, lower) < 0) return false
      return target.levels === 1 ? at(target.major + 1, 0, 0) < 0 : at(target.major, target.minor + 1, 0) < 0
    default:
      return false
  }
}

const HYPHEN_RE = /^(\S+)\s+-\s+(\S+)$/u

/** Comparators of one `||` alternative, or null when the range is unknown. */
function parseComparatorSet(part: string): Comparator[] | null {
  const text = part.trim()
  if (text === '') return []

  const hyphen = HYPHEN_RE.exec(text)
  if (hyphen !== null) {
    const lower = parsePartial(hyphen[1] ?? '')
    const upper = parsePartial(hyphen[2] ?? '')
    if (lower === null || upper === null) return null
    const comparators: Comparator[] = [{ op: '>=', target: lower }]
    if (upper.levels === 0) return comparators
    if (upper.levels === 3) comparators.push({ op: '<=', target: upper })
    else if (upper.levels === 2) comparators.push({ op: '<', target: partialOf(upper.major, upper.minor + 1, 0) })
    else comparators.push({ op: '<', target: partialOf(upper.major + 1, 0, 0) })
    return comparators
  }

  // `>= 1.2.3` is the same comparator as `>=1.2.3` — join the pair first.
  const normalized = text.replace(/(>=|<=|>|<|\^|~|=)\s+(?=[\dvxX*])/gu, '$1')
  const comparatorTexts = normalized.split(/\s+/u).filter(piece => piece !== '')
  const comparators: Comparator[] = []
  for (const piece of comparatorTexts) {
    const match = /^(\^|~|>=|<=|>|<|=)?(.*)$/u.exec(piece)
    const op = match?.[1] ?? ''
    const targetText = (match?.[2] ?? '').trim()
    if (targetText === '') return null
    const target = parsePartial(targetText)
    if (target === null) return null
    // `<*` / `>*` have no meaning in any semver dialect: unknown, not false.
    if ((op === '<' || op === '>') && target.levels === 0) return null
    comparators.push({ op, target })
  }
  return comparators
}

/** Conjunction of one comparator set, with npm's prerelease admission gate. */
function evaluateSet(
  version: ParsedVersion,
  comparators: readonly Comparator[],
  includePrerelease: boolean,
): boolean | null {
  if (comparators.length === 0) return true
  if (version.pre.length > 0 && !includePrerelease) {
    // npm default: a prerelease version only matches a set when one comparator
    // pins the same [major, minor, patch] with a prerelease of its own.
    const admitted = comparators.some(comparator =>
      comparator.target.pre.length > 0
      && comparator.target.major === version.major
      && comparator.target.minor === version.minor
      && comparator.target.patch === version.patch)
    if (!admitted) return false
  }
  for (const comparator of comparators) {
    if (!matchesComparator(version, comparator.op, comparator.target)) return false
  }
  return true
}

/**
 * Does `version` satisfy `range`?
 *
 * @param version - a complete resolved version (`1.2.3`, `1.2.3-rc.1`).
 * @param range - npm range grammar subset described in the file header.
 * @param options.includePrerelease - admit prerelease versions without the
 *   same-tuple prerelease comparator that npm otherwise requires.
 * @returns true/false, or null when either side is not understood — the
 *   caller reports "unknown" instead of asserting a mismatch.
 */
export function satisfiesRange(
  version: string,
  range: string,
  options: { includePrerelease?: boolean } = {},
): boolean | null {
  const target = parseVersion(version)
  if (target === null) return null
  let sawUnknown = false
  for (const part of range.split('||')) {
    const comparators = parseComparatorSet(part)
    if (comparators === null) {
      sawUnknown = true
      continue
    }
    const result = evaluateSet(target, comparators, options.includePrerelease === true)
    if (result === null) {
      sawUnknown = true
      continue
    }
    if (result) return true
  }
  return sawUnknown ? null : false
}

/** A resolved version or spec, once blanks are discarded. */
function usableVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Classify one peer requirement against the version that answers it.
 *
 * @param requirement - the declared peer range (e.g. `^4.0.1`).
 * @param resolved - version installed for the peer, when one was found.
 * @param hostVersion - the running host's version, used when no local copy
 *   answers a peer that belongs to the host (`@deepseek-ai/dsh*`). The caller
 *   only passes it when that fallback is meaningful.
 * @returns `missing` when neither version is available, `unknown` when the
 *   range or the version cannot be evaluated, otherwise `satisfied`/`mismatch`.
 */
export function classifyPeer(
  requirement: string,
  resolved?: string,
  hostVersion?: string,
): PeerMismatch['verdict'] {
  const version = usableVersion(resolved) ?? usableVersion(hostVersion)
  if (version === undefined) return 'missing'

  const strict = satisfiesRange(version, requirement)
  if (strict === true) return 'satisfied'
  if (strict === null) return 'unknown'

  // Every DSH host line is published with a prerelease tag, so npm's strict
  // admission gate would report a healthy host peer as broken. Re-evaluate
  // without the gate: the ordering comparison still catches real drift, it just
  // stops treating `-rc.1` as disqualifying.
  const target = parseVersion(version)
  if (target !== null && target.pre.length > 0) {
    const lenient = satisfiesRange(version, requirement, { includePrerelease: true })
    if (lenient === true) return 'satisfied'
    if (lenient === null) return 'unknown'
  }
  return 'mismatch'
}

/* ------------------------------------------------------------------ *
 * Profile entry points
 * ------------------------------------------------------------------ */

/**
 * The same report as {@link analyzeProfile} (./diagnostics.ts); kept as a named
 * entry point for callers that think in terms of "checking a profile".
 */
export function checkProfile(profile: string, explicitDir?: string): DiagnosticReport {
  return analyzeProfile(profile, explicitDir)
}

/** The state lines, built so that one unreadable file cannot lose the rest. */
function snapshotLines(profile: string, explicitDir?: string): string[] {
  const lines: string[] = []
  const dir = resolveProfileDir(profile, explicitDir)
  const manifestWritten = fileExists(join(dir, 'package.json'))
  const dependencies = manifestWritten ? readManifestDeps(profile, dir) : {}
  const dependencyNames = Object.keys(dependencies).sort((left, right) => left.localeCompare(right))
  const bundles = manifestWritten ? readBundleNames(profile, dir) : []

  lines.push(`profile: ${profile}`)
  lines.push(
    `manifest: ${manifestWritten ? 'readable' : 'MISSING'} —`
    + ` ${String(dependencyNames.length)} dependency row(s), ${String(bundles.length)} bundle row(s)`,
  )

  if (dependencyNames.length > 0) {
    lines.push(`dependencies (${String(dependencyNames.length)}):`)
    for (const name of dependencyNames) {
      const version = readInstalledVersion(profile, name, dir)
      lines.push(`  ${name}: ${dependencies[name] ?? '?'}${version === undefined ? ' (not installed)' : ` (${version})`}`)
    }
  }
  if (bundles.length > 0) {
    lines.push(`bundles (${String(bundles.length)}):`)
    for (const name of bundles) {
      lines.push(`  ${name}: ${isInstalled(profile, name, dir) ? 'ok' : 'NOT RESOLVED'}`)
    }
  }

  const report = analyzeProfile(profile, explicitDir)
  lines.push(...renderDiagnostics(report).split('\n'))
  for (const finding of report.findings) {
    lines.push(`[${finding.level}] ${finding.code}: ${finding.message}`)
  }
  return lines
}

/**
 * The `## profile state` lines of the log export —.
 *
 * Carries the profile name, never a filesystem path (the exported file is
 * attached to a public issue), and never throws: an unreadable profile leaves
 * one explanatory line so the rest of the export is still produced.
 */
export function profileSnapshotLines(profile: string, explicitDir?: string): string[] {
  try {
    return snapshotLines(profile, explicitDir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logEvent('warn', 'log-export', `profile ${profile}: snapshot unavailable — ${message}`)
    return [`profile: ${profile}`, `profile state unavailable: ${message}`]
  }
}
