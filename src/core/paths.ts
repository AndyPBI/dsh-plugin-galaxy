/**
 * Filesystem locations owned by Plugin Galaxy.
 *
 * A DSH profile lives at `<DSH_HOME>/profiles/<name>`; the galaxy keeps its
 * own durable state in a sibling directory (`.dsh-galaxy/`) so that removing
 * the plugin leaves the profile's own files untouched.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Directory (inside a profile) holding every galaxy-owned file. */
export const GALAXY_DIR_NAME = '.dsh-galaxy'

/** `<galaxy>/state.json` —. */
export const STATE_FILE = 'state.json'
/** `<galaxy>/presets.json` — collection. */
export const PRESETS_FILE = 'presets.json'
/** `<galaxy>/log.ndjson` —. */
export const LOG_FILE = 'log.ndjson'
/** `<galaxy>/snapshots/` — directory. */
export const SNAPSHOT_DIR = 'snapshots'
/** `<galaxy>/discovery-cache.json` — host compatibility facts. */
export const DISCOVERY_CACHE_FILE = 'discovery-cache.json'
/** Prefix of hot-mount files: `hot-<n>.yml`. */
export const HOT_FILE_PREFIX = 'hot-'

/** Default single-root Harness home. */
export function defaultDshHome(): string {
  return join(homedir(), '.dsh')
}

/** Expand the tilde forms supported by DSH configuration. */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve an explicit home, `DSH_HOME`, or the default to one absolute path.
 * Blank environment values count as unset, matching DSH alpha.
 */
export function resolveDshHome(
  configured?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env.DSH_HOME
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())
  return resolve(expandHomePath(selected))
}

/**
 * Whether a profile name follows DSH's directory-name contract: dots, spaces
 * and Unicode are ordinary name characters; only empty, traversal-shaped,
 * launcher-owned or separator-bearing names are refused.
 */
export function isDshProfileName(profile: string): boolean {
  return profile !== ''
    && profile !== '.'
    && profile !== '..'
    && profile !== 'node_modules'
    && !profile.includes('/')
    && !profile.includes('\\')
    && !profile.includes('\0')
}

/**
 * Resolve a profile name to its directory. An explicit directory is honoured
 * first: hosts such as DSH Desktop own the active profile location instead of
 * deriving it from the environment.
 */
export function profileDir(profile: string, explicitDir?: string): string {
  if (explicitDir !== undefined) return explicitDir
  if (!isDshProfileName(profile)) throw new Error(`dsh-plugin-galaxy: invalid profile name ${JSON.stringify(profile)}`)
  return join(resolveDshHome(), 'profiles', profile)
}

/** `<profile>/.dsh-galaxy` for a resolved profile directory. */
export function galaxyDir(dir: string): string {
  return join(dir, GALAXY_DIR_NAME)
}

/** Create a directory (and parents) with the requested mode. */
export function ensureDir(dir: string, mode = 0o700): void {
  if (existsSync(dir)) return
  mkdirSync(dir, { recursive: true, mode })
}

/** Create `<profile>/.dsh-galaxy` and return its path. */
export function ensureGalaxyDir(dir: string): string {
  const galaxy = galaxyDir(dir)
  ensureDir(galaxy)
  return galaxy
}
