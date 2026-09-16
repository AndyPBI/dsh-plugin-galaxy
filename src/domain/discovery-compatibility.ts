/**
 * Discovery-time host-compatibility index.
 *
 * What this module owns:
 *   - the verdicts this module produces,
 *   - POST /dsh-galaxy/discovery-compatibility,
 *   - `<profile>/.dsh-galaxy/discovery-cache.json`,
 *   - the per-runtime in-process copy of those facts,
 *   - the plugin-card compatibility badges.
 *
 * The public catalog does not carry npm manifests, and fetching one per
 * catalog entry while the market opens would turn one request into a thousand.
 * So manifests are read on demand for the packages the client actually shows,
 * bounded by a small fan-out, with the successful public facts cached beside
 * the galaxy's own profile state. Only FACTS are cached, never verdicts: a
 * verdict depends on the DSH version of the process serving the page, and a
 * cached verdict would follow a host upgrade into a lie.
 */

import { join } from 'node:path'
import { readJsonFile, writeJsonAtomic } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import { fetchJson } from '../core/net.ts'
import { DISCOVERY_CACHE_FILE, ensureDir, galaxyDir, profileDir } from '../core/paths.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { HostCompatibility, NpmManifest } from '../core/types.ts'
import { deriveHostCompatibility, detectHostVersion, hostVersionInfo, installedVersionOf } from './compatibility.ts'

/** Cache key inside `GalaxyRuntime` for the per-mount index. */
export const DISCOVERY_INDEX_KEY = 'discovery.index'

/** Cache file schema tag; a mismatched tag is discarded rather than migrated. */
const CACHE_SCHEMA = 'dsh-plugin-galaxy/discovery-cache/v1'

/** Six hours: a manifest's dependency declarations move on a release cadence. */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

/** How long a failed lookup is remembered before it is retried. */
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000

/** After this many consecutive failures, the registry is treated as down. */
const OUTAGE_COOLDOWN_MS = 30 * 1000

/** Per-manifest request budget: long enough for a slow mirror, short enough to move on. */
const FETCH_TIMEOUT_MS = 8_000

/** Bounded fan-out; the npm registry is not a free resource. */
const CONCURRENCY = 8

/** Durable cache ceiling, so the file cannot grow without bound. */
const MAX_CACHE_ENTRIES = 2_000

/** Declarations longer than this are treated as malformed, not as ranges. */
const MAX_RANGE_LENGTH = 256

/** The small public subset of a manifest this index keeps. */
export interface DiscoveryFacts {
  version: string | null
  /** `dsh.hostVersion` — this plugin's own spelling. */
  hostVersion: string | null
  /** `dsh.engines.dsh` (or top-level `engines.dsh`) — the common spelling. */
  engineRange: string | null
  peerDependencies: Record<string, string>
}

interface CacheEntry {
  checkedAt: number
  facts: DiscoveryFacts
}

interface CacheFile {
  schema: string
  entries: Record<string, CacheEntry>
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function shortString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' || trimmed.length > MAX_RANGE_LENGTH ? null : trimmed
}

/** The facts an npm manifest contributes to a compatibility verdict. */
export function manifestFacts(value: unknown): DiscoveryFacts {
  const manifest = asObject(value) ?? {}
  const dsh = asObject(manifest.dsh)
  const peers = asObject(manifest.peerDependencies)
  const peerDependencies: Record<string, string> = {}
  for (const [dependency, rawRange] of Object.entries(peers ?? {})) {
    const range = shortString(rawRange)
    if (range !== null) peerDependencies[dependency] = range
  }
  const dshEngines = dsh === undefined ? undefined : asObject(dsh.engines)
  const topEngines = asObject(manifest.engines)
  return {
    version: shortString(manifest.version),
    hostVersion: dsh === undefined ? null : shortString(dsh.hostVersion),
    engineRange: shortString(dshEngines?.dsh) ?? shortString(topEngines?.dsh),
    peerDependencies,
  }
}

/**
 * Facts rebuilt into the manifest shape the evaluator consumes.
 *
 * Exported because this is where a captured field can silently fail to reach the
 * verdict: the cache stores facts, so anything the capture or the rebuild drops
 * is invisible to the comparator no matter what it understands.
 */
export function factsToManifest(name: string, facts: DiscoveryFacts): NpmManifest {
  const manifest: NpmManifest = { name, peerDependencies: facts.peerDependencies }
  if (facts.version !== null) manifest.version = facts.version
  const dsh: NonNullable<NpmManifest['dsh']> = {}
  if (facts.hostVersion !== null) dsh.hostVersion = facts.hostVersion
  if (facts.engineRange !== null) dsh.engines = { dsh: facts.engineRange }
  if (Object.keys(dsh).length > 0) manifest.dsh = dsh
  return manifest
}

function validFacts(value: unknown): value is DiscoveryFacts {
  const facts = asObject(value)
  if (facts === undefined) return false
  if (facts.version !== null && shortString(facts.version) !== facts.version) return false
  if (facts.hostVersion !== null && shortString(facts.hostVersion) !== facts.hostVersion) return false
  // Strict: a cache entry written before this field existed fails here and is
  // re-fetched instead of being read as "declares nothing".
  if (facts.engineRange !== null && shortString(facts.engineRange) !== facts.engineRange) return false
  const peers = asObject(facts.peerDependencies)
  if (peers === undefined) return false
  return Object.values(peers).every(range => shortString(range) === range)
}

/**
 * Read facts out of an npm registry answer.
 *
 * The registry is addressed without `/latest`, so a mirror may answer with a
 * full packument. Both shapes are accepted: a packument is reduced to the
 * manifest its `dist-tags.latest` names, and anything else is read as the
 * manifest itself.
 */
function factsFromPayload(payload: unknown): DiscoveryFacts | null {
  const record = asObject(payload)
  if (record === undefined) return null
  const versions = asObject(record.versions)
  const distTags = asObject(record['dist-tags'])
  if (versions !== undefined && distTags !== undefined) {
    const latest = shortString(distTags.latest)
    if (latest === null) return null
    const manifest = asObject(versions[latest])
    return manifest === undefined ? null : manifestFacts(manifest)
  }
  return manifestFacts(record)
}

/** Read an environment-bounded numeric setting. */
function numericSetting(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  if (trimmed === '') return fallback
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** The npm registry base in force, no trailing slash. */
function npmRegistryBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSHG_NPM_MIRROR
  const trimmed = typeof raw === 'string' ? raw.trim().replace(/\/+$/u, '') : ''
  return trimmed === '' ? 'https://registry.npmjs.org' : trimmed
}

/**
 * Bounded, durable lookup of npm manifests for host-compatibility forecasts.
 *
 * Instances are cheap and hold no global state: {@link instanceFor} keeps one
 * per {@link GalaxyRuntime} so two mounts in one process do not share a cache.
 */
export class DiscoveryManifestIndex {
  /** The profile directory the durable cache belongs to. */
  readonly dir: string
  /** The runtime this index was created for, when there was one. */
  readonly runtime: GalaxyRuntime | undefined

  private readonly profile: string
  private readonly entries = new Map<string, CacheEntry>()
  private readonly failures = new Map<string, number>()
  private readonly inflight = new Map<string, Promise<DiscoveryFacts | null>>()
  private loaded = false
  private dirty = false
  private consecutiveFailures = 0
  private unavailableUntil = 0

  constructor(profile: string, dir: string, runtime?: GalaxyRuntime) {
    this.profile = profile
    this.dir = dir.trim() === '' ? profileDir(profile) : dir
    this.runtime = runtime
  }

  /** `<profile>/.dsh-galaxy/discovery-cache.json`. */
  get cacheFile(): string {
    return join(galaxyDir(this.dir), DISCOVERY_CACHE_FILE)
  }

  /** TTL in force, overridable through `DSHG_DISCOVERY_TTL_MS`. */
  ttlMs(env: NodeJS.ProcessEnv = process.env): number {
    return numericSetting(env.DSHG_DISCOVERY_TTL_MS, DEFAULT_TTL_MS)
  }

  /** Load the durable cache once; a missing or invalid file means "no facts". */
  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const parsed = readJsonFile<Partial<CacheFile>>(this.cacheFile)
    const entries = asObject(parsed?.entries)
    if (parsed?.schema !== CACHE_SCHEMA || entries === undefined) return
    for (const [name, raw] of Object.entries(entries)) {
      const entry = asObject(raw)
      if (entry === undefined) continue
      const checkedAt = entry.checkedAt
      const facts = entry.facts
      if (typeof checkedAt !== 'number' || !validFacts(facts)) continue
      this.entries.set(name, { checkedAt, facts })
    }
  }

  /** Rewrite the durable cache, newest entries first and capped. */
  private persist(): void {
    try {
      const newest = [...this.entries.entries()]
        .sort(([, left], [, right]) => right.checkedAt - left.checkedAt)
        .slice(0, MAX_CACHE_ENTRIES)
      ensureDir(galaxyDir(this.dir), 0o700)
      const data: CacheFile = { schema: CACHE_SCHEMA, entries: Object.fromEntries(newest) }
      // `writeJsonAtomic` creates the temporary sibling 0600 and renames it, so
      // a crash never leaves a half-written cache for the next process to read.
      writeJsonAtomic(this.cacheFile, data)
    } catch (error) {
      // A read-only or full disk degrades this to in-memory lookups for the
      // life of the process; it must never fail the request.
      logEvent('warn', 'discovery-compatibility', `could not write the discovery cache: ${(error as Error).message}`)
    }
  }

  /** One manifest, from the cache when fresh, else from the npm registry. */
  private async factsFor(name: string, ttlMs: number): Promise<DiscoveryFacts | null> {
    const now = Date.now()
    const cached = this.entries.get(name)
    if (cached !== undefined && now - cached.checkedAt < ttlMs) return cached.facts
    if ((this.failures.get(name) ?? 0) > now) return null
    if (this.unavailableUntil > now) return null
    const pending = this.inflight.get(name)
    if (pending !== undefined) return await pending

    const request = (async (): Promise<DiscoveryFacts | null> => {
      try {
        const response = await fetchJson({
          url: `${npmRegistryBase()}/${encodeURIComponent(name)}`,
          headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-galaxy' },
          timeoutMs: FETCH_TIMEOUT_MS,
        })
        if (!response.ok) throw new Error(response.error ?? `HTTP ${response.status}`)
        const facts = factsFromPayload(response.body)
        if (facts === null) throw new Error('the npm registry answered with an unrecognised manifest')
        this.entries.set(name, { checkedAt: Date.now(), facts })
        this.dirty = true
        this.failures.delete(name)
        this.consecutiveFailures = 0
        return facts
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logEvent('warn', 'discovery-compatibility', `could not read the ${name} manifest: ${message}`)
        const failedAt = Date.now()
        // Failures are memory-only and short-lived: a mirror outage must not
        // become a durable "no requirement declared" verdict on disk.
        this.failures.set(name, failedAt + FAILURE_COOLDOWN_MS)
        this.consecutiveFailures += 1
        if (this.consecutiveFailures >= CONCURRENCY) this.unavailableUntil = failedAt + OUTAGE_COOLDOWN_MS
        return null
      } finally {
        this.inflight.delete(name)
      }
    })()
    this.inflight.set(name, request)
    return await request
  }

  /** Run `task` over `items` with a bounded number of concurrent requests. */
  private async runPool<T, R>(items: readonly T[], task: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const index = next
        next += 1
        results[index] = await task(items[index])
      }
    }
    const workers: Promise<void>[] = []
    for (let index = 0; index < Math.min(CONCURRENCY, items.length); index += 1) workers.push(worker())
    await Promise.all(workers)
    return results
  }

  /**
   * Host-compatibility verdicts for `names`, in the order first requested.
   *
   * Duplicate and blank names are collapsed. A package whose manifest cannot
   * be read yields `unknown` — never a fabricated verdict.
   */
  async lookup(names: string[]): Promise<HostCompatibility[]> {
    const unique: string[] = []
    const seen = new Set<string>()
    for (const raw of names) {
      if (typeof raw !== 'string') continue
      const name = raw.trim()
      if (name === '' || seen.has(name)) continue
      seen.add(name)
      unique.push(name)
    }
    this.load()
    const ttlMs = this.ttlMs()
    const factsList = await this.runPool(unique, async name => await this.factsFor(name, ttlMs))
    // Memoized per mount when a runtime is available (the version cannot change
    // while we run); this method is called on every discovery request.
    const hostVersion = (this.runtime === undefined
      ? detectHostVersion(this.dir)
      : hostVersionInfo(this.runtime))?.version ?? ''
    const results = unique.map((name, index): HostCompatibility => {
      const facts = factsList[index]
      if (facts === undefined || facts === null) {
        return { name, status: 'unknown', basis: 'none', reason: 'the npm manifest could not be read' }
      }
      // Peers are judged against the package actually installed here (cordis
      // 4.0.2), never against the DSH release.
      const compatibility = deriveHostCompatibility(factsToManifest(name, facts), hostVersion, {
        peerVersion: peer => installedVersionOf(peer, this.dir),
      })
      return { ...compatibility, name }
    })
    if (this.dirty) {
      this.dirty = false
      this.persist()
    }
    return results
  }

  /** The profile this index caches facts for, for log lines and diagnostics. */
  get profileName(): string {
    return this.profile
  }
}

/**
 * The index belonging to one mount.
 *
 * Stored in `runtime.cache('discovery.index')` rather than in module scope, so
 * a second mount in the same process gets its own facts and its own file.
 */
export function instanceFor(runtime: GalaxyRuntime): DiscoveryManifestIndex {
  const existing = runtime.cache<DiscoveryManifestIndex>(DISCOVERY_INDEX_KEY)
  if (existing !== undefined) return existing
  const index = new DiscoveryManifestIndex(runtime.config.profile, runtime.dir, runtime)
  runtime.setCache(DISCOVERY_INDEX_KEY, index)
  return index
}
