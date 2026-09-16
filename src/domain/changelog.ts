/**
 * Update notes: what changed between an installed version and HEAD.
 *
 * Every byte of GitHub data comes from the catalog side's daily probe,
 * published as `updates.json` beside `plugins.json` (the origin is
 * `DSHG_UPDATES_ORIGIN`). The galaxy asks GitHub for nothing: anonymous REST
 * quota is shared per egress IP and already unreliable behind common proxies,
 * and this data is wanted by thousands of installations but produced perfectly
 * well once a day by one probe.
 *
 * What the catalog cannot know is where each user's installed version sits, so
 * slicing the commit tail at that boundary happens here: the same sha the
 * update check resolved (`current`) marks where "new" begins. A tail that does
 * not contain it means the range is wider than the tail, and the commits are
 * then simply the recent ones.
 *
 * The handler never throws: a dialog that cannot load its data shows a neutral
 * statement, not an error banner. A failed read returns an empty payload with
 * `truncated` set, which is the caller's signal that "nothing here" means
 * "nothing could be loaded".
 */

import { logEvent } from '../core/log.ts'
import { fetchJson } from '../core/net.ts'
import { specRepo } from '../core/profile.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { ChangelogPayload, CommitNote, ReleaseNote } from '../core/types.ts'
import { loadRegistry } from './registry.ts'
import { updatesOrigin } from './regions.ts'

/** The probe runs daily; re-checking hourly bounds staleness without churn. */
const NOTES_TTL_MS = 60 * 60 * 1000
const NOTES_CACHE_KEY = 'changelog.payload'
const TIMEOUT_MS = 15_000

/** What the dialog will actually render. */
const MAX_RELEASES = 10
const MAX_COMMITS = 30
const MAX_BODY_CHARS = 4000
const MAX_MESSAGE_CHARS = 500

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

/** Options accepted by {@link updateNotesFor}. */
export interface ChangelogOptions {
  /** Runtime owning the TTL cache; also supplies profile/dir when omitted. */
  runtime?: GalaxyRuntime
  /** Profile name, for the best-effort catalog lookup of an npm name. */
  profile?: string
  /** Resolved profile directory, for the best-effort catalog lookup. */
  dir?: string
  /** Installed sha/version: commits after it are the "new" tail. */
  current?: string | null
  /** Version the update would install, echoed back for the dialog header. */
  latest?: string | null
  /** Ignore the TTL cache. */
  force?: boolean
}

/** One entry of the probe artifact. */
interface RawEntry {
  release?: unknown
  releases?: unknown
  commits?: unknown
}

interface NotesFile {
  count?: unknown
  updates?: unknown
}

interface NotesCacheEntry {
  at: number
  url: string
  data: NotesFile
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Truncate `text`, reporting whether anything was cut. */
function clip(text: string, limit: number): { text: string; cut: boolean } {
  return text.length > limit ? { text: `${text.slice(0, limit)}…`, cut: true } : { text, cut: false }
}

/**
 * The update-notes document from the region's origin, TTL-cached.
 *
 * `null` means the document could not be read — the caller turns that into an
 * empty payload rather than an error, because absence of notes is the ordinary
 * condition of small plugins and a network failure must not look like one.
 */
export async function loadUpdateNotes(options: ChangelogOptions = {}): Promise<NotesFile | null> {
  const url = updatesOrigin()
  const runtime = options.runtime
  const cached = runtime?.cache<NotesCacheEntry>(NOTES_CACHE_KEY)
  if (options.force !== true
    && cached !== undefined
    && cached.url === url
    && Date.now() - cached.at < NOTES_TTL_MS) {
    return cached.data
  }
  try {
    const response = await fetchJson({
      url,
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-galaxy' },
      timeoutMs: TIMEOUT_MS,
    })
    if (!response.ok) {
      logEvent('warn', 'changelog', `update notes unavailable (HTTP ${response.status}) from ${url}`)
      return null
    }
    const body = asRecord(response.body)
    if (body === undefined) {
      logEvent('warn', 'changelog', `update notes payload is not an object (${url})`)
      return null
    }
    const data = body as NotesFile
    runtime?.setCache(NOTES_CACHE_KEY, { at: Date.now(), url, data } satisfies NotesCacheEntry)
    return data
  } catch (error) {
    logEvent('warn', 'changelog', `update notes lookup failed — ${(error as Error).message}`)
    return null
  }
}

/** Drop the cached document (region/proxy change, or a forced reload). */
export function invalidateUpdateNotes(runtime: GalaxyRuntime): void {
  runtime.caches.delete(NOTES_CACHE_KEY)
}

/**
 * Look an entry up by any of its keys.
 *
 * The catalog keys entries by the url as listed (author's casing preserved),
 * while the galaxy resolves repositories to lowercase, so the comparison is
 * case-insensitive: the two sides must never disagree over a capital letter.
 */
function entryFor(payload: NotesFile, keys: readonly string[]): RawEntry | undefined {
  const updates = asRecord(payload.updates)
  if (updates === undefined) return undefined
  for (const key of keys) {
    const direct = asRecord(updates[key])
    if (direct !== undefined) return direct
  }
  const lowered = new Set(keys.map(key => key.toLowerCase()))
  for (const [key, value] of Object.entries(updates)) {
    const entry = asRecord(value)
    if (entry !== undefined && lowered.has(key.toLowerCase())) return entry
  }
  return undefined
}

/**
 * Keys an entry may live under: the name itself, the repository URL it names,
 * and — best effort — the curated catalog's url for that npm package.
 *
 * The catalog lookup is what makes an npm-installed plugin resolvable at all:
 * its dependency key is a package name while the probe artifact is keyed by
 * repository URL. It is wrapped: an unreachable catalog means "no extra key",
 * never a failed dialog.
 */
async function candidateKeys(name: string, options: ChangelogOptions): Promise<string[]> {
  const keys: string[] = [name]
  if (REPO_RE.test(name)) keys.push(`https://github.com/${name}`)
  const profile = options.profile ?? options.runtime?.config.profile
  const dir = options.dir ?? options.runtime?.dir
  if (profile === undefined || dir === undefined) return keys
  try {
    const registry = await loadRegistry(profile, dir)
    const plugin = registry.plugins.find(entry => entry.name === name)
    const repo = typeof plugin?.url === 'string' ? specRepo(plugin.url) : undefined
    if (repo !== undefined) {
      const identity = repo.split('#')[0]
      keys.push(`https://github.com/${identity}`, identity)
    }
  } catch (error) {
    logEvent('info', 'changelog', `catalog lookup for ${name} failed — ${(error as Error).message}`)
  }
  return [...new Set(keys)]
}

/** Map the artifact's release object(s) onto {@link ReleaseNote}s. */
function mapReleases(entry: RawEntry): { items: ReleaseNote[]; truncated: boolean } {
  const raw: unknown[] = []
  if (Array.isArray(entry.release)) raw.push(...entry.release)
  else if (entry.release !== undefined && entry.release !== null) raw.push(entry.release)
  if (Array.isArray(entry.releases)) raw.push(...entry.releases)

  const items: ReleaseNote[] = []
  let truncated = raw.length > MAX_RELEASES
  for (const candidate of raw.slice(0, MAX_RELEASES)) {
    const record = asRecord(candidate)
    if (record === undefined) continue
    const body = asText(record.body) ?? ''
    const tag = asText(record.tag) ?? asText(record.name) ?? ''
    if (tag === '' && body === '') continue
    const clipped = clip(body, MAX_BODY_CHARS)
    truncated ||= clipped.cut
    const note: ReleaseNote = { tag, body: clipped.text }
    const name = asText(record.name)
    const publishedAt = asText(record.publishedAt)
    const url = asText(record.url)
    if (name !== undefined) note.name = name
    if (publishedAt !== undefined) note.publishedAt = publishedAt
    if (url !== undefined) note.url = url
    items.push(note)
  }
  return { items, truncated }
}

/** Map the artifact's commit tail onto {@link CommitNote}s. */
function mapCommits(entry: RawEntry): { items: CommitNote[]; truncated: boolean } {
  const raw = Array.isArray(entry.commits) ? entry.commits : []
  const items: CommitNote[] = []
  let truncated = raw.length > MAX_COMMITS
  for (const candidate of raw.slice(0, MAX_COMMITS)) {
    const record = asRecord(candidate)
    if (record === undefined) continue
    const sha = asText(record.sha)
    const message = asText(record.message)
    if (sha === undefined || message === undefined) continue
    const clipped = clip(message, MAX_MESSAGE_CHARS)
    truncated ||= clipped.cut
    const note: CommitNote = { sha, message: clipped.text }
    const date = asText(record.date)
    if (date !== undefined) note.date = date
    items.push(note)
  }
  return { items, truncated }
}

/**
 * Slice the commit tail at the installed sha.
 *
 * @returns the commits newer than `installed`. When the boundary is not found,
 *   the whole tail comes back: the range is wider than the tail (or history
 *   diverged), and the dialog labels the result "recent" rather than exact.
 */
export function sliceCommitsAt(items: readonly CommitNote[], installed: string | null | undefined): CommitNote[] {
  if (installed === null || installed === undefined || installed === '') return [...items]
  const newer: CommitNote[] = []
  for (const commit of items) {
    if (commit.sha === installed) return newer
    newer.push(commit)
  }
  return newer
}

/** The neutral payload: nothing to show, and optionally why. */
function emptyPayload(name: string, options: ChangelogOptions, truncated: boolean): ChangelogPayload {
  const payload: ChangelogPayload = { name, releases: [], commits: [] }
  if (options.current !== undefined && options.current !== null) payload.current = options.current
  if (options.latest !== undefined && options.latest !== null) payload.latest = options.latest
  if (truncated) payload.truncated = true
  return payload
}

/**
 * Everything the update dialog renders for one plugin, already resolved.
 *
 * Never throws. A plugin with neither notes nor commits gets an empty payload:
 * absence of release notes is the ordinary condition of small plugins, not a
 * defect.
 */
export async function updateNotesFor(name: string, options: ChangelogOptions = {}): Promise<ChangelogPayload> {
  const requested = name.trim()
  if (requested === '') return emptyPayload(name, options, true)
  try {
    const file = await loadUpdateNotes(options)
    if (file === null) return emptyPayload(requested, options, true)
    const entry = entryFor(file, await candidateKeys(requested, options))
    if (entry === undefined) {
      logEvent('info', 'changelog', `no release notes published for ${requested}`)
      return emptyPayload(requested, options, false)
    }
    const releases = mapReleases(entry)
    const commits = mapCommits(entry)
    const payload: ChangelogPayload = {
      name: requested,
      releases: releases.items,
      commits: sliceCommitsAt(commits.items, options.current),
    }
    if (options.current !== undefined && options.current !== null) payload.current = options.current
    if (options.latest !== undefined && options.latest !== null) payload.latest = options.latest
    if (releases.truncated || commits.truncated) payload.truncated = true
    return payload
  } catch (error) {
    logEvent('warn', 'changelog', `release notes for ${requested} failed — ${(error as Error).message}`)
    return emptyPayload(requested, options, true)
  }
}
