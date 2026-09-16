/**
 * The galaxy's own settings namespace: the switch that makes `allowRestart`
 * a control on the plugin configuration page instead of a hand-written line
 * in `cordis.yml`.
 *
 * `allowRestart` exists because a host owned by systemd, launchd or pm2 must
 * NOT start a second copy of itself: the supervisor owns
 * restarts. Until the value is a switch, the only way to say so is editing
 * YAML in the right place with the right indentation, where one stray space
 * stops the profile booting.
 *
 * Two deliberate design points, both inherited from the reference and both
 * observable in production:
 *
 *  - **No import of `@deepseek-ai/dsh-settings`.** The package deleted its
 *    convenience exports once already, and a missing NAMED EXPORT is a
 *    SyntaxError at module evaluation — the host then exits 1. The host's
 *    settings SERVICE never changed, so the service is declared structurally
 *    here and reached through `ctx.inject`/`ctx.get`.
 *  - **Nothing else is exposed.** The release channel already lives in
 *    `state.json`; publishing it here as well made this namespace a second
 *    writer that overwrote the saved choice on every settings event.
 *  - **`@deepseek-ai/schemastery` is loaded LAZILY, only to build the
 *    schema.** A schema is not a descriptor: the host resolves a namespace by
 *    CALLING the schema (`schema(mergeLayers(base, section))`), so handing it
 *    a plain object fails the registration with `schema is not a function` and
 *    the section silently never appears. The factory is therefore imported
 *    dynamically inside the wiring, so a host that ships no such package
 *    degrades to "value stays as composed in `cordis.yml`" rather than to a
 *    failed plugin load.
 *
 */

import { logEvent } from '../core/log.ts'
import { restartAllowed } from './restart.ts'
import type { GalaxySchemaFactoryLike, GalaxySchemaLike } from '@deepseek-ai/schemastery'

/** Settings namespace the card on the browser side keys itself to. */
export const GALAXY_SETTINGS_NS = 'dsh-plugin-galaxy'

/** The only value this namespace owns. */
export interface GalaxySettings {
  allowRestart: boolean
}

/** Structural subset of the host's settings service. */
export interface SettingsServiceLike {
  register?: (ns: string, schema: unknown, options: { base: GalaxySettings }) => SettingsScopeLike
}

/** Scope returned by `register`; every member is optional and probed. */
export interface SettingsScopeLike {
  get?: () => Partial<GalaxySettings> | undefined
  watch?: (listener: () => void) => void
}

/**
 * Structural subset of the cordis context, so this module compiles without
 * the host's type packages. `inject` is the graceful-degradation boundary:
 * on a host with no settings service the callback never runs and the
 * composed entry configuration stands unchanged.
 */
interface SettingsContextLike {
  inject?: (deps: string[], callback: (scoped: unknown) => void) => void
  get?: (name: string) => unknown
  effect?: (callback: () => () => void) => void
}

/**
 * Load the schemastery factory, or `undefined` when the host has no such
 * package.
 *
 * Dynamic on purpose. A static import of a package that is absent is
 * `ERR_MODULE_NOT_FOUND` during module evaluation, which takes the whole
 * plugin down; the settings service this schema is FOR is itself optional, so
 * the dependency may only be demanded at the moment it is actually needed.
 *
 * Both module shapes are accepted because the package publishes dual entry
 * points (`import` -> `index.mjs`, `require` -> `index.cjs`): an ESM host hands
 * back a namespace whose `default` is the factory, while a CJS host hands back
 * the factory itself.
 */
async function loadSchemaFactory(): Promise<GalaxySchemaFactoryLike | undefined> {
  try {
    const module = (await import('@deepseek-ai/schemastery')) as { default?: unknown } | undefined
    const factory = (module?.default ?? module) as Partial<GalaxySchemaFactoryLike> | undefined
    if (typeof factory?.object !== 'function' || typeof factory.boolean !== 'function') {
      logEvent('warn', 'settings', `settings namespace ${GALAXY_SETTINGS_NS} skipped: schemastery has no object/boolean builder`)
      return undefined
    }
    return factory as GalaxySchemaFactoryLike
  } catch (error) {
    logEvent('warn', 'settings', `settings namespace ${GALAXY_SETTINGS_NS} skipped: schemastery is unavailable (${(error as Error).message})`)
    return undefined
  }
}

/**
 * The schema descriptor handed to the host settings service.
 *
 * It must be a REAL schemastery schema: the host validates and resolves a
 * namespace by calling the registered schema, and it also serializes it with
 * `toJSON()` for the configuration UI. A plain object literal satisfies
 * neither and makes `register` throw, which is why the factory is loaded
 * rather than imitated.
 *
 * The declared default is `true` — "a restart is allowed" is the plugin's own
 * opinion, and the composed `base` layer (which carries the supervisor-aware
 * `restartAllowed(config)` value) always overrides it for the resolved value.
 */
function galaxySchema(factory: GalaxySchemaFactoryLike): GalaxySchemaLike {
  return factory.object({ allowRestart: factory.boolean().default(true) })
}

/** Apply one settings snapshot back onto the live resolved config object. */
function makeApplier(config: { allowRestart?: boolean }): (next: Partial<GalaxySettings> | undefined) => void {
  return (next) => {
    if (next === undefined || typeof next.allowRestart !== 'boolean') return
    // Assigns ONLY the field this namespace owns.
    config.allowRestart = next.allowRestart
  }
}

/**
 * Register `dsh-plugin-galaxy.allowRestart` with the host settings service
 * and write the value back into the resolved config object the routes read.
 *
 * The routes read `allowRestart` off that object on every request (the status
 * route reports the capability, the restart route enforces it), so updating it
 * in place is what makes a toggle take effect WITHOUT a restart — which would
 * be a poor thing to require of a setting whose whole subject is restarting.
 *
 * Never throws. A host without a settings service, one whose service rejects
 * the registration, or a context that has already been disposed all leave the
 * composed entry configuration in force.
 *
 * @param ctx - the plugin context that owns the wiring.
 * @param config - the live resolved config object the routes read.
 */
export function installGalaxySettings(ctx: unknown, config: { allowRestart?: boolean }): void {
  try {
    const context = ctx as SettingsContextLike | null | undefined
    if (context === null || context === undefined || typeof context !== 'object') return
    // The switch must show what the routes will actually DO: under a detected
    // supervisor an unset value means OFF, because the supervisor owns
    // restarts. Asking `restartAllowed()` rather than re-deriving the rule
    // here keeps the switch and the button from drifting.
    const entry: GalaxySettings = { allowRestart: restartAllowed(config) }
    const apply = makeApplier(config)
    let read: () => Partial<GalaxySettings> | undefined = () => entry

    const wire = async (settings: unknown): Promise<void> => {
      const service = settings as SettingsServiceLike | undefined
      if (service === undefined || service === null || typeof service.register !== 'function') return
      const factory = await loadSchemaFactory()
      if (factory === undefined) return
      let scope: SettingsScopeLike
      try {
        scope = service.register(GALAXY_SETTINGS_NS, galaxySchema(factory), { base: entry })
      } catch (error) {
        logEvent('warn', 'settings', `settings namespace ${GALAXY_SETTINGS_NS} could not be registered: ${(error as Error).message}`)
        return
      }
      if (scope !== null && typeof scope === 'object' && typeof scope.get === 'function') read = () => scope.get?.()
      // A disposed section must not leave the routes reading a value nobody
      // can see or change any more.
      try {
        context.effect?.(() => () => {
          read = () => entry
          apply(read())
        })
      } catch {
        // A context without `effect` simply keeps the scope's live value.
      }
      apply(read())
      try {
        scope.watch?.(() => { apply(read()) })
      } catch (error) {
        logEvent('warn', 'settings', `settings watcher could not be attached: ${(error as Error).message}`)
      }
    }

    /**
     * Start the wiring. Returns immediately; the only awaited step is the
     * lazily imported schema factory. Nothing in `wire` rejects, but the
     * `.catch` keeps a later edit from becoming an unhandled rejection on a
     * host whose boot must never depend on this module.
     */
    const start = (settings: unknown): void => {
      void wire(settings).catch((error: unknown) => {
        logEvent('warn', 'settings', `settings wiring skipped: ${(error as Error).message}`)
      })
    }

    if (typeof context.inject === 'function') {
      context.inject(['settings'], (scoped) => {
        const resolved = (scoped as { settings?: unknown } | undefined)?.settings
        start(resolved ?? (scoped as { settings?: unknown } | undefined))
      })
      return
    }
    if (typeof context.get === 'function') start(context.get('settings'))
  } catch (error) {
    // No code path in this module may prevent the host from booting.
    logEvent('warn', 'settings', `settings wiring skipped: ${(error as Error).message}`)
  }
}
