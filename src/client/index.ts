/**
 * Plugin Galaxy client entry: registers the "Plugin Galaxy" settings section,
 * the plugin settings card, and the install toast in the shell overlay.
 *
 * EVENT-theme-change (the `themeStore` subscription below).
 *
 * Built by tsdown into the __ModuleLoader__ factory bundle at client/client.js;
 * the only externals are the loader module table's react entries and the host
 * ui-primitives module.
 */

import { createElement as h } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Galaxy.module.css'
import { en, NS, zh } from './locales.ts'
import { ICON_ALTERNATIVES } from './icons.ts'
import { InstallToast } from './InstallToast.tsx'
import { GalaxyErrorBoundary } from './ErrorBoundary.tsx'
import { MarketSection } from './MarketSection.tsx'
import { SettingsCard } from './SettingsCard.tsx'
import { exportGalaxyLog } from './self-check.ts'
import { themeStoreFrom } from './market-data.ts'
import type { Dict, ThemeSnapshot, Translate } from './market-data.ts'

export const name = 'dsh-plugin-galaxy'

// 'theme' is safe to require: ui-layout (mandatory in every web composition)
// already hard-depends on it. This cordis's object-form inject means intercept
// config, NOT {required,optional} — do not use it here.
export const inject = ['slots', 'locale', 'theme']

/**
 * Primitives this bundle actually dereferences.
 *
 * The primitives module is host-injected (external at build time) and resolves
 * on every host, but a named export it does not provide is `undefined` — the
 * bundle would throw at render time and blank the whole settings dialog.
 * Returning the gaps lets `apply()` skip registration instead, which degrades
 * to "Plugin Galaxy is absent" rather than "the settings dialog is broken".
 *
 * Derived from the built artifact (`client/client.js` accesses exactly these
 * members off the injected primitives module), not from a wish list: guarding a
 * name the bundle never touches would skip registration on a host that simply
 * trims its primitives surface, and the whole galaxy section would silently
 * disappear even though nothing needed the missing export.
 */
export const REQUIRED_PRIMITIVES = [
  'Button',
  'Input',
  'Modal',
  'Toast',
] as const

/**
 * Icons, each with every spelling the host has shipped for that glyph.
 *
 * 0.1.5-rc.2 named them by size (`IconSearchOutline16`), 0.2.1-alpha.1 by weight
 * (`IconSearchOutlineRegular`) and dropped the old names — requiring either
 * spelling alone would skip registration (and so hide the whole panel) on the
 * other host. Any one name per group is enough; `icons.ts` resolves which.
 */
export const REQUIRED_ICON_ALTERNATIVES = ICON_ALTERNATIVES

/**
 * Whether a 0.2.x plugin-detail page is about THIS plugin.
 *
 * The detail seat renders for every plugin's page, so an entry that does not
 * check the subject would put the galaxy's card (backup, WebDAV, self-uninstall)
 * on someone else's page. `kind: 'item'` addresses an official plugin by the id
 * its own seat chose — never ours, so it is not a match.
 */
export function isOwnPluginSubject(subject: unknown): boolean {
  if (typeof subject !== 'object' || subject === null) return false
  const candidate = subject as { kind?: unknown; pkg?: { name?: unknown } }
  if (candidate.kind !== 'bundle' && candidate.kind !== 'row') return false
  return candidate.pkg?.name === NS
}

export function missingPrimitives(
  mod: Record<string, unknown>,
  required: readonly string[] = REQUIRED_PRIMITIVES,
  alternatives: ReadonlyArray<readonly string[]> = REQUIRED_ICON_ALTERNATIVES,
): string[] {
  const gaps = required.filter(name => mod[name] === undefined)
  for (const group of alternatives) {
    if (!group.some(name => mod[name] !== undefined)) gaps.push(group.join(' | '))
  }
  return gaps
}

/** The host surface the settings card needs, present only on rc.7+. */
interface SettingsScopeHost {
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: Record<string, unknown>, render: () => unknown): unknown
  }
}

/** The subset of the theme service this plugin touches. */
interface ThemeService {
  getTheme(): ThemeSnapshot | null
  setTheme(id: string): void
}

/** The subset of the locale service this plugin touches. */
interface LocaleService {
  register(namespace: string, dicts: { zh: Dict; en: Dict }): unknown
  bind(namespace: string): Translate
  subscribe(callback: () => void): () => void
  getSnapshot(): { active: string }
}

/** The subset of the slots service this plugin touches. */
interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: () => unknown): unknown
}

/**
 * The client cordis context shape this plugin relies on (structural: the host
 * provides the real Context; typing only the touched surface keeps this
 * external package free of monorepo-internal type dependencies).
 */
interface GalaxyClientContext {
  effect(callback: () => unknown, label?: string): void
  on(event: string, callback: () => void): () => void
  inject(services: string[], callback: (scoped: unknown) => void): void
  locale: LocaleService
  slots: SlotsService
  theme: ThemeService
}

export function apply(ctx: GalaxyClientContext): void {
  // Older hosts resolve the primitives module but lack the rc.6 exports the
  // views render with. Skip registration (Plugin Galaxy is simply absent from
  // the settings list) rather than throwing mid-render. console.warn, never
  // throw: a missing primitive must not blank the settings dialog.
  const gaps = missingPrimitives(primitives as unknown as Record<string, unknown>)
  if (gaps.length > 0) {
    console.warn(
      '[dsh-plugin-galaxy] host ui-primitives missing ' + gaps.join(', ') +
      ' — Plugin Galaxy disabled (dsh web >= 0.1.0-rc.6 required)',
    )
    return
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-galaxy: dictionaries')
  const t = ctx.locale.bind(NS)

  // Cached snapshot identity: useSyncExternalStore re-renders until two reads
  // agree, so the store hands the views a stable object across changes of
  // nothing. Theme pushes come from the host's own event, per the contract.
  const themeStore = themeStoreFrom({
    getTheme: () => ctx.theme.getTheme(),
    setTheme: (id: string) => ctx.theme.setTheme(id),
    subscribe: (callback: () => void) => ctx.on('theme/change', callback),
  })

  // Kept so the removal flow can retire the galaxy's own nav entry the moment
  // the package is gone: leaving it in the left menu after self-uninstall is
  // the card claiming something the profile no longer agrees with.
  let retireSection: (() => void) | null = null

  ctx.slots.inject('settings.section', () => {
    const off = ctx.slots.register({
      name: 'settings.section',
      id: 'galaxy',
      order: 40,
      label: () => t('nav'),
      locale: NS,
      inject: () => ({ t }),
    }, (ownerProps: { preferredSubsectionId?: string } = {}) => h(GalaxyErrorBoundary, {
      // Wrapped at the registration point, so the boundary is OUTSIDE
      // everything the section renders — including its portalled layers.
      // A crash inside would otherwise unmount the whole tree and leave an
      // empty settings panel with no way to export the log.
      text: {
        title: t('crashTitle'),
        hint: t('crashHint'),
        reload: t('crashReload'),
        details: t('crashDetails'),
      },
      actions: h('button', {
        type: 'button',
        className: css.crashButton,
        onClick: () => { void exportGalaxyLog().catch(() => {}) },
      }, t('exportLog')),
    }, h(MarketSection, {
      t,
      locale: ctx.locale,
      theme: ctx.theme,
      themeStore,
      preferredSubsectionId: ownerProps.preferredSubsectionId,
    })))
    if (typeof off === 'function') retireSection = off as () => void
    return off
  })

  // The settings card (dsh >= 0.1.0-rc.7). Registered through a NESTED inject
  // on purpose: naming settingsScope in the module-level `inject` would keep
  // the whole plugin unmounted on any host without that service — the galaxy's
  // own page would vanish on rc.6 to gain a card rc.6 cannot render. Nested,
  // the card simply never appears there.
  const settingsCtx = ctx as unknown as {
    inject(services: string[], callback: (scoped: SettingsScopeHost) => void): void
  }
  settingsCtx.inject(['settingsScope'], (scoped) => {
    scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
      name: 'settings.plugin.item',
      key: NS,
      locale: NS,
      inject: () => ({ t }),
    }, () => h(SettingsCard, {
      t,
      onRemoved: () => {
        const off = retireSection
        retireSection = null
        off?.()
      },
    })))
  })

  // The same card on 0.2.x, where `settings.plugin.item` no longer exists: the
  // plugins page renders contributions to a detail page's own content and each
  // entry decides from the subject whether it has anything to say. `slots.inject`
  // is the gate — the seat is declared by ui-plugin-manager at runtime, and
  // registering an undeclared slot throws, so on rc.2 this callback simply never
  // runs (the card stays reachable through the seat above).
  ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
    name: 'plugins.detail.section',
    id: 'galaxy',
    order: 50,
    label: () => t('nav'),
  }, (ownerProps: { subject?: unknown } = {}) => (isOwnPluginSubject(ownerProps.subject)
    ? h(SettingsCard, {
      t,
      onRemoved: () => {
        const off = retireSection
        retireSection = null
        off?.()
      },
    })
    : null)))

  const ToastHost = () => h(InstallToast, { t })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-plugin-galaxy-toast',
    label: () => NS,
  }, ToastHost))
}
