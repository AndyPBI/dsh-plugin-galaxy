/**
 * Mount point for every galaxy route.
 *
 * Resolves the profile, builds the per-mount {@link GalaxyRuntime}, registers
 * all eight route groups and returns a disposer. Route groups are registered
 * here rather than imported transitively so the complete endpoint surface of
 * the plugin is visible in one place:
 *
 *   1. catalog      — `GET /registry`, `POST /discovery-compatibility`
 *   2. tuning       — installed inventory, bundle order, presets, snapshots,
 *                     toggles, notes, favorites, groups, themes
 *   3. diagnostics  — `GET /check`, `GET /logs`
 *   4. protection   — backup, restore, WebDAV, Gist
 *   5. network      — updates, changelog, channel, region, GitHub proxy
 *   6. lifecycle    — install, update, uninstall, migrate, rollback,
 *                     self-uninstall, restart, approve-builds, cancel, pnpm
 *   7. v1           — the public versioned update API
 *   8. host         — `GET /status`
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configurePersistentLog, logEvent } from '../core/log.ts'
import { galaxyDir, LOG_FILE, profileDir } from '../core/paths.ts'
import { GalaxyRuntime } from '../core/runtime.ts'
import type { ResolvedConfig } from '../core/types.ts'
import type { AgentsServiceLike } from '../domain/agents.ts'
import { createCliRunner, type PluginRunner } from '../domain/dsh-cli.ts'
import { resolveRegionOnce } from '../domain/region-probe.ts'
import { UpdateOperationStoreV1 } from '../domain/update-api-v1.ts'
import type { GalaxyHost } from './host.ts'
import { Router } from './router.ts'
import { registerCatalogRoutes } from './routes-catalog.ts'
import { registerDiagnosticsRoutes } from './routes-diagnostics.ts'
import { registerHostRoutes } from './routes-host.ts'
import { registerLifecycleRoutes } from './routes-lifecycle.ts'
import { registerNetworkRoutes } from './routes-network.ts'
import { registerProtectionRoutes } from './routes-protection.ts'
import { registerTuningRoutes } from './routes-tuning.ts'
import { registerV1Routes } from './routes-v1.ts'

/** Default. */
export const DEFAULT_MAX_SNAPSHOTS = 20

/** Configuration accepted by {@link mountGalaxyRoutes}. */
export interface GalaxyMountConfig {
  profile?: string
  profileDirectory?: string
  allowRestart?: boolean
  maxSnapshots?: number
}

/** Host services the route layer needs. */
export type GalaxyRoutesHost = GalaxyHost

/** Read the plugin's own version from its package.json, best effort. */
function pluginVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url)
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', `file://${here}`), 'utf8')) as { version?: string }
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Mount the galaxy API on a host and return its disposer.
 * @param host - Host context providing `webServer` (and optionally `logger`).
 * @param config - Profile/config overrides from the loader.
 * @param runner - Package-operation runner; defaults to the `dsh` CLI runner.
 * @param agentsLookup - Lazy lookup of the host `agents` service.
 */
export function mountGalaxyRoutes(
  host: GalaxyRoutesHost,
  config: GalaxyMountConfig = {},
  runner?: PluginRunner,
  agentsLookup?: () => AgentsServiceLike | undefined,
): () => void {
  const profile = config.profile ?? 'web'
  const directory = profileDir(profile, config.profileDirectory)
  const resolved: ResolvedConfig = {
    profile,
    profileDirectory: directory,
    allowRestart: config.allowRestart,
    maxSnapshots: config.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS,
  }
  const version = pluginVersion()
  const operations = new UpdateOperationStoreV1(`${Date.now().toString(36)}`)
  /*
   * The CLI runner must be handed THIS runtime, and the runtime must be handed
   * a runner — a cycle the mount resolves with a late binding.
   *
   * It matters that the runner gets the real runtime: that is how the running
   * child becomes reachable for `POST /cancel` (`runtime.activeProcess`) and how
   * its output reaches the progress snapshot the panel polls. Creating the
   * runner WITHOUT it — `createCliRunner(resolved)` — silently disabled both, so
   * the panel could never show progress and its cancel button did nothing. The
   * proxy closes the cycle while keeping `runner` readonly, and it is only ever
   * used before the assignment below, in which window there is nothing to run.
   */
  let cliRunner: PluginRunner | undefined
  const lateRunner: PluginRunner = (profile, args) => {
    if (cliRunner === undefined) {
      return Promise.resolve({
        exitCode: 127,
        stdout: '',
        stderr: 'dsh-plugin-galaxy: the package runner is not wired yet',
        timedOut: false,
        cancelled: false,
      })
    }
    return cliRunner(profile, args)
  }
  lateRunner.dispose = async (): Promise<void> => { await cliRunner?.dispose() }

  const runtime = new GalaxyRuntime({
    config: resolved,
    runner: runner ?? lateRunner,
    operations,
    version,
    ...(agentsLookup === undefined ? {} : { agentsLookup }),
  })
  if (runner === undefined) cliRunner = createCliRunner(resolved, runtime)
  const router = new Router(host, runtime)

  // Persistent, sanitized event log for issue reports.
  configurePersistentLog(join(galaxyDir(directory), LOG_FILE))
  logEvent('info', 'bootstrap', `mounting dsh-plugin-galaxy ${version} for profile ${profile} (${directory})`)

  registerCatalogRoutes(router, runtime)
  registerTuningRoutes(router, runtime)
  registerDiagnosticsRoutes(router, runtime)
  registerProtectionRoutes(router, runtime)
  registerNetworkRoutes(router, runtime)
  registerLifecycleRoutes(router, runtime)
  registerV1Routes(router, runtime)
  registerHostRoutes(router, runtime)
  logEvent('info', 'bootstrap', `${router.size} routes registered`)

  // One-shot, lazy detection of the best download region.
  // Never blocks the mount and never fails the plugin.
  void resolveRegionOnce(runtime).then(
    (region) => { logEvent('info', 'region', `resolved download region: ${region}`) },
    (error: unknown) => { logEvent('warn', 'region', `region probe failed: ${(error as Error).message}`) },
  )

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    runtime.disposed = true
    router.dispose()
    configurePersistentLog(null)
    logEvent('info', 'bootstrap', 'dsh-plugin-galaxy disposed')
  }
}
