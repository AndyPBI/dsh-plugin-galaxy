/**
 * Update-target resolution.
 *
 * A candidate update must be asked for by the version the checker reported, not
 * by the `latest` dist-tag: pnpm resolves `@latest` against its own cached
 * registry metadata, and when that cache is behind it exits 0 having installed
 * nothing — leaving the specifier, the installed version and the lockfile
 * untouched while the operator is told the update succeeded. Measured on a real
 * profile: `add @linxin666/dsh-client-ui-skill-explorer@latest` downloaded 0 and
 * kept 0.3.20 although the registry (and `pnpm view`) said 0.3.21.
 */

import { describe, expect, it } from 'vitest'

import { updateSpecFor } from '../src/domain/updates.ts'

describe('updateSpecFor', () => {
  it('pins the reported version instead of asking for @latest', () => {
    expect(updateSpecFor('@linxin666/dsh-client-ui-skill-explorer', '^0.3.20', '0.3.21'))
      .toBe('@linxin666/dsh-client-ui-skill-explorer@0.3.21')
    expect(updateSpecFor('plain-pkg', '~1.2.0', '1.2.7')).toBe('plain-pkg@1.2.7')
  })

  it('falls back to @latest only when no version was reported', () => {
    expect(updateSpecFor('pkg', '^1.0.0')).toBe('pkg@latest')
    expect(updateSpecFor('pkg', '^1.0.0', '   ')).toBe('pkg@latest')
  })

  it('leaves non-registry identities untouched', () => {
    // Rewriting these by name is what once installed an unrelated npm package
    // that merely shared the plugin's name.
    for (const spec of [
      'github:owner/repo',
      'https://github.com/owner/repo',
      'git+ssh://git@host/owner/repo.git',
      'file:../plugin',
      'link:../plugin',
      'https://example.com/plugin.tgz',
      'https://example.com/plugin.tar.gz',
    ]) {
      expect(updateSpecFor('plugin', spec, '9.9.9')).toBe(spec)
    }
  })
})
