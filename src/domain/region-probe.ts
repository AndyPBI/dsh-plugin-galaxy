/**
 * Deciding a download region by asking the network, once.
 *
 * The alternative was reading the system time zone, and it is wrong for
 * exactly the people who most need this to work: someone in Shanghai behind a
 * corporate proxy or a VPN reaches the official registry perfectly well and
 * would be routed onto mirrors they do not need, while a Chinese-locale
 * machine sitting in Singapore would be routed onto mirrors that are further
 * away than the origin. A time zone says where a clock is. It does not say
 * what the network can reach, which is the only question here.
 *
 * So the probe measures the thing itself: it asks both regions' npm mirrors
 * for the same small document and takes whichever answers first. It runs ONCE
 * — when nothing has ever been decided — and its answer is persisted as the
 * decision. Re-probing every boot would let the galaxy silently change routes
 * between runs, which is the kind of behaviour that makes "it was fast
 * yesterday" impossible to debug.
 */

import { logEvent } from '../core/log.ts'
import { fetchJson } from '../core/net.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import { readGalaxyState, updateGalaxyState } from '../core/state.ts'
import type { Region } from '../core/types.ts'
import { REGIONS, routesFor } from './regions.ts'

/**
 * What to ask each mirror for.
 *
 * The galaxy's own package: present on every npm mirror worth using, and
 * small — the `latest` document is a few KB, against ~320KB for the full
 * packument. A probe that downloads a third of a megabyte to answer "which of
 * these is closer" has spent more than the answer is worth.
 */
const PROBE_PATH = 'dsh-plugin-galaxy/latest'

/** How long to wait before giving up on all candidates. */
export const PROBE_TIMEOUT_MS = 2500

/** Outcome of one probe round. */
export interface RegionProbeOutcome {
  /** Winning region; `global` when nothing answered in time. */
  region: Region
  /** True when at least one mirror answered inside the budget. */
  probed: boolean
  /** Wall-clock time the decision took, for the log line. */
  elapsedMs: number
}

/**
 * Ask every region's registry the same question; return whichever answers
 * first.
 *
 * First-past-the-post rather than a latency comparison, deliberately. From
 * inside China the official registry usually does answer eventually, so "did
 * it fail" is the wrong test and "which came back first" is the right one.
 * From outside, the mainland mirror is reachable but further, and the same
 * rule picks global. One rule, both directions, no thresholds to tune.
 *
 * Persists nothing: callers that own a runtime use
 * {@link resolveRegionOnce}, and tests can exercise the decision alone.
 *
 * @param timeoutMs - budget per candidate; the whole probe is bounded by it.
 * @returns the winning region, whether anything answered, and how long it took.
 */
export async function probeRegions(
  timeoutMs: number = PROBE_TIMEOUT_MS,
  env: Record<string, string | undefined> = process.env,
): Promise<RegionProbeOutcome> {
  const started = Date.now()
  const ask = async (region: Region): Promise<Region> => {
    const url = `${routesFor(region, env).npm}/${PROBE_PATH}`
    const response = await fetchJson({
      url,
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-galaxy' },
      timeoutMs,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} from the ${region} registry`)
    // Read the body before declaring a winner. Headers can arrive from a
    // captive portal or a proxy that then stalls, and a region chosen on a
    // response that never finished would be chosen on nothing.
    if (response.text === '') throw new Error(`empty response from the ${region} registry`)
    return region
  }
  try {
    const region = await Promise.any(REGIONS.map(ask))
    return { region, probed: true, elapsedMs: Date.now() - started }
  } catch {
    // An unreachable network is not evidence for switching routes.
    return { region: 'global', probed: false, elapsedMs: Date.now() - started }
  }
}

/**
 * The region to run under, probing only if nothing has ever decided one.
 *
 * The probe's answer is written as `region` + `regionAuto: true` — and only
 * while the state still has no explicit region: a manual choice made while
 * the probe was in flight must win, so the guard is re-evaluated against the
 * freshly re-read state inside `updateGalaxyState`.
 *
 * @returns the region in force after the call.
 */
export async function resolveRegionOnce(runtime: GalaxyRuntime): Promise<Region> {
  const recorded = readGalaxyState(runtime.dir).region
  if (recorded !== undefined) return recorded

  const outcome = await probeRegions()
  updateGalaxyState(runtime.dir, (state) => {
    if (state.region !== undefined) return
    state.region = outcome.region
    state.regionAuto = true
  })
  logEvent('info', 'region', outcome.probed
    ? `no region on record; network probe chose ${outcome.region} in ${outcome.elapsedMs}ms`
    : `no region on record and no mirror answered in ${outcome.elapsedMs}ms; falling back to global`)
  return outcome.region
}
