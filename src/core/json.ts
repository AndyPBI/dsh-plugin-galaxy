/**
 * Small, atomic JSON/text file helpers.
 *
 * Every galaxy-owned file is written through {@link writeFileAtomic}: a
 * temporary sibling is filled and then renamed over the target, so a crash or
 * a concurrent reader never observes a half-written document. The temporary
 * file is created with mode 0600 because the documents can carry credentials
 * (profile configuration, backup payloads).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Create the parent directory of a file if it does not exist. */
export function ensureParent(file: string, mode = 0o700): void {
  const parent = dirname(file)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode })
}

/** Read and parse a JSON file; `undefined` when missing, unreadable or invalid. */
export function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Read a UTF-8 text file; `null` when it does not exist or cannot be read. */
export function readTextFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** True when the path exists as a regular file. */
export function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** Write text atomically: fill a temporary sibling, then rename over the target. */
export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
  ensureParent(file)
  const temporary = join(dirname(file), `.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    writeFileSync(temporary, text, { mode })
    renameSync(temporary, file)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch { /* the rename already consumed it, or the disk refused both */ }
    throw error
  }
}

/** Write a JSON document atomically, with a trailing newline. */
export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode)
}

/** Write an NDJSON document atomically. */
export function writeNdjsonAtomic(file: string, rows: unknown[], mode = 0o600): void {
  writeFileAtomic(file, rows.map(row => `${JSON.stringify(row)}\n`).join(''), mode)
}

/** Parse NDJSON content into rows, skipping unreadable lines. */
export function parseNdjson<T>(text: string | null): T[] {
  if (text === null) return []
  const rows: T[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      rows.push(JSON.parse(trimmed) as T)
    } catch { /* a torn trailing line is expected after a hard kill */ }
  }
  return rows
}

/** Deep, order-insensitive structural equality for JSON-shaped values. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right)
}

/** Serialize a JSON value with object keys sorted, for comparison. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}
