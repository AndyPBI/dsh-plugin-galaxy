/**
 * Protection and sync routes (group D).
 *
 * Route ownership: `GET /dsh-galaxy/backup`, `POST /dsh-galaxy/restore`,
 * `POST /dsh-galaxy/webdav`, `POST /dsh-galaxy/gist` — and no other file may
 * register these paths.
 *
 * Guards (contract §6):
 * - `/backup` is a download: `<a download>` navigations carry no Origin, so it
 *   uses `{ loopback: true }` alone. The payload can contain credentials.
 * - The three POST routes are mutations and use the router's default
 *   same-origin check plus the `install` mutation lock, because a restore
 *   rewrites the profile manifest and the sync routes can drive a restore.
 *
 * Status codes: 400 invalid payload, 403 untrusted that the router answers,
 * 500 readable message when the export itself fails, 502 when an outbound
 * WebDAV/GitHub transport fails.
 */

import type { ServerResponse } from 'node:http'
import {
  BACKUP_FILENAME,
  MAX_BACKUP_BYTES,
  backupManifestJson,
  createProfileBackup,
  downloadWebdav,
  mergeRestoreManifest,
  secretFileCount,
  uploadWebdav,
  validateBackup,
} from '../domain/backup.ts'
import type { RestoreManifestMerge, WebdavResult } from '../domain/backup.ts'
import {
  GistError,
  createGist,
  gistErrorCode,
  readGist,
  updateGist,
  verifyGistToken,
} from '../domain/gist.ts'
import type { GistErrorCode } from '../domain/gist.ts'
import { asRecord, readJsonBody, sendAttachment, sendJson } from '../core/http.ts'
import { writeFileAtomic, writeJsonAtomic } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import { GALAXY_DIR_NAME, PRESETS_FILE, STATE_FILE } from '../core/paths.ts'
import { readManifestDeps, writeProfileManifest } from '../core/profile.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { GistResult, ProfileBackup } from '../core/types.ts'
import { createProfileSnapshot } from '../domain/snapshot.ts'
import { join } from 'node:path'
import type { Router } from './router.ts'

/** /: the route-level ceiling for one Gist action. */
const GIST_ROUTE_TIMEOUT_MS = 25_000
/** Body ceiling: a backup is validation-capped, the envelope needs headroom. */
const RESTORE_BODY_MAX_BYTES = MAX_BACKUP_BYTES + 64 * 1024
/** Sync payloads carry a URL, credentials and at most one backup document. */
const SYNC_BODY_MAX_BYTES = MAX_BACKUP_BYTES + 16 * 1024

/** Gist outcomes that describe the *request*; everything else is upstream. */
const GIST_REQUEST_CODES: ReadonlySet<GistErrorCode> = new Set<GistErrorCode>(['invalid', 'auth'])

/** Actions accepted by `POST /dsh-galaxy/gist`. */
type GistAction = 'create' | 'update' | 'read' | 'verify'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Bilingual failure text with a timeout-aware suffix. The message is the only
 * thing the operator sees, so it names what failed and what to check.
 */
function failureMessage(what: string, error: unknown): string {
  const detail = messageOf(error)
  const timedOut = error instanceof Error && error.name === 'AbortError'
  const suffix = timedOut ? `（超时 / timed out after ${String(GIST_ROUTE_TIMEOUT_MS / 1000)}s）` : ''
  return `${what}失败 / ${what} failed: ${detail}${suffix}`
}

/* ------------------------------------------------------------------ *
 * GET /dsh-galaxy/backup
 * ------------------------------------------------------------------ */

function handleBackup(runtime: GalaxyRuntime, response: ServerResponse): void {
  const backup = createProfileBackup(runtime.config.profile, runtime.config.profileDirectory)
  // Pretty-printed: the artifact is meant to be read and hand-edited.
  const body = `${JSON.stringify(backup, null, 2)}\n`
  logEvent('info', 'backup', `exported ${String(backup.files.length)} file(s), ${String(secretFileCount(backup))} credential file(s)`)
  sendAttachment(response, BACKUP_FILENAME, 'application/json; charset=utf-8', body)
}

/* ------------------------------------------------------------------ *
 * POST /dsh-galaxy/restore
 * ------------------------------------------------------------------ */

/** Payload of a successful restore. */
interface RestorePayload extends RestoreManifestMerge {
  /** True — present so the client can branch on one field. */
  ok: true
  /** Informational count of credential-carrying files in the backup. */
  secretFileCount: number
  /** Total dependency entries in the merged manifest. */
  dependencies: Record<string, string>
  /** Recovery snapshot taken before the write, when one could be taken. */
  snapshot?: string
  /** Galaxy-owned documents written back from the backup. */
  files: string[]
}

/**
 * Profile-relative documents a restore writes back.
 *
 * A restore is deliberately NOT a whole-directory overwrite: only documents
 * the galaxy itself owns (or the profile's own patch layer) are replaced, so a
 * backup can never inject arbitrary files into the profile.
 */
const RESTORABLE_FILES: ReadonlySet<string> = new Set([
  `${GALAXY_DIR_NAME}/${STATE_FILE}`,
  `${GALAXY_DIR_NAME}/${PRESETS_FILE}`,
  'cordis.patch.yml',
])

async function handleRestore(runtime: GalaxyRuntime, raw: Record<string, unknown>): Promise<RestorePayload> {
  const validated = validateBackup(raw.backup)
  if (!validated.ok) {
    logEvent('warn', 'restore', `rejected backup payload: ${validated.reason}`)
    throw new Error(`invalid backup / 备份无效: ${validated.reason}`)
  }
  const backup = validated.backup
  const manifest = backupManifestJson(backup)
  if (manifest === undefined) throw new Error('invalid backup / 备份无效: package.json is missing')

  const profile = runtime.config.profile
  const dir = runtime.config.profileDirectory

  // The mutation lock is held by the caller: a restore rewrites the profile
  // manifest, so it must not interleave with an install or another restore.
  //
  // Recovery first: whatever this restore replaces must be recoverable even if
  // a later write in this same call fails.
  let snapshot: string | undefined
  try {
    snapshot = createProfileSnapshot(profile, dir, runtime.config.maxSnapshots).id
  } catch (error) {
    // A profile whose manifest is unreadable still deserves the parts of the
    // restore that can be applied; the caller is told there is no undo point.
    logEvent('warn', 'restore', `pre-restore snapshot unavailable: ${(error as Error).message}`)
  }

  // Dependencies merge over the profile's OWN raw map (in-box bundles
  // included), never over the filtered community view.
  const merged = mergeRestoreManifest(backup, readManifestDeps(profile, dir))
  writeProfileManifest(profile, (target) => {
    target.dependencies = { ...merged.dependencies }
  }, dir)

  // Galaxy-owned documents, restricted to the allowlist above. Paths were
  // already checked for traversal by validateBackup.
  const files: string[] = []
  for (const file of backup.files) {
    if (!RESTORABLE_FILES.has(file.path)) continue
    const target = join(dir, file.path)
    if (file.type === 'json') writeJsonAtomic(target, file.json)
    else writeFileAtomic(target, `${(file.lines ?? []).join('\n')}\n`)
    files.push(file.path)
  }

  logEvent(
    'info',
    'restore',
    `restored ${String(merged.restored.length)} dependency spec(s), ${String(files.length)} document(s), skipped ${String(merged.skipped.length)}`,
  )
  return {
    ok: true,
    dependencies: merged.dependencies,
    restored: merged.restored,
    skipped: merged.skipped,
    secretFileCount: secretFileCount(backup),
    files,
    ...(snapshot === undefined ? {} : { snapshot }),
  }
}

/* ------------------------------------------------------------------ *
 * POST /dsh-galaxy/webdav
 * ------------------------------------------------------------------ */

interface WebdavPayload {
  ok: boolean
  status?: number
  backup?: ProfileBackup
  error?: string
}

async function handleWebdav(runtime: GalaxyRuntime, raw: Record<string, unknown>): Promise<WebdavPayload> {
  const action = raw.action
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  const username = typeof raw.username === 'string' ? raw.username : ''
  const password = typeof raw.password === 'string' ? raw.password : ''
  if (url === '') throw new Error('a WebDAV URL is required / 需要 WebDAV 地址')
  if (action !== 'upload' && action !== 'download') {
    throw new Error(`unknown WebDAV action ${JSON.stringify(action ?? null)} / 未知的 WebDAV 操作`)
  }

  const fail = (code: string, result: WebdavResult): WebdavPayload => {
    const error = result.error ?? 'WebDAV transport failed'
    logEvent('warn', 'webdav', `${code}: ${error}`)
    return {
      ok: false,
      ...(result.status === undefined ? {} : { status: result.status }),
      error: `WebDAV ${code}失败 / WebDAV ${code} failed: ${error}`,
    }
  }

  if (action === 'upload') {
    const supplied = raw.backup
    if (supplied === undefined) {
      // No explicit document: upload the current profile configuration.
      const backup = createProfileBackup(runtime.config.profile, runtime.config.profileDirectory)
      const result = await uploadWebdav({ url, username, password, backup })
      return result.ok ? { ok: true, ...(result.status === undefined ? {} : { status: result.status }) } : fail('上传 / upload', result)
    }
    const validated = validateBackup(supplied)
    if (!validated.ok) throw new Error(`invalid backup / 备份无效: ${validated.reason}`)
    const result = await uploadWebdav({ url, username, password, backup: validated.backup })
    return result.ok ? { ok: true, ...(result.status === undefined ? {} : { status: result.status }) } : fail('上传 / upload', result)
  }

  // Download: the validated document is returned for the client to preview;
  // the real restore is a separate POST to /dsh-galaxy/restore.
  const result = await downloadWebdav({ url, username, password })
  if (!result.ok || result.backup === undefined) return fail('下载 / download', result)
  return { ok: true, ...(result.status === undefined ? {} : { status: result.status }), backup: result.backup }
}

/* ------------------------------------------------------------------ *
 * POST /dsh-galaxy/gist
 * ------------------------------------------------------------------ */

/** Payload of a gist action: a transport result plus the downloaded backup. */
interface GistPayload extends GistResult {
  /** Present for `read`: the validated backup for the client to preview. */
  backup?: ProfileBackup
}

function gistFailure(error: unknown, action: string): { status: number; payload: GistPayload } {
  const code = gistErrorCode(error)
  const message = failureMessage(`Gist ${action}`, error)
  logEvent('warn', 'gist', `${action} failed (${code}): ${message}`)
  if (GIST_REQUEST_CODES.has(code)) return { status: 400, payload: { ok: false, error: message } }
  return { status: 502, payload: { ok: false, error: message } }
}

/** Collect the profile configuration, reporting a collection failure as 400. */
function gistBackup(runtime: GalaxyRuntime): ProfileBackup {
  try {
    return createProfileBackup(runtime.config.profile, runtime.config.profileDirectory)
  } catch (error) {
    throw new GistError(messageOf(error), 'invalid')
  }
}

async function handleGistAction(
  runtime: GalaxyRuntime,
  action: GistAction,
  raw: Record<string, unknown>,
  token: string,
  signal: AbortSignal,
): Promise<GistPayload> {
  const gistId = typeof raw.gistId === 'string' ? raw.gistId : ''
  switch (action) {
    case 'verify': {
      await verifyGistToken(token, { signal })
      return { ok: true }
    }
    case 'create': {
      return await createGist(gistBackup(runtime), { token, signal })
    }
    case 'update': {
      if (gistId.trim() === '') throw new GistError('a Gist id is required for update / 更新需要 Gist ID', 'invalid')
      return await updateGist(gistId, gistBackup(runtime), { token, signal })
    }
    case 'read': {
      if (gistId.trim() === '') throw new GistError('a Gist id is required for read / 读取需要 Gist ID', 'invalid')
      const backup = await readGist(gistId, token, { signal })
      return { ok: true, backup }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/**
 * Register the four protection routes on the galaxy router.
 *
 * The registrar owns only its own paths; every cross-module call goes through
 * the contract §5 signatures.
 */
export function registerProtectionRoutes(router: Router, runtime: GalaxyRuntime): void {
  router.get('/dsh-galaxy/backup', ({ response }) => {
    try {
      handleBackup(runtime, response)
    } catch (error) {
      const message = failureMessage('备份导出 / profile export', error)
      logEvent('error', 'backup', message)
      sendJson(response, 500, { error: message })
    }
  }, { loopback: true })

  router.post('/dsh-galaxy/restore', async ({ request, response }) => {
    let raw: Record<string, unknown> | undefined
    try {
      raw = asRecord(await readJsonBody(request, RESTORE_BODY_MAX_BYTES))
    } catch (error) {
      // Unreadable or oversized body: a request problem, so 400 — the router's
      // own fallback would turn it into a 500.
      return sendJson(response, 400, { error: failureMessage('备份恢复请求 / restore request', error) })
    }
    if (raw === undefined) return sendJson(response, 400, { error: 'a JSON body is required / 需要 JSON 请求体' })
    try {
      const applied = await runtime.locks.withLock('install', 'restore', async () => {
        // A restore invalidates any pending rollback: the manifest it would
        // undo no longer exists once this completes.
        runtime.pendingRollbacks.clear()
        return await handleRestore(runtime, raw)
      })
      sendJson(response, 200, applied)
    } catch (error) {
      const message = failureMessage('备份恢复 / profile restore', error)
      logEvent('warn', 'restore', message)
      sendJson(response, 400, { error: message })
    }
  })

  router.post('/dsh-galaxy/webdav', async ({ request, response }) => {
    let raw: Record<string, unknown> | undefined
    try {
      raw = asRecord(await readJsonBody(request, SYNC_BODY_MAX_BYTES))
    } catch (error) {
      return sendJson(response, 400, { error: failureMessage('WebDAV 请求 / request', error) })
    }
    if (raw === undefined) return sendJson(response, 400, { error: 'a JSON body is required / 需要 JSON 请求体' })
    try {
      const result = await handleWebdav(runtime, raw)
      sendJson(response, result.ok ? 200 : 502, result)
    } catch (error) {
      // A bad payload never reached the network: that is a 400, not a gateway
      // failure — handleWebdav only throws for shape/argument problems.
      const message = failureMessage('WebDAV 请求 / request', error)
      logEvent('warn', 'webdav', message)
      sendJson(response, 400, { error: message })
    }
  })

  router.post('/dsh-galaxy/gist', async ({ request, response }) => {
    // One budget for the whole action, including backup collection: the
    // controller also aborts the underlying `gh` child.
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error(`Gist operation timed out after ${String(GIST_ROUTE_TIMEOUT_MS)}ms`))
    }, GIST_ROUTE_TIMEOUT_MS)
    timer.unref?.()
    let action: GistAction = 'verify'
    let raw: Record<string, unknown> | undefined
    try {
      raw = asRecord(await readJsonBody(request, SYNC_BODY_MAX_BYTES))
      if (raw === undefined) {
        sendJson(response, 400, { error: 'a JSON body is required / 需要 JSON 请求体' })
        return
      }
      const requested = raw.action
      if (requested !== 'create' && requested !== 'update' && requested !== 'read' && requested !== 'verify') {
        sendJson(response, 400, { error: `unknown Gist action ${JSON.stringify(requested ?? null)} / 未知的 Gist 操作` })
        return
      }
      action = requested
      const token = typeof raw.token === 'string' ? raw.token.trim() : ''
      if (token === '') {
        sendJson(response, 400, { error: 'a GitHub token is required / 需要 GitHub token' })
        return
      }
      const payload = await handleGistAction(runtime, action, raw, token, controller.signal)
      sendJson(response, 200, payload)
    } catch (error) {
      const { status, payload } = gistFailure(error, action)
      sendJson(response, status, payload)
    } finally {
      clearTimeout(timer)
    }
  })
}
