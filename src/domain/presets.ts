/**
 * Named plugin presets — / /
 *
 * A preset captures a whole plugin composition: the community-bundle order
 * plus the set of plugins switched off. Applying one replays that composition
 * — the bundle order through `order.ts`, the disabled set through the galaxy
 * state and the user patch layer — after an automatic snapshot, so a preset
 * can always be undone from the snapshots tab.
 *
 * Presets persist in `<profile>/.dsh-galaxy/presets.json`, galaxy-owned state
 * deliberately separate from `state.json` (whose shape the host routes own).
 * Every write is atomic.
 *
 * Self-protection: a preset must never be able to switch the galaxy itself (or
 * host infrastructure) off — applying one is the one mutation that can take
 * the page you are using with it. Protected names are filtered when saving and
 * again when applying (defense in depth).
 */

import { join } from 'node:path'
import { readJsonFile, writeJsonAtomic } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import { ensureGalaxyDir, PRESETS_FILE } from '../core/paths.ts'
import { readGalaxyState, updateGalaxyState } from '../core/state.ts'
import type { Preset } from '../core/types.ts'
import { applyBundleOrder, checkCandidateOrder, readBundleStack, type OrderCheck, type TrialValidate } from './order.ts'
import { disableRow, enableRow, isProtectedModule, userPatchPath } from './patch.ts'
import { createProfileSnapshot, DEFAULT_MAX_SNAPSHOTS, type ProfileSnapshot } from './snapshot.ts'

/** At most this many presets per profile. */
export const MAX_PRESETS = 50

/** Preset names: letters/digits (incl. CJK), spaces, `_` and `-`; ≤ 40 chars. */
const PRESET_NAME_RE = /^[\p{L}\p{N}_ -]{1,40}$/u

/** Persisted document shape of `presets.json`. */
export interface PresetFile {
  presets: Preset[]
}

/** Result of a preset mutation. */
export interface PresetResult {
  ok: boolean
  reason?: string
}

/** Result of applying a preset. */
export interface PresetApplyResult extends PresetResult {
  snapshot?: string
  bundles?: string[]
  disabled?: string[]
}

/** A preset's bundle set vs. the profile's current community bundles. */
export interface PresetMismatch {
  /** Bundles the profile has that the preset does not mention. */
  missing: string[]
  /** Bundles the preset mentions that are no longer installed. */
  extra: string[]
  stale: boolean
}

/** What applying a preset would change — computed before anything is written. */
export interface PresetChange {
  /** Community bundles whose position changes. */
  reordered: string[]
  /** Plugins the preset would switch ON. */
  enabled: string[]
  /** Plugins the preset would switch OFF. */
  disabled: string[]
  /** True when nothing would change. */
  noop: boolean
}

/** Result of previewing a preset (pure read). */
export interface PresetPreviewResult extends PresetResult {
  changes?: PresetChange
  mismatch?: PresetMismatch
}

/** Absolute path of `<profile>/.dsh-galaxy/presets.json`. */
export function presetsPath(dir: string): string {
  return join(ensureGalaxyDir(dir), PRESETS_FILE)
}

/** Validate a preset name (field rule). */
export function validPresetName(name: unknown): name is string {
  return typeof name === 'string' && PRESET_NAME_RE.test(name) && name.trim() !== ''
}

/** True when a name must never appear in an applied disabled list. */
function isSelfProtected(name: string): boolean {
  return isProtectedModule(name)
}

/** Normalize an unknown document into a preset list. */
function normalizePresets(raw: unknown): Preset[] {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { presets?: unknown }).presets
    : undefined
  if (!Array.isArray(source)) return []
  const presets: Preset[] = []
  for (const entry of source) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.name !== 'string' || !validPresetName(record.name)) continue
    const bundleOrder = Array.isArray(record.bundleOrder)
      ? record.bundleOrder.filter((item): item is string => typeof item === 'string')
      : []
    const disabled = Array.isArray(record.disabled)
      ? record.disabled.filter((item): item is string => typeof item === 'string')
      : []
    presets.push({
      name: record.name,
      bundleOrder,
      disabled,
      createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0,
    })
  }
  return presets
}

/** Read the stored preset list; never throws (a corrupt file reads as empty). */
export function readPresets(dir: string): Preset[] {
  return normalizePresets(readJsonFile<unknown>(presetsPath(dir)))
}

/** Write the whole preset list atomically. */
export function writePresets(dir: string, presets: readonly Preset[]): void {
  writeJsonAtomic(presetsPath(dir), { presets: [...presets] } satisfies PresetFile)
}

/** All saved presets, newest first. */
export function listPresets(dir: string): Preset[] {
  return readPresets(dir).sort((left, right) => right.createdAt - left.createdAt)
}

/** Find one preset by name. */
export function findPreset(dir: string, name: string): Preset | undefined {
  return readPresets(dir).find(preset => preset.name === name)
}

/** Compare a preset's order against the profile's current community bundles. */
function presetMismatch(profile: string, dir: string, bundleOrder: readonly string[]): PresetMismatch {
  const stack = readBundleStack(profile, dir)
  const current = new Set([...stack.current, ...stack.unordered])
  const preset = new Set(bundleOrder)
  const missing = [...current].filter(name => !preset.has(name))
  const extra = bundleOrder.filter(name => !current.has(name))
  return { missing, extra, stale: missing.length > 0 || extra.length > 0 }
}

/** Human-readable `+name -name` detail of a stale preset. */
function mismatchDetail(mismatch: PresetMismatch): string {
  return [...mismatch.missing.map(name => `+${name}`), ...mismatch.extra.map(name => `-${name}`)].join(' ')
}

/** The disabled list a preset actually applies (protected names dropped). */
function sanitizedDisabled(disabled: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of disabled) {
    if (name === '' || seen.has(name) || isSelfProtected(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * /: store a named composition.
 *
 * The order must be an exact permutation of the profile's current community
 * bundles — a stale snapshot is refused here rather than failing later at
 * apply time. The quota is enforced by refusal, never by silently dropping the
 * oldest preset.
 */
export function savePreset(dir: string, preset: { name: unknown; bundleOrder: unknown; disabled?: unknown }): PresetResult {
  const name = preset.name
  if (!validPresetName(name)) return { ok: false, reason: 'invalid preset name / 组合名称无效' }
  const bundleOrder = Array.isArray(preset.bundleOrder)
    ? preset.bundleOrder.filter((item): item is string => typeof item === 'string')
    : undefined
  if (bundleOrder === undefined) {
    return { ok: false, reason: 'bundleOrder must be an array of bundle names / bundleOrder 必须是 bundle 名称数组' }
  }
  const presets = readPresets(dir)
  if (presets.some(entry => entry.name === name)) {
    return { ok: false, reason: 'a preset with this name already exists / 同名组合已存在' }
  }
  if (presets.length >= MAX_PRESETS) {
    return {
      ok: false,
      reason: `preset quota reached (${MAX_PRESETS}) — delete one first / 组合数量已达上限（${MAX_PRESETS}），请先删除一个`,
    }
  }
  if (new Set(bundleOrder).size !== bundleOrder.length) {
    return { ok: false, reason: 'duplicate bundle names in the preset order / 组合顺序包含重复的 bundle' }
  }
  const disabled = Array.isArray(preset.disabled)
    ? sanitizedDisabled(preset.disabled.filter((item): item is string => typeof item === 'string'))
    : []
  presets.push({ name, bundleOrder, disabled, createdAt: Date.now() })
  writePresets(dir, presets)
  logEvent('info', 'preset', `saved "${name}" (${bundleOrder.length} bundles, ${disabled.length} disabled)`)
  return { ok: true }
}

/** Delete a named preset. */
export function deletePreset(dir: string, name: string): PresetResult {
  if (!validPresetName(name)) return { ok: false, reason: 'invalid preset name / 组合名称无效' }
  const presets = readPresets(dir)
  const next = presets.filter(preset => preset.name !== name)
  if (next.length === presets.length) return { ok: false, reason: 'preset not found / 组合不存在' }
  writePresets(dir, next)
  logEvent('info', 'preset', `deleted "${name}"`)
  return { ok: true }
}

/**
 * Preview what applying a preset would change, WITHOUT writing anything.
 * A stale preset (bundle-set mismatch) is reported explicitly; the still
 * computable diffs are returned alongside it.
 */
export function previewPreset(dir: string, profile: string, name: string): PresetPreviewResult {
  if (!validPresetName(name)) return { ok: false, reason: 'invalid preset name / 组合名称无效' }
  const preset = findPreset(dir, name)
  if (preset === undefined) return { ok: false, reason: 'preset not found / 组合不存在' }
  const mismatch = presetMismatch(profile, dir, preset.bundleOrder)
  if (mismatch.stale) {
    return {
      ok: false,
      mismatch,
      reason: `preset is out of date — current profile differs: ${mismatchDetail(mismatch)} / 组合已过期——当前 profile 的插件列表已变化：${mismatchDetail(mismatch)}`,
    }
  }
  const stack = readBundleStack(profile, dir)
  const reordered = stack.current.filter((bundle, index) => bundle !== preset.bundleOrder[index])
  const currentDisabled = new Set(readGalaxyState(dir).disabled ?? [])
  const presetDisabled = new Set(sanitizedDisabled(preset.disabled))
  const enabled = [...currentDisabled].filter(item => !presetDisabled.has(item))
  const disabled = [...presetDisabled].filter(item => !currentDisabled.has(item))
  return {
    ok: true,
    changes: {
      reordered,
      enabled,
      disabled,
      noop: reordered.length === 0 && enabled.length === 0 && disabled.length === 0,
    },
  }
}

/**
 * Apply a saved preset.
 *
 * Order of operations (each step refuses without writing on failure):
 * trial-validate the candidate order, auto-snapshot the profile, write the
 * bundle order, then write the disabled set through the patch layer and the
 * galaxy state.
 */
export function applyPreset(
  profile: string,
  dir: string,
  name: string,
  trial?: TrialValidate,
  maxSnapshots: number = DEFAULT_MAX_SNAPSHOTS,
): PresetApplyResult {
  if (!validPresetName(name)) return { ok: false, reason: 'invalid preset name / 组合名称无效' }
  const preset = findPreset(dir, name)
  if (preset === undefined) return { ok: false, reason: 'preset not found / 组合不存在' }

  const mismatch = presetMismatch(profile, dir, preset.bundleOrder)
  if (mismatch.stale) {
    const detail = mismatchDetail(mismatch)
    logEvent('warn', 'preset', `apply "${name}" rejected: preset out of date — ${detail}`)
    return {
      ok: false,
      reason: `preset is out of date — current profile differs: ${detail} / 组合已过期——当前 profile 的插件列表已变化：${detail}`,
    }
  }

  const stack = readBundleStack(profile, dir)
  const community = [...stack.current, ...stack.unordered]
  const check: OrderCheck = checkCandidateOrder(profile, dir, preset.bundleOrder, trial)
  if (!check.ok) {
    logEvent('warn', 'preset', `apply "${name}" rejected: ${check.reason}`)
    return { ok: false, reason: check.reason }
  }

  // Automatic pre-change snapshot: every preset apply is undoable.
  let snapshot: ProfileSnapshot
  try {
    snapshot = createProfileSnapshot(profile, dir, maxSnapshots)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logEvent('error', 'preset', `apply "${name}" refused: ${reason}`)
    return { ok: false, reason }
  }

  const applied = applyBundleOrder(profile, dir, preset.bundleOrder, trial)
  if (!applied.ok) return { ok: false, reason: applied.reason }

  const disabled = sanitizedDisabled(preset.disabled)
  try {
    for (const installed of community) {
      if (disabled.includes(installed)) disableRow(userPatchPath(profile, dir), installed)
      else enableRow(userPatchPath(profile, dir), installed)
    }
    updateGalaxyState(dir, (state) => { state.disabled = [...disabled] })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logEvent('error', 'preset', `apply "${name}" wrote the order but failed on the disabled set: ${reason}`)
    return { ok: false, reason, snapshot: snapshot.id, bundles: applied.bundles }
  }
  logEvent('info', 'preset', `applied "${name}" (snapshot ${snapshot.id})`)
  return { ok: true, snapshot: snapshot.id, bundles: applied.bundles, disabled }
}
