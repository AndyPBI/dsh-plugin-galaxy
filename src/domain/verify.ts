/**
 * Post-operation verification — did an install or update actually land a
 * plugin the host can load, and what is each plugin's activation state?
 *
 * Two questions, two entry points:
 *
 *   - {@link validateAddedPlugins} answers "the package manager exited 0 — but
 *     is the thing that landed actually loadable?". A source-only checkout, a
 *     build pnpm refused to run, or a package whose name shadows one the
 *     profile already loads would brick the NEXT boot, and an install that
 *     claims success while leaving the profile unable to start is the one
 *     failure the operator cannot diagnose from the UI (it takes the UI down).
 *   - {@link verifyActivation} answers "is this plugin live now, or does it
 *     need a restart?" from evidence on disk: the hot-mount layer the galaxy
 *     itself writes, and the profile's bundle list.
 *
 * Reads only; never throws, because both callers run inside a route that has
 * already completed the real work and must still answer the browser.
 */

import type { Dirent } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { readJsonFile, readTextFile } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import { HOT_FILE_PREFIX, galaxyDir } from '../core/paths.ts'
import {
  installedPackageDir,
  isInstalled,
  readInstalled,
  resolveProfileDir,
} from '../core/profile.ts'
import { disabledList, readGalaxyState } from '../core/state.ts'
import type { ActivationState, DiagnosticFinding, InstallResult } from '../core/types.ts'
// The duplicate-name scan is shared with the diagnostics report on purpose:
// two scanners would eventually disagree about the same tree.
import { findDuplicatePackages } from './diagnostics.ts'

/** Structural subset of an installed package manifest this module reads. */
interface PackageManifestShape {
  name?: unknown
  version?: unknown
  dsh?: unknown
}

/** Outcome of the post-install validation. */
export interface ValidateAddedResult {
  /** False when any problem is severe enough to make the plugin unloadable. */
  ok: boolean
  problems: DiagnosticFinding[]
  /** Names this call examined (trimmed and de-duplicated). */
  added: string[]
  /** Names that passed every check. */
  keep: string[]
  /**
   * Names that FAILED verification. Verification is read-only, so nothing has
   * actually been uninstalled: the caller owns that decision.
   */
  removedBroken: string[]
  /** Loader entry-id conflicts; not computed here, always empty. */
  conflicts: { name: string; id: string; owner: string }[]
}

/** Runner signature the lifecycle layer injects (structural subset). */
export type AddedPluginRunner = (profile: string, args: string[]) => Promise<InstallResult>

/** A `ReadonlySet<string>`-shaped value, accepted structurally. */
function asStringSet(value: unknown): ReadonlySet<string> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  return typeof (value as { has?: unknown }).has === 'function'
    ? value as ReadonlySet<string>
    : undefined
}

/** Surfaces a `dsh` field may use to declare itself a host-extensible package. */
const DSH_SURFACES = ['plugin', 'bundle', 'client', 'entry'] as const

/**
 * Does this manifest declare a DSH plugin entry?
 *
 * Any non-null `dsh` field counts: a carrier bundle declares `dsh.bundle`
 * while shipping no plugin of its own, a library may be loaded by name from
 * someone else's patch, and a client-only plugin declares `dsh.client`. Only a
 * manifest with no `dsh` surface at all is a failure — that is the shape that
 * silently does nothing after a successful install.
 */
function dshEntry(manifest: PackageManifestShape | undefined): { ok: boolean; detail: string } {
  if (manifest === undefined || manifest === null || typeof manifest !== 'object') {
    return { ok: false, detail: 'package.json is missing or unreadable' }
  }
  const dsh = manifest.dsh
  if (dsh === undefined || dsh === null || dsh === false) {
    return { ok: false, detail: 'declares no dsh plugin entry' }
  }
  if (typeof dsh !== 'object' || Array.isArray(dsh)) {
    return { ok: true, detail: `declares dsh=${JSON.stringify(dsh)}` }
  }
  const surfaces = DSH_SURFACES.filter(
    surface => (dsh as Record<string, unknown>)[surface] !== undefined,
  )
  return {
    ok: true,
    detail: surfaces.length === 0
      ? 'declares an empty dsh field'
      : `declares dsh.${surfaces.join(' / dsh.')}`,
  }
}

/** Collect every `name:` scalar of a parsed hot-mount document. */
function collectNames(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNames(item, into)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'name' && typeof child === 'string' && child !== '') into.add(child)
    else collectNames(child, into)
  }
}

/**
 * Package names the hot-mount layer mounts into the running host.
 *
 * The hot files are `<profile>/.dsh-galaxy/hot-<n>.yml`; a file
 * the parser cannot read is skipped with a log line, because a broken hot row
 * must not turn the whole activation answer into a failure.
 */
function hotMountedNames(profileDir: string): Set<string> {
  const names = new Set<string>()
  const galaxy = galaxyDir(profileDir)
  let entries: Dirent[]
  try {
    entries = readdirSync(galaxy, { withFileTypes: true })
  } catch {
    return names
  }
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (!entry.name.startsWith(HOT_FILE_PREFIX) || !entry.name.endsWith('.yml')) continue
    const text = readTextFile(join(galaxy, entry.name))
    if (text === null) continue
    try {
      collectNames(load(text), names)
    } catch (error) {
      logEvent('warn', 'hot-mount', `could not read ${entry.name}: ${(error as Error).message}`)
    }
  }
  return names
}

/**
 * Whether the live set covers a package, allowing for a loader row that names
 * a subpath entry of it (`@scope/pkg/dsh`).
 */
function hotIncludes(live: ReadonlySet<string>, name: string): boolean {
  if (live.has(name)) return true
  const prefix = `${name}/`
  for (const entry of live) if (entry.startsWith(prefix)) return true
  return false
}

/** The verification loop shared by both call shapes of the guard. */
function inspectAddedPlugins(
  profile: string,
  dir: string,
  names: readonly string[],
): ValidateAddedResult {
  const problems: DiagnosticFinding[] = []
  const added: string[] = []
  const keep: string[] = []
  const removedBroken: string[] = []
  const duplicates = new Map(
    findDuplicatePackages(dir).map(entry => [entry.name, entry.versions] as const),
  )
  const seen = new Set<string>()

  for (const rawName of names) {
    const name = rawName.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    added.push(name)
    const before = problems.length

    // (a) the package must actually be on disk.
    if (!isInstalled(profile, name, dir)) {
      problems.push({
        level: 'error',
        code: 'package-missing',
        message: `${name} was added but is not present under node_modules — the installation did not land`,
        names: [name],
      })
      removedBroken.push(name)
      continue
    }

    const manifest = readJsonFile<PackageManifestShape>(
      join(installedPackageDir(profile, name, dir), 'package.json'),
    )

    // (b) it must declare something the host can load.
    const entry = dshEntry(manifest)
    if (!entry.ok) {
      problems.push({
        level: 'error',
        code: 'plugin-entry-missing',
        message: `${name}: ${entry.detail} — the host would not load it`,
        names: [name],
      })
    }

    // (c) its name must not collide with a copy the profile already resolves.
    // A second version of the same name is how a stale hoisted copy shadows
    // the freshly installed one, so it is reported even though it is not
    // necessarily fatal.
    const versions = duplicates.get(name)
    if (versions !== undefined) {
      problems.push({
        level: 'warn',
        code: 'duplicate-name',
        message: `${name} is also present at another version in the profile tree`
          + ` (${versions.join(' / ')}) — the loader may resolve the wrong copy`,
        names: [name],
      })
    }
    const declaredName = manifest?.name
    if (typeof declaredName === 'string' && declaredName !== name && isInstalled(profile, declaredName, dir)) {
      problems.push({
        level: 'warn',
        code: 'name-collision',
        message: `${name} installs the package ${declaredName},`
          + ' which the profile already installs under its own name',
        names: [name, declaredName],
      })
    }

    const severe = problems.slice(before).some(problem => problem.level === 'error')
    if (severe) removedBroken.push(name)
    else keep.push(name)
  }

  return {
    ok: !problems.some(problem => problem.level === 'error'),
    problems,
    added,
    keep,
    removedBroken,
    conflicts: [],
  }
}

/** Result for a profile directory that cannot even be resolved. */
function unverified(profile: string, message: string): ValidateAddedResult {
  return {
    ok: false,
    problems: [{
      level: 'error',
      code: 'profile-unresolved',
      message: `profile ${profile} could not be resolved: ${message}`,
    }],
    added: [],
    keep: [],
    removedBroken: [],
    conflicts: [],
  }
}

/**
 * Validate the packages one install or update just added.
 *
 * Every problem is a finding, so the caller can surface it verbatim and the
 * operator can see WHY a "successful" install did not produce a plugin.
 *
 * Two call shapes reach this guard, and both are supported deliberately:
 *
 *   1. `(profile, names, explicitDir?)` — the direct form: the caller already
 *      knows which packages the operation added.
 *   2. `(runner, profile, before, dir)` — the form the lifecycle route injects
 *      into the install pipeline, where "added" means the community
 *      dependencies the profile declares now that it did not declare before.
 *      The runner is accepted for signature compatibility only: verification
 *      is read-only and never runs a child process.
 *
 * @param profile - DSH profile name (first form) or the injected runner.
 * @param names - package names the operation added, or the profile name.
 * @param explicitDir - directory the Desktop host owns / the pre-run name set.
 * @returns `ok` false when at least one problem is error-level; warnings alone
 *   (a second copy of the same name in the tree) leave the install usable.
 */
export function validateAddedPlugins(
  profile: string,
  names: readonly string[],
  explicitDir?: string,
): ValidateAddedResult
export function validateAddedPlugins(
  runner: AddedPluginRunner,
  profile: string,
  before: ReadonlySet<string>,
  dir: string,
): ValidateAddedResult
export function validateAddedPlugins(
  profileOrRunner: string | AddedPluginRunner,
  namesOrProfile: readonly string[] | string,
  explicitDirOrBefore?: string | ReadonlySet<string>,
  directory?: string,
): ValidateAddedResult {
  const injected = typeof profileOrRunner === 'function'
  const profile = injected ? String(namesOrProfile) : profileOrRunner
  const explicitDir = injected
    ? directory
    : (typeof explicitDirOrBefore === 'string' ? explicitDirOrBefore : undefined)

  let dir: string
  try {
    dir = resolveProfileDir(profile, explicitDir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logEvent('error', 'install', `cannot verify added plugins: ${message}`)
    return unverified(profile, message)
  }

  let names: readonly string[]
  if (injected) {
    const before = asStringSet(explicitDirOrBefore) ?? new Set<string>()
    names = Object.keys(readInstalled(profile, dir)).filter(name => !before.has(name))
  } else {
    names = namesOrProfile as readonly string[]
  }
  return inspectAddedPlugins(profile, dir, names)
}

/**
 * Activation state of the given plugins — 's `activation` field.
 *
 * The taxonomy is the shared VO's: `disabled` dominates (the user switched the
 * plugin off, and the boot keeps it off), `live` means a hot-mount row in the
 * running process named it, `pending` means installed but not running yet (the
 * next start picks it up), and `absent` means it is not on disk at all.
 */
export function verifyActivation(
  profile: string,
  names: string[],
  explicitDir?: string,
): ActivationState[] {
  let dir: string
  try {
    dir = resolveProfileDir(profile, explicitDir)
  } catch (error) {
    logEvent('warn', 'verify', `activation states unavailable: ${(error as Error).message}`)
    return names
      .map(name => name.trim())
      .filter(name => name !== '')
      .map(name => ({ name, state: 'absent' as const }))
  }

  const disabled = new Set(disabledList(readGalaxyState(dir)))
  const live = hotMountedNames(dir)
  const states: ActivationState[] = []

  for (const rawName of names) {
    const name = rawName.trim()
    if (name === '') continue
    if (!isInstalled(profile, name, dir)) {
      states.push({ name, state: 'absent' })
      continue
    }
    if (disabled.has(name)) {
      states.push({ name, state: 'disabled' })
      continue
    }
    if (hotIncludes(live, name)) {
      states.push({ name, state: 'live', hot: true })
      continue
    }
    states.push({ name, state: 'pending' })
  }
  return states
}
