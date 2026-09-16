/**
 * Theme lifecycle — /
 * (for the galaxy itself).
 *
 * A theme is an installed plugin bundle that ships `dsh.client.theme` metadata
 * in its own `package.json`. Exactly one theme may be active at a time:
 * activating one deactivates every other installed theme through the user
 * patch layer (`cordis.patch.yml`) and the galaxy state's disabled list, and
 * the choice is recorded so it survives a restart.
 *
 * The active theme is derivable instead of authoritative: {@link activeTheme}
 * first honours the recorded choice, then falls back to the only installed
 * theme that is not disabled. That keeps the Themes tab honest when a user
 * toggles a theme from the installed list instead of from the tab.
 */

import { readJsonFile } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import { readInstalled } from '../core/profile.ts'
import { readGalaxyState, updateGalaxyState } from '../core/state.ts'
import type { ThemeInfo } from '../core/types.ts'
import { disableRow, enableRow, readUserPatchState, userPatchPath } from './patch.ts'

/** State key holding the user's explicit theme choice. */
const ACTIVE_THEME_KEY = 'theme.active'
/** State key holding the previously active theme. */
const PREVIOUS_THEME_KEY = 'theme.previous'

/** One installed theme bundle. */
export interface ThemeEntry extends ThemeInfo {
  /** Color/font swatch hint published by the bundle, when it has one. */
  swatch?: string
}

/** Deterministic fallback swatch, so every theme card has a color. */
function fallbackSwatch(name: string): string | undefined {
  const palette = ['#4f7cff', '#16a085', '#e67e22', '#9b59b6', '#e74c3c', '#2c3e50']
  if (name === '') return undefined
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 997
  return palette[hash % palette.length]
}

/** The `dsh.client.theme` declaration of an installed package. */
interface ThemeMetadata {
  /** True when the package carries a `dsh.client.theme` block. */
  declared: boolean
  description?: string
  swatch?: string
}

/** Read a package's theme metadata. */
function readThemeMetadata(dir: string, name: string): ThemeMetadata {
  const manifest = readJsonFile<{ dsh?: { client?: { theme?: unknown } } }>(
    `${dir}/node_modules/${name}/package.json`,
  )
  const theme = manifest?.dsh?.client?.theme
  if (theme === undefined || theme === null || theme === false) return { declared: false }
  if (typeof theme === 'string') return { declared: true, description: theme }
  if (typeof theme !== 'object' || Array.isArray(theme)) return { declared: true }
  const record = theme as Record<string, unknown>
  const description = typeof record.description === 'string' && record.description.trim() !== ''
    ? record.description
    : undefined
  const swatch = typeof record.swatch === 'string' && /^#[0-9a-f]{3,8}$/iu.test(record.swatch) ? record.swatch : undefined
  return {
    declared: true,
    ...(description === undefined ? {} : { description }),
    ...(swatch === undefined ? {} : { swatch }),
  }
}

/** Themes installed in this profile, in stable name order. */
export function installedThemes(profile: string, dir: string): ThemeEntry[] {
  const themes: ThemeEntry[] = []
  for (const name of Object.keys(readInstalled(profile, dir)).sort((left, right) => left.localeCompare(right))) {
    const metadata = readThemeMetadata(dir, name)
    if (!metadata.declared) continue
    const swatch = metadata.swatch ?? fallbackSwatch(name)
    themes.push({
      name,
      installed: true,
      active: false,
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
      ...(swatch === undefined ? {} : { swatch }),
    })
  }
  return themes
}

/** Names disabled through the state or the user patch layer. */
function disabledThemeNames(profile: string, dir: string): Set<string> {
  const disabled = new Set(readGalaxyState(dir).disabled ?? [])
  for (const row of readUserPatchState(profile, dir).rows) {
    if (row.disabled) disabled.add(row.name ?? row.id)
  }
  return disabled
}

/**
 * The active theme name, or undefined when no theme is installed or enabled.
 *
 * The recorded choice wins while it is still installed and enabled; otherwise
 * the only enabled installed theme is reported, so an external toggle cannot
 * leave the panel claiming a hidden theme is live.
 */
export function activeTheme(profile: string, dir: string): string | undefined {
  const themes = installedThemes(profile, dir)
  if (themes.length === 0) return undefined
  const disabled = disabledThemeNames(profile, dir)
  const recorded = readGalaxyState(dir).notes?.[ACTIVE_THEME_KEY]
  if (recorded !== undefined && themes.some(theme => theme.name === recorded) && !disabled.has(recorded)) {
    return recorded
  }
  const enabled = themes.filter(theme => !disabled.has(theme.name))
  return enabled.length === 1 ? enabled[0]!.name : undefined
}

/**
 * The installed themes with their activation state.
 * `active` is true for exactly the one live theme.
 */
export function listThemes(profile: string, dir: string): ThemeEntry[] {
  const active = activeTheme(profile, dir)
  return installedThemes(profile, dir).map(theme => ({ ...theme, active: theme.name === active }))
}

/**
 * Make `name` the one active theme: switch every other installed theme off,
 * switch the chosen one on, and record the choice.
 *
 * @returns false when `name` is not an installed theme bundle.
 */
export function activateTheme(profile: string, dir: string, name: string): boolean {
  const themes = installedThemes(profile, dir)
  if (!themes.some(theme => theme.name === name)) {
    logEvent('warn', 'themes', `activate refused: ${name} is not an installed theme`)
    return false
  }
  const file = userPatchPath(profile, dir)
  const previous = activeTheme(profile, dir)
  for (const theme of themes) {
    if (theme.name === name) continue
    disableRow(file, theme.name)
  }
  const written = enableRow(file, name)
  updateGalaxyState(dir, (state) => {
    const disabled = new Set(state.disabled ?? [])
    for (const theme of themes) if (theme.name !== name) disabled.add(theme.name)
    disabled.delete(name)
    state.disabled = [...disabled]
    const notes = { ...(state.notes ?? {}) }
    notes[ACTIVE_THEME_KEY] = name
    if (previous !== undefined && previous !== name) notes[PREVIOUS_THEME_KEY] = previous
    state.notes = notes
  })
  logEvent('info', 'themes', `active theme: ${name}${written ? '' : ' (no patch row — state only)'}`)
  return true
}

/**
 * Switch one theme entry on or off through the patch layer and the state
 * disabled list. Returns false when the name is not an installed theme.
 */
export function setEntryDisabled(profile: string, dir: string, name: string, disabled: boolean): boolean {
  const themes = installedThemes(profile, dir)
  if (!themes.some(theme => theme.name === name)) return false
  const file = userPatchPath(profile, dir)
  const written = disabled ? disableRow(file, name) : enableRow(file, name)
  updateGalaxyState(dir, (state) => {
    const next = new Set(state.disabled ?? [])
    if (disabled) next.add(name)
    else next.delete(name)
    state.disabled = [...next]
    const notes = { ...(state.notes ?? {}) }
    if (disabled) {
      if (notes[ACTIVE_THEME_KEY] === name) {
        notes[PREVIOUS_THEME_KEY] = name
        delete notes[ACTIVE_THEME_KEY]
      }
    } else {
      notes[ACTIVE_THEME_KEY] = name
    }
    state.notes = notes
  })
  logEvent('info', 'themes', `${name}: ${disabled ? 'disabled' : 'enabled'}${written ? '' : ' (no patch row — state only)'}`)
  return true
}

/** True when `name` is an installed theme bundle. */
export function isTheme(profile: string, dir: string, name: string): boolean {
  return installedThemes(profile, dir).some(theme => theme.name === name)
}

/**
 * Installed theme names, for callers that only need the set — the groups
 * module's one-theme-per-group rule and the toggle route's exclusivity check.
 */
export function installedThemeNames(profile: string, dir: string): Set<string> {
  return new Set(installedThemes(profile, dir).map(theme => theme.name))
}
