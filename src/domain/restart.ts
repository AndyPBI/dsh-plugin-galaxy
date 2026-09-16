/**
 * Self-restart, and the deployment shapes where it must not
 * be offered.
 *
 * Relaunching the exact invocation that booted this host is what lets pending
 * (non-hot) plugin changes take effect without the user leaving the UI. It is
 * also the most dangerous thing this plugin does, and every guard below exists
 * because the reference implementation broke a real host once:
 *
 *  - **Under systemd's default `KillMode=control-group`, everything in the
 *    unit's cgroup dies with the main process** — including the detached helper
 *    that was supposed to bring the replacement up. "Restart" killed a
 *    production service and nothing came back (#229). `allowRestart: false`
 *    was always the documented answer, but it is opt-in, so an unconfigured
 *    supervised host is treated as supervised-and-off until an operator says
 *    otherwise.
 *  - **`INVOCATION_ID` is INHERITED.** Every descendant of a unit carries it,
 *    which on Linux includes an ordinary desktop terminal and a CI runner, so
 *    an environment check alone would disable the button for a large
 *    population of hosts where it works fine. The operator's explicit
 *    `allowRestart: true` is this implementation's second signal: it is the
 *    documented way to say "my unit is configured to tolerate a replacement",
 *    and it needs no `/proc` read to be correct.
 *  - **A debug session must never be killed from the UI**, and unlike systemd
 *    there is no deployment shape where it is right — so `allowRestart: true`
 *    does not override the debugger latch either.
 *
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import inspector from 'node:inspector'
import { logEvent } from '../core/log.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { RestartCapability, RestartSchedule, ResolvedConfig } from '../core/types.ts'
import {
  dshLaunch,
  isProcessAlive,
  RESTART_HELPER_WAIT_MS,
  spawnRestartHelper,
  waitForExit,
} from './dsh-cli.ts'

/** Inspect-flag prefixes treated as "a debugger owns this process". */
const INSPECT_ARG_PREFIXES = ['--inspect', '--inspect-brk', '--inspect-port', '--inspect-wait', '--debug', '--debug-brk'] as const

/** Whether one argv token selects an inspector. */
function tokenHasInspectFlag(token: string): boolean {
  return INSPECT_ARG_PREFIXES.some(prefix => token === prefix || token.startsWith(`${prefix}=`))
}

/**
 * The process supervisor running this host, when one can be identified.
 *
 * Deliberately conservative: returning a name disables one-click restart for
 * an unconfigured host, so a guess costs a working feature. Each signal is
 * therefore an explicit marker the supervisor itself sets.
 *
 * @param env - environment to inspect.
 * @param container - the `/.dockerenv` probe, injectable for tests.
 * @param platform - `process.platform`, injectable for tests.
 * @returns `'systemd' | 'launchd' | 'pm2' | 'docker'`, or undefined.
 */
export function detectedSupervisor(
  env: NodeJS.ProcessEnv = process.env,
  container: () => boolean = hasDockerEnvFile,
  platform: string = process.platform,
): string | undefined {
  const set = (name: string): boolean => (env[name] ?? '').trim() !== ''
  if (set('INVOCATION_ID') || set('JOURNAL_STREAM')) return 'systemd'
  if (set('XPC_SERVICE_NAME')) return 'launchd'
  if (set('PM2_HOME') || set('pm_id') || set('pm2_instance_name')) return 'pm2'
  // `container` is what container runtimes export into their workloads; the
  // `/.dockerenv` marker is the same statement on older runtimes, Linux-only.
  if (set('container')) return 'docker'
  if (platform === 'linux' && container()) return 'docker'
  return undefined
}

/** Whether `/.dockerenv` exists (the Docker marker on a Linux host). */
function hasDockerEnvFile(): boolean {
  return existsSync('/.dockerenv')
}

/**
 * Whether this host process is under a debugger.
 *
 * Primary signal: an open inspector (`--inspect` at boot, `inspector.open()`,
 * or a SIGUSR1 attach). Secondary: inspect-family flags in `execArgv` and
 * `NODE_OPTIONS`, matched by token PREFIX — not an `/inspect/` substring, so a
 * script path like `.../inspect-tool.js` does not false-positive.
 *
 * @param execArgv - `process.execArgv`, injectable for tests.
 * @param nodeOptions - `NODE_OPTIONS`, injectable for tests.
 * @param inspectorUrl - open inspector URL, injectable for tests.
 * @returns `'inspector'`, or undefined.
 */
export function detectedDebugger(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? '',
  inspectorUrl: string | undefined = currentInspectorUrl(),
): string | undefined {
  if (inspectorUrl !== undefined && inspectorUrl !== '') return 'inspector'
  if (execArgv.some(tokenHasInspectFlag)) return 'inspector'
  const options = nodeOptions.trim()
  if (options !== '' && options.split(/\s+/u).some(tokenHasInspectFlag)) return 'inspector'
  return undefined
}

/** The open inspector's URL, read through the process's own inspector module. */
function currentInspectorUrl(): string | undefined {
  try {
    const url = inspector.url()
    return url === '' ? undefined : url
  } catch {
    return undefined
  }
}

/**
 * Whether the restart button should be shown at all.
 *
 * An explicit `true` always wins: an operator who configured their unit for a
 * surviving replacement (`KillMode=process`, or a wrapper that outlives it) is
 * making a statement about their own deployment, and this must not overrule it.
 * An explicit `false` always loses. The debugger guard is applied separately in
 * {@link restartCapability} and cannot be configured away.
 */
export function restartAllowed(config: { allowRestart?: boolean }): boolean {
  if (config.allowRestart !== undefined) return config.allowRestart
  return detectedSupervisor() === undefined
}

/**
 * The full restart posture reported on `GET /status` and enforced by the route.
 *
 * @param config - the resolved mount configuration.
 * @param runtime - the mount, for the already-scheduled latch.
 */
export function restartCapability(config: ResolvedConfig, runtime: GalaxyRuntime): RestartCapability {
  const supervisor = detectedSupervisor()
  const debuggerAttached = detectedDebugger() !== undefined
  const base: RestartCapability = {
    allowed: false,
    ...(supervisor === undefined ? {} : { supervisor }),
    debugger: debuggerAttached,
    scheduled: runtime.restartScheduled,
  }
  if (config.allowRestart === false) {
    return { ...base, reason: 'self-restart is disabled by configuration (allowRestart: false) / 配置已关闭自重启（allowRestart: false）' }
  }
  if (debuggerAttached) {
    return { ...base, reason: 'self-restart is disabled while the host is under a debugger / 宿主处于调试器下，已关闭自重启' }
  }
  if (supervisor !== undefined && config.allowRestart !== true) {
    return {
      ...base,
      reason: `this host runs under ${supervisor}, which owns restarts — set allowRestart: true only if that supervisor tolerates a replacement / 该宿主由 ${supervisor} 托管，重启应由它负责；只有在托管方允许被替换时才应设置 allowRestart: true`,
    }
  }
  return { ...base, allowed: true }
}

/** The port carried by a request Host header, when it names one. */
export function servingPort(request: { headers: { host?: string | undefined } }): number | null {
  const host = request.headers.host
  if (host === undefined) return null
  const match = /:(\d{1,5})$/u.exec(host)
  if (match === null) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/**
 * Schedule a detached helper that waits for the current pid to exit and then
 * relaunches the same command line.
 *
 * Refuses, with a reason and no side effects, while a mutation holds the
 * mutation lock: replacing the host in the middle of an install would leave
 * pnpm mid-write. A second call answers `{ scheduled: true, reason: 'already
 * scheduled' }` rather than starting a second helper, because two helpers
 * racing to bind one port is a restart that never comes back.
 *
 * @param config - the resolved mount configuration (restart posture source).
 * @param runtime - the mount owning the lock and the scheduled latch.
 * @param port - port the replacement must bind, when known.
 */
export async function scheduleRestart(
  config: ResolvedConfig,
  runtime: GalaxyRuntime,
  port: number | null = null,
): Promise<RestartSchedule> {
  // The route answers 403 from the same capability; re-checking here keeps a
  // direct caller (the v1 API, a test) from bypassing the posture.
  const capability = restartCapability(config, runtime)
  if (!capability.allowed) {
    return { scheduled: false, reason: capability.reason ?? 'self-restart is not allowed for this host' }
  }
  if (runtime.restartScheduled) return { scheduled: true, reason: 'already scheduled' }
  if (runtime.locks.isBusy()) {
    const busy = runtime.locks.busyReason()
    return {
      scheduled: false,
      reason: `a plugin operation is running (${busy ?? 'unknown'}); restart refused / 有插件操作正在执行，已拒绝重启`,
    }
  }
  const launch = dshLaunch()
  const argv = [...launch.args, ...process.argv.slice(2)]
  logEvent('info', 'restart', `scheduling a restart helper for pid ${String(process.pid)}`)
  let helperPid: number | undefined
  try {
    helperPid = spawnRestartHelper(
      { file: launch.file, args: argv, cwd: launch.cwd ?? process.cwd(), viaShell: launch.viaShell },
      port,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logEvent('error', 'restart', `could not start the restart helper: ${message}`)
    return { scheduled: false, reason: message }
  }
  runtime.restartScheduled = true
  // The helper polls for this pid's exit before relaunching; this process asks
  // for its own termination only after the handoff is in place, and only if the
  // helper is actually alive.
  const selfPid = process.pid
  const timer = setTimeout(() => {
    if (helperPid !== undefined && !isProcessAlive(helperPid)) {
      logEvent('error', 'restart', 'the restart helper exited before the handoff; the host was left running')
      runtime.restartScheduled = false
      return
    }
    try {
      process.kill(selfPid, 'SIGTERM')
    } catch (error) {
      logEvent('warn', 'restart', `could not signal this process: ${(error as Error).message}`)
    }
  }, 500)
  timer.unref?.()
  return {
    scheduled: true,
    ...(helperPid === undefined ? {} : { helperPid }),
    boot: runtime.bootId,
  }
}

/**
 * Wait for a process to exit, bounded. Exported so a route or a test can drive
 * a real helper process rather than assert on the delay alone.
 */
export async function awaitProcessExit(pid: number, ms?: number): Promise<boolean> {
  return ms === undefined ? await waitForExit(pid, RESTART_HELPER_WAIT_MS) : await waitForExit(pid, ms)
}

/**
 * Relaunch the current command line once, without a helper. Kept for the
 * diagnostics path (a host with no port to wait on) and for tests.
 */
export function relaunchInPlace(): number | undefined {
  const launch = dshLaunch()
  const child = spawn(launch.file, [...launch.args, ...process.argv.slice(2)], {
    ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
    detached: true,
    stdio: 'ignore',
    env: process.env,
    shell: launch.viaShell,
    windowsHide: true,
  })
  child.unref()
  return child.pid
}
