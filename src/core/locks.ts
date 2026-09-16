/**
 * Every mutation of the profile is serialized.
 *
 * Two independent queues exist because the operations have different blast
 * radii. `install` covers package-manager work (install, update, uninstall,
 * migration, rollback, self-uninstall, backup restore) — the operations that
 * spawn child processes and rewrite `package.json`/`pnpm-lock.yaml`. `write`
 * covers pure file writes of galaxy-owned documents (notes, favorites,
 * groups, snapshots, presets, bundle order, toggles).
 *
 * A `write` never waits behind a long `install` and an `install` never
 * interleaves with another `install`; both expose {@link isBusy} so routes can
 * answer 409 instead of queueing when the user should be told to wait.
 */

export type LockKind = 'install' | 'write'

/** Detail of the operation currently holding a lock. */
export interface LockHolder {
  kind: LockKind
  label: string
  startedAt: number
}

export class MutationLocks {
  private readonly tails = new Map<LockKind, Promise<unknown>>()
  private readonly holders = new Map<LockKind, LockHolder>()

  /** Run `task` exclusively under `kind`, queued behind the previous holder. */
  async withLock<T>(kind: LockKind, label: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(kind) ?? Promise.resolve()
    const run = previous.then(async () => {
      this.holders.set(kind, { kind, label, startedAt: Date.now() })
      try {
        return await task()
      } finally {
        this.holders.delete(kind)
      }
    })
    // The tail must never reject, or every queued operation would inherit the
    // failure; the caller still observes the rejection through `run`.
    this.tails.set(kind, run.then(() => undefined, () => undefined))
    return await run
  }

  /** The operation currently holding `kind`, if any. */
  holder(kind: LockKind): LockHolder | undefined {
    return this.holders.get(kind)
  }

  /** True when any mutation is running. */
  isBusy(): boolean {
    return this.holders.size > 0
  }

  /** Human-readable description of what is running, for 409 payloads. */
  busyReason(): string | undefined {
    for (const holder of this.holders.values()) return `${holder.kind}: ${holder.label}`
    return undefined
  }
}
