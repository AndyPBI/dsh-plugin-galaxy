#!/usr/bin/env node
/**
 * Host-surface probe: does the INSTALLED DeepSeek Harness still offer every
 * contract this plugin uses?
 *
 * This exists because the interesting failures are silent. A removed slot is a
 * string — nothing fails to compile, the panel simply never appears. A removed
 * primitive only explodes on the render path that touches it. An unchanged
 * import specifier keeps working until the platform module table drops it. So
 * "does the plugin fit this host?" cannot be answered by building the plugin:
 * it has to be asked of the HOST's own files.
 *
 * Everything is read from the harness checkout given by `--harness` (default
 * `../deepseek-harness`), i.e. the code the running profile is built from:
 *
 *   1. `PLATFORM_MODULES` — every external our client bundle may require
 *   2. the host's built `ui-primitives` exports — our 7 dereferenced members
 *   3. the slot catalogue — our three slots, with the kinds we register
 *   4. the design token sheet — every `--dsw-alias-*` name our CSS uses
 *   5. peer versions — `cordis` / `schemastery` against our declared ranges
 *   6. contracts that were RENAMED/REMOVED — we must not reference them
 *
 * Exit codes: 0 = every contract holds, 1 = at least one is missing, 2 = the
 * harness checkout (or its build) is not there, which is a SKIP, not a failure.
 *
 * Usage: node scripts/check-host-surface.mjs [--harness <dir>] [--quiet]
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 || process.argv[index + 1] === undefined ? fallback : resolve(process.argv[index + 1])
}
const quiet = process.argv.includes('--quiet')
const harness = arg('--harness', join(workspace, '..', 'deepseek-harness'))

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    if (!quiet) console.log(`PASS  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
function skip(message) {
  console.error(`SKIP  ${message}`)
  process.exit(2)
}
function read(path) {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

if (!existsSync(join(harness, 'package.json'))) {
  skip(`no harness checkout at ${harness} (pass --harness <dir>)`)
}

/* ------------------------------------------------------------------ *
 * The plugin side: what we actually use
 * ------------------------------------------------------------------ */

const clientIndex = read(join(workspace, 'src', 'client', 'index.ts'))
const clientCss = read(join(workspace, 'src', 'client', 'Galaxy.module.css'))
const manifest = JSON.parse(read(join(workspace, 'package.json')))
if (clientIndex === undefined || clientCss === undefined) skip('client sources not found; run from the plugin checkout')

/** Members the client dereferences from `@deepseek-ai/dsh-client-ui-primitives`. */
const requiredPrimitives = [...clientIndex.matchAll(/^\s*'([A-Za-z0-9]+)',\s*$/gmu)]
  .map(match => match[1])
  .filter(name => !name.startsWith('Icon') || name.startsWith('Icon'))
const primitivesBlock = /export const REQUIRED_PRIMITIVES = \[([\s\S]*?)\]/u.exec(clientIndex)
const primitives = [...(primitivesBlock?.[1] ?? '').matchAll(/'([^']+)'/gu)].map(match => match[1])
if (primitives.length === 0) skip('could not read REQUIRED_PRIMITIVES from src/client/index.ts')

/** Slots we register, with the kind the catalogue must declare. */
const SLOTS = [
  { key: 'settings.section', kind: 'list' },
  { key: 'settings.plugin.item', kind: 'keyed' },
  { key: 'shell.overlay', kind: 'list' },
]
for (const slot of SLOTS) {
  if (!clientIndex.includes(`name: '${slot.key}'`)) skip(`expected slot ${slot.key} in src/client/index.ts`)
}

/** Specifiers our bundle may require (from the tsdown externals, as shipped). */
const bundle = read(join(workspace, 'client', 'client.js'))
const externals = bundle === undefined
  ? []
  : [...new Set([
    ...[...bundle.matchAll(/require\(["']([^"']+)["']\)/gu)].map(match => match[1]),
    ...[...bundle.matchAll(/["'](@deepseek-ai\/dsh-client-[a-z-]+)["']/gu)].map(match => match[1]),
  ])].filter(specifier => !specifier.startsWith('.'))

/* ------------------------------------------------------------------ *
 * 1. platform module table
 * ------------------------------------------------------------------ */

const platformSource = read(join(harness, 'packages', 'client', 'web', 'src', 'platform.ts'))
if (platformSource === undefined) skip('harness client platform.ts not found')
const platformBlock = /PLATFORM_MODULES = \[([\s\S]*?)\] as const/u.exec(platformSource)
const platform = [...(platformBlock?.[1] ?? '').matchAll(/'([^']+)'/gu)].map(match => match[1])
if (platform.length === 0) skip('could not read PLATFORM_MODULES')
const unavailable = externals.filter(specifier => !platform.includes(specifier))
check('every bundle external is in the host platform module table', unavailable.length === 0,
  unavailable.length === 0 ? `${String(externals.length)} specifier(s)` : unavailable.join(', '))

/* ------------------------------------------------------------------ *
 * 2. primitives the client dereferences
 * ------------------------------------------------------------------ */

const primitivesFile = [
  join(harness, 'packages', 'client', 'ui-primitives', 'lib', 'index.js'),
  join(harness, 'packages', 'client', 'ui-primitives', 'src', 'index.ts'),
].find(path => existsSync(path))
if (primitivesFile === undefined) skip('harness ui-primitives build not found (run the harness build first)')
const primitivesSource = read(primitivesFile) ?? ''
const exported = new Set(
  [...primitivesSource.matchAll(/\bexport\s*\{([^}]*)\}/gu)].flatMap(match =>
    match[1].split(',').map(part => part.trim().split(/\s+as\s+/u).pop()?.trim()).filter(Boolean)),
)
const missingPrimitives = primitives.filter(name => !exported.has(name))
check('every primitive this client uses is still exported by the host', missingPrimitives.length === 0,
  missingPrimitives.length === 0 ? `${String(primitives.length)} member(s): ${primitives.join(', ')}` : missingPrimitives.join(', '))

/* ------------------------------------------------------------------ *
 * 3. slot catalogue
 * ------------------------------------------------------------------ */

const catalogPath = join(harness, 'packages', 'extensions', 'cordis-client-runner', 'src', 'client', 'slot-catalog.ts')
const catalog = read(catalogPath)
if (catalog === undefined) skip('harness slot-catalog.ts not found')
for (const slot of SLOTS) {
  const at = catalog.indexOf(`key: '${slot.key}'`)
  const kind = at === -1 ? undefined : /kind: '([^']+)'/u.exec(catalog.slice(at, at + 400))?.[1]
  check(`slot ${slot.key} exists with kind ${slot.kind}`, kind === slot.kind, kind === undefined ? 'missing from the catalogue' : `kind=${kind}`)
}

/* ------------------------------------------------------------------ *
 * 4. design tokens
 * ------------------------------------------------------------------ */

const tokensPath = join(harness, 'packages', 'client', 'ui-theme', 'src', 'styles', 'design-platform.css')
const tokens = read(tokensPath)
if (tokens === undefined) skip('harness design-platform.css not found')
const declared = new Set([...tokens.matchAll(/(--dsw-alias-[a-z0-9-]+)\s*:/gu)].map(match => match[1]))
const used = [...new Set([...clientCss.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/(--dsw-alias-[a-z0-9-]+)/gu)].map(match => match[1]))]
const unknownTokens = used.filter(token => !declared.has(token))
check('every design token this stylesheet uses exists on the host', unknownTokens.length === 0,
  unknownTokens.length === 0 ? `${String(used.length)} token(s)` : unknownTokens.join(', '))

/* ------------------------------------------------------------------ *
 * 5. peer versions
 * ------------------------------------------------------------------ */

function versionOf(path, label) {
  const source = read(path)
  if (source === undefined) return undefined
  try { return JSON.parse(source).version } catch { return undefined }
}
const peerVersions = {
  '@deepseek-ai/cordis': versionOf(join(harness, 'vendor', 'cordis', 'package.json'))
    ?? versionOf(join(harness, 'apps', 'cli', 'node_modules', '@deepseek-ai', 'cordis', 'package.json')),
  '@deepseek-ai/schemastery': versionOf(join(harness, 'vendor', 'schemastery', 'package.json'))
    ?? versionOf(join(harness, 'apps', 'cli', 'node_modules', '@deepseek-ai', 'schemastery', 'package.json')),
}
for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
  const installed = peerVersions[name]
  if (installed === undefined) {
    check(`peer ${name} is present in the host`, false, 'not found in the checkout')
    continue
  }
  // Same comparator the compatibility column uses, so both agree on prereleases.
  const { satisfiesHostRange } = await import(new URL('../lib/domain/compatibility.js', import.meta.url).href)
  check(`peer ${name} ${range} accepts ${installed}`, satisfiesHostRange(installed, range) === true)
}

/* ------------------------------------------------------------------ *
 * 6. the local host patch this project depends on
 * ------------------------------------------------------------------ */

/**
 * `sidebar.footer.action` is a horizontal flex row upstream, so third-party
 * plugin footers that ask for the full sidebar width (dsh-workvista's
 * worktable requests width: 100%) are squeezed next to sibling actions
 * (dsh-knowledge's button).
 *
 * The fix is two lines in the HOST's sidebar CSS — and because it lives in the
 * host's checkout rather than in any plugin, an upgrade silently drops it: the
 * rc.2 upgrade did exactly that, and the symptom (footers laid out in a row)
 * looks like a plugin bug. Checking for it here is what turns that from
 * folklore into a test.
 */
const sidebarCss = read(join(harness, 'packages', 'client', 'ui-sidebar', 'src', 'client', 'SidebarRoot.module.css'))
if (sidebarCss === undefined) skip('harness ui-sidebar SidebarRoot.module.css not found')
const footerRules = [...sidebarCss.matchAll(/\.footerActions\s*\{([^}]*)\}/gu)].map(match => match[1])
const footerFlexRule = footerRules.find(body => /display:\s*flex/u.test(body)) ?? ''
check(
  'host patch: sidebar footer actions stack vertically',
  /flex-direction:\s*column/u.test(footerFlexRule),
  /flex-direction:\s*column/u.test(footerFlexRule)
    ? 'column with gap'
    : 'missing — plugin footers will be squeezed into one horizontal row; add `flex-direction: column; gap: 4px` to .footerActions in packages/client/ui-sidebar/src/client/SidebarRoot.module.css and rebuild the host',
)

/* ------------------------------------------------------------------ *
 * 6b. the action-row link declares the host's small-button metrics
 * ------------------------------------------------------------------ */

/*
 * 「官网插件页」 is an anchor (it must stay a real link: middle-click, copy
 * address) sitting in a row of `Button size="sm"`. The host's shell sets NO base
 * font-size — body/html/#root in its shipped CSS carry none — so an anchor that
 * merely inherits renders at the browser's 16px next to 12px buttons, which is
 * exactly how it looked bigger than 「查看评论」 in the same row.
 *
 * The rule that fixes it is ours; the NUMBERS belong to the host, so they are
 * read from its Button CSS instead of being copied here, where they would drift.
 */
const hostButtonCss = read(join(harness, 'packages', 'client', 'ui-primitives', 'src', 'Button.module.css'))
if (hostButtonCss === undefined) skip('harness ui-primitives Button.module.css not found')
const smRule = /\.sm\s*\{([^}]*)\}/u.exec(hostButtonCss)?.[1] ?? ''
/** One declaration out of a rule body; the last one may omit its semicolon. */
const metric = (body, property) => new RegExp(`${property}:\\s*([^;}]+)`, 'u').exec(body)?.[1]?.trim()
const hostSmFont = metric(smRule, 'font-size')
const hostSmLine = metric(smRule, 'line-height')
const actionLinkRule = /\.actionLink\s*\{([^}]*)\}/u.exec(clientCss)?.[1] ?? ''
const actionFont = metric(actionLinkRule, 'font-size')
const actionLine = metric(actionLinkRule, 'line-height')
check('action-row link uses the host small-button font size',
  hostSmFont !== undefined && actionFont === hostSmFont,
  actionFont === hostSmFont
    ? `${String(actionFont)} (Button.sm)`
    : `.actionLink font-size ${String(actionFont)} vs Button.sm ${String(hostSmFont)} — 「官网插件页」 would render larger than 「查看评论」`)
check('action-row link uses the host small-button line height',
  hostSmLine !== undefined && actionLine === hostSmLine,
  actionLine === hostSmLine
    ? `${String(actionLine)} (Button.sm)`
    : `.actionLink line-height ${String(actionLine)} vs Button.sm ${String(hostSmLine)}`)

const marketSource = read(join(workspace, 'src', 'client', 'MarketSection.tsx'))
const linkAnchors = (marketSource?.match(/\bcss\.link\b/gu) ?? []).length
const actionAnchors = (marketSource?.match(/\bcss\.actionLink\b/gu) ?? []).length
check('every site-link anchor carries .actionLink',
  linkAnchors > 0 && linkAnchors === actionAnchors,
  linkAnchors === actionAnchors
    ? `${String(linkAnchors)} anchor(s)`
    : `${String(linkAnchors)} \`css.link\` vs ${String(actionAnchors)} \`css.actionLink\` — an action-row link would inherit the browser's 16px again`)

/* ------------------------------------------------------------------ *
 * 7. host release, and contracts that were renamed away
 * ------------------------------------------------------------------ */

const hostVersion = JSON.parse(read(join(harness, 'package.json'))).version
check('the plugin declares a host range this release satisfies',
  typeof manifest.dsh?.hostVersion === 'string', `host ${hostVersion}, plugin declares ${String(manifest.dsh?.hostVersion)}`)

if (bundle !== undefined) {
  // Renamed/removed in 0.1.5-rc.2; a bundle that still names them would fail
  // silently at runtime, so assert it here too (belt and braces with the unit test).
  check('bundle does not use the `conversation` slot rc.2 moved', !bundle.includes("'conversation'"))
  check('bundle does not use the primitive rc.2 renamed', !bundle.includes('DocumentFileIcon'))
}

console.log('')
console.log(failures === 0
  ? `HOST SURFACE: PASS — plugin fits ${join(harness, '').replace(/\/$/u, '')} (host ${hostVersion})`
  : `HOST SURFACE: FAIL (${String(failures)}) on host ${hostVersion}`)
process.exit(failures === 0 ? 0 : 1)
