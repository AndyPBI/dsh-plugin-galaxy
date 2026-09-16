/**
 * A stand-in for `@deepseek-ai/schemastery`, faithful for exactly the surface
 * the host settings service touches.
 *
 * The real package is an OPTIONAL peer dependency: it exists on a DSH host (the
 * settings service itself validates against it) but is deliberately not
 * installed in this workspace, so vitest aliases the specifier here instead.
 *
 * What must be faithful, because the host depends on it
 * (`packages/settings/settings/src/index.ts`):
 *
 *  - **A schema is CALLABLE.** The host resolves a namespace with
 *    `schema(mergeLayers(base, section))` — a registered value that is not a
 *    function throws `TypeError: schema is not a function` and the section
 *    silently never exists. This is the bug this stub exists to keep fixed.
 *  - **A schema has `toJSON()`**, used to describe namespaces to the settings
 *    UI.
 *  - **`default(value)`** supplies the value when the schema is called with
 *    `undefined`, which is how a schema default and the composition `base`
 *    layer interact.
 *
 * What is NOT reproduced: type coercion beyond a boolean check, secret
 * redaction, `intersect`/`union`, strictness rules and reference preservation.
 * None of them is reachable from `domain/settings.ts`.
 */

/** A schema call result: the resolved namespace value. */
type Dict = Record<string, unknown>

/** Callable schema instance, structurally identical to the real one. */
export interface StubSchema<T = unknown> {
  (data?: unknown, options?: unknown): T
  uid: number
  type: string
  meta: { default?: T }
  default(value: T): StubSchema<T>
  toJSON(): Dict
}

let uid = 0

/** Build a callable schema around one resolution rule. */
function makeSchema<T>(type: string, resolve: (data: unknown, fallback: T | undefined) => T, fallback?: T): StubSchema<T> {
  const schema = ((data?: unknown) => resolve(data, fallback)) as StubSchema<T>
  schema.uid = ++uid
  schema.type = type
  schema.meta = fallback === undefined ? {} : { default: fallback }
  schema.default = (value: T) => makeSchema(type, resolve, value)
  schema.toJSON = () => ({ type, uid: schema.uid, meta: schema.meta })
  return schema
}

/** `z.boolean()` */
function boolean(): StubSchema<boolean> {
  return makeSchema<boolean>('boolean', (data, fallback) => {
    if (typeof data === 'boolean') return data
    if (fallback !== undefined) return fallback
    throw new Error('Expected boolean')
  })
}

/**
 * `z.object(dict)`: declared keys are resolved through their own schema (so a
 * schema default applies when the key is absent), undeclared keys pass through
 * exactly as the merged layers supplied them.
 */
function object(dict: Dict): StubSchema<Dict> {
  const declared = Object.entries(dict) as Array<[string, StubSchema]>
  return makeSchema<Dict>('object', (data) => {
    const input = (data ?? {}) as Dict
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Expected object')
    const resolved: Dict = { ...input }
    for (const [key, schema] of declared) resolved[key] = schema(input[key])
    return resolved
  })
}

export default { boolean, object }
