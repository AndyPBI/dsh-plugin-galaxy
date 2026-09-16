/**
 * Reading the plugin catalog out of an installed npm package.
 *
 * What this module owns:
 *   - the catalog published as `dsh-plugin-catalog`,
 *   - the payload shape this module returns,
 *   - one entry of that payload,
 *   - the browse panel's offline-capable source.
 *
 * The catalog's own host is a web origin; a network-filtered machine may not
 * be able to read it even though the package manager reached npm fine. The
 * catalog is therefore also published as a package, and this module reads the
 * copy that is ALREADY on disk inside the profile. Nothing here touches the
 * network: only `node:fs`, so the fallback cannot fail for the same reason the
 * live fetch did.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Registry, RegistryPlugin } from '../core/types.ts'

/** Package that carries a copy of the catalog. */
export const CATALOG_PACKAGE = 'dsh-plugin-catalog'

/** File inside that package holding the catalog JSON. */
export const CATALOG_PACKAGE_FILE = 'plugins.json'

/** How many parent directories to search; a profile tree is far shallower. */
const MAX_ASCENT = 8

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** One entry, or undefined when it carries nothing installable. */
function asPlugin(value: unknown): RegistryPlugin | undefined {
  const record = asObject(value)
  const name = nonEmptyString(record?.name)
  if (record === undefined || name === undefined) return undefined
  const url = nonEmptyString(record.url)
  const npm = nonEmptyString(record.npm)
  const tarball = nonEmptyString(record.tarball)
  if (url === undefined && npm === undefined && tarball === undefined) return undefined
  const plugin: RegistryPlugin = { name }
  if (url !== undefined) plugin.url = url
  if (npm !== undefined) plugin.npm = npm
  if (tarball !== undefined) plugin.tarball = tarball
  const owner = nonEmptyString(record.owner)
  if (owner !== undefined) plugin.owner = owner
  const category = record.category
  if (typeof category === 'string' && category.trim() !== '') plugin.category = category.trim()
  const description = nonEmptyString(record.description)
  if (description !== undefined) plugin.description = description
  if (typeof record.stars === 'number' && Number.isFinite(record.stars)) plugin.stars = record.stars
  if (typeof record.downloads === 'number' && Number.isFinite(record.downloads)) plugin.downloads = record.downloads
  if (typeof record.deprecated === 'boolean') plugin.deprecated = record.deprecated
  const replacement = nonEmptyString(record.replacement)
  if (replacement !== undefined) plugin.replacement = replacement
  const hostVersion = nonEmptyString(record.hostVersion)
  if (hostVersion !== undefined) plugin.hostVersion = hostVersion
  return plugin
}

/**
 * Locate `node_modules/dsh-plugin-catalog/plugins.json`, starting at `dir` and
 * walking up. Walking up matters: pnpm hoists a profile's dependencies to the
 * top-level `node_modules`, while an explicit directory may name a workspace
 * package one or two levels down.
 */
function locateCatalogFile(dir?: string): string | undefined {
  const start = dir !== undefined && dir.trim() !== '' ? resolve(dir) : process.cwd()
  let current = start
  for (let depth = 0; depth < MAX_ASCENT; depth += 1) {
    const candidate = join(current, 'node_modules', CATALOG_PACKAGE, CATALOG_PACKAGE_FILE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * The catalog carried by an installed `dsh-plugin-catalog` package.
 *
 * @param dir - profile directory to search from; defaults to the process cwd.
 * @returns the parsed catalog tagged with its provenance, or undefined when
 *   the package (or a usable payload inside it) is not present.
 */
export function catalogFromPackage(dir?: string): Registry | undefined {
  const file = locateCatalogFile(dir)
  if (file === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    // An unreadable or truncated package file is simply "not present": the
    // caller already has a live-fetch failure to report, and a second error
    // from the fallback would only bury it.
    return undefined
  }
  const record = asObject(parsed)
  const rows = Array.isArray(parsed) ? parsed : record?.plugins
  if (!Array.isArray(rows)) return undefined

  const plugins: RegistryPlugin[] = []
  for (const row of rows) {
    const plugin = asPlugin(row)
    if (plugin !== undefined) plugins.push(plugin)
  }
  if (plugins.length === 0) return undefined

  const registry: Registry = {
    plugins,
    count: plugins.length,
    source: `npm:${CATALOG_PACKAGE}`,
  }
  const updated = nonEmptyString(record?.updated)
  if (updated !== undefined) registry.updated = updated
  return registry
}
