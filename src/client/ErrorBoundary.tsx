/**
 * The last line of defence for the Plugin Galaxy section.
 *
 * The recovery panel is also the only place the export-log button is guaranteed
 * to exist.
 *
 * The whole section is one React tree: if a render throws, React unmounts it
 * and the user is left with an empty settings panel — including no button to
 * export the log that would explain why. Catching the error here keeps that
 * button reachable and turns a blank panel into something reportable.
 *
 * Deliberately not a retry loop: re-rendering the same broken tree would only
 * flicker between the crash and the recovery panel.
 */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import css from './Galaxy.module.css'

interface GalaxyErrorBoundaryProps {
  /** Optional so `createElement(Boundary, props, child)` type-checks. */
  children?: ReactNode
  /** Rendered next to the reload button; the export-log control belongs here. */
  actions?: ReactNode
  /** Localized strings, so this file keeps no copy of its own. */
  text: { title: string; hint: string; reload: string; details: string }
}

interface GalaxyErrorBoundaryState {
  error: Error | null
}

/**
 * The last crash this boundary caught, for the exported log: a crash the user
 * has already moved past is still the most useful line in their report.
 */
let lastCrash: { message: string; stack: string | null; at: string } | null = null

/** The crash to include in the exported log, or null when there was none. */
export function lastGalaxyCrash(): { message: string; stack: string | null; at: string } | null {
  return lastCrash
}

/** Testing seam: forget the recorded crash. */
export function forgetGalaxyCrash(): void {
  lastCrash = null
}

export class GalaxyErrorBoundary extends Component<GalaxyErrorBoundaryProps, GalaxyErrorBoundaryState> {
  state: GalaxyErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): GalaxyErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    lastCrash = {
      message: error.message,
      // React's component stack says WHERE, which the JS stack stops saying
      // once the bundle is minified.
      stack: info.componentStack ?? error.stack ?? null,
      at: new Date().toISOString(),
    }
    // Kept on the console too: a developer on a live page should not have to
    // export a file to see what this boundary swallowed.
    console.error('[dsh-plugin-galaxy] the galaxy UI crashed and was replaced by its recovery panel', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    const { text, actions } = this.props
    return (
      <div
        className={css.crash}
        // Marked like the real root so the exported log can tell "crashed"
        // apart from "never mounted".
        data-dsh-galaxy-root=""
        data-dsh-galaxy-crashed=""
        translate="no"
      >
        <div className={css.crashTitle}>{text.title}</div>
        <div className={css.crashHint}>{text.hint}</div>
        <div className={css.crashActions}>
          <button
            type="button"
            className={css.crashButton}
            onClick={() => {
              if (typeof location !== 'undefined') location.reload()
            }}
          >
            {text.reload}
          </button>
          {actions}
        </div>
        <details className={css.crashDetails}>
          <summary className={css.crashSummary}>{text.details}</summary>
          <pre className={css.crashPre}>{error.stack ?? error.message}</pre>
        </details>
      </div>
    )
  }
}
