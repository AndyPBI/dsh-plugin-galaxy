/**
 * Official-site linkage.
 *
 * Two properties matter more than the URL string itself:
 *
 *  1. **The key is stable and shared with the site.** Name-based links open the
 *     wrong plugin as soon as a catalog has duplicates, so the key is
 *     `owner/name` — the same thing the website's own catalog builder composes.
 *  2. **A link is never invented.** The base comes from `DSHG_SITE_URL` or from
 *     the origin the catalog was served from, and a derived base is trusted only
 *     for rows that carry the site's `key` marker. An operator pointing at the
 *     upstream catalog gets no links rather than links to a stranger's site.
 */

import { describe, expect, it } from 'vitest'

import { siteBase, siteKeyOf, siteUrlFor, withSiteLinks } from '../src/domain/site.ts'
import { catalogUrl } from '../src/domain/registry.ts'
import { linkedRegistryFor } from '../src/domain/site.ts'
import type { Registry, RegistryPlugin } from '../src/core/types.ts'

/** A catalog row as the upstream catalog publishes it (no `key`). */
function upstream(over: Partial<RegistryPlugin> = {}): RegistryPlugin {
  return { name: 'dsh-memory', owner: 'FuRongJun-1999', url: 'https://github.com/FuRongJun-1999/dsh-memory', ...over }
}

/** A row as the operator's own site publishes it (with `key`). */
function siteRow(over: Partial<RegistryPlugin> = {}): RegistryPlugin {
  return { ...upstream(), key: 'FuRongJun-1999/dsh-memory', ...over }
}

function registry(plugins: RegistryPlugin[]): Registry {
  return { plugins, count: plugins.length } as Registry
}

describe('site key', () => {
  it('is owner/name, the same thing the website composes', () => {
    expect(siteKeyOf(upstream())).toBe('FuRongJun-1999/dsh-memory')
  })

  it('prefers the catalog\'s own key when it ships one', () => {
    expect(siteKeyOf(siteRow({ key: 'zhu1090093659/dsh-web#packages/dsh-task-board' })))
      .toBe('zhu1090093659/dsh-web#packages/dsh-task-board')
  })

  it('is undefined when the row cannot name one', () => {
    expect(siteKeyOf({ name: 'dsh-x' })).toBeUndefined()
    expect(siteKeyOf({ name: 'dsh-x', owner: '   ' })).toBeUndefined()
  })
})

describe('site base', () => {
  it('comes from DSHG_SITE_URL when set', () => {
    expect(siteBase({ DSHG_SITE_URL: 'https://www.yhaigc.cn/' }))
      .toEqual({ base: 'https://www.yhaigc.cn', source: 'env' })
  })

  it('falls back to the origin the catalog is served from', () => {
    expect(siteBase({ DSHG_REGISTRY_URL: 'https://www.yhaigc.cn/assets/plugins/catalog.json' }))
      .toEqual({ base: 'https://www.yhaigc.cn', source: 'catalog-origin' })
  })

  it('keeps a sub-path base usable', () => {
    expect(siteBase({ DSHG_SITE_URL: 'https://example.com/dsh/' })?.base).toBe('https://example.com/dsh')
  })

  it('is undefined for junk, a missing env, or a non-http base', () => {
    expect(siteBase({})).toBeUndefined()
    expect(siteBase({ DSHG_SITE_URL: 'not a url' })).toBeUndefined()
    expect(siteBase({ DSHG_SITE_URL: 'file:///tmp/x' })).toBeUndefined()
    expect(siteBase({ DSHG_REGISTRY_URL: 'ftp://x/y.json' })).toBeUndefined()
  })
})

describe('site url for one plugin', () => {
  const env = { DSHG_SITE_URL: 'https://www.yhaigc.cn' }

  it('points at the site\'s plugin page and encodes the key', () => {
    expect(siteUrlFor(upstream(), siteBase(env)))
      .toBe('https://www.yhaigc.cn/#/ai/p/FuRongJun-1999%2Fdsh-memory')
  })

  it('survives a key containing # (monorepo sub-path)', () => {
    const plugin = siteRow({ key: 'o/r#packages/pkg' })
    // `#` must be percent-encoded or the hash router would cut the key there.
    expect(siteUrlFor(plugin, siteBase(env))).toBe('https://www.yhaigc.cn/#/ai/p/o%2Fr%23packages%2Fpkg')
  })

  it('does not encode the / in a plain key twice', () => {
    expect(siteUrlFor(upstream(), siteBase(env))).not.toContain('%252F')
  })
})

describe('attaching links to a registry', () => {
  it('links every row when the site is configured explicitly', () => {
    const result = withSiteLinks(registry([upstream(), upstream({ name: 'dsh-other', owner: 'x' })]), {
      DSHG_SITE_URL: 'https://www.yhaigc.cn',
    })
    expect(result.linked).toBe(true)
    expect(result.base).toBe('https://www.yhaigc.cn')
    expect(result.source).toBe('env')
    expect(result.registry.plugins.every(plugin => plugin.siteUrl?.startsWith('https://www.yhaigc.cn/#/ai/p/'))).toBe(true)
  })

  it('links only site-published rows when the base is derived from the catalog', () => {
    // The upstream catalog has no `key`: linking it to whatever origin served the
    // JSON would point every plugin at a site that has never heard of them.
    const result = withSiteLinks(registry([upstream(), siteRow({ key: 'FuRongJun-1999/dsh-memory' })]), {
      DSHG_REGISTRY_URL: 'https://www.yhaigc.cn/assets/plugins/catalog.json',
    })
    expect(result.source).toBe('catalog-origin')
    expect(result.registry.plugins[0]?.siteUrl).toBeUndefined()
    expect(result.registry.plugins[1]?.siteUrl).toBe('https://www.yhaigc.cn/#/ai/p/FuRongJun-1999%2Fdsh-memory')
    expect(result.linked).toBe(true)
  })

  it('changes nothing when there is no site at all', () => {
    const input = registry([upstream()])
    const result = withSiteLinks(input, {})
    expect(result.linked).toBe(false)
    expect(result.registry).toBe(input)
    expect(result.registry.plugins[0]?.siteUrl).toBeUndefined()
  })

  it('skips rows that cannot produce a key', () => {
    const result = withSiteLinks(registry([{ name: 'dsh-anon' }]), { DSHG_SITE_URL: 'https://x.test' })
    expect(result.linked).toBe(false)
    expect(result.registry.plugins[0]?.siteUrl).toBeUndefined()
  })

  it('keeps every other field of a linked row', () => {
    const result = withSiteLinks(registry([siteRow({ stars: 176, npm: 'dsh-memory', install: 'dsh plugin add dsh-memory' })]), {
      DSHG_SITE_URL: 'https://www.yhaigc.cn',
    })
    const row = result.registry.plugins[0]
    expect(row?.stars).toBe(176)
    expect(row?.npm).toBe('dsh-memory')
    expect(row?.install).toBe('dsh plugin add dsh-memory')
  })
})

describe('profile-scoped overrides (config travels with the profile)', () => {
  /**
   * A deployment copies the PROFILE; the process environment belongs to whoever
   * launched it. So the catalog a server reads can live in the profile's own
   * state, with the environment still winning when ops wants the last word.
   */
  const state = {
    catalogUrl: 'https://www.yhaigc.cn/assets/plugins/catalog.json',
    siteUrl: 'https://www.yhaigc.cn/site',
  }

  it('uses the catalog from the profile when the environment is silent', () => {
    expect(catalogUrl({}, state)).toBe(state.catalogUrl)
  })

  it('lets the environment override the profile', () => {
    expect(catalogUrl({ DSHG_REGISTRY_URL: 'https://env.test/c.json' }, state)).toBe('https://env.test/c.json')
  })

  it('falls back to the built-in catalog when neither is set', () => {
    expect(catalogUrl({}, {})).toBe(catalogUrl({}))
  })

  it('derives the site base from a profile-configured catalog', () => {
    // Only the catalog is stored here: its origin IS the site.
    expect(siteBase({}, { catalogUrl: state.catalogUrl }))
      .toEqual({ base: 'https://www.yhaigc.cn', source: 'catalog-origin' })
  })

  it('prefers an explicit siteUrl over the catalog origin', () => {
    expect(siteBase({}, state)?.source).toBe('state')
  })

  it('honours an explicit siteUrl in the profile', () => {
    expect(siteBase({}, { siteUrl: state.siteUrl })).toEqual({ base: 'https://www.yhaigc.cn/site', source: 'state' })
  })

  it('still lets the environment beat the profile', () => {
    expect(siteBase({ DSHG_SITE_URL: 'https://env.test' }, state)).toEqual({ base: 'https://env.test', source: 'env' })
  })

  it('links the whole catalog when the site came from the profile itself', () => {
    // `state` is an explicit source, like env: it is the operator saying "link
    // everything here", so rows without a `key` get a link too.
    const result = withSiteLinks(registry([upstream()]), { DSHG_SITE_URL: '' })
    expect(result.linked).toBe(false)
    expect(siteBase({ DSHG_SITE_URL: state.siteUrl }, {})?.source).toBe('env')
  })
})

describe('the overrides survive a state round trip', () => {
  it('keeps catalogUrl and siteUrl through write → read', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readGalaxyState, setCatalogUrl, setSiteUrl } = await import('../src/core/state.ts')
    const dir = mkdtempSync(join(tmpdir(), 'galaxy-state-'))
    try {
      setCatalogUrl(dir, 'https://www.yhaigc.cn/assets/plugins/catalog.json')
      setSiteUrl(dir, 'https://www.yhaigc.cn')
      const state = readGalaxyState(dir)
      expect(state.catalogUrl).toBe('https://www.yhaigc.cn/assets/plugins/catalog.json')
      expect(state.siteUrl).toBe('https://www.yhaigc.cn')
      // Clearing works too, so an operator can go back to the public catalog.
      setCatalogUrl(dir, '')
      expect(readGalaxyState(dir).catalogUrl).toBeUndefined()
      expect(readGalaxyState(dir).siteUrl).toBe('https://www.yhaigc.cn')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a site catalog loaded through the real loader', () => {
  /**
   * The end-to-end path, and the regression that only it could catch: the loader
   * rebuilds every row FIELD BY FIELD, so a catalog field it does not copy is a
   * field the rest of the system never sees — the site's `key` was dropped there,
   * which silently disabled every official-site link.
   */
  it('keeps the site key and links all 221-style rows', async () => {
    const { createServer } = await import('node:http')
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { loadRegistry } = await import('../src/domain/registry.ts')

    const rows = [
      { key: 'V1ki/dsh-plugin-subscriptions', name: 'dsh-plugin-subscriptions', owner: 'V1ki', url: 'https://github.com/V1ki/dsh-plugin-subscriptions', npm: 'dsh-plugin-subscriptions', category: 'service', stars: 340 },
      { key: 'o/r#packages/pkg', name: 'r#packages/pkg', displayName: 'r packages/pkg', owner: 'o', url: 'https://github.com/o/r/tree/main/packages/pkg', npm: 'pkg', category: 'dev', stars: 5, score: 64.13, band: 'B', scoreVersion: 'opc-ranking/1', scoreParts: { popularity: 16.2, keywords: 10 }, pinReason: '生态里独一份的能力' },
    ]
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        schema: 'pbi-plugin-catalog/1',
        plugins: rows,
        ranking: { version: 'opc-ranking/1', window: 20, top: rows.map(row => row.key), pins: [{ key: 'o/r#packages/pkg', reason: '生态里独一份的能力' }] },
      }))
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as { port: number }).port

    const dir = mkdtempSync(join(tmpdir(), 'galaxy-sitecatalog-'))
    try {
      mkdirSync(join(dir, '.dsh-galaxy'), { recursive: true })
      writeFileSync(join(dir, '.dsh-galaxy', 'state.json'), JSON.stringify({ catalogUrl: `http://127.0.0.1:${String(port)}/catalog.json` }))

      const loaded = await loadRegistry('web', dir, true)
      expect(loaded.plugins).toHaveLength(2)
      expect(loaded.plugins[0]?.key).toBe('V1ki/dsh-plugin-subscriptions')
      expect(loaded.plugins[1]?.key).toBe('o/r#packages/pkg')

      const runtime = {
        dir,
        config: { profileDirectory: dir },
        caches: new Map<string, unknown>(),
        cache<T>(key: string): T | undefined { return this.caches.get(key) as T | undefined },
        setCache(key: string, value: unknown): void { this.caches.set(key, value) },
      }
      // P2 依赖的两件事：推荐榜块与每行评分字段必须**穿过加载器**（它逐字段重建行，
      // 早先就因此丢过 `key`，导致官网链接全部失效）。
      expect(loaded.ranking?.version).toBe('opc-ranking/1')
      expect(loaded.ranking?.window).toBe(20)
      expect(loaded.ranking?.top).toEqual(['V1ki/dsh-plugin-subscriptions', 'o/r#packages/pkg'])
      expect(loaded.plugins[1]?.score).toBe(64.13)
      expect(loaded.plugins[1]?.band).toBe('B')
      expect(loaded.plugins[1]?.scoreParts).toEqual({ popularity: 16.2, keywords: 10 })
      expect(loaded.plugins[1]?.pinReason).toBe('生态里独一份的能力')
      // 展示名同样要穿过重建：漏掉它，面板就只能在卡片上显示带 `#` 的原始 name
      expect(loaded.plugins[1]?.displayName).toBe('r packages/pkg')
      expect(loaded.plugins[0]?.displayName).toBeUndefined()

      const linked = linkedRegistryFor(runtime as never, loaded)
      expect(linked.linked).toBe(true)
      expect(linked.base).toBe(`http://127.0.0.1:${String(port)}`)
      expect(linked.registry.plugins.every(plugin => plugin.siteUrl?.includes('/#/ai/p/'))).toBe(true)
      // The monorepo key's `#` survives into the URL encoded, or the hash router
      // would cut the key in half.
      expect(linked.registry.plugins[1]?.siteUrl).toContain('o%2Fr%23packages%2Fpkg')
    } finally {
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
      rmSync(dir, { recursive: true, force: true })
      // The loader may consult the ambient environment; keep other tests honest.
      delete process.env.DSHG_REGISTRY_URL
    }
  }, 20_000)
})
