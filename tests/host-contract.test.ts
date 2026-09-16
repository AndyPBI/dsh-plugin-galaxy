/**
 * Host-contract guards.
 *
 * Two bug classes that unit tests could not see and that only surface on a real
 * host, both of which have already shipped once:
 *
 *  1. **Invented CLI flags.** `dsh plugin` forwards the REST of its arguments to
 *     pnpm, so a flag the CLI does not define is not rejected at the CLI — it
 *     reaches pnpm and fails with `Unknown option: '…'`. The market's runner
 *     used to append `--profile-dir`, which is not one of the CLI's options.
 *
 *  2. **Alias tokens the host does not define.** CSS custom properties fail
 *     SILENTLY: an unknown `--dsw-alias-*` name falls through to the next
 *     fallback, which was a light-theme literal — so the error banner and the
 *     state badges kept a pink/cream wash in dark mode and stopped matching the
 *     rest of the plugin. The host defines `state-error-primary`,
 *     `state-warn-*`, `state-success-*` and `bg-layer-*`; it does NOT define a
 *     `bg-error` / `label-error` / `border-error` / `fill-*` family.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { pluginCommandArgs } from '../src/domain/dsh-cli.ts'

/* ------------------------------------------------------------------ *
 * 1. CLI argv only carries flags the CLI defines
 * ------------------------------------------------------------------ */

describe('dsh CLI argv', () => {
  it('passes the profile and the forwarded arguments, nothing else', () => {
    expect(pluginCommandArgs('web', ['remove', 'dsh-plugin-x']))
      .toEqual(['plugin', '--profile', 'web', 'remove', 'dsh-plugin-x'])
  })

  it('never appends the removed --profile-dir selector', () => {
    const argv = pluginCommandArgs('web', ['add', 'pkg@latest'])
    expect(argv).not.toContain('--profile-dir')
    // `dsh plugin` has exactly one option this plugin may pass; anything else
    // would be forwarded to pnpm (`dsh plugin` takes only its own flags).
    const flags = argv.filter(token => token.startsWith('--'))
    expect(flags).toEqual(['--profile'])
  })

  it('keeps subcommand arguments in order after the profile', () => {
    const argv = pluginCommandArgs('custom', ['add', '-w', 'pkg@1.2.3'])
    expect(argv.slice(3)).toEqual(['add', '-w', 'pkg@1.2.3'])
  })
})

/* ------------------------------------------------------------------ *
 * 2. Every alias token the stylesheet uses exists on the host
 * ------------------------------------------------------------------ */

/**
 * The `--dsw-alias-*` names this plugin is allowed to reference.
 *
 * Verified against the host's own token sheet
 * (`packages/client/ui-theme/src/styles/design-platform.css` of
 * deepseek-harness 0.1.5-alpha.1). Adding a name here means verifying it there
 * first — that is the whole point of the list.
 */
const HOST_ALIASES = new Set([
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-brand-primary',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
])

const cssPath = fileURLToPath(new URL('../src/client/Galaxy.module.css', import.meta.url))
const cssSource = readFileSync(cssPath, 'utf8')
/** Comments are explanatory prose, not declarations: strip them before scanning. */
const cssRules = cssSource.replace(/\/\*[\s\S]*?\*\//g, '')

describe('stylesheet tokens', () => {
  it('references only alias tokens the host actually defines', () => {
    const used = [...new Set(cssRules.match(/--dsw-alias-[a-z0-9-]+/g) ?? [])]
    const unknown = used.filter(token => !HOST_ALIASES.has(token))
    // A failing name falls back silently to a literal, which is how the error
    // banner lost its theme colours; keep this list exact.
    expect(unknown).toEqual([])
    expect(used.length).toBeGreaterThan(0)
  })

  it('keeps state colours free of the absent bg-error / label-error family', () => {
    for (const absent of [
      '--dsw-alias-bg-error', '--dsw-alias-label-error', '--dsw-alias-border-error',
      '--dsw-alias-bg-warning', '--dsw-alias-label-warning', '--dsw-alias-border-warning',
      '--dsw-alias-bg-success', '--dsw-alias-label-success',
      '--dsw-alias-state-danger',
    ]) {
      expect(cssRules).not.toContain(absent)
    }
  })

  it('paints the error surface with a neutral layer plus the error accent', () => {
    // Anchor on a rule that STARTS with the selector: the shared
    // `.banner,.bannerInfo,.bannerWarn,.bannerError{…}` rule also contains the
    // text `.bannerError{` and must not be mistaken for the override.
    const banner = /(?:^|\n)\.bannerError\{([^}]*)\}/.exec(cssRules)
    expect(banner).not.toBeNull()
    const body = banner?.[1] ?? ''
    // Neutral surface (theme-aware) …
    expect(body).toContain('--dsw-alias-bg-layer-2')
    // … with the real error accent for border and text.
    expect(body).toContain('--dsw-alias-state-error-primary')
  })
})

/* ------------------------------------------------------------------ *
 * 3. Hot mount never claims a success the host cannot deliver
 * ------------------------------------------------------------------ */

describe('hot mount', () => {
  it('refuses and asks for a restart instead of reporting a live plugin', async () => {
    const { mkdirSync, mkdtempSync, readdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { hotMount } = await import('../src/domain/hot.ts')

    const dir = mkdtempSync(join(tmpdir(), 'galaxy-hot-'))
    const pkg = join(dir, 'node_modules', 'demo-plugin')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
      name: 'demo-plugin',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(pkg, 'cordis.patch.yml'), "- insert:\n    - id: demo\n      name: 'demo-plugin'\n")

    // Only `dir` is touched by hotMount; hotMounts is read by the listing APIs.
    const runtime = { dir, hotMounts: new Map() } as unknown as Parameters<typeof hotMount>[0]
    const result = hotMount(runtime, 'web', 'demo-plugin')

    // Nothing in this build can make the plugin live in the running process, so
    // claiming success would leave the UI silent while the plugin waits for the
    // next boot — the "installed it and nothing happened" report.
    expect(result.ok).toBe(false)
    expect(result.reason ?? '').toContain('restart')
    // And it must not leave a hot input file behind either: the host never reads
    // it, and a stale one only invites confusion.
    const galaxyDir = join(dir, '.dsh-galaxy')
    let entries: string[] = []
    try {
      entries = readdirSync(galaxyDir)
    } catch {
      entries = []
    }
    expect(entries.filter(name => name.startsWith('hot-'))).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * 4. An install the host cannot activate must ask for a restart
 * ------------------------------------------------------------------ */

describe('install reporting', () => {
  it('returns needsRestart (and hot:false) when the package cannot go live', async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { configureInstall, installPlugin } = await import('../src/domain/install.ts')
    const { hotMount } = await import('../src/domain/hot.ts')

    const dir = mkdtempSync(join(tmpdir(), 'galaxy-install-'))
    const profileDir = join(dir, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { '@deepseek-ai/dsh-base': '1.0.0' },
    }))

    const registry = { plugins: [{ name: 'demo-plugin', npm: 'demo-plugin' }] }
    const caches = new Map<string, unknown>()
    const runtime = {
      dir: profileDir,
      config: { profile: 'web', profileDirectory: profileDir, maxSnapshots: 20 },
      // A runner that behaves like pnpm: it materializes the package, which the
      // fake-success guard then reads back from disk.
      runner: async () => {
        const installed = join(profileDir, 'node_modules', 'demo-plugin')
        mkdirSync(installed, { recursive: true })
        writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }))
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false }
      },
      cache: (key: string) => caches.get(key),
      setCache: (key: string, value: unknown) => { caches.set(key, value) },
      hotMounts: new Map(),
    }

    configureInstall(runtime as never, {
      loadRegistry: async () => registry as never,
      installTargetFor: () => 'demo-plugin',
      validateAddedPlugins: () => ({
        ok: true,
        problems: [],
        added: [{ name: 'demo-plugin', version: '1.0.0' }],
        // `keep` non-empty: the flow refuses a clean exit that installed nothing
        // loadable, so an empty keep would fail the install itself.
        keep: ['demo-plugin'],
        removedBroken: [],
        conflicts: [],
      }),
      // The real hotMount refuses in this build; assert the wiring end to end.
      hotMount,
    } as never)

    const result = await installPlugin('web', profileDir, 'demo-plugin', runtime as never, {
      registry: registry as never,
    })

    expect(result.ok).toBe(true)
    // A plugin that is only waiting for the next boot must say so: reporting
    // `hot` here is what left the operator with "installed, nothing happened".
    expect(result.hot).toBe(false)
    expect(result.needsRestart).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * 3. Layout rules that the panel's two visual bugs depend on
 * ------------------------------------------------------------------ */

/**
 * The host `Button` primitive is `display:inline-flex` with no
 * `white-space:nowrap` and no `min-width:0`. Inside a constrained flex row it
 * therefore shrinks to its min-content width — ONE Chinese character — and
 * wraps its label one glyph per line: the label reads VERTICALLY where the row
 * should read horizontally. That is what happened to the restart banner's
 * "关闭" button, and to every action button in the "已安装 → 列表" row once the
 * badge line claimed its full intrinsic width.
 *
 * These assertions pin the rules that prevent it. They are static on purpose:
 * `scripts/layout-check.mjs` measures the same behaviour in real Chrome
 * (line-box counts and overflow), but Chrome is not always available, so the
 * contract lives here too; `npm run check:layout` measures it in a real browser.
 */
describe('panel layout contracts', () => {
  /** Declarations of the rule that STARTS with `selector`, comments stripped. */
  function ruleBody(selector: string): string {
    const pattern = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*')}\\{([^}]*)\\}`)
    const match = pattern.exec(cssRules)
    expect(match, `no rule found for ${selector}`).not.toBeNull()
    return match?.[1] ?? ''
  }

  it('never lets a host button be squeezed below its label', () => {
    // One rule covers every button that is a direct child of our flex rows.
    const guard = ruleBody('.row > button,.listRow > button,.banner > button,.cardActions > button,.actions > button,.cardHead > button')
    expect(guard).toContain('white-space:nowrap')
    // `flex:none` / `flex:0 0 auto` both mean "do not shrink"; assert the
    // computed intent rather than one spelling.
    expect(guard).toMatch(/flex:(none|0 0 auto)/)
  })

  it('makes the banner text yield instead of the banner control', () => {
    // `flex:1 1 0` gives the sentence the leftover space; with `auto` the
    // control absorbs the negative free space and its label goes vertical.
    expect(ruleBody('.banner > .stack')).toContain('flex:1 1 0')
  })

  it('lets the installed list row wrap and its info block shrink', () => {
    const row = ruleBody('.listRow')
    expect(row).toContain('flex-wrap:wrap')
    const info = ruleBody('.listRow > .stack')
    expect(info).toContain('min-width:0')
    // A badge line whose badges are all `nowrap` must be allowed to wrap.
    expect(ruleBody('.listRow .row')).toContain('flex-wrap:wrap')
  })

  it('lets the action GROUP shrink while the buttons inside it do not', () => {
    // `flex:0 0 auto` here kept the group at its max-content width and pushed
    // the row 82px past the panel edge (measured by the Chrome probe).
    const group = ruleBody('.listActions')
    expect(group).toContain('flex:0 1 auto')
    expect(group).not.toContain('flex:0 0 auto')
  })
})

/* ------------------------------------------------------------------ *
 * 4. Host contracts that were RENAMED or REMOVED in 0.1.5-rc.2
 * ------------------------------------------------------------------ */

/**
 * The rc.2 client surface moved two things this plugin must never reach for:
 *
 *  - the `conversation` slot became the `conversation` KEY of the new `main`
 *    slot (`slot-catalog.ts`, +411 lines in rc.2);
 *  - the `DocumentFileIcon` primitive was replaced by `FileTypeIcon`.
 *
 * Neither is used today, and this keeps it that way: the failure mode of a
 * stale host contract is not a build error — a slot name is a string, so a
 * removed one simply never renders, and a removed primitive only crashes when a
 * render path happens to touch it.
 */
describe('rc.2 host-contract migrations', () => {
  const clientRoot = fileURLToPath(new URL('../src/client/', import.meta.url))

  /** Every `.ts`/`.tsx` file of the client bundle. */
  function clientSources(): Array<{ path: string; text: string }> {
    const files: Array<{ path: string; text: string }> = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.tsx?$/u.test(entry.name)) files.push({ path: full, text: readFileSync(full, 'utf8') })
      }
    }
    walk(clientRoot)
    return files
  }

  it('never references the slot that rc.2 moved into `main`', () => {
    for (const file of clientSources()) {
      // The slot catalogue's own spelling; `main.conversation` is the new home.
      expect(file.text, file.path).not.toMatch(/['"]conversation['"]/u)
    }
  })

  it('never references the primitive rc.2 renamed', () => {
    for (const file of clientSources()) {
      expect(file.text, file.path).not.toContain('DocumentFileIcon')
    }
  })
})
