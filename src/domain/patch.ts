/**
 * The user patch layer — / / /
 * (,
 * ).
 *
 * DSH composes a web profile from its bundle layers plus the profile's own
 * patch layer (`<profile>/cordis.patch.yml`). A row is one loader entry
 * override:
 *
 *   - `- id: <row-id>` + `disabled: true` stops that entry,
 *   - `- id: <row-id>` + `disabled: false` force-enables one a lower layer
 *     switched off,
 *   - `- insert: [ { id, name, … } ]` adds loader rows of its own.
 *
 * This module is the durable, HMR-friendly half of a toggle: the profile's
 * config watcher re-composes within about a second of the write, and the file
 * is re-read on every boot, so the choice survives restarts through the
 * official mechanism. It never decides whether a plugin is "on" for the UI —
 * that is the galaxy state's job — it only records the loader-level flip.
 *
 * Parsing uses `js-yaml` with the default schema (the dialect the host reads).
 * A malformed document is reported as `unreadable` rather than throwing: the
 * caller keeps operating with its own state and shows a warning. A package
 * with no patch file at all (`exists` false, `unreadable` false) is treated as
 * an ordinary empty profile, not as a trust failure — only a file that exists
 * and cannot be parsed blocks a write.
 *
 * Every write preserves the original document shape: rows are edited in place
 * through their raw entry object, so `insert:` blocks, config sub-trees and
 * unknown fields survive a toggle untouched.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dump as dumpYaml, load as loadYaml } from 'js-yaml'
import { writeFileAtomic } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import { profileDir } from '../core/paths.ts'

/** One row of the user patch layer. */
export interface PatchRow {
  /** Row id (`id:` field) — the loader entry this row overrides. */
  id: string
  /** Package name the row targets (`name:` field), when the row carries one. */
  name?: string
  /** `disabled: true` in the document. */
  disabled: boolean
  /** `disabled: false` — an explicit force-enable in the document. */
  forceEnabled: boolean
  /** Package names referenced by this row's `insert:` entries. */
  inserts: string[]
}

/** Read-only view of the user patch layer. */
export interface PatchStateV1 {
  /** True when `<profile>/cordis.patch.yml` exists. */
  exists: boolean
  /** Parsed rows; empty when the file is missing or unreadable. */
  rows: PatchRow[]
  /** Package names referenced by `insert:` entries (uninstall guard). */
  referenced: string[]
  /**
   * Raw row ids found in the document. Named `inserts` to match the wire
   * shape of `.inserts`.
   */
  inserts: string[]
  /** True when the file exists but could not be parsed as a row list. */
  unreadable: boolean
}

/** The galaxy itself never toggles itself off. */
export const GALAXY_PACKAGE_NAME = 'dsh-plugin-galaxy'

/**
 * The host infrastructure chain (every `@deepseek-ai`
 * package, the cordis built-ins) plus the galaxy itself. Switching one of
 * these off breaks the transport/hot-reload/storage chain the patch layer
 * runs on, so toggles are refused for them.
 */
const PROTECTED_PATTERNS: readonly RegExp[] = [
  /^cordis:/u,
  /^@deepseek-ai\//u,
  new RegExp(`^${GALAXY_PACKAGE_NAME}$`, 'u'),
]

/** Is this package host infrastructure or the galaxy? */
export function isProtectedModule(name: string): boolean {
  if (typeof name !== 'string' || name === '') return false
  return PROTECTED_PATTERNS.some(pattern => pattern.test(name))
}

/** Absolute path of the profile's user patch layer. */
export function userPatchPath(profile: string, explicitDir?: string): string {
  return join(profileDir(profile, explicitDir), 'cordis.patch.yml')
}

/** One parsed document entry, kept with its raw text shape for round-trips. */
interface PatchEntry {
  row: PatchRow
  raw: Record<string, unknown>
}

/** Turn one parsed document entry into a {@link PatchEntry}, or undefined. */
function toEntry(entry: unknown): PatchEntry | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const raw = entry as Record<string, unknown>
  const inserts: string[] = []
  if (Array.isArray(raw.insert)) {
    for (const inserted of raw.insert) {
      if (inserted === null || typeof inserted !== 'object' || Array.isArray(inserted)) continue
      const name = (inserted as Record<string, unknown>).name
      if (typeof name === 'string' && name !== '') inserts.push(name)
    }
  }
  const id = typeof raw.id === 'string' ? raw.id : undefined
  const name = typeof raw.name === 'string' ? raw.name : undefined
  if (id === undefined && name === undefined) return undefined
  return {
    raw,
    row: {
      id: id ?? name!,
      ...(name === undefined ? {} : { name }),
      disabled: raw.disabled === true,
      forceEnabled: raw.disabled === false,
      inserts,
    },
  }
}

/** Parse `cordis.patch.yml` text; null when it is not a top-level row list. */
function parseEntries(text: string): PatchEntry[] | null {
  let parsed: unknown
  try {
    parsed = loadYaml(text) as unknown
  } catch {
    return null
  }
  // An empty document and DSH's shipped `[]` placeholder both mean "no rows".
  if (parsed === null || parsed === undefined) return []
  if (!Array.isArray(parsed)) return null
  const entries: PatchEntry[] = []
  for (const raw of parsed) {
    const entry = toEntry(raw)
    if (entry === undefined) return null
    entries.push(entry)
  }
  return entries
}

/**
 * Read the user patch layer without ever throwing.
 *
 * A malformed document yields `unreadable: true` (with an empty row list) so
 * the caller can refuse a destructive step; a missing file is an ordinary
 * empty profile.
 */
export function readUserPatchState(profile: string, explicitDir?: string): PatchStateV1 {
  const file = userPatchPath(profile, explicitDir)
  if (!existsSync(file)) return { exists: false, rows: [], referenced: [], inserts: [], unreadable: false }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    logEvent('warn', 'patch', `cordis.patch.yml could not be read: ${(error as Error).message}`)
    return { exists: true, rows: [], referenced: [], inserts: [], unreadable: true }
  }
  const entries = parseEntries(text)
  if (entries === null) {
    logEvent('warn', 'patch', 'cordis.patch.yml is not a top-level list of loader rows; treating it as unreadable')
    return { exists: true, rows: [], referenced: [], inserts: [], unreadable: true }
  }
  const referenced = new Set<string>()
  for (const { row } of entries) {
    for (const name of row.inserts) referenced.add(name)
    // An insert row carries the package name directly; a plain override row
    // may name the package it targets instead of using its loader row id.
    if (row.name !== undefined && row.inserts.length === 0) referenced.add(row.name)
  }
  return {
    exists: true,
    rows: entries.map(entry => entry.row),
    referenced: [...referenced],
    inserts: entries.map(entry => entry.row.id),
    unreadable: false,
  }
}

/**
 * /: user-authored rows that still load
 * `packageName` (or one of its subpaths). Scans the raw document so a name is
 * found no matter how deeply it is nested inside an `insert:` row.
 */
export function userPatchPackageReferences(file: string, packageName: string): string[] {
  if (!existsSync(file)) return []
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const references = new Set<string>()
  let parsed: unknown
  try {
    parsed = loadYaml(text) as unknown
  } catch {
    // Unreadable document: a plain text scan is the conservative fallback —
    // it can only over-report references, which makes the guard stricter.
    for (const match of text.matchAll(/name:\s*['"]?([^'"\s]+)['"]?/gu)) {
      const name = match[1]
      if (name !== undefined) references.add(name)
    }
    return [...references].filter(name => matchesPackage(name, packageName))
  }
  const collect = (entries: unknown[]): void => {
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      if (typeof record.name === 'string') references.add(record.name)
      // Only group rows treat an array-valued config as child loader rows;
      // any other array is ordinary plugin configuration, not a reference.
      if (record.group === true && Array.isArray(record.config)) collect(record.config)
    }
  }
  if (Array.isArray(parsed)) {
    for (const patch of parsed) {
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) continue
      const record = patch as Record<string, unknown>
      if (!('insert' in record)) continue
      if (Array.isArray(record.insert)) collect(record.insert)
    }
  }
  return [...references].filter(name => matchesPackage(name, packageName))
}

/** True when `reference` loads `packageName` itself or one of its subpaths. */
function matchesPackage(reference: string, packageName: string): boolean {
  return reference === packageName || reference.startsWith(`${packageName}/`)
}

/** The loader row-id shapes one package owns (mirrors the plugin manager). */
function candidateRowIds(packageName: string): string[] {
  const scoped = packageName.replace(/^@/u, '').replace(/[^A-Za-z0-9_.-]/gu, '-').toLowerCase()
  const mangled = packageName.replace(/[^A-Za-z0-9_.-]/gu, '-')
  return [...new Set([packageName, scoped, mangled, `mkt-${mangled}`, `mkt-${scoped}`, `client-${scoped}`])]
}

/** True when a patch row belongs to `packageName`. */
function rowTargets(row: PatchRow, packageName: string): boolean {
  if (row.name !== undefined && matchesPackage(row.name, packageName)) return true
  if (row.inserts.some(name => matchesPackage(name, packageName))) return true
  return candidateRowIds(packageName).includes(row.id)
}

/** Serialize a whole row list, preserving every field the user wrote. */
function serializeEntries(entries: PatchEntry[]): string {
  if (entries.length === 0) return '# []\n'
  return dumpYaml(entries.map(entry => entry.raw), { lineWidth: 120, noRefs: true })
}

/** Core of enable/disable: parse, flip the targeting rows, write atomically. */
function setRowsEnabled(file: string, packageName: string, enabled: boolean): boolean {
  if (!existsSync(file)) return false
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  const entries = parseEntries(text)
  if (entries === null) {
    logEvent('warn', 'patch', `refused to write ${packageName}: ${file} is unreadable`)
    return false
  }
  const matches = entries.filter(entry => rowTargets(entry.row, packageName))
  if (matches.length === 0) return false
  let changed = false
  for (const entry of matches) {
    const wanted = enabled ? false : true
    if (entry.row.disabled !== wanted) changed = true
    if (enabled) {
      // `disabled: false` is an explicit force-enable: it is what flips a row
      // a lower layer switched off, so it is written rather than removed.
      entry.raw.disabled = false
      entry.row.disabled = false
      entry.row.forceEnabled = true
    } else {
      entry.raw.disabled = true
      entry.row.disabled = true
      entry.row.forceEnabled = false
    }
  }
  if (!changed) return true
  try {
    writeFileAtomic(file, serializeEntries(entries), 0o644)
  } catch (error) {
    logEvent('error', 'patch', `could not write ${file}: ${(error as Error).message}`)
    return false
  }
  logEvent('info', 'patch', `${enabled ? 'enabled' : 'disabled'} ${packageName} in ${file}`)
  return true
}

/** Force-enable the patch rows that target `packageName` (true = written). */
export function enableRow(file: string, packageName: string): boolean {
  return setRowsEnabled(file, packageName, true)
}

/** Disable the patch rows that target `packageName` (true = written). */
export function disableRow(file: string, packageName: string): boolean {
  return setRowsEnabled(file, packageName, false)
}

/**
 * Remove the disable/force rows that target `packageName` entirely.
 *
 * Line-scoped on purpose: hand-written comments, formatting and unrelated
 * rows survive untouched. Returns true when the file existed.
 */
export function removeRowBlocks(file: string, packageName: string): boolean {
  if (!existsSync(file)) return false
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  const ids = new Set<string>(candidateRowIds(packageName))
  let removed = 0
  const kept: string[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = /^-\s+id:\s*['"]?([^'"\s]+)['"]?\s*$/u.exec(line.trim())
    if (match === null || !ids.has(match[1]!)) {
      kept.push(line)
      continue
    }
    removed += 1
    // Drop this row's indented body (name/disabled/…) as well.
    while (index + 1 < lines.length && /^\s+\S/u.test(lines[index + 1] ?? '')) index += 1
  }
  if (removed === 0) return true
  let next = kept.join('\n')
  // A patch file of pure comments is not a top-level array and stops the host
  // from booting — keep the empty-list placeholder in that case.
  if (next.replace(/^\s*#.*$/gmu, '').trim() === '') next = '# []\n'
  try {
    writeFileAtomic(file, next, 0o644)
  } catch (error) {
    logEvent('error', 'patch', `could not write ${file}: ${(error as Error).message}`)
    return false
  }
  logEvent('info', 'patch', `removed ${removed} row block(s) for ${packageName} from ${file}`)
  return true
}
