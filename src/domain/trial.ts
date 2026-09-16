/**
 * Trial validation — the offline "would this profile boot?" pre-flight.
 *
 * Before anything writes a composition change, this replays what the boot
 * would do with the CURRENT profile contents and refuses the change when the
 * stack cannot load. It is best-effort by design: no process is spawned, no
 * network is touched and nothing is written, so the answer is a conservative
 * verdict rather than a real boot.
 *
 * The four blockers it can prove from disk alone:
 *   1. the profile manifest is missing/unreadable,
 *   2. a bundle row names a package that is not installed (the boot dies on
 *      that row and takes the whole profile, including the galaxy's own page,
 *      down with it),
 *   3. a bundle declares a patch file that is missing or is not an entry list,
 *   4. two layers insert the same loader entry id — cordis refuses to start a
 *      tree with a duplicate id.
 *
 * Two call shapes reach this function and both are supported deliberately:
 *
 *   1. `(profile, explicitDir?)` — validate the profile as it stands now.
 *   2. `(profileDirectory, candidateOrder)` — the reorder path: the order and
 *      preset modules hand over the directory plus the requested community
 *      bundle order, and the trial additionally refuses a candidate naming a
 *      package the profile cannot resolve.
 *
 * The user patch layer is read through the patch module (`readUserPatchState`),
 * so the trial and the uninstall guard can never disagree about whether the
 * user's own file is readable.
 */

import { basename, join } from 'node:path'
import { JSON_SCHEMA, Type, load } from 'js-yaml'
import { fileExists, readJsonFile, readTextFile } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import {
  INBOX_BUNDLES,
  installedPackageDir,
  isInstalled,
  readBundleNames,
  resolveProfileDir,
} from '../core/profile.ts'
import { readUserPatchState } from './patch.ts'

/**
 * js-yaml dialect for DSH patch files: they may carry `!!js` expression
 * scalars, which the default schema rejects outright. Keeping the tag as an
 * opaque marker is enough — the trial only reads entry ids.
 */
const jsExpr = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown): boolean => typeof data === 'string',
  construct: (data: unknown): unknown => ({ __jsExpr: String(data) }),
})
const entrySchema = JSON_SCHEMA.extend(jsExpr)

/** One reason the composition would not load. */
export interface TrialIssue {
  /** Bundle name, `cordis.patch.yml` or a synthetic marker such as `(order)`. */
  layer: string
  message: string
}

/** Verdict of a trial validation. */
export interface TrialResult {
  ok: boolean
  /** The first blocker, when the verdict is negative. */
  reason?: string
  errors: TrialIssue[]
  warnings: TrialIssue[]
}

/** Structural subset of an installed bundle manifest. */
interface BundleManifestShape {
  dsh?: unknown
}

/**
 * Loader entry ids one patch document inserts, recursively through group
 * configs. Returns null when the document is not an entry list at all.
 */
function insertIds(patchText: string): string[] | null {
  let parsed: unknown
  try {
    parsed = load(patchText, { schema: entrySchema })
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const ids: string[] = []
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      if (typeof record.id === 'string' && record.id !== '') ids.push(record.id)
      if (Array.isArray(record.config)) walk(record.config)
      if (Array.isArray(record.insert)) walk(record.insert)
    }
  }
  walk(parsed)
  return ids
}

/** The declared `dsh.bundle.patch` path of a bundle manifest, when present. */
function declaredPatch(manifest: BundleManifestShape): string | undefined {
  const dsh = manifest.dsh
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) return undefined
  const bundle = (dsh as { bundle?: unknown }).bundle
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) return undefined
  const patch = (bundle as { patch?: unknown }).patch
  return typeof patch === 'string' && patch.trim() !== '' ? patch : undefined
}

/** The trial itself; the public entry point guards it. */
function runTrial(
  profile: string,
  dir: string,
  candidateOrder?: readonly string[],
): TrialResult {
  const errors: TrialIssue[] = []
  const warnings: TrialIssue[] = []

  /** Record the blocker and answer immediately — the first one is the reason. */
  const reject = (layer: string, message: string): TrialResult => {
    errors.push({ layer, message })
    return { ok: false, reason: message, errors, warnings }
  }

  if (!fileExists(join(dir, 'package.json'))) {
    return reject(profile, 'profile manifest package.json is missing or unreadable — the bundle stack cannot be validated')
  }

  // A reorder candidate must name packages the profile can actually resolve:
  // the merged order is written to the manifest and the next boot loads it.
  if (candidateOrder !== undefined) {
    for (const raw of candidateOrder) {
      const name = raw.trim()
      if (name === '') continue
      if (isInstalled(profile, name, dir) || INBOX_BUNDLES.has(name)) continue
      return reject('(order)', `candidate bundle ${name} is not installed — the next host start fails on this row`)
    }
  }

  /** entry id → the layers that insert it, in first-seen order. */
  const claimants = new Map<string, string[]>()
  const claim = (id: string, owner: string): void => {
    const list = claimants.get(id) ?? []
    if (!list.includes(owner)) list.push(owner)
    claimants.set(id, list)
  }

  for (const name of readBundleNames(profile, dir)) {
    if (!isInstalled(profile, name, dir)) {
      // An in-box bundle is supplied by the dsh installation; not finding it
      // from this process says nothing about the profile.
      if (INBOX_BUNDLES.has(name)) continue
      return reject(name, `bundle ${name} is not installed — the next host start fails on this row`)
    }
    const bundleDir = installedPackageDir(profile, name, dir)
    const manifest = readJsonFile<BundleManifestShape>(join(bundleDir, 'package.json'))
    if (manifest === undefined) {
      return reject(name, `bundle ${name}: package.json is unreadable`)
    }
    const patch = declaredPatch(manifest)
    if (patch === undefined) {
      return reject(name, `bundle ${name} declares no dsh.bundle.patch — the boot cannot load it as a bundle`)
    }
    const text = readTextFile(join(bundleDir, patch))
    if (text === null) {
      return reject(name, `bundle ${name}: declared patch ${patch} is missing`)
    }
    const ids = insertIds(text)
    if (ids === null) {
      return reject(name, `bundle ${name}: patch ${patch} is not a valid entry list`)
    }
    for (const id of ids) claim(id, name)
  }

  let userPatch
  try {
    userPatch = readUserPatchState(profile, dir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return reject('user-patch', `user patch layer could not be read: ${message}`)
  }
  if (userPatch.unreadable) {
    return reject('user-patch', 'cordis.patch.yml is not a valid entry list — the boot cannot compose the layer stack')
  }
  // Replay the user's own rows for their entry ids (the row model reports the
  // packages an insert names, not the ids it introduces), so a user insert that
  // collides with a bundle entry is caught here rather than at the next start.
  const userText = readTextFile(join(dir, 'cordis.patch.yml'))
  if (userText !== null) {
    const ids = insertIds(userText)
    if (ids === null) {
      warnings.push({
        layer: 'user-patch',
        message: 'cordis.patch.yml could not be replayed for entry ids;'
          + ' duplicate ids involving the user patch were not checked',
      })
    } else {
      for (const id of ids) claim(id, 'cordis.patch.yml')
    }
  }

  for (const [id, owners] of claimants) {
    if (owners.length > 1) {
      return reject(
        owners.join(' / '),
        `duplicate loader entry id ${JSON.stringify(id)} is inserted by`
        + ` ${owners.join(', ')} — the host refuses to start on it`,
      )
    }
  }
  return { ok: true, errors, warnings }
}

/**
 * Best-effort pre-flight of the bundle stack.
 *
 * Never throws and never spawns a process: a failure to even read the profile
 * is reported as a negative verdict, so the caller can simply skip the write it
 * was about to perform.
 *
 * @param profile - DSH profile name, or the profile directory in the
 *   candidate-order shape.
 * @param explicitDir - directory the Desktop host owns, or the requested
 *   community bundle order.
 */
export function trialValidate(profile: string, explicitDir?: string): TrialResult
export function trialValidate(profileDirectory: string, candidateOrder: readonly string[]): TrialResult
export function trialValidate(
  profileOrDir: string,
  explicitDirOrOrder?: string | readonly string[],
): TrialResult {
  try {
    const candidateOrder = Array.isArray(explicitDirOrOrder) ? explicitDirOrOrder : undefined
    const explicitDir = typeof explicitDirOrOrder === 'string' ? explicitDirOrOrder : undefined
    // In the reorder shape the first argument already IS the directory; the
    // profile name is then only a handle for the core helpers, which honour the
    // explicit directory and never consult the name.
    const dir = candidateOrder === undefined
      ? resolveProfileDir(profileOrDir, explicitDir)
      : profileOrDir
    const profile = candidateOrder === undefined ? profileOrDir : basename(dir)
    return runTrial(profile, dir, candidateOrder)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logEvent('error', 'trial', `trial validation failed: ${message}`)
    return {
      ok: false,
      reason: `trial validation failed: ${message}`,
      errors: [{ layer: '(trial)', message: `trial validation failed: ${message}` }],
      warnings: [],
    }
  }
}
