/**
 * Event log for issue reports: what the galaxy did and how it failed,
 * exportable as plain text from `GET /dsh-galaxy/logs`.
 *
 * Entries are sanitized on write — the home directory
 * collapses to `~`, credential shapes (API keys, GitHub/npm tokens, bearer
 * headers, `password=`) are masked, and control characters are stripped so a
 * user-supplied plugin name cannot forge extra lines in the exported file.
 * The in-memory buffer holds at most {@link MAX_ENTRIES} entries; a process
 * that configured a persistent sink appends every event there, capped at
 * {@link PERSISTENT_MAX_BYTES}.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import type { LogEntry, LogLevel } from './types.ts'

export type { LogEntry, LogLevel }

const MAX_ENTRIES = 200
const DETAIL_MAX = 600
const PERSISTENT_MAX_BYTES = 256 * 1024

const entries: LogEntry[] = []
let persistentFile: string | null = null
/** Bytes in the sink file, tracked so the cap holds without a stat per event. */
let persistentBytes = 0

/** Mask credentials, collapse the home directory, neutralize control characters. */
export function sanitize(text: string): string {
  return text
    .replaceAll(homedir(), '~')
    // Control characters are replaced by a single SPACE, not deleted. Deleting
    // them joins lines: a failing `pnpm` prints three lines and the UI showed
    // `[ERROR] Unknown option: 'profile-dir'For help, run: pnpm help rundsh: …`
    // — one unreadable run-on. A space keeps the log-injection guard (nothing
    // can forge a new line) while leaving the message readable.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***')
    .replace(/npm_[A-Za-z0-9]{16,}/g, 'npm_***')
    .replace(/bearer\s+\S+/gi, 'Bearer ***')
    .replace(/(authorization|token|apikey|api-key|password)(["':=\s]+)\S+/gi, '$1$2***')
}

/**
 * Append one event, sanitized and truncated.
 * @param level - severity for the export listing.
 * @param event - short machine-ish event name (e.g. `install`, `hot-mount`).
 * @param detail - free-form context; credentials and home paths are masked.
 */
export function logEvent(level: LogLevel, event: string, detail: string): void {
  const entry: LogEntry = {
    at: new Date().toISOString(),
    level,
    event,
    detail: sanitize(detail).slice(0, DETAIL_MAX),
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  if (persistentFile === null) return
  try {
    const line = `${JSON.stringify(entry)}\n`
    appendFileSync(persistentFile, line)
    persistentBytes += line.length
    if (persistentBytes > PERSISTENT_MAX_BYTES) trimPersistentLog(persistentFile)
  } catch {
    // A read-only or full disk: the in-memory log still serves this session,
    // and persistence disables itself so one bad write cannot break every
    // future event.
    persistentFile = null
  }
}

/** Rewrite the sink keeping only its newest half, and resync the byte count. */
function trimPersistentLog(file: string): void {
  let lines: string[]
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(line => line !== '')
  } catch {
    persistentFile = null
    return
  }
  const kept: string[] = []
  let bytes = 0
  for (let index = lines.length - 1; index >= 0 && bytes <= PERSISTENT_MAX_BYTES / 2; index -= 1) {
    kept.unshift(`${lines[index]!}\n`)
    bytes += lines[index]!.length + 1
  }
  try {
    writeFileSync(file, kept.join(''))
  } catch {
    persistentFile = null
    return
  }
  persistentBytes = bytes
}

/**
 * Append events to a profile-owned file, or stop doing so. Called once per
 * mount with `<profile>/.dsh-galaxy/log.ndjson` and with `null` on dispose.
 */
export function configurePersistentLog(file: string | null): void {
  persistentFile = file
  if (file === null) return
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    persistentBytes = existsSync(file) ? statSync(file).size : 0
    if (persistentBytes <= PERSISTENT_MAX_BYTES) return
    trimPersistentLog(file)
  } catch {
    persistentFile = null
  }
}

/** The newest persisted lines, for the export's prior-session section. */
export function readPersistentLog(file: string, maxLines = 80): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(line => line !== '').slice(-maxLines)
  } catch {
    return []
  }
}

/** A copy of the in-memory buffer, newest last. */
export function recentEntries(): LogEntry[] {
  return [...entries]
}

/** Drop every in-memory entry (used by tests). */
export function clearEntries(): void {
  entries.length = 0
}

/**
 * How to read the `at` fields, said once at the top.
 *
 * Every line is stamped in UTC and stays that way: the file is written to be
 * attached to an issue, and a maintainer comparing two reporters' logs needs
 * one clock. The local offset is stated with the arithmetic already done so
 * the reader can use the timestamps without converting anything.
 */
function timezoneNote(now = new Date()): string | null {
  const minutes = -now.getTimezoneOffset()
  if (minutes === 0) return null
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  let zone = ''
  try {
    const named = Intl.DateTimeFormat().resolvedOptions().timeZone
    zone = typeof named === 'string' && named !== '' ? ` (${named})` : ''
  } catch { /* a runtime without full ICU still gets the offset */ }
  const shift = mm === '00' ? `${String(Math.floor(abs / 60))}h` : `${String(Math.floor(abs / 60))}h${mm}m`
  const direction = minutes < 0 ? 'subtract' : 'add'
  return `timestamps: UTC — this machine is UTC${sign}${hh}:${mm}${zone}, so ${direction} ${shift} for local time`
}

/**
 * The export document for bug reports.
 * @param header - environment lines to prepend (version, platform — no paths).
 * @param snapshot - current profile state lines.
 * @param priorSessions - persisted log lines from previous processes.
 */
export function exportLogs(
  header: Record<string, string>,
  snapshot: string[] = [],
  priorSessions: string[] = [],
): string {
  const note = timezoneNote()
  const head = [
    ...Object.entries(header).map(([key, value]) => `${key}: ${sanitize(value)}`),
    ...(note === null ? [] : [note]),
  ]
  const lines = entries.map(e => `${e.at} [${e.level}] ${e.event}: ${e.detail}`)
  return [
    '# dsh-plugin-galaxy log export',
    ...head,
    '',
    ...(snapshot.length > 0 ? ['## profile state', ...snapshot.map(line => sanitize(line)), ''] : []),
    ...(priorSessions.length > 0
      ? ['## previous sessions (persisted log)', ...priorSessions.map(line => sanitize(line)), '']
      : []),
    '## events this session',
    ...(lines.length > 0 ? lines : ['(none — the buffer starts empty on every start)']),
    '',
  ].join('\n')
}
