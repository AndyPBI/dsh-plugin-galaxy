/**
 * GitHub Gist transport for profile backups.
 *
 * The transport is the GitHub CLI (`gh`), spawned through
 * `node:child_process` `execFile` with an argument array — never a shell
 * string. Two consequences shape the security posture:
 *
 * - The token travels in the child's environment (`GH_TOKEN` / `GITHUB_TOKEN`)
 *   and never on the command line, where any local process could read it from
 *   the process table; no token is ever logged, and none is written to disk.
 * - User-supplied identifiers (the Gist id, the file name) are validated
 *   against a strict allowlist before they reach an argv slot, so a hostile
 *   value cannot turn a `gh` invocation into something else.
 *
 * The Gist id is additionally never interpolated into a URL by this module,
 * and a downloaded payload goes through `validateBackup` before it is handed
 * back, mirroring the WebDAV download path: restore only accepts real backups.
 *
 * Errors are classified into machine-readable {@link GistErrorCode} values so
 * the route can answer 400 (bad request/credentials/content) versus 502
 * (GitHub unreachable) and the UI can show a friendly localized message
 * instead of raw CLI noise.
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GistResult, ProfileBackup } from '../core/types.ts'
import { logEvent } from '../core/log.ts'
import { validateBackup } from './backup.ts'

/** The single file every galaxy profile backup Gist carries. */
export const GIST_FILENAME = 'dsh-plugin-galaxy-backup.json'
/** GitHub's hard limit for one Gist file (1 MB). */
export const GIST_MAX_BYTES = 1024 * 1024
/** Environment variable for a host-configured token (never read from disk). */
export const GIST_TOKEN_ENV = 'DSHG_GITHUB_TOKEN'
/** Default ceiling for one `gh` invocation. */
export const GIST_TIMEOUT_MS = 25_000

/** Gist ids are opaque base-36-ish strings; anything else is rejected. */
const GIST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u
/** File names handed to `gh --filename` must be a single safe path segment. */
const GIST_FILENAME_RE = /^[A-Za-z0-9._-]{1,80}$/u
/** Output caps: a wedged gh must not fill memory with its own noise. */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024

/** Machine-readable error codes the route and the client map to messages. */
export type GistErrorCode = 'auth' | 'notfound' | 'rate-limit' | 'invalid' | 'timeout' | 'network' | 'other'

/** Error carrying a stable code; the message stays human-readable. */
export class GistError extends Error {
  readonly code: GistErrorCode

  constructor(message: string, code: GistErrorCode = 'other') {
    super(message)
    this.name = 'GistError'
    this.code = code
  }
}

/** Classification of a thrown CLI/transport failure. */
export function gistErrorCode(error: unknown): GistErrorCode {
  return error instanceof GistError ? error.code : 'other'
}

/** Reference to a Gist returned by create/update. */
interface GistRef {
  id: string
  htmlUrl: string
}

/** Options accepted by every Gist operation. */
export interface GistOptions {
  /**
   * Token for this request only. When absent, the host-configured
   * environment token is used; the value is never persisted.
   */
  token?: string
  /** Caller-owned cancellation (route-level timeout). */
  signal?: AbortSignal
  /** Hard ceiling for one CLI invocation. */
  timeoutMs?: number
}

/* ------------------------------------------------------------------ *
 * Input validation
 * ------------------------------------------------------------------ */

/** Normalize a Gist id or a gist.github.com URL to a bare id. */
export function parseGistId(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw new GistError('a Gist id or URL is required', 'invalid')
  let candidate = trimmed
  try {
    const parsed = new URL(trimmed)
    if (parsed.hostname === 'gist.github.com' || parsed.hostname.endsWith('.gist.github.com')) {
      const parts = parsed.pathname.split('/').filter(part => part !== '')
      candidate = parts[parts.length - 1] ?? ''
    }
  } catch {
    // Not a URL — the allowlist below decides whether it is a bare id.
  }
  if (!GIST_ID_RE.test(candidate)) throw new GistError('invalid Gist id', 'invalid')
  return candidate
}

/** Validate the file name handed to `gh --filename`. */
function parseGistFilename(input: string): string {
  const trimmed = input.trim()
  if (!GIST_FILENAME_RE.test(trimmed)) throw new GistError('invalid Gist file name', 'invalid')
  return trimmed
}

/** Reject an empty or whitespace-bearing token before it reaches the child. */
function normalizeToken(raw: string): string {
  const token = raw.trim()
  if (token === '') throw new GistError('a GitHub token is required', 'auth')
  if (/\s/u.test(token)) throw new GistError('the GitHub token contains whitespace', 'invalid')
  if (token.length > 512) throw new GistError('the GitHub token is implausibly long', 'invalid')
  return token
}

/**
 * Resolve the token for one operation: an explicitly supplied token first,
 * then the host-configured environment token. Both live in memory only.
 */
export function resolveGistToken(options: GistOptions = {}): string {
  if (typeof options.token === 'string' && options.token.trim() !== '') return normalizeToken(options.token)
  const configured = process.env[GIST_TOKEN_ENV] ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (typeof configured === 'string' && configured.trim() !== '') return normalizeToken(configured)
  throw new GistError('a GitHub token is required', 'auth')
}

/* ------------------------------------------------------------------ *
 * `gh` invocation
 * ------------------------------------------------------------------ */

interface GhOutcome {
  ok: boolean
  stdout: string
  stderr: string
  /** Process exit code; `-1` when gh could not be spawned at all. */
  code: number
  /** True when the invocation had to be abandoned. */
  timedOut: boolean
  /** Set when `gh` is not installed / not on PATH. */
  missing: boolean
}

/** Outcome of an invocation the caller's signal cancelled. */
function abortedOutcome(): GhOutcome {
  return { ok: false, stdout: '', stderr: '', code: -1, timedOut: true, missing: false }
}

/** `gh` locations tried in order: PATH first (which is itself a safe argv). */
function ghCandidates(): string[] {
  const candidates = ['gh']
  try {
    candidates.push(join(homedir(), '.local', 'bin', 'gh'))
  } catch { /* a host without a home directory still gets the PATH lookup */ }
  return candidates
}

/** One `execFile` invocation of `gh`, bound by a hard timeout. */
function execGhOnce(
  executable: string,
  args: string[],
  stdin: string | undefined,
  token: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<GhOutcome> {
  return new Promise<GhOutcome>((resolveOutcome) => {
    let settled = false
    const finish = (outcome: GhOutcome): void => {
      if (settled) return
      settled = true
      resolveOutcome(outcome)
    }
    const child = execFile(
      executable,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_STDOUT_BYTES,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
      },
      (error, out, err) => {
        const failure = error as { code?: string | number | null; killed?: boolean } | null
        const code = failure === null
          ? 0
          : typeof failure.code === 'number'
            ? failure.code
            : failure.code === 'ETIMEDOUT' || failure.killed === true ? 124 : -1
        finish({
          ok: error === null,
          stdout: String(out ?? ''),
          stderr: String(err ?? ''),
          code,
          // A killed child here means the budget (or the caller's signal) ran
          // out — never a genuine `gh` failure, so it reads as a timeout.
          timedOut: failure?.killed === true || failure?.code === 'ETIMEDOUT',
          missing: failure?.code === 'ENOENT',
        })
      },
    )
    child.stdout?.on('error', () => { /* a closed read end is not fatal */ })
    child.stderr?.on('error', () => { /* the callback still reports the exit */ })
    if (signal !== undefined) {
      if (signal.aborted) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish(abortedOutcome())
        return
      }
      signal.addEventListener('abort', () => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish(abortedOutcome())
      }, { once: true })
    }
    if (child.stdin === null) {
      if (stdin !== undefined) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish(abortedOutcome())
      }
      return
    }
    child.stdin.on('error', () => { /* gh exiting early closes the pipe */ })
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

/** Patterns that mean "GitHub itself could not be reached". */
const NETWORK_PATTERNS = [
  'dial tcp',
  'no such host',
  'could not resolve',
  'connection refused',
  'network is unreachable',
  'connection reset',
  'i/o timeout',
  'tls handshake',
  'proxyconnect',
  'econnrefused',
]

function stderrSuggestsNetwork(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return NETWORK_PATTERNS.some(pattern => lower.includes(pattern))
}

/** Translate a failed invocation into a coded, human-readable error. */
function classifyGhFailure(outcome: GhOutcome): GistError {
  if (outcome.missing) {
    return new GistError('the GitHub CLI (gh) is not installed or not on PATH', 'other')
  }
  if (outcome.timedOut || outcome.code === 124) {
    return new GistError('the GitHub CLI did not answer in time', 'timeout')
  }
  const detail = (outcome.stderr.trim() === '' ? outcome.stdout.trim() : outcome.stderr.trim()).slice(0, 400)
  if (/bad credentials|401|authentication failed|invalid token|requires authentication/iu.test(detail)) {
    return new GistError('the GitHub token is invalid, expired or lacks the gist scope', 'auth')
  }
  if (/rate limit|403|secondary rate/iu.test(detail)) {
    return new GistError(`GitHub rejected the request (rate limit or insufficient scope): ${detail}`, 'rate-limit')
  }
  if (/could not find|not found|404/iu.test(detail)) {
    return new GistError('the requested Gist was not found', 'notfound')
  }
  if (/HTTP 422|validation failed/iu.test(detail)) {
    return new GistError(`GitHub rejected the request: ${detail}`, 'invalid')
  }
  if (stderrSuggestsNetwork(detail)) {
    return new GistError(`GitHub is unreachable: ${detail}`, 'network')
  }
  return new GistError(detail === '' ? `the GitHub CLI exited with code ${String(outcome.code)}` : `GitHub CLI failed: ${detail}`, 'other')
}

/** Whether an invocation counts as successful for a given operation. */
type GhSuccess = (outcome: GhOutcome) => boolean

/** Run one `gh` command, falling back to the per-user install location. */
async function runGh(
  args: string[],
  options: {
    stdin?: string
    token: string
    signal?: AbortSignal
    timeoutMs?: number
    action: string
    success: GhSuccess
  },
): Promise<GhOutcome> {
  const timeoutMs = options.timeoutMs ?? GIST_TIMEOUT_MS
  let missing: GhOutcome | null = null
  for (const candidate of ghCandidates()) {
    const outcome = await execGhOnce(candidate, args, options.stdin, options.token, timeoutMs, options.signal)
    if (outcome.missing) {
      missing = outcome
      continue
    }
    if (!options.success(outcome)) {
      const error = classifyGhFailure(outcome)
      logEvent('warn', 'gist', `${options.action} failed (${error.code}): ${error.message}`)
      throw error
    }
    return outcome
  }
  const error = classifyGhFailure(missing ?? {
    ok: false,
    stdout: '',
    stderr: '',
    code: -1,
    timedOut: false,
    missing: true,
  })
  logEvent('error', 'gist', `${options.action} could not run: ${error.message}`)
  throw error
}

/** Success predicate: exit code 0. */
const exitZero: GhSuccess = outcome => outcome.ok
/**
 * Success predicate for `gh gist view`: an empty result is an answer too, so
 * only a real error is a failure.
 */
const viewSuccess: GhSuccess = (outcome) => {
  if (outcome.ok) return true
  const detail = `${outcome.stdout}\n${outcome.stderr}`
  return /no files|not found/iu.test(detail) && !/authentication|bad credentials/iu.test(detail)
}

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

/**
 * Confirm a token is usable: `gh api user` succeeds only for an accepted
 * credential, and it is the cheapest call the CLI can make with one.
 * @throws {@link GistError} with a `code` for the caller to map to a status.
 */
export async function verifyGistToken(token: string, options: GistOptions = {}): Promise<boolean> {
  const resolved = normalizeToken(token)
  await runGh(['api', 'user'], {
    ...options,
    token: resolved,
    action: 'token verification',
    success: exitZero,
  })
  logEvent('info', 'gist', 'token verified')
  return true
}

/** Serialize a backup into the JSON document a Gist carries. */
function serializeBackup(backup: ProfileBackup): string {
  return `${JSON.stringify(backup, null, 2)}\n`
}

/** Inspect `gh gist create` output for the id, whatever representation it used. */
function gistRefFromOutput(stdout: string): GistRef | undefined {
  const trimmed = stdout.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { id?: unknown; html_url?: unknown; url?: unknown }
      const id = typeof parsed.id === 'string' ? parsed.id : undefined
      if (id !== undefined && GIST_ID_RE.test(id)) {
        const html = typeof parsed.html_url === 'string'
          ? parsed.html_url
          : typeof parsed.url === 'string' && !parsed.url.includes('api.github.com')
            ? parsed.url
            : `https://gist.github.com/${id}`
        return { id, htmlUrl: html }
      }
    } catch { /* fall through to the URL scan */ }
  }
  const match = /https:\/\/gist\.github\.com\/(?:[^/\s]+\/)?([A-Za-z0-9_-]{1,64})/u.exec(trimmed)
  if (match === null) return undefined
  const id = match[1]!
  return { id, htmlUrl: `https://gist.github.com/${id}` }
}

/**
 * Create a new private Gist carrying one backup file. The document is written
 * to the child's stdin — never as an argument — so the (credential-bearing)
 * payload does not appear in the process table.
 *
 * @throws {@link GistError} `invalid` when the document exceeds
 * {@link GIST_MAX_BYTES}.
 */
export async function createGist(backup: ProfileBackup, options: GistOptions = {}): Promise<GistResult> {
  const token = resolveGistToken(options)
  const content = serializeBackup(backup)
  if (!fitsGistLimit(content)) {
    throw new GistError(
      `backup is ${String(Buffer.byteLength(content, 'utf8'))} bytes and exceeds the GitHub Gist 1 MB limit`,
      'invalid',
    )
  }
  const filename = parseGistFilename(GIST_FILENAME)
  const outcome = await runGh(
    ['gist', 'create', '--filename', filename, '--desc', 'Plugin Galaxy profile backup', '-'],
    { ...options, stdin: content, token, action: 'Gist creation', success: exitZero },
  )
  const ref = gistRefFromOutput(outcome.stdout)
  if (ref === undefined) throw new GistError('GitHub returned no usable Gist reference', 'other')
  logEvent('info', 'gist', `created ${ref.id} (${String(Buffer.byteLength(content, 'utf8'))} bytes)`)
  return { ok: true, gistId: ref.id, gistUrl: ref.htmlUrl }
}

/**
 * Overwrite the backup file inside an existing Gist (its other files stay).
 * A create-on-edit is intentionally not attempted: an unknown id must fail
 * loudly instead of quietly making a second Gist.
 */
export async function updateGist(gistId: string, backup: ProfileBackup, options: GistOptions = {}): Promise<GistResult> {
  const token = resolveGistToken(options)
  const id = parseGistId(gistId)
  const content = serializeBackup(backup)
  if (!fitsGistLimit(content)) {
    throw new GistError(
      `backup is ${String(Buffer.byteLength(content, 'utf8'))} bytes and exceeds the GitHub Gist 1 MB limit`,
      'invalid',
    )
  }
  const filename = parseGistFilename(GIST_FILENAME)
  const outcome = await runGh(
    ['gist', 'edit', id, '--filename', filename, '-'],
    { ...options, stdin: content, token, action: 'Gist update', success: exitZero },
  )
  const ref = gistRefFromOutput(outcome.stdout) ?? { id, htmlUrl: `https://gist.github.com/${id}` }
  logEvent('info', 'gist', `updated ${ref.id} (${String(Buffer.byteLength(content, 'utf8'))} bytes)`)
  return { ok: true, gistId: ref.id, gistUrl: ref.htmlUrl }
}

/** Read the whole Gist as a `{ name: content }` map, or `undefined` on failure. */
async function readGistFiles(id: string, token: string, options: GistOptions): Promise<Record<string, string> | undefined> {
  try {
    const outcome = await runGh(
      ['gist', 'view', id, '--json', 'files'],
      { ...options, token, action: 'Gist listing', success: exitZero },
    )
    const parsed = JSON.parse(outcome.stdout) as { files?: unknown }
    if (!Array.isArray(parsed.files)) return undefined
    const files: Record<string, string> = {}
    for (const entry of parsed.files as unknown[]) {
      if (entry === null || typeof entry !== 'object') continue
      const record = entry as { filename?: unknown; text?: unknown }
      if (typeof record.filename === 'string' && typeof record.text === 'string') files[record.filename] = record.text
    }
    return files
  } catch (error) {
    logEvent('warn', 'gist', `could not list the Gist: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** Pick the backup file of a Gist: the canonical name first, then any `.json`. */
function pickGistFile(files: Record<string, string>): { name: string; content: string } | undefined {
  const preferred = files[GIST_FILENAME]
  if (typeof preferred === 'string') return { name: GIST_FILENAME, content: preferred }
  for (const [name, content] of Object.entries(files)) {
    if (name.toLowerCase().endsWith('.json')) return { name, content }
  }
  return undefined
}

/**
 * Download and strictly validate the backup file inside a Gist. The returned
 * document passed {@link validateBackup}, so the caller may preview it and
 * post it to `/dsh-galaxy/restore` without re-checking the shape.
 */
export async function readGist(gistId: string, token: string, options: GistOptions = {}): Promise<ProfileBackup> {
  const resolved = normalizeToken(token)
  const id = parseGistId(gistId)
  const filename = parseGistFilename(GIST_FILENAME)

  let content: string | undefined
  try {
    const outcome = await runGh(
      ['gist', 'view', id, '--filename', filename, '--raw'],
      { ...options, token: resolved, action: 'Gist read', success: viewSuccess },
    )
    if (outcome.stdout.trim() !== '') content = outcome.stdout
  } catch (error) {
    // A missing canonical file is recoverable when the Gist carries another
    // JSON document, so the listing fallback gets one chance; a network or
    // authentication failure is re-thrown unchanged.
    const missingFile = error instanceof GistError && error.code === 'notfound'
      && /not found|could not find|no files/iu.test(error.message)
    if (!missingFile) throw error
    logEvent('warn', 'gist', `no ${filename} in the Gist — falling back to the first JSON file`)
  }
  if (content === undefined) {
    const files = await readGistFiles(id, resolved, options)
    const picked = files === undefined ? undefined : pickGistFile(files)
    if (picked === undefined) throw new GistError(`the Gist carries no ${filename} backup file`, 'invalid')
    content = picked.content
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new GistError('the Gist backup is not valid JSON', 'invalid')
  }
  const validated = validateBackup(parsed)
  if (!validated.ok) throw new GistError(`the Gist payload is not a profile backup: ${validated.reason}`, 'invalid')
  logEvent('info', 'gist', `read ${id} (${String(validated.backup.files.length)} files)`)
  return validated.backup
}

/**
 * True when a serialized backup fits inside one Gist file.
 * Byte length, not character count: GitHub counts UTF-8 bytes.
 */
export function fitsGistLimit(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') <= GIST_MAX_BYTES
}
