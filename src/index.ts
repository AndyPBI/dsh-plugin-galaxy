/**
 * Plugin Galaxy host entry (,
 * ).
 *
 * The plugin mounts its HTTP routes once the host profile composes the
 * `webServer` and `loader` services. Two deployment shapes exist and they
 * differ in who owns the process lifecycle:
 *
 *  - Web host: the profile directory is derived from `--profile`/config and
 * the galaxy may offer a restart button (subject to).
 *  - Desktop host: the shell owns the profile location and the process
 *    lifecycle, so `desktopProfiles.current.dir` is used and restart is
 *    forced off.
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountGalaxyRoutes, type GalaxyMountConfig, type GalaxyRoutesHost } from './api/index.ts'
import type { AgentsServiceLike } from './domain/agents.ts'
import { createDesktopPluginRuntime, type DesktopPnpmLike } from './domain/dsh-cli.ts'
import type { HostLogger } from './api/host.ts'
import { installGalaxySettings } from './domain/settings.ts'
import { logEvent } from './core/log.ts'

/** Name the loader knows this plugin by. */
export const name = 'dsh-plugin-galaxy'

/** Optional cordis configuration; the profile defaults to `web`. */
export type Config = Partial<Pick<GalaxyMountConfig, 'profile' | 'allowRestart' | 'maxSnapshots'>>

/** Structural subset of DSH Desktop's public `desktopProfiles` contract. */
interface DesktopProfilesLike {
  readonly current: { readonly name: string; readonly dir: string }
}

interface GalaxyEffectHost extends GalaxyRoutesHost {
  effect(callback: () => (() => void | Promise<void>), label: string): void
}

/**
 * The profile this host process actually booted (`--profile <name>` on the
 * dsh CLI invocation). Without it the galaxy would default to `web` and
 * installs from a secondary profile would mutate the real one.
 */
function argvProfile(): string | undefined {
  const argv = process.argv
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1]!.startsWith('-')) return argv[flag + 1]
  return undefined
}

/**
 * Resolve the host's `agents` inventory lazily — at request time, not at
 * startup, so the guard sees whichever agents exist by the time a file
 * mutation is asked for. Hosts without the service return undefined and the
 * guarded routes stay open.
 */
function agentsLookupOf(ctx: Context): () => AgentsServiceLike | undefined {
  return () => ctx.get('agents') as AgentsServiceLike | undefined
}

/**
 * Read the host logger defensively.
 *
 * `logger` is not in this plugin's inject list, so on a composition that does
 * not expose it the property access throws. A route must never fail because
 * logging was unavailable, so the read is guarded and a missing logger simply
 * means the galaxy's own `logEvent` sink is the only record.
 */
function optionalLogger(ctx: Context): { logger?: HostLogger } {
  try {
    const logger = (ctx as unknown as { logger?: HostLogger }).logger
    return logger === undefined || logger === null ? {} : { logger }
  } catch {
    return {}
  }
}

/**
 * Register the galaxy against the host context.
 * @param ctx - Host context that may acquire webServer and loader services.
 * @param config - Optional profile override from the loader.
 */
export function apply(ctx: Context, config?: Config): void {
  ctx.inject(['webServer', 'loader'], (hostCtx: Context) => {
    // Only INJECTED services may be read off a cordis context: any other
    // property access throws (`cannot get property "x" without inject`), and an
    // exception raised while registering routes leaves the plugin half-mounted
    // with no visible error. So the host handed to the route layer is a PLAIN
    // object built from the two things this fiber was actually injected with —
    // never the context itself.
    const routesHost: GalaxyRoutesHost = {
      webServer: (hostCtx as unknown as { webServer: GalaxyRoutesHost['webServer'] }).webServer,
      ...optionalLogger(hostCtx),
    }
    const desktopProfiles = ctx.get('desktopProfiles') as DesktopProfilesLike | undefined

    if (desktopProfiles === undefined) {
      const resolved: GalaxyMountConfig = {
        profile: config?.profile ?? argvProfile() ?? 'web',
        // Left UNDEFINED when unconfigured, deliberately: defaulting to true
        // here would turn "the operator said nothing" into "the operator said
        // yes", and restartAllowed() could no longer tell them apart — which
        // is exactly the distinction supervisor detection needs.
        allowRestart: config?.allowRestart,
        maxSnapshots: config?.maxSnapshots,
      }
      // Offer allowRestart as a switch on the settings page. Deliberately not
      // in the Desktop branch below: there the shell owns the process
      // lifecycle, so the value is not the user's to choose.
      installGalaxySettings(ctx, resolved)
      ;(hostCtx as unknown as GalaxyEffectHost).effect(
        () => mountGalaxyRoutes(routesHost, resolved, undefined, agentsLookupOf(ctx)),
        'dsh-plugin-galaxy: http routes',
      )
      return
    }

    // Desktop guarantees `desktopProfiles` exists before loader entries mount,
    // and prescribes this presence check plus a nested `desktopPnpm`
    // injection. Ordinary DSH keeps the CLI path above.
    hostCtx.inject(['desktopPnpm'], (desktopCtx: Context) => {
      const current = desktopProfiles.current
      const service = (desktopCtx as unknown as { desktopPnpm: DesktopPnpmLike }).desktopPnpm
      const runtime = createDesktopPluginRuntime(service, current.dir)
      const resolved: GalaxyMountConfig = {
        profile: current.name,
        profileDirectory: current.dir,
        // Relaunching a raw Electron process would bypass Desktop's launcher
        // lifecycle; the shell remains responsible for restart in this mode.
        allowRestart: false,
        maxSnapshots: config?.maxSnapshots,
      }
      const desktopHost = desktopCtx as unknown as GalaxyEffectHost
      desktopHost.effect(() => {
        const disposeRoutes = mountGalaxyRoutes({
          ...routesHost,
          ...optionalLogger(desktopCtx),
        }, resolved, runtime, agentsLookupOf(ctx))
        return async () => {
          disposeRoutes()
          await runtime.dispose()
        }
      }, 'dsh-plugin-galaxy: Desktop http routes and package operations')
    })
  })

  logEvent('info', 'bootstrap', `dsh-plugin-galaxy ${name} mounting`)
}
