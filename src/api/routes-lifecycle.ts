/**
 * Group F — lifecycle routes: install, update, uninstall, migration, rollback,
 * self-uninstall, restart, build approval, cancel and pnpm provisioning.
 *
 * Every endpoint here mutates the profile or the host process, so the same
 * three guards appear on all of them and in the same order:
 *
 * 1. **** — the work runs inside
 *      `runtime.locks.withLock('install', …)`, which serializes every
 *      package-manager operation. A second request queues behind the first
 *      rather than corrupting the profile.
 * 2. **** — `installBlocked(runtime)` resolves the host's
 *      agent inventory lazily at request time; running agents answer 409 with
 *      the `busyAgents` list instead of having their plugin files replaced
 *      under them.
 * 3. **** — uninstall and migration refuse while the user's
 *      own `cordis.patch.yml` still inserts the package.
 *
 * Cross-module helpers are reached through lazy dynamic imports resolved at
 * REQUEST time (`siblings()`), never at module load. A static import of a
 * module that fails to evaluate takes the whole plugin down with a
 * SyntaxError before any route can answer, so a broken helper degrades one
 * endpoint instead of the host.
 *
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { booleanField, readJsonBody, sendJson, stringArrayField, stringField } from '../core/http.ts'
import { logEvent, sanitize } from '../core/log.ts'
import {
  installedPackageDir,
  profileStateMatches,
  readInstalled,
  readInstalledVersion,
  readLockfile,
  readProfileManifestSnapshot,
  restoreLockfile,
  restoreProfileManifest,
} from '../core/profile.ts'
import type { ProfileManifestSnapshot } from '../core/profile.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { InstallResult, PendingRollback, PnpmProbe, Registry } from '../core/types.ts'
import type { Handler, HandlerContext, Router } from './router.ts'
import { installBlocked } from '../domain/agents.ts'
import {
  accelerateTarget,
  captureMutation,
  configureInstall,
  installConfigOf,
  installPlugin,
  registryEntryFor,
  runPackageMutation,
  type InstallConfig,
} from '../domain/install.ts'
import { progressTracker } from '../domain/progress.ts'
import { detectedDebugger, restartCapability, scheduleRestart, servingPort } from '../domain/restart.ts'
import { updateSpecFor } from '../domain/updates.ts'
import {
  configureSelfUninstall,
  GALAXY_PACKAGE_NAMES,
  selfUninstall,
} from '../domain/self-uninstall.ts'
import {
  configureSourceMigration,
  migrateSource,
  type PatchStateLike,
} from '../domain/source-migration.ts'

/* ------------------------------------------------------------------ *
 * Lazy sibling access
 * ------------------------------------------------------------------ */

/**
 * Resolve one sibling module at request time.
 *
 * The specifier is deliberately held in a variable: it keeps the module graph
 * acyclic and lets a missing or broken helper be reported as a per-endpoint
 * failure instead of an import-time SyntaxError that stops the host booting.
 * A truly absent module still throws, and the handler's `catch` turns that
 * into a sanitized 500 for that one request.
 */
async function siblingModule(name: string): Promise<Record<string, unknown>> {
  return await import(`../domain/${name}.ts`) as Record<string, unknown>
}

/** A typed read of one sibling export, or undefined when it is absent. */
function member<T>(module_: Record<string, unknown>, name: string): T | undefined {
  const value = module_[name]
  return typeof value === 'function' ? value as unknown as T : undefined
}

/** The theme manager's narrow surface, as `domain/themes.ts` publishes it. */
interface ThemeManagerLike {
  setEntryDisabled(name: string, disabled: boolean): Promise<boolean>
  activateTheme(name: string): Promise<boolean>
}

/** The sibling modules, resolved once per mount and cached on the runtime. */
interface Siblings {
  sources: Record<string, unknown>
  verify: Record<string, unknown>
  hot: Record<string, unknown>
  themes: Record<string, unknown>
  patch: Record<string, unknown>
  updates: Record<string, unknown>
  pnpm: Record<string, unknown>
  registry: Record<string, unknown>
  /** Catalog cached for the update-target lookup; refreshed on demand. */
  catalog?: Registry
}

/** Cache key holding the mount's resolved sibling surface. */
const SIBLINGS_CACHE_KEY = 'lifecycle.siblings'

/** Load the sibling modules once per mount and remember them on the runtime. */
async function siblings(runtime: GalaxyRuntime): Promise<Siblings> {
  const cached = runtime.cache<Siblings>(SIBLINGS_CACHE_KEY)
  if (cached !== undefined) return cached
  const [sources, verify, hot, themes, patch, updates, pnpm, registry, accelerate] = await Promise.all([
    siblingModule('sources'),
    siblingModule('verify'),
    siblingModule('hot'),
    siblingModule('themes'),
    siblingModule('patch'),
    siblingModule('updates'),
    siblingModule('pnpm-compat'),
    siblingModule('registry'),
    siblingModule('accelerate'),
  ])
  const loaded: Siblings = { sources, verify, hot, themes, patch, updates, pnpm, registry }
  runtime.setCache(SIBLINGS_CACHE_KEY, loaded)

  // Wire the injected helpers `domain/install.ts` orchestrates with. Every
  // adapter is a thin structural bridge: the sibling module keeps its own
  // signature, and a mount missing one simply loses that capability.
  const installTargetFor = member<(registry: Registry, url: string) => string | undefined>(sources, 'installTargetFor')
  const validateAdded = member<(...args: never[]) => unknown>(verify, 'validateAddedPlugins')
  const acceleratedTarget = member<NonNullable<InstallConfig['acceleratedTarget']>>(accelerate, 'acceleratedTarget')
  const parseIgnoredBuilds = member<NonNullable<InstallConfig['parseIgnoredBuilds']>>(pnpm, 'parseIgnoredBuilds')
  const hotMount = member<NonNullable<InstallConfig['hotMount']>>(hot, 'hotMount')
  const loadRegistry = member<NonNullable<InstallConfig['loadRegistry']>>(registry, 'loadRegistry')
  if (loadRegistry === undefined || installTargetFor === undefined || validateAdded === undefined) {
    logEvent('warn', 'lifecycle', 'the install helpers are not available on this host; install and update will refuse')
    return loaded
  }
  const config: InstallConfig = {
    loadRegistry,
    installTargetFor,
    // The registered signature is the runner-injected overload; the sibling
    // module declares it alongside a name-list form, so the call is made
    // through a precisely typed structural adapter.
    validateAddedPlugins: (runner, profile, before, dir) =>
      (validateAdded as unknown as NonNullable<InstallConfig['validateAddedPlugins']>)(runner, profile, before, dir),
    ...(acceleratedTarget === undefined ? {} : { acceleratedTarget }),
    ...(parseIgnoredBuilds === undefined ? {} : { parseIgnoredBuilds }),
    ...(hotMount === undefined ? {} : { hotMount }),
  }
  configureInstall(runtime, config)
  buildSourceMigrationConfig(runtime, patch)
  buildSelfUninstallConfig(runtime, patch)
  return loaded
}

/** Wire `domain/source-migration.ts` with the patch reader it needs. */
function buildSourceMigrationConfig(runtime: GalaxyRuntime, patch: Record<string, unknown>): void {
  const readUserPatchState = member<(profile: string, dir?: string) => PatchStateLike>(patch, 'readUserPatchState')
  if (readUserPatchState === undefined) return
  configureSourceMigration(runtime, {
    readUserPatchState: (profile, dir) => readUserPatchState(profile, dir),
  })
}

/** Wire `domain/self-uninstall.ts` with the patch helpers it needs. */
function buildSelfUninstallConfig(runtime: GalaxyRuntime, patch: Record<string, unknown>): void {
  const userPatchPath = member<(profile: string, dir?: string) => string>(patch, 'userPatchPath')
  const removeRowBlocks = member<(file: string, packageName: string) => boolean>(patch, 'removeRowBlocks')
  const readUserPatchState = member<(profile: string, dir?: string) => PatchStateLike>(patch, 'readUserPatchState')
  if (userPatchPath === undefined || removeRowBlocks === undefined || readUserPatchState === undefined) return
  configureSelfUninstall(runtime, {
    userPatchPath: (profile, dir) => userPatchPath(profile, dir),
    removeRowBlocks: (file, packageName) => removeRowBlocks(file, packageName),
    readUserPatchState: (profile, dir) => readUserPatchState(profile, dir),
  })
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Body cap for every lifecycle POST; the largest is an approve-builds list. */
const BODY_LIMIT = 64 * 1024

/** Cap on a reason string copied into a response payload. */
const REASON_LIMIT = 800

/** Read and parse the request body; answers 400 and returns undefined on garbage. */
async function readBody(context: HandlerContext): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readJsonBody(context.request, BODY_LIMIT)
    if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return raw as Record<string, unknown>
  } catch (error) {
    sendJson(context.response, 400, { error: `malformed request body: ${sanitize((error as Error).message)}` })
    return undefined
  }
}

/** Answer 409 with the agent identities that block this mutation. */
function agentGuard(context: HandlerContext): boolean {
  const busyAgents = installBlocked(context.runtime)
  if (busyAgents.length === 0) return true
  logEvent('warn', 'install-blocked', `refused while agents are running — ${busyAgents.join(', ')}`)
  sendJson(context.response, 409, {
    error: `${busyAgents.length === 1 ? 'An agent is running' : 'Agents are running'} (${busyAgents.join(', ')}). Plugin files cannot be changed while an agent is mid-turn; wait for it to finish or cancel it. / 有 agent 正在运行（${busyAgents.join(', ')}）。agent 运行期间不能修改插件文件，请等它完成或取消后再试。`,
    agentsBusy: true,
    runningAgents: busyAgents,
    busyAgents,
  })
  return false
}

/** One bounded, sanitized failure reason for a finished child run. */
function reasonOf(result: InstallResult): string {
  const structured = (result as { pnpmError?: unknown }).pnpmError
  const code = (result as { pnpmErrorCode?: unknown }).pnpmErrorCode
  if (typeof structured === 'string' && structured !== '') {
    const prefix = typeof code === 'string' && code !== '' ? `${code}: ` : ''
    return sanitize(`${prefix}${structured}`).slice(0, REASON_LIMIT)
  }
  const detail = sanitize(result.stderr.trim() || result.stdout.trim()).slice(-REASON_LIMIT)
  if (detail !== '') return detail
  return result.timedOut ? 'the plugin command timed out' : `the plugin command failed with exit code ${String(result.exitCode)}`
}

/** Whether a child run ended cleanly. */
function succeeded(result: InstallResult): boolean {
  return result.exitCode === 0 && result.timedOut !== true && result.cancelled !== true
}

/** Fingerprint of the profile state a rollback token was minted against. */
interface StateFingerprint {
  manifest: ProfileManifestSnapshot
  lockfile: string | null
}

/** Capture the current manifest + lockfile state for a staleness guard. */
function captureState(runtime: GalaxyRuntime): StateFingerprint | undefined {
  try {
    return {
      manifest: readProfileManifestSnapshot(runtime.config.profile, runtime.dir),
      lockfile: readLockfile(runtime.config.profile, runtime.dir),
    }
  } catch (error) {
    logEvent('warn', 'rollback', `profile state could not be captured: ${(error as Error).message}`)
    return undefined
  }
}

/** Whether the profile still matches a captured fingerprint. */
function stateMatches(runtime: GalaxyRuntime, expected: unknown): boolean {
  const previous = expected as StateFingerprint | undefined
  if (previous === undefined) return false
  const current = captureState(runtime)
  if (current === undefined) return false
  if (previous.lockfile !== current.lockfile) return false
  try {
    return profileStateMatches(runtime.config.profile, previous.manifest, runtime.dir)
  } catch {
    return false
  }
}

/**
 * Store one pending rollback and return its token.
 *
 * @param before - the state captured BEFORE the mutation. This is the restore
 *   payload, and `expectedState` is the fingerprint of the state right now
 *   (i.e. after the mutation), so the token is invalidated when anything else
 *   edits the profile later. Callers that mutate the profile must pass it:
 *   capturing here would store the post-operation state and turn the rollback
 *   into a no-op.
 */
function saveRollback(
  runtime: GalaxyRuntime,
  kind: PendingRollback['kind'],
  name: string,
  expectedSpec?: string,
  before?: StateFingerprint,
): string | undefined {
  const restore = before ?? captureState(runtime)
  if (restore === undefined) return undefined
  const current = captureState(runtime) ?? restore
  const token = `rollback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const record: PendingRollback = {
    token,
    kind,
    name,
    createdAt: Date.now(),
    manifest: restore.manifest,
    lockfile: restore.lockfile,
    ...(expectedSpec === undefined ? {} : { expectedSpec }),
    expectedState: JSON.stringify(current),
  }
  runtime.pendingRollbacks.set(token, record)
  return token
}

/** Log and answer a sanitized failure. */
function fail(
  context: HandlerContext,
  event: string,
  status: number,
  detail: string,
  extra: Record<string, unknown> = {},
): void {
  logEvent('error', event, detail)
  sendJson(context.response, status, { error: sanitize(detail).slice(0, REASON_LIMIT), ...extra })
}

/**
 * Run one mutating route under the install lock, turning
 * any escaped error into a sanitized 500 plus a log line.
 *
 * @param target - package the operation is about, for the `GET /status`
 *   progress snapshot; a long install is otherwise a silent wait.
 */
async function mutate(
  context: HandlerContext,
  event: string,
  target: string,
  task: () => Promise<void> | void,
): Promise<void> {
  // The tracker `GET /status` reads. It is fed with the child's
  // own output by the CLI runner, so a long install reports real movement
  // (`Progress: resolved …, reused …`) instead of a bare "busy".
  const tracker = progressTracker(context.runtime)
  tracker.start(target)
  tracker.phase(event)
  try {
    await context.runtime.locks.withLock('install', event, task)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    tracker.finish(message)
    fail(context, event, 500, message)
    return
  }
  // `finish` keeps the phase for display after the operation ends.
  tracker.phase('done')
  tracker.finish()
}

/** Register one POST route with the standard start/end logging envelope. */
function post(
  router: Router,
  path: string,
  event: string,
  options: { loopback?: boolean },
  handler: Handler,
): void {
  router.post(path, async (context) => {
    logEvent('info', event, `${path} requested from ${context.request.socket.remoteAddress ?? 'unknown'}`)
    try {
      await handler(context)
    } finally {
      logEvent('info', event, `${path} answered`)
    }
  }, options)
}

/* ------------------------------------------------------------------ *
 * Route group
 * ------------------------------------------------------------------ */

/**
 * Register every Group F endpoint.
 *
 * The registrar takes no host object. A previous version recovered one from the
 * router's host and read a `.ctx` property off it; on a real cordis Context that
 * property is *guarded* (cordis throws `cannot get property "ctx" without
 * inject`), the exception escaped into the host's effect wrapper, and every
 * route registered after this group — the v1 API and `GET /status` — silently
 * disappeared. Hot-mount capability does not need a context today
 * (`hot.ts` takes the runtime alone), so the parameter is gone rather than
 * threaded through unread.
 *
 * @param router - the mount's router (owns same-origin and 405 behaviour).
 * @param runtime - the mount's resolved configuration and shared state.
 */
export function registerLifecycleRoutes(router: Router, runtime: GalaxyRuntime): void {
  /** The sibling surface, resolved on first use and cached on the runtime. */
  const surface = async (): Promise<Siblings> => await siblings(runtime)

  /* --------------------------- install --------------------------- */

  post(router, '/dsh-galaxy/install', 'install', {}, async (context) => {
    const body = await readBody(context)
    if (body === undefined) return
    const url = stringField(body, 'url') ?? ''
    if (url === '') {
      sendJson(context.response, 400, { error: 'url is required' })
      return
    }
    // , checked BEFORE the lock so the answer is immediate.
    if (!agentGuard(context)) return
    await mutate(context, 'install', url, async () => {
      let siblings_: Siblings
      try {
        siblings_ = await surface()
      } catch (error) {
        fail(context, 'install', 500, `the galaxy catalog helpers are unavailable: ${(error as Error).message}`)
        return
      }
      if (installConfigOf(runtime) === undefined) {
        fail(context, 'install', 500, 'the galaxy install helpers are not registered for this mount')
        return
      }
      const before = captureState(runtime)
      const result = await installPlugin(runtime.config.profile, runtime.dir, url, runtime, {
        ...(siblings_.catalog === undefined ? {} : { registry: siblings_.catalog }),
      })
      if (!result.ok && !result.cancelled) {
        // A registry-bound refusal is the caller's error (400); a catalog that
        // could not be fetched is an outbound failure (502); anything else is
        // this server's (500).
        const status = result.code === 'not-in-registry' || result.code === 'unsupported-source'
          ? 400
          : result.code === 'catalog-unavailable' ? 502 : 500
        const token = result.added.length > 0
          ? saveRollback(runtime, 'install', result.name, undefined, before)
          : undefined
        logEvent('error', 'install', `${result.target} exit=${String(result.exitCode)} err=${result.reason ?? 'unknown'}`)
        sendJson(context.response, status, {
          ok: false,
          name: result.name,
          target: result.target,
          error: sanitize(result.reason ?? 'install failed').slice(0, REASON_LIMIT),
          warnings: result.warnings,
          ...(token === undefined ? {} : { rollbackToken: token }),
          ...(result.ignoredBuilds === undefined ? {} : { ignoredBuilds: result.ignoredBuilds }),
        })
        return
      }
      const token = result.ok && result.added.length > 0
        ? saveRollback(runtime, 'install', result.name, undefined, before)
        : undefined
      logEvent('info', 'install', `${result.target} ok=${String(result.ok)} hot=${String(result.hot)}`)
      sendJson(context.response, 200, {
        ok: result.ok,
        name: result.name,
        needsRestart: result.needsRestart,
        warnings: result.warnings,
        hot: result.hot,
        ...(result.ignoredBuilds === undefined ? {} : { ignoredBuilds: result.ignoredBuilds }),
        ...(result.risks === undefined ? {} : { risks: result.risks }),
        ...(token === undefined ? {} : { rollbackToken: token }),
        ...(result.cancelled ? { cancelled: true } : {}),
      })
    })
  })

  /* --------------------------- update --------------------------- */

  post(router, '/dsh-galaxy/update', 'update', {}, async (context) => {
    const body = await readBody(context)
    if (body === undefined) return
    const name = stringField(body, 'name') ?? ''
    const force = booleanField(body, 'force') === true
    const restore = booleanField(body, 'restore') === true
    if (name === '') {
      sendJson(context.response, 400, { error: 'name is required' })
      return
    }
    const installed = readInstalled(runtime.config.profile, runtime.dir)
    const spec = installed[name]
    if (spec === undefined) {
      sendJson(context.response, 404, { error: 'plugin is not installed' })
      return
    }
    const local = /^(?:link|file):/iu.test(spec)
    if (local && !restore) {
      sendJson(context.response, 400, {
        error: 'locally linked plugins update from their checkout; pass restore to replace one with its published release / 本地链接插件从它的检出目录更新；使用 restore 才能换回线上版本',
      })
      return
    }
    if (!agentGuard(context)) return
    await mutate(context, 'update', name, async () => {
      const siblings_ = await surface()
      const check = member<(profile: string, dir: string, options: { force?: boolean; names?: string[] }, runtime: GalaxyRuntime) => Promise<unknown>>(
        siblings_.updates,
        'checkUpdates',
      )
      if (check === undefined) {
        fail(context, 'update', 500, 'the galaxy update checker is unavailable for this mount')
        return
      }
      const statuses = await check(runtime.config.profile, runtime.dir, { force: true, names: [name] }, runtime)
      const status = pickStatus(statuses, name)
      if (status?.updateAvailable !== true) {
        // "Already there" is not a failure: the page's list is usually a
        // snapshot from before an earlier round of the same batch.
        sendJson(context.response, 200, {
          ok: true,
          name,
          skipped: 'current',
          needsRestart: false,
          ...(status?.latest === undefined ? {} : { version: status.latest }),
          ...(status?.reason === undefined ? {} : { reason: status.reason }),
        })
        return
      }
      const context_ = captureMutation(runtime.config.profile, runtime.dir, runtime)
      if (context_ === undefined) {
        fail(context, 'update', 500, 'the galaxy install helpers are not registered for this mount')
        return
      }
      // The version the checker reported is pinned into the target (see
      // updateSpecFor): `@latest` is re-resolved by pnpm against its own cached
      // metadata and silently no-ops when that cache is behind.
      const target = await updateTargetFor(siblings_, runtime, name, spec, restore, force, status?.latest)
      if (target === null) {
        sendJson(context.response, 400, {
          error: 'no update target could be resolved for this plugin / 无法为该插件解析更新目标',
        })
        return
      }
      const versionBefore = readInstalledVersion(runtime.config.profile, name, runtime.dir)
      const before = captureState(runtime)
      const result = await runPackageMutation(context_, target, name, runtime)
      if (!result.ok && !result.cancelled) {
        sendJson(context.response, result.exitCode === 1 ? 400 : 502, {
          ok: false,
          name,
          target,
          error: sanitize(result.reason ?? `update of ${name} failed`).slice(0, REASON_LIMIT),
          ...(result.ignoredBuilds === undefined ? {} : { ignoredBuilds: result.ignoredBuilds }),
          ...(result.risks === undefined ? {} : { risks: result.risks }),
        })
        return
      }
      const versionAfter = readInstalledVersion(runtime.config.profile, name, runtime.dir)
      const changed = versionBefore !== versionAfter
      const wanted = typeof status?.latest === 'string' && status.latest !== '' ? status.latest : undefined
      if (!changed) {
        // pnpm exited 0 without installing anything. Reporting success here is
        // what made a no-op look like an upgrade; say what actually happened.
        const nowCurrent = wanted === undefined || versionAfter === wanted
        logEvent('warn', 'update', `${name}: ${target} changed nothing (installed ${versionAfter ?? 'unknown'})`)
        sendJson(context.response, nowCurrent ? 200 : 502, {
          ok: nowCurrent,
          name,
          skipped: nowCurrent ? 'current' : 'unchanged',
          target,
          needsRestart: false,
          ...(versionAfter === undefined ? {} : { version: versionAfter }),
          ...(nowCurrent
            ? {}
            : {
                error: `the update did not take effect: the installed version is still ${versionAfter ?? 'unknown'}`
                  + `${wanted === undefined ? '' : ` while ${wanted} is available`}`
                  + ' — the package manager may be resolving from stale registry metadata; retry / '
                  + `更新未生效：安装版本仍为 ${versionAfter ?? 'unknown'}（可用 ${wanted ?? '未知'}），`
                  + '可能是包管理器使用了过期的 registry 元数据，请重试',
              }),
        })
        return
      }
      const token = saveRollback(runtime, 'update', name, spec, before)
      logEvent('info', 'update', `${name}: ${versionBefore ?? 'unknown'} -> ${versionAfter ?? 'unknown'} via ${target}`)
      sendJson(context.response, 200, {
        ok: result.ok,
        name: result.added[0]?.name ?? name,
        needsRestart: result.needsRestart,
        ...(versionBefore === undefined ? {} : { from: versionBefore }),
        ...(versionAfter === undefined ? {} : { to: versionAfter }),
        ...(token === undefined ? {} : { rollbackToken: token }),
        ...(result.cancelled ? { cancelled: true } : {}),
      })
    })
  })

  /* -------------------------- uninstall -------------------------- */

  post(router, '/dsh-galaxy/uninstall', 'uninstall', {}, async (context) => {
    const body = await readBody(context)
    if (body === undefined) return
    const name = stringField(body, 'name') ?? ''
    const force = booleanField(body, 'force') === true
    if (name === '') {
      sendJson(context.response, 400, { error: 'name is required' })
      return
    }
    if (GALAXY_PACKAGE_NAMES.includes(name)) {
      sendJson(context.response, 400, { error: 'use the self-uninstall endpoint to remove this plugin / 请使用自我卸载端点移除本插件' })
      return
    }
    if (readInstalled(runtime.config.profile, runtime.dir)[name] === undefined) {
      sendJson(context.response, 400, { error: 'plugin is not installed' })
      return
    }
    const siblings_ = await surface()
    // . Only the INDETERMINATE case (an unreadable layer) is
    // forceable; a readable layer that definitely names the package leaves the
    // user a concrete row to fix, and an override would only help them break
    // their next boot.
    const patchState = readPatchState(siblings_, runtime)
    if (patchState.unreadable === true && !force) {
      logEvent('warn', 'uninstall-blocked', `${name}: user cordis.patch.yml could not be inspected safely`)
      sendJson(context.response, 409, {
        error: `Cannot safely uninstall ${name}: this profile's cordis.patch.yml could not be read as a valid patch list, so a remaining reference cannot be ruled out. Check the patch file; force once you are sure it is unrelated. / 无法安全卸载 ${name}：cordis.patch.yml 无法读取，无法排除它仍被引用；确认无关后可强制卸载。`,
        userPatchInspectionFailed: true,
        forceable: true,
      })
      return
    }
    if (patchState.unreadable === true) {
      logEvent('warn', 'uninstall', `${name}: forced past an unreadable user cordis.patch.yml`)
    }
    const referenced = patchState.referenced ?? []
    if (referenced.includes(name)) {
      logEvent('warn', 'uninstall-blocked', `${name}: user cordis.patch.yml still inserts ${referenced.join(', ')}`)
      sendJson(context.response, 409, {
        error: `Cannot uninstall ${name}: this profile's cordis.patch.yml still inserts ${referenced.join(', ')}. Remove those user-owned patch references first. / 无法卸载 ${name}：cordis.patch.yml 仍通过 insert 引用 ${referenced.join(', ')}，请先移除这些用户补丁引用。`,
        userPatchReferenced: true,
        patchReferences: referenced,
      })
      return
    }
    if (!agentGuard(context)) return
    await mutate(context, 'uninstall', name, async () => {
      const result = await runtime.runner(runtime.config.profile, ['remove', name])
      const ok = succeeded(result)
      let reconciled = false
      if (!ok && !result.cancelled) {
        // Half-uninstall guard: pnpm can fail a remove AFTER deleting
        // node_modules but BEFORE saving package.json, leaving a manifest row
        // the next boot cannot resolve. Disk truth decides the repair.
        if (!existsSync(join(installedPackageDir(runtime.config.profile, name, runtime.dir), 'package.json'))) {
          reconciled = dropFromManifest(siblings_, runtime, name)
          logEvent('warn', 'uninstall', `${name}: remove failed but the package is gone from disk; reconciled=${String(reconciled)}`)
        }
      }
      let hot = false
      if (ok || reconciled) {
        hot = await teardownPackage(siblings_, runtime, name)
        removeRows(siblings_, runtime, name)
      }
      if (!ok && !reconciled && !result.cancelled) {
        logEvent('error', 'uninstall', `${name} exit=${String(result.exitCode)} err=${reasonOf(result)}`)
        sendJson(context.response, result.busy === true ? 409 : 502, {
          ok: false,
          name,
          error: sanitize(reasonOf(result)).slice(0, REASON_LIMIT),
          exitCode: result.exitCode,
        })
        return
      }
      logEvent('info', 'uninstall', `${name} ok=${String(ok)} hot=${String(hot)}${result.cancelled ? ' CANCELLED' : ''}`)
      sendJson(context.response, 200, {
        ok: true,
        name,
        // Removing a package cannot unload a plugin the RUNNING host already
        // mounted: the market list clears at once while the sidebar keeps its
        // entry until the process restarts. Saying so is the difference between
        // "needs a restart" and "the uninstall did nothing" — which is how it
        // was read before this field existed.
        ...(hot ? { hot: true } : { needsRestart: true }),
        ...(reconciled ? { reconciled: true } : {}),
        ...(result.cancelled ? { cancelled: true } : {}),
      })
    })
  })

  /* ------------------------ migrate-source ----------------------- */

  post(router, '/dsh-galaxy/migrate-source', 'migrate-source', {}, async (context) => {
    const body = await readBody(context)
    if (body === undefined) return
    const name = stringField(body, 'name') ?? ''
    if (name === '') {
      sendJson(context.response, 400, { error: 'name is required' })
      return
    }
    if (readInstalled(runtime.config.profile, runtime.dir)[name] === undefined) {
      sendJson(context.response, 400, { error: 'plugin is not installed' })
      return
    }
    if (!agentGuard(context)) return
    await mutate(context, 'migrate-source', name, async () => {
      const siblings_ = await surface()
      const patchState = readPatchState(siblings_, runtime)
      if (patchState.unreadable !== true && (patchState.referenced ?? []).includes(name)) {
        sendJson(context.response, 409, {
          error: `Cannot migrate ${name}: this profile's cordis.patch.yml still inserts it. / 无法迁移 ${name}：cordis.patch.yml 仍通过 insert 引用它。`,
          userPatchReferenced: true,
          patchReferences: patchState.referenced,
        })
        return
      }
      let catalog: Registry
      try {
        catalog = await catalogFor(siblings_, runtime)
      } catch (error) {
        fail(context, 'source-migration', 502, `the curated registry could not be loaded: ${(error as Error).message}`)
        return
      }
      const result = await migrateSource(
        runtime.config.profile,
        runtime.dir,
        name,
        runtime,
        catalog,
        patchState.unreadable === true,
      )
      if (!result.ok) {
        fail(context, 'source-migration', 500, result.reason ?? `migration of ${name} failed`, {
          ok: false,
          ...(result.removed === undefined ? {} : { removed: result.removed }),
          restored: result.restored,
        })
        return
      }
      sendJson(context.response, 200, {
        ok: true,
        from: { name: result.removed ?? name },
        to: { name: result.added ?? name, source: 'npm' },
        warnings: [],
      })
    })
  })

  /* --------------------------- rollback -------------------------- */

  post(router, '/dsh-galaxy/rollback', 'rollback', {}, async (context) => {
    const body = await readBody(context)
    if (body === undefined) return
    const id = stringField(body, 'rollbackId') ?? ''
    if (id === '') {
      sendJson(context.response, 400, { error: 'rollbackId is required' })
      return
    }
    await mutate(context, 'rollback', id, async () => {
      const pending = runtime.pendingRollbacks.get(id)
      if (pending === undefined) {
        sendJson(context.response, 409, {
          error: 'rollback is not available (it may have been superseded by another operation) / 回滚已不可用（可能已被后续操作覆盖）',
        })
        return
      }
      // The token captures whole-profile manifest and lock state. A terminal
      // pnpm/dsh command runs outside this route's mutation lock, so only a
      // state comparison can stop an old token from overwriting a newer
      // external edit.
      const expected = typeof pending.expectedState === 'string' ? safeParse(pending.expectedState) : undefined
      if (!stateMatches(runtime, expected)) {
        runtime.pendingRollbacks.delete(id)
        sendJson(context.response, 409, {
          error: 'rollback is not available because the profile changed after this operation / 操作后配置已发生变化，回滚不可用',
        })
        return
      }
      let ok = true
      let detail: string | undefined
      try {
        const manifest = pending.manifest as ProfileManifestSnapshot | undefined
        if (manifest !== undefined) restoreProfileManifest(runtime.config.profile, manifest, runtime.dir)
        restoreLockfile(runtime.config.profile, pending.lockfile ?? null, runtime.dir)
      } catch (error) {
        ok = false
        detail = (error as Error).message
      }
      if (ok && pending.name !== undefined && pending.kind === 'install') {
        // An install is undone by removing what it added; an update is undone
        // by the captured manifest/lockfile restore above, which already put
        // the previous source back.
        const removed = await runtime.runner(runtime.config.profile, ['remove', pending.name])
        ok = succeeded(removed)
        if (!ok) detail = reasonOf(removed)
      }
      if (!ok) {
        logEvent('error', 'rollback', `${pending.kind}: ${pending.name ?? '(unknown)'} failed — ${detail ?? 'unknown'}`)
        sendJson(context.response, 502, { ok: false, rolledBack: false, ...(detail === undefined ? {} : { detail: sanitize(detail) }) })
        return
      }
      runtime.pendingRollbacks.delete(id)
      logEvent('info', 'rollback', `${pending.kind}: ${pending.name ?? '(unknown)'} rolled back`)
      sendJson(context.response, 200, { ok: true, rolledBack: true })
    })
  })

  /* ------------------------ self-uninstall ----------------------- */

  post(router, '/dsh-galaxy/self-uninstall', 'self-uninstall', { loopback: true }, async (context) => {
    const body = await readBody(context)
    if (body === undefined) return
    const confirm = booleanField(body, 'confirm') === true
    const purge = booleanField(body, 'purge') === true
    // An explicit flag, not merely reaching the endpoint: this is the one route
    // whose accidental success cannot be undone from the UI that would have
    // undone it.
    if (!confirm) {
      sendJson(context.response, 400, { error: 'self-uninstall requires an explicit confirmation / 自我卸载需要显式确认' })
      return
    }
    if (!agentGuard(context)) return
    await mutate(context, 'self-uninstall', GALAXY_PACKAGE_NAMES[0], async () => {
      const result = await selfUninstall(runtime.config.profile, runtime.dir, runtime, { confirm, purge })
      if (!result.ok) {
        fail(context, 'self-uninstall', 502, result.reason ?? 'self-uninstall failed', { ok: false })
        return
      }
      sendJson(context.response, 200, {
        ok: true,
        ...(result.removed === undefined ? {} : { removed: result.removed }),
        purged: result.purged === true,
        ...(result.restored === undefined ? {} : { restored: result.restored }),
      })
    })
  })

  /* --------------------------- restart --------------------------- */

  post(router, '/dsh-galaxy/restart', 'restart', { loopback: true }, async (context) => {
    const capability = restartCapability(runtime.config, runtime)
    if (!capability.allowed) {
      sendJson(context.response, 403, {
        error: capability.reason ?? 'self-restart is not allowed for this host',
        restart: capability,
      })
      return
    }
    if (detectedDebugger() !== undefined) {
      sendJson(context.response, 403, {
        error: 'self-restart is disabled while the host is under a debugger / 宿主处于调试器下，已关闭自重启',
        restart: capability,
      })
      return
    }
    if (runtime.locks.isBusy()) {
      sendJson(context.response, 409, {
        error: `cannot restart while a plugin operation is running (${runtime.locks.busyReason() ?? 'unknown'}) / 有插件操作正在执行，无法重启`,
      })
      return
    }
    if (runtime.restartScheduled) {
      sendJson(context.response, 409, { error: 'restart already scheduled / 重启已调度' })
      return
    }
    const schedule = await scheduleRestart(runtime.config, runtime, servingPort(context.request))
    if (!schedule.scheduled) {
      sendJson(context.response, 409, { error: schedule.reason ?? 'restart could not be scheduled', restart: schedule })
      return
    }
    logEvent('info', 'restart', `helper=${String(schedule.helperPid)} boot=${schedule.boot ?? ''}`)
    sendJson(context.response, 200, schedule)
  })

  /* ------------------------ approve-builds ----------------------- */

  post(router, '/dsh-galaxy/approve-builds', 'approve-builds', {}, async (context) => {
    const body = await readBody(context)
    if (body === undefined) return
    const requested = (stringArrayField(body, 'packages') ?? []).map(stripVersion).filter(name => name !== '')
    // Only packages PHYSICALLY present in the profile's installed tree may be
    // approved: pnpm's blocked build scripts are usually TRANSITIVE
    // dependencies, which never appear in package.json.
    const present = requested.filter(name =>
      existsSync(join(installedPackageDir(runtime.config.profile, name, runtime.dir), 'package.json')))
    if (present.length === 0) {
      sendJson(context.response, 400, { error: 'no installed packages given / 没有给出已安装的包' })
      return
    }
    await mutate(context, 'approve-builds', 'build-scripts', async () => {
      const siblings_ = await surface()
      const setAllowBuilds = member<(profile: string, packages: string[], dir?: string) => string[]>(
        siblings_.pnpm,
        'setAllowBuilds',
      )
      if (setAllowBuilds === undefined) {
        fail(context, 'approve-builds', 500, 'the pnpm compatibility helper is unavailable for this mount')
        return
      }
      const approved = setAllowBuilds(runtime.config.profile, present, runtime.dir)
      logEvent('info', 'approve-builds', `allowed build scripts: ${approved.join(', ')}`)
      sendJson(context.response, 200, { ok: true, approved })
    })
  })

  /* ---------------------------- cancel --------------------------- */

  post(router, '/dsh-galaxy/cancel', 'cancel', {}, async (context) => {
    const active = runtime.activeProcess
    if (active === null) {
      sendJson(context.response, 404, { error: 'no operation is running' })
      return
    }
    try {
      active.cancel()
    } catch (error) {
      fail(context, 'cancel', 500, `cancel failed: ${(error as Error).message}`)
      return
    }
    logEvent('info', 'cancel', 'cancelled the running plugin operation')
    sendJson(context.response, 200, { ok: true, cancelled: true })
  })

  /* -------------------------- setup-pnpm ------------------------- */

  post(router, '/dsh-galaxy/setup-pnpm', 'setup-pnpm', {}, async (context) => {
    let siblings_: Siblings
    try {
      siblings_ = await surface()
    } catch (error) {
      fail(context, 'setup-pnpm', 500, `the pnpm helper is unavailable: ${(error as Error).message}`)
      return
    }
    const provisionPnpm = member<(profile: string, config: unknown) => Promise<{ ok: boolean; path?: string; version?: string; hint?: string }>>(
      siblings_.pnpm,
      'provisionPnpm',
    )
    const probePnpm = member<(profile: string, config: unknown) => Promise<{ ok: boolean; path?: string; version?: string }>>(
      siblings_.pnpm,
      'probePnpm',
    )
    try {
      const provisioned = provisionPnpm === undefined ? undefined : await provisionPnpm(runtime.config.profile, runtime.config)
      if (provisioned?.ok === true) {
        const probe: PnpmProbe = {
          ok: true,
          provisioned: true,
          ...(provisioned.path === undefined ? {} : { path: provisioned.path }),
          ...(provisioned.version === undefined ? {} : { version: provisioned.version }),
        }
        logEvent('info', 'setup-pnpm', 'pnpm was provisioned by the galaxy')
        sendJson(context.response, 200, probe)
        return
      }
      const checked = probePnpm === undefined ? undefined : await probePnpm(runtime.config.profile, runtime.config)
      const probe: PnpmProbe = {
        ok: checked?.ok === true,
        provisioned: false,
        ...(checked?.path === undefined ? {} : { path: checked.path }),
        ...(checked?.version === undefined ? {} : { version: checked.version }),
        ...(checked?.ok === true ? {} : { hint: provisioned?.hint ?? PNPM_UNAVAILABLE_HINT }),
      }
      logEvent(probe.ok ? 'info' : 'warn', 'setup-pnpm', `ok=${String(probe.ok)}`)
      sendJson(context.response, 200, probe)
    } catch (error) {
      fail(context, 'setup-pnpm', 500, `pnpm provisioning failed: ${(error as Error).message}`)
    }
  })
}

/* ------------------------------------------------------------------ *
 * Route-level helpers
 * ------------------------------------------------------------------ */

/** Hint shown when pnpm cannot be provisioned and no sibling supplies one. */
const PNPM_UNAVAILABLE_HINT
  = 'pnpm 没能准备好。请在终端执行 `pnpm --version` 确认；macOS/Linux 可用 `brew install pnpm`，Windows 可用 `iwr https://get.pnpm.io/install.ps1 -useb | iex`，装完后重启 dsh'
  + ' / pnpm could not be provisioned. Run `pnpm --version` in a terminal; `brew install pnpm` (macOS/Linux) or `iwr https://get.pnpm.io/install.ps1 -useb | iex` (Windows) installs one — restart dsh afterwards.'

/** JSON.parse that answers undefined instead of throwing. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** `name@1.2.3` → `name`; scoped names keep their slash. */
function stripVersion(name: string): string {
  const trimmed = name.trim()
  const at = trimmed.lastIndexOf('@')
  return at > 0 ? trimmed.slice(0, at) : trimmed
}

/** Normalize whatever `checkUpdates` returns into a per-name lookup. */
function pickStatus(
  statuses: unknown,
  name: string,
): { updateAvailable?: boolean; latest?: string; current?: string; reason?: string } | undefined {
  if (Array.isArray(statuses)) {
    return statuses.find(entry => (entry as { name?: unknown }).name === name) as
      | { updateAvailable?: boolean; latest?: string; current?: string; reason?: string }
      | undefined
  }
  if (statuses !== null && typeof statuses === 'object') {
    const record = statuses as Record<string, { updateAvailable?: boolean; latest?: string; current?: string; reason?: string }>
    return record[name]
  }
  return undefined
}

/**
 * The pnpm target an update should install.
 *
 * Resolution order mirrors the reference implementation's hard-won rules:
 *
 *  - a `restore` of a locally linked plugin is re-pointed at the catalog's
 *    published target — the only way a `link:` install can move online;
 *  - a GitHub source stays a GitHub source, because resolving it by NAME would
 *    install an unrelated npm package that happens to share the plugin's name;
 *  - the market follows its own release channel, everything else `latest`;
 *  - a git remote that is not GitHub keeps its remote URL untouched.
 *
 * @returns the target, or null when nothing can be resolved.
 */
async function updateTargetFor(
  siblings_: Siblings,
  runtime: GalaxyRuntime,
  name: string,
  spec: string,
  restore: boolean,
  force: boolean,
  latest?: string,
): Promise<string | null> {
  void force
  const config = installConfigOf(runtime)
  const local = /^(?:link|file):/iu.test(spec)
  if (restore || local) {
    if (config === undefined) return null
    let catalog: Registry
    try {
      catalog = await catalogFor(siblings_, runtime)
    } catch (error) {
      logEvent('warn', 'update', `${name}: catalog lookup failed — ${(error as Error).message}`)
      return null
    }
    const entry = registryEntryFor(catalog, name) ?? catalog.plugins.find(plugin => plugin.url === spec)
    if (entry === undefined) return null
    const target = config.installTargetFor(catalog, entry.url ?? '')
    return target === undefined || target === '' ? null : await accelerateTarget(config, target, name)
  }
  // A GitHub spec is re-added as a GitHub target: re-resolving it by name is
  // what installed an unrelated npm package that shared the plugin's name.
  if (/^github:/iu.test(spec) || /github\.com/iu.test(spec)) {
    return spec
  }
  if (/^(?:git\+|git:|ssh:)/iu.test(spec) || (/^https?:/iu.test(spec) && !/npmjs/iu.test(spec))) {
    // A non-GitHub git remote (Gitea, a private host) keeps its URL.
    return spec
  }
  // Plain npm ranges (and anything else) go through the shared helper, which
  // pins the version the checker reported instead of trusting `@latest`.
  return updateSpecFor(name, spec, latest)
}

/** Read the catalog, reusing the one cached on this mount when possible. */
async function catalogFor(siblings_: Siblings, runtime: GalaxyRuntime): Promise<Registry> {
  const cached = siblings_.catalog
  if (cached !== undefined && cached.plugins.length > 0) return cached
  const load = member<NonNullable<InstallConfig['loadRegistry']>>(siblings_.registry, 'loadRegistry')
  if (load === undefined) throw new Error('the catalog loader is unavailable for this mount')
  const catalog = await load(runtime.config.profile, runtime.dir, false, runtime)
  siblings_.catalog = catalog
  return catalog
}

/** Read the user patch layer through the sibling module, never throwing. */
function readPatchState(siblings_: Siblings, runtime: GalaxyRuntime): PatchStateLike {
  const read = member<(profile: string, dir?: string) => PatchStateLike>(siblings_.patch, 'readUserPatchState')
  if (read === undefined) return { exists: false, referenced: [], unreadable: false }
  try {
    return read(runtime.config.profile, runtime.dir)
  } catch (error) {
    logEvent('warn', 'patch', `the user patch layer could not be read — ${(error as Error).message}`)
    return { exists: true, referenced: [], unreadable: true }
  }
}

/**
 * Drop every user patch row that belongs to one package.
 *
 * `domain/patch.ts` owns the file format, so this asks it to remove the rows by
 * package name rather than reconstructing row ids here — a row id is an
 * implementation detail of that module's parser.
 */
function removeRows(siblings_: Siblings, runtime: GalaxyRuntime, name: string): void {
  const write = member<(file: string, name: string) => boolean>(siblings_.patch, 'removeRowBlocks')
  const resolvePath = member<(profile: string, dir?: string) => string>(siblings_.patch, 'userPatchPath')
  if (write === undefined || resolvePath === undefined) return
  try {
    write(resolvePath(runtime.config.profile, runtime.dir), name)
  } catch (error) {
    logEvent('warn', 'patch', `${name}: patch rows could not be removed — ${(error as Error).message}`)
  }
}

/**
 * Hot-unmount a package and disable its loader entry.
 *
 * Both run unconditionally: a package that is BOTH hot-mounted and reachable
 * through the bundle layer would otherwise get half its cleanup, and the
 * surviving half is exactly the 404-on-refresh wedge that leaves the whole
 * settings page unusable. A package that was never hot-mounted costs one
 * lookup.
 */
async function teardownPackage(siblings_: Siblings, runtime: GalaxyRuntime, name: string): Promise<boolean> {
  let hot = false
  const unmount = member<(runtime: GalaxyRuntime, profile: string, name: string) => boolean>(siblings_.hot, 'hotUnmount')
  if (unmount !== undefined) {
    try {
      hot = unmount(runtime, runtime.config.profile, name)
    } catch (error) {
      logEvent('warn', 'hot-unmount', `${name}: ${(error as Error).message}`)
    }
  }
  // Both cleanups run: a package reachable through the bundle layer as well as
  // a hot mount would otherwise keep its live loader entry after its files are
  // gone, which is the 404-on-refresh wedge.
  const disable = member<(profile: string, dir: string, name: string, disabled: boolean) => boolean>(
    siblings_.themes,
    'setEntryDisabled',
  )
  if (disable !== undefined) {
    try {
      hot = disable(runtime.config.profile, runtime.dir, name, true) || hot
    } catch (error) {
      logEvent('warn', 'toggle', `${name}: entry update failed — ${(error as Error).message}`)
    }
  }
  runtime.hotMounts.delete(name)
  return hot
}

/**
 * Reconcile the manifest from disk truth after a half-completed remove.
 *
 * The profile manifest belongs to the host, so this goes through the core
 * writer rather than a sibling module: a package that is gone from disk must
 * not keep its dependency row, or the next boot fails to activate a ghost.
 *
 * @returns true when a row was actually dropped.
 */
function dropFromManifest(siblings_: Siblings, runtime: GalaxyRuntime, name: string): boolean {
  void siblings_
  try {
    const manifest = readProfileManifestSnapshot(runtime.config.profile, runtime.dir)
    if (manifest.dependencies[name] === undefined) return false
    delete manifest.dependencies[name]
    restoreProfileManifest(runtime.config.profile, manifest, runtime.dir)
    return true
  } catch (error) {
    logEvent('warn', 'uninstall', `${name}: manifest reconciliation failed — ${(error as Error).message}`)
    return false
  }
}
