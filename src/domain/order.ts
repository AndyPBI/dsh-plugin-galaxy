/**
 * Community bundle ordering — / /
 * (consumers).
 *
 * DSH loads a web profile from an ordered stack recorded in the profile
 * manifest's `dsh.profile.bundles` array. The official in-box bundles
 * (`@deepseek-ai/dsh-base`, `-web-app`, `-headless`) are fixed: they keep
 * their exact positions and are never reordered, added or removed by a user
 * reorder. Community bundles may be permuted, but only after two checks:
 *
 *   1. the packages' own `dsh.bundle.order.{before,after}` declarations are
 *      satisfied ({@link validateOrder} / {@link readBundleRules}),
 *   2. a dry-run composition replay accepts the candidate
 *      ({@link trialValidate}, implemented by the diagnostics/trial module).
 *
 * The single manifest write is atomic (`writeJsonAtomic`). Before writing, a
 * `ProfileManifestSnapshot` is captured; when the write throws the snapshot is
 * restored, so a failed reorder can never leave a manifest DSH refuses to
 * boot.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { writeJsonAtomic } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import {
  INBOX_BUNDLES,
  manifestPath,
  readBundleNames,
  readInstalled,
  readProfileManifest,
  readProfileManifestSnapshot,
  restoreProfileManifest,
  type ProfileManifest,
} from '../core/profile.ts'
import { profileDir } from '../core/paths.ts'
import type { BundleStack } from '../core/types.ts'

export { INBOX_BUNDLES }

/** Author-declared ordering constraints of one bundle. */
export interface BundleRule {
  name: string
  /** This bundle must load after every name in this list. */
  after: string[]
  /** This bundle must load before every name in this list. */
  before: string[]
}

/** A violated before/after rule in the proposed order. */
export interface OrderConflict {
  name: string
  reason: string
}

/** Result of merging or validating a candidate community order. */
export type OrderCheck =
  | { ok: true; bundles: string[]; conflicts: OrderConflict[] }
  | { ok: false; reason: string; conflicts: OrderConflict[] }

/**
 * The profile's bundle stack: the recorded order, the community bundles
 * present in the manifest but not ordered yet, and the merged candidate.
 */
export function readBundleStack(profile: string, explicitDir?: string): BundleStack {
  const current = readBundleNames(profile, explicitDir).filter(name => !INBOX_BUNDLES.has(name))
  const currentSet = new Set(current)
  const unordered = Object.keys(readInstalled(profile, explicitDir))
    .filter(name => !currentSet.has(name))
    .sort((left, right) => left.localeCompare(right))
  return { current, unordered, merged: [...current] }
}

/** The raw manifest bundle list, including the fixed in-box bundles. */
export function readRawBundleNames(profile: string, explicitDir?: string): string[] {
  return readBundleNames(profile, explicitDir)
}

/** Path of a bundle's own package.json, resolved the way the boot resolves it. */
function resolveBundlePackageJson(dir: string, name: string): string | undefined {
  const direct = join(dir, 'node_modules', name, 'package.json')
  if (existsSync(direct)) return direct
  // pnpm workspace-root hoisting: Node's own search paths from the profile
  // anchor also cover `<profiles>/node_modules` for `<profiles>/<name>`.
  try {
    const paths = createRequire(join(dir, 'package.json')).resolve.paths(name) ?? []
    for (const searchPath of paths) {
      const candidate = join(searchPath, name, 'package.json')
      if (existsSync(candidate)) return candidate
    }
  } catch { /* unresolvable bundle — contributes no rule */ }
  return undefined
}

/**
 * Read every bundle's declared ordering rules (`dsh.bundle.order`). A bundle
 * that is not installed, is unreadable, or declares no rule contributes
 * nothing.
 */
export function readBundleRules(profile: string, explicitDir?: string): BundleRule[] {
  const dir = profileDir(profile, explicitDir)
  const rules: BundleRule[] = []
  for (const name of readBundleNames(profile, explicitDir)) {
    if (INBOX_BUNDLES.has(name)) continue
    const file = resolveBundlePackageJson(dir, name)
    if (file === undefined) continue
    let order: unknown
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as { dsh?: { bundle?: { order?: unknown } } }
      order = manifest.dsh?.bundle?.order
    } catch {
      continue
    }
    if (order === null || typeof order !== 'object' || Array.isArray(order)) continue
    const listOf = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
    const record = order as Record<string, unknown>
    const rule: BundleRule = { name, after: listOf(record.after), before: listOf(record.before) }
    if (rule.after.length > 0 || rule.before.length > 0) rules.push(rule)
  }
  return rules
}

/**
 * Merge a community-bundle permutation into the full recorded stack. The
 * fixed in-box bundles keep their exact positions; community slots are filled
 * with `requested` in order. Pure — nothing is written.
 *
 * `candidates` is the community list the caller believes is installed; when
 * omitted it is derived from the recorded order.
 */
export function mergeOrder(current: string[], candidates: string[], requested: string[]): OrderCheck {
  const community = (candidates.length > 0 ? candidates : current).filter(name => !INBOX_BUNDLES.has(name))
  if (new Set(requested).size !== requested.length) {
    return { ok: false, reason: 'duplicate bundle names in the new order / 新顺序包含重复的 bundle', conflicts: [] }
  }
  const communitySet = new Set(community)
  if (requested.length !== communitySet.size) {
    return {
      ok: false,
      reason: 'the new order must contain exactly the current community bundles / 新顺序必须恰好包含全部社区 bundle',
      conflicts: [],
    }
  }
  for (const name of requested) {
    if (!communitySet.has(name)) {
      return {
        ok: false,
        reason: `${name} is not a reorderable community bundle / ${name} 不是可排序的社区 bundle`,
        conflicts: [],
      }
    }
  }
  const merged = [...current]
  let cursor = 0
  for (let index = 0; index < merged.length; index += 1) {
    const name = merged[index]
    if (name === undefined || INBOX_BUNDLES.has(name)) continue
    merged[index] = requested[cursor]!
    cursor += 1
  }
  return { ok: true, bundles: merged, conflicts: [] }
}

/**
 * Check a bundle order against the declared before/after rules. Rules naming
 * bundles outside `stack` are ignored — a rule for a not-yet-installed bundle
 * must not block the current stack.
 */
export function validateOrder(stack: readonly string[], rules: readonly BundleRule[]): OrderConflict[] {
  const position = new Map(stack.map((name, index) => [name, index]))
  const conflicts: OrderConflict[] = []
  for (const rule of rules) {
    const at = position.get(rule.name)
    if (at === undefined) continue
    for (const other of rule.after) {
      const otherAt = position.get(other)
      if (otherAt === undefined) continue
      if (otherAt >= at) {
        conflicts.push({
          name: rule.name,
          reason: `must load after ${other}, but ${other} is currently before/equal (position ${otherAt} vs ${at})`,
        })
      }
    }
    for (const other of rule.before) {
      const otherAt = position.get(other)
      if (otherAt === undefined) continue
      if (otherAt <= at) {
        conflicts.push({
          name: rule.name,
          reason: `must load before ${other}, but ${other} is currently after/equal (position ${otherAt} vs ${at})`,
        })
      }
    }
  }
  return conflicts
}

/**
 * Full pre-write check for a candidate order: permutation, before/after rules,
 * then the trial composition replay. Read-only; nothing is written.
 *
 * @param trial - dry-run validator from `domain/trial.ts`; injected so this
 * module stays independent of the composition machinery.
 * @returns the merged stack on success, or the reason it must be refused.
 */
export function checkCandidateOrder(
  profile: string,
  explicitDir: string | undefined,
  requested: string[],
  trial?: (dir: string, order: string[]) => { ok: boolean; reason?: string },
): OrderCheck {
  const stack = readBundleStack(profile, explicitDir)
  const community = [...stack.current, ...stack.unordered]
  const merged = mergeOrder(stack.merged, community, requested)
  if (!merged.ok) return merged
  const conflicts = validateOrder(merged.bundles, readBundleRules(profile, explicitDir))
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: 'the order violates declared before/after rules / 该顺序违反了插件声明的 before/after 规则',
      conflicts,
    }
  }
  if (trial !== undefined) {
    const dir = profileDir(profile, explicitDir)
    const result = trial(dir, requested)
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason ?? 'trial validation failed / 试启动校验失败',
        conflicts: [],
      }
    }
  }
  return { ok: true, bundles: merged.bundles, conflicts: [] }
}

/**
 * Trial validation seam — kept as an exported name so callers outside this
 * module (the routes layer) can refer to one symbol. The signature is
 * {@link checkCandidateOrder}'s `trial` parameter.
 */
export type TrialValidate = (dir: string, order: string[]) => { ok: boolean; reason?: string }

/** Outcome of a bundle-order write. */
export interface BundleOrderResult {
  ok: boolean
  bundles: string[]
  reason?: string
  conflicts?: OrderConflict[]
}

/**
 * Apply a new community-bundle order to the profile manifest.
 *
 * 1. capture a manifest snapshot (`readProfileManifestSnapshot`),
 * 2. attempt a trial validation when a validator is supplied,
 * 3. write via `writeJsonAtomic`,
 * 4. restore the snapshot when the write throws.
 *
 * The candidate is never partially applied: a rejection leaves the manifest
 * byte-identical to what it was.
 */
export function applyBundleOrder(
  profile: string,
  dir: string,
  order: string[],
  trial?: TrialValidate,
): BundleOrderResult {
  const manifest = readProfileManifest(profile, dir)
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
    ? (manifest.dsh!.profile!.bundles as unknown[]).filter((item): item is string => typeof item === 'string')
    : []
  const community = readBundleStack(profile, dir).current
  const merged = mergeOrder(bundles, community, order)
  if (!merged.ok) return { ok: false, bundles, reason: merged.reason }

  if (trial !== undefined) {
    const result = trial(dir, order)
    if (!result.ok) return { ok: false, bundles, reason: result.reason ?? 'trial validation failed / 试启动校验失败' }
  }

  const snapshot = readProfileManifestSnapshot(profile, dir)
  try {
    writeBundleOrder(profile, dir, merged.bundles)
  } catch (error) {
    // Restoring is best-effort: a failing restore must not mask the original
    // write error, which is what the caller reports.
    try {
      restoreProfileManifest(profile, snapshot, dir)
    } catch (restoreError) {
      logEvent('error', 'bundle-order', `manifest restore failed: ${(restoreError as Error).message}`)
    }
    const message = error instanceof Error ? error.message : String(error)
    logEvent('error', 'bundle-order', `write failed and the manifest was restored: ${message}`)
    return { ok: false, bundles, reason: message }
  }
  return { ok: true, bundles: merged.bundles }
}

/** Write the exact bundle list into `dsh.profile.bundles`. */
function writeBundleOrder(profile: string, dir: string, bundleNames: string[]): void {
  const file = manifestPath(profile, dir)
  const manifest = readProfileManifest(profile, dir) as ProfileManifest
  const dsh = { ...(manifest.dsh ?? {}) }
  const profileBlock = dsh.profile !== null && typeof dsh.profile === 'object' && !Array.isArray(dsh.profile)
    ? { ...(dsh.profile as Record<string, unknown>) }
    : {}
  profileBlock.bundles = bundleNames
  dsh.profile = profileBlock
  manifest.dsh = dsh
  writeJsonAtomic(file, manifest, 0o644)
  logEvent('info', 'bundle-order', `wrote ${bundleNames.length} bundle row(s) to ${file}`)
}
