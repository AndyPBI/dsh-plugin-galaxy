/**
 * Refuse profile mutations while a host agent is mid-turn.
 *
 * Rewriting `node_modules` under a live agent replaces files that the running
 * plugin modules may still read or lazily import, so an install can report
 * success while old and new code are mixed in one process. The guard is
 * therefore consulted by every mutating lifecycle route before it takes the
 * mutation lock.
 *
 * Two properties matter more than detection accuracy here:
 *
 *  - the host service is resolved LAZILY, at request time (`runtime.agentsLookup`),
 *    so an agent created after the plugin mounted is still seen;
 *  - an unrecognised service shape yields an empty list. A host that does not
 *    publish this optional service must never have its plugin page wedged by a
 *    guard that cannot read the inventory — failing open is the deliberate
 *    choice, and the reference implementation's "only a positive
 *    `status === 'running'` blocks" rule generalises to "only a readable
 *    running list blocks".
 *
 */

import type { GalaxyRuntime } from '../core/runtime.ts'

/** One entry of an agent inventory, in whichever shape the host publishes. */
export interface RunningAgentLike {
  id?: unknown
  name?: unknown
  status?: unknown
}

/**
 * Structural subset of the host's optional agent inventory.
 *
 * `list()` and `running()` are declared separately because hosts differ:
 * some publish the full inventory and mark entries, others publish only the
 * running set. A host that publishes neither simply never blocks.
 */
export interface AgentsServiceLike {
  list?: () => unknown
  running?: () => unknown
}

/** Read a string identity out of one inventory entry. */
function identityOf(entry: unknown, fallback: string): string | undefined {
  if (typeof entry === 'string') return entry === '' ? undefined : entry
  if (entry === null || typeof entry !== 'object') return undefined
  const record = entry as Record<string, unknown>
  for (const key of ['id', 'name', 'sessionId', 'agentId'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return fallback === '' ? undefined : fallback
}

/** Whether one inventory entry describes an agent that is still working. */
function isRunningEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false
  const status = (entry as Record<string, unknown>).status
  return status === 'running'
}

/** Throw-safe invocation of one optional member of the service. */
function probe(method: (() => unknown) | undefined): unknown {
  if (method === undefined) return undefined
  try {
    return method()
  } catch {
    // A half-disposed registry must never take the galaxy's routes down.
    return undefined
  }
}

/** Collect unique names from a plain list of entries. */
function namesFromList(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const names: string[] = []
  for (const entry of list) {
    if (!isRunningEntry(entry)) continue
    const name = identityOf(entry, names.length === 0 ? 'agent' : `agent-${names.length + 1}`)
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

/** Collect unique names from a `{ id: entry }` map of running agents. */
function namesFromRecord(record: Record<string, unknown>): string[] {
  const names: string[] = []
  for (const [key, value] of Object.entries(record)) {
    const running = value === true || isRunningEntry(value)
    if (!running) continue
    const name = identityOf(value, key)
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * The identity of every agent the host reports as running.
 *
 * An empty array means either "no agents service", "a service whose shape
 * this module cannot read", or "nothing is running" — all three keep the
 * route open, which is the only safe failure direction for an optional
 * host service.
 *
 * @param service - the host's agents service, or undefined.
 * @returns unique, human-readable agent identities; never throws.
 */
export function runningAgentsForGuard(service: AgentsServiceLike | undefined): string[] {
  if (service === undefined) return []
  const running = probe(service.running)
  if (Array.isArray(running)) return namesFromList(running)
  if (running !== null && typeof running === 'object') return namesFromRecord(running as Record<string, unknown>)
  if (typeof running === 'number' && running > 0) return ['agent']
  const listed = probe(service.list)
  if (Array.isArray(listed)) return namesFromList(listed)
  if (listed !== null && typeof listed === 'object') return namesFromRecord(listed as Record<string, unknown>)
  return []
}

/**
 * At request time: resolve the host service through the
 * runtime's lazy lookup and report the running agents.
 *
 * @param runtime - the mount whose `agentsLookup` is consulted now (not at mount).
 */
export function installBlocked(runtime: GalaxyRuntime): string[] {
  let service: AgentsServiceLike | undefined
  try {
    service = runtime.agentsLookup()
  } catch {
    // A lookup that throws (a disposing context) must not close the route.
    return []
  }
  return runningAgentsForGuard(service)
}
