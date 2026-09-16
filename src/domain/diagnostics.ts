/**
 * Profile diagnostics — the read-only analysis behind `GET /dsh-galaxy/check`.
 *
 * It feeds the `diagnostics` field of the installed inventory and the compact
 * summary rendered into the exported log.
 *
 * Everything here is a pure function of the profile directory contents: no
 * process, no network, no writes. The analysis reports four kinds of trouble:
 *
 *   1. bundle resolution — a `dsh.profile.bundles` row whose package is not
 *      installed (the next host start dies on it),
 *   2. duplicate package names — one name resolved at several versions inside
 *      the installed tree, which is how a hoisted copy shadows the intended
 *      one,
 *   3. peer-dependency requirements a resolved version does not satisfy, with
 *      a verdict per requirement/resolution pair,
 *   4. everything else as a levelled finding, so one report shape covers the
 *      panel and the log export.
 *
 * Nothing in this module throws: an unreadable profile is a report carrying an
 * error finding, because the browser panel and the log export both run on
 * exactly the broken profiles where an exception would be least useful.
 *
 * Import-cycle note: `classifyPeer` (the single semver-range implementation of
 * this project) lives in ./check.ts, whose `checkProfile` delegates back here.
 * The two modules therefore import each other; every cross-call happens inside
 * a function body and never during module evaluation, which is what makes the
 * cycle safe under ESM live bindings.
 */

import type { Dirent } from 'node:fs'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileExists, readJsonFile } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import {
  INBOX_BUNDLES,
  isInstalled,
  readBundleNames,
  readInstalled,
  readInstalledVersion,
  resolveProfileDir,
} from '../core/profile.ts'
import { profileDir } from '../core/paths.ts'
import type { DiagnosticFinding, DiagnosticReport, PeerMismatch } from '../core/types.ts'
// Call-time-only dependency on ./check.ts (see the import-cycle note above).
import { classifyPeer } from './check.ts'
import { detectHostVersion } from './compatibility.ts'

/** A plain `x.y.z` version, optionally prerelease/build tagged. */
const SEMVER_TEXT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u

/** Structural subset of an installed package manifest this module reads. */
interface PackageManifestShape {
  name?: unknown
  version?: unknown
  peerDependencies?: unknown
  peerDependenciesMeta?: unknown
}

/** One peer requirement together with the plugin that declares it. */
export interface PeerFinding extends PeerMismatch {
  /** Declaring plugin package name. */
  plugin: string
  /** The declaring plugin marked this peer optional. */
  optional?: boolean
}

/** One location where a package name was found. */
export interface VersionCopy {
  version: string
  /** Human-readable origin: `profile`, `nested under <pkg>`, `workspace root`. */
  location: string
}

/** A package name installed at more than one version. */
export interface DuplicatePackage {
  name: string
  /** Distinct resolved versions, ascending. */
  versions: string[]
  /** Every copy found, for the finding message. */
  copies: VersionCopy[]
}

/** True when the string looks like a resolved version rather than a spec. */
function isVersionText(value: string | undefined): value is string {
  return value !== undefined && SEMVER_TEXT.test(value.trim())
}

/**
 * Whether a name belongs to the DSH host itself. A second copy of a host
 * package does not merely shadow a library — it splits the host's identity and
 * breaks service registration, so it is escalated past a warning.
 */
function isHostPackage(name: string): boolean {
  return INBOX_BUNDLES.has(name) || /^@deepseek-ai\/(?:dsh|cordis)(?:$|-)/u.test(name)
}

/** Version of the installed package whose manifest lives at `file`. */
function versionAt(file: string): string | undefined {
  const manifest = readJsonFile<PackageManifestShape>(file)
  const version = manifest?.version
  return typeof version === 'string' ? version : undefined
}

/**
 * Names of the packages directly inside one `node_modules` directory, with one
 * level of scope expanded. `link:` installs are junctions/symlinks, so
 * symbolic links count as packages.
 */
function packageNamesIn(nodeModules: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(nodeModules, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (!entry.name.startsWith('@')) {
      names.push(entry.name)
      continue
    }
    let scoped: Dirent[]
    try {
      scoped = readdirSync(join(nodeModules, entry.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of scoped) {
      if (child.isDirectory() || child.isSymbolicLink()) names.push(`${entry.name}/${child.name}`)
    }
  }
  return names
}

/**
 * Every copy of the requested names visible to the profile's dependency tree:
 *
 *   - the profile's own `node_modules` (what the loader resolves first),
 *   - a nested copy inside any installed package's own `node_modules` — how
 *     pnpm parks a conflicting version where only that package can see it,
 *   - the pnpm workspace root beside the profile, where shared dependencies
 *     are hoisted when the profile is a workspace member.
 */
function versionCopies(dir: string, names: readonly string[]): Map<string, VersionCopy[]> {
  const wanted = new Set(names)
  const found = new Map<string, VersionCopy[]>()
  const add = (name: string, version: string | undefined, location: string): void => {
    if (version === undefined) return
    const copies = found.get(name) ?? []
    if (!copies.some(copy => copy.version === version && copy.location === location)) {
      copies.push({ version, location })
    }
    found.set(name, copies)
  }

  const root = join(dir, 'node_modules')
  for (const name of names) add(name, versionAt(join(root, name, 'package.json')), 'profile')

  for (const owner of packageNamesIn(root)) {
    const nested = join(root, owner, 'node_modules')
    for (const nestedName of packageNamesIn(nested)) {
      if (!wanted.has(nestedName)) continue
      add(nestedName, versionAt(join(nested, nestedName, 'package.json')), `nested under ${owner}`)
    }
  }

  const parent = dirname(dir)
  if (parent !== dir) {
    const hoisted = join(parent, 'node_modules')
    for (const name of names) add(name, versionAt(join(hoisted, name, 'package.json')), 'workspace root')
  }
  return found
}

/**
 * Package names installed at more than one version in the tree around `dir`.
 * Exported so the post-install verification (./verify.ts) answers the
 * duplicate-name question with exactly the same scan.
 */
export function findDuplicatePackages(dir: string): DuplicatePackage[] {
  const names = packageNamesIn(join(dir, 'node_modules'))
  if (names.length === 0) return []
  const duplicates: DuplicatePackage[] = []
  for (const [name, copies] of versionCopies(dir, names)) {
    const versions = [...new Set(copies.map(copy => copy.version))]
    if (versions.length < 2) continue
    versions.sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
    duplicates.push({ name, versions, copies })
  }
  return duplicates.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * The version of the running host.
 *
 * Delegates to {@link detectHostVersion}, which knows where a DSH profile keeps
 * its host packages: the profile's OWN `node_modules` usually has the plugins
 * and nothing else, while the host lives one level up in the shared dependency
 * anchor (`<dsh home>/profiles/node_modules`). Probing only the profile-local
 * directory — which is what this did — is why the diagnostics page reported
 * `宿主版本: unknown` on a perfectly healthy profile, while its own bundle
 * section said the same packages were "not locatable from this profile".
 *
 * `'unknown'` is still the answer when nothing readable exists: an invented
 * version would poison the peer analysis that consumes this value.
 */
export function readHostVersion(profile: string, explicitDir?: string): string {
  return detectHostVersion(profileDir(profile, explicitDir))?.version ?? 'unknown'
}

/** Bundle resolution rows plus the findings that go with them. */
function analyzeBundles(
  profile: string,
  dir: string,
  findings: DiagnosticFinding[],
): DiagnosticReport['bundles'] {
  const names = readBundleNames(profile, dir)
  const bundles = names.map((name): DiagnosticReport['bundles'][number] => {
    if (isInstalled(profile, name, dir)) return { name, resolved: true }
    if (isHostPackage(name)) {
      // An in-box bundle belongs to the dsh INSTALLATION, not to the profile.
      // Not finding it here says this process cannot see the installation, not
      // that the profile is broken — so it is reported, never escalated.
      return {
        name,
        resolved: false,
        reason: 'supplied by the dsh installation (not locatable from this profile)',
      }
    }
    return {
      name,
      resolved: false,
      reason: 'bundle package is not installed — the next host start fails here',
    }
  })

  for (const bundle of bundles) {
    if (bundle.resolved) continue
    if (isHostPackage(bundle.name)) {
      findings.push({
        level: 'info',
        code: 'bundle-host-supplied',
        message: `bundle ${bundle.name}: ${String(bundle.reason)}`,
        names: [bundle.name],
      })
    } else {
      findings.push({
        level: 'error',
        code: 'bundle-unresolved',
        message: `bundle ${bundle.name}: ${String(bundle.reason)}`,
        names: [bundle.name],
      })
    }
  }
  return bundles
}

/** Duplicate-name findings, one per affected package. */
function analyzeDuplicates(duplicates: readonly DuplicatePackage[], findings: DiagnosticFinding[]): string[] {
  for (const duplicate of duplicates) {
    const where = duplicate.copies
      .map(copy => `${copy.version} (${copy.location})`)
      .join(', ')
    findings.push({
      level: isHostPackage(duplicate.name) ? 'error' : 'warn',
      code: 'duplicate-package',
      message: `${duplicate.name} is installed at several versions: ${where}`,
      names: [duplicate.name],
    })
  }
  return duplicates.map(duplicate => duplicate.name)
}

/**
 * Peer-dependency rows for every installed package, with the declaring plugin
 * attached.
 *
 * Node resolves a plugin's peer from the plugin's own `node_modules` first,
 * then the profile tree, then the workspace root. A peer that no local copy
 * answers but that is a host package falls back to the host version, because
 * the running host supplies its own packages at mount time.
 */
function analyzePeers(
  dir: string,
  hostVersion: string,
  findings: DiagnosticFinding[],
): PeerFinding[] {
  const root = join(dir, 'node_modules')
  const parent = dirname(dir)
  const rows: PeerFinding[] = []

  for (const plugin of packageNamesIn(root)) {
    const manifest = readJsonFile<PackageManifestShape>(join(root, plugin, 'package.json'))
    const peers = manifest?.peerDependencies
    if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) continue
    const meta = manifest?.peerDependenciesMeta
    const optionalPeers = meta !== null && typeof meta === 'object' && !Array.isArray(meta)
      ? meta as Record<string, unknown>
      : undefined

    for (const [peer, requirement] of Object.entries(peers as Record<string, unknown>)) {
      if (typeof requirement !== 'string' || requirement.trim() === '') continue
      const local = versionAt(join(root, plugin, 'node_modules', peer, 'package.json'))
        ?? versionAt(join(root, peer, 'package.json'))
        ?? (parent === dir ? undefined : versionAt(join(parent, 'node_modules', peer, 'package.json')))
      const hostFallback = local === undefined && isHostPackage(peer) && isVersionText(hostVersion)
        ? hostVersion
        : undefined
      const resolved = local ?? hostFallback
      const verdict = classifyPeer(requirement, local, hostFallback)
      const optionalMeta = optionalPeers?.[peer]
      const optional = optionalMeta !== null && typeof optionalMeta === 'object'
        && (optionalMeta as { optional?: unknown }).optional === true

      rows.push({
        name: peer,
        requirement,
        ...(resolved === undefined ? {} : { resolved }),
        verdict,
        plugin,
        ...(optional ? { optional: true } : {}),
      })

      if (optional) continue
      if (verdict === 'mismatch') {
        findings.push({
          level: 'warn',
          code: 'peer-mismatch',
          message: `${plugin} requires peer ${peer}@${requirement} but ${String(resolved)} is resolved`,
          names: [plugin, peer],
        })
      } else if (verdict === 'missing') {
        findings.push({
          level: 'info',
          code: 'peer-missing',
          message: `${plugin} declares peer ${peer}@${requirement}, which is not installed`,
          names: [plugin, peer],
        })
      } else if (verdict === 'unknown') {
        findings.push({
          level: 'info',
          code: 'peer-verdict-unknown',
          message: `${plugin} peer ${peer}@${requirement} could not be evaluated`
            + (resolved === undefined ? ' (not installed)' : ` against ${resolved}`),
          names: [plugin, peer],
        })
      }
    }
  }

  return rows.sort((left, right) =>
    left.plugin.localeCompare(right.plugin) || left.name.localeCompare(right.name))
}

/** Deterministic finding order: severity first, then code and message. */
function sortFindings(findings: readonly DiagnosticFinding[]): DiagnosticFinding[] {
  const rank = { error: 0, warn: 1, info: 2 } as const
  return [...findings].sort((left, right) =>
    rank[left.level] - rank[right.level]
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message))
}

/** The report shape returned when the analysis itself could not run. */
function failedReport(profile: string, message: string): DiagnosticReport {
  return {
    profile,
    hostVersion: 'unknown',
    generatedAt: new Date().toISOString(),
    summary: { errors: 1, warnings: 0, packages: 0, bundles: 0 },
    bundles: [],
    peerMismatches: [],
    duplicateNames: [],
    findings: [{ level: 'error', code: 'diagnostics-failed', message }],
  }
}

/** The actual analysis; the public entry point guards it. */
function buildReport(profile: string, explicitDir?: string): DiagnosticReport {
  const dir = resolveProfileDir(profile, explicitDir)
  const findings: DiagnosticFinding[] = []

  // A missing manifest is the one condition that invalidates every other
  // answer, so it is stated first and the analysis continues best-effort.
  const manifestWritten = fileExists(join(dir, 'package.json'))
  if (!manifestWritten) {
    findings.push({
      level: 'error',
      code: 'profile-manifest-missing',
      message: `profile ${profile}: package.json is missing or unreadable — nothing can be verified`,
    })
  }

  // Independent of `manifestWritten`: the HOST's release is knowable even when
  // the profile's own manifest is missing, and calling it `unknown` there hid a
  // real value behind an unrelated problem.
  const hostVersion = readHostVersion(profile, dir)
  const bundles = analyzeBundles(profile, dir, findings)
  const duplicateNames = analyzeDuplicates(findDuplicatePackages(dir), findings)
  const peerMismatches = analyzePeers(dir, hostVersion, findings)
  if (bundles.length === 0 && manifestWritten) {
    findings.push({
      level: 'info',
      code: 'bundle-stack-empty',
      message: `profile ${profile}: no bundle is listed in dsh.profile.bundles`,
    })
  }

  const sorted = sortFindings(findings)
  return {
    profile,
    hostVersion,
    generatedAt: new Date().toISOString(),
    summary: {
      errors: sorted.filter(finding => finding.level === 'error').length,
      warnings: sorted.filter(finding => finding.level === 'warn').length,
      packages: Object.keys(readInstalled(profile, dir)).length,
      bundles: bundles.length,
    },
    bundles,
    peerMismatches,
    duplicateNames,
    findings: sorted,
  }
}

/**
 * Analyze one profile —.
 *
 * Never throws: an unreadable profile (or an unreadable tree underneath it)
 * produces a report whose `findings` carry the reason.
 * @param profile - DSH profile name; the report echoes the name, never the path.
 * @param explicitDir - directory the Desktop host owns, when it differs.
 */
export function analyzeProfile(profile: string, explicitDir?: string): DiagnosticReport {
  try {
    return buildReport(profile, explicitDir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logEvent('error', 'diagnostics', `profile ${profile}: analysis failed — ${message}`)
    return failedReport(profile, `diagnostics failed: ${message}`)
  }
}

/** The declaring plugin of a peer row, when the row predates {@link PeerFinding}. */
function peerOwner(row: PeerMismatch): string | undefined {
  const owner = (row as { plugin?: unknown }).plugin
  return typeof owner === 'string' ? owner : undefined
}

/**
 * Compact human-readable summary of a report, folded into the log export by
 * `profileSnapshotLines` (./check.ts). One line per concern so the exported
 * file stays readable when it is attached to an issue.
 */
export function renderDiagnostics(report: DiagnosticReport): string {
  const lines = [
    `diagnostics: ${String(report.summary.errors)} error(s),`
    + ` ${String(report.summary.warnings)} warning(s),`
    + ` ${String(report.summary.packages)} package(s),`
    + ` ${String(report.summary.bundles)} bundle(s) — host ${report.hostVersion}`,
  ]
  if (report.bundles.length > 0) {
    const rendered = report.bundles.map(bundle => bundle.resolved
      ? `${bundle.name}=ok`
      : `${bundle.name}=NOT RESOLVED (${bundle.reason ?? 'unknown'})`)
    lines.push(`bundles: ${rendered.join(', ')}`)
  }
  const peers = report.peerMismatches.filter(row => row.verdict !== 'satisfied')
  if (peers.length > 0) {
    const rendered = peers.map((row) => {
      const owner = peerOwner(row)
      const prefix = owner === undefined ? '' : `${owner} -> `
      return `${prefix}${row.name}@${row.requirement} resolved=${row.resolved ?? 'not installed'} [${row.verdict}]`
    })
    lines.push(`peers: ${rendered.join('; ')}`)
  }
  if (report.duplicateNames.length > 0) {
    lines.push(`duplicate package names: ${report.duplicateNames.join(', ')}`)
  }
  return lines.join('\n')
}
