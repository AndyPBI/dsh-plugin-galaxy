/**
 * API integration tests: mount the whole route surface on a fake host and
 * drive it with synthetic requests.
 *
 * These assert the behaviours that a per-module unit test cannot see — that
 * every documented path is actually registered, that method and origin guards
 * hold across the surface, and that a mutation really lands in the profile's
 * galaxy state file.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { mountGalaxyRoutes } from '../src/api/index.ts'
import type { HostRoute } from '../src/api/host.ts'
import type { InstallResult } from '../src/core/types.ts'

/** Every route the plugin registered with the fake host. */
const routes: HostRoute[] = []
const host = {
  webServer: {
    register(route: HostRoute): () => void {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  },
  logger: { warn: (): void => {} },
}

/** Child-process runner stub: never spawns anything. */
const runner = async (): Promise<InstallResult> => ({
  exitCode: 1,
  stdout: '',
  stderr: 'runner disabled in tests',
  timedOut: false,
  cancelled: false,
})

let home: string
let dispose: () => void

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'galaxy-api-'))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  // A realistic profile manifest: the in-box bundle must be filtered out of
  // the installed view while a community dependency stays visible, and the
  // snapshot routes require a readable manifest.
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {
      '@deepseek-ai/dsh-base': '1.0.0',
      'community-demo-plugin': '^1.2.3',
    },
    dsh: { profile: { bundles: ['community-demo-plugin'] } },
  }, null, 2))
  process.env.DSH_HOME = home
  // Point every outbound fetch at a closed port so the region probe and the
  // catalog loader fail fast instead of reaching the network.
  process.env.DSHG_REGISTRY_URL = 'http://127.0.0.1:1/plugins.json'
  process.env.DSHG_UPDATES_ORIGIN = 'http://127.0.0.1:1/updates.json'
  dispose = mountGalaxyRoutes(host, { profile: 'web' }, runner)
})

afterAll(() => {
  dispose()
  rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
  delete process.env.DSHG_REGISTRY_URL
  delete process.env.DSHG_UPDATES_ORIGIN
})

interface RequestOptions {
  method?: string
  url?: string
  body?: unknown
  origin?: string | null
  remoteAddress?: string
}

/** Minimal ServerResponse stand-in capturing status, headers and body. */
class FakeResponse {
  status = 0
  headers: Record<string, string> = {}
  body = ''
  headersSent = false
  ended = false
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status
    this.headers = { ...headers }
    this.headersSent = true
    return this
  }
  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    this.ended = true
    return this
  }
  json<T = unknown>(): T {
    return JSON.parse(this.body) as T
  }
}

/** Minimal IncomingMessage stand-in, including an async body iterator. */
function fakeRequest(options: RequestOptions): import('node:http').IncomingMessage {
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))]
  const headers: Record<string, string> = { host: '127.0.0.1:3080' }
  const origin = options.origin === undefined ? 'http://127.0.0.1:3080' : options.origin
  if (origin !== null) headers.origin = origin
  const request = {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  return request as unknown as import('node:http').IncomingMessage
}

/** Find and invoke the handler registered for an exact path. */
async function call(path: string, options: RequestOptions = {}): Promise<FakeResponse> {
  const route = routes.find(candidate => candidate.path === path && candidate.kind === 'exact')
  if (route === undefined) throw new Error(`no route registered for ${path}`)
  const response = new FakeResponse()
  await route.handler(fakeRequest({ url: path, ...options }), response as unknown as import('node:http').ServerResponse)
  return response
}

describe('registered surface', () => {
  it('registers every documented endpoint exactly once', () => {
    const expected = [
      '/dsh-galaxy/api/v1/capabilities',
      '/dsh-galaxy/api/v1/updates',
      '/dsh-galaxy/api/v1/operations',
      '/dsh-galaxy/api/v1/rollback',
      '/dsh-galaxy/api/v1/restart',
      '/dsh-galaxy/api/v1/cancelling',
      '/dsh-galaxy/backup',
      '/dsh-galaxy/restore',
      '/dsh-galaxy/webdav',
      '/dsh-galaxy/gist',
      '/dsh-galaxy/registry',
      '/dsh-galaxy/discovery-compatibility',
      '/dsh-galaxy/installed',
      '/dsh-galaxy/check',
      '/dsh-galaxy/bundle-order',
      '/dsh-galaxy/presets',
      '/dsh-galaxy/snapshots',
      '/dsh-galaxy/restore-snapshot',
      '/dsh-galaxy/delete-snapshot',
      '/dsh-galaxy/use-skin',
      '/dsh-galaxy/toggle',
      '/dsh-galaxy/note',
      '/dsh-galaxy/favorite',
      '/dsh-galaxy/groups',
      '/dsh-galaxy/status',
      '/dsh-galaxy/logs',
      '/dsh-galaxy/updates',
      '/dsh-galaxy/changelog',
      '/dsh-galaxy/migrate-source',
      '/dsh-galaxy/update',
      '/dsh-galaxy/setup-pnpm',
      '/dsh-galaxy/channel',
      '/dsh-galaxy/region',
      '/dsh-galaxy/github-proxy',
      '/dsh-galaxy/catalog-source',
      '/dsh-galaxy/self-uninstall',
      '/dsh-galaxy/restart',
      '/dsh-galaxy/approve-builds',
      '/dsh-galaxy/cancel',
      '/dsh-galaxy/uninstall',
      '/dsh-galaxy/rollback',
      '/dsh-galaxy/install',
    ]
    const registered = new Set(routes.map(route => route.path))
    const missing = expected.filter(path => !registered.has(path))
    expect(missing).toEqual([])
    for (const path of expected) {
      const count = routes.filter(route => route.path === path).length
      expect(count, `${path} registered ${count} times`).toBe(1)
    }
  })

  it('disposes every route on unmount', () => {
    const before = routes.length
    const scratch = mountGalaxyRoutes(host, { profile: 'web' }, runner)
    expect(routes.length).toBeGreaterThan(before)
    scratch()
    expect(routes.length).toBe(before)
  })
})

describe('guards', () => {
  it('rejects a mutating request from a foreign origin', async () => {
    const response = await call('/dsh-galaxy/note', {
      method: 'POST',
      body: { name: 'x', text: 'y' },
      origin: 'http://evil.example',
    })
    expect(response.status).toBe(403)
  })

  it('rejects destructive routes from a non-loopback peer', async () => {
    const response = await call('/dsh-galaxy/restart', {
      method: 'POST',
      remoteAddress: '10.0.0.9',
    })
    expect(response.status).toBe(403)
  })

  it('answers 405 for an unsupported method', async () => {
    const response = await call('/dsh-galaxy/status', { method: 'POST' })
    expect(response.status).toBe(405)
    expect(response.headers.allow).toContain('GET')
  })
})

describe('read endpoints', () => {
  it('reports host status', async () => {
    const response = await call('/dsh-galaxy/status')
    expect(response.status).toBe(200)
    const payload = response.json<{ boot: string; profile: string; channel: string; region: string }>()
    expect(payload.profile).toBe('web')
    expect(typeof payload.boot).toBe('string')
    expect(['stable', 'beta', 'dev']).toContain(payload.channel)
    expect(['global', 'china']).toContain(payload.region)
  })

  it('lists the installed inventory', async () => {
    const response = await call('/dsh-galaxy/installed')
    expect(response.status).toBe(200)
    const payload = response.json<{ profile: string; installed: unknown[]; bundles: unknown[] }>()
    expect(payload.profile).toBe('web')
    expect(Array.isArray(payload.installed)).toBe(true)
    expect(Array.isArray(payload.bundles)).toBe(true)
  })

  it('describes the public v1 contract', async () => {
    const response = await call('/dsh-galaxy/api/v1/capabilities')
    expect(response.status).toBe(200)
    const payload = response.json<{ apiVersion: number; schema: string; endpoints: string[] }>()
    expect(payload.apiVersion).toBe(1)
    expect(payload.endpoints.length).toBeGreaterThan(0)
  })

  it('answers 400 when the changelog request has no name', async () => {
    const response = await call('/dsh-galaxy/changelog')
    expect(response.status).toBe(400)
  })
})

describe('mutations', () => {
  it('persists a note into the galaxy state file', async () => {
    const response = await call('/dsh-galaxy/note', {
      method: 'POST',
      body: { name: 'some-plugin', text: 'my note' },
    })
    expect(response.status).toBe(200)
    const state = JSON.parse(readFileSync(join(home, 'profiles', 'web', '.dsh-galaxy', 'state.json'), 'utf8')) as {
      notes?: Record<string, string>
    }
    expect(state.notes?.['some-plugin']).toBe('my note')
  })

  it('creates and lists a snapshot', async () => {
    const created = await call('/dsh-galaxy/snapshots', { method: 'POST', body: {} })
    expect([200, 201]).toContain(created.status)
    const listed = await call('/dsh-galaxy/snapshots')
    expect(listed.status).toBe(200)
  })

  it('rejects an unknown plugin group action', async () => {
    const response = await call('/dsh-galaxy/groups', {
      method: 'POST',
      body: { action: 'nonsense', name: 'g' },
    })
    expect(response.status).toBe(400)
  })

  it('restore writes the merged manifest and galaxy documents back to disk', async () => {
    const backup = {
      format: 'dsh-galaxy-backup',
      version: '0.2',
      createdAt: new Date().toISOString(),
      profile: 'web',
      secretFileCount: 0,
      packages: {},
      files: [
        {
          path: 'package.json',
          type: 'json',
          json: {
            dependencies: {
              '@deepseek-ai/dsh-base': '1.0.0',
              'restored-plugin': '^9.9.9',
            },
          },
        },
        { path: '.dsh-galaxy/state.json', type: 'json', json: { channel: 'beta' } },
      ],
    }
    const response = await call('/dsh-galaxy/restore', { method: 'POST', body: { backup } })
    expect(response.status).toBe(200)

    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    // Merged, not replaced: the profile's own community dependency survives,
    // and the backup's spec is applied.
    expect(manifest.dependencies['restored-plugin']).toBe('^9.9.9')
    expect(manifest.dependencies['community-demo-plugin']).toBe('^1.2.3')

    const state = JSON.parse(
      readFileSync(join(home, 'profiles', 'web', '.dsh-galaxy', 'state.json'), 'utf8'),
    ) as { channel?: string }
    expect(state.channel).toBe('beta')
  })

  it('restore refuses a backup that names a file outside the allowlist', async () => {
    const backup = {
      format: 'dsh-galaxy-backup',
      version: '0.2',
      createdAt: new Date().toISOString(),
      profile: 'web',
      files: [{ path: '../../etc/passwd', type: 'lines', lines: ['x'] }],
    }
    const response = await call('/dsh-galaxy/restore', { method: 'POST', body: { backup } })
    expect(response.status).toBe(400)
  })
})

/**
 * Uninstall must say when the running host cannot drop the plugin.
 *
 * Removing the package clears the market list immediately, but a plugin the
 * process already mounted stays in memory (and in the sidebar) until restart —
 * the state that was reported as "the uninstall did not work". The response
 * therefore carries `needsRestart` whenever the hot teardown did not happen.
 */
describe('uninstall reports a required restart', () => {
  it('answers needsRestart when the plugin cannot be hot-unmounted', async () => {
    const localRoutes: HostRoute[] = []
    const localHost = {
      webServer: {
        register(route: HostRoute): () => void {
          localRoutes.push(route)
          return () => {}
        },
      },
      logger: { warn: (): void => {} },
    }
    const profile = 'uninstall-fixture'
    const dir = join(home, 'profiles', profile)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-uninstall-fixture',
      dependencies: { 'demo-plugin': '^1.0.0' },
    }, null, 2))

    // A runner that SUCCEEDS: the point is the response shape, not the failure path.
    const succeedingRunner = async (): Promise<InstallResult> => ({
      exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false,
    })
    const disposeLocal = mountGalaxyRoutes(localHost, { profile }, succeedingRunner)
    try {
      const route = localRoutes.find(candidate => candidate.path === '/dsh-galaxy/uninstall')
      expect(route).toBeDefined()
      const response = new FakeResponse()
      await route?.handler(
        fakeRequest({ url: '/dsh-galaxy/uninstall', method: 'POST', body: { name: 'demo-plugin' } }),
        response as unknown as import('node:http').ServerResponse,
      )

      expect(response.status).toBe(200)
      const payload = response.json<{ ok: boolean; needsRestart?: boolean; hot?: boolean }>()
      expect(payload.ok).toBe(true)
      expect(payload.hot).toBeUndefined()
      expect(payload.needsRestart).toBe(true)
    } finally {
      disposeLocal()
    }
  })
})

/**
 * The production shape: a mount that builds its OWN CLI runner.
 *
 * `mountGalaxyRoutes` used to call `createCliRunner(config)` with no runtime,
 * while the runner is the only place that (a) publishes the cancellable child
 * for `POST /cancel` and (b) forwards the child's output to the progress
 * tracker. Both were therefore dead in production and invisible to every test
 * that injected a stub runner — the panel could not show progress, and its
 * cancel button silently did nothing.
 *
 * This case mounts without a runner and drives the real path: a fake `dsh` on
 * PATH prints a pnpm summary line and then sleeps, so `/status` and `/cancel`
 * can be exercised while the child is genuinely running.
 */
describe('a mount that owns its runner (production shape)', () => {
  it('publishes child output to /status and lets /cancel reach the child', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'galaxy-dsh-'))
    const script = join(binDir, 'dsh')
    writeFileSync(script, `#!/bin/sh
echo 'Progress: resolved 5, reused 1, downloaded 2, added 2, done'
sleep 30
`, { mode: 0o755 })
    const originalPath = process.env.PATH
    const originalCatalog = process.env.DSHG_REGISTRY_URL
    process.env.PATH = `${binDir}:${originalPath ?? ''}`

    // A local catalog so the install resolves offline: the route authorizes the
    // requested source against the curated registry before anything spawns.
    const catalog = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        plugins: [{ name: 'demo-package', npm: 'demo-package', url: 'https://github.com/demo/demo-package' }],
      }))
    })
    await new Promise<void>(resolve => { catalog.listen(0, '127.0.0.1', resolve) })
    const catalogPort = (catalog.address() as AddressInfo).port
    process.env.DSHG_REGISTRY_URL = `http://127.0.0.1:${String(catalogPort)}/plugins.json`

    const localRoutes: HostRoute[] = []
    const localHost = {
      webServer: {
        register(route: HostRoute): () => void {
          localRoutes.push(route)
          return () => {}
        },
      },
      logger: { warn: (): void => {} },
    }
    const profile = 'runner-fixture'
    mkdirSync(join(home, 'profiles', profile), { recursive: true })

    // No runner argument: the mount creates the CLI runner itself.
    const disposeLocal = mountGalaxyRoutes(localHost, { profile })
    const call = async (path: string, options: RequestOptions = {}): Promise<FakeResponse> => {
      const route = localRoutes.find(candidate => candidate.path === path && candidate.kind === 'exact')
      if (route === undefined) throw new Error(`no local route for ${path}`)
      const response = new FakeResponse()
      await route.handler(
        fakeRequest({ url: path, ...options }),
        response as unknown as import('node:http').ServerResponse,
      )
      return response
    }
    const status = async (): Promise<{ busy: boolean; progress: { active: boolean; lines?: string[]; phase?: string } }> => {
      return (await call('/dsh-galaxy/status')).json()
    }

    try {
      // Not awaited: the install runs until the child ends (or is cancelled).
      const installing = call('/dsh-galaxy/install', { method: 'POST', body: { url: 'demo-package' } })

      // The tracker starts under the install lock, and the child's own words
      // arrive while it runs — this is the whole point of.
      let snapshot = await status()
      for (let attempt = 0; attempt < 100 && (snapshot.progress.lines ?? []).length === 0; attempt += 1) {
        await new Promise(resolve => { setTimeout(resolve, 50) })
        snapshot = await status()
      }
      expect(snapshot.progress.active).toBe(true)
      expect(snapshot.progress.phase).toBe('install')
      expect((snapshot.progress.lines ?? []).join('\n')).toContain('resolved 5')
      expect(snapshot.busy).toBe(true)

      // The child is running, so it must be reachable by /cancel.
      const cancelled = await call('/dsh-galaxy/cancel', { method: 'POST', body: {} })
      expect(cancelled.status).toBe(200)
      expect(cancelled.json<{ cancelled: boolean }>().cancelled).toBe(true)

      const finished = await installing
      expect(finished.json<{ cancelled?: boolean }>().cancelled).toBe(true)
    } finally {
      disposeLocal()
      process.env.PATH = originalPath
      if (originalCatalog === undefined) delete process.env.DSHG_REGISTRY_URL
      else process.env.DSHG_REGISTRY_URL = originalCatalog
      await new Promise<void>(resolve => { catalog.close(() => { resolve() }) })
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('host version on the wire', () => {
  it('reports the version the profile anchor installs, with its source', async () => {
    // The panel shows this, and the compatibility verdicts are computed from it,
    // so the route must carry the DETECTED version — not `DSH_HOST_VERSION`,
    // which dsh never sets (that is why every verdict used to be `unknown`).
    const anchor = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-base')
    mkdirSync(anchor, { recursive: true })
    writeFileSync(join(anchor, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.1.5-alpha.1' }))

    const localRoutes: HostRoute[] = []
    const localHost = {
      webServer: {
        register(route: HostRoute): () => void {
          localRoutes.push(route)
          return () => {}
        },
      },
      logger: { warn: (): void => {} },
    }
    const profile = 'host-version-fixture'
    mkdirSync(join(home, 'profiles', profile), { recursive: true })
    const disposeLocal = mountGalaxyRoutes(localHost, { profile })
    try {
      const route = localRoutes.find(candidate => candidate.path === '/dsh-galaxy/status')
      expect(route).toBeDefined()
      const response = new FakeResponse()
      await route?.handler(
        fakeRequest({ url: '/dsh-galaxy/status' }),
        response as unknown as import('node:http').ServerResponse,
      )
      const payload = response.json<{ hostVersion: string | null; hostVersionSource: string | null; version: string }>()
      expect(payload.hostVersion).toBe('0.1.5-alpha.1')
      expect(payload.hostVersionSource).toBe('anchor')
      // The plugin's own version stays a separate field.
      expect(payload.version).not.toBe('0.1.5-alpha.1')
    } finally {
      disposeLocal()
      rmSync(join(home, 'profiles', 'node_modules'), { recursive: true, force: true })
    }
  })
})

/**
 * The catalog source is the one setting with no other entry point, and the one
 * whose absence made a healthy panel look broken: a packaged app without it fell
 * back to the built-in public catalog (4508 rows, no ranking, a MAP-shaped
 * vocabulary) and showed no featured category and no category selector.
 *
 * Read side lives in `/status` (one registration per path), write side here.
 * This harness sets `DSHG_REGISTRY_URL`, so the environment is reported as the
 * winning layer — which is exactly the precedence the card has to explain.
 */
describe('catalog source', () => {
  it('reports the stored values and which layer wins through /status', async () => {
    const response = await call('/dsh-galaxy/status')
    expect(response.status).toBe(200)
    const body = await response.json() as { catalogUrl: string; siteUrl: string; catalogSource: string; effectiveCatalogUrl: string; envCatalog: boolean }
    expect(body.envCatalog).toBe(true)
    expect(body.catalogSource).toBe('env')
    expect(body.catalogUrl).toBe('')
    expect(body.effectiveCatalogUrl).toBe('http://127.0.0.1:1/plugins.json')
  })

  it('stores both URLs, then clears them back to the fallback', async () => {
    const response = await call('/dsh-galaxy/catalog-source', {
      method: 'POST',
      body: { catalogUrl: 'https://www.yhaigc.cn/assets/plugins/catalog.json', siteUrl: 'https://www.yhaigc.cn' },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { catalogSource: string; effectiveCatalogUrl: string; siteUrl: string }
    // The env override still wins for the catalog, but siteUrl has no override.
    expect(body.catalogSource).toBe('env')
    expect(body.effectiveCatalogUrl).toBe('http://127.0.0.1:1/plugins.json')
    expect(body.siteUrl).toBe('https://www.yhaigc.cn')

    const state = JSON.parse(readFileSync(join(home, 'profiles', 'web', '.dsh-galaxy', 'state.json'), 'utf8')) as { catalogUrl?: string; siteUrl?: string }
    expect(state.catalogUrl).toBe('https://www.yhaigc.cn/assets/plugins/catalog.json')
    expect(state.siteUrl).toBe('https://www.yhaigc.cn')

    const cleared = await call('/dsh-galaxy/catalog-source', { method: 'POST', body: { catalogUrl: '', siteUrl: '' } })
    const after = await cleared.json() as { catalogUrl: string; siteUrl: string }
    expect(after.catalogUrl).toBe('')
    expect(after.siteUrl).toBe('')
  })

  it('rejects a non-URL value instead of storing it', async () => {
    for (const bad of ['not-a-url', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const response = await call('/dsh-galaxy/catalog-source', { method: 'POST', body: { catalogUrl: bad } })
      expect(response.status, bad).toBe(400)
    }
    const missing = await call('/dsh-galaxy/catalog-source', { method: 'POST', body: {} })
    expect(missing.status).toBe(400)
  })
})
