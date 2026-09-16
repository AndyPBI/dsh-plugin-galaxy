/**
 * Minimal structural declaration of `@deepseek-ai/schemastery`, the schema
 * package the host settings service validates a registered namespace against.
 *
 * The package is an OPTIONAL peer dependency (see `peerDependenciesMeta`) and
 * is deliberately not installed here, so a literal `import()` of it would be a
 * `TS2307` in this workspace. Declaring only the four members this plugin uses
 * keeps the plugin independent of the package's own version and of its type
 * layout — the same reason `settings.ts` declares the settings SERVICE
 * structurally instead of importing `@deepseek-ai/dsh-settings`.
 *
 * The shapes below are copied from `schemastery@3.18.2`
 * (`lib/types/index.d.ts`: `boolean()`, `object()`, and the callable
 * `Schemastery<S, T>` interface carrying `default()` and `toJSON()`).
 *
 * Delete this file if the package is ever added as a real `devDependency`:
 * the genuine declarations then take its place and the names here would be
 * redundant. (The names are prefixed so that even then they only add
 * interfaces rather than colliding with the package's own.)
 */
declare module '@deepseek-ai/schemastery' {
  /**
   * A callable schema instance. Callability is the whole point: the host
   * resolves a namespace by CALLING the schema, which is exactly what a plain
   * descriptor object cannot satisfy.
   */
  export interface GalaxySchemaLike<T = unknown> {
    (data?: unknown): T
    default(value: T): GalaxySchemaLike<T>
    toJSON(): GalaxySchemaLike<T>
  }

  /** The factory surface this plugin uses: two builders, nothing else. */
  export interface GalaxySchemaFactoryLike {
    boolean(): GalaxySchemaLike<boolean>
    object(dict: Record<string, unknown>): GalaxySchemaLike<Record<string, unknown>>
  }

  const z: GalaxySchemaFactoryLike
  export default z
}
