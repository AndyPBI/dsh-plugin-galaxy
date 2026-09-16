/**
 * Group B routes — the installed inventory and every tuning mutation:
 *
 * This layer only parses requests, calls the domain modules and serializes
 * responses (,
 *
 * ).
 *
 * Every durable write goes through
 * `runtime.locks.withLock('write', label, task)`. `write` (not `install`) is
 * correct here — no child process and no dependency graph is touched, only
 * galaxy-owned documents and the profile manifest's bundle list.
 *
 * Cross-module dependencies implemented in parallel (called by the exact
 * signatures from `docs/implementation-contract.md` §5):
 *   - `analyzeProfile(profile, explicitDir?)` — domain/diagnostics.ts (group C)
 *   - `trialValidate(dir, order)` — domain/trial.ts (group C), injected into
 *     order.ts/presets.ts as their trial validator
 *   - `createProfileBackup(profile, explicitDir?)` /
 *     `restoreProfileBackup(profile, backup, explicitDir?)` —
 *     domain/backup.ts (group D)
 */

import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, booleanField, readJsonBody, sendJson, stringArrayField, stringField } from '../core/http.ts'
import { logEvent } from '../core/log.ts'
import { hasClientBundle, readBundleNames, readInstalledPlugins, readInstalledVersion, specRepo } from '../core/profile.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import { MAX_FAVORITES, MAX_NOTE, readGalaxyState, updateGalaxyState } from '../core/state.ts'
import type { ActivationState, DiagnosticReport, InstalledPayload, PatchState } from '../core/types.ts'
import { createProfileBackup } from '../domain/backup.ts'
import * as backupModule from '../domain/backup.ts'
import { analyzeProfile } from '../domain/diagnostics.ts'
import { createGroup, deleteGroup, renameGroup, setGroupEnabled, setGroupMembers } from '../domain/groups.ts'
import { dropStaleHotMounts, hotMountNames, hotUnmount } from '../domain/hot.ts'
import { applyBundleOrder, checkCandidateOrder, readBundleStack, type BundleOrderResult } from '../domain/order.ts'
import { isProtectedModule, readUserPatchState } from '../domain/patch.ts'
import { applyPreset, deletePreset, listPresets, previewPreset, readPresets, savePreset } from '../domain/presets.ts'
import { createProfileSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot, DEFAULT_MAX_SNAPSHOTS, tryCreateProfileSnapshot } from '../domain/snapshot.ts'
import { activateTheme, installedThemeNames, isTheme, listThemes } from '../domain/themes.ts'
import { trialValidate as runTrial } from '../domain/trial.ts'
import type { Router } from './router.ts'

/**
 * Trial validator handed to the order/preset modules. `domain/trial.ts` owns
 * the composition replay; this adapter narrows its result to the reason string
 * the callers report.
 */
function trialFor(dir: string, order: string[]): { ok: boolean; reason?: string } {
  const result = runTrial(dir, order)
  if (result.ok) return { ok: true }
  const first = result.errors[0]
  return { ok: false, reason: first?.message ?? 'trial validation failed / 试启动校验失败' }
}

/** Request body as a record, or undefined for a non-object/empty/unparseable body. */
async function readRecord(request: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(await readJsonBody(request, maxBytes))
  } catch (error) {
    logEvent('warn', 'route', `could not read request body: ${(error as Error).message}`)
    return undefined
  }
}

/** Send a JSON error with a meaningful status code. */
function fail(response: ServerResponse, status: number, error: string): void {
  sendJson(response, status, { ok: false, error })
}

/** Names that are live right now: the bundle stack plus recorded hot mounts. */
function liveNames(runtime: GalaxyRuntime): Set<string> {
  const live = new Set(hotMountNames(runtime))
  for (const name of readBundleStack(runtime.config.profile, runtime.dir).current) live.add(name)
  return live
}

/** True when the package directory holds a manifest. */
function isPresent(runtime: GalaxyRuntime, name: string): boolean {
  return existsSync(`${runtime.dir}/node_modules/${name}/package.json`)
}

/** Repository hints parsed from the profile's dependency specs. */
function repoHintsFor(plugins: ReturnType<typeof readInstalledPlugins>): Record<string, string> {
  const hints: Record<string, string> = {}
  for (const plugin of plugins) {
    const repo = plugin.repo ?? specRepo(plugin.spec)
    if (repo !== undefined) hints[plugin.name] = repo
  }
  return hints
}

/**
 * Repository identities taken from each installed package's own manifest
 * `repository` field. Read-only evidence, best effort.
 */
function repoIdentitiesFor(runtime: GalaxyRuntime, names: readonly string[]): Record<string, string> {
  const identities: Record<string, string> = {}
  for (const name of names) {
    try {
      const file = `${runtime.dir}/node_modules/${name}/package.json`
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { repository?: unknown }
      const repository = parsed.repository
      if (typeof repository === 'string' && repository !== '') identities[name] = repository
      else if (repository !== null && typeof repository === 'object' && !Array.isArray(repository)) {
        const url = (repository as { url?: unknown }).url
        if (typeof url === 'string' && url !== '') identities[name] = url
      }
    } catch { /* no manifest — no evidence */ }
  }
  return identities
}

/** The patch-layer view in the shape `InstalledPayload.patch` declares. */
function patchPayload(profile: string, dir: string): PatchState {
  const state = readUserPatchState(profile, dir)
  return {
    exists: state.exists,
    rows: state.rows.map(row => ({
      id: row.id,
      disabled: row.disabled,
      forced: row.forceEnabled,
      inserts: row.inserts,
    })),
    referenced: state.referenced,
    unreadable: state.unreadable,
  }
}

/**
 * Activation state of one plugin, from observable facts only: `absent` = no
 * package directory, `disabled` = switched off, `live` = enabled and in the
 * bundle stack or hot-mounted, `pending` = enabled but only in the manifest
 * (a restart would load it).
 */
function activationFor(
  runtime: GalaxyRuntime,
  name: string,
  disabled: boolean,
  live: ReadonlySet<string>,
): ActivationState {
  if (!isPresent(runtime, name)) return { name, state: 'absent' }
  if (disabled) return { name, state: 'disabled' }
  if (live.has(name)) return { name, state: 'live', hot: hotMountNames(runtime).includes(name) }
  return { name, state: 'pending' }
}

/** GET /dsh-galaxy/installed → InstalledPayload. */
function handleInstalled(runtime: GalaxyRuntime, response: ServerResponse): void {
  const profile = runtime.config.profile
  const dir = runtime.dir
  dropStaleHotMounts(runtime, profile)
  const state = readGalaxyState(dir)
  const disabled = new Set(state.disabled ?? [])
  const stacks = readBundleStack(profile, dir)
  const bundleNames = readBundleNames(profile, dir)
  const installed = readInstalledPlugins(profile, [...disabled], bundleNames, dir)
  const live = liveNames(runtime)
  const present: string[] = []
  const activation: ActivationState[] = []
  for (const plugin of installed) {
    if (readInstalledVersion(profile, plugin.name, dir) !== undefined) present.push(plugin.name)
    activation.push(activationFor(runtime, plugin.name, disabled.has(plugin.name), live))
  }
  sendJson(response, 200, {
    profile,
    installed,
    repoIdentities: repoIdentitiesFor(runtime, installed.map(plugin => plugin.name)),
    repoHints: repoHintsFor(installed),
    present,
    activation,
    live: [...live],
    disabled: [...disabled],
    groups: state.groups ?? {},
    groupOrder: state.groupOrder ?? [],
    notes: state.notes ?? {},
    favorites: state.favorites ?? [],
    bundles: stacks.current,
    patch: patchPayload(profile, dir),
    diagnostics: analyzeProfile(profile, dir) as DiagnosticReport,
  } satisfies InstalledPayload)
}

/**
 * Report (and, when the backup module exposes one, run) the automatic restore
 * after a failed bundle-order write.
 *
 * The in-repo `domain/backup.ts` is an export/import module: it creates a
 * pre-write `ProfileBackup` used as an immediate rollback net (and, in the
 * reference product, feeds the backup tab), but it does not export an
 * in-process restore. The `dangerous` recovery contract here is therefore:
 * the pre-write snapshot is what actually rolls the change back — it is
 * captured before the write and restorable from the snapshots tab — while the
 * backup is captured and reported.
 *
 * A `restoreProfileBackup(profile, backup, explicitDir?)` hook is invoked
 * when the backup module exports one, so a host build that ships an
 * in-process restore gets the reference product's behaviour automatically.
 */
function restoreAfterFailure(runtime: GalaxyRuntime, backup: unknown, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (backup === undefined) {
    logEvent('error', 'bundle-order', `write failed: ${message}`)
    return
  }
  const restorer = (backupModule as { restoreProfileBackup?: (profile: string, value: unknown, explicitDir?: string) => unknown })
    .restoreProfileBackup
  if (typeof restorer !== 'function') {
    logEvent('error', 'bundle-order', `write failed — the pre-write snapshot is the recovery path: ${message}`)
    return
  }
  try {
    restorer(runtime.config.profile, backup, runtime.dir)
    logEvent('error', 'bundle-order', `write failed — profile restored from the pre-write backup: ${message}`)
  } catch (restoreError) {
    logEvent('error', 'bundle-order', `write failed AND the automatic restore failed: ${(restoreError as Error).message}`)
  }
}

/**
 * Pre-write profile backup (group D). The backup module owns its own format;
 * this adapter narrows the call to "best-effort, never fatal" — a profile
 * without a manifest cannot be backed up, and the snapshot taken beside it is
 * the durable recovery path, so a backup failure is logged and skipped rather
 * than turning a valid reorder into a 500.
 */
function createBackup(profile: string, dir: string): unknown | undefined {
  try {
    const backup = createProfileBackup(profile, dir)
    return backup === undefined ? undefined : backup
  } catch (error) {
    logEvent('warn', 'bundle-order', `pre-write profile backup skipped: ${(error as Error).message}`)
    return undefined
  }
}

/** POST /dsh-galaxy/bundle-order. */
async function handleBundleOrder(runtime: GalaxyRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const profile = runtime.config.profile
  const dir = runtime.dir
  const body = await readRecord(request)
  if (body === undefined) {
    fail(response, 400, 'a JSON body with { order } is required / 需要包含 { order } 的 JSON body')
    return
  }
  const order = stringArrayField(body, 'order')
  if (order === undefined) {
    fail(response, 400, 'order must be an array of bundle names / order 必须是 bundle 名称数组')
    return
  }

  await runtime.locks.withLock('write', 'bundle-order', () => {
    const check = checkCandidateOrder(profile, dir, order, trialFor)
    if (!check.ok) {
      logEvent('warn', 'bundle-order', `rejected: ${check.reason}`)
      sendJson(response, 422, { ok: false, reason: check.reason, conflicts: check.conflicts })
      return
    }

    const backup = createBackup(profile, dir)
    const captured = tryCreateProfileSnapshot(profile, dir, runtime.config.maxSnapshots)
    if (!captured.ok) {
      fail(response, 400, captured.reason)
      return
    }

    let applied: BundleOrderResult
    try {
      applied = applyBundleOrder(profile, dir, order)
    } catch (error) {
      restoreAfterFailure(runtime, backup, error)
      fail(response, 500, error instanceof Error ? error.message : String(error))
      return
    }
    if (!applied.ok) {
      fail(response, 422, applied.reason ?? 'the order was refused / 顺序被拒绝')
      return
    }
    sendJson(response, 200, { ok: true, bundles: applied.bundles, snapshot: captured.snapshot.id })
  }).catch((error: unknown) => {
    if (!response.headersSent) fail(response, 500, error instanceof Error ? error.message : String(error))
  })
}

/** GET|POST /dsh-galaxy/presets. */
async function handlePresets(runtime: GalaxyRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const profile = runtime.config.profile
  const dir = runtime.dir
  const body = await readRecord(request)
  if (body === undefined) {
    fail(response, 400, 'a JSON body with { action, name } is required / 需要包含 { action, name } 的 JSON body')
    return
  }
  const action = stringField(body, 'action')
  const name = stringField(body, 'name')
  if (name === undefined || name === '') {
    fail(response, 400, 'name is required / 需要 name')
    return
  }
  if (action === 'preview') {
    const previewed = previewPreset(dir, profile, name)
    sendJson(response, previewed.ok ? 200 : 422, previewed)
    return
  }
  if (action !== 'save' && action !== 'apply' && action !== 'delete') {
    fail(response, 400, 'action must be save | preview | apply | delete / action 必须是 save | preview | apply | delete')
    return
  }
  await runtime.locks.withLock('write', `presets:${action}`, () => {
    if (action === 'save') {
      const saved = savePreset(dir, {
        name,
        bundleOrder: stringArrayField(body, 'bundleOrder') ?? [],
        disabled: stringArrayField(body, 'disabled') ?? [],
      })
      sendJson(response, saved.ok ? 200 : 422, saved)
      return
    }
    if (action === 'delete') {
      const deleted = deletePreset(dir, name)
      sendJson(response, deleted.ok ? 200 : 404, deleted)
      return
    }
    const applied = applyPreset(profile, dir, name, trialFor, runtime.config.maxSnapshots)
    sendJson(response, applied.ok ? 200 : 422, applied)
  }).catch((error: unknown) => {
    if (!response.headersSent) fail(response, 500, error instanceof Error ? error.message : String(error))
  })
}

/** POST /dsh-galaxy/snapshots — create one snapshot. */
async function handleCreateSnapshot(runtime: GalaxyRuntime, response: ServerResponse): Promise<void> {
  const profile = runtime.config.profile
  const dir = runtime.dir
  await runtime.locks.withLock('write', 'snapshots:create', () => {
    const captured = tryCreateProfileSnapshot(profile, dir, runtime.config.maxSnapshots)
    if (captured.ok) sendJson(response, 200, { ok: true, snapshot: captured.snapshot })
    else fail(response, 400, captured.reason)
  }).catch((error: unknown) => {
    if (!response.headersSent) fail(response, 500, error instanceof Error ? error.message : String(error))
  })
}

/** POST /dsh-galaxy/restore-snapshot. */
async function handleRestoreSnapshot(runtime: GalaxyRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const dir = runtime.dir
  const body = await readRecord(request)
  const snapshot = stringField(body, 'snapshot')
  if (snapshot === undefined || snapshot === '') {
    fail(response, 400, 'snapshot id is required / 需要快照 id')
    return
  }
  await runtime.locks.withLock('write', 'restore-snapshot', () => {
    const restored = restoreSnapshot(dir, snapshot)
    if (restored.ok) sendJson(response, 200, { ok: true, snapshot })
    else fail(response, 404, restored.reason ?? 'snapshot not found / 快照不存在')
  }).catch((error: unknown) => {
    if (!response.headersSent) fail(response, 500, error instanceof Error ? error.message : String(error))
  })
}

/** POST /dsh-galaxy/delete-snapshot. */
async function handleDeleteSnapshot(runtime: GalaxyRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const dir = runtime.dir
  const body = await readRecord(request)
  const snapshot = stringField(body, 'snapshot')
  if (snapshot === undefined || snapshot === '') {
    fail(response, 400, 'snapshot id is required / 需要快照 id')
    return
  }
  await runtime.locks.withLock('write', 'delete-snapshot', () => {
    const deleted = deleteSnapshot(dir, snapshot)
    if (deleted) sendJson(response, 200, { ok: true, snapshot })
    else fail(response, 404, 'snapshot not found / 快照不存在')
  }).catch((error: unknown) => {
    if (!response.headersSent) fail(response, 500, error instanceof Error ? error.message : String(error))
  })
}

/** POST /dsh-galaxy/use-skin. */
async function handleUseSkin(runtime: GalaxyRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const profile = runtime.config.profile
  const dir = runtime.dir
  const body = await readRecord(request)
  const name = stringField(body, 'name')
  if (name === undefined || name === '') {
    fail(response, 400, 'name is required / 需要 name')
    return
  }
  await runtime.locks.withLock('write', 'use-skin', () => {
    if (!isTheme(profile, dir, name)) {
      fail(response, 409, `${name} is not an installed theme / ${name} 不是已安装的主题`)
      return
    }
    const activated = activateTheme(profile, dir, name)
    if (!activated) {
      sendJson(response, 502, { ok: false, error: 'theme activation failed — restart required / 主题激活失败，需要重启' })
      return
    }
    sendJson(response, 200, { ok: true, name, themes: listThemes(profile, dir) })
  }).catch((error: unknown) => {
    if (!response.headersSent) fail(response, 500, error instanceof Error ? error.message : String(error))
  })
}

/** POST /dsh-galaxy/toggle. */
async function handleToggle(runtime: GalaxyRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const profile = runtime.config.profile
  const dir = runtime.dir
  const body = await readRecord(request)
  const name = stringField(body, 'name')
  const enabled = booleanField(body, 'enabled')
  if (name === undefined || name === '') {
    fail(response, 400, 'name is required / 需要 name')
    return
  }
  if (enabled === undefined) {
    fail(response, 400, 'enabled must be a boolean / enabled 必须是布尔值')
    return
  }
  // Switching off host infrastructure (or the galaxy
  // itself) breaks the very chain the patch layer runs on.
  if (isProtectedModule(name)) {
    fail(response, 400, `${name} is host infrastructure and cannot be toggled / ${name} 属于宿主基础设施，禁止开关`)
    return
  }

  await runtime.locks.withLock('write', 'toggle', () => {
    const state = readGalaxyState(dir)
    const installed = readInstalledPlugins(profile, [...(state.disabled ?? [])], [], dir)
    if (!installed.some(plugin => plugin.name === name)) {
      fail(response, 404, `${name} is not installed / ${name} 未安装`)
      return
    }

    const wasLive = liveNames(runtime).has(name)
    if (enabled && isTheme(profile, dir, name)) {
      // Theme exclusivity: enabling a theme switches every other theme off.
      if (!activateTheme(profile, dir, name)) {
        fail(response, 502, 'theme activation failed — restart required / 主题激活失败，需要重启')
        return
      }
    } else {
      updateGalaxyState(dir, (current) => {
        const next = new Set(current.disabled ?? [])
        if (enabled) next.delete(name)
        else next.add(name)
        current.disabled = [...next]
      })
      if (!enabled) hotUnmount(runtime, profile, name)
    }

    const liveAfter = enabled ? liveNames(runtime) : new Set<string>()
    // The live composition did not follow the switch — the change lands on the
    // next boot through the patch layer and the state file.
    const needsRestart = enabled ? !liveAfter.has(name) : wasLive
    sendJson(response, 200, {
      ok: true,
      name,
      enabled,
      disabled: [...(readGalaxyState(dir).disabled ?? [])],
      activation: { [name]: activationFor(runtime, name, !enabled, liveAfter) },
      // `restart` is the original key; `needsRestart` is the name install,
      // update and uninstall use, and the one the UI keys its notice on.
      restart: needsRestart,
      needsRestart,
      // A plugin with a client bundle needs a page refresh to show the change.
      refresh: hasClientBundle(profile, name, dir),
    })
  }).catch((error: unknown) => {
    if (!response.headersSent) fail(response, 500, error instanceof Error ? error.message : String(error))
  })
}

/** POST /dsh-galaxy/note. */
async function handleNote(runtime: GalaxyRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const dir = runtime.dir
  const body = await readRecord(request)
  const name = stringField(body, 'name')
  if (name === undefined || name === '') {
    fail(response, 400, 'name is required / 需要 name')
    return
  }
  const text = (stringField(body, 'text') ?? '').slice(0, MAX_NOTE)
  await runtime.locks.withLock('write', 'note', () => {
    // updateGalaxyState re-reads the file first, so two browser tabs cannot
    // silently drop each other's notes.
    const state = updateGalaxyState(dir, (current) => {
      const notes = { ...(current.notes ?? {}) }
      // Empty clears rather than storing a blank: a row must not claim to
      // carry a note the user just erased.
      if (text === '') delete notes[name]
      else notes[name] = text
      current.notes = notes
    })
    sendJson(response, 200, { ok: true, notes: state.notes ?? {} })
  }).catch((error: unknown) => {
    if (!response.headersSent) fail(response, 500, error instanceof Error ? error.message : String(error))
  })
}

/** POST /dsh-galaxy/favorite. */
async function handleFavorite(runtime: GalaxyRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const dir = runtime.dir
  const body = await readRecord(request)
  const url = stringField(body, 'url')
  const favorited = booleanField(body, 'favorited')
  if (url === undefined || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    fail(response, 400, 'a valid http(s) url is required / 需要有效的 http(s) url')
    return
  }
  if (favorited === undefined) {
    fail(response, 400, 'favorited must be a boolean / favorited 必须是布尔值')
    return
  }
  await runtime.locks.withLock('write', 'favorite', () => {
    const current = readGalaxyState(dir)
    const favorites = [...(current.favorites ?? [])]
    if (favorited && !favorites.includes(url) && favorites.length >= MAX_FAVORITES) {
      fail(response, 422, `favorites limit reached (${MAX_FAVORITES}) / 收藏已达上限（${MAX_FAVORITES}）`)
      return
    }
    // Re-read immediately before writing so a concurrent mutation is never
    // dropped by a stale snapshot.
    const state = updateGalaxyState(dir, (fresh) => {
      const list = [...(fresh.favorites ?? [])]
      if (favorited) {
        if (!list.includes(url)) list.push(url)
      } else {
        const index = list.indexOf(url)
        if (index !== -1) list.splice(index, 1)
      }
      fresh.favorites = list
    })
    sendJson(response, 200, { ok: true, favorites: state.favorites ?? [] })
  }).catch((error: unknown) => {
    if (!response.headersSent) fail(response, 500, error instanceof Error ? error.message : String(error))
  })
}

/** POST /dsh-galaxy/groups. */
async function handleGroups(runtime: GalaxyRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const profile = runtime.config.profile
  const dir = runtime.dir
  const body = await readRecord(request)
  const action = stringField(body, 'action')
  const name = stringField(body, 'name') ?? ''
  const known = action === 'create' || action === 'rename' || action === 'delete'
    || action === 'set-members' || action === 'members'
    || action === 'toggle' || action === 'enable' || action === 'disable'
  if (action === undefined || !known) {
    fail(response, 400, 'unknown group action / 未知的分组操作')
    return
  }
  const members = stringArrayField(body, 'members')
  const newName = stringField(body, 'newName')
  const enabled = booleanField(body, 'enabled') ?? (action === 'enable' ? true : action === 'disable' ? false : undefined)
  const installed = new Set(readInstalledPlugins(profile, [], [], dir).map(plugin => plugin.name))

  await runtime.locks.withLock('write', `groups:${action}`, () => {
    let ok: boolean
    let reason: string | undefined
    let extra: Record<string, unknown> = {}
    if (action === 'create') {
      const result = createGroup(dir, name)
      ok = result.ok
      reason = result.reason
    } else if (action === 'rename') {
      const result = renameGroup(dir, name, newName ?? '')
      ok = result.ok
      reason = result.reason
    } else if (action === 'delete') {
      const result = deleteGroup(dir, name)
      ok = result.ok
      reason = result.reason
    } else if (action === 'set-members' || action === 'members') {
      const result = setGroupMembers(dir, name, members ?? [], installed)
      ok = result.ok
      reason = result.reason
    } else {
      if (enabled === undefined) {
        fail(response, 400, 'action toggle|enable|disable requires { enabled } / 切换操作需要 enabled')
        return
      }
      const result = setGroupEnabled(profile, dir, name, enabled, {
        installed,
        themes: installedThemeNames(profile, dir),
        activateMember: member => activateTheme(profile, dir, member),
      })
      ok = result.ok
      reason = result.reason
      extra = { members: result.members, restartMembers: result.members }
    }
    const state = readGalaxyState(dir)
    logEvent(ok ? 'info' : 'warn', 'groups', `${action} ${name}${ok ? '' : ` — ${reason ?? ''}`}`)
    sendJson(response, ok ? 200 : 400, {
      ok,
      ...(reason === undefined ? {} : { error: reason, reason }),
      groups: state.groups ?? {},
      groupOrder: state.groupOrder ?? [],
      disabled: state.disabled ?? [],
      ...extra,
    })
  }).catch((error: unknown) => {
    if (!response.headersSent) fail(response, 500, error instanceof Error ? error.message : String(error))
  })
}

/**
 * Register every group B endpoint on the router. Mutating routes use
 * `router.post` (which enforces same-origin); `presets` and `snapshots` accept
 * GET for listing and POST for mutation on the same path.
 */
export function registerTuningRoutes(router: Router, runtime: GalaxyRuntime): void {
  router.get('/dsh-galaxy/installed', ({ response }) => {
    handleInstalled(runtime, response)
  })

  router.post('/dsh-galaxy/bundle-order', async ({ request, response }) => {
    await handleBundleOrder(runtime, request, response)
  })

  router.methods('/dsh-galaxy/presets', ['GET', 'POST'], async ({ request, response }) => {
    if (request.method === 'GET') {
      sendJson(response, 200, { presets: listPresets(runtime.dir), count: readPresets(runtime.dir).length })
      return
    }
    await handlePresets(runtime, request, response)
  }, { sameOrigin: true })

  router.methods('/dsh-galaxy/snapshots', ['GET', 'POST'], async ({ request, response }) => {
    if (request.method === 'GET') {
      sendJson(response, 200, { snapshots: listSnapshots(runtime.dir), max: runtime.config.maxSnapshots })
      return
    }
    await handleCreateSnapshot(runtime, response)
  }, { sameOrigin: true })

  router.post('/dsh-galaxy/restore-snapshot', async ({ request, response }) => {
    await handleRestoreSnapshot(runtime, request, response)
  })

  router.post('/dsh-galaxy/delete-snapshot', async ({ request, response }) => {
    await handleDeleteSnapshot(runtime, request, response)
  })

  router.post('/dsh-galaxy/use-skin', async ({ request, response }) => {
    await handleUseSkin(runtime, request, response)
  })

  router.post('/dsh-galaxy/toggle', async ({ request, response }) => {
    await handleToggle(runtime, request, response)
  })

  router.post('/dsh-galaxy/note', async ({ request, response }) => {
    await handleNote(runtime, request, response)
  })

  router.post('/dsh-galaxy/favorite', async ({ request, response }) => {
    await handleFavorite(runtime, request, response)
  })

  router.post('/dsh-galaxy/groups', async ({ request, response }) => {
    await handleGroups(runtime, request, response)
  })
}

/** Re-exported so callers can size the snapshot quota without a second import. */
export { DEFAULT_MAX_SNAPSHOTS }
