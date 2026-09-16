/**
 * Plugin Galaxy — public, versioned update API v1 (stability: `beta`).
 *
 * This module owns the *contract* exposed under `/dsh-galaxy/api/v1`: the
 * capability document a client must read before enabling any mutation control,
 * the bounded process-local operation registry, and the projections that turn
 * internal bookkeeping into public payloads. The HTTP layer
 * (`src/api/routes-v1.ts`) only wires these to the router, so no private field
 * of the galaxy's own update state can leak into a response by accident.
 *
 * CONTRACT STABILITY — `beta`
 *   `GET /dsh-galaxy/api/v1/capabilities` reports `"stability": "beta"`.
 *   New *optional* fields may be added within v1 and existing v1 fields are
 *   never repurposed; a breaking change ships under a new path and schema
 *   version. Clients must read the `stability` field rather than infer
 *   anything from the `v1` in the path.
 *
 * RETENTION
 *   Operation records live in the current host process only — they are never
 *   persisted. The registry holds at most MAX_UPDATE_OPERATIONS_V1 records and
 *   evicts the oldest *completed* operations first; every operation id embeds
 *   the runtime boot id, so a browser tab can never mistake a record of a dead
 *   process for a live task. A record older than OPERATION_RETENTION_MS is
 *   likewise considered stale by clients, which is what `operationRetention`
 *   in the capability document announces.
 */

import { resolve } from 'node:path'
import { profileDir } from '../core/paths.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import { restartCapability } from './restart.ts'
import type {
  CapabilitiesV1,
  Channel,
  OperationState,
  RestartCapability,
  SourceMigrationHint,
  UpdateOperationV1,
  UpdateStatus,
} from '../core/types.ts'

/* ------------------------------------------------------------------ *
 * Public constants
 * ------------------------------------------------------------------ */

/** The `schema` string carried by every `/dsh-galaxy/api/v1` response body. */
export const UPDATE_API_V1_SCHEMA = 'dsh-galaxy-update-api' as const

/**
 * Capacity: the registry keeps at most this many records
 * and drops the oldest completed ones first. Deliberately larger than the
 * reference implementation's 50 — the extra head room is cheap (records are
 * a few hundred bytes) and reduces the chance that a client polling an
 * operation id races an eviction.
 */
export const MAX_UPDATE_OPERATIONS_V1 = 64

/**
 * How long a terminal operation stays meaningful to a client, in
 * milliseconds. Reported as `operationRetention`; the store keeps records
 * until capacity pressure or process exit, so this is a *client* hint — poll
 * sooner than this, then treat a 404 as "the process moved on".
 */
export const OPERATION_RETENTION_MS = 30 * 60 * 1000

/**
 * Prefix of every operation id. Recognisable in logs, distinct from the
 * galaxy's legacy `/dsh-galaxy/*` operation labels, and followed by the boot
 * id and a per-process sequence number.
 */
export const UPDATE_OPERATION_ID_PREFIX = 'galaxy-update-'

/**
 * Names of the features the v1 surface provides. Availability of individual
 * mutations is decided by the matching field (`restart.allowed`, the
 * 409/403 answers of the routes), never by the presence of a name here — the
 * list only tells a client what a conforming provider implements.
 */
export const UPDATE_API_V1_FEATURES = [
  'check',
  'update',
  'operations',
  'progress',
  'rollback',
  'restart',
  'cancel',
] as const

/**
 * npm package-name grammar (`@scope/name` or `name`). The host's package
 * manager is the ultimate authority, but rejecting an obviously invalid name
 * before it reaches a child process keeps error responses honest.
 * Mirrors `sources.ts` (group A) without importing it: that module does not
 * export this constant in the cross-module contract.
 */
export const NPM_PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** npm's own documented package-name length ceiling. */
const NPM_PACKAGE_NAME_MAX = 214

/** True when `name` is a syntactically valid npm package name. */
export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= NPM_PACKAGE_NAME_MAX && NPM_PACKAGE_NAME_RE.test(name)
}

/** Operation states that no longer change on their own. */
function isTerminal(state: OperationState): boolean {
  return state === 'done' || state === 'warned' || state === 'failed' || state === 'cancelled'
}

/* ------------------------------------------------------------------ *
 * The process-local operation registry
 * ------------------------------------------------------------------ */

/**
 * Bounded, process-local registry of public update operations.
 *
 * One instance is owned by the runtime (`runtime.operations`) and constructed
 * with the runtime boot id; the store never touches module scope, so a second
 * mount in the same process (tests, two profiles) stays independent.
 *
 * Eviction policy: while the registry is over capacity the oldest *completed*
 * record is dropped first; only when no completed record can be dropped does
 * it fall back to the oldest record at all. The active operation and records
 * pinned with {@link retain} are never dropped.
 */
export class UpdateOperationStoreV1 {
  private readonly bootId: string
  private readonly maxOperations: number
  /** Insertion-ordered: the first key is the oldest record. */
  private readonly operations = new Map<string, UpdateOperationV1>()
  /** Ids pinned by {@link retain}; exempt from every eviction pass. */
  private readonly retained = new Set<string>()
  private sequence = 0
  private activeId: string | null = null

  constructor(bootId: string, maxOperations: number = MAX_UPDATE_OPERATIONS_V1) {
    this.bootId = bootId
    this.maxOperations = Math.max(1, Math.trunc(maxOperations))
  }

  /**
   * Allocate a `queued` operation for `packageName` and make it the active
   * one. The id is `galaxy-update-<bootId>-<n>`: unique inside the process and
   * recognisable in logs.
   */
  create(packageName: string): UpdateOperationV1 {
    const operationId = `${UPDATE_OPERATION_ID_PREFIX}${this.bootId}-${String(++this.sequence)}`
    const now = Date.now()
    const operation: UpdateOperationV1 = {
      operationId,
      packageName,
      state: 'queued',
      progress: {
        active: false,
        phase: 'queued',
        target: packageName,
        currentPackage: packageName,
      },
      createdAt: now,
      updatedAt: now,
    }
    this.operations.set(operationId, operation)
    this.activeId = operationId
    this.evict()
    return structuredClone(operation)
  }

  /** A copy of one operation, or `undefined` when the id is unknown. */
  get(operationId: string): UpdateOperationV1 | undefined {
    const operation = this.operations.get(operationId)
    return operation === undefined ? undefined : structuredClone(operation)
  }

  /**
   * Shallow-merge `patch` into one operation and stamp `updatedAt`.
   * `operationId` and `createdAt` are immutable; a terminal state releases the
   * active slot, a non-terminal one takes it. Returns a copy, or `undefined`
   * for an unknown id.
   */
  update(operationId: string, patch: Partial<UpdateOperationV1>): UpdateOperationV1 | undefined {
    const current = this.operations.get(operationId)
    if (current === undefined) return undefined
    const next: UpdateOperationV1 = {
      ...current,
      ...patch,
      operationId: current.operationId,
      packageName: patch.packageName ?? current.packageName,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    }
    this.operations.set(operationId, next)
    if (isTerminal(next.state)) {
      if (this.activeId === operationId) this.activeId = null
    } else {
      this.activeId = operationId
    }
    return structuredClone(next)
  }

  /** Every recorded operation, oldest first, as copies. */
  list(): UpdateOperationV1[] {
    return [...this.operations.values()].map(operation => structuredClone(operation))
  }

  /**
   * Mark one operation `cancelled` (queue/running work only; a terminal record
   * is left untouched) and release the active slot. Returns `false` for an
   * unknown id, which is what the route turns into a 404.
   */
  cancel(operationId: string): boolean {
    const current = this.operations.get(operationId)
    if (current === undefined) return false
    if (!isTerminal(current.state)) {
      this.operations.set(operationId, {
        ...current,
        state: 'cancelled',
        progress: {
          ...current.progress,
          active: false,
          phase: 'cancelled',
          // A cancellation was observed for this operation; clients use it to
          // stop rendering a spinner without waiting for the next poll.
          cancelling: true,
        },
        updatedAt: Date.now(),
      })
    }
    if (this.activeId === operationId) this.activeId = null
    return true
  }

  /**
   * Pin one operation so capacity pressure never drops it (a client that just
   * started polling must not lose its record to a burst of new operations).
   * Returns `false` for an unknown id. Pair with {@link release}.
   */
  retain(operationId: string): boolean {
    if (!this.operations.has(operationId)) return false
    this.retained.add(operationId)
    return true
  }

  /** Drop the pin added by {@link retain}; `true` when one was held. */
  release(operationId: string): boolean {
    return this.retained.delete(operationId)
  }

  /** True while an operation of this store is queued, running or awaiting input. */
  hasActive(): boolean {
    return this.activeId !== null
  }

  /** The operation currently holding the active slot, as a copy. */
  active(): UpdateOperationV1 | undefined {
    return this.activeId === null ? undefined : this.get(this.activeId)
  }

  /** Drop records until the registry fits, oldest completed first. */
  private evict(): void {
    while (this.operations.size > this.maxOperations) {
      const victim = this.evictionCandidate()
      if (victim === undefined) break
      this.operations.delete(victim)
      this.retained.delete(victim)
      if (this.activeId === victim) this.activeId = null
    }
  }

  /** The oldest droppable id: completed first, then anything not pinned. */
  private evictionCandidate(): string | undefined {
    const protectedId = (operationId: string): boolean =>
      operationId === this.activeId || this.retained.has(operationId)
    const ids = [...this.operations.keys()]
    for (const operationId of ids) {
      const operation = this.operations.get(operationId)
      if (operation !== undefined && !protectedId(operationId) && isTerminal(operation.state)) {
        return operationId
      }
    }
    for (const operationId of ids) {
      if (!protectedId(operationId)) return operationId
    }
    return undefined
  }
}

/* ------------------------------------------------------------------ *
 * The discovery document
 * ------------------------------------------------------------------ */

/**
 * True when this mount is owned by DSH Desktop rather than a self-derived web
 * profile. Desktop injects an explicit `profileDirectory`; a web start always
 * resolves the directory from `DSH_HOME`, so the two differ exactly when the
 * host shell owns the profile location.
 */
function desktopRuntime(runtime: GalaxyRuntime): boolean {
  try {
    return resolve(runtime.config.profileDirectory) !== resolve(profileDir(runtime.config.profile))
  } catch {
    // An explicit directory that cannot be derived at all is host-owned.
    return true
  }
}

/**
 * Build the 200 body of `GET /dsh-galaxy/api/v1/capabilities`.
 *
 * `endpoints` is supplied by the registrar (the router owns the path list), so
 * the document can never advertise a route another module actually owns.
 */
export function capabilitiesV1(runtime: GalaxyRuntime, endpoints: string[]): CapabilitiesV1 {
  const restart: RestartCapability = restartCapability(runtime.config, runtime)
  return {
    schema: UPDATE_API_V1_SCHEMA,
    apiVersion: 1,
    stability: 'beta',
    marketVersion: runtime.version,
    profile: runtime.config.profile,
    bootId: runtime.bootId,
    runtime: {
      supervisor: restart.supervisor,
      debugger: restart.debugger,
      desktop: desktopRuntime(runtime),
    },
    features: [...UPDATE_API_V1_FEATURES],
    restart,
    operationRetention: OPERATION_RETENTION_MS,
    operationLimit: MAX_UPDATE_OPERATIONS_V1,
    endpoints: [...endpoints],
  }
}

/* ------------------------------------------------------------------ *
 * Public projection of
 * ------------------------------------------------------------------ */

/** Public, frozen view of one package's update status. */
export interface UpdatePackageStatusV1 {
  name: string
  /** Origin of the installed package (`npm`, `git`, local link, …). */
  source: UpdateStatus['kind']
  installedVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  channelSwitch: Channel | null
  /** True when the recorded spec must be rewritten before updating. */
  restoreRequired: boolean
  sourceMigration: SourceMigrationHint | null
  /** Human-readable reason when no update can be applied. */
  reason: string | null
  checkedAt: number
}

/** The 200 body of `GET /dsh-galaxy/api/v1/updates`. */
export interface UpdateStatusPayloadV1 {
  schema: typeof UPDATE_API_V1_SCHEMA
  package: UpdatePackageStatusV1
}

/**
 * Project one internal {@link UpdateStatus} onto the public v1 response shape.
 *
 * Internal `UpdateStatus` fields are additive over time and may carry facts
 * the public contract does not promise; this is the only place where the
 * mapping happens, so a new internal field can never silently become public.
 */
export function updatePayloadFor(status: UpdateStatus): UpdateStatusPayloadV1 {
  return {
    schema: UPDATE_API_V1_SCHEMA,
    package: {
      name: status.name,
      source: status.kind,
      installedVersion: status.current ?? null,
      latestVersion: status.latest ?? null,
      updateAvailable: status.updateAvailable,
      channelSwitch: status.channelSwitch ?? null,
      restoreRequired: status.restoreRequired === true,
      sourceMigration: status.sourceMigration ?? null,
      reason: status.reason ?? null,
      checkedAt: status.checkedAt,
    },
  }
}
