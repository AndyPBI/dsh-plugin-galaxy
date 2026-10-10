#!/usr/bin/env node
/**
 * Client bundle smoke test.
 *
 * Evaluates the built `client/client.js` exactly as the host module loader
 * does — `window.__ModuleLoader__.load({ id, factory })` with the factory
 * resolving externals through the injected `require` table — then calls the
 * registered `apply(ctx)` with a host-shaped client context and renders the
 * section and every panel through `react-dom/server`.
 *
 * This catches the failures a node-side build cannot see: a member the bundle
 * dereferences from the injected primitives that the host does not provide, a
 * crash while `apply()` registers slots, or a component that throws on first
 * render (which would blank the host settings dialog).
 *
 * Usage: node scripts/client-smoke.mjs
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const bundle = resolve(root, 'client/client.js')

if (!existsSync(bundle)) {
  console.error(`client smoke FAILED: ${bundle} does not exist (run npm run build:client)`)
  process.exit(1)
}

const require = createRequire(import.meta.url)
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

/* ---- the loader module table (baseline rows this bundle may request) ---- */

const primitivesStub = {
  Button: props => props.children ?? null,
  Input: () => null,
  Modal: props => props.children ?? null,
  Toast: () => null,
  IconRefreshOutlineRegular: () => null,
  IconSearchOutlineRegular: () => null,
  IconSparkleRegular: () => null,
}

const moduleTable = {
  react: require('react'),
  'react/jsx-runtime': require('react/jsx-runtime'),
  'react-dom': require('react-dom'),
  'react-dom/client': require('react-dom/client'),
  '@deepseek-ai/dsh-client-ui-primitives': primitivesStub,
}

const requested = new Set()
const loaderRequire = (specifier) => {
  requested.add(specifier)
  if (specifier in moduleTable) return moduleTable[specifier]
  throw new Error(`module table cannot answer require("${specifier}")`)
}

/* ---- evaluate the bundle the way the host does ---- */

let registered
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registered = { id: entry.id, mod: entry.factory(loaderRequire) }
    },
  },
}

try {
  require(bundle)
} catch (error) {
  check('bundle evaluates under the loader facade', false, String(error?.message ?? error))
}
check('bundle evaluates under the loader facade', registered !== undefined)
check('bundle registers under its package id', registered?.id === 'dsh-plugin-galaxy', `id=${String(registered?.id)}`)
check('module table answered every external', true, [...requested].join(', '))
check('bundle exports apply()', typeof registered?.mod?.apply === 'function')
check('bundle exports the plugin name', registered?.mod?.name === 'dsh-plugin-galaxy')

/* ---- host-shaped client context ---- */

const slots = []
const localeRegistrations = []
const applied = []

const slotsService = {
  inject(slot, register) {
    const result = typeof register === 'function' ? register() : undefined
    applied.push({ slot, result })
  },
  register(meta, component) {
    slots.push({ meta, component })
    return () => {}
  },
}

const dictionaries = {}
const localeService = {
  register(namespace, dicts) {
    dictionaries[namespace] = dicts
    localeRegistrations.push(namespace)
  },
  bind: () => (key, params) => {
    let text = dictionaries['dsh-plugin-galaxy']?.en?.[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  },
  subscribe: () => () => {},
  getSnapshot: () => ({ active: 'en' }),
}

const themeSnapshot = { id: 'dark', mode: 'dark' }
const ctx = {
  effect: callback => { callback(); return () => {} },
  on: () => () => {},
  inject: (services, callback) => {
    // `settings.plugin.item` is registered behind a nested settingsScope inject.
    if (services.includes('settingsScope')) callback({ slots: slotsService })
  },
  locale: localeService,
  slots: slotsService,
  theme: { getTheme: () => themeSnapshot, setTheme: () => {} },
}

try {
  registered?.mod?.apply(ctx)
  check('apply(ctx) does not throw', true)
} catch (error) {
  check('apply(ctx) does not throw', false, String(error?.stack ?? error))
}

check('locale dictionary registered for the plugin namespace', localeRegistrations.includes('dsh-plugin-galaxy'))
check('zh and en dictionaries both present',
  dictionaries['dsh-plugin-galaxy']?.zh !== undefined && dictionaries['dsh-plugin-galaxy']?.en !== undefined)
check('settings.section slot registered', slots.some(entry => entry.meta?.name === 'settings.section'))
check('settings.plugin.item slot registered', slots.some(entry => entry.meta?.name === 'settings.plugin.item'))
check('shell.overlay slot registered', slots.some(entry => entry.meta?.name === 'shell.overlay'))
// The sidebar seat was evaluated and deliberately removed: this plugin's only
// surface is the settings dialog, so it must NOT claim a sidebar cell.
check('no sidebar seat is claimed', !slots.some(entry => entry.meta?.name === 'sidebar.footer.action'))

/* ---- render every registered surface through react-dom/server ---- */

const { createElement } = require('react')
const { renderToString } = require('react-dom/server')

const t = localeService.bind('dsh-plugin-galaxy')
const themeStore = { subscribe: () => () => {}, getSnapshot: () => themeSnapshot, getServerSnapshot: () => themeSnapshot }

const renderProps = {
  'settings.section': {
    t, locale: localeService, theme: ctx.theme, themeStore,
  },
  'settings.plugin.item': { t },
  'shell.overlay': { t },
}

for (const entry of slots) {
  const name = entry.meta?.name
  const props = renderProps[name]
  if (props === undefined) continue
  try {
    const html = renderToString(createElement(entry.component, props))
    // An empty string is legitimate for the install toast (nothing to say
    // while idle); the assertion is that the render did not throw.
    check(`render ${name} without throwing`, typeof html === 'string', `${String(html.length)} chars`)
  } catch (error) {
    check(`render ${name} without throwing`, false, String(error?.message ?? error))
  }
}

/* ---- the guard must match what the bundle really needs ---- */

const required = registered?.mod?.REQUIRED_PRIMITIVES
if (Array.isArray(required)) {
  const missingInStub = required.filter(name => primitivesStub[name] === undefined)
  check('REQUIRED_PRIMITIVES contains only members the host provides', missingInStub.length === 0, missingInStub.join(', '))
}
// Icons are resolved per host (0.2.x renamed every glyph), so the guard asks for
// ONE name per group instead of one fixed spelling. The stub carries the 0.2.x
// names, which is exactly the case that used to skip registration entirely.
if (typeof registered?.mod?.missingPrimitives === 'function' && Array.isArray(required)) {
  const gaps = registered.mod.missingPrimitives(primitivesStub)
  check('the primitives guard is satisfied by the stub (stable members + one icon spelling each)',
    gaps.length === 0, gaps.join(', '))
}

console.log(failures.length === 0
  ? '\nCLIENT SMOKE: PASS'
  : `\nCLIENT SMOKE: FAIL (${String(failures.length)}) ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
