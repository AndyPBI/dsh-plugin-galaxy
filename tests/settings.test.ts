/**
 * Settings-namespace contract guards.
 *
 * The defect these tests keep fixed: the galaxy's own namespace used to be
 * registered with a **plain descriptor object** — `{ allowRestart: { type:
 * 'boolean', default: false } }`. The host does not read such an object; it
 * CALLS the registered value (`schema(mergeLayers(base, section))`) and also
 * serializes it with `schema.toJSON()` for the settings UI. The registration
 * therefore threw `TypeError: schema is not a function`, was swallowed by the
 * graceful-degradation catch, and the switch simply never appeared on the
 * plugin configuration page — a silent failure whose only trace was one warning
 * line in the host log.
 *
 * `@deepseek-ai/schemastery` is what makes a schema callable. It is an optional
 * peer dependency that is not installed in this workspace, so vitest aliases
 * the specifier to `tests/stubs/schemastery.ts` (see `vitest.config.ts`) and the
 * fake settings service below reproduces the host's registration contract,
 * including its error messages.
 */

import { describe, expect, it, vi } from 'vitest'

import { GALAXY_SETTINGS_NS, installGalaxySettings } from '../src/domain/settings.ts'

/** One registration, plus the value the host would have resolved at that point. */
interface Registration {
  schema: ((data?: unknown) => unknown) & { toJSON?: () => unknown; uid?: number; type?: string }
  base: { allowRestart?: boolean }
  value: unknown
  watchers: Set<() => void>
}

/**
 * The smallest faithful settings service: it enforces the host's registration
 * contract (`typeof schema === 'function'`, `schema.toJSON` present, call the
 * schema with the merged layers to resolve the section) and exposes `push` so a
 * test can imitate a settings change arriving from the UI.
 */
function settingsService() {
  const registrations = new Map<string, Registration>()
  return {
    registrations,
    register(namespace: string, schema: Registration['schema'], options: { base: Registration['base'] }): unknown {
      // Errors below are the host's own (packages/settings/settings/src/index.ts).
      if (typeof schema !== 'function') throw new TypeError('schema is not a function')
      if (typeof schema.toJSON !== 'function') throw new TypeError('schema.toJSON is not a function')
      if (registrations.has(namespace)) throw new Error(`settings namespace "${namespace}" is already registered`)
      const registration: Registration = {
        schema,
        base: options?.base ?? {},
        value: schema(options?.base),
        watchers: new Set(),
      }
      registrations.set(namespace, registration)
      return {
        get: () => registration.value,
        watch: (listener: () => void) => { registration.watchers.add(listener) },
      }
    },
    /** Imitate a user-layer change landing on the namespace. */
    push(namespace: string, value: unknown): void {
      const registration = registrations.get(namespace)
      if (registration === undefined) throw new Error(`not registered: ${namespace}`)
      registration.value = value
      for (const listener of registration.watchers) listener()
    },
  }
}

/** A context whose `inject` resolves immediately, as cordis does once satisfied. */
function contextFor(service: unknown, options: { withInject?: boolean } = {}) {
  const cleanups: Array<() => void> = []
  const context: Record<string, unknown> = {
    get: () => service,
    effect: (callback: () => () => void) => { cleanups.push(callback()) },
  }
  if (options.withInject !== false) {
    context.inject = (_dependencies: string[], callback: (scoped: unknown) => void) => callback({ settings: service })
  }
  return { context, cleanups }
}

/** Wait until the fire-and-forget wiring has reached the service. */
async function waitForRegistration(service: ReturnType<typeof settingsService>): Promise<Registration> {
  await vi.waitFor(() => { expect(service.registrations.size).toBe(1) })
  const registration = service.registrations.get(GALAXY_SETTINGS_NS)
  if (registration === undefined) throw new Error('not registered')
  return registration
}

describe('galaxy settings namespace', () => {
  it('registers a schema the host can CALL, not a descriptor object', async () => {
    const service = settingsService()
    const config: { allowRestart?: boolean } = {}
    installGalaxySettings(contextFor(service).context, config)

    const { schema } = await waitForRegistration(service)
    expect(typeof schema).toBe('function')
    // The host resolves the namespace by calling the schema; this is the line
    // that used to throw `schema is not a function`.
    expect(schema({ allowRestart: true })).toMatchObject({ allowRestart: true })
    // ...and describes it to the settings UI by serializing it.
    expect(typeof schema.toJSON).toBe('function')
    expect(schema.toJSON()).toMatchObject({ type: 'object' })
  })

  it('pins the host contract the descriptor object violated', () => {
    const service = settingsService()
    const descriptor = { allowRestart: { type: 'boolean', default: false } }
    expect(() => service.register(GALAXY_SETTINGS_NS, descriptor as never, { base: {} }))
      .toThrow(/schema is not a function/)
  })

  it('carries the supervisor-aware composed value as the base layer', async () => {
    const service = settingsService()
    // Explicit `false` is how a supervised host opts out; `restartAllowed`
    // returns it unchanged, so the assertion does not depend on the test
    // machine's environment.
    const config: { allowRestart?: boolean } = { allowRestart: false }
    installGalaxySettings(contextFor(service).context, config)

    const registration = await waitForRegistration(service)
    expect(registration.base.allowRestart).toBe(false)
    expect(config.allowRestart).toBe(false)
  })

  it('writes a settings change back into the live config, without a restart', async () => {
    const service = settingsService()
    const config: { allowRestart?: boolean } = { allowRestart: false }
    installGalaxySettings(contextFor(service).context, config)
    await waitForRegistration(service)

    service.push(GALAXY_SETTINGS_NS, { allowRestart: true })

    // The routes read `config.allowRestart` per request, so this assignment is
    // what makes the switch effective immediately.
    expect(config.allowRestart).toBe(true)
  })

  it('falls back to the composed value when the section is disposed', async () => {
    const service = settingsService()
    const config: { allowRestart?: boolean } = { allowRestart: false }
    const { context, cleanups } = contextFor(service)
    installGalaxySettings(context, config)
    await waitForRegistration(service)
    expect(cleanups).toHaveLength(1)

    service.push(GALAXY_SETTINGS_NS, { allowRestart: true })
    expect(config.allowRestart).toBe(true)

    // A section nobody can see or change any more must not keep steering.
    for (const cleanup of cleanups) cleanup()
    expect(config.allowRestart).toBe(false)
  })

  it('never throws when the settings service refuses the registration', async () => {
    const rejecting = {
      register: () => { throw new Error('registration refused') },
    }
    const config: { allowRestart?: boolean } = { allowRestart: false }
    expect(() => installGalaxySettings(contextFor(rejecting).context, config)).not.toThrow()
    // Give the fire-and-forget wiring a chance to fail before asserting.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(config.allowRestart).toBe(false)
  })

  it('wires through ctx.get when inject is unavailable', async () => {
    const service = settingsService()
    const config: { allowRestart?: boolean } = {}
    installGalaxySettings(contextFor(service, { withInject: false }).context, config)
    await waitForRegistration(service)
  })

  it('degrades to the composed value when the host has no settings service', async () => {
    const config: { allowRestart?: boolean } = { allowRestart: false }
    expect(() => installGalaxySettings(contextFor(undefined).context, config)).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(config.allowRestart).toBe(false)
  })
})
