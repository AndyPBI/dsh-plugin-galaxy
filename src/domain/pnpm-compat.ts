/**
 * pnpm compatibility: probing, provisioning and the allowBuilds allowlist.
 *
 * Everything the galaxy needs to know about how different pnpm majors behave
 * inside a dsh profile lives here, and none of it spawns a process: the only
 * handle on child processes is the runner from `dsh-cli.ts`
 * (`createCliRunner(config)`), which owns the spawn environment, the extra
 * PATH directories and the cancellation/timeout policy. A tool invocation is
 * expressed as an argv whose first element names the tool (`pnpm`, `corepack`,
 * `npm`); any other argv is a `dsh plugin …` subcommand.
 *
 * Verified behaviour that shapes the rules below (2026-08; pnpm 9.15.9 /
 * 10.28.2 / 11.21.0):
 *  - a workspace root rejects `add` without `-w` on pnpm 9, while every major
 *    rejects `-w` outside a workspace;
 *  - pnpm >= 10 blocks dependency build scripts by default and reports them
 *    through the ndjson `pnpm:ignored-scripts` event;
 *  - `node_modules` built by one pnpm major and mutated by another fails the
 *    modules-layout compatibility check.
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { writeJsonAtomic } from '../core/json.ts'
import { logEvent } from '../core/log.ts'
import { manifestPath, readProfileManifest } from '../core/profile.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { IgnoredBuilds, InstallResult, PnpmProbe, ResolvedConfig } from '../core/types.ts'
import { createCliRunner, pnpmExtraPathDirs, type PluginRunner } from './dsh-cli.ts'

/** A package name, npm's own grammar (scoped names allowed). */
const PACKAGE_NAME_RE = /^(@[A-Za-z0-9-~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9-~][A-Za-z0-9._~-]*$/u

/** ANSI colour/control sequences pnpm's pretty reporter emits. */
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/gu

const VERSION_RE = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u

/* ------------------------------------------------------------------ *
 * Tool invocation (through the runner only)
 * ------------------------------------------------------------------ */

/** Run one tool argv through the plugin runner, never throwing. */
async function runTool(
  runner: PluginRunner,
  profile: string,
  args: string[],
): Promise<InstallResult> {
  try {
    return await runner(profile, args)
  } catch (error) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: `could not start ${args[0] ?? 'the tool'}: ${(error as Error).message}`,
      timedOut: false,
      cancelled: false,
    }
  }
}

/** The contract's runner factory: it is built from the configuration alone. */
type RunnerFactory = (config: ResolvedConfig, runtime?: GalaxyRuntime) => PluginRunner

/**
 * Build the CLI runner for one probe/provision call.
 *
 * The published contract is `createCliRunner(config)`. A mount-scoped runner
 * additionally accepts the runtime so it can publish the cancellable process
 * slot (`/cancel`); that arity difference is absorbed here rather than at
 * every call site, and a runtime is passed through whenever the caller has
 * one.
 */
function makeRunner(config: ResolvedConfig, runtime: GalaxyRuntime | undefined): PluginRunner {
  const factory = createCliRunner as unknown as RunnerFactory
  return runtime === undefined ? factory(config) : factory(config, runtime)
}

/** The last few lines of a child process' output, for the log. */
function outputTail(result: InstallResult): string {
  return `${result.stdout}\n${result.stderr}`.trim().slice(-300)
}

/** The first semver-looking token in the output, when the tool printed one. */
function versionFrom(text: string): string | undefined {
  return VERSION_RE.exec(text)?.[1]
}

/**
 * Directories the galaxy is willing to look in for a `pnpm` executable.
 *
 * PATH first, then the directories `dsh-cli.ts` learned during a previous
 * provisioning (the npm global bin), then the conventional locations a GUI
 * launch loses — macOS Finder starts a process with a minimal PATH, and
 * telling that user pnpm "is not installed" is a lie they can disprove in
 * their own terminal.
 */
function lookupDirs(): string[] {
  const dirs: string[] = []
  for (const part of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    const dir = part.trim()
    if (dir !== '' && !dirs.includes(dir)) dirs.push(dir)
  }
  for (const dir of safeExtraPathDirs()) {
    if (dir !== '' && !dirs.includes(dir)) dirs.push(dir)
  }
  const home = homedir()
  for (const dir of [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(home, '.local', 'bin'),
    join(home, 'Library', 'pnpm'),
  ]) {
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

/** `pnpmExtraPathDirs()` from the CLI runner, tolerating a host that omits it. */
function safeExtraPathDirs(): string[] {
  try {
    return pnpmExtraPathDirs()
  } catch {
    return []
  }
}

/** The executable names a bare `pnpm` can resolve to on this platform. */
function executableNames(): string[] {
  return process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm.bat'] : ['pnpm']
}

/** Absolute path of a pnpm executable found without spawning anything. */
export function locatePnpm(): string | undefined {
  for (const dir of lookupDirs()) {
    for (const name of executableNames()) {
      const file = join(dir, name)
      if (!isExecutableFile(file)) continue
      return file
    }
  }
  return undefined
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
  } catch {
    return false
  }
  if (process.platform === 'win32') return true
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Probe and provision
 * ------------------------------------------------------------------ */

/** Ask the runner for `pnpm --version`, falling back to a filesystem lookup. */
async function probeWith(runner: PluginRunner, profile: string): Promise<PnpmProbe> {
  const located = locatePnpm()
  const result = await runTool(runner, profile, ['pnpm', '--version'])
  const version = result.exitCode === 0 ? versionFrom(result.stdout) : undefined
  if (version !== undefined) return { ok: true, version, ...(located === undefined ? {} : { path: located }) }
  if (located !== undefined) {
    // The binary is on a path the galaxy hands its children even though the
    // version question did not come back — report what can be verified.
    return { ok: true, path: located }
  }
  return { ok: false, hint: probeHint(result) }
}

/**
 * Report whether pnpm is usable for installs.
 *
 * The version comes from the runner; when the runner cannot answer but a
 * `pnpm` executable exists on a path the galaxy hands its children, the probe
 * reports that path rather than "missing". The weaker evidence is deliberate:
 * telling a user who has pnpm that it is absent sends them to reinstall a tool
 * they already own, and only the version question is lost.
 *
 * @param profile - profile name the runner works in.
 * @param config - resolved plugin configuration the runner is built from.
 * @param runtime - the mount, when the caller has one (enables `/cancel`).
 */
export async function probePnpm(
  profile: string,
  config: ResolvedConfig,
  runtime?: GalaxyRuntime,
): Promise<PnpmProbe> {
  return await probeWith(makeRunner(config, runtime), profile)
}

/**
 * Probe, then provision pnpm through corepack (which ships with Node) and a
 * global npm install as the fallback.
 *
 * `provisioned: true` means this call performed the install, which is what the
 * settings card reports back to the user.
 *
 * @param profile - profile name the runner works in.
 * @param config - resolved plugin configuration the runner is built from.
 * @param runtime - the mount, when the caller has one (enables `/cancel`).
 */
export async function provisionPnpm(
  profile: string,
  config: ResolvedConfig,
  runtime?: GalaxyRuntime,
): Promise<PnpmProbe> {
  const runner = makeRunner(config, runtime)
  const existing = await probeWith(runner, profile)
  if (existing.ok) return existing

  const corepack = await runTool(runner, profile, ['corepack', 'enable', 'pnpm'])
  logEvent(corepack.exitCode === 0 ? 'info' : 'warn', 'setup-pnpm',
    `corepack enable pnpm: exit=${corepack.exitCode} ${outputTail(corepack)}`)
  const afterCorepack = await probeWith(runner, profile)
  if (afterCorepack.ok) return { ...afterCorepack, provisioned: true }

  const npm = await runTool(runner, profile, ['npm', 'install', '-g', 'pnpm'])
  logEvent(npm.exitCode === 0 ? 'info' : 'error', 'setup-pnpm',
    `npm install -g pnpm: exit=${npm.exitCode} ${outputTail(npm)}`)
  const afterNpm = await probeWith(runner, profile)
  if (afterNpm.ok) return { ...afterNpm, provisioned: true }

  // The install may have succeeded into a directory this process does not
  // search yet: `pnpmExtraPathDirs` is the learned list, so a binary found
  // there is real, and the galaxy says what it found instead of claiming the
  // setup failed.
  const learned = locatePnpm()
  if (learned !== undefined) return { ok: true, path: learned, provisioned: true }

  return { ok: false, provisioned: false, hint: provisionHint(corepack, npm) }
}

/** A bilingual, actionable hint for a machine with no usable pnpm. */
function probeHint(result: InstallResult): string {
  const detail = outputTail(result)
  return `没有可用的 pnpm，插件安装无法进行。请在终端执行 \`corepack enable pnpm\` 或 \`npm install -g pnpm\`，然后重试`
    + ` / no usable pnpm was found, so plugin installs cannot run. Run \`corepack enable pnpm\` or \`npm install -g pnpm\` in a terminal and retry`
    + (detail === '' ? '' : `\n${detail}`)
}

function provisionHint(corepack: InstallResult, npm: InstallResult): string {
  const why = corepack.exitCode === 0 || npm.exitCode === 0
    ? '安装命令成功了，但 pnpm 仍然不可用（可能不在 PATH 上）。请退出并重新启动 dsh 后再试'
    : '自动安装失败（corepack 与 npm 都未成功）。请手动安装 pnpm 后重试'
  const en = corepack.exitCode === 0 || npm.exitCode === 0
    ? 'the installer reported success but pnpm is still not reachable (it may be off PATH) — restart dsh and retry'
    : 'automatic installation failed (both corepack and npm) — install pnpm by hand and retry'
  const detail = outputTail(npm) || outputTail(corepack)
  return `${why} / ${en}` + (detail === '' ? '' : `\n${detail}`)
}

/* ------------------------------------------------------------------ *
 * Output normalization
 * ------------------------------------------------------------------ */

/**
 * Decode pnpm's ndjson reporter into readable text.
 *
 * Mutating commands run with `--reporter=ndjson`, so an error's message
 * normally arrives as a JSON string: quotes escaped and embedded newlines as
 * `\n`. A user (and the log export) can read the decoded form; anything that
 * is not a recognizable event line is passed through untouched.
 */
export function normalizePnpmOutput(text: string): string {
  const lines: string[] = []
  for (const line of text.replace(ANSI_RE, '').replace(/\r\n/gu, '\n').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      lines.push(line)
      continue
    }
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      lines.push(line)
      continue
    }
    const messages = [asText(event.message), asText(asRecord(event.err)?.message)].filter(
      (value): value is string => value !== undefined,
    )
    if (messages.length === 0) {
      lines.push(line)
      continue
    }
    const prefix = [asText(event.level), asText(event.name)].filter(Boolean).join(' ')
    lines.push(`${prefix === '' ? '' : `[${prefix}] `}${messages.join('\n')}`)
  }
  return lines.join('\n')
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** pnpm reports version-qualified names; the allowlist keys are bare. */
function stripVersionSuffix(name: string): string {
  const trimmed = name.trim().replace(/\.$/u, '')
  const at = trimmed.lastIndexOf('@')
  return at > 0 ? trimmed.slice(0, at) : trimmed
}

/**
 * The packages pnpm reported as having their build scripts ignored.
 *
 * The ndjson `pnpm:ignored-scripts` event is the production shape
 * (`{"name":"pnpm:ignored-scripts","packageNames":["esbuild@0.21.5"]}`); the
 * human sentence ("Ignored build scripts: esbuild, koffi.") is the fallback
 * for a run that produced pretty output. Names are deduplicated and stripped
 * of their `@version` suffix, because the allowlist keys and the node_modules
 * lookups all use bare package names.
 *
 * @param stdout - the finished run's stdout.
 * @param stderr - its stderr; searched too, because pnpm has written the
 *   sentence to either stream across versions.
 * @returns the contract's {@link IgnoredBuilds} object. The value is ALSO a
 *   plain `string[]` of the names, so the install pipeline's
 *   `parseIgnoredBuilds(stdout, stderr): string[]` calling convention reads
 *   the same answer instead of silently finding nothing.
 */
export function parseIgnoredBuilds(stdout: string, stderr = ''): IgnoredBuilds {
  const text = `${stdout}\n${stderr}`
  const packages: string[] = []
  const detail: string[] = []
  const add = (raw: string): void => {
    const name = stripVersionSuffix(raw)
    if (name === '' || !PACKAGE_NAME_RE.test(name) || packages.includes(name)) return
    packages.push(name)
  }
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (event.name !== 'pnpm:ignored-scripts') continue
    const names = event.packageNames
    if (!Array.isArray(names)) continue
    detail.push(trimmed)
    for (const name of names) {
      if (typeof name === 'string') add(name)
    }
  }
  if (packages.length === 0) {
    const human = /Ignored build scripts:?\s*([^\n]+)/iu.exec(text)
    if (human !== null) {
      detail.push(human[0].trim())
      for (const chunk of human[1].split(',')) add(chunk)
    }
  }
  return asIgnoredBuilds(packages, detail)
}

/**
 * Build the dual-shaped result.
 *
 * A plain array carrying the object's fields, deliberately: `IgnoredBuilds`
 * (`{ packages, detail? }`) is the contract this module publishes, while group
 * F's install pipeline consumes the reference implementation's
 * `(stdout, stderr) => string[]` form. One value satisfies both, so neither
 * consumer loses the packages to a shape mismatch — and at the position where
 * the pipeline embeds it (`{ packages: parsed }`) it serializes as the
 * expected array either way.
 */
function asIgnoredBuilds(packages: string[], detailLines: string[]): IgnoredBuilds {
  const hybrid = [...packages] as string[] & { packages: string[]; detail?: string }
  hybrid.packages = [...packages]
  if (detailLines.length > 0) hybrid.detail = detailLines.join('\n')
  return hybrid
}

/* ------------------------------------------------------------------ *
 * allowBuilds
 * ------------------------------------------------------------------ */

/**
 * Allow the given packages' build scripts in the profile manifest
 * (`pnpm.allowBuilds`), merging with the existing entries.
 *
 * Only package names are accepted — the list is not free input, and the
 * merged set is what the route hands back to the UI. Presence in
 * `node_modules` is the caller's check (group F's approve-builds route),
 * because blocked build scripts usually belong to TRANSITIVE dependencies
 * that never appear in `package.json`.
 *
 * @param profile - profile name.
 * @param packages - names (with or without an `@version` suffix) to allow.
 * @param explicitDir - explicit profile directory (Desktop-owned).
 * @returns every package now allowed, in manifest order.
 */
export function setAllowBuilds(profile: string, packages: string[], explicitDir?: string): string[] {
  const file = manifestPath(profile, explicitDir)
  const manifest = readProfileManifest(profile, explicitDir)
  const pnpm = asRecord(manifest.pnpm) ?? {}
  const existing = Array.isArray(pnpm.allowBuilds)
    ? (pnpm.allowBuilds as unknown[]).filter((value): value is string => typeof value === 'string')
    : []
  const merged = [...existing]
  for (const candidate of packages) {
    const name = stripVersionSuffix(candidate)
    if (name === '' || !PACKAGE_NAME_RE.test(name) || merged.includes(name)) continue
    merged.push(name)
  }
  pnpm.allowBuilds = merged
  manifest.pnpm = { ...pnpm, allowBuilds: merged }
  writeJsonAtomic(file, manifest, 0o644)
  logEvent('info', 'approve-builds', `allowBuilds now lists ${merged.length} package(s)`)
  return merged
}

/* ------------------------------------------------------------------ *
 * Workspace flag
 * ------------------------------------------------------------------ */

/**
 * Decide the argv for a `dsh plugin <add|remove> …` call in a profile.
 *
 * pnpm 9 refuses to add at a workspace root without `-w`, and every pnpm
 * major refuses `-w` when the directory is NOT a workspace, so the flag is
 * injected exactly when the profile owns a `pnpm-workspace.yaml`.
 *
 * @param profileDir - resolved profile directory.
 * @param pluginArgs - the raw args, e.g. `['add', 'pkg@latest']`.
 */
export function pluginArgsFor(profileDir: string, pluginArgs: string[]): string[] {
  if (pluginArgs[0] !== 'add' && pluginArgs[0] !== 'remove') return pluginArgs
  if (!existsSync(join(profileDir, 'pnpm-workspace.yaml'))) return pluginArgs
  return [pluginArgs[0], '-w', ...pluginArgs.slice(1)]
}
