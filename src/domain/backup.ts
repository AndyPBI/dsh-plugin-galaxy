/**
 * Portable profile configuration backup (/
 * ).
 *
 * A profile directory is plain user data: next to `package.json` it may hold
 * `cordis.patch.yml`, API keys (`config.toml`, `.env`, …) and the galaxy's own
 * `.dsh-galaxy/` documents. A backup is therefore a *configuration* export —
 * installed packages are never carried, only the declared dependency specs are
 * recorded for information — and it stays one-to-one (nothing is masked) so a
 * restore is faithful. Credential-carrying files are flagged instead, and the
 * UI warns about them; the download route is loopback-only for that reason.
 *
 * Bounds: at most {@link MAX_FILES} collected files and at
 * most {@link MAX_BACKUP_BYTES} of serialized JSON. Exceeding either one is an
 * error, never a silently truncated backup.
 *
 * WebDAV transport is a thin PUT/GET layer over `core/net.ts`
 * `fetchJson`: it never throws on network failure, it returns `{ ok, ... }`,
 * and it validates a downloaded payload before handing it back so a restore
 * flow can preview exactly what a later `/restore` will accept.
 */

import { readdirSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { asRecord } from '../core/http.ts'
import { readJsonFile, readTextFile } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import { fetchJson, proxyHint } from '../core/net.ts'
import { profileDir } from '../core/paths.ts'
import { readManifestDeps } from '../core/profile.ts'
import type { BackupFile, ProfileBackup } from '../core/types.ts'

/** Backup document format implemented by this module. */
export const BACKUP_FORMAT = 'dsh-galaxy-backup'
/** Backup document version (string, per). */
export const BACKUP_VERSION = '0.2'
/** Hard ceiling for the serialized backup document. */
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024
/** Hard ceiling for the number of collected files. */
export const MAX_FILES = 256
/** Download artifact name used by the browser client and the backup route. */
export const BACKUP_FILENAME = 'dsh-plugin-galaxy-backup.json'

/**
 * Directory and file names that are never part of a configuration backup:
 * installed packages, VCS metadata, the lockfile (reproducible from the
 * manifest), galaxy-owned rebuildable caches, and `.bak` wreckage left behind
 * by a repair — carrying that back would restore the damage.
 */
const SKIP_NAMES = new Set([
  'node_modules',
  '.git',
  'pnpm-lock.yaml',
  '.DS_Store',
  '.probe-cache',
  'log.ndjson',
  'discovery-cache.json',
])
const SKIP_DIR_NAMES = new Set(['snapshots'])
/** Any `.bak` marker, whatever the recovery tool that wrote it. */
const BACKUP_RESIDUE = /\.bak\b/iu

/**
 * File names known to carry credentials. Presence is reported
 * values are never rewritten.
 */
export const SECRET_FILE_HINTS = /(^|\/)(\.env(\.[^/]*)?|config\.toml|credentials[^/]*)$/iu

/** File names serialized as JSON; every other collected file is line-oriented. */
const JSON_FILE_NAMES = new Set(['package.json', 'state.json', 'presets.json'])

/** One dependency spec plus its owning package name. */
interface NamedSpec {
  name: string
  spec: string
}

/** Result of {@link mergeRestoreManifest}. */
export interface RestoreManifestMerge {
  /** Existing dependencies with the backup's specs overlaid (never dropped). */
  dependencies: Record<string, string>
  /** Backup dependency names now present in the merged manifest. */
  restored: string[]
  /** Backup dependency names whose spec cannot be reproduced from a backup. */
  skipped: string[]
}

/** Outcome of {@link uploadWebdav} / {@link downloadWebdav}. */
export interface WebdavResult {
  ok: boolean
  status?: number
  /** Parsed, strictly validated backup when the action was a download. */
  backup?: ProfileBackup
  error?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/* ------------------------------------------------------------------ *
 * Collection
 * ------------------------------------------------------------------ */

/** True when two strings differ only by case (Windows-safe de-duplication). */
function samePath(left: string, right: string): boolean {
  return left === right || left.toLowerCase() === right.toLowerCase()
}

function isSkipped(entry: string): boolean {
  return SKIP_NAMES.has(entry) || BACKUP_RESIDUE.test(entry)
}

/**
 * Profile-relative, forward-slash paths of every configuration file below
 * `root`. Symbolic links are skipped (a link target is not part of the
 * profile), as are the directories in {@link SKIP_NAMES}. The walk throws as
 * soon as more than {@link MAX_FILES} files were found, so a runaway profile
 * cannot be walked to completion.
 */
function collectProfileFiles(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string, prefix: string): void => {
    if (files.length > MAX_FILES) {
      throw new Error(`dsh-plugin-galaxy: profile has more than ${String(MAX_FILES)} configuration files`)
    }
    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      throw new Error(`dsh-plugin-galaxy: cannot read ${prefix === '' ? 'the profile' : prefix}: ${(error as Error).message}`)
    }
    for (const entry of entries) {
      const name = entry.name
      if (isSkipped(name)) continue
      const relativePath = prefix === '' ? name : `${prefix}/${name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(name)) continue
        walk(resolve(directory, name), relativePath)
        continue
      }
      if (!entry.isFile()) continue
      files.push(relativePath)
      if (files.length > MAX_FILES) {
        throw new Error(`dsh-plugin-galaxy: profile has more than ${String(MAX_FILES)} configuration files`)
      }
    }
  }
  walk(root, '')
  return files.sort((left, right) => left.localeCompare(right))
}

/**
 * Read one collected file into its `BackupFile` representation.
 *
 * Asks each entry for a JSON value XOR raw lines. A document
 * that parses to a JSON *object* is carried as `json` (the manifest and the
 * galaxy's own state/preset documents, which the restore writes back as JSON);
 * everything else — `cordis.patch.yml`, a `.env`, a `.toml`, or a JSON file
 * whose top level is an array — is carried as `lines`, which byte-preserves it.
 */
function readBackupFile(root: string, path: string): BackupFile {
  const contents = readTextFile(resolve(root, ...path.split('/')))
  if (contents === null) {
    throw new Error(`dsh-plugin-galaxy: profile file disappeared while backing up: ${path}`)
  }
  const basename = path.slice(path.lastIndexOf('/') + 1)
  const secret = SECRET_FILE_HINTS.test(path)
  if (JSON_FILE_NAMES.has(basename)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(contents)
    } catch (error) {
      throw new Error(`dsh-plugin-galaxy: ${path} is not valid JSON: ${(error as Error).message}`)
    }
    if (isPlainObject(parsed)) {
      return { path, type: 'json', json: parsed, ...(secret ? { secret: true } : {}) }
    }
  }
  return { path, type: 'lines', lines: contents.split(/\r?\n/u), ...(secret ? { secret: true } : {}) }
}

/** Serialized size of a backup document, measured the way it is downloaded. */
function backupBytes(backup: ProfileBackup): number {
  return Buffer.byteLength(JSON.stringify(backup, null, 2), 'utf8')
}

/** Count of collected files whose name looks like it carries credentials. */
export function secretFileCount(backup: ProfileBackup): number {
  return backup.files.filter(file => file.secret === true || SECRET_FILE_HINTS.test(file.path)).length
}

/**
 * Serialize the profile's configuration into a portable backup.
 *
 * The profile's own `package.json`, `cordis.patch.yml` and
 * `.dsh-galaxy/state.json` / `.dsh-galaxy/presets.json` are always part of the
 * collection; any other non-ignored file is carried along so an operator's
 * additional configuration (a `config.toml`, a `.env`) survives a round trip.
 * Dependency specs are recorded informationally in `packages` and are never
 * installed by a restore.
 *
 * @throws when `package.json` is missing, when more than {@link MAX_FILES}
 *   files were collected, or when the serialized backup exceeds
 *   {@link MAX_BACKUP_BYTES}.
 */
export function createProfileBackup(profile: string, explicitDir?: string): ProfileBackup {
  const root = resolve(profileDir(profile, explicitDir))
  const manifestFile = resolve(root, 'package.json')
  let manifestStat: ReturnType<typeof statSync>
  try {
    manifestStat = statSync(manifestFile)
  } catch {
    throw new Error('dsh-plugin-galaxy: profile package.json is missing — nothing to back up')
  }
  if (!manifestStat.isFile()) throw new Error('dsh-plugin-galaxy: profile package.json is not a file')

  const rawManifest = readJsonFile<unknown>(manifestFile)
  if (!isPlainObject(rawManifest)) throw new Error('dsh-plugin-galaxy: profile package.json is not a JSON object')

  const files = collectProfileFiles(root).map(path => readBackupFile(root, path))
  if (files.length === 0) throw new Error('dsh-plugin-galaxy: profile has no configuration files to back up')
  if (files.length > MAX_FILES) {
    throw new Error(`dsh-plugin-galaxy: profile has more than ${String(MAX_FILES)} configuration files`)
  }
  if (!files.some(file => samePath(file.path, 'package.json'))) {
    throw new Error('dsh-plugin-galaxy: profile package.json is missing')
  }

  const packages: Record<string, string> = {}
  for (const [name, spec] of Object.entries(readManifestDeps(profile, explicitDir))) {
    packages[name] = spec
  }

  const backup: ProfileBackup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    profile,
    files,
    secretFileCount: files.filter(file => file.secret === true).length,
    packages,
  }
  const bytes = backupBytes(backup)
  if (bytes > MAX_BACKUP_BYTES) {
    throw new Error(
      `dsh-plugin-galaxy: profile configuration is too large to back up `
      + `(${String(bytes)} bytes > ${String(MAX_BACKUP_BYTES)} bytes)`,
    )
  }
  logEvent('info', 'backup', `collected ${String(files.length)} file(s), ${String(bytes)} bytes, ${String(backup.secretFileCount ?? 0)} credential file(s)`)
  return backup
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Reject anything that is not a profile-relative path: absolute POSIX paths,
 * Windows drive letters, UNC paths, `..` traversal, nul bytes, backslashes and
 * empty segments. A backup is user-supplied data that a restore writes to
 * disk, so this gate runs before any path is used.
 */
export function isSafeBackupPath(path: string): boolean {
  if (path === '' || path.length > 1024) return false
  if (path.includes('\0') || path.includes('\\')) return false
  if (isAbsolute(path)) return false
  if (/^[A-Za-z]:/u.test(path) || path.startsWith('//')) return false
  for (const part of path.split('/')) {
    if (part === '' || part === '.' || part === '..') return false
  }
  return true
}

/**
 * Strict structural validation of an untrusted backup value. Nothing here
 * trusts the sender: format and version must match, every path must be
 * profile-relative, paths must be unique, and each file carries a JSON value
 * XOR raw lines — never both, never neither.
 */
export function validateBackup(value: unknown): { ok: true; backup: ProfileBackup } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: 'backup must be a JSON object' }
  if (value.format !== BACKUP_FORMAT) {
    return { ok: false, reason: `unsupported backup format ${JSON.stringify(value.format ?? null)}` }
  }
  if (typeof value.version !== 'string' || value.version.trim() === '') {
    return { ok: false, reason: 'backup version is missing' }
  }
  if (!Array.isArray(value.files)) return { ok: false, reason: 'backup files must be an array' }
  if (value.files.length === 0) return { ok: false, reason: 'backup carries no files' }
  if (value.files.length > MAX_FILES) return { ok: false, reason: `backup carries more than ${String(MAX_FILES)} files` }
  if (value.packages !== undefined && !isPlainObject(value.packages)) {
    return { ok: false, reason: 'backup packages must be an object' }
  }
  if (value.secretFileCount !== undefined && (typeof value.secretFileCount !== 'number' || !Number.isInteger(value.secretFileCount) || value.secretFileCount < 0)) {
    return { ok: false, reason: 'backup secretFileCount is invalid' }
  }

  const files: BackupFile[] = []
  const seen = new Set<string>()
  let hasManifest = false
  let secret = 0
  for (const entry of value.files as unknown[]) {
    if (!isPlainObject(entry)) return { ok: false, reason: 'backup file entry is not an object' }
    const { path, json, lines } = entry
    if (typeof path !== 'string') return { ok: false, reason: 'backup file path is missing' }
    if (!isSafeBackupPath(path)) return { ok: false, reason: `unsafe backup path: ${path}` }
    const key = path.toLowerCase()
    if (seen.has(key)) return { ok: false, reason: `duplicate backup path: ${path}` }
    seen.add(key)

    const hasJson = json !== undefined
    const hasLines = lines !== undefined
    if (hasJson === hasLines) {
      return { ok: false, reason: `backup file ${path} must carry either json or lines, not both or neither` }
    }
    if (entry.type !== undefined && entry.type !== 'json' && entry.type !== 'lines') {
      return { ok: false, reason: `backup file ${path} has an invalid type` }
    }
    if (entry.secret !== undefined && typeof entry.secret !== 'boolean') {
      return { ok: false, reason: `backup file ${path} has an invalid secret flag` }
    }

    const flagged = entry.secret === true || SECRET_FILE_HINTS.test(path)
    const basename = path.slice(path.lastIndexOf('/') + 1)
    if (flagged) secret += 1
    if (hasJson) {
      if (!isPlainObject(json)) return { ok: false, reason: `backup file ${path} must hold a JSON object` }
      if (basename === 'package.json') hasManifest = true
      files.push({ path, type: 'json', json, ...(flagged ? { secret: true } : {}) })
    } else {
      if (!Array.isArray(lines) || !lines.every(line => typeof line === 'string')) {
        return { ok: false, reason: `backup file ${path} has invalid lines` }
      }
      files.push({ path, type: 'lines', lines, ...(flagged ? { secret: true } : {}) })
    }
  }
  if (!hasManifest) return { ok: false, reason: 'backup has no package.json' }
  if (value.createdAt !== undefined && typeof value.createdAt !== 'string') {
    return { ok: false, reason: 'backup createdAt is invalid' }
  }

  const backup: ProfileBackup = {
    format: BACKUP_FORMAT,
    version: value.version,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    profile: typeof value.profile === 'string' ? value.profile : '',
    files,
    secretFileCount: secret,
    ...(isPlainObject(value.packages) ? { packages: value.packages as Record<string, string> } : {}),
  }
  if (backupBytes(backup) > MAX_BACKUP_BYTES) return { ok: false, reason: 'backup is too large' }
  return { ok: true, backup }
}

/* ------------------------------------------------------------------ *
 * Restore merge
 * ------------------------------------------------------------------ */

/**
 * Dependency specs that cannot be reproduced from a backup: `file:`/`link:`
 * specs pointing at a POSIX absolute path, a Windows drive letter or a UNC
 * share. They resolve against the machine that wrote them and are reported
 * (never rewritten) so the operator decides what to do before an install runs.
 * Relative `file:./vendor/x` specs travel fine and are left alone.
 */
export function unportableDeps(dependencies: Record<string, string>): NamedSpec[] {
  const found: NamedSpec[] = []
  for (const [name, spec] of Object.entries(dependencies)) {
    const match = /^(?:link|file):(.+)$/iu.exec(spec)
    if (match === null) continue
    let target = match[1] ?? ''
    try {
      target = decodeURIComponent(target)
    } catch { /* keep the literal spec when it is not percent-encoded */ }
    if (target.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(target) || target.startsWith('\\\\')) {
      found.push({ name, spec })
    }
  }
  return found
}

/** String dependency specs declared in the backup's `package.json`. */
function backupDependencies(backup: ProfileBackup): Record<string, string> {
  const manifest = backup.files.find(file => file.path === 'package.json')
  const record = manifest === undefined ? undefined : asRecord(manifest.json)
  const raw = record?.dependencies
  if (raw === undefined || !isPlainObject(raw)) return {}
  const dependencies: Record<string, string> = {}
  for (const [name, spec] of Object.entries(raw)) {
    if (typeof spec === 'string') dependencies[name] = spec
  }
  return dependencies
}

/**
 * The `package.json` object carried by a backup, or `undefined` when the
 * backup has none. Exposed so a caller can inspect what it is about to merge
 * without reaching into `files`.
 */
export function backupManifestJson(backup: ProfileBackup): Record<string, unknown> | undefined {
  const manifest = backup.files.find(file => file.path === 'package.json')
  return manifest === undefined ? undefined : asRecord(manifest.json)
}

/**
 * Merge a backup's dependency map into the target's current dependencies.
 *
 * The target's plugins are never silently dropped: current specs stay and the
 * backup's spec wins on a name conflict. Dependencies whose spec cannot be
 * reproduced (`link:/Users/…`, `file:C:\…`) are excluded from the merge and
 * reported in `skipped` — a restore that carried them would write a manifest
 * `pnpm install` cannot satisfy.
 */
export function mergeRestoreManifest(
  backup: ProfileBackup,
  existingDeps: Record<string, string>,
): RestoreManifestMerge {
  const fromBackup = backupDependencies(backup)
  const unportable = unportableDeps(fromBackup)
  const unportableNames = new Set(unportable.map(dep => dep.name))

  const dependencies: Record<string, string> = { ...existingDeps }
  const restored: string[] = []
  const skipped: string[] = []
  for (const [name, spec] of Object.entries(fromBackup)) {
    if (unportableNames.has(name)) {
      skipped.push(name)
      continue
    }
    dependencies[name] = spec
    restored.push(name)
  }
  restored.sort((left, right) => left.localeCompare(right))
  skipped.sort((left, right) => left.localeCompare(right))
  if (skipped.length > 0) {
    logEvent('warn', 'restore', `machine-specific dependency paths will not be restored — ${unportable.map(dep => `${dep.name}: ${dep.spec}`).join('; ')}`)
  }
  return { dependencies, restored, skipped }
}

/* ------------------------------------------------------------------ *
 * WebDAV transport
 * ------------------------------------------------------------------ */

/** Options shared by {@link uploadWebdav} and {@link downloadWebdav}. */
export interface WebdavOptions {
  /** Full URL of the backup FILE (…/galaxy/backup.json), not its folder. */
  url: string
  username?: string
  password?: string
  timeoutMs?: number
  /** Backup to PUT; required for an upload. */
  backup?: ProfileBackup
}

const WEBDAV_TIMEOUT_MS = 30_000

/** Normalize an {@link WebdavOptions} URL into an absolute http(s) URL. */
function webdavUrl(raw: string): URL | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.username !== '' || parsed.password !== '') return undefined
  return parsed
}

/**
 * PUT a backup to a user-supplied WebDAV URL with basic auth. The URL and the
 * credentials come from the operator; this function never throws on a network
 * failure, it answers `{ ok, status?, error? }` and logs the reason.
 */
export async function uploadWebdav(options: WebdavOptions): Promise<WebdavResult> {
  const parsed = webdavUrl(options.url)
  if (parsed === undefined) return { ok: false, error: 'a WebDAV http(s) URL is required' }
  if (options.backup === undefined) return { ok: false, error: 'a backup payload is required for upload' }

  const response = await fetchJson({
    url: parsed.toString(),
    method: 'PUT',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(options.backup, null, 2),
    timeoutMs: options.timeoutMs ?? WEBDAV_TIMEOUT_MS,
    ...(options.username === undefined || options.username === ''
      ? {}
      : { auth: { username: options.username, password: options.password ?? '' } }),
  })
  if (!response.ok) {
    const detail = response.error ?? `HTTP ${String(response.status)}${response.text === '' ? '' : ` — ${response.text.slice(0, 200)}`}`
    logEvent('warn', 'webdav', `upload to ${parsed.origin}${parsed.pathname} failed: ${detail} (${proxyHint()})`)
    return { ok: false, status: response.status, error: `WebDAV upload failed: ${detail}` }
  }
  logEvent('info', 'webdav', `uploaded backup to ${parsed.origin}${parsed.pathname}`)
  return { ok: true, status: response.status }
}

/**
 * GET a backup from a user-supplied WebDAV URL. The downloaded document is
 * strictly validated with {@link validateBackup} before it is returned, so the
 * caller can preview exactly what a later `/restore` will accept instead of
 * echoing an arbitrary response body back to the browser.
 */
export async function downloadWebdav(options: WebdavOptions): Promise<WebdavResult> {
  const parsed = webdavUrl(options.url)
  if (parsed === undefined) return { ok: false, error: 'a WebDAV http(s) URL is required' }

  const response = await fetchJson({
    url: parsed.toString(),
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: options.timeoutMs ?? WEBDAV_TIMEOUT_MS,
    ...(options.username === undefined || options.username === ''
      ? {}
      : { auth: { username: options.username, password: options.password ?? '' } }),
  })
  if (!response.ok) {
    const detail = response.error ?? `HTTP ${String(response.status)}${response.text === '' ? '' : ` — ${response.text.slice(0, 200)}`}`
    logEvent('warn', 'webdav', `download from ${parsed.origin}${parsed.pathname} failed: ${detail} (${proxyHint()})`)
    return { ok: false, status: response.status, error: `WebDAV download failed: ${detail}` }
  }

  let candidate: unknown = response.body
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown
    } catch {
      return { ok: false, status: response.status, error: 'WebDAV payload is not valid JSON' }
    }
  }
  const validated = validateBackup(candidate)
  if (!validated.ok) {
    logEvent('warn', 'webdav', `rejected payload from ${parsed.origin}${parsed.pathname}: ${validated.reason}`)
    return { ok: false, status: response.status, error: `WebDAV payload is not a profile backup: ${validated.reason}` }
  }
  logEvent('info', 'webdav', `downloaded backup from ${parsed.origin}${parsed.pathname} (${String(validated.backup.files.length)} files)`)
  return { ok: true, status: response.status, backup: validated.backup }
}
