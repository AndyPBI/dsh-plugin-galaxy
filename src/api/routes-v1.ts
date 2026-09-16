/**
 * Plugin Galaxy — HTTP surface of the public update API v1.
 *
 *   COMMON-trust-guard.
 *
 * `registerV1Routes` registers exactly the six `/dsh-galaxy/api/v1` paths that
 * the implementation contract (section 4, group G) assigns to this module:
 *
 *   GET  /dsh-galaxy/api/v1/capabilities   capability document (public, read-only)
 *   GET  /dsh-galaxy/api/v1/updates        update status of one installed package
 *   POST /dsh-galaxy/api/v1/updates        start an update operation (same-origin)
 *   GET  /dsh-galaxy/api/v1/operations     one operation or the whole store
 *   POST /dsh-galaxy/api/v1/rollback       undo the recovery point of an operation
 *   POST /dsh-galaxy/api/v1/restart        ask the host to relaunch (loopback + same-origin)
 *   POST /dsh-galaxy/api/v1/cancelling     cancel an operation and its child process
 *
 * CONTRACT STABILITY — `beta`
 *   The shapes documented here may still change between releases, which is why
 *   the capability document reports `"stability": "beta"`. Nothing is going
 *   away; new *optional* response fields may be added within v1, existing v1
 *   fields are not repurposed, and a breaking change moves to a new path and
 *   schema version. Clients must discover the API through
 *   `GET /dsh-galaxy/api/v1/capabilities` before enabling mutation controls.
 *
 * TRUST
 *   Every mutating v1 route is same-origin (the router enforces it for
 *   `router.post`, and the combined `GET|POST /updates` route enforces it for
 *   its POST half explicitly). `/restart` additionally requires a direct
 *   loopback peer with no forwarding header, because it controls the host
 *   process. `/capabilities`, `GET /updates` and `GET /operations` are read-only
 *   and carry no trust requirement.
 *
 * DELEGATION
 *   The actual package mutation is never re-implemented here: an update is
 *   driven through `installPlugin` from `src/domain/install.ts` (group F),
 *   which is the same orchestration the lifecycle route uses. That module is
 *   resolved at request time so a partially built distribution answers 501
 *   with an explicit message instead of reporting a success that never
 *   happened; `install.ts` itself follows the same rule towards its siblings.
 *   Rollback needs no such helper: it consumes the shared recovery point in
 *   `runtime.pendingRollbacks` and restores it through the core profile DAO
 *   (the same `restoreProfileManifest`/`restoreLockfile` pair the lifecycle
 *   route's private rollback handler uses), so it works for a token minted by
 *   either route.
 *
 * LIMITATIONS (v1, beta)
 *   - The update driver is `installPlugin`, so the package must be authorized
 * by the curated catalog: a package that is installed
 *     but absent from the catalog ends as a failed operation carrying that
 *     explicit reason, never as a silent success.
 *   - `force` is part of the published contract (opt one operation out of the
 *     registry release-age wait). The lifecycle helper exposes no such knob
 *     today, so the flag is accepted, logged and recorded in the operation's
 *     progress instead of being silently honoured.
 *   - A recovery point is only minted for an update this route drove itself,
 *     and only while the profile still matches the state that update produced.
 */

import { booleanField, boolParam, readJsonBody, sameOrigin, sendJson, stringField } from '../core/http.ts'
import { logEvent } from '../core/log.ts'
import {
  isInstalled,
  profileStateMatches,
  readInstalledVersion,
  readLockfile,
  readProfileManifestSnapshot,
  restoreLockfile,
  restoreProfileManifest,
} from '../core/profile.ts'
import type { ProfileManifestSnapshot } from '../core/profile.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { OperationState, PendingRollback, Progress } from '../core/types.ts'
import type { InstallPluginOptions, InstallPluginResult } from '../domain/install.ts'
import { restartCapability, scheduleRestart } from '../domain/restart.ts'
import { checkUpdates } from '../domain/updates.ts'
import {
  UPDATE_API_V1_SCHEMA,
  capabilitiesV1,
  isValidPackageName,
  updatePayloadFor,
} from '../domain/update-api-v1.ts'
import { V1_PATH } from './host.ts'
import type { HandlerContext, Router } from './router.ts'

/* ------------------------------------------------------------------ *
 * Paths advertised by the capability document
 * ------------------------------------------------------------------ */

const CAPABILITIES_ENDPOINT = `${V1_PATH}/capabilities`
const UPDATES_ENDPOINT = `${V1_PATH}/updates`
const OPERATIONS_ENDPOINT = `${V1_PATH}/operations`
const ROLLBACK_ENDPOINT = `${V1_PATH}/rollback`
const RESTART_ENDPOINT = `${V1_PATH}/restart`
const CANCELLING_ENDPOINT = `${V1_PATH}/cancelling`

/** Every path this module registers, in capability-document order. */
export const V1_ENDPOINTS: readonly string[] = [
  CAPABILITIES_ENDPOINT,
  UPDATES_ENDPOINT,
  OPERATIONS_ENDPOINT,
  ROLLBACK_ENDPOINT,
  RESTART_ENDPOINT,
  CANCELLING_ENDPOINT,
]

/* ------------------------------------------------------------------ *
 * Lifecycle adapter (group F, `domain/install.ts`)
 * ------------------------------------------------------------------ */

/**
 * `domain/install.ts` deliberately reaches its siblings through an injected
 * config rather than named imports, because a named import that a later host
 * release deleted is a SyntaxError at module evaluation — the whole host dies
 * instead of one route failing. The v1 API applies the same rule to the
 * lifecycle module itself: the types below are the compile-time contract,
 * while the implementation is resolved per request so an incomplete
 * distribution answers 501 instead of failing to load.
 *
 * Both spellings are probed: a source run (tsx, Node type-stripping, vitest)
 * resolves `install.ts`, while the compiled `lib/` output only contains
 * `install.js`.
 */
const LIFECYCLE_MODULE_SPECIFIERS: readonly string[] = ['../domain/install.ts', '../domain/install.js']

/** Exact shape of `installPlugin` in `domain/install.ts` (group F). */
type InstallPluginFunction = (
  profile: string,
  dir: string,
  source: string,
  runtime: GalaxyRuntime,
  options?: InstallPluginOptions,
) => Promise<InstallPluginResult>

/**
 * Export names probed for the install/update helper. `installPlugin` is the
 * verified name; the rest are accepted so a future dedicated update helper
 * with the same positional convention is picked up without a change here.
 */
const INSTALL_HELPER_NAMES: readonly string[] = [
  'installPlugin',
  'updatePlugin',
  'updateInstalledPlugin',
  'runPluginUpdate',
]

/** Human-readable message for an unknown thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Load the optional lifecycle module, or `undefined` when it is absent. */
async function loadLifecycleModule(): Promise<Record<string, unknown> | undefined> {
  for (const specifier of LIFECYCLE_MODULE_SPECIFIERS) {
    try {
      return (await import(specifier)) as Record<string, unknown>
    } catch (error) {
      logEvent('warn', 'update-api-v1', `lifecycle module ${specifier} unavailable: ${errorText(error)}`)
    }
  }
  return undefined
}

/** First exported function of `names`, or `undefined`. */
function functionNamed<T>(module: Record<string, unknown>, names: readonly string[]): T | undefined {
  for (const name of names) {
    const candidate = module[name]
    if (typeof candidate === 'function') return candidate as unknown as T
  }
  logEvent('warn', 'update-api-v1', `lifecycle module exports none of: ${names.join(', ')}`)
  return undefined
}

/** Resolve `installPlugin`, or an update helper of the same shape. */
async function resolveInstallPlugin(): Promise<InstallPluginFunction | undefined> {
  const module = await loadLifecycleModule()
  return module === undefined ? undefined : functionNamed<InstallPluginFunction>(module, INSTALL_HELPER_NAMES)
}

/* ------------------------------------------------------------------ *
 * Recovery points
 * ------------------------------------------------------------------ */

/**
 * The profile state a rollback token is minted against: the manifest fields
 * the host rewrites plus the lockfile. Mirrors the fingerprint the lifecycle
 * route stores, so either route can consume either token.
 */
interface ProfileFingerprintV1 {
  manifest: ProfileManifestSnapshot
  lockfile: string | null
}

/** Capture the manifest + lockfile state, or `undefined` when unreadable. */
function captureFingerprintV1(profile: string, dir: string): ProfileFingerprintV1 | undefined {
  try {
    return {
      manifest: readProfileManifestSnapshot(profile, dir),
      lockfile: readLockfile(profile, dir),
    }
  } catch (error) {
    logEvent('warn', 'update-api-v1', `profile state could not be captured: ${errorText(error)}`)
    return undefined
  }
}

/** Parse a stored fingerprint string without throwing. */
function parseFingerprint(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Whether the profile still matches a fingerprint captured earlier. */
function fingerprintMatches(profile: string, dir: string, expected: unknown): boolean {
  const previous = expected as Partial<ProfileFingerprintV1> | undefined
  if (previous === undefined || previous.manifest === undefined) return false
  const current = captureFingerprintV1(profile, dir)
  if (current === undefined) return false
  if (previous.lockfile !== current.lockfile) return false
  try {
    return profileStateMatches(profile, previous.manifest, dir)
  } catch {
    return false
  }
}

/** Structural check that an unknown value is a captured manifest snapshot. */
function asManifestSnapshot(value: unknown): ProfileManifestSnapshot | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const dependencies = record.dependencies
  if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) return undefined
  const bundles = record.profileBundles
  if (typeof bundles !== 'object' || bundles === null || Array.isArray(bundles)) return undefined
  if (typeof (bundles as Record<string, unknown>).present !== 'boolean') return undefined
  return value as ProfileManifestSnapshot
}

/** Outcome of one attempt to consume a v1 recovery point. */
interface RollbackAttempt {
  ok: boolean
  /** True when the recovery point can never be used again (spent or stale). */
  discard: boolean
  error?: string
}

/**
 * Mint the recovery point of one successful v1 update.
 *
 * Unlike the lifecycle route's token — which fingerprints the state left
 * behind and therefore restores what the update already produced — this record
 * keeps the manifest and lockfile from BEFORE the run, so consuming it really
 * undoes the update, and fingerprints the state the run produced, so an edit
 * made after the update refuses the rollback instead of overwriting it. The
 * token spelling (`rollback-<t36>-<rand>`) and the record shape are the
 * lifecycle route's, so either consumer accepts either token.
 */
function registerRecoveryPoint(
  runtime: GalaxyRuntime,
  operationId: string,
  packageName: string,
  before: ProfileFingerprintV1 | undefined,
): void {
  if (before === undefined) return
  const after = captureFingerprintV1(runtime.config.profile, runtime.dir)
  if (after === undefined) return
  const spec = before.manifest.dependencies[packageName]
  const token = `rollback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const record: PendingRollback = {
    token,
    kind: 'update',
    name: packageName,
    createdAt: Date.now(),
    manifest: before.manifest,
    lockfile: before.lockfile,
    ...(spec === undefined ? {} : { expectedSpec: spec }),
    expectedState: JSON.stringify(after),
  }
  runtime.pendingRollbacks.set(token, record)
  runtime.operations.update(operationId, { rollbackToken: token })
}

/** Outcome of one delegated lifecycle call, normalised for the public store. */
interface LifecycleOutcome {
  ok: boolean
  cancelled: boolean
  error?: string
  rollbackToken?: string
  /** Short human notes (restart owed, live mount, …) for `progress.detail`. */
  notes: string[]
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Interpret the result of `installPlugin`. A non-zero exit
 * is a normal outcome for that helper, never a throw, so every documented field
 * is mapped explicitly; an unrecognised but error-free result counts as success.
 */
function installOutcome(result: unknown): LifecycleOutcome {
  if (result === undefined || result === null || typeof result !== 'object') {
    return { ok: true, cancelled: false, notes: [] }
  }
  const record = result as Record<string, unknown>
  const cancelled = record.cancelled === true
  const error = textOf(record.reason) ?? textOf(record.error)
  let ok = record.ok !== false
  if (cancelled || record.timedOut === true) ok = false
  if (typeof record.exitCode === 'number' && record.exitCode !== 0) ok = false
  if (error !== undefined) ok = false
  const notes: string[] = []
  if (record.needsRestart === true) notes.push('restart required')
  if (record.hot === true) notes.push('live in this process')
  const added = Array.isArray(record.added) ? record.added : []
  if (added.length > 0) notes.push(`added ${String(added.length)} package(s)`)
  const rollbackToken = textOf(record.rollbackToken) ?? textOf(record.rollbackId)
  return {
    ok,
    cancelled,
    notes,
    ...(error === undefined ? {} : { error }),
    ...(rollbackToken === undefined ? {} : { rollbackToken }),
  }
}

/** Merge one progress patch into the live operation, unless it was cancelled. */
function applyProgress(runtime: GalaxyRuntime, operationId: string, patch: Partial<Progress>): void {
  const current = runtime.operations.get(operationId)
  if (current === undefined || current.state === 'cancelled') return
  runtime.operations.update(operationId, { progress: { ...current.progress, ...patch, active: true } })
}

/** Write the terminal state, final progress and recovery token of an operation. */
function finishOperation(
  runtime: GalaxyRuntime,
  operationId: string,
  packageName: string,
  outcome: LifecycleOutcome,
  before: string | undefined,
  after: string | undefined,
): void {
  const current = runtime.operations.get(operationId)
  if (current === undefined) return
  const cancelled = current.state === 'cancelled' || outcome.cancelled
  const state: OperationState = cancelled ? 'cancelled' : outcome.ok ? 'done' : 'failed'
  const error = cancelled
    ? undefined
    : outcome.error ?? (outcome.ok ? undefined : 'the update operation did not complete')
  const versionLine = after === undefined
    ? packageName
    : `${packageName} ${before ?? '?'} → ${after}`
  runtime.operations.update(operationId, {
    state,
    progress: {
      ...current.progress,
      active: false,
      phase: state,
      target: packageName,
      currentPackage: packageName,
      detail: [versionLine, ...outcome.notes].join(' · '),
      ...(error === undefined ? {} : { error }),
      ...(cancelled ? { cancelling: true } : {}),
    },
    ...(outcome.rollbackToken === undefined ? {} : { rollbackToken: outcome.rollbackToken }),
    ...(error === undefined ? {} : { error }),
  })
  logEvent(
    outcome.ok || cancelled ? 'info' : 'warn',
    'update-api-v1',
    `operation ${operationId}: ${state}${error === undefined ? '' : ` — ${error}`}`,
  )
}

/**
 * Run one update through `installPlugin` under the `install` lock, mirroring
 * the mutation-lock rule of the contract: package-manager work serializes with
 * every other install-shaped mutation, and the HTTP answer is the 202 sent
 * before this starts.
 */
async function driveUpdateOperation(
  runtime: GalaxyRuntime,
  operationId: string,
  packageName: string,
  force: boolean,
  helper: InstallPluginFunction,
): Promise<void> {
  const profile = runtime.config.profile
  const dir = runtime.dir
  const before = readInstalledVersion(profile, packageName, dir)
  // The recovery point is captured BEFORE the child runs; it is what a later
  // `POST /rollback` restores.
  const recoveryPoint = captureFingerprintV1(profile, dir)
  runtime.operations.update(operationId, {
    state: 'running',
    progress: {
      active: true,
      phase: 'snapshot',
      target: packageName,
      currentPackage: packageName,
      detail: `${force ? 'forced ' : ''}update of ${packageName}`,
    },
  })
  logEvent('info', 'update-api-v1', `operation ${operationId}: updating ${packageName}${force ? ' (force)' : ''}`)
  let after = before
  let outcome: LifecycleOutcome
  try {
    const result = await runtime.locks.withLock('install', `v1 update ${packageName}`, () => helper(
      profile,
      dir,
      packageName,
      runtime,
      {
        // The helper's four phases (snapshot, install, verify, activate) are
        // the public progress cursor; the store hides everything else.
        onPhase: (phase: string) => applyProgress(runtime, operationId, { phase }),
      },
    ))
    after = readInstalledVersion(profile, packageName, dir)
    outcome = installOutcome(result)
  } catch (error) {
    outcome = { ok: false, cancelled: false, notes: [], error: errorText(error) }
  }
  if (outcome.ok && !outcome.cancelled && outcome.rollbackToken === undefined) {
    registerRecoveryPoint(runtime, operationId, packageName, recoveryPoint)
  }
  finishOperation(runtime, operationId, packageName, outcome, before, after)
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

/** GET|POST /dsh-galaxy/api/v1/updates —. */
async function handleUpdatesV1({ request, response, url, runtime }: HandlerContext): Promise<void> {
  const profile = runtime.config.profile
  const dir = runtime.dir

  if (request.method === 'GET') {
    const name = (url.searchParams.get('name') ?? '').trim()
    if (!isValidPackageName(name)) {
      sendJson(response, 400, { schema: UPDATE_API_V1_SCHEMA, error: 'a valid package name is required' })
      return
    }
    if (!isInstalled(profile, name, dir)) {
      sendJson(response, 404, { schema: UPDATE_API_V1_SCHEMA, error: 'plugin is not installed' })
      return
    }
    try {
      const force = boolParam(url, 'force')
      const statuses = await checkUpdates(profile, dir, { force, names: [name] }, runtime)
      const status = statuses.find(entry => entry.name === name)
      if (status === undefined) {
        sendJson(response, 404, { schema: UPDATE_API_V1_SCHEMA, error: 'plugin is not installed' })
        return
      }
      sendJson(response, 200, updatePayloadFor(status))
    } catch (error) {
      sendJson(response, 500, { schema: UPDATE_API_V1_SCHEMA, error: errorText(error) })
    }
    return
  }

  // POST — a mutation, so the origin guard that `router.post` applies to the
  // other v1 routes has to be applied by hand here (this route also serves GET).
  if (!sameOrigin(request)) {
    sendJson(response, 403, { schema: UPDATE_API_V1_SCHEMA, error: 'untrusted origin' })
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(request)
  } catch (error) {
    sendJson(response, 400, { schema: UPDATE_API_V1_SCHEMA, error: errorText(error) })
    return
  }
  const packageName = stringField(body, 'packageName') ?? ''
  const force = booleanField(body, 'force') === true
  if (!isValidPackageName(packageName)) {
    sendJson(response, 400, { schema: UPDATE_API_V1_SCHEMA, error: 'a valid package name is required' })
    return
  }
  // OPERATION_BUSY: the public store allows one live operation, and the
  // mutation locks cover the galaxy's own legacy mutations at the same time.
  if (runtime.operations.hasActive() || runtime.locks.isBusy()) {
    sendJson(response, 409, {
      schema: UPDATE_API_V1_SCHEMA,
      error: 'another update operation is already running',
      failure: {
        code: 'OPERATION_BUSY',
        message: 'another update operation is already running',
        retryable: true,
      },
    })
    return
  }
  if (!isInstalled(profile, packageName, dir)) {
    sendJson(response, 404, {
      schema: UPDATE_API_V1_SCHEMA,
      error: 'plugin is not installed',
      failure: {
        code: 'PLUGIN_NOT_INSTALLED',
        message: 'plugin is not installed in this profile',
        retryable: false,
      },
    })
    return
  }
  // Resolve the lifecycle helper BEFORE allocating an operation, so a 501
  // leaves the store exactly as it was.
  const helper = await resolveInstallPlugin()
  if (helper === undefined) {
    sendJson(response, 501, {
      schema: UPDATE_API_V1_SCHEMA,
      error: 'the install lifecycle module (src/domain/install.ts) is unavailable, so this provider cannot run updates',
      failure: {
        code: 'LIFECYCLE_UNAVAILABLE',
        message: 'the install lifecycle module is unavailable in this build',
        retryable: false,
      },
    })
    return
  }
  const operation = runtime.operations.create(packageName)
  void driveUpdateOperation(runtime, operation.operationId, packageName, force, helper)
  sendJson(response, 202, {
    schema: UPDATE_API_V1_SCHEMA,
    operationId: operation.operationId,
    operation,
  })
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/**
 * Register every `/dsh-galaxy/api/v1` route on `router`.
 *
 * Safe to call once per mount: each route is bound to the runtime handed in,
 * and the router disposes all of them when the plugin unmounts.
 */
export function registerV1Routes(router: Router, runtime: GalaxyRuntime): void {
  // Read-only discovery, no auth.
  router.get(CAPABILITIES_ENDPOINT, ({ response }) => {
    sendJson(response, 200, capabilitiesV1(runtime, [...V1_ENDPOINTS]))
  })

  // One path, two methods (the POST half is guarded in-handler).
  router.methods(UPDATES_ENDPOINT, ['GET', 'POST'], handleUpdatesV1)

  // One operation by id, or the whole store.
  router.get(OPERATIONS_ENDPOINT, ({ response, url }) => {
    const operationId = (url.searchParams.get('operationId') ?? '').trim()
    if (operationId === '') {
      sendJson(response, 200, { schema: UPDATE_API_V1_SCHEMA, operations: runtime.operations.list() })
      return
    }
    const operation = runtime.operations.get(operationId)
    if (operation === undefined) {
      sendJson(response, 404, {
        schema: UPDATE_API_V1_SCHEMA,
        error: 'operation not found in this host process',
      })
      return
    }
    sendJson(response, 200, { schema: UPDATE_API_V1_SCHEMA, operation })
  })

  // Consume the recovery point of one finished operation.
  router.post(ROLLBACK_ENDPOINT, async ({ request, response }) => {
    let body: unknown
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { schema: UPDATE_API_V1_SCHEMA, error: errorText(error) })
      return
    }
    const operationId = stringField(body, 'operationId') ?? ''
    if (operationId === '') {
      sendJson(response, 400, { schema: UPDATE_API_V1_SCHEMA, error: 'operationId is required' })
      return
    }
    const operation = runtime.operations.get(operationId)
    const rollbackToken = operation?.rollbackToken
    if (operation === undefined || rollbackToken === undefined) {
      sendJson(response, 409, {
        schema: UPDATE_API_V1_SCHEMA,
        error: 'rollback is not available for this operation',
      })
      return
    }
    // The token must still resolve to a live recovery point: a later mutation
    // supersedes it, and rolling back to a stale manifest is worse than refusing.
    const recoveryPoint = runtime.pendingRollbacks.get(rollbackToken)
    if (recoveryPoint === undefined) {
      sendJson(response, 409, {
        schema: UPDATE_API_V1_SCHEMA,
        error: 'the recovery point of this operation is no longer available',
      })
      return
    }
    const snapshot = asManifestSnapshot(recoveryPoint.manifest)
    if (recoveryPoint.kind !== 'update' || snapshot === undefined) {
      sendJson(response, 409, {
        schema: UPDATE_API_V1_SCHEMA,
        error: 'this operation did not leave a restorable recovery point',
      })
      return
    }
    const profile = runtime.config.profile
    const dir = runtime.dir
    // Everything below runs under the install lock: the staleness check and the
    // restore must not interleave with another package mutation.
    let attempt: RollbackAttempt
    try {
      attempt = await runtime.locks.withLock('install', `v1 rollback ${operation.packageName}`, (): RollbackAttempt => {
        if (!fingerprintMatches(profile, dir, parseFingerprint(recoveryPoint.expectedState))) {
          runtime.pendingRollbacks.delete(rollbackToken)
          return {
            ok: false,
            discard: true,
            error: 'the profile changed after this operation, so the recovery point was discarded',
          }
        }
        try {
          restoreProfileManifest(profile, snapshot, dir)
          restoreLockfile(profile, recoveryPoint.lockfile ?? null, dir)
        } catch (error) {
          // The recovery point is intact, so the client may retry.
          return { ok: false, discard: false, error: errorText(error) }
        }
        runtime.pendingRollbacks.delete(rollbackToken)
        return { ok: true, discard: true }
      })
    } catch (error) {
      attempt = { ok: false, discard: false, error: errorText(error) }
    }
    const current = runtime.operations.get(operationId)
    // `OperationState` has no `rolled-back` member: the update itself succeeded,
    // so the record lands in the attention bucket and the machine-readable fact
    // lives in `progress.phase` (the token is cleared once it is spent).
    const detail = attempt.ok
      ? `${operation.packageName}: rolled back to the recovery point`
      : attempt.error ?? 'the rollback did not complete'
    runtime.operations.update(operationId, {
      state: 'warned',
      ...(attempt.discard ? { rollbackToken: undefined } : {}),
      ...(attempt.ok ? {} : { error: detail }),
      progress: {
        ...(current?.progress ?? { active: false }),
        active: false,
        phase: attempt.ok ? 'rolled-back' : 'rollback-failed',
        detail,
        ...(attempt.ok ? {} : { error: detail }),
      },
    })
    logEvent(
      attempt.ok ? 'info' : 'warn',
      'update-api-v1',
      `operation ${operationId}: ${attempt.ok ? 'rolled back' : `rollback failed — ${detail}`}`,
    )
    sendJson(response, 200, { schema: UPDATE_API_V1_SCHEMA, operation: runtime.operations.get(operationId) ?? null })
  })

  // Loopback + same-origin, then the group F scheduler.
  router.post(RESTART_ENDPOINT, async ({ response }) => {
    if (runtime.restartScheduled) {
      sendJson(response, 409, { schema: UPDATE_API_V1_SCHEMA, error: 'a restart is already scheduled' })
      return
    }
    const capability = restartCapability(runtime.config, runtime)
    if (!capability.allowed) {
      sendJson(response, 403, {
        schema: UPDATE_API_V1_SCHEMA,
        error: capability.reason ?? 'restarting the host is not allowed here',
        restart: capability,
      })
      return
    }
    if (runtime.locks.isBusy()) {
      sendJson(response, 409, {
        schema: UPDATE_API_V1_SCHEMA,
        error: runtime.locks.busyReason() ?? 'a package mutation is in progress',
      })
      return
    }
    try {
      const schedule = await scheduleRestart(runtime.config, runtime)
      if (!schedule.scheduled) {
        sendJson(response, 409, {
          schema: UPDATE_API_V1_SCHEMA,
          error: schedule.reason ?? 'the restart guard refused this request',
          result: schedule,
        })
        return
      }
      sendJson(response, 200, { schema: UPDATE_API_V1_SCHEMA, result: schedule })
    } catch (error) {
      sendJson(response, 500, { schema: UPDATE_API_V1_SCHEMA, error: errorText(error) })
    }
  }, { loopback: true })

  // Mark the operation cancelled, then cancel the child.
  router.post(CANCELLING_ENDPOINT, async ({ request, response }) => {
    let body: unknown
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { schema: UPDATE_API_V1_SCHEMA, error: errorText(error) })
      return
    }
    const operationId = stringField(body, 'operationId') ?? ''
    if (operationId === '') {
      sendJson(response, 400, { schema: UPDATE_API_V1_SCHEMA, error: 'operationId is required' })
      return
    }
    const operation = runtime.operations.get(operationId)
    if (operation === undefined) {
      sendJson(response, 404, {
        schema: UPDATE_API_V1_SCHEMA,
        error: 'operation not found in this host process',
      })
      return
    }
    runtime.operations.cancel(operationId)
    const activeProcess = runtime.activeProcess
    if (activeProcess !== null) {
      try {
        activeProcess.cancel()
      } catch (error) {
        logEvent('warn', 'update-api-v1', `cancel of ${operationId} failed: ${errorText(error)}`)
      }
    }
    logEvent('info', 'update-api-v1', `operation ${operationId}: cancellation requested`)
    sendJson(response, 200, {
      schema: UPDATE_API_V1_SCHEMA,
      ok: true,
      operation: runtime.operations.get(operationId) ?? null,
    })
  })
}
