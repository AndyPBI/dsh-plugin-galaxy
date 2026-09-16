/**
 * Profile snapshots — / /,
 *
 * A snapshot is one JSON document under
 * `<profile>/.dsh-galaxy/snapshots/<id>.json` capturing the three files that
 * define a profile's plugin composition:
 *
 *   - `package.json` (dependencies + `dsh.profile.bundles`),
 *   - `cordis.patch.yml` (the user patch layer),
 *   - `.dsh-galaxy/state.json` (the galaxy's own disable list / groups / notes).
 *
 * Version 2 records every tracked path, including an explicit `absent` marker
 * for a file that did not exist at capture time, so restoring a snapshot also
 * removes a file that appeared afterwards. Listing validates the document
 * strictly: a snapshot that could never be restored is not offered to the user.
 *
 * Writes go through `core/json.ts` `writeJsonAtomic` (temp file + rename), so a
 * crash can never leave a half-written snapshot.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ensureParent, readJsonFile, readTextFile, writeFileAtomic, writeJsonAtomic } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import { GALAXY_DIR_NAME, galaxyDir, SNAPSHOT_DIR } from '../core/paths.ts'
import type { ProfileSnapshot, SnapshotFile } from '../core/types.ts'

// Re-exported so callers of this module never need a second import for the
// document type they receive.
export type { ProfileSnapshot, SnapshotFile }

/** .format — the exact format marker this module writes. */
export const SNAPSHOT_FORMAT = 'dsh-plugin-galaxy-snapshot' as const
/** .version — v2 records absent files explicitly. */
export const SNAPSHOT_VERSION = 2 as const
/** Default number of snapshots retained per profile. */
export const DEFAULT_MAX_SNAPSHOTS = 20

/** An id is a basename, never a path. */
const SNAPSHOT_ID_RE = /^snapshot-[0-9A-Za-z-]+$/u

/** The three composition files every v2 snapshot describes, profile-relative. */
const STATE_RELATIVE_PATH = `${GALAXY_DIR_NAME}/state.json`

/** Profile-relative paths captured by a snapshot, in a stable order. */
export const SNAPSHOT_PATHS: readonly string[] = [
  'package.json',
  'cordis.patch.yml',
  STATE_RELATIVE_PATH,
]

/**
 * Reject traversal-shaped, absolute or otherwise malformed
 * ids BEFORE they can reach the filesystem.
 */
export function validSnapshotId(id: string): boolean {
  return SNAPSHOT_ID_RE.test(id)
}

/** `<profile>/.dsh-galaxy/snapshots`. */
export function snapshotDir(dir: string): string {
  return join(galaxyDir(dir), SNAPSHOT_DIR)
}

/** Absolute path of one snapshot document; throws on a traversal-shaped id. */
function snapshotFile(dir: string, id: string): string {
  if (!validSnapshotId(id)) throw new Error(`invalid snapshot id / 无效的快照 id: ${JSON.stringify(id)}`)
  return join(snapshotDir(dir), `${id}.json`)
}

/** True when `error` is ENOENT — the ordinary "file is not there" shape. */
function isMissing(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * `readFileSync` reports ENOENT for a dangling symlink too. Confirm the path
 * entry itself is gone before turning an unreadable file into a later delete.
 */
function isTrulyAbsent(path: string, error: unknown): boolean {
  if (!isMissing(error)) return false
  try {
    lstatSync(path)
    return false
  } catch (statError) {
    return isMissing(statError)
  }
}

/** Parse + strictly validate a snapshot document read from disk. */
function parseSnapshot(raw: unknown, expectedId?: string): ProfileSnapshot | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (record.format !== SNAPSHOT_FORMAT || record.version !== SNAPSHOT_VERSION) return undefined
  if (typeof record.id !== 'string' || !validSnapshotId(record.id)) return undefined
  if (expectedId !== undefined && record.id !== expectedId) return undefined
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return undefined
  if (!Array.isArray(record.files)) return undefined

  const byPath = new Map<string, SnapshotFile>()
  for (const entry of record.files) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const file = entry as Record<string, unknown>
    const path = file.path
    if (typeof path !== 'string' || !SNAPSHOT_PATHS.includes(path)) return undefined
    if (byPath.has(path)) return undefined
    const absent = file.absent === true
    const hasJson = Object.hasOwn(file, 'json')
    const hasLines = Array.isArray(file.lines)
    const representations = Number(absent) + Number(hasJson) + Number(hasLines)
    if (representations !== 1) return undefined
    if (hasLines && !(file.lines as unknown[]).every(line => typeof line === 'string')) return undefined
    // `package.json` and `state.json` are JSON documents, `cordis.patch.yml`
    // is line-oriented: a representation mismatch is corruption, not a variant.
    if (path === 'cordis.patch.yml') {
      if (!hasLines && !absent) return undefined
    } else if (!hasJson && !absent) {
      return undefined
    }
    byPath.set(path, file as unknown as SnapshotFile)
  }
  // v2 describes every tracked path — a missing entry means a truncated write.
  if (SNAPSHOT_PATHS.some(path => !byPath.has(path))) return undefined
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    id: record.id,
    createdAt: record.createdAt,
    files: SNAPSHOT_PATHS.map(path => byPath.get(path)!),
  }
}

/** Basename of the next snapshot: capture time plus a same-millisecond sequence. */
function nextSnapshotId(dir: string): string {
  const existing = new Set<string>()
  try {
    for (const name of readdirSync(snapshotDir(dir))) {
      if (name.endsWith('.json')) existing.add(name.slice(0, -5))
    }
  } catch { /* no snapshots directory yet — no collisions */ }
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  let id = `snapshot-${stamp}`
  let sequence = 0
  while (existing.has(id)) {
    sequence += 1
    id = `snapshot-${stamp}-${String(sequence)}`
  }
  return id
}

/** Newest-first order; ids break ties when two captures share a timestamp. */
function byNewest(left: ProfileSnapshot, right: ProfileSnapshot): number {
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
}

/**
 * Capture the profile's three composition files as a version 2 snapshot.
 *
 * `package.json` must exist and parse; a snapshot without a manifest could not
 * restore a bootable profile. The other two are optional and recorded as
 * `absent` when missing. An existing-but-unreadable optional file makes the
 * capture fail rather than silently recording a deletion instruction.
 *
 * Afterwards the directory keeps only the newest
 * `maxSnapshots` documents (a non-positive cap is clamped to 1).
 */
export function createProfileSnapshot(
  profile: string,
  dir: string,
  maxSnapshots: number = DEFAULT_MAX_SNAPSHOTS,
): ProfileSnapshot {
  const manifestPath = join(dir, 'package.json')
  let manifestText: string
  try {
    manifestText = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    throw new Error(isTrulyAbsent(manifestPath, error)
      ? 'profile package.json is missing / profile package.json 缺失'
      : `profile package.json could not be read / 无法读取 profile package.json: ${(error as Error).message}`)
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestText) as unknown
  } catch {
    throw new Error('profile package.json contains invalid JSON / profile package.json 包含无效 JSON')
  }

  const files: SnapshotFile[] = [{ path: 'package.json', json: manifest }]
  for (const path of SNAPSHOT_PATHS.slice(1)) {
    const absolute = join(dir, path)
    let text: string
    try {
      text = readFileSync(absolute, 'utf8')
    } catch (error) {
      if (isTrulyAbsent(absolute, error)) {
        files.push({ path, absent: true })
        continue
      }
      throw new Error(`snapshot file ${path} could not be read / 无法读取快照文件 ${path}: ${(error as Error).message}`)
    }
    if (path === STATE_RELATIVE_PATH) {
      try {
        files.push({ path, json: JSON.parse(text) as unknown })
      } catch {
        // Every state reader observes an invalid document as empty, so
        // "absent" is the exact composition state the host would boot with.
        files.push({ path, absent: true })
        logEvent('warn', 'snapshot', `${path} is invalid JSON; captured as absent (readers treat it as empty)`)
      }
    } else {
      files.push({ path, lines: text.split(/\r?\n/u) })
    }
  }

  const id = nextSnapshotId(dir)
  const snapshot: ProfileSnapshot = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    id,
    createdAt: Date.now(),
    files,
  }
  ensureParent(snapshotFile(dir, id), 0o700)
  writeJsonAtomic(snapshotFile(dir, id), snapshot)
  logEvent('info', 'snapshot', `created ${id} (${files.map(file => file.path).join(', ')})`)
  // The just-created snapshot is pinned first, so a cap
  // of 1 can never prune the document this call is about to return.
  pruneSnapshots(dir, maxSnapshots, id)
  return snapshot
}

/** Prune the snapshot directory to the `max` newest documents. */
function pruneSnapshots(dir: string, max: number, keepId: string): string[] {
  const cap = Math.max(1, max)
  const all = listSnapshots(dir)
  if (all.length <= cap) return []
  const ordered = [
    ...all.filter(snapshot => snapshot.id === keepId),
    ...all.filter(snapshot => snapshot.id !== keepId),
  ]
  const dropped = ordered.slice(cap)
  for (const snapshot of dropped) deleteSnapshot(dir, snapshot.id)
  if (dropped.length > 0) {
    logEvent('info', 'snapshot', `pruned ${dropped.length} old snapshot(s) (cap ${cap}): ${dropped.map(s => s.id).join(', ')}`)
  }
  return dropped.map(snapshot => snapshot.id)
}

/**
 * Every restorable snapshot of this profile, newest first. Documents that are
 * unparseable, shape-invalid or whose internal id disagrees with the file name
 * are skipped: a snapshot that cannot be restored must not be listed.
 */
export function listSnapshots(dir: string): ProfileSnapshot[] {
  let names: string[]
  try {
    names = readdirSync(snapshotDir(dir))
  } catch {
    return []
  }
  const snapshots: ProfileSnapshot[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    if (!validSnapshotId(id)) continue
    const parsed = parseSnapshot(readJsonFile<unknown>(join(snapshotDir(dir), name)), id)
    if (parsed !== undefined) snapshots.push(parsed)
  }
  return snapshots.sort(byNewest)
}

/** Read one snapshot, or `undefined` when it is unknown or corrupt. */
export function readSnapshot(dir: string, id: string): ProfileSnapshot | undefined {
  if (!validSnapshotId(id)) return undefined
  return parseSnapshot(readJsonFile<unknown>(snapshotFile(dir, id)), id)
}

/**
 * Restore a snapshot's files into the profile.
 *
 * Every target is validated before anything is written, each write goes
 * through `writeJsonAtomic`, and a failure midway rolls the completed
 * writes/deletions back to their pre-restore contents so a half-restored
 * profile cannot be left behind.
 */
export function restoreSnapshot(dir: string, id: string): { ok: boolean; reason?: string } {
  if (!validSnapshotId(id)) return { ok: false, reason: 'invalid snapshot id / 无效的快照 id' }
  const snapshot = readSnapshot(dir, id)
  if (snapshot === undefined) return { ok: false, reason: 'snapshot not found / 快照不存在' }

  interface PendingWrite {
    path: string
    target: string
    content: string | null
    previous: string | null
  }
  const writes: PendingWrite[] = []

  for (const file of snapshot.files) {
    const target = join(dir, file.path)
    // Rollback records bytes, not filesystem identity: replacing a symlink or
    // a directory could never be restored faithfully, so refuse it up front.
    try {
      if (!lstatSync(target).isFile()) {
        return { ok: false, reason: `restore target is not a regular file / 恢复目标不是常规文件: ${file.path}` }
      }
    } catch (error) {
      if (!isMissing(error)) {
        return { ok: false, reason: `restore target is unreadable / 恢复目标不可读: ${file.path}` }
      }
    }
    let previous: string | null
    try {
      previous = readFileSync(target, 'utf8')
    } catch (error) {
      if (!isMissing(error)) {
        return { ok: false, reason: `restore target is unreadable / 恢复目标不可读: ${file.path}` }
      }
      previous = null
    }
    let content: string | null = null
    if (file.absent !== true) {
      content = file.json !== undefined
        ? `${JSON.stringify(file.json, null, 2)}\n`
        : `${(file.lines ?? []).join('\n')}`
    }
    writes.push({ path: file.path, target, content, previous })  }

  const completed: PendingWrite[] = []
  try {
    for (const write of writes) {
      if (write.content === null) rmSync(write.target, { force: true })
      else writeFileAtomic(write.target, write.content, 0o644)
      completed.push(write)
    }
  } catch (error) {
    for (const write of [...completed].reverse()) {
      try {
        if (write.previous === null) rmSync(write.target, { force: true })
        else writeFileAtomic(write.target, write.previous, 0o644)
      } catch (rollbackError) {
        logEvent('error', 'snapshot', `rollback of ${write.path} failed: ${(rollbackError as Error).message}`)
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    logEvent('error', 'snapshot', `restore ${id} failed and was rolled back: ${message}`)
    return { ok: false, reason: message }
  }
  logEvent('info', 'snapshot', `restored ${id}: ${writes.map(write => write.path).join(', ')}`)
  return { ok: true }
}

/** Delete one snapshot; false when the id is malformed or nothing was there. */
export function deleteSnapshot(dir: string, id: string): boolean {
  if (!validSnapshotId(id)) return false
  const file = snapshotFile(dir, id)
  if (!existsSync(file)) return false
  try {
    rmSync(file, { force: true })
    return true
  } catch (error) {
    logEvent('warn', 'snapshot', `could not delete ${id}: ${(error as Error).message}`)
    return false
  }
}

/**
 * Non-throwing capture used by routes that must report a clean 400. The
 * contract-required {@link createProfileSnapshot} throws instead.
 */
export function tryCreateProfileSnapshot(
  profile: string,
  dir: string,
  maxSnapshots: number = DEFAULT_MAX_SNAPSHOTS,
): { ok: true; snapshot: ProfileSnapshot } | { ok: false; reason: string } {
  try {
    return { ok: true, snapshot: createProfileSnapshot(profile, dir, maxSnapshots) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Read a profile-relative text file (small helper shared by callers). */
export function readSnapshotText(dir: string, path: string): string | null {
  return readTextFile(join(dir, path))
}
