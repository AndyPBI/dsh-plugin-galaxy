/**
 * Offline catalog matching against a local fixture.
 *
 * What this module owns:
 *   - an on-disk fixture in the same shape as the live
 *    catalog, used by tests and e2e runs,
 *   - the entries this module returns,
 *   - browsing without any network access,
 *   - source lookups that must work offline.
 *
 * The fixture is opt-in through `DSHG_REGISTRY_FIXTURE`; when that variable is
 * unset (the normal case for a real install) every call returns an empty list,
 * so this module adds no behaviour to a production process.
 */

import { logEvent } from '../core/log.ts'
import { readJsonFile } from '../core/json.ts'
import type { RegistryPlugin } from '../core/types.ts'

/** Environment variable naming the fixture file. */
export const FIXTURE_ENV = 'DSHG_REGISTRY_FIXTURE'

/** GitHub repository URL, optionally with a `/tree/<ref>/<subpath>` suffix. */
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/

/** Repository identity: exactly `owner/name`. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

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

/** Normalize one comparison key: trimmed, trailing slashes removed, lowercased. */
function key(value: string): string {
  return value.trim().replace(/\/+$/u, '').toLowerCase()
}

/** Valid subpath selector: no empty or traversal segments. */
function validSubpath(subpath: string): boolean {
  if (!/^[A-Za-z0-9_./-]+$/.test(subpath)) return false
  return !subpath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
}

/** Every identity a fixture entry can be looked up by. */
function keysOf(plugin: RegistryPlugin): Set<string> {
  const keys = new Set<string>()
  const add = (value: string | undefined): void => {
    if (value !== undefined) keys.add(key(value))
  }
  add(plugin.name)
  add(plugin.npm)
  add(plugin.tarball)
  add(plugin.url)
  for (const value of [plugin.url, plugin.npm]) {
    if (value === undefined) continue
    const target = githubTargetOf(value)
    if (target === undefined) continue
    keys.add(target.repo)
    if (target.subpath !== null) keys.add(`${target.repo}#path:/${key(target.subpath)}`)
  }
  return keys
}

/** One fixture row, narrowed to the fields a catalog entry may carry. */
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
  const category = nonEmptyString(record.category)
  if (category !== undefined) plugin.category = category
  const description = nonEmptyString(record.description)
  if (description !== undefined) plugin.description = description
  const install = nonEmptyString(record.install)
  if (install !== undefined) plugin.install = install
  const comments = nonEmptyString(record.comments)
  if (comments !== undefined) plugin.comments = comments
  if (typeof record.deprecated === 'boolean') plugin.deprecated = record.deprecated
  const replacement = nonEmptyString(record.replacement)
  if (replacement !== undefined) plugin.replacement = replacement
  return plugin
}

/** The fixture path in force, when one is configured. */
export function fixturePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[FIXTURE_ENV]
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

/** Every entry the fixture carries, or an empty list. */
function fixturePlugins(): RegistryPlugin[] {
  const file = fixturePath()
  if (file === undefined) return []
  const parsed = readJsonFile<unknown>(file)
  if (parsed === undefined) {
    // Not fatal: without a fixture this module is simply inert, and the log
    // line is what turns "the e2e saw an empty market" into a one-line answer.
    logEvent('warn', 'registry-fixture', `could not read ${FIXTURE_ENV} fixture`)
    return []
  }
  const record = asObject(parsed)
  const rows = Array.isArray(parsed) ? parsed : record?.plugins
  if (!Array.isArray(rows)) {
    logEvent('warn', 'registry-fixture', 'the catalog fixture carries no plugins array')
    return []
  }
  const plugins: RegistryPlugin[] = []
  for (const row of rows) {
    const plugin = asPlugin(row)
    if (plugin !== undefined) plugins.push(plugin)
  }
  return plugins
}

/** GitHub target behind a `github:` shortcut, an https URL, or a plain URL. */
function githubTargetOf(spec: string): { repo: string; subpath: string | null } | undefined {
  const trimmed = spec.trim()
  const shortcut = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.*))?$/.exec(trimmed)
  if (shortcut !== null) {
    const repo = (shortcut[1] as string).replace(/\.git$/i, '').toLowerCase()
    if (!REPO_RE.test(repo)) return undefined
    for (const selector of (shortcut[2] ?? '').split('&')) {
      const match = /^path:\/(.+)$/.exec(selector)
      if (match === null) continue
      const subpath = match[1] as string
      return validSubpath(subpath) ? { repo, subpath } : { repo, subpath: null }
    }
    return { repo, subpath: null }
  }
  const match = GITHUB_URL.exec(trimmed)
  if (match === null) return undefined
  const repo = (match[1] as string).replace(/\.git$/i, '').toLowerCase()
  if (!REPO_RE.test(repo)) return undefined
  const subpath = match[2]
  return { repo, subpath: subpath !== undefined && validSubpath(subpath) ? subpath : null }
}

/** Every comparison key one requested value stands for. */
function requestedKeys(raw: string): Set<string> {
  const keys = new Set<string>([key(raw)])
  const target = githubTargetOf(raw)
  if (target !== undefined) {
    keys.add(target.repo)
    if (target.subpath !== null) keys.add(`${target.repo}#path:/${key(target.subpath)}`)
  }
  return keys
}

/**
 * Fixture entries matching any of `names`.
 *
 * A name may be an npm package name, a catalog entry name, a repository URL,
 * a `github:owner/repo` shortcut, or a `github:owner/repo#path:/sub` target:
 * every one of those forms is reduced to the same comparison keys the fixture
 * entry publishes, so a caller does not have to know which spelling it holds.
 *
 * @returns matching entries in fixture order; an empty list when no fixture is
 *   configured, when it cannot be read, or when nothing matches.
 */
export function matchLocalCatalog(names: string[]): RegistryPlugin[] {
  const wanted = new Set<string>()
  for (const raw of names) {
    if (typeof raw !== 'string') continue
    if (raw.trim() === '') continue
    for (const candidate of requestedKeys(raw)) wanted.add(candidate)
  }
  if (wanted.size === 0) return []
  return fixturePlugins().filter((plugin) => {
    for (const candidate of keysOf(plugin)) if (wanted.has(candidate)) return true
    return false
  })
}
