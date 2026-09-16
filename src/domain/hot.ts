/**
 * Hot-mount bookkeeping — / /,
 *
 * IMPORTANT — the host half of hot mounting is NOT available in this project.
 * Writing the `hot-<n>.yml` input file and recording the row in
 * `runtime.hotMounts` IS the contract: a caller that asks for a hot mount gets
 * `{ ok: false, reason }` when the plugin has nothing mountable, and both the
 * callers and the client treat "hot mount unavailable" as "restart required".
 * Nothing here imports the host loader, spawns a process, or touches the live
 * composition.
 *
 * The input files live under `<profile>/.dsh-galaxy/` and are wiped on every
 * boot (`cleanHotDir`), so a crash can never leave a file whose loader entry
 * collides with the bundle layer. `state.json` in the same directory is the
 * galaxy's own durable state and deliberately survives the wipe.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { writeFileAtomic } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import { galaxyDir, HOT_FILE_PREFIX, profileDir } from '../core/paths.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { HotRow } from '../core/types.ts'

/** Matches the hot input files: `hot-<n>.yml`. */
const HOT_FILE_RE = /^hot-(\d+)\.(?:yml|yaml)$/u
/** Row-id prefix the galaxy gives its own loader rows. */
const HOT_ROW_PREFIX = 'galaxy-'

/** Outcome of one hot-mount attempt. */
export interface HotMountResult {
  ok: boolean
  /** The recorded row when it mounted. */
  row?: HotRow
  /** Why it could not mount; callers surface this as "restart required". */
  reason?: string
}

/** One parsed loader row of a plugin's patch file. */
interface SimpleRow {
  id: string
  name: string
}

/**
 * Parse the plain `insert` rows of a patch document.
 *
 * Returns null when the document contains anything beyond plain rows (config
 * blocks, disables, expressions): those compositions cannot be hot-mounted and
 * must fall back to a restart.
 */
export function parseSimplePatch(patchText: string): SimpleRow[] | null {
  let parsed: unknown
  try {
    parsed = loadYaml(patchText) as unknown
  } catch {
    return null
  }
  if (parsed === null || parsed === undefined) return null
  if (!Array.isArray(parsed)) return null
  const rows: SimpleRow[] = []
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    const record = entry as Record<string, unknown>
    if (!Array.isArray(record.insert)) return null
    const keys = Object.keys(record)
    if (keys.some(key => key !== 'insert')) return null
    for (const inserted of record.insert) {
      if (inserted === null || typeof inserted !== 'object' || Array.isArray(inserted)) return null
      const row = inserted as Record<string, unknown>
      if (typeof row.id !== 'string' || typeof row.name !== 'string') return null
      if (row.name.includes('\n') || row.name.includes("'")) return null
      rows.push({ id: row.id, name: row.name })
    }
  }
  return rows.length > 0 ? rows : null
}

/** Absolute directory holding the hot input files. */
function hotDir(dir: string): string {
  return galaxyDir(dir)
}

/** The next unused `hot-<n>.yml` number for a profile directory. */
function nextHotNumber(dir: string): number {
  let highest = 0
  try {
    for (const name of readdirSync(hotDir(dir))) {
      const match = HOT_FILE_RE.exec(name)
      if (match !== null) highest = Math.max(highest, Number.parseInt(match[1]!, 10))
    }
  } catch { /* no hot files yet */ }
  return highest + 1
}

/** Serialize the loader rows of a hot input file. */
function serializeRows(rows: SimpleRow[]): string {
  return rows.map(row => `- id: '${row.id}'\n  name: '${row.name}'\n`).join('')
}

/**
 * Mount `name` into the running composition.
 *
 * **It cannot**: this project does not drive the host's loader, so nothing here
 * makes a plugin live in the current process. The function therefore always
 * answers `ok: false` with a "restart required" reason, and it deliberately does
 * NOT write a hot input file or record a row any more.
 *
 * That honesty is the point. The previous version wrote the file, logged
 * `host loading unavailable — restart applies it`, and returned `ok: true`; the
 * install route then reported `hot: true`, so a freshly installed plugin showed
 * no restart prompt and the operator was left with "I installed it and nothing
 * happened" — the plugin was in fact waiting for the next boot. A false success
 * is worse than no hot-mount at all.
 */
export function hotMount(runtime: GalaxyRuntime, profile: string, name: string): HotMountResult {
  const dir = profileDir(profile, runtime.dir)
  if (!existsSync(join(dir, 'node_modules', name, 'package.json'))) {
    return { ok: false, reason: `${name} is not installed in this profile / 该 profile 未安装 ${name}` }
  }
  logEvent('info', 'hot-mount', `${name}: host loading is unavailable in this build — the plugin activates on the next restart`)
  return {
    ok: false,
    reason: `host hot-mounting is unavailable in this build — restart required / 该版本不支持热挂载，需要重启 (${name})`,
  }
}

/**
 * The write-half of the old hot mount, kept ONLY for tests and for a future
 * loader integration: it records the rows the host would have to apply.
 *
 * @param runtime - the mount that owns the bookkeeping.
 * @param profile - profile name the package belongs to.
 * @param name - installed package to record.
 * @returns the written file and row, or null when there is nothing to write.
 */
export function writeHotRows(runtime: GalaxyRuntime, profile: string, name: string): HotRow | null {
  const dir = profileDir(profile, runtime.dir)
  if (!existsSync(join(dir, 'node_modules', name, 'package.json'))) return null
  let rows: SimpleRow[] | null = null
  try {
    rows = parseSimplePatch(readFileSync(join(dir, 'node_modules', name, 'cordis.patch.yml'), 'utf8'))
  } catch {
    rows = null
  }
  if (rows === null) rows = [{ id: `client-${name.replace(/[^A-Za-z0-9_.-]/gu, '-')}`, name }]
  const number = nextHotNumber(dir)
  const file = join(hotDir(dir), `${HOT_FILE_PREFIX}${String(number)}.yml`)
  const rowId = `${HOT_ROW_PREFIX}${String(number)}-${name.replace(/[^A-Za-z0-9_.-]/gu, '-')}`
  const labelled = rows.map((row, index) => ({ id: `${rowId}-${String(index)}`, name: row.name }))
  try {
    writeFileAtomic(file, serializeRows(labelled), 0o600)
  } catch (error) {
    logEvent('error', 'hot-mount', `${name}: could not write ${file}: ${(error as Error).message}`)
    return null
  }
  const row: HotRow = { name, rowId: labelled[0]!.id, file, mountedAt: Date.now() }
  runtime.hotMounts.set(rowId, row)
  return row
}

/**
 * Drop the bookkeeping for a hot-mount row and delete its input file.
 * @returns true when a record or file was there to remove.
 */
export function hotUnmount(runtime: GalaxyRuntime, profile: string, name: string): boolean {
  const dir = profileDir(profile, runtime.dir)
  let removed = false
  for (const [key, row] of [...runtime.hotMounts.entries()]) {
    if (row.name !== name) continue
    runtime.hotMounts.delete(key)
    try {
      if (existsSync(row.file)) rmSync(row.file, { force: true })
    } catch (error) {
      logEvent('warn', 'hot-unmount', `${name}: could not remove ${row.file}: ${(error as Error).message}`)
    }
    removed = true
  }
  // A row recorded by an earlier process (or a file left behind) still counts
  // as unmounted when its file is in this profile.
  try {
    for (const file of readdirSync(hotDir(dir))) {
      if (!HOT_FILE_RE.test(file)) continue
      const full = join(hotDir(dir), file)
      const text = readFileSync(full, 'utf8')
      if (!text.includes(`name: '${name}'`) && !text.includes(`name: ${name}`)) continue
      rmSync(full, { force: true })
      removed = true
    }
  } catch { /* no hot directory — nothing else to sweep */ }
  if (removed) logEvent('info', 'hot-unmount', `${name}: unmounted (restart applies the change)`)
  return removed
}

/** Every recorded hot-mount row of this mount, oldest first. */
export function listHotMounts(runtime: GalaxyRuntime): HotRow[] {
  return [...runtime.hotMounts.values()].sort((left, right) => left.mountedAt - right.mountedAt)
}

/** Names currently recorded as hot-mounted. */
export function hotMountNames(runtime: GalaxyRuntime): string[] {
  return [...new Set(listHotMounts(runtime).map(row => row.name))]
}

/**
 * Wipe leftover hot input files. Called once when the host starts; the galaxy
 * state file in the same directory deliberately survives.
 */
export function cleanHotDir(profile: string, dir: string): string[] {
  const remove = profileDir(profile, dir)
  const removed: string[] = []
  try {
    for (const file of readdirSync(hotDir(remove))) {
      if (!HOT_FILE_RE.test(file)) continue
      const full = join(hotDir(remove), file)
      rmSync(full, { force: true })
      removed.push(full)
    }
  } catch { /* no hot directory yet */ }
  if (removed.length > 0) logEvent('info', 'hot-sweep', `removed ${removed.length} leftover hot file(s)`)
  return removed
}

/**
 * Drop the bookkeeping for hot-mounted packages that were removed outside the
 * galaxy (e.g. `dsh plugin remove` in a terminal). A stale row would keep
 * serving a client bundle that 404s after a refresh.
 * @returns the names that were dropped.
 */
export function dropStaleHotMounts(runtime: GalaxyRuntime, profile: string): string[] {
  const dir = profileDir(profile, runtime.dir)
  const dropped: string[] = []
  for (const name of hotMountNames(runtime)) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) continue
    hotUnmount(runtime, profile, name)
    dropped.push(name)
    logEvent('warn', 'hot-sweep', `${name}: package removed outside the galaxy — hot record dropped`)
  }
  return dropped
}

/** Delete every hot-mount artifact for a profile (used by self-uninstall). */
export function purgeHotDir(profile: string, dir: string): boolean {
  const target = hotDir(profileDir(profile, dir))
  try {
    rmSync(target, { recursive: true, force: true })
    return true
  } catch (error) {
    logEvent('warn', 'purge', `could not remove ${target}: ${(error as Error).message}`)
    return false
  }
}
