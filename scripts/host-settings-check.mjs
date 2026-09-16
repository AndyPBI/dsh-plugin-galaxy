/**
 * Pre-install integration check: the settings wiring against the REAL host.
 *
 * `tests/settings.test.ts` proves the wiring against a faithful fake. This
 * script proves it against the genuine packages, loaded from the DSH checkout
 * by absolute path:
 *
 *   - `@deepseek-ai/cordis` — a real `Context`, so `inject`/`effect` behave as
 *     they do in production (a guarded property READ throws there, which is a
 *     bug class fakes cannot see).
 *   - `@deepseek-ai/dsh-settings` — the real `SettingsProvider`, whose
 *     `register` resolves a namespace by CALLING the schema, runs
 *     `redactSecrets` over the resolved value and serializes the schema with
 *     `toJSON()` for `describe()`. A descriptor object fails all three.
 *   - our built `lib/domain/settings.js`, so the artifact under test is the one
 *     that gets installed.
 *
 * Run after `npm run build`. Requires `@deepseek-ai/schemastery` to be
 * resolvable from this package (the script prints the one-line symlink when it
 * is not); on a real host the profile's dependency anchor provides it.
 *
 * Usage: node scripts/host-settings-check.mjs [--harness <deepseek-harness dir>]
 *                                            [--plugin <path to lib/domain/settings.js>]
 *
 * `--plugin` verifies an INSTALLED copy instead of the freshly built one. That
 * is the only way to prove the artifact sitting in a profile registers
 * correctly, because the lazy schemastery import then resolves through the
 * profile's own dependency anchor — the production resolution path.
 */

import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')

/** `--harness <dir>` wins, then `$DSH_HARNESS`, then the sibling checkout. */
function harnessRoot() {
  const flag = process.argv.indexOf('--harness')
  if (flag !== -1 && process.argv[flag + 1] !== undefined) return resolve(process.argv[flag + 1])
  if (process.env.DSH_HARNESS !== undefined && process.env.DSH_HARNESS !== '') return resolve(process.env.DSH_HARNESS)
  return resolve(workspace, '..', 'deepseek-harness')
}

const harness = harnessRoot()

/** The built artifact by default; `--plugin` selects an installed copy. */
function pluginEntryPath() {
  const flag = process.argv.indexOf('--plugin')
  if (flag !== -1 && process.argv[flag + 1] !== undefined) return resolve(process.argv[flag + 1])
  return join(workspace, 'lib', 'domain', 'settings.js')
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** Fail early and legibly when the CHECKOUT is incomplete, not the plugin. */
function requireFile(path, what) {
  if (existsSync(path)) return path
  console.error(`SKIP  ${what} not found at ${path}\n      pass --harness <deepseek-harness dir> or set DSH_HARNESS.`)
  process.exit(2)
}

// Pre-flight: our plugin loads schemastery LAZILY at runtime, from its own
// location. Without it the wiring degrades to "no switch" — correct plugin
// behaviour, but a useless check, so say so instead of reporting a false bug.
const pluginEntry = pluginEntryPath()
const require = createRequire(pluginEntry)
let schemastery
try {
  schemastery = require.resolve('@deepseek-ai/schemastery')
} catch {
  console.error(
    `SKIP  @deepseek-ai/schemastery is not resolvable from ${dirname(pluginEntry)}\n` +
    `      ln -sfn ${join(harness, 'vendor', 'schemastery')} ${join(workspace, 'node_modules', '@deepseek-ai', 'schemastery')}`,
  )
  process.exit(2)
}

const cordisEntry = requireFile(
  join(harness, 'apps', 'cli', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  '@deepseek-ai/cordis',
)
const settingsEntry = requireFile(
  join(harness, 'packages', 'settings', 'settings', 'lib', 'index.js'),
  '@deepseek-ai/dsh-settings',
)
const builtPlugin = requireFile(pluginEntry, 'the plugin under test (npm run build, or pass --plugin)')

const { Context } = await import(pathToFileURL(realpathSync(cordisEntry)).href)
const { SettingsProvider } = await import(pathToFileURL(realpathSync(settingsEntry)).href)
const { GALAXY_SETTINGS_NS, installGalaxySettings } = await import(pathToFileURL(builtPlugin).href)
console.log(`      plugin under test: ${builtPlugin}`)

/** Minimal writable in-memory provider, mirroring the host's own test double. */
class MemorySettings extends SettingsProvider {
  constructor(ctx) {
    super(ctx)
    this.doc = {}
  }

  get writable() {
    return true
  }

  load() {
    return Promise.resolve(structuredClone(this.doc))
  }

  persist(ns, section) {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

const ctx = new Context()
await ctx.plugin(MemorySettings)
check('real host settings service is up', typeof ctx.settings?.register === 'function')
check('schemastery resolved from the plugin location', typeof schemastery === 'string', schemastery)

// Negative control: the host contract the old plain descriptor violated. If
// this ever stops throwing, the host has changed and the wiring below needs a
// re-read before it can be trusted.
let controlFailed = false
try {
  ctx.settings.register('dsh-galaxy-negative-control', { allowRestart: { type: 'boolean', default: true } }, { base: {} })
} catch (error) {
  controlFailed = /schema is not a function/.test(String(error?.message))
}
check('a descriptor object is still rejected by the host', controlFailed)

// The composed value the routes read: supervisor-aware, explicit `false` here.
const config = { allowRestart: false }
installGalaxySettings(ctx, config)
await new Promise(resolve => setTimeout(resolve, 100))

const registration = ctx.settings.get(GALAXY_SETTINGS_NS)
check('namespace registered with the real service', registration !== undefined, JSON.stringify(registration))
check('base layer carries the composed value', registration?.allowRestart === false)
check('live config received the composed value', config.allowRestart === false)

// `describe()` is what a configuration UI calls: it serializes the schema with
// `toJSON()` AND runs `redactSecrets` over the resolved value.
let described
try {
  described = ctx.settings.describe().find(entry => entry.ns === GALAXY_SETTINGS_NS)
} catch (error) {
  check('describe() accepts the schema', false, error.message)
}
check('describe() accepts the schema', described !== undefined)
check(
  'described schema carries the boolean field',
  JSON.stringify(described?.schema ?? null).includes('allowRestart'),
  JSON.stringify(described?.schema ?? null).slice(0, 160),
)

// The user layer is what the switch writes. The watcher must push it into the
// live config object so the routes see it WITHOUT a restart.
await ctx.settings.update(GALAXY_SETTINGS_NS, { allowRestart: true })
check('user-layer update reaches the live config', config.allowRestart === true, String(config.allowRestart))

await ctx.settings.replace(GALAXY_SETTINGS_NS, {})
check('reset falls back to the composed base', config.allowRestart === false, String(config.allowRestart))

console.log(failures === 0 ? '\nHOST SETTINGS CHECK: PASS' : `\nHOST SETTINGS CHECK: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
