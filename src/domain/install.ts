/**
 * Install orchestration used by the lifecycle routes.
 *
 * Everything the install route does around the child process lives here, so
 * that the route only validates its input, takes the lock, and shapes a
 * response. The order is the one the reference implementation settled on after
 * several production incidents, and each step earns its place:
 *
 * 1. **** — the source is validated against the curated
 *     catalog and resolved to a pnpm target. A page cannot POST an arbitrary
 *     install spec at a local server that runs with the user's privileges.
 *  2. **HEAD acceleration** — a GitHub source is resolved to a commit-pinned
 *     target through whichever regional route works, so pnpm downloads a
 *     codeload archive instead of the whole repository.
 *  3. **pre-mutation snapshot** — the exact `dependencies` map plus the exact
 *     `dsh.profile.bundles` field, captured BEFORE the child runs. The `dsh`
 *     CLI writes the manifest before the build-script check and the registry
 *     fetches, so a failed run can leave residue that breaks every later
 *     operation and the next boot.
 *  4. **the child** — via `runtime.runner`.
 *  5. **fake-success guard** — a clean exit that installed nothing loadable
 *     must not read as success; see `validateAddedPlugins` in `verify.ts`.
 *  6. **hot mount** — try to activate without a restart, and report honestly
 *     when the package cannot be hot-mounted.
 *  7. **risk report** — the compatibility risks THIS run introduced, so the
 *     user can undo exactly what it caused.
 *
 * The sibling modules are reached through {@link InstallConfig}, which the
 * route registrar fills in from the imports it already has. They are not
 * imported by name here, because the reference project shipped a named import
 * for a helper that a later host release deleted — and a missing named export
 * is a SyntaxError at module evaluation, so the plugin's failure mode was the
 * host exiting 1. Injecting them keeps this module's edge to `core/*` only.
 *
 */

import { logEvent } from '../core/log.ts'
import { progressTracker } from './progress.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import {
  readInstalled,
  readInstalledVersion,
  readLockfile,
  readProfileManifestSnapshot,
  restoreLockfile,
  restoreProfileManifest,
} from '../core/profile.ts'
import type { ProfileManifestSnapshot } from '../core/profile.ts'
import type { CompatRisk, IgnoredBuilds, InstallResult, Registry, RegistryPlugin } from '../core/types.ts'

/* ------------------------------------------------------------------ *
 * Injected sibling implementations
 * ------------------------------------------------------------------ */

/**
 * Structural view of the compatibility verdicts `domain/compatibility.ts`
 * produces, kept as an opaque array because only that module may interpret
 * them.
 */
export type CompatAssessmentLike = readonly unknown[]

/** What `domain/verify.ts`'s `validateAddedPlugins` reports. */
export interface ValidationLike {
  ok?: boolean
  added?: string[]
  keep?: string[]
  removedBroken?: string[]
  conflicts?: { name: string; id: string; owner: string }[]
}

/**
 * The sibling implementations this module orchestrates.
 *
 * Registered once per mount through {@link configureInstall} and stored on the
 * runtime, so no module-level state exists and two mounts in one process stay
 * independent. Every signature is written against the sibling module that
 * exists in this workspace — they are injected rather than imported so a
 * broken one degrades the install endpoint instead of stopping the host from
 * booting.
 */
export interface InstallConfig {
  /** `domain/registry.ts` — the catalog snapshot that authorizes the install. */
  loadRegistry: (profile: string, dir: string, force?: boolean, runtime?: GalaxyRuntime) => Promise<Registry>
  /** `domain/sources.ts` — resolve a catalog url to its pnpm install target. */
  installTargetFor: (registry: Registry, url: string) => string | undefined
  /** `domain/verify.ts` — the fake-success guard (read-only). */
  validateAddedPlugins: (
    runner: (profile: string, args: string[]) => Promise<InstallResult>,
    profile: string,
    before: ReadonlySet<string>,
    dir: string,
  ) => ValidationLike
  /** `domain/accelerate.ts` — optional; resolves a GitHub HEAD through the region. */
  acceleratedTarget?: (target: string, options: { region: string }) => Promise<string>
  /** Region used for HEAD acceleration ("global" | "china"). */
  region?: string
  /** Optional compatibility assessment of the whole profile. */
  assessProfile?: (profile: string, dir?: string) => CompatAssessmentLike
  /** Optional filter returning only the risks the mutation introduced. */
  introducedRisks?: (before: CompatAssessmentLike, after: CompatAssessmentLike) => CompatRisk[]
  /** `domain/pnpm-compat.ts` — build scripts pnpm refused to run. */
  parseIgnoredBuilds?: (stdout: string) => IgnoredBuilds
  /** `domain/hot.ts` — optional; activates a package without a restart. */
  hotMount?: (runtime: GalaxyRuntime, profile: string, name: string) => { ok: boolean; reason?: string | null } | Promise<{ ok: boolean; reason?: string | null }>
}

/** Cache key holding the mount's {@link InstallConfig}. */
const CONFIG_CACHE_KEY = 'lifecycle.install.config'

/**
 * Register the sibling implementations for one mount.
 *
 * Called by the route registrar, which is the one place holding the catalog,
 * the host context and the runtime together.
 */
export function configureInstall(runtime: GalaxyRuntime, config: InstallConfig): void {
  runtime.setCache(CONFIG_CACHE_KEY, config)
}

/** The registered configuration, if the mount was wired. */
export function installConfigOf(runtime: GalaxyRuntime): InstallConfig | undefined {
  return runtime.cache<InstallConfig>(CONFIG_CACHE_KEY)
}

/* ------------------------------------------------------------------ *
 * Result shapes
 * ------------------------------------------------------------------ */

/** One package the install added and whether it is live now. */
export interface AddedPackage {
  name: string
  version?: string
  /** True when the package is loaded in the running host — no restart owed. */
  live: boolean
}

/** What the install route gets back from the orchestration. */
export interface InstallPluginResult {
  ok: boolean
  /** The plugin's name, from the catalog entry or the add target. */
  name: string
  /** The pnpm target actually handed to the child process. */
  target: string
  /** True when anything this run installed still needs a restart. */
  needsRestart: boolean
  /** True when every added package is live in this process. */
  hot: boolean
  warnings: string[]
  added: AddedPackage[]
  ignoredBuilds?: IgnoredBuilds
  risks?: CompatRisk[]
  /** Sanitized failure detail, present only when `ok` is false. */
  reason?: string
  /**
   * Machine-readable failure class. The route uses it to choose a status
   * code — a source that is not in the curated catalog is the caller's error
   * (400), while a child process that failed is a server-side one (500).
   */
  code?: 'not-in-registry' | 'unsupported-source' | 'helpers-missing' | 'catalog-unavailable' | 'failed' | 'cancelled' | 'busy'
  exitCode: number
  cancelled: boolean
  timedOut: boolean
}

/** Options for {@link installPlugin}. */
export interface InstallPluginOptions {
  /** Registry entry that authorized the install (skips the entry lookup). */
  entry?: RegistryPlugin
  /**
   * Catalog already loaded by the caller. Passing it avoids a second
   * revalidation of the same document inside one request.
   */
  registry?: Registry
  /** Extra argv injected after `add` (rollback and restore paths). */
  extraArgs?: string[]
  /** Override the registered configuration for this one call (tests). */
  config?: Partial<InstallConfig>
  /** Diagnostics hook so a caller can report progress. */
  onPhase?: (phase: string) => void
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Cap on a warning string copied into a response payload. */
const WARNING_LIMIT = 800

/** Collapse a failed run into one bounded, log-safe line. */
function failureReason(result: InstallResult): string {
  const detail = (result.stderr.trim() || result.stdout.trim()).slice(-WARNING_LIMIT)
  if (detail !== '') return detail
  if (result.timedOut) return 'the plugin command timed out'
  return `the plugin command failed with exit code ${String(result.exitCode)}`
}

/** Serialize pnpm's own structured error when it said more than stderr did. */
function structuredError(result: InstallResult): string | null {
  const message = (result as { pnpmError?: unknown }).pnpmError
  if (typeof message !== 'string' || message === '') return null
  const code = (result as { pnpmErrorCode?: unknown }).pnpmErrorCode
  return typeof code === 'string' && code !== '' ? `${code}: ${message}` : message
}

/**
 * The package name pnpm reported as newly added, parsed from CLI output.
 *
 * The authoritative "what did this add" answer is the installed-package diff,
 * and the install route uses that. This parser exists for the paths where the
 * diff cannot answer — a command whose manifest write did not happen, or a
 * caller that only has captured output — and it must therefore never guess: an
 * unrecognised shape returns undefined rather than a wrong name that would
 * then be passed to `hotMount` and `setAllowBuilds`.
 *
 * Shapes handled, most specific first:
 *  - pnpm's dependency delta, `+ name@1.2.3` / `+ @scope/name@1.2.3`;
 *  - a human `Adding <spec>` / `Installed <spec>` sentence.
 *
 * @param stdout - captured stdout.
 * @returns the bare package name, or undefined when it cannot be determined.
 */
export function parseAddedPackage(stdout: string): string | undefined {
  if (stdout.trim() === '') return undefined
  const namePattern = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u
  const bareOf = (spec: string): string | undefined => {
    const trimmed = spec.trim().replace(/[.,;]$/u, '')
    if (trimmed === '') return undefined
    const at = trimmed.lastIndexOf('@')
    const name = at > 0 ? trimmed.slice(0, at) : trimmed
    return namePattern.test(name) ? name : undefined
  }
  const delta = /^\s*\+\s+(\S+)\s*$/mu.exec(stdout)
  if (delta !== null && delta[1] !== undefined) {
    const name = bareOf(delta[1])
    if (name !== undefined) return name
  }
  const sentence = /^\s*(?:Adding|Installed|installed)\s+(\S+)\s*$/mu.exec(stdout)
  if (sentence !== null && sentence[1] !== undefined) {
    const name = bareOf(sentence[1])
    if (name !== undefined) return name
  }
  return undefined
}

/**
 * The package pnpm's fetcher refused to prepare because its build script is
 * not allowlisted: `The git-hosted package "name@2.8.0" needs to execute build
 * scripts but is not in the "allowBuilds" allowlist.`
 *
 * Unlike an ignored build, this package is NOT in node_modules yet — the
 * fetcher rejects before materialization — so it exists in neither the
 * manifest nor the installed tree. It is the one blocked-build shape that
 * cannot be discovered by looking at the profile, which is why the
 * approve-builds flow needs it reported separately.
 *
 * The galaxy runs pnpm with `--reporter=ndjson`, so the sentence usually
 * arrives inside a JSON string with its quotes escaped; unescaping before
 * matching is what makes the banner appear at all on the ONLY path production
 * uses.
 */
export function parsePrepareNotAllowed(stdout: string, stderr: string): string | null {
  const text = `${stdout}\n${stderr}`.replace(/\\"/gu, '"')
  const match = /git-hosted package "([^"]+)" needs to execute build scripts/u.exec(text)
  if (match === null || match[1] === undefined) return null
  const raw = match[1].trim()
  // Strip the trailing @version — the name itself may be scoped.
  const at = raw.lastIndexOf('@')
  return at > 0 ? raw.slice(0, at) : raw
}

/**
 * Build the {@link IgnoredBuilds} payload from a finished run, or undefined
 * when pnpm reported nothing blocked.
 *
 * @param result - the finished child run.
 * @param parse - `domain/pnpm-compat.ts`'s `parseIgnoredBuilds`.
 */
export function ignoredBuildsFor(
  result: InstallResult,
  parse?: (stdout: string) => IgnoredBuilds,
): IgnoredBuilds | undefined {
  const structured = (result as { ignoredBuilds?: unknown }).ignoredBuilds
  if (Array.isArray(structured) && structured.length > 0) {
    return { packages: structured.filter((item): item is string => typeof item === 'string') }
  }
  const parsed = parse?.(`${result.stdout}\n${result.stderr}`)
  if (parsed !== undefined && parsed.packages.length > 0) return parsed
  const pending = parsePrepareNotAllowed(result.stdout, result.stderr)
  if (pending === null) return parsed !== undefined && parsed.packages.length > 0 ? parsed : undefined
  const packages = [...(parsed?.packages ?? []), pending]
  return {
    packages: [...new Set(packages)],
    ...(parsed?.detail === undefined ? {} : { detail: parsed.detail }),
  }
}

/** Resolve the catalog entry that authorizes `source`, or undefined. */
export function registryEntryFor(registry: Registry, source: string): RegistryPlugin | undefined {
  const wanted = source.trim().toLowerCase()
  if (wanted === '') return undefined
  return registry.plugins.find(plugin =>
    (typeof plugin.url === 'string' && plugin.url.toLowerCase() === wanted)
    || (typeof plugin.npm === 'string' && plugin.npm.toLowerCase() === wanted)
    || plugin.name.toLowerCase() === wanted)
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

/** A failed validation of the source, recorded as a normal result. */
function rejected(
  name: string,
  target: string,
  reason: string,
  code: NonNullable<InstallPluginResult['code']> = 'failed',
): InstallPluginResult {
  return {
    ok: false,
    name,
    target,
    needsRestart: true,
    hot: false,
    warnings: [],
    added: [],
    reason,
    code,
    exitCode: 1,
    cancelled: false,
    timedOut: false,
  }
}

/** The mutation pipeline's captured "before" state. */
export interface MutationContext {
  config: InstallConfig
  profile: string
  dir: string
  /** Installed dependency set before the run (in-box bundles filtered out). */
  before: Set<string>
  manifestBefore: ProfileManifestSnapshot
  lockfileBefore: string | null
  /** Present only when a sibling assessor was registered for this mount. */
  compatibilityBefore?: CompatAssessmentLike
}

/**
 * Report an operation stage to the caller's hook AND the mount's progress
 * tracker.
 *
 * The hook is for callers that care (`onPhase`); the tracker is what the
 * browser reads while the operation runs. Reporting is
 * best-effort by construction: progress must never be able to break an install.
 */
function phaseReporter(runtime: GalaxyRuntime, onPhase?: (phase: string) => void): (phase: string) => void {
  return (phase: string) => {
    onPhase?.(phase)
    try {
      progressTracker(runtime).phase(phase)
    } catch {
      // A tracker that cannot be reached is not worth failing an install for.
    }
  }
}

/** Options accepted by {@link runPackageMutation}. */
export interface MutationOptions {
  /** Extra argv injected after the subcommand (rollback and restore paths). */
  extraArgs?: string[]
  /** Diagnostics hook so a caller can report progress. */
  onPhase?: (phase: string) => void
}

/**
 * Capture everything a mutation has to be able to undo.
 *
 * @returns the captured context, or undefined when the mount has not been
 *   wired with the sibling helpers (the caller answers 500).
 */
export function captureMutation(
  profile: string,
  dir: string,
  runtime: GalaxyRuntime,
): MutationContext | undefined {
  const config = installConfigOf(runtime)
  if (config === undefined || config.validateAddedPlugins === undefined) {
    logEvent('error', 'install', 'install helpers are not registered for this mount')
    return undefined
  }
  const beforeMap = readInstalled(profile, dir)
  // The compatibility assessment is optional: with no sibling assessor the
  // risk report is simply absent, which is better than inventing one.
  let compatibilityBefore: CompatAssessmentLike | undefined
  try {
    compatibilityBefore = config.assessProfile?.(profile, dir)
  } catch (error) {
    logEvent('warn', 'install-compat', `the profile could not be assessed before the mutation — ${(error as Error).message}`)
  }
  return {
    config,
    profile,
    dir,
    before: new Set(Object.keys(beforeMap)),
    manifestBefore: readProfileManifestSnapshot(profile, dir),
    lockfileBefore: readLockfile(profile, dir),
    ...(compatibilityBefore === undefined ? {} : { compatibilityBefore }),
  }
}

/**
 * Run one `add <target>` mutation and everything that must follow it:
 * manifest rollback on failure, the fake-success guard, hot mount and the
 * compatibility risk report.
 *
 * Shared by the install route (which resolves and authorizes the target
 * first) and by the update route (which computes its own target from the
 * installed spec, so an already-installed plugin whose source is no longer in
 * the catalog can still be updated).
 *
 * @param context - the captured "before" state.
 * @param target - the pnpm install target (already authorized by the caller).
 * @param label - catalog name, used for logging.
 * @param runtime - the mount supplying the runner.
 * @param options - extra argv and a phase hook.
 */
export async function runPackageMutation(
  context: MutationContext,
  target: string,
  label: string,
  runtime: GalaxyRuntime,
  options: MutationOptions = {},
): Promise<InstallPluginResult> {
  const { config, profile, dir } = context
  const reportPhase = phaseReporter(runtime, options.onPhase)
  reportPhase('install')
  const result = await runtime.runner(profile, ['add', target, ...(options.extraArgs ?? [])])
  const cancelled = result.cancelled === true
  const failed = result.exitCode !== 0 || result.timedOut === true
  if (failed && !cancelled) {
    // The host writes `dependencies` and `dsh.profile.bundles` before the
    // build-script check and the registry fetches run. Either residue can
    // break every later operation or the next boot, so a failed run is undone.
    try {
      restoreProfileManifest(profile, context.manifestBefore, dir)
      restoreLockfile(profile, context.lockfileBefore, dir)
      logEvent('warn', 'install', `${label}: restored the profile manifest and lockfile after a failed run`)
    } catch (error) {
      logEvent('error', 'install', `${label}: rollback of the failed run did not complete — ${(error as Error).message}`)
    }
  }
  return await finishMutation(context, result, target, label, runtime)
}

/**
 * The post-run half of {@link runPackageMutation}: validation, activation and
 * risk reporting. Kept separate so the update route may retarget a collection
 * repository (or a restore) between the raw run and the validation.
 */
export async function finishMutation(
  context: MutationContext,
  result: InstallResult,
  target: string,
  label: string,
  runtime: GalaxyRuntime,
  options: MutationOptions = {},
): Promise<InstallPluginResult> {
  const { config, profile, dir } = context
  const cancelled = result.cancelled === true
  const warnings: string[] = []
  const added: AddedPackage[] = []
  let ok = result.exitCode === 0 && result.timedOut !== true && !cancelled
  const reportPhase = phaseReporter(runtime, options.onPhase)
  reportPhase('verify')
  if (result.exitCode === 0 && !cancelled) {
    try {
      const validated = await config.validateAddedPlugins(runtime.runner, profile, context.before, dir)
      const kept = validated.keep ?? []
      const broken = validated.removedBroken ?? []
      if (broken.length > 0) warnings.push(`removed uninstallable pieces: ${broken.join(', ')}`)
      if (kept.length === 0) {
        ok = false
        const addedNames = validated.added ?? []
        warnings.push(addedNames.length === 0
          ? 'the plugin command reported success but the profile did not change'
          : `nothing installable survived validation (added: ${addedNames.join(', ')})`)
      }
      // Resolved versions come from the profile AFTER the run, which is the
      // only place that knows what pnpm actually materialized.
      for (const name of kept) {
        const version = readInstalledVersion(profile, name, dir)
        added.push({ name, ...(version === undefined ? {} : { version }), live: false })
      }
    } catch (error) {
      ok = false
      logEvent('error', 'install-verify', `${label}: validation failed — ${(error as Error).message}`)
      warnings.push(`post-install validation failed: ${(error as Error).message}`)
    }
  }

  // Hot mount: the whole point of the layer is to avoid a restart. Tried per
  // added package, and reported as hot only when EVERY one mounted — a
  // partially live install still owes a restart.
  let hot = false
  if (ok && added.length > 0 && config.hotMount !== undefined) {
    reportPhase('activate')
    hot = true
    for (const pkg of added) {
      try {
        const mounted = await config.hotMount(runtime, profile, pkg.name)
        pkg.live = mounted.ok
        if (!mounted.ok) {
          hot = false
          if (typeof mounted.reason === 'string' && mounted.reason !== '') warnings.push(mounted.reason)
        }
      } catch (error) {
        hot = false
        logEvent('warn', 'hot-mount', `${pkg.name}: ${(error as Error).message}`)
      }
    }
  }

  let risks: CompatRisk[] | undefined
  if (ok && added.length > 0 && context.compatibilityBefore !== undefined
    && config.assessProfile !== undefined && config.introducedRisks !== undefined) {
    try {
      const after = config.assessProfile(profile, dir)
      const introduced = config.introducedRisks(context.compatibilityBefore, after) ?? []
      if (introduced.length > 0) risks = introduced
    } catch (error) {
      logEvent('warn', 'install-compat', `${label}: compatibility assessment failed — ${(error as Error).message}`)
    }
  }

  const buildWarnings = ok || cancelled
    ? undefined
    : ignoredBuildsFor(result, config.parseIgnoredBuilds)
  const parsedName = parseAddedPackage(result.stdout)
  return {
    ok,
    name: added[0]?.name ?? parsedName ?? label,
    target,
    needsRestart: !hot,
    hot,
    warnings,
    added,
    ...(buildWarnings === undefined ? {} : { ignoredBuilds: buildWarnings }),
    ...(risks === undefined ? {} : { risks }),
    ...(ok || cancelled ? {} : { reason: structuredError(result) ?? failureReason(result) }),
    exitCode: result.exitCode,
    cancelled,
    timedOut: result.timedOut === true,
  }
}

/**
 * Optionally resolve a GitHub target to a commit-pinned one through the
 * region's available routes. Returns the original target on any failure, so a
 * lookup problem can never block an install.
 */
export async function accelerateTarget(
  config: Pick<InstallConfig, 'acceleratedTarget' | 'region'>,
  target: string,
  label: string,
): Promise<string> {
  const accelerate = config.acceleratedTarget
  if (accelerate === undefined) return target
  const region = config.region ?? 'global'
  try {
    return await accelerate(target, { region })
  } catch (error) {
    logEvent('warn', 'install-accelerate', `${label}: HEAD lookup failed — ${(error as Error).message}`)
    return target
  }
}

/**
 * Install one plugin into the profile, with every guard and validation the
 * reference implementation applies around the child process.
 *
 * A non-zero exit is a normal outcome, never a throw.
 *
 * @param profile - profile name handed to the runner.
 * @param dir - resolved profile directory (honours a Desktop-owned path).
 * @param source - catalog URL or npm name; authorized against the registry.
 * @param runtime - the mount supplying the runner, locks and cache.
 * @param options - entry override, extra argv, per-call config, phase hook.
 */
export async function installPlugin(
  profile: string,
  dir: string,
  source: string,
  runtime: GalaxyRuntime,
  options: InstallPluginOptions = {},
): Promise<InstallPluginResult> {
  const config: Partial<InstallConfig> | undefined = { ...installConfigOf(runtime), ...options.config }
  if (config.loadRegistry === undefined
    || config.installTargetFor === undefined
    || config.validateAddedPlugins === undefined) {
    logEvent('error', 'install', 'install helpers are not registered for this mount')
    return rejected(source, source, 'the galaxy install helpers are not registered for this mount', 'helpers-missing')
  }
  let registry: Registry
  if (options.registry !== undefined) {
    registry = options.registry
  } else {
    try {
      registry = await config.loadRegistry(profile, dir, false, runtime)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logEvent('error', 'install', `the curated registry could not be loaded: ${message}`)
      return rejected(source, source, message, 'catalog-unavailable')
    }
  }
  const entry = options.entry ?? registryEntryFor(registry, source)
  if (entry === undefined) {
    logEvent('warn', 'install-rejected', `not in the curated registry: ${source.slice(0, 120)}`)
    return rejected(source, source, 'plugin is not in the curated registry', 'not-in-registry')
  }
  const plainTarget = config.installTargetFor(registry, entry.url ?? '')
  if (plainTarget === undefined || plainTarget === '') return rejected(entry.name, '', 'unsupported source url', 'unsupported-source')

  // HEAD acceleration runs BEFORE anything downstream reasons about the spec,
  // so every later step sees exactly what will be installed. The helper
  // returns the original target on any lookup failure.
  const target = await accelerateTarget(config, plainTarget, entry.name)

  const context = captureMutation(profile, dir, runtime)
  if (context === undefined) return rejected(entry.name, target, 'the galaxy install helpers are not registered for this mount', 'helpers-missing')
  return await runPackageMutation(context, target, entry.name, runtime, {
    ...(options.extraArgs === undefined ? {} : { extraArgs: options.extraArgs }),
    ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
  })
}


/** Re-export so the route layer can name the captured manifest type. */
export type { ProfileManifestSnapshot }
