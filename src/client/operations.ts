/**
 * The operations model behind (
 * ,).
 *
 * One record per mutating operation, from the moment it is queued until the
 * user clears it. Records exist because operation state used to live on the
 * card that started it, which disappears the moment the user paginates,
 * searches or switches tab — taking any decision attached to it (a loader-id
 * clash, a blocked build script) along with it. Records live here instead,
 * keyed by `kind:name`, so the panel only has to ask "what is running for this
 * package".
 *
 * Six states are what the model has to distinguish, three buckets are what a
 * reader can hold apart:
 *
 *   busy      queued, running
 *   ok        done, warned
 *   attention input, failed, cancelled
 *
 * `input` is not a failure: the host already reverted the change, so the
 * profile is intact and the operation is only waiting for the user. That is
 * why it stays in `attention` — a bucket named "ok" would hide the only thing
 * the user has to act on.
 *
 * ## Merging a status snapshot
 *
 * `recordFromStatus` folds one `/status` answer into the previous list:
 * records are matched by `recordId(kind, name)` and updated in place, never
 * appended twice, and a busy record that disappears from the snapshot is
 * settled rather than dropped. A record whose state changed is stamped
 * `needsRefresh`, which is the panel's cue that the page no longer reflects
 * what the profile contains.
 *
 * The module is deliberately structural: it builds records of its own shape
 * (`RecordFields`) and crosses into the server DTO once, at `asRecord`, so a
 * change to the transport type in `market-data.ts` cannot break the pure
 * folding logic here.
 */

import type { GalaxyStatus, OperationRecord } from './market-data.ts'

/** The three visual groups (bucket). */
type Bucket = 'busy' | 'ok' | 'attention'

/** The subset of this module reads and writes. */
interface RecordFields {
  id: string
  kind: string
  name: string
  url?: string | undefined
  state: string
  bucket: Bucket
  percent?: number | undefined
  detail?: string | undefined
  reason?: string | undefined
  blockedBuilds?: string[] | undefined
  needsRefresh?: boolean | undefined
  startedAt: number
  finishedAt?: number | undefined
  /**
   * Annotation: the host boot that reported this record. When the boot id
   * changes, a busy record can never finish — the process that was running it
   * is gone — so the merge settles it as failed instead of leaving the panel
   * waiting forever.
   */
  boot?: string | undefined
  /**
   * Annotation: `/status` reports pnpm unusable, so the panel offers the
   * one-click provision next to the failure it explains.
   */
  pnpmMissing?: boolean | undefined
}

/** The subset of `/status` this module reads. */
interface StatusView {
  busy?: boolean | undefined
  progress?: {
    active?: boolean | undefined
    target?: string | undefined
    phase?: string | undefined
    done?: number | undefined
    total?: number | undefined
    currentPackage?: string | undefined
    percent?: number | undefined
    detail?: string | undefined
    error?: string | undefined
    cancelling?: boolean | undefined
  } | undefined
  pnpm?: { ok?: boolean | undefined } | undefined
}

/** States grouped by bucket. `cancelled` is settled and not a success. */
const BUCKETS: Record<string, Bucket> = {
  queued: 'busy',
  running: 'busy',
  input: 'attention',
  failed: 'attention',
  cancelled: 'attention',
  done: 'ok',
  warned: 'ok',
}

/** States in which the host may still be working on the record. */
const BUSY_STATES: readonly string[] = ['queued', 'running']

/** Operation kinds the client can name; anything else falls back to install. */
const KINDS: readonly string[] = ['install', 'update', 'uninstall', 'migrate', 'restore', 'order', 'self-uninstall']

/** Sentence shown for a record a host restart interrupted. */
const INTERRUPTED = 'The host restarted before this operation finished.'

/** Single boundary between this module's record view and the server DTO. */
function asRecord(fields: RecordFields): OperationRecord {
  return fields as unknown as OperationRecord
}

/** The record view of a DTO: only the fields this module reads. */
function fieldsOf(record: OperationRecord): RecordFields {
  return record as unknown as RecordFields
}

/** The bucket one state belongs to; unknown states ask for attention. */
function bucketOfState(state: string): Bucket {
  return BUCKETS[state] ?? 'attention'
}

/** Which of the three visual groups a record belongs to. */
export function bucketOf(record: OperationRecord): Bucket {
  return bucketOfState(fieldsOf(record).state)
}

/** Stable record identity: one record per kind+name, whatever the boot. */
export function recordId(kind: string, name: string): string {
  return `${kind}:${name.trim()}`
}

/**
 * Group records into the panel's three buckets, keeping the order each list
 * arrived in — a queue has to read top-to-bottom in the order it will run.
 */
export function groupRecords(records: readonly OperationRecord[]): {
  busy: OperationRecord[]
  ok: OperationRecord[]
  attention: OperationRecord[]
} {
  const busy: OperationRecord[] = []
  const ok: OperationRecord[] = []
  const attention: OperationRecord[] = []
  for (const record of records) {
    const bucket = bucketOf(record)
    if (bucket === 'busy') busy.push(record)
    else if (bucket === 'ok') ok.push(record)
    else attention.push(record)
  }
  return { busy, ok, attention }
}

/** Whether the host may still be working on this record. */
function isBusy(record: { state: string }): boolean {
  return BUSY_STATES.includes(record.state)
}

/** Narrow a free-form string to a known operation kind. */
function asKind(value: string | undefined): string | undefined {
  return value !== undefined && KINDS.includes(value) ? value : undefined
}

/**
 * Which operation an unnamed progress report belongs to: the record already
 * carrying that package name answers it; failing that, the phase text does;
 * failing that, an install.
 */
function kindFor(records: readonly RecordFields[], name: string, phase: string | undefined): string {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record.name === name && isBusy(record)) return record.kind
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record.name === name) return record.kind
  }
  const text = (phase ?? '').toLowerCase()
  const candidates: [string, string][] = [
    ['uninstall', 'uninstall'],
    ['remove', 'uninstall'],
    ['migrate', 'migrate'],
    ['restore', 'restore'],
    ['order', 'order'],
    ['update', 'update'],
  ]
  for (const [needle, kind] of candidates) {
    if (text.includes(needle)) {
      const known = asKind(kind)
      if (known !== undefined) return known
    }
  }
  return 'install'
}

/** 0-100 progress, from the server's own percentage or from done/total. */
function percentOf(progress: StatusView['progress']): number | undefined {
  if (progress === undefined) return undefined
  const reported = progress.percent
  if (typeof reported === 'number' && Number.isFinite(reported)) return clampPercent(reported)
  const { done, total } = progress
  if (typeof done === 'number' && typeof total === 'number' && total > 0) return clampPercent((done / total) * 100)
  return undefined
}

/** Keep a percentage inside the bar it draws. */
function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** The host's latest progress line, shown verbatim under the bar. */
function detailOf(progress: StatusView['progress']): string | undefined {
  if (progress === undefined) return undefined
  for (const value of [progress.detail, progress.currentPackage, progress.phase]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Index of the newest busy record, or -1 when nothing is moving. */
function lastBusyIndex(records: readonly RecordFields[]): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (isBusy(records[index])) return index
  }
  return -1
}

/**
 * Settle a record the host stopped reporting: the operation is over, and only
 * its own error decides whether it ended well.
 */
function settle(record: RecordFields, status: StatusView, boot: string, at: number): RecordFields {
  const progress = status.progress
  const error = typeof progress?.error === 'string' && progress.error.trim() !== '' ? progress.error.trim() : undefined
  const cancelled = error === undefined && progress?.cancelling === true
  const state = error !== undefined ? 'failed' : cancelled ? 'cancelled' : 'done'
  const changed = record.state !== state
  return {
    ...record,
    state,
    bucket: bucketOfState(state),
    reason: error ?? record.reason,
    needsRefresh: changed ? true : record.needsRefresh,
    finishedAt: record.finishedAt ?? at,
    boot,
  }
}

/** Build (or update) the record an active progress report describes. */
function progressRecord(
  existing: RecordFields | undefined,
  kind: string,
  name: string,
  status: StatusView,
  boot: string,
  at: number,
): RecordFields {
  const resuming = existing !== undefined && isBusy(existing)
  return {
    id: recordId(kind, name),
    kind,
    name,
    url: existing?.url,
    state: 'running',
    bucket: bucketOfState('running'),
    percent: percentOf(status.progress),
    detail: detailOf(status.progress),
    // The previous outcome is dropped the moment a new attempt starts, or the
    // panel would show a fresh run carrying an old failure's sentence.
    reason: undefined,
    blockedBuilds: existing?.blockedBuilds,
    needsRefresh: existing !== undefined && existing.state !== 'running' ? true : existing?.needsRefresh,
    startedAt: resuming ? existing.startedAt : at,
    finishedAt: undefined,
    boot,
    pnpmMissing: false,
  }
}

/** A busy record seen in a previous boot process can never finish. */
function markInterrupted(record: RecordFields, boot: string, at: number): RecordFields {
  if (!isBusy(record) || record.boot === undefined || record.boot === boot) {
    return { ...record, boot: record.boot ?? boot }
  }
  return {
    ...record,
    state: 'failed',
    bucket: bucketOfState('failed'),
    reason: INTERRUPTED,
    needsRefresh: true,
    finishedAt: record.finishedAt ?? at,
    boot,
  }
}

/**
 * Fold one `/status` snapshot into the records the panel already holds.
 *
 * @param previous - records as the panel currently holds them.
 * @param status - the host's latest answer.
 * @param boot - boot id of that answer (`status.boot`), used to detect a
 *   restart that orphaned an operation.
 * @returns a new list: history is kept, matching records are updated in
 *   place, and a state change stamps `needsRefresh`.
 */
export function recordFromStatus(previous: readonly OperationRecord[], status: GalaxyStatus, boot: string): OperationRecord[] {
  const at = Date.now()
  const view = status as unknown as StatusView
  const progress = view.progress
  const active = progress !== undefined && progress.active === true
  const target = active ? (progress?.target ?? progress?.currentPackage ?? '').trim() : ''
  const pnpmMissing = view.pnpm?.ok !== true

  let records: RecordFields[] = previous.map(record => markInterrupted(fieldsOf(record), boot, at))

  if (active && target !== '') {
    const kind = kindFor(records, target, progress?.phase)
    const id = recordId(kind, target)
    const index = records.findIndex(record => record.id === id)
    const next = progressRecord(index === -1 ? undefined : records[index], kind, target, view, boot, at)
    if (index === -1) records = [...records, next]
    else {
      const copy = records.slice()
      copy[index] = next
      records = copy
    }
  } else if (active) {
    // A running host that names no target: attach the line to whatever is
    // still moving rather than inventing a record with an empty name.
    const index = lastBusyIndex(records)
    if (index !== -1) {
      const existing = records[index]
      const copy = records.slice()
      copy[index] = progressRecord(existing, existing.kind, existing.name, view, boot, at)
      records = copy
    }
  } else if (view.busy !== true) {
    // The host is idle: nothing that was moving is moving any more.
    records = records.map(record => (isBusy(record) ? settle(record, view, boot, at) : record))
  }

  return records.map(record => asRecord(
    record.state === 'failed' ? { ...record, pnpmMissing } : { ...record, pnpmMissing: undefined },
  ))
}
