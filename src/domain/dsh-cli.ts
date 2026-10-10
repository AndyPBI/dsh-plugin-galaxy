/**
 * Process layer — the ONLY module that starts child processes.
 *
 * Installs run through `node:child_process` with an argv array, never through
 * a shell string and never through the host's shell service: the shell service
 * is the agent's sandboxed executor and denies writes to the profile
 * directory, and a shell string turns a package spec into shell syntax.
 *
 * Three problems this module exists to solve, all of them observed in the
 * field by the reference implementation:
 *
 *  - **A GUI launch has no PATH.** macOS apps started from Finder/Dock (and
 *    Windows desktop hosts) inherit a minimal environment, so Homebrew, npm,
 *    corepack and pnpm "vanish" and every install dies with ENOENT/127.
 *    {@link pnpmExtraPathDirs} returns the well-known bin directories and they
 *    are appended to the child's PATH.
 *  - **pnpm ignores the standard proxy variables.** It reads npm config, and
 *    `git` — which pnpm shells out to for every git-hosted plugin — reads only
 *    the standard variables. {@link proxyEnvForPnpm} translates in both
 *    directions so a proxied machine can install npm AND git sources.
 *  - **`dsh.cmd` on Windows cannot be started with `shell: false`.** It is a
 *    cmd.exe shim; the shim path goes through `cmd.exe /d /s /c` with an
 *    explicitly quoted command line, every other invocation spawns directly.
 *
 * Cancellation is cooperative through `runtime.activeProcess`, which the
 * `/cancel` route reaches: the handle kills the whole process GROUP, because
 * the `dsh` wrapper runs pnpm as a grandchild (spawnSync) whose open stdio
 * pipes otherwise keep the close event from ever firing.
 *
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { logEvent } from '../core/log.ts'
import { progressTracker } from './progress.ts'
import { profileDir } from '../core/paths.ts'
import type { PnpmInvocationLike } from './host-shape.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { InstallResult, ResolvedConfig } from '../core/types.ts'

/** Run one `dsh plugin …` command for a profile; never rejects on a non-zero exit. */
export interface PluginRunner {
  (profile: string, args: string[]): Promise<InstallResult>
  /**
   * Release anything this runner owns.
   *
   * The CLI runner owns only the transient child it clears when that child
   * settles, so its implementation is a no-op; the desktop runtime
   * implements it for real, because a host-supplied package manager keeps an
   * operation handle that must be cancelled before the mount goes away.
   */
  dispose(): Promise<void>
}

/** Default per-command budget: slow networks plus git installs need room. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/** Cap on captured stdout (256 KiB) and stderr (64 KiB). */
const STDOUT_LIMIT = 256 * 1024
const STDERR_LIMIT = 64 * 1024

/**
 * How long the helper waits for the old process to exit before relaunching
 * anyway. A hung shutdown must not leave a machine with no host at all.
 */
export const RESTART_HELPER_WAIT_MS = 30_000

/** Bilingual, actionable text for the one-click pnpm setup button. */
export const PNPM_HINT
  = 'pnpm 没能准备好。请在终端里执行 `pnpm --version` 确认它是否可用：如果那里也失败，就单独装一个 pnpm（macOS/Linux 用 `brew install pnpm`，Windows 用 `iwr https://get.pnpm.io/install.ps1 -useb | iex`）；如果终端里正常而这里失败，说明 dsh 进程的 PATH 与你的终端不同，请从一个能直接运行 pnpm 的终端里启动 dsh，并在装完后重启（安装器只对新开的会话生效）'
  + ' / pnpm could not be provisioned. Run `pnpm --version` in a terminal: if that fails too, install pnpm on its own (`brew install pnpm` on macOS/Linux, `iwr https://get.pnpm.io/install.ps1 -useb | iex` on Windows); if it works there but not here, the dsh process has a different PATH than your shell — start dsh from a terminal where pnpm already runs, and restart afterwards (an installer only affects new sessions)'

/** True when this platform starts a bare command through a `.cmd` shim. */
export const winCmdShim = process.platform === 'win32'

/** cmd.exe resolved once; only the Windows shim path uses it. */
const COMSPEC = process.env.ComSpec ?? 'cmd.exe'

/** Characters cmd.exe treats as syntax even inside a token. */
const CMD_METACHARS = /[\s"&|<>^()%!]/

/** Quote one argv token for a `cmd.exe /c` command line. */
function quoteCmdArg(arg: string): string {
  if (!CMD_METACHARS.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/** Build a cmd.exe command line from argv, quoting every token. */
function cmdCommandLine(argv: readonly string[]): string {
  return argv.map(quoteCmdArg).join(' ')
}

/** The real Node executable, preferring an absolute existing `argv0`. */
export function nodeExecutable(
  argv0: string | undefined = process.argv0,
  execPath: string = process.execPath,
): string {
  if (argv0 !== undefined && argv0 !== '' && isAbsolute(argv0) && existsSync(argv0)) return argv0
  return execPath
}

/** The directory holding the Node binary running this process. */
export const nodeBinDir = dirname(nodeExecutable())

/**
 * Extra directories appended to a child's PATH so a spawned pnpm can be found
 * even from a GUI/desktop launch that inherited no shell profile.
 *
 * @param platform - `process.platform`, injectable for tests.
 * @param env - environment, for `PNPM_HOME` and the Windows app-data roots.
 * @param home - home directory, injectable for tests.
 */
export function pnpmExtraPathDirs(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const dirs: string[] = []
  // PNPM_HOME comes first on every platform: the standalone installer sets it,
  // so it is the one answer that stays right when the layout is not default.
  const pnpmHome = (env.PNPM_HOME ?? '').trim()
  if (pnpmHome !== '') dirs.push(pnpmHome)
  if (platform === 'win32') {
    const local = (env.LOCALAPPDATA ?? '').trim()
    const roaming = (env.APPDATA ?? '').trim()
    if (local !== '') dirs.push(join(local, 'pnpm'))
    if (roaming !== '') dirs.push(join(roaming, 'npm'))
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'))
    dirs.push(join(home, 'Library', 'pnpm'), join(home, '.local', 'share', 'pnpm'))
  }
  dirs.push(nodeBinDir)
  // Deduped: PNPM_HOME usually names one of the defaults, and a list that says
  // the same directory twice reads as carelessness in the one place a user
  // goes looking for an answer.
  return [...new Set(dirs.filter(dir => dir.trim() !== ''))]
}

/**
 * Translate the machine's proxy environment into the forms pnpm and git read.
 *
 * Three consumers, three vocabularies, one proxy: the galaxy's own fetch reads
 * the standard variables, pnpm reads ONLY npm config
 * (`npm_config_https_proxy` / `npm_config_proxy` / `npm_config_noproxy`), and
 * `git` reads only the standard variables. Translating one direction leaves
 * the third out — the reference project was told four times that a catalog
 * loaded through a proxy while every install hung (#148, #161, #188, #232),
 * and separately that git installs went direct and failed (#274).
 *
 * An `npm_config_*` value the caller already set always wins: it is the more
 * specific statement of intent. On Windows env keys are case-insensitive, so
 * the check is too. `NO_PROXY` is forwarded verbatim so a host that excludes
 * its own registry mirror keeps excluding it.
 *
 * @param env - environment to translate; never mutated.
 * @returns only the variables the child should have set or replaced.
 */
export function proxyEnvForPnpm(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const has = (name: string): boolean => {
    const wanted = name.toLowerCase()
    return Object.keys(env).some(key => key.toLowerCase() === wanted && (env[key] ?? '').trim() !== '')
  }
  const pick = (...names: string[]): string | null => {
    for (const name of names) {
      const raw = env[name]
      if (raw !== undefined && raw.trim() !== '') return raw.trim()
    }
    return null
  }
  const out: Record<string, string> = {}
  // Same precedence as undici's EnvHttpProxyAgent: lowercase over uppercase,
  // https falling back to http.
  const stdHttps = pick('https_proxy', 'HTTPS_PROXY') ?? pick('http_proxy', 'HTTP_PROXY')
  const stdHttp = pick('http_proxy', 'HTTP_PROXY') ?? stdHttps
  if (stdHttps !== null && !has('npm_config_https_proxy')) out.npm_config_https_proxy = stdHttps
  if (stdHttp !== null && !has('npm_config_proxy')) out.npm_config_proxy = stdHttp
  const stdNoProxy = pick('no_proxy', 'NO_PROXY')
  if (stdNoProxy !== null && !has('npm_config_noproxy')) out.npm_config_noproxy = stdNoProxy

  // The other direction, and ONLY when the standard vocabulary is empty. A
  // proxy known solely to npm config is the case that stranded git; copying
  // npm's answer over a standard variable the caller set would invent a
  // setting they did not make.
  if (stdHttps === null && stdHttp === null) {
    const npmHttps = pick('npm_config_https_proxy') ?? pick('npm_config_proxy')
    const npmHttp = pick('npm_config_proxy') ?? npmHttps
    if (npmHttps !== null) out.HTTPS_PROXY = npmHttps
    if (npmHttp !== null) out.HTTP_PROXY = npmHttp
    const npmNoProxy = pick('npm_config_noproxy')
    if (npmNoProxy !== null && stdNoProxy === null) out.NO_PROXY = npmNoProxy
  }
  return out
}

/** PATH + proxy environment every spawned child receives. */
function spawnEnv(): NodeJS.ProcessEnv {
  const separator = process.platform === 'win32' ? ';' : ':'
  const parts = (process.env.PATH ?? '').split(separator).filter(part => part !== '')
  for (const dir of pnpmExtraPathDirs()) {
    if (!parts.includes(dir)) parts.push(dir)
  }
  return {
    ...process.env,
    ...proxyEnvForPnpm(process.env),
    // pnpm v10+ blocks forever on a silent interactive prompt without a TTY;
    // CI mode makes it act or fail instead of asking.
    CI: 'true',
    PATH: parts.join(separator),
  }
}

/** Per-command timeout in milliseconds; `DSHG_INSTALL_TIMEOUT_MS` overrides. */
export function installTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.DSHG_INSTALL_TIMEOUT_MS ?? '').trim()
  if (raw === '') return DEFAULT_TIMEOUT_MS
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
}

/**
 * How long to wait after a kill signal before settling without `close`.
 *
 * `DSHG_KILL_SETTLE_MS` overrides. The default is deliberately short: the
 * command has already been asked twice to die, and every extra second is a
 * second the profile mutation lock is held and the operator stares at a busy
 * panel.
 */
export function killSettleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.DSHG_KILL_SETTLE_MS ?? '').trim()
  if (raw === '') return KILL_SETTLE_MS
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : KILL_SETTLE_MS
}

/**
 * How to re-invoke the `dsh` CLI that launched this host.
 *
 * When `process.argv[1]` looks like a dsh/node entry point, the child is
 * spawned as `node <abs entry> …`, which works whether dsh runs from a global
 * bin, a local install, or repository source (`node --import tsx/esm …`).
 * Elsewhere the bare `dsh` command is used, which on Windows is a `.cmd` shim
 * that only a shell can start.
 */
export function dshLaunch(): { file: string; args: string[]; cwd: string | undefined; viaShell: boolean } {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/u.test(entry)) {
    // Absolute, because a source launch (`pnpm dsh`) passes a relative entry
    // that the child would resolve against its OWN cwd and die with
    // MODULE_NOT_FOUND. cwd near the entry keeps `--import tsx/esm` resolvable.
    const absolute = resolve(entry)
    return { file: nodeExecutable(), args: [...process.execArgv, absolute], cwd: dirname(absolute), viaShell: false }
  }
  return { file: 'dsh', args: [], cwd: undefined, viaShell: winCmdShim }
}

/**
 * Spawn a command, avoiding Node's deprecated `shell: true` + argv combination.
 * Windows `.cmd` shims cannot start without a shell, so that one path routes
 * through `cmd.exe /d /s /c` with an explicitly built, quoted command line;
 * every other invocation spawns directly with `shell: false`.
 */
function spawnCommand(
  file: string,
  args: readonly string[],
  options: { cwd?: string | undefined; env: NodeJS.ProcessEnv; detached: boolean; viaShell: boolean },
): ChildProcess {
  const base = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    detached: options.detached,
    windowsHide: true,
  }
  if (!options.viaShell || process.platform !== 'win32') {
    return spawn(file, [...args], { ...base, shell: false })
  }
  return spawn(COMSPEC, ['/d', '/s', '/c', `"${cmdCommandLine([file, ...args])}"`], {
    ...base,
    shell: false,
    windowsVerbatimArguments: true,
  })
}

/**
 * Kill a child and, on Windows, its whole process tree — `kill()` there only
 * terminates the wrapper, leaving pnpm children running.
 */
export function killChild(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      return
    } catch { /* fall through to the generic path */ }
  }
  try {
    child.kill('SIGKILL')
  } catch { /* already gone */ }
}

/**
 * Kill a child and its whole tree, gracefully where the platform allows:
 * `taskkill /T /F` on Windows, SIGTERM with a 5s SIGKILL escalation
 * elsewhere so pnpm can clean up its staging directory.
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      return
    } catch { /* fall through */ }
  }
  const signalTree = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    // The child is spawned detached as its own process GROUP on POSIX, so the
    // wrapper AND the pnpm grandchild die with one signal.
    try {
      process.kill(-child.pid, signal)
    } catch {
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }
  signalTree('SIGTERM')
  const escalate = setTimeout(() => { signalTree('SIGKILL') }, 5000)
  escalate.unref?.()
}

/** One running child plus the user-cancelled latch shared with the route. */
interface RunningChild {
  child: ChildProcess
  cancelled: boolean
  /** Global cancel for the active-process slot; idempotent. */
  cancel(): void
}

/**
 * Grace period after `exit` for the remaining stdio to arrive before the child
 * is declared finished anyway.
 *
 * `close` — which this used to wait for EXCLUSIVELY — fires only once the
 * child's stdio is fully closed, and that is not the same thing as the child
 * exiting: a grandchild that inherited the pipes keeps `close` pending after
 * the command is long gone (measured: wrapper `exit` at 4ms, `close` at 8013ms
 * behind a single orphaned `sleep`). In the real chain (`dsh` -> `pnpm` -> node
 * worker) that is exactly what an unexpected exit leaves behind, and the cost
 * was severe: the HTTP request never answered, so the `install` mutation lock
 * stayed held and the panel sat on "busy" with no error and no way out.
 */
const DRAIN_GRACE_MS = 2_000

/**
 * Hard deadline after a kill signal. A descendant that survives the signal (or
 * lives in another process group, as on Windows) must not be able to keep the
 * request — and with it the profile mutation lock — hostage indefinitely.
 */
const KILL_SETTLE_MS = 10_000

/**
 * Wire output capture, timeout and cancellation around one spawned child.
 *
 * Settlement is GUARANTEED: whichever of `error`, `close`, the post-`exit`
 * drain grace or the post-kill deadline comes first wins, and `onSettle` runs
 * exactly once. Callers turn "no result" into a hung request, so this is a
 * correctness property, not a nicety.
 *
 * @param child - the spawned process.
 * @param timeoutMs - kill the child after this long.
 * @param onRegister - called with the cancel handle while the child lives.
 * @param onSettle - called exactly once when the child ends (or fails).
 */
function collectChild(
  child: ChildProcess,
  timeoutMs: number,
  onRegister: (running: RunningChild) => void,
  onSettle: () => void,
  onOutput?: (chunk: string) => void,
): Promise<InstallResult> {
  return new Promise<InstallResult>((settle) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let done = false
    let exitCode: number | null = null
    let drainTimer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    const running: RunningChild = {
      child,
      cancelled: false,
      cancel: () => {
        if (running.cancelled || done) return
        running.cancelled = true
        killTree(child)
        armKillDeadline()
      },
    }
    const finish = (result: InstallResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(drainTimer)
      clearTimeout(killTimer)
      onSettle()
      settle(result)
    }
    /** Settle without `close`, reporting why (the output may be truncated). */
    const settleAnyway = (why: string): void => {
      logEvent('warn', 'spawn', `settling: ${why} (exit=${String(exitCode ?? 'none')}, timedOut=${String(timedOut)}, cancelled=${String(running.cancelled)})`)
      finish({
        exitCode: exitCode ?? 127,
        stdout,
        stderr,
        timedOut,
        cancelled: running.cancelled,
        ...(stdout === '' && stderr === '' ? {} : { raw: `${stdout}\n${stderr}` }),
      })
    }
    /** Start the post-kill deadline once, when a kill is actually requested. */
    const armKillDeadline = (): void => {
      if (killTimer !== undefined || done) return
      killTimer = setTimeout(() => { settleAnyway('the command did not exit after being killed') }, killSettleMs())
      killTimer.unref?.()
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      armKillDeadline()
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stdout = (stdout + text).slice(-STDOUT_LIMIT)
      // Streamed so a long operation is legible WHILE it runs; the buffers
      // above stay the authoritative record for the result and the log.
      if (onOutput !== undefined) { try { onOutput(text) } catch { /* progress must never break an install */ } }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stderr = (stderr + text).slice(-STDERR_LIMIT)
      if (onOutput !== undefined) { try { onOutput(text) } catch { /* see above */ } }
    })
    child.on('error', (error: Error) => {
      finish({
        exitCode: 127,
        stdout,
        stderr: `${stderr}${stderr === '' ? '' : '\n'}${error.message}`,
        timedOut,
        cancelled: running.cancelled,
      })
    })
    child.on('exit', (code: number | null) => {
      exitCode = code
      // The command is gone; only its pipes may still be open. Do not let an
      // orphan decide when the operator hears back.
      drainTimer = setTimeout(() => { settleAnyway('the output pipes stayed open after the command exited') }, DRAIN_GRACE_MS)
      drainTimer.unref?.()
    })
    child.on('close', (code: number | null) => {
      if (code !== null) exitCode = code
      finish({
        exitCode: exitCode ?? 127,
        stdout,
        stderr,
        timedOut,
        cancelled: running.cancelled,
        ...(stdout === '' && stderr === '' ? {} : { raw: `${stdout}\n${stderr}` }),
      })
    })
    onRegister(running)
  })
}

/**
 * Build the runner that drives the `dsh` CLI for one mount's profile.
 *
 * Every spawn is logged with the command and profile ONLY — never the
 * environment, which carries the proxy credentials. Captured output is
 * sanitized by {@link logEvent} on the way into the log and by the route layer
 * on the way to the browser.
 *
 * @param config - the resolved mount configuration (profile + explicit dir).
 * @param runtime - the mount whose `activeProcess` slot exposes `/cancel`.
 */
export function createCliRunner(config: ResolvedConfig, runtime?: GalaxyRuntime): PluginRunner {
  const launch = dshLaunch()
  // The CLI resolves the profile from `--profile <name>` + `$DSH_HOME` alone, so
  // an explicit non-standard directory cannot be passed through it (see
  // pluginCommandArgs). Say so once per mount rather than operating on a
  // different directory than the operator configured without a trace.
  const standardDir = profileDir(config.profile)
  if (config.profileDirectory !== standardDir) {
    logEvent(
      'warn',
      'spawn',
      `profile directory ${config.profileDirectory} is not the standard ${standardDir}; `
      + 'CLI package operations target the standard one (only a packaged app runner honours an explicit directory)',
    )
  }
  return makeSpawnRunner({ ...launch, env: spawnEnv(), cli: true }, runtime)
}

/**
 * Build a runner around one launch recipe: the shared body of every package
 * operation (timeout, process-tree kill, progress, `/cancel`).
 */
function makeSpawnRunner(
  launch: { file: string; args: readonly string[]; cwd: string | undefined; env: NodeJS.ProcessEnv; viaShell: boolean; cli: boolean },
  runtime?: GalaxyRuntime,
): PluginRunner {
  const timeoutMs = installTimeoutMs()
  const runner: PluginRunner = async (profile: string, args: string[]): Promise<InstallResult> => {
    // A packaged app is handed pnpm directly, so the CLI's `plugin --profile`
    // wrapper (which would also resolve the profile itself) is not used.
    const forwarded = launch.cli
      ? pluginCommandArgs(profile, args)
      : [...args]
    logEvent('info', 'spawn', `${launch.file} ${forwarded.join(' ')}`)
    let child: ChildProcess
    try {
      child = spawnCommand(launch.file, [...launch.args, ...forwarded], {
        cwd: launch.cwd,
        env: launch.env,
        // Own process group on POSIX so cancel/timeout can kill the wrapper
        // and the pnpm grandchild with one signal.
        detached: process.platform !== 'win32',
        viaShell: launch.viaShell,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logEvent('error', 'spawn', `could not start the dsh CLI: ${message}`)
      return { exitCode: 127, stdout: '', stderr: message, timedOut: false, cancelled: false }
    }
    try {
      return await collectChild(
        child,
        timeoutMs,
        (running) => {
          // The slot is what `/cancel` reaches; a runner built without a
          // runtime simply has no cancellable handle to publish.
          if (runtime !== undefined) runtime.activeProcess = { cancel: () => { running.cancel() } }
        },
        () => { if (runtime !== undefined) runtime.activeProcess = null },
        // The mount's progress tracker is the one place that turns child output
        // into something `GET /status` can hand the browser.
        // Feeding it HERE means every package operation reports progress —
        // install, update, uninstall, migration, rollback — with no route-level
        // bookkeeping to forget.
        (chunk) => { if (runtime !== undefined) progressTracker(runtime).outputLines(chunk) },
      )
    } finally {
      // Also cleared here so a rejection that bypassed the settle callback
      // cannot leave `/cancel` pointing at a dead process.
      if (runtime !== undefined) runtime.activeProcess = null
    }
  }
  // Nothing owned survives a settled child: the active-process slot is the
  // mount's, not this runner's, and `collectChild` clears it in every path.
  runner.dispose = async (): Promise<void> => {}
  return runner
}

/**
 * argv for one `dsh plugin …` invocation.
 *
 * ONLY flags the CLI actually defines may appear here. `dsh plugin` forwards
 * every remaining argument to pnpm, so an invented flag does not fail loudly at
 * the CLI — it reaches pnpm and surfaces as
 * `[ERROR] Unknown option: 'profile-dir'` / `pnpm failed`. That is exactly what
 * the removed `--profile-dir` selector did.
 *
 * The profile directory does not need to be passed: the CLI resolves it from
 * `--profile <name>` + `$DSH_HOME`, the same resolution this plugin uses, and a
 * Desktop host never reaches the CLI at all (it calls the injected
 * `desktopPnpm` service, which is handed the directory directly).
 *
 * @param profile - the profile name the CLI should operate on.
 * @param args - the forwarded pnpm arguments, e.g. `['remove', 'pkg']`.
 * @returns the spawn argv, without the launcher prefix.
 */
export function pluginCommandArgs(profile: string, args: readonly string[]): string[] {
  return ['plugin', '--profile', profile, ...args]
}

/* ------------------------------------------------------------------ *
 * Packaged applications (0.2.x `profileContext.packageManager`)
 * ------------------------------------------------------------------ */

/**
 * How a packaged application's package manager is launched.
 *
 * `profileContext.packageManager` is `{ command, args, env }`: the app hands over
 * its BUNDLED runtime instead of a PATH executable, because a packaged app has no
 * pnpm on PATH at all — on Windows the command is the app's own `node.exe` plus
 * the pnpm entry point. It replaces the removed `desktopPnpm` service (which used
 * to run pnpm on the plugin's behalf); the plugin now spawns it, which is why the
 * CLI's `plugin --profile` wrapper is skipped here: the app already scoped the
 * invocation to its own profile directory.
 *
 * Pure so the platform decision can be tested without spawning anything.
 *
 * @param invocation - command/args/env the app supplied.
 * @param platform - `process.platform`, injectable for tests.
 * @returns the launch recipe for {@link makeSpawnRunner}.
 */
export function packagedLaunch(
  invocation: PnpmInvocationLike,
  platform: string = process.platform,
): { file: string; args: string[]; viaShell: boolean } {
  // A bundled `node.exe`/`node` starts directly; only a `.cmd` shim (what a
  // PATH-installed pnpm looks like on Windows) needs a shell.
  const shim = platform === 'win32' && /\.(?:cmd|bat)$/iu.test(invocation.command)
  return { file: invocation.command, args: [...invocation.args], viaShell: shim }
}

/**
 * Runner for a packaged application: pnpm straight from the app's own runtime.
 *
 * The app's `env` is layered OVER the spawn environment — it describes where its
 * bundled runtime lives, so it must not be overridden by ours.
 */
export function createPackagedRunner(config: ResolvedConfig, runtime?: GalaxyRuntime): PluginRunner {
  if (config.packageManager === undefined) {
    throw new Error('dsh-plugin-galaxy: createPackagedRunner requires config.packageManager')
  }
  if (!isAbsolute(config.profileDirectory) || config.profileDirectory.includes('\0')) {
    throw new Error('dsh-plugin-galaxy: a packaged profile directory must be an absolute path without NUL')
  }
  const launch = packagedLaunch(config.packageManager)
  return makeSpawnRunner({
    file: launch.file,
    args: launch.args,
    cwd: config.profileDirectory,
    env: { ...spawnEnv(), ...config.packageManager.env },
    viaShell: launch.viaShell,
    cli: false,
  }, runtime)
}

/* ------------------------------------------------------------------ *
 * Desktop (structural subset of a third-party host's pnpm service)
 * ------------------------------------------------------------------ */

/** One running desktop package operation, however it was started. */
export interface DesktopPnpmHandleLike {
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>
  cancel(): void
}

/**
 * Structural subset of DSH Desktop's public `desktopPnpm` contract.
 *
 * Every member but `runPlugin` is optional and reached by feature detection: a
 * host that does not publish one simply never enters that branch, and the
 * ordinary CLI path it already used stays untouched. The cost of accommodating
 * one vendor must not be paid by the others.
 */
export interface DesktopPnpmLike {
  runPlugin(args: readonly string[], invokingDir: string, signal?: AbortSignal): DesktopPnpmHandleLike
  /** Some desktop builds refuse `add` on `runPlugin` and offer this instead. */
  runExternalMarketPluginInstall?(
    args: readonly string[],
    invokingDir: string,
    signal?: AbortSignal,
  ): DesktopPnpmHandleLike
}

/** An npm name with a fully pinned version. */
const EXACT_NPM_TARGET_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

/** Copy a desktop handle's streams into one {@link InstallResult}. */
function collectDesktopHandle(handle: DesktopPnpmHandleLike, timeoutMs: number): {
  result: Promise<InstallResult>
  cancel: () => void
} {
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let cancelled = false
  const controller = new AbortController()
  const collectOut = (chunk: string | Buffer): void => { stdout = (stdout + chunk.toString()).slice(-STDOUT_LIMIT) }
  const collectErr = (chunk: string | Buffer): void => { stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT) }
  handle.stdout.on('data', collectOut)
  handle.stderr.on('data', collectErr)
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('dsh-plugin-galaxy: desktop package operation timed out'))
    handle.cancel()
  }, timeoutMs)
  timer.unref?.()
  const result = (async (): Promise<InstallResult> => {
    try {
      const outcome = await handle.done
      return {
        exitCode: outcome.exitCode ?? 127,
        stdout,
        stderr,
        timedOut,
        cancelled,
        ...(stdout === '' && stderr === '' ? {} : { raw: `${stdout}\n${stderr}` }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        exitCode: 127,
        stdout,
        stderr: `${stderr}${stderr === '' ? '' : '\n'}${message}`,
        timedOut,
        cancelled,
      }
    } finally {
      clearTimeout(timer)
      handle.stdout.off?.('data', collectOut)
      handle.stderr.off?.('data', collectErr)
    }
  })()
  return { result, cancel: () => { cancelled = true; handle.cancel() } }
}

/**
 * Adapt a desktop host's package manager to the ordinary {@link PluginRunner}
 * contract.
 *
 * There is no runtime import or dependency on the desktop package: the host
 * supplies this public service only when the galaxy is mounted there. The
 * explicit directory replaces the profile argument entirely, because that host
 * scopes every operation to its own active profile directory and refuses
 * commands aimed anywhere else.
 *
 * @param service - the host's `desktopPnpm` (or compatible) service.
 * @param dir - the absolute active profile directory the host owns.
 * @param options - `invokingDir` and `timeoutMs`, both injectable for tests.
 */
export function createDesktopPluginRuntime(
  service: DesktopPnpmLike,
  dir: string,
  options: { invokingDir?: string; timeoutMs?: number } = {},
): PluginRunner {
  const timeoutMs = options.timeoutMs ?? installTimeoutMs()
  const invokingDir = options.invokingDir ?? process.cwd()
  if (!isAbsolute(dir) || dir.includes('\0')) {
    throw new Error('dsh-plugin-galaxy: the desktop profile directory must be an absolute path without NUL')
  }
  // The operation this runtime started, kept only so `dispose()` can cancel it:
  // the host's package manager owns a process tree that outlives the route.
  let active: { cancel: () => void } | null = null
  let closed = false
  const runner: PluginRunner = async (_profile: string, args: string[]): Promise<InstallResult> => {
    if (closed) {
      return {
        exitCode: 127,
        stdout: '',
        stderr: 'dsh-plugin-galaxy: the desktop package runtime is disposed',
        timedOut: false,
        cancelled: false,
      }
    }
    const target = args[args.length - 1] ?? ''
    logEvent('info', 'spawn', `desktop pnpm ${args.join(' ')} (dir ${dir})`)
    let handle: DesktopPnpmHandleLike
    const boundary = args[0] === 'add' ? service.runExternalMarketPluginInstall : undefined
    try {
      // A host that publishes the boundary accepts ONLY `name@exact.version`
      // there; anything else falls back to the ordinary call, which reports
      // that host's own refusal rather than a message this module invented.
      handle = boundary !== undefined && EXACT_NPM_TARGET_RE.test(target)
        ? boundary.call(service, args, invokingDir)
        : service.runPlugin(args, invokingDir)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const busy = /already running/i.test(message)
      return { exitCode: 127, stdout: '', stderr: message, timedOut: false, cancelled: false, ...(busy ? { busy: true } : {}) }
    }
    const running = collectDesktopHandle(handle, timeoutMs)
    active = { cancel: running.cancel }
    try {
      return await running.result
    } finally {
      active = null
    }
  }
  runner.dispose = async (): Promise<void> => {
    closed = true
    active?.cancel()
    active = null
  }
  return runner
}

/* ------------------------------------------------------------------ *
 * Restart helper
 * ------------------------------------------------------------------ */

/**
 * Source for the detached helper that outlives this process and brings the
 * replacement host up.
 *
 * Extracted as a string so the waiting can be tested by RUNNING it, which is
 * the only way this class of bug shows itself. It fixes the reference
 * implementation's #177: the helper used to sleep a flat 1500ms and spawn,
 * while the listening socket had not been released yet, so the replacement
 * died instantly with EADDRINUSE — and the spawn was wrapped in `catch {}`, so
 * nothing was written anywhere. The user saw a restart button that did
 * nothing. So: wait for the port to go quiet, start, then CHECK that something
 * came up, and write a diagnosis when it did not.
 *
 * @param file - executable to relaunch.
 * @param args - its arguments.
 * @param cwd - working directory for the replacement.
 * @param viaShell - whether the relaunch needs a shell (a `.cmd` shim).
 * @param logs - files the helper appends its own diagnostics to.
 * @param port - the port the replacement must bind, when known.
 */
export function restartHelperSource(
  file: string,
  args: readonly string[],
  cwd: string,
  viaShell: boolean,
  logs: { out: string; err: string },
  port: number | null,
): string {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const file = ${JSON.stringify(file)}`,
    `const args = ${JSON.stringify(args)}`,
    `const cwd = ${JSON.stringify(cwd)}`,
    `const viaShell = ${JSON.stringify(viaShell)}`,
    `const logOut = ${JSON.stringify(logs.out)}`,
    `const logErr = ${JSON.stringify(logs.err)}`,
    `const port = ${JSON.stringify(port)}`,
    'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
    'const note = (line) => { try { fs.appendFileSync(logErr, `[dsh-plugin-galaxy] ${line}\\n`) } catch {} }',
    // "Free" means nothing accepts a connection, checked by CONNECTING rather
    // than by binding: binding to test would itself hold the port for the
    // moment the replacement needs it.
    'const listening = () => new Promise((resolve) => {',
    '  const probe = net.connect({ host: "127.0.0.1", port })',
    '  const done = (value) => { probe.destroy(); resolve(value) }',
    '  probe.on("connect", () => done(true))',
    '  probe.on("error", () => done(false))',
    '  setTimeout(() => done(false), 500)',
    '})',
    'const main = async () => {',
    '  if (port) {',
    '    const until = Date.now() + 30000',
    '    while (Date.now() < until && await listening()) await sleep(250)',
    '    if (await listening()) note(`port ${port} was still in use after 30s; starting anyway`)',
    '    await sleep(300)',
    '  } else {',
    '    await sleep(1500)',
    '  }',
    '  let child',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", out, err], env: process.env, shell: viaShell })',
    // spawn reports a missing or unexecutable file ASYNCHRONOUSLY; the
    // try/catch only covers the synchronous throw, so without this listener
    // that failure is exactly as silent as the bug being fixed.
    '    child.on("error", (error) => note(`could not start the replacement: ${error && error.message ? error.message : error}`))',
    '    child.unref()',
    '  } catch (error) {',
    '    note(`could not start the replacement: ${error && error.message ? error.message : error}`)',
    '    return',
    '  }',
    // Outliving the spawn matters on Windows: a helper that exits the instant
    // it has spawned can take the replacement with it, because the child is in
    // its process group and has not detached yet.
    '  if (!port) { await sleep(3000); return }',
    '  const upBy = Date.now() + 20000',
    '  while (Date.now() < upBy && !(await listening())) await sleep(500)',
    '  if (!(await listening())) note(`the replacement did not bind port ${port} within 20s — see the output log beside this one`)',
    '}',
    'main()',
  ].join('\n')
}

/**
 * Start the detached restart helper and return its pid.
 *
 * The helper waits for this pid to exit (port first, then a bounded poll)
 * before relaunching the same command line, and is `unref`ed so it survives
 * this process. Used by {@link restart.scheduleRestart}; exported so the
 * waiting can be exercised by running it.
 */
export function spawnRestartHelper(
  launch: { file: string; args: string[]; cwd: string; viaShell: boolean },
  port: number | null,
): number | undefined {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  const logs = {
    out: join(tmpdir(), `dsh-galaxy-restart-${stamp}.out.log`),
    err: join(tmpdir(), `dsh-galaxy-restart-${stamp}.err.log`),
  }
  const source = restartHelperSource(launch.file, launch.args, launch.cwd, launch.viaShell, logs, port)
  const helper = spawn(nodeExecutable(), ['-e', source], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
    windowsHide: true,
  })
  helper.unref()
  return helper.pid
}

/** Wait for the current process to exit, or for `ms` to pass, whichever is first. */
export function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  return new Promise<boolean>((settle) => {
    const tick = (): void => {
      const alive = isProcessAlive(pid)
      if (!alive) { settle(true); return }
      if (Date.now() >= deadline) { settle(false); return }
      const timer = setTimeout(tick, 250)
      timer.unref?.()
    }
    tick()
  })
}

/** Whether a pid still exists (`EPERM` means it exists but is not ours). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
