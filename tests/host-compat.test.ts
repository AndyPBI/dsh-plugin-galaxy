/**
 * Cross-generation host compatibility (0.1.5-rc.2 ↔ 0.2.1-alpha.1).
 *
 * The two host generations differ in exactly two places this plugin touches:
 * every icon was renamed from a size suffix to a weight suffix (old names
 * removed, no aliases), and the plugin settings card's seat moved from
 * `settings.plugin.item` to `plugins.detail.section`. Both are resolved at
 * RUNTIME here, so one artifact serves both — these tests pin the resolution
 * rules and the guard that decides whether the section may register at all.
 */

import { describe, expect, it } from 'vitest'
import { ICON_ALTERNATIVES, resolveIcon } from '../src/client/icons.ts'
import { REQUIRED_PRIMITIVES, isOwnPluginSubject, missingPrimitives } from '../src/client/index.ts'
import { Config } from '../src/index.ts'

const icon = (name: string) => () => name

describe('icon resolution across host generations', () => {
  it('prefers the newest spelling when the host ships both', () => {
    const mod = { IconSearchOutlineRegular: icon('new'), IconSearchOutline16: icon('old') }
    expect(resolveIcon(mod, ICON_ALTERNATIVES[0])).toBe(mod.IconSearchOutlineRegular)
  })

  it('falls back to the size-suffixed name on rc.2 (which has no Regular spelling)', () => {
    const mod = { IconSearchOutline16: icon('old') }
    expect(resolveIcon(mod, ICON_ALTERNATIVES[0])).toBe(mod.IconSearchOutline16)
  })

  it('returns undefined when the host ships neither spelling', () => {
    expect(resolveIcon({}, ICON_ALTERNATIVES[0])).toBeUndefined()
  })

  it('ignores a name the host defines as a non-component', () => {
    // A host may export the name as something else (a string, a null placeholder);
    // treating it as a component would crash at render.
    const mod = { IconSearchOutlineRegular: null, IconSearchOutline16: icon('old') }
    expect(resolveIcon(mod, ICON_ALTERNATIVES[0])).toBe(mod.IconSearchOutline16)
  })

  it('lists the 0.2.x spelling first for every glyph', () => {
    expect(ICON_ALTERNATIVES.length).toBe(3)
    for (const group of ICON_ALTERNATIVES) {
      expect(group.length).toBeGreaterThanOrEqual(2)
      expect(group[0]).toMatch(/Regular$/u)
      expect(new Set(group).size).toBe(group.length)
    }
  })
})

describe('primitives guard', () => {
  const stable = Object.fromEntries(REQUIRED_PRIMITIVES.map(name => [name, icon(name)]))
  const icons = {
    IconSearchOutlineRegular: icon('search'),
    IconRefreshOutlineRegular: icon('refresh'),
    IconSparkleRegular: icon('sparkle'),
  }

  it('accepts the 0.2.x host', () => {
    expect(missingPrimitives({ ...stable, ...icons })).toEqual([])
  })

  it('accepts the rc.2 host', () => {
    expect(missingPrimitives({
      ...stable,
      IconSearchOutline16: icon('search'),
      IconRefreshOutline14: icon('refresh'),
      IconSparkle16: icon('sparkle'),
    })).toEqual([])
  })

  it('accepts one generation per glyph (no all-or-nothing requirement)', () => {
    expect(missingPrimitives({
      ...stable,
      IconSearchOutline16: icon('search'),
      IconRefreshOutlineRegular: icon('refresh'),
      IconSparkleRegular: icon('sparkle'),
    })).toEqual([])
  })

  it('reports an icon group as a group when neither spelling exists', () => {
    const gaps = missingPrimitives(stable)
    expect(gaps).toEqual([
      'IconSearchOutlineRegular | IconSearchOutline16',
      'IconRefreshOutlineRegular | IconRefreshOutline14 | IconRefreshOutline16',
      'IconSparkleRegular | IconSparkle16',
    ])
  })

  it('still reports a missing stable primitive by name', () => {
    expect(missingPrimitives({ ...icons })).toEqual(['Button', 'Input', 'Modal', 'Toast'])
  })

  it('keeps the explicit-required form working for callers that pass a list', () => {
    expect(missingPrimitives({ Button: icon('b') }, ['Button', 'Input'], [])).toEqual(['Input'])
  })
})

describe('plugin detail subject', () => {
  it('matches this plugin as a bundle and as a row', () => {
    expect(isOwnPluginSubject({ kind: 'bundle', pkg: { name: 'dsh-plugin-galaxy' } })).toBe(true)
    expect(isOwnPluginSubject({
      kind: 'row',
      pkg: { name: 'dsh-plugin-galaxy' },
      row: { rowId: 'galaxy', moduleName: 'x', enabled: true },
    })).toBe(true)
  })

  it('does not match another plugin, an official item, or junk', () => {
    expect(isOwnPluginSubject({ kind: 'bundle', pkg: { name: 'dsh-workvista' } })).toBe(false)
    expect(isOwnPluginSubject({ kind: 'item', id: 'dsh-plugin-galaxy' })).toBe(false)
    expect(isOwnPluginSubject({ kind: 'bundle' })).toBe(false)
    expect(isOwnPluginSubject(undefined)).toBe(false)
    expect(isOwnPluginSubject('dsh-plugin-galaxy')).toBe(false)
  })
})

/**
 * The cordis `Config` export, which is how 0.2.x gives a plugin a setting: the
 * host projects it into a form, so an entry without it loses `allowRestart`
 * silently when the settings-namespace seam disappears.
 */
describe('plugin config schema', () => {
  const validate = (value: unknown) => Config['~standard'].validate(value)

  it('declares Standard Schema v1', () => {
    expect(Config['~standard'].version).toBe(1)
    expect(typeof Config['~standard'].validate).toBe('function')
  })

  it('resolves an absent config to an empty object', () => {
    expect(validate(undefined)).toEqual({ value: {} })
  })

  it('passes the three known fields through', () => {
    expect(validate({ profile: 'web', allowRestart: true, maxSnapshots: 3 }))
      .toEqual({ value: { profile: 'web', allowRestart: true, maxSnapshots: 3 } })
  })

  it('rejects wrong types and non-finite numbers', () => {
    expect(Array.isArray((validate({ allowRestart: 'yes' }) as { issues?: unknown[] }).issues)).toBe(true)
    expect(Array.isArray((validate({ profile: 7 }) as { issues?: unknown[] }).issues)).toBe(true)
    expect(Array.isArray((validate({ maxSnapshots: Number.NaN }) as { issues?: unknown[] }).issues)).toBe(true)
    expect(Array.isArray(validate([1, 2]))).toBe(false)
    expect((validate([1, 2]) as { issues?: unknown[] }).issues?.length).toBe(1)
  })

  it('drops unknown keys rather than failing the entry load', () => {
    expect(validate({ nope: 1, profile: 'web' })).toEqual({ value: { profile: 'web' } })
  })
})
