/**
 * Self-uninstall: remove Plugin Galaxy from the profile it is serving.
 *
 * This is deliberately NOT the generic uninstall route. A destructive action on
 * the thing serving the request must be reachable only from the surface built
 * for it, never as a stray `{ name: "dsh-plugin-galaxy" }` on the ordinary
 * path — so it lives behind its own loopback-only endpoint and its own
 * `confirm` flag.
 *
 * Removing the running plugin is safe, which is not obvious: an already
 * imported module does not vanish with its files, so the process keeps serving
 * and the response completes normally. What is NOT safe is leaving its loader
 * entry live while its client bundle is gone from disk — the browser then 404s
 * on the bundle and the whole settings page wedges on the next refresh (#37).
 * That is why the entry is disabled as the last step, after the response.
 *
 * Opt-in cleanup only touches what the galaxy itself wrote: a plugin the
 * galaxy switched off stays off after it is gone, and the only UI that could
 * switch it back on has just been removed — but a hand-written patch row is the
 * user's, not ours, so only rows belonging to the galaxy's own disable list are
 * removed.
 *
 */

import { logEvent } from '../core/log.ts'
import { readInstalled } from '../core/profile.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import { readGalaxyState, purgeGalaxyState } from '../core/state.ts'
import type { InstallResult } from '../core/types.ts'

/* ------------------------------------------------------------------ *
 * Injected sibling implementations
 * ------------------------------------------------------------------ */

/** The sibling implementations a self-uninstall needs. */
export interface SelfUninstallConfig {
  /** `domain/patch.ts` — the user patch file for one profile. */
  userPatchPath: (profile: string, dir?: string) => string
  /** `domain/patch.ts` — drop every row that belongs to one package. */
  removeRowBlocks: (file: string, packageName: string) => boolean
  /** `domain/patch.ts` — read-only view of the patch layer. */
  readUserPatchState?: (profile: string, dir?: string) => { referenced?: readonly string[]; unreadable?: boolean }
  /** `domain/themes.ts` — disable the loader entry by package name. */
  setEntryDisabled?: (profile: string, dir: string, name: string, disabled: boolean) => boolean
}

/** Cache key holding the mount's {@link SelfUninstallConfig}. */
const CONFIG_CACHE_KEY = 'lifecycle.self-uninstall.config'

/** Register the sibling implementations for one mount. */
export function configureSelfUninstall(runtime: GalaxyRuntime, config: SelfUninstallConfig): void {
  runtime.setCache(CONFIG_CACHE_KEY, config)
}

/** The registered configuration, if the mount was wired. */
export function selfUninstallConfigOf(runtime: GalaxyRuntime): SelfUninstallConfig | undefined {
  return runtime.cache<SelfUninstallConfig>(CONFIG_CACHE_KEY)
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/** Names a DSH profile may have recorded for the galaxy itself. */
export const GALAXY_PACKAGE_NAMES: readonly string[] = ['dsh-plugin-galaxy']

/**
 * The profile dependency that IS this plugin, when one is installed.
 *
 * The published name comes first; legacy and alias spellings are accepted
 * afterwards so an older install can still remove itself instead of reporting
 * "not an installed dependency" while its own card sits on the page.
 *
 * @param installed - dependency map from the profile manifest.
 * @param aliases - additional names to accept (legacy spellings).
 */
export function resolveGalaxyPackageName(
  installed: Readonly<Record<string, string>>,
  aliases: readonly string[] = GALAXY_PACKAGE_NAMES,
): string | undefined {
  for (const name of aliases) {
    if (installed[name] !== undefined) return name
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

/** Options for {@link selfUninstall}. */
export interface SelfUninstallOptions {
  /** Explicit confirmation; the remove does not happen without it. */
  confirm: boolean
  /** Also restore the galaxy's own patch rows and delete its state directory. */
  purge: boolean
  /** Override the package names searched for (tests, legacy hosts). */
  selfNames?: readonly string[]
}

/** What a self-uninstall reports back to the route. */
export interface SelfUninstallResult {
  ok: boolean
  reason?: string
  /** The dependency that was removed (the galaxy's own name). */
  removed?: string
  /** True when the state directory and the galaxy's own patch rows were cleared. */
  purged?: boolean
  /** Packages whose galaxy-written patch rows were restored. */
  restored?: string[]
}

/** Cap on a reason string copied into a response payload. */
const REASON_LIMIT = 800

/** One bounded, log-safe description of a failed child run. */
function failureDetail(result: InstallResult): string {
  const detail = (result.stderr.trim() || result.stdout.trim()).slice(-REASON_LIMIT)
  return detail === '' ? 'removing the galaxy failed' : detail
}

/**
 * Remove the galaxy's own dependency from the profile, and optionally undo the
 * configuration it wrote.
 *
 * @param profile - profile name handed to the runner.
 * @param dir - resolved profile directory.
 * @param runtime - the mount supplying the runner and the injected config.
 * @param options - `confirm` (required) and `purge` (opt-in cleanup).
 */
export async function selfUninstall(
  profile: string,
  dir: string,
  runtime: GalaxyRuntime,
  options: SelfUninstallOptions,
): Promise<SelfUninstallResult> {
  // An explicit flag, not merely reaching the endpoint: this is the one route
  // whose accidental success cannot be undone from the UI that would have
  // undone it.
  if (options.confirm !== true) {
    return { ok: false, reason: 'self-uninstall requires an explicit confirmation / 自我卸载需要显式确认' }
  }
  const installed = readInstalled(profile, dir)
  const selfName = resolveGalaxyPackageName(installed, options.selfNames ?? GALAXY_PACKAGE_NAMES)
  if (selfName === undefined) {
    return { ok: false, reason: 'this plugin is not an installed dependency of this profile / 本插件不是该 profile 的已装依赖' }
  }
  const config = selfUninstallConfigOf(runtime)
  const disabled = readGalaxyState(dir).disabled ?? []
  const result = await runtime.runner(profile, ['remove', selfName])
  if (result.exitCode !== 0 || result.timedOut === true || result.cancelled === true) {
    // Report what pnpm actually said. A bare "removal failed" on the one action
    // the user cannot retry from a UI that is still there would leave them with
    // nothing to act on.
    const detail = failureDetail(result)
    logEvent('error', 'self-uninstall', `${selfName}: remove failed — ${detail}`)
    return { ok: false, removed: selfName, reason: detail }
  }

  const restored: string[] = []
  if (options.purge) {
    if (config !== undefined) {
      let file = ''
      try {
        file = config.userPatchPath(profile, dir)
      } catch (error) {
        logEvent('warn', 'self-uninstall', `the user patch file could not be located — ${(error as Error).message}`)
      }
      for (const name of disabled) {
        // Only rows the galaxy itself wrote are touched: a hand-written row is
        // the user's, not ours.
        if (file === '') continue
        try {
          if (config.removeRowBlocks(file, name)) restored.push(name)
        } catch (error) {
          logEvent('warn', 'self-uninstall', `${name}: patch rows could not be removed — ${(error as Error).message}`)
        }
      }
    }
    purgeGalaxyState(dir)
  }

  // LAST, and after the response in the route: disabling the loader entry
  // composes the next page load without the galaxy, which is what stops the
  // 404-on-refresh wedge. Doing it here keeps the side effect in one place.
  if (config?.setEntryDisabled !== undefined) {
    try {
      config.setEntryDisabled(profile, dir, selfName, true)
    } catch (error) {
      logEvent('warn', 'self-uninstall', `could not disable the loader entry: ${(error as Error).message}`)
    }
  }
  logEvent('info', 'self-uninstall', `removed ${selfName}${options.purge ? `; purged state, restored ${String(restored.length)} plugin(s)` : '; state kept'}`)
  return { ok: true, removed: selfName, purged: options.purge === true, restored }
}
