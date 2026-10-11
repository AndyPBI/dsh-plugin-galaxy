/**
 * Shared vocabulary for Plugin Galaxy.
 *
 * This file is the single source of truth for the plugin's own domain model:
 * persistent entities, transport DTOs/VOs, enums and configuration. Domain
 * modules, the HTTP API layer and the browser client all import their contracts
 * from here so that a change to a payload shape is a compile error everywhere
 * it matters.
 */

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/** Release channel of the galaxy plugin itself. */
export type Channel = 'stable' | 'beta' | 'dev'

/** Download region used to route outbound requests. */
export type Region = 'global' | 'china'

/** Which GitHub surface a proxy prefix applies to. */
export type GithubService = 'git' | 'raw' | 'avatar'

/** Optional cordis configuration for the plugin. */
export interface GalaxyConfig {
  /** Profile whose directory is managed. Defaults to `--profile` argv or `web`. */
  profile?: string
  /** Explicit profile directory (Desktop host injects this). */
  profileDirectory?: string
  /** Whether the host may be restarted from the UI. Undefined = unconfigured. */
  allowRestart?: boolean
  /** Maximum retained snapshots per profile. */
  maxSnapshots?: number
}

/** Configuration after defaults and host services have been resolved. */
export interface ResolvedConfig {
  profile: string
  profileDirectory: string
  allowRestart: boolean | undefined
  maxSnapshots: number
  /**
   * A packaged application's own package manager (0.2.x
   * `profileContext.packageManager`). Present only when the host is an app that
   * ships its own runtime — the marker for "pnpm is not on PATH AND the shell
   * owns this process". The mount then drives pnpm directly instead of the
   * `dsh plugin` wrapper, which cannot target a non-standard profile directory.
   */
  packageManager?: PnpmInvocationLike
}

import type { PnpmInvocationLike } from '../domain/host-shape.ts'

/* ------------------------------------------------------------------ *
 * Persistent entities
 * ------------------------------------------------------------------ */

/**
 * The galaxy's own durable state for one profile.
 * Persisted at `<profile>/.dsh-galaxy/state.json`.
 */
export interface GalaxyState {
  /** Plugin names switched off by the user (patch layer mirrors this). */
  disabled?: string[]
  /** Named groups of plugin names. */
  groups?: Record<string, string[]>
  /** Display order of group names. */
  groupOrder?: string[]
  /** Per-plugin one-line user note; `undefined`/absent = no note. */
  notes?: Record<string, string>
  /** Release channel of the galaxy itself. */
  channel?: Channel
  /** Explicitly chosen download region. */
  region?: Region
  /** True when `region` came from the automatic one-shot probe. */
  regionAuto?: boolean
  /** Bookmarked catalog URLs (not yet installed). */
  favorites?: string[]
  /** Operator/UI configured GitHub prefix proxy. */
  githubProxy?: string
  /**
   * Catalog URL for THIS profile, when the operator set one here instead of in
   * the process environment.
   *
   * Profile-scoped on purpose: a deployment copies the profile, and the catalog
   * a server should read is part of that deployment, not of whoever happened to
   * launch the process. The environment still wins (ops override).
   */
  catalogUrl?: string
  /** Base of the operator's plugin website, same precedence rules as above. */
  siteUrl?: string
}

/** A named composition (bundle order + disabled set). */
export interface Preset {
  name: string
  bundleOrder: string[]
  disabled: string[]
  createdAt: number
}

/** One captured file inside a profile snapshot. */
export interface SnapshotFile {
  /** Profile-relative path, e.g. `package.json`. */
  path: string
  /** Parsed JSON when the file is JSON. */
  json?: unknown
  /** Raw lines when the file is line-oriented. */
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

/** One sanitized galaxy event. */
export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  at: string
  level: LogLevel
  event: string
  detail: string
}

/* ------------------------------------------------------------------ *
 * Catalog
 * ------------------------------------------------------------------ */

/** One installable entry of the curated catalog. */
export interface RegistryPlugin {
  /** npm package name (or `github:` spec for git-only entries). */
  name: string
  /**
   * What the card title, the search index and the website all show.
   *
   * The website computes it from `name` (monorepo entries are published as
   * `repo#subpath`, which is unreadable as a label) and ships it with every row.
   * Older catalogs and the upstream public one have no such field, so consumers
   * fall back to `name`.
   *
   * `name` itself is NOT the label: it participates in the identity contract
   * (`key === owner/name`) and in the deep link, so it stays raw.
   */
  displayName?: string
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
  /**
   * Composite recommendation score (0–100) computed by the catalog's own
   * pipeline (`opc-ranking/1` on the website side). Absent on upstream
   * catalogs, which is why every consumer treats it as optional.
   */
  score?: number
  /** Score band: `S` / `A` / `B` / `C` (the site slices it by distribution). */
  band?: string
  /** Version of the formula that produced `score`, so a stale score is visible. */
  scoreVersion?: string
  /** Per-dimension contribution, for "why is this recommended" tooltips. */
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
/** The catalog's ordered recommendation list (see `docs/site-linkage.md`). */
export interface RegistryRanking {
  version: string
  generatedAt?: string
  /** How many entries the UI should show at once (the site computes a longer list). */
  window?: number
  /** Ordered keys, longest first: the UI filters installed ones and takes `window`. */
  top: string[]
  /** Editorial pins, with the reason to show next to the entry. */
  pins?: Array<{ key: string; reason: string }>
}

/**
 * One category the catalog declares, as the site publishes it.
 *
 * The site owns the vocabulary: rows carry a `category` SLUG and this table maps
 * it to the label users read (`label` / `labelEn`). Older catalogs shipped a bare
 * string list, so the loader normalizes both into this shape — a plugin that
 * only understood strings silently dropped the whole table and every card showed
 * the raw slug.
 */
export interface RegistryCategory {
  /** Slug rows refer to (`curated`, `cost`, …). */
  id: string
  /** Chinese label, when the catalog ships one. */
  label?: string
  /** English label, when the catalog ships one. */
  labelEn?: string
  /** How many rows carry this category, as counted by the site. */
  count?: number
}

export interface Registry {
  plugins: RegistryPlugin[]
  /** Category vocabulary: slug → labels. See {@link RegistryCategory}. */
  categories?: RegistryCategory[]
  updated?: string
  count?: number
  /** Present when the payload came from a local fixture. */
  source?: string
  /** Recommendations, when the catalog ships them. */
  ranking?: RegistryRanking
}

/** Structural subset of an npm packument used for compatibility decisions. */
export interface NpmManifest {
  name: string
  version?: string
  dsh?: {
    plugin?: boolean
    /** This plugin's own convention (what the galaxy reads). */
    hostVersion?: string
    /** The convention other DSH plugins publish. */
    engines?: { dsh?: string }
  }
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  engines?: { node?: string; dsh?: string }
  dist?: { tarball?: string }
}

/* ------------------------------------------------------------------ *
 * Installed inventory
 * ------------------------------------------------------------------ */

/** Dependency source classification. */
export type InstallKind = 'npm' | 'git' | 'local' | 'tarball' | 'alias' | 'unknown'

/** One dependency of the managed profile. */
export interface InstalledPlugin {
  name: string
  /** Version resolved from `node_modules/<name>/package.json`, when readable. */
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
 * Updates
 * ------------------------------------------------------------------ */

/** Why an update is or is not available for one plugin. */
export interface UpdateStatus {
  name: string
  /** `npm` = registry version, `git` = HEAD moved, `restore` = local restore. */
  kind: 'npm' | 'git' | 'restore' | 'local' | 'unknown'
  current?: string
  latest?: string
  updateAvailable: boolean
  /** Set when the plugin should move to another channel. */
  channelSwitch?: Channel
  /** True when the recorded spec must be rewritten before updating. */
  restoreRequired?: boolean
  /** Present when a git→npm migration is available. */
  sourceMigration?: SourceMigrationHint
  /** Human readable reason when nothing can be done. */
  reason?: string
  checkedAt: number
}

/** Hint describing an available git→npm migration. */
export interface SourceMigrationHint {
  from: string
  to: string
  packageName: string
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

/** A compatibility risk introduced by an installation. */
export interface CompatRisk {
  name: string
  requirement: string
  hostVersion: string
  severity: 'warn' | 'error'
  detail: string
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
  /**
   * The tail of the child's own output, newest last (bounded).
   *
   * The counters above come from parsing; this is the unparsed truth, which is
   * what makes a long install legible: pnpm's `Progress: resolved …, reused …,
   * downloaded …` lines and the CLI's stage notes are the real process, and an
   * operator can see it moving (or stalled) without reading the log file.
   */
  lines?: string[]
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
 * Public update API v1
 * ------------------------------------------------------------------ */

export interface UpdateOperationV1 {
  operationId: string
  packageName: string
  state: OperationState
  progress: Progress
  rollbackToken?: string
  createdAt: number
  updatedAt: number
  error?: string
}

export interface CapabilitiesV1 {
  schema: 'dsh-galaxy-update-api'
  apiVersion: 1
  stability: 'beta'
  marketVersion: string
  profile: string
  bootId: string
  runtime: { supervisor?: string; debugger: boolean; desktop: boolean }
  features: string[]
  restart: RestartCapability
  operationRetention: number
  operationLimit: number
  endpoints: string[]
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
 * Process / host
 * ------------------------------------------------------------------ */

/** Result of one `dsh plugin …` (or pnpm) child process. */
export interface InstallResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
  busy?: boolean
  /** Raw pnpm output preserved for the build-approval flow. */
  raw?: string
}

/** */
export interface RestartSchedule {
  scheduled: boolean
  reason?: string
  helperPid?: number
  boot?: string
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
export interface PnpmProbe {
  ok: boolean
  path?: string
  version?: string
  provisioned?: boolean
  hint?: string
}

/** Build scripts pnpm refused to run. */
export interface IgnoredBuilds {
  packages: string[]
  /** Raw pnpm hint lines, for display only. */
  detail?: string
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
 * Patch layer and bundle order
 * ------------------------------------------------------------------ */

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

/** Current and candidate bundle order. */
export interface BundleStack {
  /** Bundle order recorded in `dsh.profile.bundles`. */
  current: string[]
  /** Community bundles present in the manifest but not ordered. */
  unordered: string[]
  /** Candidate order after a merge attempt. */
  merged: string[]
}

/** Result of a bundle-order write. */
export interface BundleOrderResult {
  ok: boolean
  bundles: string[]
  snapshot?: string
  reason?: string
}

/* ------------------------------------------------------------------ *
 * Hot mount
 * ------------------------------------------------------------------ */

/** One hot-mounted plugin row. */
export interface HotRow {
  name: string
  rowId: string
  file: string
  mountedAt: number
}

/* ------------------------------------------------------------------ *
 * Themes
 * ------------------------------------------------------------------ */

/** One theme bundle offered by the Themes tab. */
export interface ThemeInfo {
  name: string
  active: boolean
  installed: boolean
  description?: string
  swatch?: string
}

/* ------------------------------------------------------------------ *
 * Rollback
 * ------------------------------------------------------------------ */

/** In-memory token describing how to undo the previous mutation. */
export interface PendingRollback {
  token: string
  kind: OperationKind
  name?: string
  createdAt: number
  /** Profile manifest captured before the mutation. */
  manifest?: unknown
  /** Lockfile contents captured before the mutation. */
  lockfile?: string | null
  /** Dependency spec to restore, for install/update rollback. */
  expectedSpec?: string
  /** Expected manifest state after the operation (staleness guard). */
  expectedState?: string
}

/* ------------------------------------------------------------------ *
 * HTTP transport
 * ------------------------------------------------------------------ */

/** A registered route of the galaxy API. */
export interface RouteDefinition {
  kind: 'exact' | 'prefix'
  path: string
  methods: string[]
  /** Same-origin guard required for mutating routes. */
  sameOrigin?: boolean
  handler: RouteHandler
}

export interface RouteRequest {
  request: import('node:http').IncomingMessage
  response: import('node:http').ServerResponse
  url: URL
  /** Matched route path. */
  routePath: string
  /** Remainder after the matched prefix (empty for exact routes). */
  rest: string
}

export type RouteHandler = (context: RouteRequest) => Promise<void> | void
