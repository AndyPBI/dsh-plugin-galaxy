/**
 * Diagnostics report — the panel that answers "what is my profile actually
 * running?".
 *
 * Its header carries the HOST version, and the peer analysis uses that version
 * as the fallback for peers the host itself supplies. The reader used to look
 * only in `<profile>/node_modules`, which is where the PLUGINS live: a real DSH
 * profile keeps the host packages one level up, in the shared dependency anchor
 * (`<dsh home>/profiles/node_modules`). So a perfectly healthy profile reported
 * `宿主版本: unknown` — while the very same report's bundle section said those
 * packages were "not locatable from this profile". These cases pin the lookup.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { analyzeProfile, readHostVersion } from '../src/domain/diagnostics.ts'

let home: string
const originalHome = process.env.DSH_HOME

/** Create `<root>/node_modules/<name>/package.json` with a version. */
function install(root: string, name: string, version: string): void {
  const dir = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'galaxy-diag-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
})

describe('host version in the diagnostics report', () => {
  it('reads the shared dependency anchor the profile is built against', () => {
    install(join(home, 'profiles'), '@deepseek-ai/dsh-base', '0.1.5-alpha.1')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    expect(readHostVersion('web')).toBe('0.1.5-alpha.1')
  })

  it('prefers a profile-local host package when the profile has one', () => {
    install(join(home, 'profiles'), '@deepseek-ai/dsh-base', '0.1.4')
    install(join(home, 'profiles', 'web'), '@deepseek-ai/dsh-base', '0.1.6')
    expect(readHostVersion('web')).toBe('0.1.6')
  })

  it('accepts the other host packages of the same release line', () => {
    install(join(home, 'profiles'), '@deepseek-ai/dsh-headless', '0.1.5-rc.3')
    expect(readHostVersion('web')).toBe('0.1.5-rc.3')
  })

  it('never reports cordis as the host version', () => {
    // cordis versioned 4.x is a peer, not the DSH release: anchoring on it would
    // print "宿主版本: 4.0.2", which is worse than saying nothing.
    install(join(home, 'profiles'), '@deepseek-ai/cordis', '4.0.2')
    expect(readHostVersion('web')).toBe('unknown')
  })

  it('says unknown rather than inventing a version', () => {
    expect(readHostVersion('web')).toBe('unknown')
  })

  it('gives the REPORT the same version, even with no profile manifest', () => {
    // The value used to be gated on `manifestWritten`, which hid the host
    // release behind an unrelated problem.
    install(join(home, 'profiles'), '@deepseek-ai/dsh-base', '0.1.5-alpha.1')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const report = analyzeProfile('web')
    expect(report.hostVersion).toBe('0.1.5-alpha.1')
    // …and the missing manifest is still reported as the error it is.
    expect(report.findings.some(finding => finding.code === 'profile-manifest-missing')).toBe(true)
  })
})
