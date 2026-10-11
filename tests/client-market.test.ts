// @vitest-environment jsdom
/**
 * Discover-tab interaction regressions.
 *
 * Every case here reproduces a reported defect against data shaped like the
 * LIVE catalog (3561 entries, 152 duplicate display names) rather than a tidy
 * fixture:
 *
 *  1. duplicate display names must still produce one distinct card each —
 *     `key={plugin.name}` collided and React reused DOM nodes between rows;
 *  2. the "installed" filter must correspond to the installed inventory, not to
 *     catalog rows that merely share a name (a namesake `@author/dsh-knowledge`
 *     was reported as installed while three real plugins were missing);
 *  3. the refresh button must actually force a catalog revalidation and report
 *     that it ran.
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MarketSection } from '../src/client/MarketSection.tsx'
import { en, translate, zh } from '../src/client/locales.ts'

const t = (key: string, params?: Record<string, string | number>): string => translate(en, key, params)

/* ------------------------------------------------------------------ *
 * Fixtures shaped like the real profile and the real catalog
 * ------------------------------------------------------------------ */

/** The user's actual installed set (one is disabled, as in the live host). */
const INSTALLED = [
  { name: 'dsh-knowledge', version: '0.3.9', spec: '^0.3.9', kind: 'npm', bundle: true, disabled: false, client: false },
  { name: 'dsh-plugin-galaxy', version: '0.1.1', spec: 'file:./x.tgz', kind: 'local', bundle: true, disabled: false, client: true },
  { name: 'dsh-worktable', version: '0.3.3', spec: 'link:../wt', kind: 'local', bundle: true, disabled: false, client: true },
  { name: 'dsh-workvista', version: '0.1.12', spec: 'file:./y.tgz', kind: 'local', bundle: true, disabled: true, client: true },
]

/**
 * Catalog rows that reproduce the two traps:
 *  - `dsh-knowledge` appears twice under DIFFERENT packages (bare vs scoped),
 *    so name-matching marks a namesake as installed;
 *  - `dsh-memory` appears three times, so the card key collides.
 */
const CATALOG = [
  { name: 'dsh-knowledge', npm: 'dsh-knowledge', owner: 'alpha', url: 'https://github.com/alpha/dsh-knowledge', category: 'memory', description: 'bare package' },
  { name: 'dsh-knowledge', npm: '@lemoncat7/dsh-knowledge', owner: 'lemoncat7', url: 'https://github.com/lemoncat7/dsh-knowledge', category: 'memory', description: 'namesake, different package' },
  { name: 'dsh-worktable', npm: 'dsh-worktable', owner: 'wt', url: 'https://github.com/wt/dsh-worktable', category: 'ui' },
  { name: 'dsh-memory', npm: 'dsh-memory', owner: 'm1', url: 'https://github.com/m1/dsh-memory', category: 'memory' },
  { name: 'dsh-memory', npm: 'dsh-memory', owner: 'm2', url: 'https://github.com/m2/dsh-memory', category: 'memory' },
  { name: 'dsh-memory', npm: 'dsh-memory', owner: 'm3', url: 'https://github.com/m3/dsh-memory', category: 'memory' },
  { name: 'dsh-other', npm: 'dsh-other', owner: 'other', url: 'https://github.com/other/dsh-other', category: 'ui' },
]

const INVENTORY = {
  profile: 'web',
  installed: INSTALLED,
  repoIdentities: {},
  repoHints: {},
  present: INSTALLED.map(plugin => plugin.name),
  activation: [],
  live: [],
  disabled: ['dsh-workvista'],
  groups: {},
  groupOrder: [],
  notes: {},
  favorites: [],
  bundles: INSTALLED.map(plugin => plugin.name),
  patch: { exists: false, rows: [], referenced: [], unreadable: false },
  diagnostics: {
    profile: 'web', hostVersion: '0.1.5', generatedAt: '2026-01-01T00:00:00.000Z',
    summary: { errors: 0, warnings: 0, packages: 4, bundles: 4 },
    bundles: [], peerMismatches: [], duplicateNames: [], findings: [],
  },
}

interface Call { url: string; method: string }

let calls: Call[] = []
let root: Root | null = null
let consoleErrors: string[] = []

/** Flush the effect/await chain React and the component's fetches need. */
async function flush(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  calls = []
  consoleErrors = []
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '))
  })

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url.includes('/registry')) return json({ registry: { plugins: CATALOG, count: CATALOG.length } })
    if (url.includes('/installed')) return json(INVENTORY)
    if (url.includes('/updates')) return json([])
    if (url.includes('/discovery-compatibility')) return json({ results: [] })
    if (url.includes('/status')) {
      return json({
        boot: 'test-boot', version: '0.1.1', channel: 'stable', region: 'global', profile: 'web',
        busy: false, progress: { active: false }, pnpm: { ok: true },
        restart: { allowed: false, debugger: false, scheduled: false }, installed: [],
      })
    }
    return json({ ok: true })
  }) as typeof fetch

  document.body.innerHTML = '<div id="host"></div>'
})

afterEach(() => {
  root?.unmount()
  root = null
  vi.restoreAllMocks()
})

/** Mount the settings section and let its initial reads settle. */
async function mount(): Promise<HTMLElement> {
  const container = document.getElementById('host') as HTMLElement
  root = createRoot(container)
  root.render(createElement(MarketSection, {
    t,
    locale: {
      register: () => undefined,
      bind: () => t,
      subscribe: () => () => undefined,
      getSnapshot: () => ({ active: 'en' }),
    },
    theme: { getTheme: () => ({ id: 'dark' }), setTheme: () => undefined },
    themeStore: { subscribe: () => () => undefined, getSnapshot: () => ({ id: 'dark' }), getServerSnapshot: () => ({ id: 'dark' }) },
  }))
  await flush()
  return container
}

/** Card titles currently rendered in the Discover panel. */
function cardTitles(host: HTMLElement): string[] {
  return [...host.querySelectorAll('article[aria-label]')].map(article => article.getAttribute('aria-label') ?? '')
}

/**
 * Click the Discover filter chip whose visible label matches.
 *
 * Scoped to a `role="group"` container: the tab bar also has a button labelled
 * "Installed" (the tab), and a document-wide search would click that instead and
 * silently test the wrong surface.
 */
function clickChip(host: HTMLElement, label: string): void {
  for (const group of host.querySelectorAll('[role="group"]')) {
    const chip = [...group.querySelectorAll('button')]
      .find(button => (button.textContent ?? '').trim() === label)
    if (chip !== undefined) {
      chip.click()
      return
    }
  }
  throw new Error(`no filter chip labelled ${label}`)
}

/** Click the toolbar refresh button. */
function clickReload(host: HTMLElement): void {
  const button = [...host.querySelectorAll('button')].find(button => (button.textContent ?? '').trim() === 'Refresh')
    ?? [...host.querySelectorAll('button')].find(button => (button.textContent ?? '').trim() === 'Reload')
  if (button === undefined) throw new Error('no refresh button')
  button.click()
}

describe('Discover — duplicate catalog names', () => {
  it('renders one distinct card per catalog entry and never reuses a key', async () => {
    const host = await mount()

    // 2 × dsh-knowledge + 1 × dsh-worktable + 3 × dsh-memory + 1 × dsh-other
    expect(cardTitles(host).length).toBe(7)
    expect(cardTitles(host).filter(title => title === 'dsh-memory').length).toBe(3)

    const collisions = consoleErrors.filter(line => line.includes('same key'))
    expect(collisions).toEqual([])
  })

  it('disambiguates same-named rows with their owner', async () => {
    const host = await mount()
    const text = host.textContent ?? ''
    // The three dsh-memory rows are different plugins; each shows its author.
    expect(text).toContain('m1')
    expect(text).toContain('m2')
    expect(text).toContain('m3')
    // And the two dsh-knowledge rows are told apart the same way.
    expect(text).toContain('lemoncat7')
  })

  it('opens straight into the marketplace: no tab bar, no idle status strip', async () => {
    /*
     * The panel used to carry a tab bar (Discover / Installed / Favorites /
     * Themes) and an always-on strip (展开·任务 · 共 N 条记录 · 版本 · 宿主 ·
     * 快照/预设/诊断). Both are gone, and the subtitle is the new one.
     */
    const host = await mount()

    expect(host.querySelector('[role="tablist"]')).toBeNull()
    const text = host.textContent ?? ''
    expect(text).toContain('Value picked from thousands of plugins')
    // The strip's own labels: the operations count, the host version, the three
    // panel buttons. (`Version:` is NOT asserted: installed cards legitimately
    // show the installed version.)
    expect(text).not.toContain('record(s)')
    expect(text).not.toContain('Host:')
    expect(text).not.toContain('Snapshots')
    expect(text).not.toContain('Presets')
    expect(text).not.toContain('Diagnostics')
    // The marketplace itself is still there: the filter row and the cards.
    // (This catalog ships no ranking block, so that chip reads 「未安装」 here.)
    expect(text).toContain('All')
    expect(text).toContain('Not installed')
    expect(cardTitles(host).length).toBeGreaterThan(0)
  })
})

describe('Discover — installed filter corresponds to the inventory', () => {
  it('lists exactly the installed plugins, once each, as CARDS', async () => {
    // 「已安装」 renders the same card grid as every other filter (the list form
    // is retained in the code but no longer an entry point), one card per
    // installed plugin.
    const host = await mount()
    clickChip(host, 'Installed')
    await flush()

    const titles = cardTitles(host)
    expect(titles.length).toBe(INSTALLED.length)
    for (const plugin of INSTALLED) {
      expect(titles.filter(title => title === plugin.name).length).toBe(1)
    }
  })

  it('never reports a namesake package as installed', async () => {
    const host = await mount()
    clickChip(host, 'Installed')
    await flush()

    // `@lemoncat7/dsh-knowledge` is a different package that shares the display
    // name; it must not appear as an installed plugin.
    const text = host.textContent ?? ''
    expect(text).not.toContain('lemoncat7')
  })

  it('reports the installed total in the count line', async () => {
    const host = await mount()
    clickChip(host, 'Installed')
    await flush()
    expect(host.textContent).toContain(String(INSTALLED.length))
  })

  it('offers lifecycle actions rather than "install" for an installed plugin', async () => {
    const host = await mount()
    clickChip(host, 'Installed')
    await flush()
    const labels = [...host.querySelectorAll('button')].map(button => (button.textContent ?? '').trim())
    expect(labels).toContain('Disable')
    expect(labels).toContain('Enable') // the disabled dsh-workvista
    expect(labels).not.toContain('Install')
  })
})

describe('Discover — uninstall from an installed card', () => {
  it('shows an uninstall action on every installed card it owns', async () => {
    const host = await mount()
    clickChip(host, 'Installed')
    await flush()

    // Four installed plugins; three are uninstallable (the market itself is
    // not), so each of those cards carries its own button.
    const uninstall = [...host.querySelectorAll('button')]
      .filter(button => (button.textContent ?? '').trim() === 'Uninstall')
    expect(uninstall.length).toBe(INSTALLED.length - 1)
  })

  it('does not offer uninstall or disable on the market\'s own card', async () => {
    const host = await mount()
    clickChip(host, 'Installed')
    await flush()

    const selfCard = [...host.querySelectorAll('article[aria-label]')]
      .find(article => article.getAttribute('aria-label') === 'dsh-plugin-galaxy')
    expect(selfCard).toBeDefined()
    const labels = [...(selfCard?.querySelectorAll('button') ?? [])]
      .map(button => (button.textContent ?? '').trim())
    // The server refuses both for its own package (isProtectedModule / self-uninstall).
    expect(labels).not.toContain('Uninstall')
    expect(labels).not.toContain('Disable')
    expect(labels).not.toContain('Enable')
  })

  it('asks for confirmation instead of uninstalling immediately', async () => {
    const host = await mount()
    clickChip(host, 'Installed')
    await flush()

    const button = [...host.querySelectorAll('button')]
      .find(candidate => (candidate.textContent ?? '').trim() === 'Uninstall')
    button?.click()
    await flush(2)

    // No request yet — only the dialog, and it names the plugin it would remove.
    expect(calls.some(call => call.url.includes('/uninstall'))).toBe(false)
    expect(host.textContent).toContain('This removes dsh-knowledge from the current profile')
  })

  it('tells the user a restart is required when the host keeps the plugin mounted', async () => {
    // Removing the package cannot unload a plugin the running host already
    // mounted; without this notice the sidebar entry reads as a failed uninstall.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/uninstall')) return json({ ok: true, name: 'dsh-knowledge', needsRestart: true })
      if (url.includes('/registry')) return json({ registry: { plugins: CATALOG, count: CATALOG.length } })
      if (url.includes('/installed')) return json(INVENTORY)
      if (url.includes('/updates')) return json([])
      if (url.includes('/discovery-compatibility')) return json({ results: [] })
      if (url.includes('/status')) {
        return json({
          boot: 'test-boot', version: '0.1.5', channel: 'stable', region: 'global', profile: 'web',
          busy: false, progress: { active: false }, pnpm: { ok: true },
          restart: { allowed: false, debugger: false, scheduled: false }, installed: [],
        })
      }
      return json({ ok: true })
    }) as typeof fetch

    const host = await mount()
    clickChip(host, 'Installed')
    await flush()

    // The card action opens the dialog; the dialog's own confirm runs the request.
    const cardButton = [...host.querySelectorAll('button')]
      .find(candidate => (candidate.textContent ?? '').trim() === 'Uninstall')
    cardButton?.click()
    await flush(2)
    const confirm = [...(host.querySelector('[role="dialog"]')?.querySelectorAll('button') ?? [])]
      .find(candidate => (candidate.textContent ?? '').trim() === 'Uninstall')
    confirm?.click()
    await flush()

    expect(calls.some(call => call.url.includes('/uninstall'))).toBe(true)
    // The notice names what changed and says a full restart makes it take effect.
    expect(host.textContent).toContain('Restart required to take full effect')
    expect(host.textContent).toContain('dsh-knowledge')
  })
})

describe('Discover — incompatible filter', () => {
  /** Answer compatibility with one verdict, and record the names asked about. */
  function stubCompatibility(verdicts: { name: string; status: string }[]): string[][] {
    const batches: string[][] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/discovery-compatibility')) {
        const requested = JSON.parse(String(init?.body ?? '{}')) as { packages?: string[] }
        batches.push(requested.packages ?? [])
        return json({
          results: (requested.packages ?? [])
            .filter(name => verdicts.some(verdict => verdict.name === name))
            .map(name => ({ name, status: 'incompatible', basis: 'manifest' })),
        })
      }
      if (url.includes('/registry')) return json({ registry: { plugins: CATALOG, count: CATALOG.length } })
      if (url.includes('/installed')) return json(INVENTORY)
      if (url.includes('/updates')) return json([])
      if (url.includes('/status')) {
        return json({
          boot: 'test-boot', version: '0.1.2', channel: 'stable', region: 'global', profile: 'web',
          busy: false, progress: { active: false }, pnpm: { ok: true },
          restart: { allowed: false, debugger: false, scheduled: false }, installed: [],
        })
      }
      return json({ ok: true })
    }) as typeof fetch
    return batches
  }

  it('asks for verdicts BEFORE filtering, so the filter can populate', async () => {
    const batches = stubCompatibility([{ name: 'dsh-other', status: 'incompatible' }])
    const host = await mount()

    // The candidate scan must have asked about entries the filter would keep —
    // a filter applied before the request finds nothing and never asks.
    expect(batches.length).toBeGreaterThan(0)
    expect(batches.flat()).toContain('dsh-other')
  })

  it('shows exactly the entries whose verdict is incompatible', async () => {
    stubCompatibility([{ name: 'dsh-other', status: 'incompatible' }])
    const host = await mount()
    clickChip(host, 'Incompatible')
    await flush()

    const titles = cardTitles(host)
    expect(titles).toEqual(['dsh-other'])
  })
})

describe('Discover — manual refresh', () => {
  it('forces a catalog revalidation instead of replaying the cache', async () => {
    const host = await mount()
    const before = calls.filter(call => call.url.includes('/registry')).length

    clickReload(host)
    await flush()

    const registryCalls = calls.filter(call => call.url.includes('/registry'))
    expect(registryCalls.length).toBeGreaterThan(before)
    expect(registryCalls.some(call => call.url.includes('force=1'))).toBe(true)
  })

  it('reports that the refresh happened', async () => {
    const host = await mount()
    clickReload(host)
    await flush()
    expect(host.textContent).toContain('Refreshed')
  })
})

describe('A mutation that never answers', () => {
  /**
   * The reported defect: an install whose package command was killed (or whose
   * grandchild kept its pipes open) never produced an HTTP response, so the
   * panel showed a bare "busy" line forever — every control disabled, no error,
   * no way out. The panel now RACES the request against a watchdog, so waiting
   * always ends in something the operator can read and act on.
   *
   * Timers are faked only for the mutation itself: mounting the panel and its
   * initial reads use real timers (the file's `flush`), and everything after
   * `vi.useFakeTimers()` is driven with `advanceTimersByTimeAsync`.
   */
  async function mountWithHangingToggle(): Promise<HTMLElement> {
    const host = await mount()
    // Everything except the mutation keeps answering. `/status` reports busy
    // only once the mutation has been requested, which is what a real host does
    // (the lock is held by that very operation).
    let mutationRequested = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/cancel')) return json({ ok: true, cancelled: true })
      if (url.includes('/toggle')) mutationRequested = true
      if (url.includes('/toggle')) return await new Promise<Response>(() => { /* never answers */ })
      if (url.includes('/installed')) return json(INVENTORY)
      if (url.includes('/registry')) return json({ registry: { plugins: CATALOG, count: CATALOG.length } })
      if (url.includes('/updates')) return json([])
      if (url.includes('/status')) {
        return json({
          boot: 'test-boot', version: '0.1.1', channel: 'stable', region: 'global', profile: 'web',
          busy: mutationRequested,
          progress: mutationRequested
            ? {
                active: true,
                target: 'dsh-knowledge',
                phase: 'install',
                downloaded: 3,
                done: 2,
                lines: [
                  '✓ Lockfile passes supply-chain policies (verified 7m ago)',
                  'Progress: resolved 173, reused 54, downloaded 3, added 2, done',
                ],
              }
            : { active: false },
          pnpm: { ok: true },
          restart: { allowed: false, debugger: false, scheduled: false }, installed: [],
        })
      }
      return json({ ok: true })
    }) as typeof fetch
    return host
  }

  /** Let pending microtasks and faked timers run. */
  async function settleFake(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await vi.advanceTimersByTimeAsync(0)
  }

  function buttonLabelled(host: HTMLElement, label: string): HTMLButtonElement | undefined {
    return [...host.querySelectorAll('button')]
      .find(button => (button.textContent ?? '').trim() === label) as HTMLButtonElement | undefined
  }

  /** Start a toggle (no confirmation dialog) whose request never answers. */
  async function startHangingMutation(host: HTMLElement): Promise<void> {
    clickChip(host, 'Installed')
    await flush()
    vi.useFakeTimers()
    const disable = buttonLabelled(host, 'Disable')
    expect(disable).toBeDefined()
    disable?.click()
    await settleFake()
  }

  afterEach(() => { vi.useRealTimers() })

  it('shows elapsed time and a way out once the watchdog fires', async () => {
    const host = await mountWithHangingToggle()
    await startHangingMutation(host)

    // Busy, but not yet stalled: no cancel affordance to click by accident.
    // The line names the SERVER's stage, not a generic "working".
    expect(host.textContent).toContain('Installing')
    expect(buttonLabelled(host, 'Cancel')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(20_000)
    await settleFake()

    expect(host.textContent).toContain('20s elapsed')
    expect(host.textContent).toContain('you can keep waiting')
    expect(buttonLabelled(host, 'Cancel')).toBeDefined()
  })

  it('shows the real stage, counters and the command\'s own output', async () => {
    const host = await mountWithHangingToggle()
    await startHangingMutation(host)

    // The status poll (1.5s while busy) carries the tracker snapshot.
    await vi.advanceTimersByTimeAsync(2_000)
    await settleFake()

    const text = host.textContent ?? ''
    // A named stage instead of a bare "busy"…
    expect(text).toContain('Installing')
    // … counters lifted out of pnpm's summary line …
    expect(text).toContain('downloaded 3')
    expect(text).toContain('added 2')
    // … and the child's own words, which are the real answer to "is it moving?".
    expect(text).toContain('Latest command output')
    expect(text).toContain('Progress: resolved 173, reused 54, downloaded 3, added 2, done')
    expect(text).toContain('supply-chain policies')
  })

  it('cancels server-side and stops waiting when the operator cancels', async () => {
    const host = await mountWithHangingToggle()
    await startHangingMutation(host)
    await vi.advanceTimersByTimeAsync(20_000)
    await settleFake()

    buttonLabelled(host, 'Cancel')?.click()
    await settleFake()

    // The server owns the child process, so it must be told …
    expect(calls.some(call => call.url.includes('/cancel') && call.method === 'POST')).toBe(true)
    // … and the panel must stop waiting and say what happened. `Working…` is
    // this page's own pending line; the server may legitimately still be busy,
    // which the separate server-side hint reports.
    expect(host.textContent).toContain('Stopped waiting')
    expect(host.textContent).not.toContain('Installing')
    expect(host.textContent).toContain('The server still has an operation running')
  })
})

describe('A server-side operation this page is not waiting for', () => {
  it('reports it and offers cancellation (the reloaded-page case)', async () => {
    // The page reloaded while an operation was still running: point `/status` at
    // a busy server BEFORE mounting, exactly as the reloaded page finds it.
    // (No fake timers here: the status poll interval is created during mount.)
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/cancel')) return json({ ok: true, cancelled: true })
      if (url.includes('/status')) {
        return json({
          boot: 'test-boot', version: '0.1.1', channel: 'stable', region: 'global', profile: 'web',
          busy: true, progress: { active: true }, pnpm: { ok: true },
          restart: { allowed: false, debugger: false, scheduled: false }, installed: [],
        })
      }
      if (url.includes('/installed')) return json(INVENTORY)
      if (url.includes('/registry')) return json({ registry: { plugins: CATALOG, count: CATALOG.length } })
      if (url.includes('/updates')) return json([])
      return json({ ok: true })
    }) as typeof fetch

    const host = await mount()

    expect(host.textContent).toContain('The server still has an operation running')
    const cancel = [...host.querySelectorAll('button')]
      .find(button => (button.textContent ?? '').trim() === 'Cancel')
    expect(cancel).toBeDefined()

    cancel?.click()
    await flush()

    // The server owns the process, so it must be told …
    expect(calls.some(call => call.url.includes('/cancel') && call.method === 'POST')).toBe(true)
    // … and the click must say so instead of appearing to do nothing.
    expect(host.textContent).toContain('Cancellation requested')
  })
})

describe('Discover — official website links', () => {
  /**
   * The operator's own site hosts a page per plugin. The card links to it with
   * the catalog's stable key (`owner/name`), never with the display name: the
   * live catalog has 152 duplicated names, so a name-built link opens the wrong
   * plugin. Rows without a resolved site keep their other actions and simply
   * show no link.
   */
  async function mountWithSiteLinks(): Promise<HTMLElement> {
    // Install the stub BEFORE mounting: the catalog is fetched during the mount
    // effect, so an override afterwards would only affect later requests.
    installSiteLinkStub()
    return await mount()
  }

  function installSiteLinkStub(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/registry')) {
        const withLinks = CATALOG.map(plugin => plugin.name === 'dsh-worktable'
          ? { ...plugin, siteUrl: 'https://www.yhaigc.cn/#/ai/p/wt%2Fdsh-worktable' }
          : plugin)
        return json({ registry: { plugins: withLinks, count: withLinks.length } })
      }
      if (url.includes('/installed')) return json(INVENTORY)
      if (url.includes('/updates')) return json([])
      if (url.includes('/discovery-compatibility')) return json({ results: [] })
      if (url.includes('/status')) {
        return json({
          boot: 'test-boot', version: '0.1.1', channel: 'stable', region: 'global', profile: 'web',
          busy: false, progress: { active: false }, pnpm: { ok: true },
          restart: { allowed: false, debugger: false, scheduled: false }, installed: [],
        })
      }
      return json({ ok: true })
    }) as typeof fetch
  }

  it('renders a real link to the plugin page on the operator site', async () => {
    const host = await mountWithSiteLinks()
    await flush()

    const link = host.querySelector('a[href^="https://www.yhaigc.cn/#/ai/p/"]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    // A different document: it must stay an anchor that opens in a new tab.
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toContain('noreferrer')
  })

  it('shows no site link for rows the site does not publish', async () => {
    const host = await mountWithSiteLinks()
    await flush()
    // Only `dsh-worktable` carries a siteUrl in this fixture.
    expect(host.querySelectorAll('a[href^="https://www.yhaigc.cn/#/ai/p/"]').length).toBe(1)
  })

  it('does not turn a site link into a button (middle-click must work)', async () => {
    const host = await mountWithSiteLinks()
    await flush()
    const link = host.querySelector('a[href^="https://www.yhaigc.cn/#/ai/p/"]')
    expect(link?.tagName).toBe('A')
  })
})

describe('Discover — the recommended (未安装) view', () => {
  /**
   * 「未安装」= 官网算出的推荐榜，只显示前 `window` 条。
   *
   * 三条规则必须成立：顺序**完全按目录给的排名**（不在这里重排）、**跳过已安装**并从更长的
   * 列表里补位（所以装掉一个会自动补上下一个）、目录没带 ranking 时**退回原行为**。
   */
  const RANKING = ['alpha/dsh-one', 'beta/dsh-two', 'gamma/dsh-three', 'delta/dsh-four', 'epsilon/dsh-five']

  function catalogWithRanking(): unknown[] {
    return RANKING.map((key, index) => ({
      name: `${key.split('/')[1]}`,
      owner: key.split('/')[0],
      npm: `${key.split('/')[1]}`,
      url: `https://github.com/${key}`,
      category: 'memory',
      stars: 100 - index,
      band: index === 0 ? 'S' : 'A',
      score: 90 - index,
      scoreParts: { popularity: 20 - index, keywords: 10 },
      ...(index === 0 ? { pinReason: '生态里独一份的能力' } : {}),
    }))
  }

  function installRankingStub(installed: string[] = []): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/registry')) {
        return json({
          registry: {
            plugins: catalogWithRanking(),
            count: RANKING.length,
            ranking: { version: 'opc-ranking/1', window: 3, top: RANKING, pins: [{ key: 'alpha/dsh-one', reason: '生态里独一份的能力' }] },
          },
        })
      }
      if (url.includes('/installed')) {
        return json({ ...INVENTORY, installed: installed.map(name => ({ name, version: '1.0.0', spec: '^1.0.0', kind: 'npm' })) })
      }
      if (url.includes('/updates')) return json([])
      if (url.includes('/discovery-compatibility')) return json({ results: [] })
      if (url.includes('/status')) {
        return json({
          boot: 'test-boot', version: '0.1.1', channel: 'stable', region: 'global', profile: 'web',
          busy: false, progress: { active: false }, pnpm: { ok: true },
          restart: { allowed: false, debugger: false, scheduled: false }, installed: [],
        })
      }
      return json({ ok: true })
    }) as typeof fetch
  }

  it('renders exactly `window` cards, in the order the catalog published', async () => {
    installRankingStub()
    const host = await mount()
    clickChip(host, 'Installed')
    await flush()
    clickChip(host, 'Installed')
    // Switch to the 推荐 filter (the tab is labelled the same, the chip is scoped).
    clickChip(host, 'Recommended')
    await flush()

    const titles = cardTitles(host)
    expect(titles).toEqual(['dsh-one', 'dsh-two', 'dsh-three'])
  })

  it('names the ranking chip 「推荐」 and numbers the cards 1, 2, 3…', async () => {
    /*
     * The chip replaced 「未安装」: with a `ranking` block it renders the website's
     * recommendation list, so that is the word on it, and every card carries the
     * published position — the order on screen IS the rank.
     */
    installRankingStub()
    const host = await mount()
    await flush()

    const chips = [...host.querySelectorAll('[role="group"] button')].map(button => (button.textContent ?? '').trim())
    expect(chips).toContain('Recommended')
    expect(chips).not.toContain('Not installed')

    clickChip(host, 'Recommended')
    await flush()
    expect(host.textContent ?? '').toContain('#1')
    expect(host.textContent ?? '').toContain('#3')
    // 名次与卡片顺序一一对应：第 1 张卡就是 #1。
    const cards = [...host.querySelectorAll('article[aria-label]')]
    expect(cards[0]?.textContent ?? '').toContain('#1')
    expect(cards[1]?.textContent ?? '').toContain('#2')
  })

  it('skips installed plugins and fills the window from the longer list', async () => {
    installRankingStub(['dsh-one', 'dsh-two'])
    const host = await mount()
    await flush()
    clickChip(host, 'Recommended')
    await flush()

    // 前两条已安装 → 用第 3/4/5 条补位（名次也跟着重排，仍是 1、2、3）。
    expect(cardTitles(host)).toEqual(['dsh-three', 'dsh-four', 'dsh-five'])
    const first = host.querySelector('article[aria-label]')
    expect(first?.textContent ?? '').toContain('#1')
  })

  it('shows the band badge and the editor-pick reason', async () => {
    installRankingStub()
    const host = await mount()
    await flush()
    clickChip(host, 'Recommended')
    await flush()

    const text = host.textContent ?? ''
    expect(text).toContain('Ranked S · 90')
    expect(text).toContain('Editor’s pick')
    // 说明行告诉用户这只是前 N 条。
    expect(text).toContain('see All for the full catalog')
  })

  it('falls back to the plain listing (and the 「未安装」 label) without a ranking', async () => {
    // 默认 stub 的目录没有 ranking —— 这必须仍然给出完整的未安装列表。
    const host = await mount()
    await flush()
    // 没有推荐块就没有"名次"可显示，标签也要退回去，否则一个叫「推荐」的入口会列出全部几千条。
    const chips = [...host.querySelectorAll('[role="group"] button')].map(button => (button.textContent ?? '').trim())
    expect(chips).toContain('Not installed')
    expect(chips).not.toContain('Recommended')

    clickChip(host, 'Not installed')
    await flush()
    expect(cardTitles(host).length).toBeGreaterThan(3)
    expect(host.textContent ?? '').not.toContain('see All for the full catalog')
    // 不在推荐视图里就不印名次。
    expect(host.textContent ?? '').not.toContain('#1')
  })

  it('hides the sort control in the ranking view (its order is the published rank)', async () => {
    /*
     * `sort` is deliberately ignored while the ranking view is active (the order IS
     * `ranking.top`), so the control would be a knob that does nothing. It stays for
     * every other filter, where it does sort.
     */
    installRankingStub()
    const host = await mount()
    await flush()
    expect(host.querySelector('select')).not.toBeNull()

    clickChip(host, 'Recommended')
    await flush()
    expect(host.querySelector('select')).toBeNull()

    clickChip(host, 'All')
    await flush()
    expect(host.querySelector('select')).not.toBeNull()
  })
})

/** Change a `<select>` the way React notices: native setter, then a change event. */
function selectOption(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  setter?.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('Discover — the sort menu', () => {
  /**
   * 「推荐」 is a VIEW, not a sort: the panel deliberately offers no
   * "recommendation score" ordering (the score only ever appears on the badge and
   * in the hover explanation). This guards the decision against a well-meaning
   * re-addition — a dropdown entry there would compete with the chip that already
   * renders the published ranking.
   */
  const SCORED = [
    { key: 'a/aaa', name: 'aaa', owner: 'a', npm: 'aaa', url: 'https://github.com/a/aaa', category: 'dev', stars: 10, score: 70, band: 'A' },
    { key: 'b/bbb', name: 'bbb', owner: 'b', npm: 'bbb', url: 'https://github.com/b/bbb', category: 'dev', stars: 90, score: 90, band: 'S' },
    { key: 'c/ccc', name: 'ccc', owner: 'c', npm: 'ccc', url: 'https://github.com/c/ccc', category: 'dev', stars: 5, score: 70, band: 'A' },
  ]

  function installScoredStub(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/registry')) return json({ registry: { plugins: SCORED, count: SCORED.length } })
      if (url.includes('/installed')) return json(INVENTORY)
      if (url.includes('/updates')) return json([])
      if (url.includes('/discovery-compatibility')) return json({ results: [] })
      if (url.includes('/status')) {
        return json({
          boot: 'test-boot', version: '0.1.1', channel: 'stable', region: 'global', profile: 'web',
          busy: false, progress: { active: false }, pnpm: { ok: true },
          restart: { allowed: false, debugger: false, scheduled: false }, installed: [],
        })
      }
      return json({ ok: true })
    }) as typeof fetch
  }

  it('offers no recommendation entry: score is a badge, not an ordering', async () => {
    installScoredStub()
    const host = await mount()
    await flush()

    const select = host.querySelector('select') as HTMLSelectElement
    const values = [...select.options].map(entry => entry.value)
    expect(values).toEqual(['name-asc', 'name-desc', 'stars-desc', 'stars-asc', 'downloads-desc', 'downloads-asc', 'added-desc', 'added-asc'])
    expect([...select.options].map(entry => entry.textContent).join(' ')).not.toContain('score')

    // 分数仍然只出现在徽章上（这正是它该在的地方）。
    expect(host.textContent ?? '').toContain('Ranked S · 90')

    // 其余排序照常工作（删掉 score 分支后不能把菜单一起弄坏）。
    selectOption(select, 'stars-desc')
    await flush()
    expect(cardTitles(host)).toEqual(['bbb', 'aaa', 'ccc'])
  })
})

/** Type into a text input the way React notices: native setter, then `input`. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Discover — the label the website ships (displayName)', () => {
  /**
   * Monorepo entries are published as `repo#subpath`; the website ships the
   * readable label as `displayName` and the panel has to use it. Before this,
   * the rule lived only in the website's frontend, so "rename a plugin on the
   * website" never reached the panel.
   *
   * `name` stays raw: it is the identity (`key === owner/name`), the install spec
   * and the deep link — a label the website can restyle must not move those.
   */
  const ROWS = [
    { key: 'tt-a1i/archify#integrations/deepseek-harness', name: 'archify#integrations/deepseek-harness', displayName: 'archify integrations/deepseek-harness', owner: 'tt-a1i', npm: '@tt-a1i/archify-dsh', url: 'https://github.com/tt-a1i/archify', category: 'office', stars: 60032 },
    { key: 'j/v#packages/pkg', name: 'v#packages/pkg', owner: 'j', npm: 'pkg', url: 'https://github.com/j/v', category: 'dev', stars: 3 },
  ]

  function installStub(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/registry')) return json({ registry: { plugins: ROWS, count: ROWS.length } })
      if (url.includes('/installed')) return json(INVENTORY)
      if (url.includes('/updates')) return json([])
      if (url.includes('/discovery-compatibility')) return json({ results: [] })
      if (url.includes('/status')) {
        return json({
          boot: 'test-boot', version: '0.1.1', channel: 'stable', region: 'global', profile: 'web',
          busy: false, progress: { active: false }, pnpm: { ok: true },
          restart: { allowed: false, debugger: false, scheduled: false }, installed: [],
        })
      }
      return json({ ok: true })
    }) as typeof fetch
  }

  it('prints the shipped label, and falls back to `name` when the catalog has none', async () => {
    installStub()
    const host = await mount()
    await flush()
    expect(cardTitles(host)).toEqual(['archify integrations/deepseek-harness', 'v#packages/pkg'])
  })

  it('finds a row by the label the user reads, and by the raw name too', async () => {
    installStub()
    const host = await mount()
    await flush()
    const input = [...host.querySelectorAll('input')]
      .find(element => (element.getAttribute('aria-label') ?? '').startsWith('Search plugins')) as HTMLInputElement
    expect(input).toBeDefined()

    typeInto(input, 'archify integrations')
    await flush()
    expect(cardTitles(host)).toEqual(['archify integrations/deepseek-harness'])

    typeInto(input, 'archify#integrations')
    await flush()
    expect(cardTitles(host)).toEqual(['archify integrations/deepseek-harness'])
  })
})

describe('Discover — category labels follow the catalog', () => {
  /**
   * The site added a 「甄选」 category (slug `curated`, 8 plugins) and ships the
   * vocabulary as `categories: [{id,label,labelEn,count}]` while rows carry only
   * the slug. Cards used to print the slug, so a new category appeared as
   * `curated` and the site could not rename one without the panel disagreeing —
   * the same single-source-of-truth problem `displayName` had.
   */
  const ROWS = [
    { key: 'sumarilkkxx/dsh-atlas', name: 'dsh-atlas', displayName: 'dsh-atlas', owner: 'sumarilkkxx', category: 'curated', stars: 12, description: '地图式知识整理' },
    { key: 'alpha/dsh-legacy', name: 'dsh-legacy', owner: 'alpha', category: 'made-up', stars: 3, description: '旧分类' },
  ]
  const TABLE = [{ id: 'curated', label: '甄选', labelEn: 'Featured', count: 8 }]

  function installStub(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/registry')) return json({ registry: { plugins: ROWS, count: ROWS.length, categories: TABLE } })
      if (url.includes('/installed')) return json(INVENTORY)
      if (url.includes('/updates')) return json([])
      if (url.includes('/discovery-compatibility')) return json({ results: [] })
      if (url.includes('/status')) {
        return json({
          boot: 'test-boot', version: '0.1.1', channel: 'stable', region: 'global', profile: 'web',
          busy: false, progress: { active: false }, pnpm: { ok: true },
          restart: { allowed: false, debugger: false, scheduled: false }, installed: [],
        })
      }
      return json({ ok: true })
    }) as typeof fetch
  }

  async function mountIn(language: 'zh' | 'en'): Promise<HTMLElement> {
    installStub()
    const dictionary = language === 'en' ? en : zh
    const localeT = (key: string, params?: Record<string, string | number>): string => translate(dictionary, key, params)
    const container = document.getElementById('host') as HTMLElement
    root = createRoot(container)
    root.render(createElement(MarketSection, {
      t: localeT,
      locale: {
        register: () => undefined,
        bind: () => localeT,
        subscribe: () => () => undefined,
        getSnapshot: () => ({ active: language }),
      },
      theme: { getTheme: () => ({ id: 'dark' }), setTheme: () => undefined },
      themeStore: { subscribe: () => () => undefined, getSnapshot: () => ({ id: 'dark' }), getServerSnapshot: () => ({ id: 'dark' }) },
    }))
    await flush()
    return container
  }

  function card(host: HTMLElement, title: string): string {
    return host.querySelector(`article[aria-label="${title}"]`)?.textContent ?? ''
  }

  it('prints the published label in the active language', async () => {
    const host = await mountIn('zh')
    expect(card(host, 'dsh-atlas')).toContain('分类: 甄选')
    expect(card(host, 'dsh-atlas')).not.toContain('curated')
  })

  it('switches to the English label with the host locale', async () => {
    const host = await mountIn('en')
    expect(card(host, 'dsh-atlas')).toContain('Category: Featured')
  })

  it('keeps showing an unknown slug instead of blanking the badge', async () => {
    const host = await mountIn('zh')
    expect(card(host, 'dsh-legacy')).toContain('分类: made-up')
  })

  it('finds the rows by the label the user reads', async () => {
    const host = await mountIn('zh')
    const input = [...host.querySelectorAll('input')]
      .find(element => (element.getAttribute('aria-label') ?? '').startsWith('搜索')) as HTMLInputElement
    expect(input).toBeDefined()
    typeInto(input, '甄选')
    await flush()
    expect(cardTitles(host)).toEqual(['dsh-atlas'])
  })
})

describe('Discover — the category selector browses the site vocabulary', () => {
  /**
   * The badge alone was not enough: 「甄选」 had to be *browsable*, and the option
   * list must come from the catalog (order and labels included) so a category the
   * site adds appears without a plugin release.
   */
  const ROWS = [
    { key: 'sumarilkkxx/dsh-atlas', name: 'dsh-atlas', owner: 'sumarilkkxx', category: 'curated', stars: 12, description: '地图式知识整理' },
    { key: 'alpha/dsh-spend', name: 'dsh-spend', owner: 'alpha', category: 'cost', stars: 9, description: '花销看板' },
    { key: 'beta/dsh-plain', name: 'dsh-plain', owner: 'beta', category: 'made-up', stars: 1 },
  ]
  const TABLE = [
    { id: 'curated', label: '甄选', labelEn: 'Featured', count: 3 },
    { id: 'cost', label: '费用与额度', labelEn: 'Cost', count: 1 },
  ]

  function installStub(withRanking = false): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/registry')) {
        return json({
          registry: {
            plugins: ROWS,
            count: ROWS.length,
            categories: TABLE,
            ...(withRanking
              ? { ranking: { version: 'opc-ranking/1', window: 20, top: ['alpha/dsh-spend'], pins: [] } }
              : {}),
          },
        })
      }
      if (url.includes('/installed')) return json(INVENTORY)
      if (url.includes('/updates')) return json([])
      if (url.includes('/discovery-compatibility')) return json({ results: [] })
      if (url.includes('/status')) {
        return json({
          boot: 'test-boot', version: '0.1.1', channel: 'stable', region: 'global', profile: 'web',
          busy: false, progress: { active: false }, pnpm: { ok: true },
          restart: { allowed: false, debugger: false, scheduled: false }, installed: [],
        })
      }
      return json({ ok: true })
    }) as typeof fetch
  }

  async function mountIn(language: 'zh' | 'en', withRanking = false): Promise<HTMLElement> {
    installStub(withRanking)
    const dictionary = language === 'en' ? en : zh
    const localeT = (key: string, params?: Record<string, string | number>): string => translate(dictionary, key, params)
    const container = document.getElementById('host') as HTMLElement
    root = createRoot(container)
    root.render(createElement(MarketSection, {
      t: localeT,
      locale: {
        register: () => undefined,
        bind: () => localeT,
        subscribe: () => () => undefined,
        getSnapshot: () => ({ active: language }),
      },
      theme: { getTheme: () => ({ id: 'dark' }), setTheme: () => undefined },
      themeStore: { subscribe: () => () => undefined, getSnapshot: () => ({ id: 'dark' }), getServerSnapshot: () => ({ id: 'dark' }) },
    }))
    await flush()
    return container
  }

  function categorySelect(host: HTMLElement, label: string): HTMLSelectElement {
    return host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
  }

  it('offers every published category, in the site order, with live counts', async () => {
    const host = await mountIn('zh')
    const select = categorySelect(host, '分类筛选')
    expect(select).toBeDefined()
    expect([...select.options].map(option => option.textContent)).toEqual(['全部分类', '甄选 (1)', '费用与额度 (1)'])
    expect(select.value).toBe('')
  })

  it('localizes the options with the host locale', async () => {
    const host = await mountIn('en')
    const select = categorySelect(host, 'Category filter')
    expect([...select.options].map(option => option.textContent)).toEqual(['All categories', 'Featured (1)', 'Cost (1)'])
  })

  it('shows only that category\'s plugins once selected', async () => {
    const host = await mountIn('zh')
    selectOption(categorySelect(host, '分类筛选'), 'curated')
    await flush()
    expect(cardTitles(host)).toEqual(['dsh-atlas'])
    // The row whose slug is not in the vocabulary is still reachable under 全部.
    selectOption(categorySelect(host, '分类筛选'), '')
    await flush()
    expect(cardTitles(host).length).toBe(3)
  })

  it('composes with the search box', async () => {
    const host = await mountIn('zh')
    selectOption(categorySelect(host, '分类筛选'), 'curated')
    await flush()
    const input = [...host.querySelectorAll('input')]
      .find(element => (element.getAttribute('aria-label') ?? '').startsWith('搜索')) as HTMLInputElement
    typeInto(input, '花销')
    await flush()
    expect(cardTitles(host)).toEqual([])
  })

  it('explains an empty category instead of looking broken', async () => {
    // 「推荐」 is the fixed ranking (one scored row); the curated row is not on it,
    // so the combination is honestly empty and the hint says how to see it.
    const host = await mountIn('zh', true)
    clickChip(host, '推荐')
    await flush()
    selectOption(categorySelect(host, '分类筛选'), 'curated')
    await flush()
    expect(cardTitles(host)).toEqual([])
    expect(host.textContent).toContain('该分类下没有可显示的条目')
    expect(host.textContent).toContain('切到「全部」')
  })
})
