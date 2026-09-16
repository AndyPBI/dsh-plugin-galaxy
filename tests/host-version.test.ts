/**
 * Host-version detection.
 *
 * The compatibility column used to be permanently `unknown` on every real host,
 * because it read `DSH_HOST_VERSION` — a variable that exists in this plugin and
 * NOWHERE in dsh (`grep -rn DSH_HOST_VERSION` over the harness: 0 hits). The
 * version is knowable, though: the profile's dependency anchor installs the host
 * packages beside the profile. These cases pin the whole probe order, including
 * the two ways it must stay silent rather than invent an answer.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectHostVersion, hostVersionInfo, satisfiesHostRange } from '../src/domain/compatibility.ts'

let scratch: string
const originalHome = process.env.DSH_HOME
const originalExplicit = process.env.DSH_HOST_VERSION

/** Write `<root>/node_modules/<name>/package.json` with `version` (or `raw`). */
function installPackage(root: string, name: string, version: string | null): void {
  const dir = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), version === null ? 'not json at all' : JSON.stringify({ name, version }))
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'galaxy-host-'))
  delete process.env.DSH_HOST_VERSION
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  if (originalExplicit === undefined) delete process.env.DSH_HOST_VERSION
  else process.env.DSH_HOST_VERSION = originalExplicit
})

describe('host version detection', () => {
  it('lets an explicit DSH_HOST_VERSION win over anything installed', () => {
    process.env.DSH_HOME = scratch
    const profile = join(scratch, 'profiles', 'web')
    installPackage(join(scratch, 'profiles'), '@deepseek-ai/dsh-base', '0.9.9')
    process.env.DSH_HOST_VERSION = '1.2.3-rc.4'
    expect(detectHostVersion(profile)).toEqual({ version: '1.2.3-rc.4', source: 'env' })
  })

  it('reads the anchor a profile is built against (the real layout)', () => {
    // <home>/profiles/node_modules/@deepseek-ai/dsh-base — exactly what the live
    // profile has (0.1.5-alpha.1), and the reason the verdicts can stop being
    // `unknown`.
    process.env.DSH_HOME = scratch
    installPackage(join(scratch, 'profiles'), '@deepseek-ai/dsh-base', '0.1.5-alpha.1')
    const profile = join(scratch, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    expect(detectHostVersion(profile)).toEqual({ version: '0.1.5-alpha.1', source: 'anchor' })
  })

  it('prefers a profile-local host install over the shared anchor', () => {
    process.env.DSH_HOME = scratch
    installPackage(join(scratch, 'profiles'), '@deepseek-ai/dsh-base', '0.1.4')
    const profile = join(scratch, 'profiles', 'web')
    installPackage(profile, '@deepseek-ai/dsh-base', '0.2.0')
    expect(detectHostVersion(profile)).toEqual({ version: '0.2.0', source: 'profile' })
  })

  it('falls back to the CLI package when the host bundle is absent', () => {
    process.env.DSH_HOME = scratch
    installPackage(join(scratch, 'profiles'), '@deepseek-ai/dsh', '0.1.6')
    expect(detectHostVersion(join(scratch, 'profiles', 'web'))).toEqual({ version: '0.1.6', source: 'anchor' })
  })

  it('stays unknown when nothing is readable — an invented version is worse', () => {
    process.env.DSH_HOME = scratch
    // A malformed manifest must not become a version.
    installPackage(join(scratch, 'profiles'), '@deepseek-ai/dsh-base', null)
    expect(detectHostVersion(join(scratch, 'profiles', 'web'))).toBeUndefined()
  })

  it('does not throw when the home is unset and the profile has no packages', () => {
    delete process.env.DSH_HOME
    expect(() => detectHostVersion(join(scratch, 'nothing-here'))).not.toThrow()
  })

  it('resolves once per mount, so a polled route reads no files', () => {
    process.env.DSH_HOME = scratch
    const profile = join(scratch, 'profiles', 'web')
    installPackage(join(scratch, 'profiles'), '@deepseek-ai/dsh-base', '0.1.5-alpha.1')
    const caches = new Map<string, unknown>()
    const runtime = {
      config: { profileDirectory: profile },
      cache<T>(key: string): T | undefined { return caches.get(key) as T | undefined },
      setCache(key: string, value: unknown): void { caches.set(key, value) },
    }
    expect(hostVersionInfo(runtime)).toEqual({ version: '0.1.5-alpha.1', source: 'anchor' })
    // Remove the evidence: the memoized answer must survive, because the host
    // release cannot change while this process is alive.
    rmSync(join(scratch, 'profiles', 'node_modules'), { recursive: true, force: true })
    expect(hostVersionInfo(runtime)).toEqual({ version: '0.1.5-alpha.1', source: 'anchor' })
  })
})

describe('the plugin declares the host it was verified against', () => {
  it('publishes a range its own reader understands', () => {
    // The host does not enforce `dsh.engines` (0 hits in apps/cli), so this is
    // metadata — but it must at least be TRUE, and readable by the same
    // comparator that judges every catalog plugin.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dsh?: { hostVersion?: string; engines?: { dsh?: string } }
    }
    const declared = pkg.dsh?.hostVersion
    expect(typeof declared).toBe('string')
    expect(pkg.dsh?.engines?.dsh).toBe(declared)
    // The version this plugin was built and tested against…
    expect(satisfiesHostRange('0.1.5-alpha.1', declared as string)).toBe(true)
    // …and a host older than the floor it needs (no settings.plugin.item cohort).
    expect(satisfiesHostRange('0.1.4', declared as string)).toBe(false)
  })
})
