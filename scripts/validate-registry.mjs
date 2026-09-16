#!/usr/bin/env node
/**
 * Validate a Plugin Galaxy catalog payload.
 *
 * The catalog is the curated list of installable plugins and the only source
 * accepted by the install route, so a broken entry is a
 * broken install button. This script is the CI gate: it accepts a local file
 * path or a URL, checks the documented shape, and exits non-zero with a
 * readable report when anything is wrong.
 *
 * Usage:
 *   node scripts/validate-registry.mjs                       # live catalog
 *   node scripts/validate-registry.mjs path/to/plugins.json  # local file
 *   node scripts/validate-registry.mjs https://host/p.json   # explicit URL
 */

import { readFile } from 'node:fs/promises'

const DEFAULT_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const NAME_RE = /^(@[a-z0-9-~][a-z0-9._~-]*\/)?[a-z0-9-~][a-z0-9._~-]*$/iu
const MAX_DESCRIPTION = 2000
const MAX_PLUGINS = 5000

const target = process.argv[2] ?? process.env.DSHG_REGISTRY_URL ?? DEFAULT_URL

/** Load the payload from a file path or an HTTP(S) URL. */
async function load(target) {
  if (/^https?:\/\//iu.test(target)) {
    const response = await fetch(target, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`catalog fetch failed: HTTP ${response.status}`)
    return await response.json()
  }
  return JSON.parse(await readFile(target, 'utf8'))
}

/** Collect every problem with one catalog entry. */
function inspectPlugin(plugin, index, seen) {
  const problems = []
  const label = `plugins[${index}]`
  if (typeof plugin !== 'object' || plugin === null || Array.isArray(plugin)) {
    return [`${label}: not an object`]
  }
  const name = plugin.name
  if (typeof name !== 'string' || name.trim() === '') {
    problems.push(`${label}: missing "name"`)
  } else {
    if (!NAME_RE.test(name)) problems.push(`${label}: "name" is not a valid package name: ${name}`)
    if (seen.has(name)) problems.push(`${label}: duplicate "name": ${name}`)
    seen.add(name)
  }
  const sources = [plugin.url, plugin.npm, plugin.tarball].filter(value => typeof value === 'string' && value.trim() !== '')
  if (sources.length === 0) problems.push(`${label} (${name ?? '?'}): no usable source (url/npm/tarball)`)
  for (const key of ['url', 'npm', 'tarball', 'homepage']) {
    const value = plugin[key]
    if (value === undefined) continue
    if (typeof value !== 'string') problems.push(`${label} (${name ?? '?'}): "${key}" must be a string`)
  }
  if (typeof plugin.description === 'string' && plugin.description.length > MAX_DESCRIPTION) {
    problems.push(`${label} (${name ?? '?'}): description exceeds ${MAX_DESCRIPTION} characters`)
  }
  if (plugin.stars !== undefined && !Number.isFinite(Number(plugin.stars))) {
    problems.push(`${label} (${name ?? '?'}): "stars" is not numeric`)
  }
  if (plugin.deprecated === true && typeof plugin.replacement !== 'string') {
    problems.push(`${label} (${name ?? '?'}): deprecated entry has no "replacement"`)
  }
  return problems
}

try {
  const payload = await load(target)
  const problems = []
  if (typeof payload !== 'object' || payload === null) throw new Error('catalog is not an object')
  if (!Array.isArray(payload.plugins)) throw new Error('catalog has no "plugins" array')
  if (payload.plugins.length > MAX_PLUGINS) problems.push(`catalog has more than ${MAX_PLUGINS} entries`)
  const seen = new Set()
  payload.plugins.forEach((plugin, index) => { problems.push(...inspectPlugin(plugin, index, seen)) })

  if (problems.length > 0) {
    console.error(`registry validation FAILED (${problems.length} problem(s)) for ${target}`)
    for (const problem of problems.slice(0, 50)) console.error(`  - ${problem}`)
    if (problems.length > 50) console.error(`  … and ${problems.length - 50} more`)
    process.exit(1)
  }
  console.log(`registry validation PASSED: ${payload.plugins.length} plugin(s) in ${target}`)
} catch (error) {
  console.error(`registry validation ERROR: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
