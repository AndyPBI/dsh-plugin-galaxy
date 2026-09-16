/**
 * Ambient declarations for the Plugin Galaxy browser bundle.
 *
 * `window.__DSH_BOOT__` is what the host page writes before the loader evaluates
 * bundle-layer plugins; the client only ever reads it (e.g. to tell whether this
 * bundle was injected as an entry) and never writes it.
 */

/** CSS Modules: the tsdown plugin returns the hashed class map as default. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

interface Window {
  /** Boot manifest written by the host page for bundle-layer plugins. */
  __DSH_BOOT__?: {
    entries?: Array<{ id: string }>
  }
}
