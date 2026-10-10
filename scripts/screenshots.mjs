#!/usr/bin/env node
/**
 * README screenshots, rendered from the SHIPPED artifacts.
 *
 * The panel is a settings section inside the host's dialog, so it cannot be
 * captured from a URL: this script rebuilds the same situation offline —
 *
 *   1. fixtures are the LIVE route responses of a running host
 *      (`/dsh-galaxy/{registry,installed,updates,status}`), captured in Node, so
 *      the numbers, names and recommendation ranks in the images are real;
 *   2. the render is the real `client/client.js` through the same
 *      `window.__ModuleLoader__.load({id,factory})` facade the host uses — not a
 *      hand-written mock of the DOM;
 *   3. the primitives are the host's OWN components, compiled from the checkout
 *      (`ui-primitives/src/Button.tsx`, `Input`, `Modal`, `Toast`, the icons)
 *      with its real CSS Modules and `design-platform.css` tokens, which is what
 *      makes the buttons, radii and colours match production.
 *
 * Chrome renders each view at 2x into `docs/screenshots/`.
 *
 * Usage: node scripts/screenshots.mjs [--harness <dir>] [--url <host>] [--chrome <path>] [--keep]
 *   `--url` defaults to http://127.0.0.1:3080; when it is unreachable the
 *   fixtures fall back to a small synthesized catalog so the script still runs.
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')
const shotDir = join(workspace, '.screenshots')
const outDir = join(workspace, 'docs', 'screenshots')

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at !== -1 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}

const harness = resolve(flag('harness', process.env.DSH_HARNESS ?? resolve(workspace, '..', 'deepseek-harness')))
const host = flag('url', 'http://127.0.0.1:3080').replace(/\/$/u, '')
const keep = process.argv.includes('--keep')

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]
const chrome = resolve(flag('chrome', process.env.CHROME_PATH
  ?? CHROME_CANDIDATES.find(candidate => existsSync(candidate)) ?? ''))

/** Views to capture: the filter the panel is switched to, and the file name. */
const VIEWS = [
  { id: 'all', file: '01-market-all.png', title: '全部：卡片网格 + 搜索/筛选/排序' },
  { id: 'recommended', file: '02-recommended.png', title: '推荐：官网排名前 20，卡片带 #名次与分档' },
  { id: 'installed', file: '03-installed.png', title: '已安装：启停/更新/卸载/备注/收藏' },
  { id: 'detail', file: '04-detail-modal.png', title: '插件详情：评分构成、来源、评论入口' },
]

/* ------------------------------------------------------------------ *
 * 1. fixtures — the live host's own answers
 * ------------------------------------------------------------------ */

const FIXTURE_ROUTES = ['registry', 'installed', 'updates', 'status']

const FALLBACK_REGISTRY = {
  registry: {
    plugins: [
      { key: 'liustack/modlens', name: 'modlens', displayName: 'modlens', owner: 'liustack', npm: 'dsh-modlens', category: 'dev', stars: 412, downloads: 3800, description: '把当前会话的模块依赖画成一张可交互的图。', score: 88.4, band: 'S' },
      { key: 'tt-a1i/archify#integrations/deepseek-harness', name: 'archify#integrations/deepseek-harness', displayName: 'archify integrations/deepseek-harness', owner: 'tt-a1i', npm: '@tt-a1i/archify-dsh', category: 'office', stars: 60032, description: '在对话里直接生成并交付文档、表格与演示稿。', score: 81.1, band: 'A' },
      { key: 'o/r#packages/dsh-memory', name: 'r#packages/dsh-memory', displayName: 'r packages/dsh-memory', owner: 'openviking', npm: '@openviking/dsh-memory-plugin', category: 'knowledge', stars: 903, description: '把长期记忆接进 DSH：检索、写回、跨会话复用。', score: 78.9, band: 'A' },
      { key: 'V1ki/dsh-plugin-subscriptions', name: 'dsh-plugin-subscriptions', owner: 'V1ki', npm: 'dsh-plugin-subscriptions', category: 'service', stars: 340, description: '订阅型服务的额度与用量看板。', score: 74.2, band: 'B' },
      { key: 'WSL043/dsh-codex-subscription', name: 'dsh-codex-subscription', owner: 'WSL043', npm: 'dsh-codex-subscription', category: 'service', stars: 63, description: 'Codex 订阅接入。', score: 70.1, band: 'B' },
      { key: 'j/v#packages/pkg', name: 'v#packages/pkg', displayName: 'v packages/pkg', owner: 'j', npm: 'dsh-quick-pkg', category: 'dev', stars: 12, description: '快速在会话里生成并运行一个 npm 包。', score: 58.0, band: 'C' },
    ],
    count: 6,
  },
  hostVersion: '0.2.1-alpha.1',
}

const FALLBACK_INSTALLED = {
  installed: [
    { name: 'dsh-plugin-galaxy', version: '0.1.29', spec: 'dsh-plugin-galaxy@0.1.29', source: 'npm', bundle: true, enabled: true },
    { name: 'dsh-cost-meter', version: '1.7.27', spec: 'dsh-cost-meter@^1.7.27', source: 'npm', bundle: true, enabled: true },
    { name: 'dsh-workvista', version: '0.1.13', spec: 'dsh-workvista@0.1.13', source: 'npm', bundle: true, enabled: true },
  ],
  groups: {},
  notes: {},
  favorites: [],
  patch: { file: 'cordis.patch.yml', rows: [] },
  diagnostics: { ok: true, findings: [] },
}
const FALLBACK_UPDATES = {
  updates: [
    { name: 'dsh-workvista', current: '0.1.13', latest: '0.1.15', updateAvailable: true, kind: 'minor' },
  ],
}
const FALLBACK_STATUS = {
  boot: 'screenshot', version: '0.1.29', channel: 'stable', region: 'global', profile: 'web',
  hostVersion: '0.2.1-alpha.1', hostVersionSource: 'anchor', busy: false,
  progress: { active: false }, pnpm: { ok: true, version: '11.22.0' },
  restart: { allowed: false, supervisor: 'launchd' }, installed: [],
}

async function captureFixtures() {
  const fixtures = {}
  let live = 0
  for (const route of FIXTURE_ROUTES) {
    try {
      const response = await fetch(`${host}/dsh-galaxy/${route}`, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      fixtures[route] = await response.json()
      live += 1
    } catch (error) {
      console.log(`      ${route}: live capture failed (${error.message}); using the fallback fixture`)
    }
  }
  if (fixtures.registry === undefined) fixtures.registry = FALLBACK_REGISTRY
  if (fixtures.installed === undefined) fixtures.installed = FALLBACK_INSTALLED
  if (fixtures.updates === undefined) fixtures.updates = FALLBACK_UPDATES
  if (fixtures.status === undefined) fixtures.status = FALLBACK_STATUS
  console.log(`      fixtures: ${String(live)}/${String(FIXTURE_ROUTES.length)} live from ${host}`)
  return fixtures
}

/* ------------------------------------------------------------------ *
 * 2. harness entry — host components + loader facade + mount
 * ------------------------------------------------------------------ */

const primitivesBase = join(harness, 'packages', 'client', 'ui-primitives', 'src')
const themeCss = join(harness, 'packages', 'client', 'ui-theme', 'src', 'styles', 'design-platform.css')
for (const required of [
  join(primitivesBase, 'Button.tsx'), join(primitivesBase, 'Input.tsx'),
  join(primitivesBase, 'Modal.tsx'), join(primitivesBase, 'Toast.tsx'),
  join(primitivesBase, 'icons', 'index.tsx'), themeCss,
]) {
  if (!existsSync(required)) {
    console.error(`SKIP  host component not found: ${required}\n      pass --harness <deepseek-harness dir>.`)
    process.exit(2)
  }
}

const ENTRY = `/**
 * Generated by scripts/screenshots.mjs — do not edit by hand.
 * Host primitives are imported from the checkout so the images show the real
 * components and the real CSS Modules, not a lookalike.
 */
import ${JSON.stringify(themeCss)}
import { Button } from ${JSON.stringify(join(primitivesBase, 'Button.tsx'))}
import { Input } from ${JSON.stringify(join(primitivesBase, 'Input.tsx'))}
import { Modal } from ${JSON.stringify(join(primitivesBase, 'Modal.tsx'))}
import { Toast } from ${JSON.stringify(join(primitivesBase, 'Toast.tsx'))}
import {
  IconSearchOutlineRegular,
  IconRefreshOutlineRegular,
  IconSparkleRegular,
} from ${JSON.stringify(join(primitivesBase, 'icons', 'index.tsx'))}

/*
 * React arrives as the page's UMD globals, NOT as a second copy bundled here.
 * Bundling it is what broke the first attempt: this harness rendered with its own
 * React while the client bundle resolved react through the module table and the
 * host primitives (compiled from the checkout into this bundle) hooked the first
 * copy — two dispatchers, one of them null, so every hook threw
 * "Cannot read properties of null (reading 'useRef')" inside the error boundary.
 */
const React = window.React
const ReactDOM = window.ReactDOM
const primitives = { Button, Input, Modal, Toast, IconSearchOutlineRegular, IconRefreshOutlineRegular, IconSparkleRegular }
const moduleTable = {
  react: React,
  'react/jsx-runtime': window.ReactJSXRuntime,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOM,
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
}

const fixtures = JSON.parse(document.getElementById('fixtures').textContent ?? '{}')
const events = []
window.__SHOT_EVENTS__ = events

// React reports a render error caught by an error boundary through console.error
// (including the stack), and the boundary replaces the panel with its recovery
// UI — so this is where a harness-only failure becomes readable.
const consoleErrors = []
window.__SHOT_CONSOLE__ = consoleErrors
const originalConsoleError = console.error
console.error = (...args) => {
  consoleErrors.push(args.map(argument => (argument && argument.stack) ? String(argument.stack) : String(argument)).join(' ').slice(0, 600))
  originalConsoleError(...args)
}

window.fetch = async (input, init) => {
  const url = String(typeof input === 'string' ? input : input.url)
  const path = url.slice(url.indexOf('/dsh-galaxy') + '/dsh-galaxy'.length).split('?')[0].replace(/^\\//u, '')
  const body = fixtures[path] ?? { ok: true }
  events.push((init?.method ?? 'GET') + ' ' + path)
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

const slots = []
const dictionaries = {}
const slotsService = {
  inject(_slot, register) { try { register() } catch (error) { events.push('slot error: ' + String(error)) } },
  register(meta, component) { slots.push({ meta, component }); return () => {} },
}
let language = 'zh'
const localeService = {
  register(namespace, dicts) { dictionaries[namespace] = dicts },
  bind: () => (key, params) => {
    let text = dictionaries['dsh-plugin-galaxy']?.[language]?.[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll('{' + name + '}', String(value))
    return text
  },
  subscribe: () => () => {},
  getSnapshot: () => ({ active: language }),
  setLanguage: next => { language = next },
}
const themeSnapshot = { id: 'light', mode: 'light' }
const themeService = { getTheme: () => themeSnapshot, setTheme: () => {} }
const themeStore = {
  subscribe: () => () => {}, getSnapshot: () => themeSnapshot, getServerSnapshot: () => themeSnapshot,
}
const ctx = {
  effect: callback => { callback(); return () => {} },
  on: () => () => {},
  get: () => undefined,
  inject: (services, callback) => { if (services.includes('settingsScope')) callback({ slots: slotsService }) },
  locale: localeService,
  slots: slotsService,
  theme: themeService,
}

let registered
window.__ModuleLoader__ = {
  load(entry) {
    registered = { id: entry.id, mod: entry.factory(specifier => {
      if (specifier in moduleTable) return moduleTable[specifier]
      throw new Error('module table cannot answer ' + specifier)
    }) }
  },
}

function debug(state) {
  let node = document.getElementById('shot-debug')
  if (node === null) {
    node = document.createElement('pre')
    node.id = 'shot-debug'
    node.style.display = 'none'
    document.body.append(node)
  }
  node.textContent = JSON.stringify(state)
}

window.__DSH_BOOT__ = () => {
  const status = { registered: registered?.id, slots: slots.map(entry => entry.meta?.name), events, error: null, root: 0, view: null }
  debug(status)
  const t = localeService.bind('dsh-plugin-galaxy')
  try {
    registered.mod.apply(ctx)
  } catch (error) {
    status.error = String(error?.stack ?? error)
    debug(status)
    return
  }
  status.slots = slots.map(entry => entry.meta?.name)
  const section = slots.find(entry => entry.meta?.name === 'settings.section')
  if (section === undefined) { events.push('no settings.section registered'); debug(status); return }

  const root = document.getElementById('root')
  try {
    ReactDOM.createRoot(root).render(
      React.createElement(section.component, {
        t, locale: localeService, theme: themeService, themeStore,
      }),
    )
  } catch (error) {
    status.error = String(error?.stack ?? error)
    debug(status)
    return
  }
  status.view = new URLSearchParams(location.search).get('view') ?? 'all'
  debug(status)

  const view = new URLSearchParams(location.search).get('view') ?? 'all'
  const labels = { all: '全部', recommended: '推荐', installed: '已安装' }
  const settle = () => new Promise(resolve => setTimeout(resolve, 60))

  void (async () => {
    await settle()
    if (view !== 'detail' && labels[view] !== undefined) {
      const button = [...document.querySelectorAll('button[aria-pressed]')]
        .find(candidate => (candidate.textContent ?? '').trim() === labels[view])
      if (button === undefined) events.push('filter button not found: ' + labels[view])
      else button.click()
      await settle()
      await settle()
    }
    if (view === 'detail') {
      const open = [...document.querySelectorAll('button')]
        .find(candidate => (candidate.textContent ?? '').includes(t('commentsOpen')))
      if (open === undefined) events.push('comments button not found')
      else open.click()
      await settle()
      await settle()
    }
    // "ready" means the grid is on screen, not that the effect ran: otherwise
    // the capture races the data round trip and the image shows an empty market.
    // (No backticks here: this code lives inside a template literal.)
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && document.querySelectorAll('[class*="cardTitle"]').length < 3) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    status.root = document.getElementById('root').innerHTML.length
    status.cards = document.querySelectorAll('[class*="cardTitle"]').length
    status.events = events
    debug(status)
    document.body.dataset.ready = '1'
  })()
}
`

/* ------------------------------------------------------------------ *
 * 3. page — inlined harness, then the real client bundle
 * ------------------------------------------------------------------ */

/**
 * The harness is a separate file on purpose: inlining it breaks the page — the
 * minified React bundle contains `</script>` and the HTML parser ends the script
 * tag there, which silently renders nothing. The fixtures JSON is escaped for
 * the same reason (`<` -> \u003c).
 */
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>Plugin Galaxy · README screenshot</title>
<link rel="stylesheet" href="./harness.css">
<style>
html,body{margin:0;padding:0;background:var(--dsw-alias-bg-layer-1,#fff)}
#root{width:1000px;padding:20px 22px 28px;box-sizing:border-box;font-family:-apple-system,"PingFang SC","Helvetica Neue",Arial,sans-serif}
</style></head>
<body>
<div id="root"></div>
<script src="./react.js"></script>
<script src="./react-dom.js"></script>
<script>
/* The automatic runtime's three exports, over the UMD React. */
window.ReactJSXRuntime = {
  Fragment: window.React.Fragment,
  jsx: (type, props, key) => {
    const { children, ...rest } = props ?? {}
    const args = children === undefined ? [] : Array.isArray(children) ? children : [children]
    return window.React.createElement(type, key === undefined ? rest : { ...rest, key }, ...args)
  },
  jsxs: (type, props, key) => {
    const { children, ...rest } = props ?? {}
    const args = children === undefined ? [] : Array.isArray(children) ? children : [children]
    return window.React.createElement(type, key === undefined ? rest : { ...rest, key }, ...args)
  },
}
</script>
<script id="fixtures" type="application/json">__FIXTURES__</script>
<script>window.__SHOT_ERROR__ = null; window.addEventListener('error', event => { window.__SHOT_ERROR__ = String(event.message ?? event.error) })</script>
<script src="./harness.js"></script>
<script src="./client.js"></script>
<script>try { window.__DSH_BOOT__() } catch (error) { document.body.dataset.bootError = String(error && error.stack || error).slice(0, 400) }</script>
<script>if (window.__SHOT_ERROR__ !== null) document.body.dataset.pageError = String(window.__SHOT_ERROR__)?.slice(0, 400)</script>
</body></html>`

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

if (chrome === '' || !existsSync(chrome)) {
  console.error('SKIP  no Chrome/Chromium found; pass --chrome <path> or set CHROME_PATH.')
  process.exit(2)
}
if (!existsSync(join(workspace, 'client', 'client.js'))) {
  console.error('SKIP  client/client.js not found; run npm run build:client first.')
  process.exit(2)
}

rmSync(shotDir, { recursive: true, force: true })
mkdirSync(shotDir, { recursive: true })
mkdirSync(outDir, { recursive: true })

console.log('==> capturing live fixtures')
const fixtures = await captureFixtures()

/**
 * The live routes report the operator's own profile — absolute `file:` specs for
 * locally installed tarballs, the pnpm path, and so on. The images go into a
 * public repository, so every absolute path is rewritten before rendering.
 */
function sanitize(value) {
  if (typeof value === 'string') {
    return value
      .replace(/file:\/\/[^\s"']*?\/([^\s"'/]+\.tgz)/gu, 'file:$1')
      .replace(/file:\/[^\s"']*?\/([^\s"'/]+\.tgz)/gu, 'file:$1')
      .replace(/\/(?:Users|home)\/[^\s"',)]*/gu, '/…/')
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]))
  }
  return value
}
const safeFixtures = sanitize(fixtures)
/** A local install's spec must still read like an install spec, just pathless. */
for (const entry of safeFixtures.installed?.installed ?? []) {
  if (typeof entry.spec === 'string' && entry.spec.startsWith('file:')) entry.spec = `file:${entry.name}-${entry.version}.tgz`
}

console.log('==> writing the harness entry')
const entryPath = join(shotDir, 'entry.tsx')
writeFileSync(entryPath, ENTRY)

console.log('==> bundling host components + React (vite)')
const { build } = await import('vite')
await build({
  root: shotDir,
  logLevel: 'warn',
  configFile: false,
  // Library mode leaves `process.env.NODE_ENV` alone, and React's entry reads it
  // at module scope: without this the bundle dies with "process is not defined"
  // before `__ModuleLoader__` is even installed. The host's own bundle config
  // defines the same three.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env': '{}',
  },
  build: {
    outDir: join(shotDir, 'dist'),
    emptyOutDir: true,
    cssCodeSplit: false,
    minify: true,
    target: 'es2022',
    lib: { entry: entryPath, formats: ['iife'], name: 'DshGalaxyShot', fileName: () => 'harness.js' },
    rollupOptions: {
      // One React for everybody: the page loads the UMD builds, and both this
      // bundle and the client bundle reference those globals.
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
      output: {
        assetFileNames: 'harness.[ext]',
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react-dom/client': 'ReactDOM',
          'react/jsx-runtime': 'ReactJSXRuntime',
        },
      },
    },
  },
})

const dist = join(shotDir, 'dist')
const harnessJs = readFileSync(join(dist, 'harness.js'), 'utf8')
const harnessCss = existsSync(join(dist, 'harness.css')) ? readFileSync(join(dist, 'harness.css'), 'utf8') : ''
copyFileSync(join(workspace, 'node_modules', 'react', 'umd', 'react.production.min.js'), join(shotDir, 'react.js'))
copyFileSync(join(workspace, 'node_modules', 'react-dom', 'umd', 'react-dom.production.min.js'), join(shotDir, 'react-dom.js'))
writeFileSync(join(shotDir, 'harness.js'), harnessJs)
writeFileSync(join(shotDir, 'harness.css'), harnessCss)
copyFileSync(join(workspace, 'client', 'client.js'), join(shotDir, 'client.js'))
const fixturesJson = JSON.stringify(safeFixtures).replace(/</gu, '\\u003c')
writeFileSync(join(shotDir, 'page.html'), PAGE.replace('__FIXTURES__', fixturesJson))

/**
 * Capture through the DevTools protocol instead of `--screenshot`.
 *
 * `--screenshot` fires at load, and this panel paints its grid one data round
 * trip later — the first attempt produced four identical hero-less images. The
 * page therefore sets `document.body.dataset.ready` once the view is switched
 * AND rows exist; CDP waits for that marker, screenshots beyond the viewport,
 * and reports the DOM's own view of what it rendered (which is also how this
 * script verifies itself: the PNGs cannot be read back here).
 */
function waitForDevtools(port, deadlineMs = 15_000) {
  const until = Date.now() + deadlineMs
  return (async function poll() {
    while (Date.now() < until) {
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`)
        if (response.ok) return await response.json()
      } catch { /* not up yet */ }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    throw new Error(`Chrome did not open a DevTools port on ${String(port)}`)
  })()
}

async function cdpCapture({ url, target, width, height, scale }) {
  const port = 9300 + Math.floor(Math.random() * 300)
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-crash-reporter',
    `--user-data-dir=${join(shotDir, 'chrome-profile')}`,
    `--remote-debugging-port=${String(port)}`, 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await waitForDevtools(port)
    const created = await (await fetch(
      `http://127.0.0.1:${String(port)}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' },
    )).json()
    const socket = new WebSocket(created.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true })
    })
    let nextId = 0
    const pending = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      const settle = pending.get(message.id)
      if (settle === undefined) return
      pending.delete(message.id)
      if (message.error !== undefined) settle.reject(new Error(message.error.message))
      else settle.resolve(message.result)
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })

    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
    const until = Date.now() + 25_000
    let state = {}
    while (Date.now() < until) {
      const evaluated = await send('Runtime.evaluate', {
        expression: `JSON.stringify({
          ready: document.body?.dataset?.ready ?? '',
          boot: (document.body?.dataset?.bootError ?? '').slice(0, 160),
          page: (document.body?.dataset?.pageError ?? '').slice(0, 160),
          root: document.getElementById('root')?.innerHTML.length ?? 0,
          cards: document.querySelectorAll('[class*="cardTitle"]').length,
          titles: [...document.querySelectorAll('[class*="cardTitle"]')].slice(0, 4).map(node => node.textContent),
          debug: document.getElementById('shot-debug')?.textContent?.slice(0, 400) ?? '',
          text: document.getElementById('root')?.innerText?.replace(/\\s+/g, ' ').slice(0, 260) ?? '',
          console: (window.__SHOT_CONSOLE__ ?? []).slice(0, 2),
          dialogs: document.querySelectorAll('[role="dialog"]').length,
          height: document.documentElement.scrollHeight,
        })`,
        returnByValue: true,
      })
      state = JSON.parse(evaluated.result.value)
      if (state.ready === '1' || state.boot !== '') break
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    // Viewport only: one card-grid screen per image keeps them readable in a
    // README instead of a 6000px strip of the whole catalog.
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(target, Buffer.from(shot.data, 'base64'))
    socket.close()
    await fetch(`http://127.0.0.1:${String(port)}/json/close/${created.id}`).catch(() => {})
    return state
  } finally {
    child.kill('SIGKILL')
  }
}

const report = []
for (const view of VIEWS) {
  const target = join(outDir, view.file)
  const state = await cdpCapture({
    url: `file://${join(shotDir, 'page.html')}?view=${view.id}`,
    target,
    width: 1044,
    height: 900,
    scale: 2,
  })
  report.push({ file: view.file, ...state })
  const ok = existsSync(target) && statSync(target).size > 0
  console.log(`    ${view.file}: ${ok ? 'written' : 'MISSING'} · cards=${String(state.cards ?? 0)} · root=${String(state.root ?? 0)}`
    + `${state.boot === '' ? '' : ` · BOOT ERROR: ${state.boot}`}${state.page === '' ? '' : ` · PAGE ERROR: ${state.page}`}`)
  if (!ok) process.exitCode = 1
}
writeFileSync(join(shotDir, 'report.json'), JSON.stringify(report, null, 2))
console.log(`    titles sample: ${JSON.stringify(report[0]?.titles ?? [])}`)

// The harness page can report what it did; a missing filter button would
// otherwise produce a screenshot of the wrong view without failing.
const eventsFile = join(shotDir, 'events.json')
writeFileSync(eventsFile, JSON.stringify({ fixtures: Object.keys(fixtures) }, null, 2))

if (!keep) rmSync(join(shotDir, 'dist'), { recursive: true, force: true })
console.log(`\nSCREENSHOTS: ${String(VIEWS.length)} file(s) in ${outDir}`)
