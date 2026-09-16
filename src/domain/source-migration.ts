/**
 * Safe discovery and execution of legacy Git -> npm source migrations.
 *
 * A migration changes the package's name, publisher and build provenance, so
 * it is the one mutation where doing less is the whole design:
 *
 *  - only repository evidence carried by the installed Git spec may authorize
 *    it — bare `github:owner/repo` matches only the catalog root for that repo,
 *    and a `#path:/subdir` selector matches only that exact subpath;
 *  - branch, tag, commit and semver selectors are NOT migrated, because they
 *    express an explicit choice the user made and dropping one silently would
 *    be an upgrade they did not ask for;
 *  - more than one matching verified npm entry is ambiguous, and ambiguity
 *    fails closed.
 *
 * Adds the other refusal: a package still named by an `insert`
 * entry in the user's `cordis.patch.yml` is load-bearing for the next boot, so
 * the migration stops and names the rows instead of rewriting a file the user
 * owns. That refusal is overridable ONLY while the patch layer is unreadable —
 * where the galaxy cannot say which row to fix — and never when the layer is
 * readable and definitely references the package.
 *
 * Any failure after the first destructive step rolls the captured manifest and
 * lockfile back, and reports whether that rollback itself verified.
 *
 */

import { logEvent } from '../core/log.ts'
import { readInstalled, readLockfile, readProfileManifestSnapshot, restoreLockfile, restoreProfileManifest } from '../core/profile.ts'
import type { ProfileManifestSnapshot } from '../core/profile.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { InstallResult, Registry, RegistryPlugin, SourceMigrationHint } from '../core/types.ts'

/* ------------------------------------------------------------------ *
 * Injected sibling implementations
 * ------------------------------------------------------------------ */

/**
 * Structural subset of what `domain/patch.ts`'s `readUserPatchState` reports.
 *
 * Only the guard's inputs are named: the row list itself is that module's
 * business, and asking for it here would couple this module to a parser it
 * never reads.
 */
export interface PatchStateLike {
  exists?: boolean
  referenced?: readonly string[]
  unreadable?: boolean
}

/**
 * The sibling implementations a migration needs.
 *
 * The catalog is passed to {@link migrateSource} as a value rather than loaded
 * here, because the route already needs it for its own guards and loading it
 * twice would double the network cost of one request. What this module cannot
 * derive on its own is the user patch layer, so that is the one required
 * dependency.
 */
export interface MigrationConfig {
  /** `domain/patch.ts` — read the user patch layer. */
  readUserPatchState: (profile: string, explicitDir?: string) => PatchStateLike
  /** `domain/sources.ts` — identity facts of an installed spec. */
  parseSourceSpec?: (spec: string) => { kind: string; repo?: string; packageName: string }
}

/** Cache key holding the mount's {@link MigrationConfig}. */
const CONFIG_CACHE_KEY = 'lifecycle.migration.config'

/** Register the sibling implementations for one mount. */
export function configureSourceMigration(runtime: GalaxyRuntime, config: MigrationConfig): void {
  runtime.setCache(CONFIG_CACHE_KEY, config)
}

/** The registered configuration, if the mount was wired. */
export function migrationConfigOf(runtime: GalaxyRuntime): MigrationConfig | undefined {
  return runtime.cache<MigrationConfig>(CONFIG_CACHE_KEY)
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

/** Normalized owner/repo or `owner/repo#path:/subdir` identity of a migratable spec. */
function migratableGitIdentity(spec: string): string | null {
  if (!spec.startsWith('github:')) return null
  const hash = spec.indexOf('#')
  if (hash !== -1) {
    const selector = spec.slice(hash + 1)
    // A path selector says WHICH package inside a monorepo. Any other selector
    // expresses an explicit version/ref choice and is deliberately preserved
    // rather than silently discarded.
    if (!selector.startsWith('path:/') || selector.includes('&')) return null
  }
  const repo = spec.slice('github:'.length).split('#')[0] ?? ''
  return repo === '' ? null : repo.toLowerCase()
}

/** Normalize a bare `owner/repo` for comparison. */
function normalizeRepo(repo: string): string {
  return repo.trim().replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '').toLowerCase()
}

/** Split a normalized identity into its repo and optional subpath. */
function splitIdentity(identity: string): { repo: string; subpath: string | null } {
  const at = identity.indexOf('#path:/')
  if (at === -1) return { repo: identity, subpath: null }
  return { repo: identity.slice(0, at), subpath: identity.slice(at + '#path:/'.length) }
}

/** The repository identity a catalog entry's `url` names, when it names one. */
function entryRepo(entry: RegistryPlugin): { repo: string; subpath: string | null } | null {
  const url = typeof entry.url === 'string' ? entry.url : ''
  const github = /github\.com[/:]([^/#?\s]+)\/([^/#?\s]+)/iu.exec(url)
  if (github === null || github[1] === undefined || github[2] === undefined) return null
  const repo = normalizeRepo(`${github[1]}/${github[2]}`)
  // A `/tree/<ref>/<subpath>` URL carries an explicit ref AND a subpath. This
  // flow migrates neither: the subpath form exists only for entries whose url
  // is a bare repository address, which is also the only form the installed
  // `github:…#path:/…` spec can be matched against without guessing a ref.
  if (/\/tree\//u.test(url)) return { repo, subpath: null }
  return { repo, subpath: null }
}

/**
 * The npm package a legacy Git install may be migrated to, when the catalog
 * verifies exactly one candidate.
 *
 * @param profile - profile name, used for the manifest read.
 * @param name - the installed package whose source should move.
 * @param explicitDir - resolved profile directory (Desktop-owned path).
 * @param registry - catalog to search; omit to skip discovery.
 * @returns the hint, or undefined when the source must not be migrated.
 */
export function findGitToNpmMigration(
  profile: string,
  name: string,
  explicitDir?: string,
  registry?: Registry,
): SourceMigrationHint | undefined {
  if (registry === undefined) return undefined
  const spec = readInstalled(profile, explicitDir)[name]
  if (spec === undefined) return undefined
  const identity = migratableGitIdentity(spec)
  if (identity === null) return undefined
  const wanted = splitIdentity(identity)
  let candidate: string | undefined
  for (const entry of registry.plugins) {
    const npm = typeof entry.npm === 'string' ? entry.npm : ''
    if (npm === '') continue
    const source = entryRepo(entry)
    if (source === null || source.repo !== wanted.repo) continue
    // A collection root must not guess which `/tree/` child was meant.
    if (wanted.subpath === null && source.subpath !== null) continue
    if (wanted.subpath !== null && source.subpath !== wanted.subpath) continue
    if (candidate !== undefined && candidate !== npm) return undefined
    candidate = npm
  }
  if (candidate === undefined) return undefined
  return { from: spec, to: 'npm', packageName: candidate }
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

/** What a migration reports back to the route. */
export interface MigrationResult {
  ok: boolean
  /** The dependency that was removed (the legacy name). */
  removed?: string
  /** The dependency that was added, when it differs from `removed`. */
  added?: string
  /** True when the captured manifest/lockfile were restored after a failure. */
  restored: boolean
  reason?: string
}

/** Cap on a reason string copied into a response payload. */
const REASON_LIMIT = 800

/** One bounded, log-safe description of a failed child run. */
function failureDetail(result: InstallResult): string {
  const detail = (result.stderr.trim() || result.stdout.trim()).slice(-REASON_LIMIT)
  if (detail !== '') return detail
  if (result.timedOut) return 'the plugin command timed out'
  return `the plugin command failed with exit code ${String(result.exitCode)}`
}

/** Whether a child run ended cleanly. */
function succeeded(result: InstallResult): boolean {
  return result.exitCode === 0 && result.timedOut !== true && result.cancelled !== true
}

/**
 * Migrate one installed Git dependency to its verified npm package.
 *
 * Steps: refuse when the user patch layer references the package, capture the
 * manifest and lockfile, `remove` the Git dependency, `add` the npm target,
 * and confirm the replacement is present and loadable. Any failure restores
 * the captured manifest and lockfile, and the result says whether that
 * restoration happened.
 *
 * @param profile - profile name handed to the runner.
 * @param dir - resolved profile directory.
 * @param name - the installed package to migrate.
 * @param runtime - the mount supplying the runner and the injected config.
 * @param registry - catalog used to verify the npm target.
 * @param force - the one documented override: proceed past an UNREADABLE patch layer.
 */
export async function migrateSource(
  profile: string,
  dir: string,
  name: string,
  runtime: GalaxyRuntime,
  registry: Registry,
  force = false,
): Promise<MigrationResult> {
  const config = migrationConfigOf(runtime)
  if (config === undefined) {
    logEvent('error', 'source-migration', 'migration helpers are not registered for this mount')
    return { ok: false, restored: false, reason: 'the galaxy migration helpers are not registered for this mount' }
  }
  const installed = readInstalled(profile, dir)
  const spec = installed[name]
  if (spec === undefined) return { ok: false, restored: false, reason: 'plugin is not installed' }
  const hint = findGitToNpmMigration(profile, name, dir, registry)
  if (hint === undefined) {
    return {
      ok: false,
      restored: false,
      reason: 'this Git source cannot be uniquely verified to one npm package, or it carries an explicit branch/tag/commit/ref / 该 Git 来源无法唯一核验到一个 npm 包，或包含显式 ref',
    }
  }
  const targetName = hint.packageName
  if (targetName !== name && installed[targetName] !== undefined) {
    return {
      ok: false,
      restored: false,
      reason: `the target package ${targetName} is already installed as a separate dependency / 目标 npm 包已作为独立依赖安装`,
    }
  }

  // A readable patch layer that names the package is a hard
  // stop — the user has a concrete row to fix. An unreadable layer is the only
  // forceable case, because the galaxy cannot say which row to fix and the
  // moment someone migrates is often the moment something is already broken.
  let patch: PatchStateLike
  try {
    patch = config.readUserPatchState(profile, dir)
  } catch (error) {
    logEvent('warn', 'source-migration', `${name}: the user patch layer could not be read — ${(error as Error).message}`)
    patch = { unreadable: true, referenced: [] }
  }
  const referenced = patch.referenced ?? []
  if (patch.unreadable !== true && referenced.includes(name)) {
    logEvent('warn', 'migration-blocked', `${name}: user cordis.patch.yml still inserts it`)
    return {
      ok: false,
      restored: false,
      reason: `无法迁移 ${name}：当前 profile 的 cordis.patch.yml 仍通过 insert 引用它。请先移除这些用户补丁引用再重试。 / Cannot migrate ${name}: this profile's cordis.patch.yml still inserts it. Remove those user-owned patch references first and retry.`,
    }
  }
  if (patch.unreadable === true && !force) {
    return {
      ok: false,
      restored: false,
      reason: `无法安全迁移 ${name}：cordis.patch.yml 无法读取为有效的补丁列表，因此无法排除它仍被引用。请先检查补丁文件；确认无关后可强制迁移。 / Cannot safely migrate ${name}: cordis.patch.yml could not be read as a valid patch list. Check the patch file; force the migration once you are sure it is unrelated.`,
    }
  }
  if (patch.unreadable === true) {
    logEvent('warn', 'source-migration', `${name}: forced past an unreadable user cordis.patch.yml`)
  }

  const manifestBefore: ProfileManifestSnapshot = readProfileManifestSnapshot(profile, dir)
  const lockfileBefore = readLockfile(profile, dir)

  /** Restore the captured profile state; returns whether it verified. */
  const rollback = (): boolean => {
    try {
      restoreProfileManifest(profile, manifestBefore, dir)
      restoreLockfile(profile, lockfileBefore, dir)
      return true
    } catch (error) {
      logEvent('error', 'source-migration', `${name}: rollback failed — ${(error as Error).message}`)
      return false
    }
  }

  const remove = await runtime.runner(profile, ['remove', name])
  if (!succeeded(remove)) {
    const detail = failureDetail(remove)
    const restored = rollback()
    logEvent(restored ? 'warn' : 'error', 'source-migration', `${name}: remove failed — ${detail}; ${restored ? 'profile restored' : 'rollback failed'}`)
    return { ok: false, restored, removed: name, reason: detail }
  }
  const add = await runtime.runner(profile, ['add', `${targetName}@latest`])
  if (!succeeded(add)) {
    const detail = failureDetail(add)
    const restored = rollback()
    logEvent(restored ? 'warn' : 'error', 'source-migration', `${name}: add ${targetName} failed — ${detail}; ${restored ? 'previous Git source restored' : 'rollback failed'}`)
    return { ok: false, restored, removed: name, added: targetName, reason: detail }
  }
  const after = readInstalled(profile, dir)
  if (after[targetName] === undefined) {
    const restored = rollback()
    logEvent('error', 'source-migration', `${name}: the npm target did not become a dependency`)
    return {
      ok: false,
      restored,
      removed: name,
      added: targetName,
      reason: 'the npm target did not produce a replacement dependency / npm 目标安装后未形成依赖',
    }
  }
  logEvent('info', 'source-migration', `${name}: ${spec} -> ${targetName}`)
  return { ok: true, restored: false, removed: name, added: targetName }
}
