/**
 * / — parsing of pnpm's NDJSON progress stream.
 *
 * Installing a plugin spawns a child process, and the browser learns what is
 * happening by polling `GET /dsh-galaxy/status`. That means the human-unfriendly
 * stream pnpm writes on stdout has to become small, serializable
 * {@link ProgressPatch} objects on the way in.
 *
 * The stream is pnpm's `--reporter=ndjson` bole output: one JSON object per
 * line, e.g.
 *
 *   {"level":"debug","name":"pnpm:stage","stage":"resolution_started"}
 *   {"level":"debug","name":"pnpm:progress","packageId":"esbuild@0.21.5","status":"resolved"}
 *   {"level":"debug","name":"pnpm:fetching-progress","packageId":"esbuild@0.21.5","size":123,"downloaded":40}
 *   {"level":"debug","name":"pnpm:ignored-scripts","packageNames":["esbuild@0.21.5"]}
 *   {"level":"error","name":"pnpm","err":{"code":"ERR_PNPM_…","message":"…"}}
 *
 * Two properties are non-negotiable here, because this runs on the read side of
 * a live install:
 *
 *   - it never throws. An unparseable line, a JSON value of the wrong shape, a
 *     non-string field — every one is skipped so one odd event cannot break the
 *     UI. Do not add a `throw` to this file.
 *   - it is incremental. Chunk boundaries fall in the middle of lines; the
 *     parser instance buffers the remainder, so callers can pipe raw stdout
 *     chunks straight in without splitting lines themselves.
 *
 * The parser holds no state that survives across operations — a fresh parser
 * per install keeps the "seen packages" count meaningful.
 */

import type { Progress } from '../core/types.ts'

/** A partial update of the active operation's progress. */
export type ProgressPatch = Partial<Progress>

/**
 * pnpm stage names worth naming. The reporter uses a handful of enum-like
 * stage identifiers; unknown stages are ignored rather than guessed at.
 */
const STAGE_NAMES: Record<string, string> = {
  resolution_started: 'resolving',
  resolution_done: 'downloading',
  importing_started: 'linking',
  importing_done: 'linking',
}

/**
 * Monotonic order of the install pipeline. pnpm's reporters occasionally repeat
 * an earlier stage (a retry, or a per-package event arriving after a stage
 * line), and a progress bar that walks backwards reads as a bug.
 */
const PHASE_ORDER: Record<string, number> = {
  resolving: 0,
  downloading: 1,
  linking: 2,
  building: 3,
}

/** Move `current` to `next` only when `next` is a later stage. */
function forwardPhase(current: string | undefined, next: string): string {
  if (current === undefined) return next
  return (PHASE_ORDER[next] ?? 0) >= (PHASE_ORDER[current] ?? 0) ? next : current
}

/** True for a finite, non-negative number (counters are never negative here). */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** A non-empty trimmed string, or `undefined`. */
function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/**
 * Reduce pnpm's version-qualified package id (`esbuild@0.21.5`,
 * `@scope/pkg@1.2.3`, `registry.npmjs.org/lodash/4.17.21`) to the package name
 * a user recognises.
 *
 * The trailing semver-ish suffix is pinned down by a regex rather than the last
 * `@`, so a git spec (`github:owner/repo#sha`) or a path keeps its full text.
 */
export function barePackageName(raw: string): string {
  const spec = raw.trim().replace(/\/+$/u, '')
  if (spec === '') return ''
  const pinned = /^(.*?)@(\d[^@/]*)$/u.exec(spec)
  if (pinned !== null && pinned[1] !== '') return pinned[1]
  const pathish = /^(.+)\/\d+\.\d+[^/]*$/u.exec(spec)
  if (pathish !== null) {
    const tail = pathish[1].split('/').filter(Boolean).pop()
    if (tail !== undefined && tail !== '') return tail
  }
  if (spec.startsWith('@')) {
    const scoped = /^(@[^@/]+\/[^@/]+)@/u.exec(spec)
    if (scoped !== null) return scoped[1]
  }
  return spec
}

/** `pnpm:ignored-scripts` is surfaced verbatim; the galaxy does not interpret it. */
function ignoredScriptDetail(names: string[]): string {
  return `ignored build scripts: ${names.join(', ')}`
}

/**
 * Parse one NDJSON line into a {@link ProgressPatch}, or `undefined` when the
 * line carries nothing the status view can use.
 *
 * Recognises `resolution` / `fetch` / `download` phases, `downloaded` and
 * `size` counters, `currentPackage`, `done` / `total`, and `ignored-scripts`
 * events. Malformed input is skipped silently — never thrown.
 */
export function parseNdjsonLine(line: string): ProgressPatch | undefined {
  const trimmed = line.trim()
  if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined // a human line the ndjson reporter never emits
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined

  const event = parsed as Record<string, unknown>
  const name = asText(event.name)
  if (name === undefined) return undefined

  if (name === 'pnpm:stage') {
    const stage = asText(event.stage)
    if (stage === undefined) return undefined
    const known = STAGE_NAMES[stage]
    return known === undefined ? undefined : { phase: known }
  }

  if (name === 'pnpm:progress') {
    const status = asText(event.status)
    const packageId = asText(event.packageId)
    const patch: ProgressPatch = {}
    if (status === 'resolved') {
      patch.phase = 'resolving'
      if (packageId !== undefined) patch.currentPackage = barePackageName(packageId)
    } else if (status === 'fetched' || status === 'found_in_store') {
      patch.phase = 'downloading'
      if (packageId !== undefined) patch.currentPackage = barePackageName(packageId)
    } else {
      return undefined
    }
    const total = isCount(event.total) ? event.total : undefined
    if (total !== undefined) patch.total = total
    const done = isCount(event.done) ? event.done : undefined
    if (done !== undefined) patch.done = done
    return Object.keys(patch).length === 0 ? undefined : patch
  }

  if (name === 'pnpm:fetching-progress') {
    const patch: ProgressPatch = { phase: 'downloading' }
    const packageId = asText(event.packageId)
    if (packageId !== undefined) patch.currentPackage = barePackageName(packageId)
    if (isCount(event.downloaded)) patch.downloaded = event.downloaded
    if (isCount(event.size)) patch.size = event.size
    return patch
  }

  if (name === 'pnpm:lifecycle') {
    const workdir = asText(event.wd)
    const depPath = asText(event.depPath)
    const picked = workdir !== undefined ? barePackageName(workdir) : depPath !== undefined ? barePackageName(depPath) : undefined
    const patch: ProgressPatch = { phase: 'building' }
    if (picked !== undefined && picked !== '') patch.currentPackage = picked
    return patch
  }

  if (name === 'pnpm:stats') {
    return event.added === undefined && event.removed === undefined ? undefined : { phase: 'linking' }
  }

  if (name === 'pnpm:ignored-scripts') {
    // Display only: the interpretation of "which builds were ignored" belongs
    // to the install/approve-builds flow, not to the progress parser.
    const names: string[] = []
    const reported = event.packageNames ?? event.packages ?? event.packageIds
    if (Array.isArray(reported)) {
      for (const entry of reported) {
        const text = asText(entry)
        if (text === undefined) continue
        const bare = barePackageName(text)
        if (bare !== '' && !names.includes(bare)) names.push(bare)
      }
    }
    return names.length === 0 ? undefined : { detail: ignoredScriptDetail(names) }
  }

  if (name === 'pnpm' && asText(event.level) === 'error') {
    const error = asText(event.err)
    if (error !== undefined) return { detail: `pnpm error: ${error}` }
    const record = typeof event.err === 'object' && event.err !== null ? event.err as Record<string, unknown> : undefined
    const message = record === undefined ? undefined : asText(record.message)
    return message === undefined ? undefined : { detail: `pnpm error: ${message}` }
  }

  return undefined
}

/** An incremental line-oriented NDJSON reader. Feed it raw chunks. */
export interface NdjsonParser {
  /** Consume one stream chunk and return the patches its complete lines carry. */
  (chunk: string): ProgressPatch[]
  /** Patches held back because the line is still incomplete. */
  pending(): string
  /** Parse the trailing partial line, if any — call once the stream closes. */
  flush(): ProgressPatch[]
}

/**
 * Create an incremental parser.
 *
 * A chunk may end anywhere, including in the middle of a JSON object, so the
 * incomplete tail is buffered and prepended to the next chunk. Only complete
 * (`\n`-terminated) lines are parsed; `\r\n` output is fine because the parser
 * trims each line.
 */
export function createNdjsonParser(): NdjsonParser {
  let buffer = ''

  const parser = ((chunk: string): ProgressPatch[] => {
    const patches: ProgressPatch[] = []
    if (typeof chunk !== 'string' || chunk === '') return patches
    buffer += chunk

    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const patch = parseNdjsonLine(line)
      if (patch !== undefined) patches.push(patch)
      newline = buffer.indexOf('\n')
    }

    // A run of progress events can exceed Node's argument limits if it is kept
    // as a single unterminated line; drop what cannot be a JSON object anyway.
    if (buffer.length > 1_000_000) buffer = buffer.slice(-4096)
    return patches
  }) as NdjsonParser

  parser.pending = (): string => buffer

  parser.flush = (): ProgressPatch[] => {
    if (buffer.trim() === '') {
      buffer = ''
      return []
    }
    const line = buffer
    buffer = ''
    const patch = parseNdjsonLine(line)
    return patch === undefined ? [] : [patch]
  }

  return parser
}
