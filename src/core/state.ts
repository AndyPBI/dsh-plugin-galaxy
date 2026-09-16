/**
 * Persistence: `<profile>/.dsh-galaxy/state.json`.
 *
 * This is the galaxy's own durable state (disabled plugins, groups, notes,
 * channel, region, favorites, GitHub proxy). It is deliberately separate from
 * the profile manifest: removing the plugin leaves the profile's own files
 * untouched, and a corrupted state file can be deleted without breaking the
 * host.
 *
 * Every mutation goes through {@link updateGalaxyState}, which re-reads the
 * file before applying the change — two browser tabs saving notes at the same
 * time must not lose each other's writes.
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile, writeJsonAtomic } from './json.ts'
import { galaxyDir, STATE_FILE } from './paths.ts'
import { logEvent } from './log.ts'
import type { Channel, GalaxyState, Region } from './types.ts'

/** A single note is capped at this many characters. */
export const MAX_NOTE = 200
/** At most this many bookmarked catalog URLs. */
export const MAX_FAVORITES = 500
/** Cap on a custom GitHub proxy prefix. */
export const MAX_PROXY = 300
/** Cap on the number of named groups. */
export const MAX_GROUPS = 50
/** Cap on members of a single group. */
export const MAX_GROUP_MEMBERS = 200
/** A configured URL (catalog or website base) is capped like a proxy prefix. */
export const MAX_URL = 500

/** Absolute path of the galaxy state file. */
export function statePath(dir: string): string {
  return join(galaxyDir(dir), STATE_FILE)
}

/** Normalize an unknown value into a {@link GalaxyState}. */
function normalize(raw: unknown): GalaxyState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  const state: GalaxyState = {}
  if (Array.isArray(record.disabled)) {
    state.disabled = record.disabled.filter((item): item is string => typeof item === 'string')
  }
  if (typeof record.groups === 'object' && record.groups !== null && !Array.isArray(record.groups)) {
    const groups: Record<string, string[]> = {}
    for (const [name, members] of Object.entries(record.groups as Record<string, unknown>)) {
      if (!Array.isArray(members)) continue
      groups[name] = members.filter((item): item is string => typeof item === 'string')
    }
    state.groups = groups
  }
  if (Array.isArray(record.groupOrder)) {
    state.groupOrder = record.groupOrder.filter((item): item is string => typeof item === 'string')
  }
  if (typeof record.notes === 'object' && record.notes !== null && !Array.isArray(record.notes)) {
    const notes: Record<string, string> = {}
    for (const [name, text] of Object.entries(record.notes as Record<string, unknown>)) {
      if (typeof text === 'string') notes[name] = text
    }
    state.notes = notes
  }
  if (record.channel === 'stable' || record.channel === 'beta' || record.channel === 'dev') {
    state.channel = record.channel
  }
  if (record.region === 'global' || record.region === 'china') state.region = record.region
  if (typeof record.regionAuto === 'boolean') state.regionAuto = record.regionAuto
  if (Array.isArray(record.favorites)) {
    state.favorites = record.favorites.filter((item): item is string => typeof item === 'string').slice(0, MAX_FAVORITES)
  }
  if (typeof record.githubProxy === 'string' && record.githubProxy.trim() !== '') {
    state.githubProxy = record.githubProxy.trim().slice(0, MAX_PROXY)
  }
  if (typeof record.catalogUrl === 'string' && record.catalogUrl.trim() !== '') {
    state.catalogUrl = record.catalogUrl.trim().slice(0, MAX_URL)
  }
  if (typeof record.siteUrl === 'string' && record.siteUrl.trim() !== '') {
    state.siteUrl = record.siteUrl.trim().slice(0, MAX_URL)
  }
  return state
}

/** Read the galaxy state; never throws — a corrupt file reads as empty. */
export function readGalaxyState(dir: string): GalaxyState {
  return normalize(readJsonFile<unknown>(statePath(dir)))
}

/** Write the galaxy state atomically. */
export function writeGalaxyState(dir: string, state: GalaxyState): void {
  writeJsonAtomic(statePath(dir), state)
}

/**
 * Read-modify-write the galaxy state. The file is re-read inside the call so
 * concurrent writers cannot silently drop each other's changes.
 */
export function updateGalaxyState(dir: string, mutate: (state: GalaxyState) => void): GalaxyState {
  const state = readGalaxyState(dir)
  mutate(state)
  writeGalaxyState(dir, state)
  return state
}

/** The disabled-plugin set as a plain array. */
export function disabledList(state: GalaxyState): string[] {
  return [...(state.disabled ?? [])]
}

/** Record the explicit region choice (clears the automatic-probe flag). */
export function setRegion(dir: string, region: Region): GalaxyState {
  return updateGalaxyState(dir, (state) => {
    state.region = region
    state.regionAuto = false
  })
}

/** Record the release channel of the galaxy itself. */
export function setChannel(dir: string, channel: Channel): GalaxyState {
  return updateGalaxyState(dir, (state) => { state.channel = channel })
}

/**
 * Delete every galaxy-owned file for a profile. Returns the removed paths.
 * Used by self-uninstall with `purge: true`.
 */
/**
 * Point this profile at a catalog URL (empty clears the override).
 *
 * Read-time precedence is `DSHG_REGISTRY_URL` → this → the built-in public
 * catalog, so an ops override still wins over whatever is stored here.
 */
export function setCatalogUrl(dir: string, url: string): GalaxyState {
  return updateGalaxyState(dir, (state) => {
    const value = url.trim()
    if (value === '' || value.length > MAX_URL) delete state.catalogUrl
    else state.catalogUrl = value
  })
}

/** Point this profile at the operator's plugin website (empty clears it). */
export function setSiteUrl(dir: string, url: string): GalaxyState {
  return updateGalaxyState(dir, (state) => {
    const value = url.trim()
    if (value === '' || value.length > MAX_URL) delete state.siteUrl
    else state.siteUrl = value
  })
}

export function purgeGalaxyState(dir: string): string[] {
  const removed: string[] = []
  const galaxy = galaxyDir(dir)
  try {
    rmSync(galaxy, { recursive: true, force: true })
    removed.push(galaxy)
    logEvent('info', 'purge', `removed galaxy state directory ${galaxy}`)
  } catch (error) {
    logEvent('warn', 'purge', `could not remove ${galaxy}: ${(error as Error).message}`)
  }
  return removed
}
