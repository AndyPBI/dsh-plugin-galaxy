/**
 *
 * The host status endpoint.
 *
 * `GET /dsh-galaxy/status` is the busiest route in the plugin: the browser polls
 * it while an install runs, and the operations panel polls it while idle. It is
 * therefore read-only, cheap, and *incapable of failing* — a status route that
 * answers 500 leaves the UI with no way to find out that something is wrong.
 *
 * Every input is read behind an individual guard that degrades to a documented
 * fallback, and the only outbound work (the pnpm probe) is memoized:
 *
 *   - region/channel from via `readGalaxyState`, region falling
 *     back to the parallel `domain/regions.ts` resolver and then to `global`;
 *   - `busy` from (`runtime.locks`), which stays true through
 *     the post-processing window after pnpm exits — `progress.active` alone
 *     would report idle too early and the UI would bounce a restart off a 409;
 *   - `progress` from the per-runtime tracker;
 *   - `pnpm` from `domain/pnpm-compat.ts`, cached for
 *     {@link PNPM_CACHE_TTL_MS} in `runtime.cache('status.pnpm')` and bounded by
 *     {@link PNPM_PROBE_TIMEOUT_MS} so a hung or missing pnpm cannot make the
 *     poll stall. A failure is a *result* (`{ ok: false, hint }`), never an
 *     error status;
 *   - `restart` from `domain/restart.ts` capability VO;
 *   - `installed` as the sorted community dependency names (in-box bundles are
 *     already filtered by `readInstalled`).
 *
 * `` is browser-side only and is deliberately absent here:
 * ignoring an update prompt is session state the client owns.
 */

import { sendJson } from '../core/http.ts'
import { logEvent } from '../core/log.ts'
import { readInstalled } from '../core/profile.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import { readGalaxyState } from '../core/state.ts'
import type {
  Channel,
  GalaxyState,
  GalaxyStatus,
  PnpmProbe,
  Region,
  ResolvedConfig,
  RestartCapability,
} from '../core/types.ts'
import type { Router } from './router.ts'
import { hostVersionInfo } from '../domain/compatibility.ts'
import { progressTracker } from '../domain/progress.ts'
import { probePnpm } from '../domain/pnpm-compat.ts'
import { resolveRegion } from '../domain/regions.ts'
import { restartCapability } from '../domain/restart.ts'
import { catalogSourceView } from '../domain/catalog-source.ts'

/** How long a pnpm probe stays usable before it is re-measured. */
const PNPM_CACHE_TTL_MS = 60_000

/** Hard ceiling on one `pnpm --version` probe, so polling cannot stall. */
const PNPM_PROBE_TIMEOUT_MS = 5_000

/** Cache slot holding either the in-flight probe or its resolved value. */
const PNPM_CACHE_KEY = 'status.pnpm'

interface PnpmCacheEntry {
  result: PnpmProbe
  at: number
}

/** The channel reported when the state file carries none. */
const DEFAULT_CHANNEL: Channel = 'stable'

/** The region reported when neither the state file nor the resolver answers. */
const DEFAULT_REGION: Region = 'global'

/**
 * Evaluate `read`, falling back to `fallback` and logging when it throws.
 *
 * Used for the synchronous readers of the status route (state file, installed
 * map, capability VOs). The failure is logged once per request and the route
 * still answers 200 — the whole point of a status endpoint is that it reports
 * degraded state instead of refusing to describe it.
 */
function guarded<T>(what: string, read: () => T, fallback: T): T {
  try {
    const value = read()
    return value === undefined || value === null ? fallback : value
  } catch (error) {
    logEvent('warn', 'status', `${what} unavailable: ${(error as Error).message}`)
    return fallback
  }
}

/** The persisted galaxy state, or an empty one when it cannot be read. */
function safeState(runtime: GalaxyRuntime): GalaxyState {
  return guarded('galaxy state', () => readGalaxyState(runtime.dir), {})
}

/**
 * The region in force: the explicit/persisted choice wins, the parallel
 * `domain/regions.ts` resolver is asked next, and `global` is the last resort.
 */
function safeRegion(runtime: GalaxyRuntime, state: GalaxyState): Region {
  if (state.region !== undefined) return state.region
  return guarded('region', () => resolveRegion(runtime) as Region, DEFAULT_REGION)
}

/** Sorted community dependency names of the managed profile. */
function safeInstalled(runtime: GalaxyRuntime): string[] {
  const declared = guarded(
    'installed list',
    () => readInstalled(runtime.config.profile, runtime.dir),
    {} as Record<string, string>,
  )
  return Object.keys(declared).sort((left, right) => left.localeCompare(right))
}

/**
 * Probe pnpm, memoized for {@link PNPM_CACHE_TTL_MS}.
 *
 * A status poll must not spawn a process per request, and several tabs polling
 * at once must not spawn one each: the in-flight probe itself is cached, so
 * concurrent callers await the same child. Failures are cached too — a missing
 * pnpm is not going to appear between two polls 200ms apart, and the point of
 * the failure is the hint, not a retry.
 */
async function pnpmProbe(runtime: GalaxyRuntime): Promise<PnpmProbe> {
  const cached = runtime.cache<PnpmCacheEntry>(PNPM_CACHE_KEY)
  if (cached !== undefined && Date.now() - cached.at < PNPM_CACHE_TTL_MS) return cached.result

  const config = runtime.config
  const probe = probePnpm(config.profile, config)
  runtime.setCache(PNPM_CACHE_KEY, probe)
  let timer: ReturnType<typeof setTimeout> | undefined
  let result: PnpmProbe
  try {
    // A hung pnpm (a broken corepack shim, a locked store) would otherwise hold
    // the poll open indefinitely; the timeout turns it into a reportable state.
    result = await Promise.race([
      probe,
      new Promise<PnpmProbe>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, hint: 'pnpm probe timed out' }), PNPM_PROBE_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    logEvent('warn', 'status', `pnpm probe failed: ${(error as Error).message}`)
    result = { ok: false, hint: (error as Error).message }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  runtime.setCache(PNPM_CACHE_KEY, { result, at: Date.now() } satisfies PnpmCacheEntry)
  if (!result.ok) logEvent('warn', 'status', `pnpm unavailable: ${result.hint ?? 'unknown reason'}`)
  return result
}

/** Whether the host can be restarted from the UI (the restart capability VO). */
function safeRestart(config: ResolvedConfig, runtime: GalaxyRuntime): RestartCapability {
  return guarded<RestartCapability>(
    'restart capability',
    () => restartCapability(config, runtime),
    { allowed: false, reason: 'restart capability unavailable', debugger: false, scheduled: runtime.restartScheduled },
  )
}

/**
 * Register the host-runtime routes (group H): `GET /dsh-galaxy/status`.
 */
export function registerHostRoutes(router: Router, runtime: GalaxyRuntime): void {
  router.get('/dsh-galaxy/status', async ({ response }) => {
    // One state read per poll: the status endpoint is polled continuously, so
    // channel and region are derived from the same snapshot.
    const state = safeState(runtime)
    const status = {
      boot: runtime.bootId,
      version: runtime.version,
      channel: state.channel ?? DEFAULT_CHANNEL,
      region: safeRegion(runtime, state),
      profile: runtime.config.profile,
      busy: runtime.locks.isBusy(),
      progress: progressTracker(runtime).snapshot(),
      // The host release this profile was built for:
      // shown in the panel so an upgrade is visible instead of being guessed at.
      hostVersion: hostVersionInfo(runtime)?.version ?? null,
      hostVersionSource: hostVersionInfo(runtime)?.source ?? null,
      pnpm: await pnpmProbe(runtime),
      restart: safeRestart(runtime.config, runtime),
      installed: safeInstalled(runtime),
      // Which catalog this profile reads, and which layer decided it — the
      // settings card shows it and the write route returns the same shape.
      ...catalogSourceView(runtime.dir),
    } satisfies GalaxyStatus
    sendJson(response, 200, status)
  })
}
