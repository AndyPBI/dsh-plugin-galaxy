/**
 * / / — the active-operation
 * progress tracker.
 *
 * The install and update routes spawn a child process and hand its NDJSON
 * stdout to a {@link ProgressTracker}; the browser polls
 * `GET /dsh-galaxy/status` and reads the tracker's last {@link Progress}
 * snapshot. One tracker exists per {@link GalaxyRuntime} (stored in
 * `runtime.cache('progress.tracker')`), so two mounts — a test, or two profiles
 * in one process — never share progress.
 *
 * The rules that make the number on screen trustworthy:
 *
 *   - `percent` is derived from `done`/`total` and never decreases while the
 *     operation runs. pnpm's stream is not ordered (a store hit can be reported
 *     after a later package was fetched), and a bar that jumps backwards reads
 *     as a failure.
 *   - a finished tracker reports `active: false` but keeps `phase`, counters
 *     and `error`, because the UI shows the outcome of the operation that just
 *     ended until the next one starts.
 *   - `seconds` is a duration, not a live timer: it stops advancing at
 *     {@link ProgressTracker.finish} so a completed operation keeps the time it
 *     actually took instead of growing while the user reads it.
 */

import type { GalaxyRuntime } from '../core/runtime.ts'
import type { Progress } from '../core/types.ts'
import type { ProgressPatch } from './ndjson.ts'

/** Mutable internal state; never handed out (see {@link ProgressTracker.snapshot}). */
interface ProgressData {
  active: boolean
  target?: string
  phase?: string
  done?: number
  total?: number
  currentPackage?: string
  downloaded?: number
  size?: number
  ndjson?: boolean
  percent?: number
  detail?: string
  error?: string
  cancelling?: boolean
}

/** Cache slot of the per-runtime tracker singleton. */
const TRACKER_KEY = 'progress.tracker'

/**
 * How many trailing output lines a snapshot carries.
 *
 * Enough to show the last few stages of a package operation, small enough that
 * the status poll (every 1.5s while busy) stays a cheap payload.
 */
const OUTPUT_LINES = 8

/** One `Progress: resolved 173, reused 54, downloaded 1, added 1, done` line. */
const PNPM_PROGRESS = /^Progress:\s*(.+)$/u

/**
 * Tracks one active operation at a time.
 *
 * Lifecycle: {@link start} → zero or more {@link apply} / {@link phase} calls →
 * {@link finish}. Calling `start` again resets the state, which is how a second
 * install reuses the same tracker.
 */
export class ProgressTracker {
  private data: ProgressData = { active: false }
  private startedAt = 0
  private endedAt = 0
  /** High-water mark of the reported percentage (percent never walks back). */
  private lastPercent: number | undefined
  /** Trailing output lines, newest last (bounded by {@link OUTPUT_LINES}). */
  private lines: string[] = []
  /** Bytes of a line whose trailing newline has not arrived yet. */
  private pending = ''

  /** Begin tracking `target`; `total` is known up front for count-based work. */
  start(target: string, total?: number): void {
    const next: ProgressData = { active: true, target }
    if (typeof total === 'number' && Number.isFinite(total) && total > 0) next.total = total
    this.data = next
    this.startedAt = Date.now()
    this.endedAt = 0
    this.lastPercent = undefined
    this.lines = []
    this.pending = ''
  }

  /**
   * Fold a raw output chunk from the running child into the snapshot.
   *
   * pnpm is NOT run with a machine reporter here (`dsh plugin` forwards to
   * pnpm's default reporter), so the operator's view is the tool's own words.
   * That is deliberate: the human lines are the real process, and showing them
   * is what turns "installing…" into something an operator can judge. Counters
   * are still lifted out of the lines that carry them.
   *
   * Chunks arrive at arbitrary boundaries, so a partial trailing line is held
   * until its newline shows up.
   */
  outputLines(chunk: string): void {
    if (chunk === '') return
    const text = this.pending + chunk
    const parts = text.split(/\r?\n/u)
    this.pending = parts.pop() ?? ''
    if (this.pending.length > 4096) this.pending = this.pending.slice(-4096)
    for (const raw of parts) {
      const line = raw.replace(/\s+$/u, '')
      if (line === '') continue
      this.lines.push(line)
      if (this.lines.length > OUTPUT_LINES) this.lines.splice(0, this.lines.length - OUTPUT_LINES)
      const progress = PNPM_PROGRESS.exec(line.trim())
      if (progress !== null) this.applyProgressLine(progress[1])
    }
  }

  /** Lift `downloaded`/`added` counters out of pnpm's summary line. */
  private applyProgressLine(body: string): void {
    this.data.detail = `Progress: ${body}`
    const downloaded = /downloaded\s+(\d+)/u.exec(body)
    if (downloaded !== null) this.data.downloaded = Math.max(this.data.downloaded ?? 0, Number(downloaded[1]))
    const added = /added\s+(\d+)/u.exec(body)
    if (added !== null) this.data.done = Math.max(this.data.done ?? 0, Number(added[1]))
  }

  /**
   * Fold one parsed NDJSON patch into the current state.
   *
   * Lifecycle fields (`active`, `error`, `cancelling`) are deliberately not
   * taken from a patch: the tracker owns the operation's state machine, and a
   * stray stream line must not be able to declare the operation finished.
   */
  apply(patch: ProgressPatch): void {
    const data = this.data

    const phase = typeof patch.phase === 'string' ? patch.phase : undefined
    if (phase !== undefined) data.phase = phase

    const currentPackage = typeof patch.currentPackage === 'string' ? patch.currentPackage : undefined
    if (currentPackage !== undefined && currentPackage !== '') data.currentPackage = currentPackage

    // Counters are absolute readings, and downloads restart per package. Only
    // raise them, so a repeated or late event cannot walk the bar backwards.
    const total = numberOrUndefined(patch.total)
    if (total !== undefined && (data.total === undefined || total > data.total)) data.total = total
    const done = numberOrUndefined(patch.done)
    if (done !== undefined) data.done = Math.max(data.done ?? 0, done)

    const downloaded = numberOrUndefined(patch.downloaded)
    if (downloaded !== undefined) data.downloaded = Math.max(data.downloaded ?? 0, downloaded)
    const size = numberOrUndefined(patch.size)
    if (size !== undefined) data.size = Math.max(data.size ?? 0, size)

    if (patch.ndjson !== undefined) data.ndjson = patch.ndjson
    if (typeof patch.detail === 'string' && patch.detail !== '') data.detail = patch.detail

    if (data.done !== undefined || data.total !== undefined) this.recomputePercent()
  }

  /** Set the display phase explicitly (used by route-level steps around pnpm). */
  phase(name: string, detail?: string): void {
    if (typeof name !== 'string' || name === '') return
    this.data.phase = name
    if (detail !== undefined) this.data.detail = detail
  }

  /** End the operation, recording `error` when it failed. Stays displayable. */
  finish(error?: string): void {
    if (this.data.active) this.endedAt = Date.now()
    this.data.active = false
    this.data.cancelling = false
    if (error !== undefined) this.data.error = error
  }

  /**
   * Mark the operation as being cancelled; it still ends via {@link finish}.
   * The `detail` text is left alone so a cancellation request cannot erase the
   * last real status message.
   */
  markCancelling(): void {
    if (!this.data.active) return
    this.data.cancelling = true
  }

  /** A serializable copy of the current progress. */
  snapshot(): Progress {
    const data = this.data
    const snapshot: Progress = { active: data.active, seconds: this.seconds() }
    if (data.target !== undefined) snapshot.target = data.target
    if (data.phase !== undefined) snapshot.phase = data.phase
    if (data.done !== undefined) snapshot.done = data.done
    if (data.total !== undefined) snapshot.total = data.total
    if (data.currentPackage !== undefined) snapshot.currentPackage = data.currentPackage
    if (data.downloaded !== undefined) snapshot.downloaded = data.downloaded
    if (data.size !== undefined) snapshot.size = data.size
    if (data.ndjson !== undefined) snapshot.ndjson = data.ndjson
    if (this.lastPercent !== undefined) snapshot.percent = this.lastPercent
    if (data.detail !== undefined) snapshot.detail = data.detail
    if (data.error !== undefined) snapshot.error = data.error
    if (data.cancelling === true) snapshot.cancelling = true
    if (this.lines.length > 0) snapshot.lines = [...this.lines]
    return snapshot
  }

  /** True while an operation is being tracked. */
  isBusy(): boolean {
    return this.data.active
  }

  /** Whole seconds the operation ran (or has been running). */
  seconds(): number {
    if (this.startedAt === 0) return 0
    const end = this.data.active ? Date.now() : this.endedAt
    return Math.max(0, Math.round((end - this.startedAt) / 1000))
  }

  /** Recompute `percent` from the counters, clamped to the high-water mark. */
  private recomputePercent(): void {
    const { done, total } = this.data
    if (done === undefined || total === undefined || total <= 0) return
    const raw = Math.min(100, Math.floor((done * 100) / total))
    this.lastPercent = this.lastPercent === undefined ? raw : Math.max(this.lastPercent, raw)
  }
}

/** A finite, non-negative number from a patch field, or `undefined`. */
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * The per-runtime tracker singleton.
 *
 * The install/update routes feed this instance and `GET /dsh-galaxy/status`
 * reads it, so progress survives across requests without any module-level
 * state — the slot lives in {@link GalaxyRuntime} and dies with the mount.
 */
export function progressTracker(runtime: GalaxyRuntime): ProgressTracker {
  const existing = runtime.cache<ProgressTracker>(TRACKER_KEY)
  if (existing !== undefined) return existing
  const tracker = new ProgressTracker()
  runtime.setCache(TRACKER_KEY, tracker)
  return tracker
}
