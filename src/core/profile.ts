/**
 * Profile filesystem reads and manifest writes.
 *
 * Everything the galaxy learns from a dsh profile directory (manifest,
 * lockfile, installed package trees) is a pure function of the directory
 * contents — no processes, no network. This is the "DAO" layer of the
 * written here and nowhere else.
 */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logEvent } from './log.ts'
import { jsonEqual, readJsonFile, readTextFile, writeJsonAtomic } from './json.ts'
import { profileDir } from './paths.ts'
import type { InstallKind, InstalledPlugin } from './types.ts'

/**
 * The in-box bundles a dsh profile template installs itself — the only names
 * the galaxy hides from the installed list. Community plugins may legitimately
 * publish under the official scope, so a whole-scope filter would make them
 * invisible and break install validation.
 */
export const INBOX_BUNDLES: Set<string> = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

/** Structural view of the fields the galaxy touches in a profile manifest. */
export interface ProfileManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  pnpm?: { allowBuilds?: unknown; onlyBuiltDependencies?: unknown; [key: string]: unknown }
  dsh?: {
    profile?: { bundles?: unknown; [key: string]: unknown }
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** Resolved directory of a profile (honours an explicit Desktop-owned path). */
export function resolveProfileDir(profile: string, explicitDir?: string): string {
  return profileDir(profile, explicitDir)
}

/** Read the profile manifest, or an empty object when it is missing/invalid. */
export function readProfileManifest(profile: string, explicitDir?: string): ProfileManifest {
  return readJsonFile<ProfileManifest>(join(profileDir(profile, explicitDir), 'package.json')) ?? {}
}

/** Absolute path of the profile manifest. */
export function manifestPath(profile: string, explicitDir?: string): string {
  return join(profileDir(profile, explicitDir), 'package.json')
}

/** Absolute path of the profile lockfile. */
export function lockfilePath(profile: string, explicitDir?: string): string {
  return join(profileDir(profile, explicitDir), 'pnpm-lock.yaml')
}

/**
 * Community dependencies of the profile (in-box bundles filtered out), as
 * recorded in `package.json`. This is the *declared* view; resolved versions
 * come from the installed trees.
 */
export function readInstalled(profile: string, explicitDir?: string): Record<string, string> {
  const manifest = readProfileManifest(profile, explicitDir)
  const installed: Record<string, string> = {}
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (!INBOX_BUNDLES.has(name)) installed[name] = spec
  }
  return installed
}

/**
 * RAW dependency map including the in-box bundles. This is the rollback
 * snapshot: restoring the filtered view would delete `@deepseek-ai/dsh-base`
 * and friends.
 */
export function readManifestDeps(profile: string, explicitDir?: string): Record<string, string> {
  return { ...(readProfileManifest(profile, explicitDir).dependencies ?? {}) }
}

/**
 * Exact rollback state owned by one profile package operation: the raw
 * dependency map plus the presence/value of `dsh.profile.bundles`.
 */
export interface ProfileManifestSnapshot {
  dependencies: Record<string, string>
  profileBundles: { present: false } | { present: true; value: unknown }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Capture dependencies and the exact `dsh.profile.bundles` field. */
export function readProfileManifestSnapshot(profile: string, explicitDir?: string): ProfileManifestSnapshot {
  const manifest = readProfileManifest(profile, explicitDir)
  const profileManifest = objectRecord(manifest.dsh?.profile)
  const present = profileManifest !== undefined && Object.hasOwn(profileManifest, 'bundles')
  return {
    dependencies: { ...(manifest.dependencies ?? {}) },
    profileBundles: present
      ? { present: true, value: structuredClone(profileManifest!.bundles) }
      : { present: false },
  }
}

/**
 * Write the dependency map and (optionally) the bundle list back to the
 * profile manifest, preserving every unrelated field.
 */
export function writeProfileManifest(
  profile: string,
  mutate: (manifest: ProfileManifest) => void,
  explicitDir?: string,
): void {
  const file = manifestPath(profile, explicitDir)
  const manifest = readProfileManifest(profile, explicitDir)
  mutate(manifest)
  writeJsonAtomic(file, manifest, 0o644)
}

/**
 * Restore a previously captured manifest state. A missing bundle field is
 * deleted rather than set to `undefined`, so the file round-trips exactly.
 */
export function restoreProfileManifest(
  profile: string,
  snapshot: ProfileManifestSnapshot,
  explicitDir?: string,
): void {
  writeProfileManifest(profile, (manifest) => {
    manifest.dependencies = { ...snapshot.dependencies }
    const profileManifest = objectRecord(manifest.dsh?.profile) ?? {}
    if (snapshot.profileBundles.present) {
      profileManifest.bundles = structuredClone(snapshot.profileBundles.value)
    } else {
      delete profileManifest.bundles
    }
    manifest.dsh = { ...(manifest.dsh ?? {}), profile: profileManifest }
    if (Object.keys(manifest.dsh).length === 0) delete manifest.dsh
  }, explicitDir)
}

/** True when the profile manifest still matches a captured snapshot. */
export function profileStateMatches(
  profile: string,
  expected: ProfileManifestSnapshot,
  explicitDir?: string,
): boolean {
  return jsonEqual(readProfileManifestSnapshot(profile, explicitDir), expected)
}

/** Read the profile lockfile, or null when it does not exist. */
export function readLockfile(profile: string, explicitDir?: string): string | null {
  return readTextFile(lockfilePath(profile, explicitDir))
}

/** Restore the profile lockfile (null deletes it). */
export function restoreLockfile(profile: string, contents: string | null, explicitDir?: string): void {
  const file = lockfilePath(profile, explicitDir)
  if (contents === null) {
    try {
      if (existsSync(file)) writeFileSync(file, '', { mode: 0o644 })
    } catch (error) {
      logEvent('warn', 'lockfile', `could not clear lockfile: ${(error as Error).message}`)
    }
    return
  }
  try {
    writeFileSync(file, contents, { mode: 0o644 })
  } catch (error) {
    logEvent('warn', 'lockfile', `could not restore lockfile: ${(error as Error).message}`)
  }
}

/** Remote-repository identity parsed from a dependency spec, if any. */
export function specRepo(spec: string): string | undefined {
  const shorthand = /^github:([^#]+)/u.exec(spec)
  if (shorthand !== null) return shorthand[1]
  const url = /github\.com[/:]([^/#]+)\/([^/#.]+)/u.exec(spec)
  if (url !== null) return `${url[1]}/${url[2]}`
  return undefined
}

/** Classify a dependency spec into an {@link InstallKind}. */
export function specKind(spec: string): InstallKind {
  if (spec.startsWith('github:') || spec.includes('github.com')) return 'git'
  if (spec.startsWith('file:') || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) return 'local'
  // Windows absolute paths: a drive letter (`C:\\dir\\pkg.tgz`) or a UNC share
  // (`\\\\server\\share`). Without this they fall through to `unknown`, and a
  // locally installed tarball would be offered an npm update it can never get.
  if (/^[A-Za-z]:[\\/]/u.test(spec) || spec.startsWith('\\\\')) return 'local'
  if (spec.endsWith('.tgz') || spec.endsWith('.tar.gz')) return 'tarball'
  if (spec.startsWith('npm:')) return 'alias'
  if (spec.startsWith('workspace:')) return 'local'
  if (/^[~^]?\d/u.test(spec) || spec === 'latest' || spec === '*') return 'npm'
  return 'unknown'
}

/** Absolute path of one installed package inside the profile. */
export function installedPackageDir(profile: string, name: string, explicitDir?: string): string {
  return join(profileDir(profile, explicitDir), 'node_modules', name)
}

/** Resolve the version of an installed package from its own manifest. */
export function readInstalledVersion(profile: string, name: string, explicitDir?: string): string | undefined {
  const manifest = readJsonFile<{ version?: string }>(join(installedPackageDir(profile, name, explicitDir), 'package.json'))
  return typeof manifest?.version === 'string' ? manifest.version : undefined
}

/** True when the installed package ships a DSH client bundle. */
export function hasClientBundle(profile: string, name: string, explicitDir?: string): boolean {
  const dir = installedPackageDir(profile, name, explicitDir)
  if (existsSync(join(dir, 'client', 'client.js'))) return true
  const manifest = readJsonFile<{ dsh?: { client?: unknown } }>(join(dir, 'package.json'))
  return manifest?.dsh?.client !== undefined
}

/** True when the package directory exists and contains a manifest. */
export function isInstalled(profile: string, name: string, explicitDir?: string): boolean {
  try {
    return statSync(join(installedPackageDir(profile, name, explicitDir), 'package.json')).isFile()
  } catch {
    return false
  }
}

/** Bundle names recorded in `dsh.profile.bundles` (string entries only). */
export function readBundleNames(profile: string, explicitDir?: string): string[] {
  const manifest = readProfileManifest(profile, explicitDir)
  const bundles = objectRecord(manifest.dsh?.profile)?.bundles
  if (!Array.isArray(bundles)) return []
  return bundles.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * The full installed inventory: declared dependencies enriched with resolved
 * versions, source classification, bundle membership, disabled state and
 * client-bundle presence.
 */
export function readInstalledPlugins(
  profile: string,
  disabled: readonly string[],
  bundles: readonly string[],
  explicitDir?: string,
): InstalledPlugin[] {
  const declared = readInstalled(profile, explicitDir)
  const disabledSet = new Set(disabled)
  const bundleSet = new Set(bundles)
  return Object.entries(declared)
    .map(([name, spec]): InstalledPlugin => {
      const repo = specRepo(spec)
      return {
        name,
        spec,
        kind: specKind(spec),
        version: readInstalledVersion(profile, name, explicitDir),
        bundle: bundleSet.has(name),
        disabled: disabledSet.has(name),
        client: hasClientBundle(profile, name, explicitDir),
        ...(repo === undefined ? {} : { repo }),
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Rename a manifest file to its backup variant, best effort. */
export function backupManifestFile(profile: string, explicitDir?: string): string | undefined {
  const file = manifestPath(profile, explicitDir)
  const target = `${file}.bak`
  try {
    renameSync(file, target)
    return target
  } catch {
    return undefined
  }
}
