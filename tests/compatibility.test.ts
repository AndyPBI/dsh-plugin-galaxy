/**
 * Compat: verdicts, both host-range spellings, and the cached-facts round trip.
 *
 * The pre-install compatibility column is the feature that tells a user whether
 * a catalog plugin suits the host they are running. Two ways it was answering
 * `unknown` for plugins that DO declare their requirement:
 *
 *  1. only `dsh.hostVersion` was read, while the convention other DSH plugins
 *     publish is `dsh.engines.dsh` (the aggregate web UI declares
 *     `>=0.1.5-rc.1` there);
 *  2. the discovery cache stores FACTS, not manifests — so even a comparator
 *     that understood a field would still see `unknown` unless the field
 *     survived `manifestFacts` → cache → `factsToManifest`.
 */

import { describe, expect, it } from 'vitest'

import { deriveHostCompatibility, satisfiesHostRange } from '../src/domain/compatibility.ts'
import { factsToManifest, manifestFacts } from '../src/domain/discovery-compatibility.ts'
import type { NpmManifest } from '../src/core/types.ts'

/** Verdict for one manifest against a host version. */
function verdict(manifest: Partial<NpmManifest>, hostVersion: string) {
  return deriveHostCompatibility({ name: 'demo-plugin', ...manifest } as NpmManifest, hostVersion)
}

describe('host ranges in either spelling', () => {
  it('honours dsh.hostVersion (this plugin\'s own convention)', () => {
    const result = verdict({ dsh: { hostVersion: '>=0.1.5-rc.1' } }, '0.1.5-alpha.1')
    expect(result.status).toBe('incompatible')
    expect(result.basis).toBe('host-version')
    expect(result.requirement).toBe('>=0.1.5-rc.1')
  })

  it('honours dsh.engines.dsh (the convention third-party plugins publish)', () => {
    // Exactly the shape the installed aggregate web UI uses.
    const result = verdict({ dsh: { engines: { dsh: '>=0.1.5-rc.1' } } }, '0.1.5-alpha.1')
    expect(result.status).toBe('incompatible')
    expect(result.basis).toBe('host-version')
    expect(result.requirement).toBe('>=0.1.5-rc.1')
  })

  it('accepts a plugin whose engine range the host satisfies', () => {
    const result = verdict({ dsh: { engines: { dsh: '>=0.1.5-alpha.1' } } }, '0.1.5-alpha.1')
    expect(result.status).toBe('compatible')
    expect(result.basis).toBe('host-version')
  })

  it('reads a top-level engines.dsh too', () => {
    // `^0.1.5` cannot accept a PRERELEASE of 0.1.5 (npm semantics), so an alpha
    // host is genuinely out of range — this is the case that matters for a
    // plugin declaring a release-line range.
    const result = verdict({ engines: { dsh: '^0.1.5' } }, '0.1.5-alpha.1')
    expect(result.status).toBe('incompatible')
    expect(result.basis).toBe('host-version')
  })

  it('reports every declaration it evaluated when both spellings are present', () => {
    const result = verdict({ dsh: { hostVersion: '>=0.1.0', engines: { dsh: '>=0.9.0' } } }, '0.1.5-alpha.1')
    expect(result.status).toBe('incompatible')
    // Both are host-range declarations, so the rejection is not blamed on a peer.
    expect(result.basis).toBe('host-version')
    expect(result.declarations?.['dsh.hostVersion']).toBe('>=0.1.0')
    expect(result.declarations?.['dsh.engines.dsh']).toBe('>=0.9.0')
  })

  it('judges a peer against the INSTALLED peer, not against the host release', () => {
    // `"@deepseek-ai/cordis": "^4.0.1"` names cordis, whose installed version is
    // 4.0.2 — comparing it to "DSH 0.1.5" reported every peer-declaring plugin
    // (this one included) as incompatible.
    const manifest = { peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' } }
    const satisfied = deriveHostCompatibility(manifest as NpmManifest, '0.1.5-alpha.1', { peerVersion: () => '4.0.2' })
    expect(satisfied.status).toBe('compatible')
    const violated = deriveHostCompatibility(manifest as NpmManifest, '0.1.5-alpha.1', { peerVersion: () => '9.0.0' })
    expect(violated.status).toBe('incompatible')
    expect(violated.basis).toBe('peer')
  })

  it('does not invent a mismatch from a peer that is not installed here', () => {
    const manifest = { peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' } }
    const result = deriveHostCompatibility(manifest as NpmManifest, '0.1.5-alpha.1')
    // Nothing was checked, so it must not claim compatibility either.
    expect(result.status).toBe('unknown')
    expect(result.reason).toContain('cordis')
  })

  it('stays unknown when a plugin declares nothing', () => {
    const result = verdict({}, '0.1.5-alpha.1')
    expect(result.status).toBe('unknown')
  })

  it('never claims compatibility from a range it cannot parse', () => {
    const result = verdict({ dsh: { engines: { dsh: 'not a range !!' } } }, '0.1.5-alpha.1')
    expect(result.status).toBe('unknown')
  })
})

describe('compatibility facts survive the discovery cache', () => {
  it('keeps the engine range through capture, cache and rebuild', () => {
    // The cache stores facts, not manifests: a field the capture step forgets is
    // a field the verdict can never see, no matter what the comparator knows.
    const facts = manifestFacts({
      name: 'demo-plugin',
      version: '0.3.20',
      dsh: { plugin: true, engines: { dsh: '>=0.1.5-rc.1' } },
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
    })
    expect(facts.engineRange).toBe('>=0.1.5-rc.1')
    const rebuilt = factsToManifest('demo-plugin', facts)
    expect(rebuilt.dsh?.engines?.dsh).toBe('>=0.1.5-rc.1')
    // The peer is resolved like the discovery path resolves it.
    const peerVersion = (name: string): string | undefined => (name === '@deepseek-ai/cordis' ? '4.0.2' : undefined)
    expect(deriveHostCompatibility(rebuilt, '0.1.5-alpha.1', { peerVersion }).status).toBe('incompatible')
    // …and the same facts judge compatible on a host that satisfies them.
    expect(deriveHostCompatibility(rebuilt, '0.1.5-rc.2', { peerVersion }).status).toBe('compatible')
  })

  it('captures this plugin\'s own spelling as well', () => {
    const facts = manifestFacts({ name: 'x', dsh: { hostVersion: '>=0.1.5-alpha.1' } })
    expect(facts.hostVersion).toBe('>=0.1.5-alpha.1')
    expect(factsToManifest('x', facts).dsh?.hostVersion).toBe('>=0.1.5-alpha.1')
  })

  it('records absence as null, so a verdict can say "declares nothing"', () => {
    const facts = manifestFacts({ name: 'x' })
    expect(facts.engineRange).toBeNull()
    expect(facts.hostVersion).toBeNull()
    expect(factsToManifest('x', facts).dsh).toBeUndefined()
  })

  it('agrees with the range comparator on prerelease ordering', () => {
    // The whole feature rests on this: 0.1.5-alpha.1 is OLDER than 0.1.5-rc.1.
    expect(satisfiesHostRange('0.1.5-alpha.1', '>=0.1.5-rc.1')).toBe(false)
    expect(satisfiesHostRange('0.1.5-rc.1', '>=0.1.5-alpha.1')).toBe(true)
  })
})
