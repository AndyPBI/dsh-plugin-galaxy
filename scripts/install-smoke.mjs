#!/usr/bin/env node
/**
 * Real-composition install smoke test.
 *
 * Boots the REAL vendored cordis plus the REAL host webserver service from a
 * DeepSeek Harness checkout, provides a `loader` service, then loads this
 * plugin through its public `apply(ctx, config)` entry exactly as the DSH
 * loader would, and exercises the HTTP surface over a real socket.
 *
 * This is the closest simulation of `dsh plugin add` short of installing into a
 * live profile, and it is the check that catches install-time failures a
 * build + unit-test pass cannot see: wrong `apply` wiring, a service the host
 * does not provide, a route registration the webserver rejects, or a client
 * artifact the loader cannot resolve.
 *
 * Usage:
 *   node scripts/install-smoke.mjs [--checkout /path/to/deepseek-harness]
 *
 * Environment:
 *   DSH_CHECKOUT  path to the DeepSeek Harness checkout (default: the sibling
 *                 checkout used during development). The script SKIPS (exit 0)
 *                 when the checkout or its built webserver is unavailable, so
 *                 it never fails CI for an unrelated reason.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')

const checkoutFlag = process.argv.indexOf('--checkout')
const checkout = resolve(
  checkoutFlag === -1
    ? (process.env.DSH_CHECKOUT ?? join(homedir(), 'Documents', 'AI', 'deepseek-harness'))
    : (process.argv[checkoutFlag + 1] ?? ''),
)
const webserverLib = join(checkout, 'packages/host/webserver/lib/index.js')

if (!existsSync(webserverLib)) {
  console.log(`install smoke SKIPPED: no built host webserver at ${webserverLib}`)
  console.log('(pass --checkout <path> or set DSH_CHECKOUT to run it)')
  process.exit(0)
}

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const { Context, Service } = await import('@deepseek-ai/cordis')
const { default: WebServer } = await import(webserverLib)

/** Minimal `loader` service: the plugin only needs the key to exist. */
class FakeLoader extends Service {
  constructor(ctx) {
    super(ctx, 'loader')
    this.entries = () => []
  }
}

const home = mkdtempSync(join(tmpdir(), 'galaxy-install-'))
const profileDir = join(home, 'profiles', 'web')
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web',
  dependencies: { '@deepseek-ai/dsh-base': '1.0.0', 'community-demo-plugin': '^1.2.3' },
  dsh: { profile: { bundles: ['community-demo-plugin'] } },
}, null, 2))

process.env.DSH_HOME = home
// Point outbound calls at a closed port: the smoke test must not need a network.
process.env.DSHG_REGISTRY_URL = 'http://127.0.0.1:1/plugins.json'
process.env.DSHG_UPDATES_ORIGIN = 'http://127.0.0.1:1/updates.json'

const ctx = new Context()
try {
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' })
  await ctx.plugin(FakeLoader)
  check('real webServer service available', ctx.webServer !== undefined)
  check('real loader service available', ctx.get('loader') !== undefined)

  const plugin = await import(join(pluginRoot, 'lib/index.js'))
  check('plugin exports name', plugin.name === 'dsh-plugin-galaxy', `name=${String(plugin.name)}`)
  check('plugin exports apply', typeof plugin.apply === 'function')

  // Exactly what the DSH loader does with the patch-layer row.
  plugin.apply(ctx, { profile: 'web' })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 300))
  const port = ctx.webServer.port
  check('webserver is listening', typeof port === 'number' && port > 0, `port=${String(port)}`)
  const base = `http://127.0.0.1:${String(port)}`

  const status = await fetch(`${base}/dsh-galaxy/status`)
  check('GET /dsh-galaxy/status -> 200', status.status === 200, `status=${String(status.status)}`)
  if (status.status === 200) {
    const payload = await status.json()
    check('status reports profile=web', payload.profile === 'web')
    check('status carries a boot id', typeof payload.boot === 'string')
    check('pnpm probe degrades instead of failing the route', payload.pnpm !== undefined)
    check('restart capability is reported', payload.restart !== undefined)
  }

  const installed = await fetch(`${base}/dsh-galaxy/installed`)
  check('GET /dsh-galaxy/installed -> 200', installed.status === 200, `status=${String(installed.status)}`)
  if (installed.status === 200) {
    const payload = await installed.json()
    check('in-box bundle filtered from the installed view', !Object.keys(payload.installed ?? {}).includes('@deepseek-ai/dsh-base'))
  }

  const capabilities = await fetch(`${base}/dsh-galaxy/api/v1/capabilities`)
  check('GET /api/v1/capabilities -> 200', capabilities.status === 200, `status=${String(capabilities.status)}`)

  const foreign = await fetch(`${base}/dsh-galaxy/note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ name: 'x', text: 'y' }),
  })
  check('cross-origin POST /note -> 403', foreign.status === 403, `status=${String(foreign.status)}`)

  const note = await fetch(`${base}/dsh-galaxy/note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ name: 'demo', text: 'hello from the real host' }),
  })
  check('same-origin POST /note -> 200', note.status === 200, `status=${String(note.status)}`)

  // Exercises the TypeScript relative-import rewrite helper + dynamic imports.
  const updates = await fetch(`${base}/dsh-galaxy/updates`)
  check('GET /dsh-galaxy/updates -> 200', updates.status === 200, `status=${String(updates.status)}`)

  const checkRoute = await fetch(`${base}/dsh-galaxy/check`)
  check('GET /dsh-galaxy/check -> 200', checkRoute.status === 200, `status=${String(checkRoute.status)}`)

  const restart = await fetch(`${base}/dsh-galaxy/restart`, { method: 'POST', headers: { origin: base } })
  check('POST /restart answers a guarded status (not 500)', [403, 409].includes(restart.status), `status=${String(restart.status)}`)

  const logs = await fetch(`${base}/dsh-galaxy/logs`)
  check('GET /dsh-galaxy/logs -> 200 attachment', logs.status === 200, `status=${String(logs.status)}`)
} catch (error) {
  console.error('THREW:', error?.stack ?? String(error))
  failures.push(`threw: ${String(error?.message ?? error)}`)
} finally {
  try { await ctx.fiber.dispose() } catch { /* already down */ }
  rmSync(home, { recursive: true, force: true })
}

console.log(failures.length === 0
  ? '\nINSTALL SMOKE: PASS'
  : `\nINSTALL SMOKE: FAIL (${String(failures.length)}) ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
