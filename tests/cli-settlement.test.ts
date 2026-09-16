/**
 * Settlement of a spawned package command — the defect behind "the panel just
 * hangs and never tells me anything".
 *
 * `collectChild` used to settle on the child's `close` event ALONE. `close`
 * requires the child's stdio to be fully closed, which is NOT the same as the
 * child exiting: a grandchild that inherited the pipes keeps `close` pending
 * long after the command is gone. Measured directly:
 *
 *     exit  code=3 after    4ms     ← the wrapper is gone
 *     close code=3 after 8013ms     ← an orphaned `sleep` still held stdout
 *
 * In the real chain (`dsh` -> `pnpm` -> node worker) an unexpected exit leaves
 * exactly that: the HTTP request never answered, so `runtime.locks` kept the
 * `install` lock forever, every later mutation queued behind it, and the panel
 * sat on "busy" with no error and no way out. The client-side watchdog is a
 * safety net; this is the actual fix, and it is asserted with REAL processes:
 * a fake `dsh` earlier on `PATH` reproduces both shapes.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createCliRunner, type PluginRunner } from '../src/domain/dsh-cli.ts'
import { GalaxyRuntime } from '../src/core/runtime.ts'
import { profileDir } from '../src/core/paths.ts'
import { progressTracker } from '../src/domain/progress.ts'
import { UpdateOperationStoreV1 } from '../src/domain/update-api-v1.ts'

/** Dirs created per test, removed afterwards. */
const created: string[] = []
const originalPath = process.env.PATH
const originalEnv = {
  DSH_HOME: process.env.DSH_HOME,
  DSHG_INSTALL_TIMEOUT_MS: process.env.DSHG_INSTALL_TIMEOUT_MS,
  DSHG_KILL_SETTLE_MS: process.env.DSHG_KILL_SETTLE_MS,
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  process.env.PATH = originalPath
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/**
 * Put a fake `dsh` FIRST on `PATH` (`dshLaunch()` falls back to a plain `dsh`
 * lookup whenever `process.argv[1]` is not a dsh entry point, which is the case
 * under vitest) and point `$DSH_HOME` at a throwaway home so nothing near the
 * real profile is touched.
 */
function fakeDsh(script: string): { dir: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), 'galaxy-cli-'))
  const home = join(dir, 'home')
  created.push(dir)
  const bin = join(dir, 'dsh')
  writeFileSync(bin, script, { mode: 0o755 })
  chmodSync(bin, 0o755)
  process.env.PATH = `${dir}:${originalPath ?? ''}`
  process.env.DSH_HOME = home
  return { dir, home }
}

/** A runner for a throwaway profile; `createCliRunner` needs no live runtime. */
function runnerFor(home: string) {
  process.env.DSH_HOME = home
  return createCliRunner({
    profile: 'web',
    // Must equal `profileDir('web')`, or the runner logs a "non-standard
    // directory" warning (and the CLI would target a different one).
    profileDirectory: profileDir('web'),
    allowRestart: undefined,
    maxSnapshots: 3,
  })
}

describe('package-command settlement', () => {
  it('settles after the command exits, even while an orphan holds its pipes', async () => {
    // The wrapper exits at once; a backgrounded grandchild inherits stdout and
    // keeps it open for 8s. Before the fix this promise never settled.
    const { home } = fakeDsh(`#!/bin/sh
(sleep 8 &)
echo 'partial output'
exit 3
`)
    const runner = runnerFor(home)
    const started = Date.now()
    const result = await runner('web', ['add', 'demo-package'])
    const elapsed = Date.now() - started

    expect(result.exitCode).toBe(3)
    expect(result.timedOut).toBe(false)
    expect(result.cancelled).toBe(false)
    // Output written before the exit is still reported.
    expect(result.stdout).toContain('partial output')
    // Crucially: it settled on the drain grace, not when the orphan died.
    expect(elapsed).toBeLessThan(6_000)
  }, 20_000)

  it('settles on the post-kill deadline when a descendant survives the kill', async () => {
    // The wrapper ignores SIGTERM; the detached grandchild is in its OWN
    // process group, so the group SIGKILL cannot reach it and it keeps holding
    // stdout — `close` can never fire. The kill deadline must settle anyway.
    process.env.DSHG_INSTALL_TIMEOUT_MS = '1000'
    process.env.DSHG_KILL_SETTLE_MS = '1200'
    const pidFile = join(tmpdir(), `galaxy-orphan-${String(process.pid)}.pid`)
    process.env.GALAXY_TEST_PID_FILE = pidFile
    const { home } = fakeDsh(`#!/bin/sh
trap '' TERM
node -e "const fs=require('fs');const {spawn}=require('child_process');const c=spawn('sleep',['15'],{detached:true,stdio:'inherit'});fs.writeFileSync(process.env.GALAXY_TEST_PID_FILE,String(c.pid))"
sleep 30
`)
    const runner = runnerFor(home)
    const started = Date.now()
    const result = await runner('web', ['add', 'demo-package'])
    const elapsed = Date.now() - started

    expect(result.timedOut).toBe(true)
    // 1s timeout + 1.2s deadline; anything near 15s would mean it waited for
    // the orphan instead of the deadline.
    expect(elapsed).toBeLessThan(8_000)

    // Clean up the deliberately unkillable orphan so the suite can exit.
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(pid) && pid > 0) process.kill(pid, 'SIGKILL')
    } catch {
      // The orphan may already be gone; nothing to clean up.
    }
    rmSync(pidFile, { force: true })
    delete process.env.GALAXY_TEST_PID_FILE
  }, 20_000)

  it('reports a spawn failure instead of hanging when the command cannot start', async () => {
    // No fake `dsh` on PATH at all: the launch fails and must still settle.
    const dir = mkdtempSync(join(tmpdir(), 'galaxy-cli-empty-'))
    created.push(dir)
    process.env.PATH = dir
    process.env.DSH_HOME = join(dir, 'home')
    const runner = runnerFor(join(dir, 'home'))
    const result = await runner('web', ['add', 'demo-package'])
    expect(result.exitCode).toBe(127)
    expect(result.stderr).not.toBe('')
  }, 20_000)
})

describe('package-command output reaches the progress snapshot', () => {
  it('feeds GET /status progress with the child\'s own words', async () => {
    // Was reported by `/status` and never fed, so a long install
    // looked identical to a hung one. The runner is the single choke point for
    // child output, which is why the wiring lives there.
    const { home } = fakeDsh(`#!/bin/sh
echo '\u2713 Lockfile passes supply-chain policies (verified 7m ago)'
echo 'Progress: resolved 173, reused 54, downloaded 3, added 2, done'
exit 0
`)
    const config = {
      profile: 'web',
      profileDirectory: profileDir('web'),
      allowRestart: undefined,
      maxSnapshots: 3,
    }
    // The runtime needs a runner and the runner needs the runtime: a proxy
    // breaks the cycle the same way the mount does at boot.
    let real: PluginRunner | undefined
    const proxy = ((profile: string, args: string[]) => {
      if (real === undefined) throw new Error('runner not wired')
      return real(profile, args)
    }) as PluginRunner
    proxy.dispose = async (): Promise<void> => undefined
    const runtime = new GalaxyRuntime({
      config,
      runner: proxy,
      operations: new UpdateOperationStoreV1('test-boot'),
    })
    real = createCliRunner(config, runtime)

    const tracker = progressTracker(runtime)
    tracker.start('demo-package')
    const result = await real('web', ['add', 'demo-package'])

    expect(result.exitCode).toBe(0)
    const snapshot = tracker.snapshot()
    expect(snapshot.lines?.join('\n')).toContain('supply-chain policies')
    expect(snapshot.lines?.join('\n')).toContain('resolved 173')
    // Counters are lifted out of the same line the operator sees.
    expect(snapshot.downloaded).toBe(3)
    expect(snapshot.done).toBe(2)
    expect(snapshot.detail).toContain('resolved 173')
  }, 20_000)
})
