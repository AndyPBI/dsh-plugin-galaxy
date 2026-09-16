/**
 * The single client access point to the /dsh-galaxy host routes.
 *
 * Every request goes to `/dsh-galaxy/...` on the same origin, with
 * `credentials: 'same-origin'` and a JSON body for writes. Non-2xx responses
 * become a `GalaxyApiError` carrying the status and the parsed payload, so the
 * views can render the host's own error text instead of a bare HTTP code.
 *
 * The response types are re-declared here on purpose: `src/core/types.ts` is
 * server code and must never enter the browser bundle.
 */

/* ------------------------------------------------------------------ *
 * Shared vocabulary
 * ------------------------------------------------------------------ */

/** Locale dictionary: flat key -> text. */
export type Dict = Record<string, string>

/** Translate one key, interpolating `{name}` placeholders from `params`. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/* ------------------------------------------------------------------ *
 * Config enums
 * ------------------------------------------------------------------ */

export type Channel = 'stable' | 'beta' | 'dev'
export type Region = 'global' | 'china'

/* ------------------------------------------------------------------ *
 * Catalog
 * ------------------------------------------------------------------ */

/** One installable entry of the curated catalog. */
export interface RegistryPlugin {
  /** npm package name (or `github:` spec for git-only entries). */
  name: string
  /** Source spec accepted by `dsh plugin add`. */
  url?: string
  npm?: string
  tarball?: string
  owner?: string
  category?: string
  description?: string
  stars?: number
  downloads?: number
  install?: string
  added?: string
  /** The catalog row's own stable key (`owner/name`), when it ships one. */
  key?: string
  /** Composite recommendation score (0–100) from the catalog's own pipeline. */
  score?: number
  /** `S` / `A` / `B` / `C`, sliced by distribution on the site side. */
  band?: string
  scoreVersion?: string
  /** Per-dimension contribution, for the "why recommended" tooltip. */
  scoreParts?: Record<string, number>
  /** Why an editor pinned this entry despite a low formula score. */
  pinReason?: string
  /**
   * This plugin's page on the operator's website (see `domain/site.ts`).
   * Present only when a site is configured or the catalog came from one.
   */
  siteUrl?: string
  deprecated?: boolean
  replacement?: string
  screenshots?: string[]
  /** Free-form catalog comments rendered in the comments modal. */
  comments?: string
  /** Declared host version range, when the catalog publishes one. */
  hostVersion?: string
  homepage?: string
}

/** Catalog payload handed to the browser. */
/** The catalog's ordered recommendation list (see docs/site-linkage.md). */
export interface RegistryRanking {
  version: string
  generatedAt?: string
  /** Entries to show at once; `top` is longer so installed ones can be skipped. */
  window?: number
  top: string[]
  pins?: Array<{ key: string; reason: string }>
}

export interface Registry {
  plugins: RegistryPlugin[]
  /** Recommendations, when the catalog ships them. */
  ranking?: RegistryRanking
  categories?: string[]
  updated?: string
  count?: number
  /** Present when the payload came from a local fixture. */
  source?: string
}

/** Envelope of `GET /dsh-galaxy/registry`. */
export interface RegistryEnvelope {
  registry?: Registry
  hostVersion?: string
}

/* ------------------------------------------------------------------ *
 * Installed inventory
 * ------------------------------------------------------------------ */

export type InstallKind = 'npm' | 'git' | 'local' | 'tarball' | 'alias' | 'unknown'

/** One dependency of the managed profile. */
export interface InstalledPlugin {
  name: string
  version?: string
  /** Raw dependency spec recorded in the profile manifest. */
  spec: string
  kind: InstallKind
  /** True when the package is part of the profile's bundle stack. */
  bundle: boolean
  /** True when the user switched the plugin off. */
  disabled: boolean
  /** True when the package ships a DSH client bundle. */
  client: boolean
  /** Repository identity parsed from a git spec, when present. */
  repo?: string
}

/** Activation state of one plugin inside the running host. */
export interface ActivationState {
  name: string
  /** live = loaded in the current host process; pending = restart required. */
  state: 'live' | 'pending' | 'disabled' | 'absent'
  /** True when the plugin came from the hot-mount layer. */
  hot?: boolean
}

/** One bundle row of the user patch layer. */
export interface PatchRow {
  id: string
  disabled: boolean
  forced: boolean
  inserts: string[]
}

/** Read-only view of the user patch layer. */
export interface PatchState {
  exists: boolean
  rows: PatchRow[]
  /** Package names referenced by `insert` entries (uninstall guard). */
  referenced: string[]
  /** True when the patch file could not be parsed. */
  unreadable: boolean
}

/** Payload of `GET /dsh-galaxy/installed`. */
export interface InstalledPayload {
  profile: string
  installed: InstalledPlugin[]
  repoIdentities: Record<string, string>
  repoHints: Record<string, string>
  present: string[]
  activation: ActivationState[]
  live: string[]
  disabled: string[]
  groups: Record<string, string[]>
  groupOrder: string[]
  notes: Record<string, string>
  favorites: string[]
  bundles: string[]
  patch: PatchState
  diagnostics: DiagnosticReport
}

/* ------------------------------------------------------------------ *
 * Updates and changelogs
 * ------------------------------------------------------------------ */

/** Hint describing an available git→npm migration. */
export interface SourceMigrationHint {
  from: string
  to: string
  packageName: string
}

/** Why an update is or is not available for one plugin. */
export interface UpdateStatus {
  name: string
  /** `npm` = registry version, `git` = HEAD moved, `restore` = local restore. */
  kind: 'npm' | 'git' | 'restore' | 'local' | 'unknown'
  current?: string
  latest?: string
  updateAvailable: boolean
  channelSwitch?: Channel
  /** True when the recorded spec must be rewritten before updating. */
  restoreRequired?: boolean
  sourceMigration?: SourceMigrationHint
  reason?: string
  checkedAt: number
}

/** One release note block of a changelog. */
export interface ReleaseNote {
  tag: string
  name?: string
  publishedAt?: string
  url?: string
  body: string
}

/** One commit summary of a changelog. */
export interface CommitNote {
  sha: string
  message: string
  date?: string
}

/** Changelog payload for one plugin. */
export interface ChangelogPayload {
  name: string
  current?: string
  latest?: string
  releases: ReleaseNote[]
  commits: CommitNote[]
  truncated?: boolean
}

/* ------------------------------------------------------------------ *
 * Compatibility
 * ------------------------------------------------------------------ */

/** Result of a host-compatibility forecast for one candidate package. */
export interface HostCompatibility {
  name: string
  status: 'compatible' | 'incompatible' | 'unknown'
  basis: 'manifest' | 'peer' | 'host-version' | 'none'
  requirement?: string
  declarations?: Record<string, string>
  reason?: string
}

/* ------------------------------------------------------------------ *
 * Operations and status
 * ------------------------------------------------------------------ */

export type OperationKind = 'install' | 'update' | 'uninstall' | 'migrate' | 'restore' | 'order' | 'self-uninstall'

export type OperationState = 'queued' | 'running' | 'input' | 'done' | 'warned' | 'failed' | 'cancelled'

export type OperationBucket = 'busy' | 'ok' | 'attention'

/** Progress of the active operation. */
export interface Progress {
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
  seconds?: number
  error?: string
  cancelling?: boolean
  /** Tail of the child's own output, newest last (bounded). */
  lines?: string[]
}

/** */
export interface PnpmProbe {
  ok: boolean
  path?: string
  version?: string
  provisioned?: boolean
  hint?: string
}

/** Whether restarting the host is currently possible. */
export interface RestartCapability {
  allowed: boolean
  reason?: string
  supervisor?: string
  debugger: boolean
  scheduled: boolean
}

/** */
export interface RestartSchedule {
  scheduled: boolean
  reason?: string
  helperPid?: number
  boot?: string
}

/** Payload of `GET /dsh-galaxy/status`. */
export interface GalaxyStatus {
  boot: string
  version: string
  channel: Channel
  region: Region
  profile: string
  busy: boolean
  progress: Progress
  pnpm: PnpmProbe
  restart: RestartCapability
  installed?: string[]
  /** The host release this profile was built for, when it could be read. */
  hostVersion?: string | null
  /** Where `hostVersion` came from (`env` | `profile` | `anchor`). */
  hostVersionSource?: string | null
}

/** Client-side record of one change operation. */
export interface OperationRecord {
  id: string
  kind: OperationKind
  name: string
  url?: string
  state: OperationState
  bucket: OperationBucket
  percent?: number
  detail?: string
  conflicts?: string[]
  reason?: string
  blockedBuilds?: string[]
  needsRefresh?: boolean
  startedAt: number
  finishedAt?: number
}

/* ------------------------------------------------------------------ *
 * Backup / sync
 * ------------------------------------------------------------------ */

/** One file inside a portable backup. */
export interface BackupFile {
  path: string
  type: 'json' | 'lines'
  json?: unknown
  lines?: string[]
  /** True when the file is known to carry credentials. */
  secret?: boolean
}

/** Portable profile configuration backup. */
export interface ProfileBackup {
  /** Only this plugin's own format: `restore` rejects anything else. */
  format: 'dsh-galaxy-backup'
  version: string
  createdAt: string
  profile: string
  files: BackupFile[]
  secretFileCount?: number
  /** Installed package list, informational (never restored as-is). */
  packages?: Record<string, string>
}

/** */
export interface GistResult {
  ok: boolean
  gistId?: string
  gistUrl?: string
  error?: string
}

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

export interface PeerMismatch {
  name: string
  requirement: string
  resolved?: string
  verdict: 'satisfied' | 'mismatch' | 'missing' | 'unknown'
}

export interface DiagnosticFinding {
  level: 'info' | 'warn' | 'error'
  code: string
  message: string
  names?: string[]
}

/** */
export interface DiagnosticReport {
  profile: string
  hostVersion: string
  generatedAt: string
  summary: { errors: number; warnings: number; packages: number; bundles: number }
  bundles: { name: string; resolved: boolean; reason?: string }[]
  peerMismatches: PeerMismatch[]
  duplicateNames: string[]
  findings: DiagnosticFinding[]
}

/* ------------------------------------------------------------------ *
 * Snapshots and presets
 * ------------------------------------------------------------------ */

/** One captured file inside a profile snapshot. */
export interface SnapshotFile {
  /** Profile-relative path, e.g. `package.json`. */
  path: string
  json?: unknown
  lines?: string[]
  /** True when the file did not exist at capture time (v2 explicit absence). */
  absent?: boolean
}

/** Versioned capture of the profile's three config files. */
export interface ProfileSnapshot {
  format: 'dsh-plugin-galaxy-snapshot'
  version: 2
  id: string
  createdAt: number
  files: SnapshotFile[]
}

/** A named composition (bundle order + disabled set). */
export interface Preset {
  name: string
  bundleOrder: string[]
  disabled: string[]
  createdAt: number
}

/** Result of a bundle-order write. */
export interface BundleOrderResult {
  ok: boolean
  bundles: string[]
  snapshot?: string
  reason?: string
}

/** Current and candidate bundle order (bundle-order view). */
export interface BundleStack {
  /** Bundle order recorded in `dsh.profile.bundles`. */
  current: string[]
  /** Community bundles present in the manifest but not ordered. */
  unordered: string[]
  /** Candidate order after a merge attempt. */
  merged: string[]
}

/** One theme bundle offered by the Themes tab. */
export interface ThemeInfo {
  name: string
  active: boolean
  installed: boolean
  description?: string
  swatch?: string
}

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

/** One mutation of the named-group store (`POST /dsh-galaxy/groups`). */
export type GroupAction = 'create' | 'rename' | 'delete' | 'set-members' | 'toggle'

/** Payload of one group mutation; unused members are omitted from the body. */
export interface GroupPayload {
  /** Target group name (every action except `create`). */
  name?: string
  /** New group name for `rename`. */
  newName?: string
  /** Member package names for `set-members`. */
  members?: string[]
  /** Switch value for `toggle`. */
  enabled?: boolean
}

/* ------------------------------------------------------------------ *
 * Mutation responses
 * ------------------------------------------------------------------ */

/**
 * Every write route reports success here; failures carry a reason when known.
 * The optional fields are the state a mutation hands back so the caller can
 * adopt it without a second round trip — a route only sends the ones it
 * actually changed.
 */
export interface OkResponse {
  ok: boolean
  reason?: string
  error?: string
  /**
   * Opaque token minted for this mutation, accepted by `POST /dsh-galaxy/rollback`.
   * Absent when the operation left nothing to undo.
   */
  rollbackToken?: string
  /** Resulting disabled set (toggle, groups). */
  disabled?: string[]
  /** Resulting live set (toggle, use-skin). */
  live?: string[]
  /** Resulting bookmarked catalog URLs (favorite). */
  favorites?: string[]
  /** Resulting note map (note). */
  notes?: Record<string, string>
  /** Resulting groups (groups). */
  groups?: Record<string, string[]>
  /** Resulting group display order (groups). */
  groupOrder?: string[]
  /** Members whose load state did not follow a group switch. */
  restartMembers?: string[]
  /** Client-part members that need a page reload. */
  refreshMembers?: string[]
  /** True when the page should be reloaded for this change to show. */
  refresh?: boolean
  /** True when the plugin was mounted without a restart. */
  hot?: boolean
  /** Snapshot ids created as part of the write. */
  snapshots?: string[]
}

/** Result of `POST /dsh-galaxy/install`. */
export interface InstallResponse extends OkResponse {
  operationId?: string
  name?: string
  url?: string
  version?: string
  /** Conflicts found while composing the profile. */
  conflicts?: string[]
  /** Build scripts pnpm refused to run. */
  blockedBuilds?: string[]
  /** True when the user cancelled the run before it finished. */
  cancelled?: boolean
  restartRequired?: boolean
}

/** Result of `POST /dsh-galaxy/update`. */
export interface UpdateResponse extends OkResponse {
  operationId?: string
  name?: string
  from?: string
  to?: string
  /** `current` when the plugin was already on the target version. */
  skipped?: string
  partial?: boolean
  cancelled?: boolean
  updated?: string[]
  failed?: string[]
  blockedBuilds?: string[]
  restartRequired?: boolean
}

/* ------------------------------------------------------------------ *
 * Host services the client binds to
 * ------------------------------------------------------------------ */

/** The subset of the locale service the views use. */
export interface LocaleServiceLike {
  register(namespace: string, dicts: { zh: Dict; en: Dict }): unknown
  bind(namespace: string): Translate
  subscribe(callback: () => void): () => void
  getSnapshot(): { active: string }
}

/** Active theme descriptor; the host may carry more keys than these. */
export interface ThemeSnapshot {
  id: string
  mode?: 'light' | 'dark'
  [key: string]: unknown
}

/** The subset of the theme service the views use. */
export interface ThemeServiceLike {
  getTheme(): ThemeSnapshot | null
  setTheme?(id: string): void
  /** Present on hosts that push theme changes; otherwise the store is static. */
  subscribe?(callback: () => void): () => void
}

/** `useSyncExternalStore`-compatible theme store. */
export interface ThemeStore {
  subscribe(callback: () => void): () => void
  getSnapshot(): ThemeSnapshot | null
  /**
   * Snapshot used when the tree is rendered to a string. React requires it for
   * any `useSyncExternalStore` rendered outside the browser; the plugin only
   * renders in the browser, but a missing member turns any server render (and
   * a component test) into a hard throw rather than a harmless one.
   */
  getServerSnapshot?(): ThemeSnapshot | null
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

/** Thrown for every non-2xx response; `payload` is the parsed body verbatim. */
export interface GalaxyApiError extends Error {
  status: number
  payload: unknown
}

/** The route prefix owned by this plugin. */
const API_PREFIX = '/dsh-galaxy'

class GalaxyApiFailure extends Error implements GalaxyApiError {
  readonly status: number
  readonly payload: unknown

  constructor(status: number, payload: unknown, message: string) {
    super(message)
    this.name = 'GalaxyApiError'
    this.status = status
    this.payload = payload
  }
}

/**
 * Structural check rather than `instanceof`: two copies of this bundle (a
 * double-loaded page) each own a distinct class identity.
 */
export function isGalaxyApiError(value: unknown): value is GalaxyApiError {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { name?: unknown; status?: unknown }
  return candidate.name === 'GalaxyApiError' && typeof candidate.status === 'number'
}

/** One query value; `undefined`/`null` entries are dropped. */
type QueryValue = string | number | boolean | undefined | null
type Query = Record<string, QueryValue>

interface RequestOptions {
  method?: 'GET' | 'POST'
  /** JSON body; omitted entirely when undefined. */
  body?: unknown
  query?: Query
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Normalize an API path into a path relative to the document base, keeping the
 * `/dsh-galaxy` prefix. Anchoring on `document.baseURI` is what makes the
 * client work behind a reverse proxy that mounts dsh under a prefix; on a root
 * deployment the base is `/`, so the result is `/dsh-galaxy/...` as usual.
 * A path that already carries the prefix is not prefixed twice.
 */
function apiRelative(path: string): string {
  const raw = path.trim()
  const prefixed = raw.startsWith(API_PREFIX) ? raw : `${API_PREFIX}/${raw.replace(/^\/+/, '')}`
  return prefixed.replace(/^\/+/, '')
}

/** Root-relative request path, query string preserved. */
function apiPath(path: string): string {
  const relative = apiRelative(path)
  if (typeof document === 'undefined' || typeof document.baseURI !== 'string') return `/${relative}`
  try {
    const url = new URL(relative, document.baseURI)
    return url.pathname + url.search + url.hash
  } catch {
    return `/${relative}`
  }
}

/** Absolute URL of an API path, for anchors and diagnostics. */
export function absoluteApiUrl(path: string): string {
  const relative = apiRelative(path)
  if (typeof document === 'undefined' || typeof document.baseURI !== 'string') return `/${relative}`
  try {
    return new URL(relative, document.baseURI).toString()
  } catch {
    return `/${relative}`
  }
}

function withQuery(path: string, query: Query | undefined): string {
  if (query === undefined) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  if (qs === '') return path
  return path.includes('?') ? `${path}&${qs}` : `${path}?${qs}`
}

/** Parse a response body as JSON, falling back to raw text. */
async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** Prefer the host's own error text over the bare status line. */
function errorMessage(status: number, path: string, payload: unknown): string {
  if (typeof payload === 'string' && payload.trim() !== '') return payload.trim()
  if (isRecord(payload)) {
    for (const key of ['error', 'reason', 'message', 'detail']) {
      const value = payload[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  }
  return `HTTP ${String(status)} ${apiPath(path)}`
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const url = apiPath(withQuery(path, options.query))
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
  }
  if (options.body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(url, init)
  if (!response.ok) {
    const payload = await readPayload(response)
    throw new GalaxyApiFailure(response.status, payload, errorMessage(response.status, path, payload))
  }
  return response
}

/**
 * Perform one request and parse its JSON body. A successful empty body (204,
 * or a route that only reports through the status code) becomes `{ ok: true }`
 * so callers can read `.ok` without a null check.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options)
  const payload = await readPayload(response)
  return (payload === null ? { ok: true } : payload) as T
}

/** Perform one request and return its body as text (`/logs`). */
async function requestText(path: string, options: RequestOptions = {}): Promise<string> {
  const response = await send(path, options)
  return await response.text()
}

/**
 * Read an array payload that the host may wrap in an envelope: `[...]`,
 * `{ updates: [...] }`, `{ snapshots: [...] }`, ... Unknown shapes yield `[]`
 * so a view renders its empty state instead of throwing.
 */
function arrayField<T>(value: unknown, ...keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[]
  if (isRecord(value)) {
    for (const key of keys) {
      const nested = value[key]
      if (Array.isArray(nested)) return nested as T[]
    }
  }
  return []
}

function isRegistryLike(value: unknown): value is Registry {
  return isRecord(value) && Array.isArray(value.plugins)
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** Catalog plus the host version it should be read against. `force` revalidates. */
export async function fetchRegistry(force?: boolean): Promise<{
  registry: Registry
  hostVersion?: string
  /** Base of the operator's plugin site, when one is configured. */
  siteUrlBase?: string
  /** `env` = explicitly configured, `catalog-origin` = derived from the catalog URL. */
  siteUrlSource?: 'env' | 'catalog-origin'
}> {
  const body = await request<unknown>('/registry', {
    query: force === true ? { force: 1 } : undefined,
  })
  if (isRegistryLike(body)) return { registry: body }
  if (isRecord(body)) {
    const registry = body.registry
    if (isRegistryLike(registry)) {
      const hostVersion = typeof body.hostVersion === 'string' ? body.hostVersion : undefined
      return hostVersion === undefined ? { registry } : { registry, hostVersion }
    }
  }
  return { registry: { plugins: [] } }
}

/** Installed inventory, groups, notes, favorites, patch state and diagnostics. */
export function fetchInstalled(): Promise<InstalledPayload> {
  return request<InstalledPayload>('/installed')
}

/** Live host status: boot id, busy flag, progress, pnpm probe, restart capability. */
export function fetchStatus(): Promise<GalaxyStatus> {
  return request<GalaxyStatus>('/status')
}

/** Per-plugin update verdicts; `force` bypasses the host's cache. */
export async function fetchUpdates(force?: boolean): Promise<UpdateStatus[]> {
  const body = await request<unknown>('/updates', { query: force === true ? { force: 1 } : undefined })
  return arrayField<UpdateStatus>(body, 'updates')
}

/** Release notes and commits for one plugin. */
export function fetchChangelog(name: string): Promise<ChangelogPayload> {
  return request<ChangelogPayload>('/changelog', { query: { name } })
}

/** Full profile diagnostic report. */
export function fetchCheck(): Promise<DiagnosticReport> {
  return request<DiagnosticReport>('/check')
}

/** The exported log as plain text (server half; the browser half is appended by self-check.ts). */
export function fetchLogsText(): Promise<string> {
  return requestText('/logs')
}

/** Portable profile configuration backup. */
export function fetchBackup(): Promise<ProfileBackup> {
  return request<ProfileBackup>('/backup')
}

/* ------------------------------------------------------------------ *
 * Catalog and compatibility
 * ------------------------------------------------------------------ */

/** Discovery-time host compatibility forecast for candidate package names. */
export async function discoveryCompatibility(packages: string[]): Promise<HostCompatibility[]> {
  const body = await request<unknown>('/discovery-compatibility', {
    method: 'POST',
    body: { packages },
  })
  const list = arrayField<HostCompatibility>(body, 'compatibility', 'results')
  if (list.length > 0) return list
  // Also accept the map form (`plugins: { <name>: {status, basis, ...} }`),
  // which carries the package name in the key rather than the value.
  if (isRecord(body) && isRecord(body.plugins)) {
    return Object.entries(body.plugins).map(([name, value]) => ({
      name,
      ...(isRecord(value) ? value : {}),
    })) as unknown as HostCompatibility[]
  }
  return list
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/** Install one catalog source spec. */
export function installPlugin(url: string): Promise<InstallResponse> {
  return request<InstallResponse>('/install', { method: 'POST', body: { url } })
}

/** Update one installed plugin; `force` skips the channel check, `restore` rewrites the spec. */
export function updatePlugin(name: string, options: { force?: boolean; restore?: boolean } = {}): Promise<UpdateResponse> {
  return request<UpdateResponse>('/update', {
    method: 'POST',
    body: {
      name,
      ...(options.force === true ? { force: true } : {}),
      ...(options.restore === true ? { restore: true } : {}),
    },
  })
}

/** Remove one plugin from the profile. */
export function uninstallPlugin(name: string, force?: boolean): Promise<OkResponse> {
  return request<OkResponse>('/uninstall', {
    method: 'POST',
    body: { name, ...(force === true ? { force: true } : {}) },
  })
}

/** Migrate a git-installed plugin to its npm release. */
export function migrateSource(name: string): Promise<OkResponse> {
  return request<OkResponse>('/migrate-source', { method: 'POST', body: { name } })
}

/** Undo the mutation identified by a rollback token. */
export function rollbackOperation(rollbackId: string): Promise<OkResponse> {
  return request<OkResponse>('/rollback', { method: 'POST', body: { rollbackId } })
}

/** Ask the host to kill the running operation. */
export function cancelOperation(): Promise<{ ok: boolean; cancelled: boolean }> {
  return request<{ ok: boolean; cancelled: boolean }>('/cancel', { method: 'POST', body: {} })
}

/** Approve the build scripts pnpm refused to run. */
export function approveBuilds(packages: string[]): Promise<{ ok: boolean; approved: string[] }> {
  return request<{ ok: boolean; approved: string[] }>('/approve-builds', { method: 'POST', body: { packages } })
}

/** Provision pnpm (or report the probe result when it is already available). */
export function setupPnpm(): Promise<PnpmProbe> {
  return request<PnpmProbe>('/setup-pnpm', { method: 'POST', body: {} })
}

/** Schedule a host restart; the response says whether it was accepted. */
export function restartHost(): Promise<RestartSchedule> {
  return request<RestartSchedule>('/restart', { method: 'POST', body: {} })
}

/** Remove Plugin Galaxy from this profile; `confirm` is the explicit second step. */
export function selfUninstall(confirm: boolean, purge: boolean): Promise<OkResponse> {
  return request<OkResponse>('/self-uninstall', { method: 'POST', body: { confirm, purge } })
}

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

/** Enable or disable one installed plugin. */
export function togglePlugin(name: string, enabled: boolean): Promise<OkResponse> {
  return request<OkResponse>('/toggle', { method: 'POST', body: { name, enabled } })
}

/** Write (or clear, when empty) one plugin's user note. */
export function saveNote(name: string, text: string): Promise<OkResponse> {
  return request<OkResponse>('/note', { method: 'POST', body: { name, text } })
}

/** Bookmark or un-bookmark one catalog URL. */
export function favoriteUrl(url: string, favorited: boolean): Promise<OkResponse> {
  return request<OkResponse>('/favorite', { method: 'POST', body: { url, favorited } })
}

/** One named-group mutation. */
export function groupAction(action: GroupAction, payload?: GroupPayload): Promise<OkResponse> {
  return request<OkResponse>('/groups', { method: 'POST', body: { action, ...(payload ?? {}) } })
}

/** Write the profile bundle order. */
export function reorderBundles(order: string[]): Promise<BundleOrderResult> {
  return request<BundleOrderResult>('/bundle-order', { method: 'POST', body: { order } })
}

/** Captured profile snapshots, newest first when the host sorts them. */
export async function listSnapshots(): Promise<ProfileSnapshot[]> {
  const body = await request<unknown>('/snapshots')
  return arrayField<ProfileSnapshot>(body, 'snapshots')
}

/** Capture the current profile configuration. */
export function createSnapshot(): Promise<{ ok: boolean; snapshot: ProfileSnapshot }> {
  return request<{ ok: boolean; snapshot: ProfileSnapshot }>('/snapshots', { method: 'POST', body: {} })
}

/** Restore one snapshot over the live profile files. */
export function restoreSnapshotFile(id: string): Promise<OkResponse> {
  // `snapshot` is the reference payload key; `id` matches this client's own
  // signature. Sending both keeps either host vocabulary working, since an
  // unknown extra key is ignored.
  return request<OkResponse>('/restore-snapshot', { method: 'POST', body: { id, snapshot: id } })
}

/** Delete one snapshot. */
export function deleteSnapshotFile(id: string): Promise<OkResponse> {
  return request<OkResponse>('/delete-snapshot', { method: 'POST', body: { id, snapshot: id } })
}

/** Saved presets. */
export async function listPresets(): Promise<Preset[]> {
  const body = await request<unknown>('/presets')
  return arrayField<Preset>(body, 'presets')
}

/** Save, apply, delete or preview one preset. */
export function presetAction(
  action: 'save' | 'apply' | 'delete' | 'preview',
  payload: { name: string; bundleOrder?: string[]; disabled?: string[] },
): Promise<{ ok: boolean; presets?: Preset[]; order?: string[]; disabled?: string[]; reason?: string }> {
  return request<{ ok: boolean; presets?: Preset[]; order?: string[]; disabled?: string[]; reason?: string }>(
    '/presets',
    { method: 'POST', body: { action, ...payload } },
  )
}

/** Activate one theme plugin without editing the profile by hand. */
export function useSkin(name: string): Promise<OkResponse> {
  return request<OkResponse>('/use-skin', { method: 'POST', body: { name } })
}

/* ------------------------------------------------------------------ *
 * Protection and sync
 * ------------------------------------------------------------------ */

/** Overwrite the live profile configuration from a backup payload. */
export function restoreBackupFile(backup: ProfileBackup): Promise<{ ok: boolean; restored: string[]; skipped: string[] }> {
  return request<{ ok: boolean; restored: string[]; skipped: string[] }>('/restore', { method: 'POST', body: { backup } })
}

/** Upload the current backup to WebDAV, or download one from it. */
export function webdavAction(
  action: 'upload' | 'download',
  options: { url: string; username?: string; password?: string; backup?: ProfileBackup },
): Promise<{ ok: boolean; backup?: ProfileBackup; error?: string }> {
  return request<{ ok: boolean; backup?: ProfileBackup; error?: string }>('/webdav', {
    method: 'POST',
    body: { action, ...options },
  })
}

/** Create, update, read or verify a GitHub Gist export. */
export function gistAction(
  action: 'create' | 'update' | 'read' | 'verify',
  options: { token?: string; gistId?: string; includeDeps?: boolean; includeConfig?: boolean },
): Promise<GistResult> {
  return request<GistResult>('/gist', { method: 'POST', body: { action, ...options } })
}

/* ------------------------------------------------------------------ *
 * Network
 * ------------------------------------------------------------------ */

/** Switch the release channel of Plugin Galaxy itself. */
export function setChannel(channel: Channel): Promise<OkResponse> {
  return request<OkResponse>('/channel', { method: 'POST', body: { channel } })
}

/** Switch the download region. */
export function setRegion(region: Region): Promise<OkResponse> {
  return request<OkResponse>('/region', { method: 'POST', body: { region } })
}

/** Set (or clear, with an empty string) the custom GitHub prefix proxy. */
export function setGithubProxy(proxy: string): Promise<OkResponse> {
  return request<OkResponse>('/github-proxy', { method: 'POST', body: { proxy } })
}

/* ------------------------------------------------------------------ *
 * Compatibility re-exports
 * ------------------------------------------------------------------ */

/**
 * `recordFromStatus` is owned by `operations.ts` (docs/client-contract.md §4)
 * and is re-exported here so a view that treats `market-data.ts` as the single
 * client module finds it. The implementation stays in operations.ts — this is
 * a re-export, not a second copy.
 */
export { recordFromStatus } from './operations.ts'

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

/**
 * Download a text file through a temporary anchor.
 *
 * `<a download>` is used rather than the File System API because the host page
 * may be served from any origin; the object URL is revoked as soon as the
 * click has been dispatched so the blob does not outlive the action.
 */
export function downloadTextFile(filename: string, text: string): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/**
 * Wrap a theme service into a `useSyncExternalStore` store.
 *
 * `getSnapshot` MUST return the same object identity while the theme has not
 * changed: React re-renders until two consecutive reads agree, so a host that
 * builds a fresh snapshot object per call would otherwise spin the section
 * forever. The cache is keyed by the identity fields the snapshot contract
 * guarantees (`id` + `mode`) and falls back to the host's own subscribe.
 */
export function themeStoreFrom(theme: ThemeServiceLike): ThemeStore {
  let cached: ThemeSnapshot | null = null
  let cachedKey = '\u0000unset'

  const getSnapshot = (): ThemeSnapshot | null => {
    const snapshot = theme.getTheme() ?? null
    const key = snapshot === null ? 'null' : `${snapshot.id}|${snapshot.mode ?? ''}`
    if (key !== cachedKey) {
      cachedKey = key
      cached = snapshot
    }
    return cached
  }

  const subscribe = (callback: () => void): (() => void) => {
    if (typeof theme.subscribe !== 'function') return () => {}
    const off = theme.subscribe(callback)
    return typeof off === 'function' ? off : () => {}
  }

  return { subscribe, getSnapshot, getServerSnapshot: getSnapshot }
}
