/**
 * Host icons, resolved at RUNTIME instead of at build time.
 *
 * The host renamed its whole icon set between 0.1.5-rc.2 and 0.2.1-alpha.1:
 * rc.2 named a glyph by its SIZE (`IconSearchOutline16`, `IconRefreshOutline14`)
 * while 0.2.x names it by its WEIGHT (`IconSearchOutlineRegular` / `…Medium`) and
 * dropped every old name — verified in both directions, there is no alias.
 *
 * A named import of a missing export is `undefined` (the module is an external
 * resolved from the loader table), and the section's primitive guard then skips
 * registration entirely: on 0.2.x the whole panel would be absent because three
 * icons moved. So this module reads the injected module object and picks
 * whichever spelling the running host actually provides — one artifact serves
 * both host generations.
 *
 * `primitives.d.ts` declares both spellings, so the build compiles against
 * either; nothing here may be a static named import of an icon.
 */

import type { ReactElement } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

/** The prop shape every host icon accepts. */
export interface HostIconProps {
  /** Square edge in px; the host glyph defaults to its own drawn size. */
  size?: number
  className?: string
}

/** A host icon component, or a stub that draws nothing. */
export type HostIcon = (props: HostIconProps) => ReactElement | null

/**
 * Alternative names for the icons this bundle uses, newest spelling first.
 *
 * Exported because the section guard has to accept ANY of them: requiring the
 * 0.2.x name would disable the panel on rc.2 and the other way round.
 */
export const ICON_ALTERNATIVES = [
  ['IconSearchOutlineRegular', 'IconSearchOutline16'],
  // The refresh glyph was drawn at 14 and 16 in rc.2; either one serves.
  ['IconRefreshOutlineRegular', 'IconRefreshOutline14', 'IconRefreshOutline16'],
  ['IconSparkleRegular', 'IconSparkle16'],
] as const satisfies ReadonlyArray<readonly string[]>

/**
 * First name in `names` the module actually provides as a function.
 *
 * Pure on purpose: the resolution rule is the part worth testing, and it can be
 * tested with a hand-made module object instead of the running host.
 */
export function resolveIcon(mod: Record<string, unknown>, names: readonly string[]): HostIcon | undefined {
  for (const name of names) {
    const candidate = mod[name]
    if (typeof candidate === 'function') return candidate as HostIcon
  }
  return undefined
}

/** Drawn when no spelling exists; the section guard keeps that path unreachable. */
const absent: HostIcon = () => null

const host = primitives as unknown as Record<string, unknown>

/** Search glyph (the toolbar's search box). */
export const IconSearch = resolveIcon(host, ICON_ALTERNATIVES[0]) ?? absent
/** Refresh glyph (reload buttons). */
export const IconRefresh = resolveIcon(host, ICON_ALTERNATIVES[1]) ?? absent
/** Sparkle glyph (the install toast). */
export const IconSparkle = resolveIcon(host, ICON_ALTERNATIVES[2]) ?? absent
