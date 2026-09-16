/**
 * Foundation tests: the core layer every domain module builds on.
 *
 * These cover the pieces where a bug would be silent and destructive —
 * atomic writes, JSON round-tripping of galaxy state, profile manifest
 * preservation, mutation-lock serialisation, same-origin/loopback guards and
 * log sanitisation.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { jsonEqual, readJsonFile, writeFileAtomic, writeJsonAtomic } from '../src/core/json.ts'
import { MutationLocks } from '../src/core/locks.ts'
import { sanitize } from '../src/core/log.ts'
import { isDshProfileName, profileDir, resolveDshHome } from '../src/core/paths.ts'
import {
  INBOX_BUNDLES,
  readInstalled,
  readManifestDeps,
  readProfileManifestSnapshot,
  restoreProfileManifest,
  specKind,
  specRepo,
} from '../src/core/profile.ts'
import { MAX_FAVORITES, MAX_NOTE, readGalaxyState, updateGalaxyState, writeGalaxyState } from '../src/core/state.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'galaxy-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('core/json', () => {
  it('writes JSON atomically and leaves no temporary file behind', () => {
    const file = join(dir, 'nested', 'state.json')
    writeJsonAtomic(file, { hello: 'world' })
    expect(readJsonFile<{ hello: string }>(file)).toEqual({ hello: 'world' })
    // Exactly one file: the rename consumed the temporary sibling.
    expect(readdirSync(join(dir, 'nested'))).toEqual(['state.json'])
  })

  it('replaces existing content rather than appending', () => {
    const file = join(dir, 'a.txt')
    writeFileAtomic(file, 'first')
    writeFileAtomic(file, 'second')
    expect(readFileSync(file, 'utf8')).toBe('second')
  })

  it('compares JSON structurally, not by key order', () => {
    expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true)
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false)
  })
})

describe('core/paths', () => {
  it('refuses traversal-shaped profile names', () => {
    for (const name of ['', '.', '..', 'node_modules', 'a/b', 'a\\b']) {
      expect(isDshProfileName(name)).toBe(false)
    }
    expect(isDshProfileName('web')).toBe(true)
    expect(isDshProfileName('我的 配置')).toBe(true)
  })

  it('honours DSH_HOME and falls back to ~/.dsh', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '/tmp/custom-home' })).toBe('/tmp/custom-home')
    expect(resolveDshHome(undefined, { DSH_HOME: '   ' })).toContain('.dsh')
  })

  it('derives the profile directory from the home', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = '/tmp/galaxy-home'
    try {
      expect(profileDir('web')).toBe('/tmp/galaxy-home/profiles/web')
      expect(profileDir('web', '/explicit/dir')).toBe('/explicit/dir')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('core/state', () => {
  it('round-trips a galaxy state document', () => {
    writeGalaxyState(dir, { disabled: ['a'], groups: { g: ['a'] }, channel: 'beta', favorites: ['u'] })
    const state = readGalaxyState(dir)
    expect(state.disabled).toEqual(['a'])
    expect(state.groups).toEqual({ g: ['a'] })
    expect(state.channel).toBe('beta')
  })

  it('drops unknown values instead of throwing on a corrupt file', () => {
    mkdirSync(join(dir, '.dsh-galaxy'), { recursive: true })
    writeFileSync(join(dir, '.dsh-galaxy', 'state.json'), '{ not json')
    expect(readGalaxyState(dir)).toEqual({})
  })

  it('re-reads before mutating so concurrent writers are not lost', () => {
    writeGalaxyState(dir, { notes: { a: 'first' } })
    updateGalaxyState(dir, (state) => { state.notes = { ...state.notes, b: 'second' } })
    expect(readGalaxyState(dir).notes).toEqual({ a: 'first', b: 'second' })
  })

  it('enforces the favorites quota and note length constants', () => {
    expect(MAX_FAVORITES).toBe(500)
    expect(MAX_NOTE).toBe(200)
    const many = Array.from({ length: MAX_FAVORITES + 10 }, (_, index) => `u${index}`)
    writeGalaxyState(dir, { favorites: many })
    expect(readGalaxyState(dir).favorites?.length).toBe(MAX_FAVORITES)
  })
})

describe('core/profile', () => {
  it('filters in-box bundles from the installed view but keeps them for rollback', () => {
    const manifest = {
      dependencies: {
        '@deepseek-ai/dsh-base': '1.0.0',
        'community-plugin': '^2.0.0',
      },
    }
    const profile = 'web'
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    mkdirSync(join(dir, 'profiles', profile), { recursive: true })
    writeFileSync(join(dir, 'profiles', profile, 'package.json'), JSON.stringify(manifest))
    try {
      const installed = readInstalled(profile)
      expect(Object.keys(installed)).toEqual(['community-plugin'])
      const raw = readManifestDeps(profile)
      expect(Object.keys(raw).sort()).toEqual(['@deepseek-ai/dsh-base', 'community-plugin'])
      expect(INBOX_BUNDLES.has('@deepseek-ai/dsh-base')).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('restores a manifest snapshot exactly, including an absent bundles field', () => {
    const profile = 'web'
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    mkdirSync(join(dir, 'profiles', profile), { recursive: true })
    writeFileSync(
      join(dir, 'profiles', profile, 'package.json'),
      JSON.stringify({ dependencies: { a: '1.0.0' }, dsh: { profile: { bundles: ['a'] } } }),
    )
    try {
      const snapshot = readProfileManifestSnapshot(profile)
      writeFileSync(
        join(dir, 'profiles', profile, 'package.json'),
        JSON.stringify({ dependencies: { a: '1.0.0', b: '2.0.0' }, dsh: { profile: {} } }),
      )
      restoreProfileManifest(profile, snapshot)
      const restored = JSON.parse(readFileSync(join(dir, 'profiles', profile, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
        dsh?: { profile?: { bundles?: unknown } }
      }
      expect(restored.dependencies).toEqual({ a: '1.0.0' })
      expect(restored.dsh?.profile?.bundles).toEqual(['a'])
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('classifies dependency specs', () => {
    expect(specKind('^1.2.3')).toBe('npm')
    expect(specKind('github:owner/repo')).toBe('git')
    expect(specKind('file:../local')).toBe('local')
    expect(specKind('https://x/y.tgz')).toBe('tarball')
    expect(specRepo('github:owner/repo#main')).toBe('owner/repo')
    expect(specRepo('https://github.com/owner/repo')).toBe('owner/repo')
  })
})

describe('core/locks', () => {
  it('serializes operations of the same kind', async () => {
    const locks = new MutationLocks()
    const order: string[] = []
    const first = locks.withLock('install', 'a', async () => {
      order.push('a-start')
      await new Promise(resolve => setTimeout(resolve, 20))
      order.push('a-end')
    })
    const second = locks.withLock('install', 'b', () => { order.push('b') })
    await Promise.all([first, second])
    expect(order).toEqual(['a-start', 'a-end', 'b'])
  })

  it('does not let a failing operation poison the queue', async () => {
    const locks = new MutationLocks()
    const failing = locks.withLock('write', 'bad', () => { throw new Error('boom') })
    await expect(failing).rejects.toThrow('boom')
    await expect(locks.withLock('write', 'good', () => 'ok')).resolves.toBe('ok')
  })

  it('reports busy state and the current holder', async () => {
    const locks = new MutationLocks()
    expect(locks.isBusy()).toBe(false)
    const running = locks.withLock('install', 'install abc', async () => {
      expect(locks.isBusy()).toBe(true)
      expect(locks.busyReason()).toBe('install: install abc')
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    await running
    expect(locks.isBusy()).toBe(false)
  })
})

describe('core/log', () => {
  it('masks credentials, folds the home directory and strips control characters', () => {
    // compliance-allow: credential — the sanitizer's own fixture, not a secret.
    const credentialFixture = ['sk', 'abcdefghijklmnop'].join('-')
    const text = sanitize(`token=${credentialFixture}\ninjected\tnpm_abcdefghijklmnop`)
    expect(text).not.toContain(credentialFixture)
    expect(text).not.toContain('npm_abcdefghijklmnop')
    expect(text).not.toContain('\n')
    expect(text).not.toContain('\t')
  })
})
