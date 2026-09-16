/**
 * Shared, per-mount runtime state.
 *
 * Every module-level cache of the reference implementation (catalog
 * validators, the update TTL cache, pending rollback tokens, the v1 operation
 * store, hot-mount bookkeeping, the active child process) lives here instead
 * of in module scope. That makes a second mount (tests, two profiles in one
 * process) independent by construction, and it gives route registrars one
 * object to depend on.
 */

import { MutationLocks } from './locks.ts'
import type { ResolvedConfig } from './types.ts'
import type { AgentsServiceLike } from '../domain/agents.ts'
import type { PluginRunner } from '../domain/dsh-cli.ts'
import type { UpdateOperationStoreV1 } from '../domain/update-api-v1.ts'

/** Generic per-module cache slot, keyed by the owning module. */
export type CacheStore = Map<string, unknown>

/** Runtime state shared by every route of one mount. */
export class GalaxyRuntime {
  readonly config: ResolvedConfig
  readonly locks = new MutationLocks()
  /** Identifier of this host process; invalidates browser-side caches. */
  readonly bootId: string
  /** Version of the galaxy plugin itself. */
  readonly version: string
  /** Lazy lookup of the host's `agents` service (install guard). */
  readonly agentsLookup: () => AgentsServiceLike | undefined
  /** Runner used for `dsh plugin …` child processes. */
  readonly runner: PluginRunner
  /** Public update API operation store. */
  readonly operations: UpdateOperationStoreV1
  /** Pending rollback tokens, keyed by token. */
  readonly pendingRollbacks = new Map<string, import('./types.ts').PendingRollback>()
  /** Module caches (catalog validators, update TTL cache, …). */
  readonly caches: CacheStore = new Map()
  /** Hot-mounted plugin rows, keyed by row id. */
  readonly hotMounts = new Map<string, import('./types.ts').HotRow>()
  /** Cancel handle of the child process currently running, if any. */
  activeProcess: { cancel(): void } | null = null
  /** True once a restart has been scheduled for this process. */
  restartScheduled = false
  /** True once the plugin has been disposed. */
  disposed = false

  constructor(init: {
    config: ResolvedConfig
    runner: PluginRunner
    operations: UpdateOperationStoreV1
    bootId?: string
    version?: string
    agentsLookup?: () => AgentsServiceLike | undefined
  }) {
    this.config = init.config
    this.runner = init.runner
    this.operations = init.operations
    this.bootId = init.bootId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.version = init.version ?? '0.0.0'
    this.agentsLookup = init.agentsLookup ?? (() => undefined)
  }

  /** The resolved profile directory managed by this mount. */
  get dir(): string {
    return this.config.profileDirectory
  }

  /** Typed read of a module cache slot. */
  cache<T>(key: string): T | undefined {
    return this.caches.get(key) as T | undefined
  }

  /** Store a module cache slot. */
  setCache(key: string, value: unknown): void {
    this.caches.set(key, value)
  }
}
