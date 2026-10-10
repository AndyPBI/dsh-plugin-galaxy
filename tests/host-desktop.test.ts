/**
 * Desktop / Windows host shapes.
 *
 * 0.2.x replaced the two services the Desktop shell used to publish
 * (`desktopProfiles`, `desktopPnpm`) with one `profileContext` service, so a
 * plugin that only knows the old names takes its non-desktop path inside the
 * desktop app: it resolves the profile to `web` (the desktop host is not started
 * with `--profile` at all) and finds no pnpm on PATH. These tests pin the
 * resolution and the launch recipe that keep both shapes working.
 */

import { describe, expect, it } from 'vitest'
import { packagedLaunch, pluginCommandArgs } from '../src/domain/dsh-cli.ts'
import { readProfileContext, resolveHostShape } from '../src/domain/host-shape.ts'

const PACKAGED = {
  name: 'desktop',
  dir: '/Applications/DSH.app/profile',
  packageManager: {
    command: '/Applications/DSH.app/runtime/node',
    args: ['/Applications/DSH.app/runtime/pnpm.cjs'],
    env: { PATH: '/Applications/DSH.app/runtime' },
  },
}

describe('host shape resolution', () => {
  it('prefers profileContext on 0.2.x (name and directory together)', () => {
    const shape = resolveHostShape({ profileContext: PACKAGED })
    expect(shape.profile).toBe('desktop')
    expect(shape.profileDirectory).toBe('/Applications/DSH.app/profile')
    expect(shape.packaged).toBe(true)
    expect(shape.packageManager?.command).toBe('/Applications/DSH.app/runtime/node')
  })

  it('takes the launched profile for a plain 0.2.x CLI/web host too', () => {
    const shape = resolveHostShape({ profileContext: { name: 'web', dir: '/opt/dsh/profiles/web' } })
    expect(shape.profile).toBe('web')
    expect(shape.profileDirectory).toBe('/opt/dsh/profiles/web')
    expect(shape.packaged).toBe(false)
  })

  it('falls back to the legacy desktop service (≤ 0.1.5-rc.2)', () => {
    const shape = resolveHostShape({ legacyDesktop: { current: { name: 'desktop', dir: '/old/profile' } } })
    expect(shape.profile).toBe('desktop')
    expect(shape.profileDirectory).toBe('/old/profile')
    expect(shape.packaged).toBe(false)
  })

  it('falls back to argv, then to web', () => {
    expect(resolveHostShape({ argvProfile: 'work' }).profile).toBe('work')
    expect(resolveHostShape({}).profile).toBe('web')
  })

  it('lets operator config win, and does NOT borrow the launched directory', () => {
    // An explicitly configured profile keeps the standard layout: pointing it at
    // the launched directory would make the galaxy read and mutate the wrong files.
    const shape = resolveHostShape({ configuredProfile: 'other', profileContext: PACKAGED })
    expect(shape.profile).toBe('other')
    expect(shape.profileDirectory).toBeUndefined()
    expect(shape.packaged).toBe(true)
  })

  it('ignores a malformed packageManager instead of treating it as packaged', () => {
    for (const value of [undefined, null, 'pnpm', {}, { command: '' }, { command: 7, args: 'x' }]) {
      const shape = resolveHostShape({ profileContext: { name: 'desktop', dir: '/p', packageManager: value } })
      expect(shape.packaged).toBe(false)
      expect(shape.packageManager).toBeUndefined()
    }
  })

  it('keeps a packageManager with odd args/env usable', () => {
    const shape = resolveHostShape({
      profileContext: { ...PACKAGED, packageManager: { command: 'node', args: ['pnpm.cjs', 7, null], env: { A: '1', B: 2 } } },
    })
    expect(shape.packageManager).toEqual({ command: 'node', args: ['pnpm.cjs'], env: { A: '1' } })
  })

  it('reads profileContext through get only, and survives a refusing context', () => {
    expect(readProfileContext({ get: () => PACKAGED })?.name).toBe('desktop')
    expect(readProfileContext({ get: () => null })).toBeUndefined()
    expect(readProfileContext({ get: () => 'nope' })).toBeUndefined()
    expect(readProfileContext({ get: () => { throw new Error('cannot get property without inject') } })).toBeUndefined()
  })
})

describe('packaged package-manager launch', () => {
  it('starts a bundled runtime directly — no shell, no CLI wrapper', () => {
    const launch = packagedLaunch(PACKAGED.packageManager, 'win32')
    expect(launch.file).toBe('/Applications/DSH.app/runtime/node')
    expect(launch.args).toEqual(['/Applications/DSH.app/runtime/pnpm.cjs'])
    expect(launch.viaShell).toBe(false)
  })

  it('still routes a Windows .cmd shim through the shell', () => {
    // A packaged app normally ships node.exe; if a build hands us a shim anyway,
    // `shell: false` could not start it (documented at the top of dsh-cli.ts).
    expect(packagedLaunch({ command: 'C:\\tools\\pnpm.cmd', args: [], env: {} }, 'win32').viaShell).toBe(true)
    expect(packagedLaunch({ command: 'C:\\tools\\pnpm.BAT', args: [], env: {} }, 'win32').viaShell).toBe(true)
    expect(packagedLaunch({ command: 'C:\\tools\\pnpm.exe', args: [], env: {} }, 'win32').viaShell).toBe(false)
    // …and only on Windows.
    expect(packagedLaunch({ command: '/usr/bin/pnpm.cmd', args: [], env: {} }, 'darwin').viaShell).toBe(false)
  })

  it('keeps the CLI wrapper for ordinary hosts', () => {
    expect(pluginCommandArgs('web', ['add', 'pkg'])).toEqual(['plugin', '--profile', 'web', 'add', 'pkg'])
  })
})

/**
 * Windows path handling outside the package manager: the drive-letter/UNC case
 * that POSIX-shaped checks miss, and the rename-over-open-file window that only
 * Windows has.
 */
describe('Windows path handling', () => {
  it('classifies a drive-letter or UNC spec as a local install', async () => {
    const { specKind } = await import('../src/core/profile.ts')
    expect(specKind('C:\\plugins\\pkg.tgz')).toBe('local')
    expect(specKind('D:/plugins/pkg')).toBe('local')
    expect(specKind('\\\\server\\share\\pkg')).toBe('local')
    // Unchanged for the shapes that already worked.
    expect(specKind('file:/tmp/x.tgz')).toBe('local')
    expect(specKind('/tmp/x.tgz')).toBe('local')
    expect(specKind('dsh-cost-meter')).toBe('unknown')
  })

  it('retries the atomic rename when Windows reports the target as busy', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { writeFileAtomic } = await import('../src/core/json.ts')
    const dir = mkdtempSync(join(tmpdir(), 'galaxy-atomic-'))
    const file = join(dir, 'state.json')
    writeFileSync(file, '{"old":true}')

    // A rename that fails the way Windows does, then succeeds.
    let attempts = 0
    const { default: fs } = await import('node:fs')
    const realRename = fs.renameSync
    // eslint-disable-next-line ts/no-explicit-any -- patching one fs call for the test
    ;(fs as any).renameSync = (...args: unknown[]) => {
      attempts += 1
      if (attempts === 1) {
        const error = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return (realRename as (...a: unknown[]) => unknown)(...args)
    }
    try {
      writeFileAtomic(file, '{"fresh":true}')
    } finally {
      ;(fs as any).renameSync = realRename
    }
    // The documented fallback: the write lands even though the rename was blocked.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fresh: true })
  })
})
