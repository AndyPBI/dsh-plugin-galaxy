/**
 * Where the galaxy's profile facts come from, across host shapes.
 *
 * 0.2.x collapsed the old packaged-app contracts into one service,
 * `profileContext` (`apps/cli/src/profile-boot.ts` provides it for EVERY
 * dsh-launched profile, packaged or not):
 *
 *   { name, dir, patchPath, home, packageManager?: { command, args, env }, … }
 *
 * That replaced two services the Desktop shell used to provide:
 *
 *   - `desktopProfiles` — the app-owned profile list. Gone in 0.2.x; a plugin
 *     that still asks for it takes its non-desktop path and resolves the profile
 *     to `web`, i.e. it would read and mutate the WRONG profile. The Desktop host
 *     is not started as `dsh --profile <name>` at all (it spawns its own
 *     `dsh-desktop-host <runtimeDir> <projectDir> …`), so argv has no profile to
 *     fall back on either.
 *   - `desktopPnpm` — the app's package manager as a service that ran pnpm for
 *     the caller. In 0.2.x the app instead hands over its bundled runtime as
 *     `profileContext.packageManager` (`{command, args, env}`) and the plugin
 *     spawns it — which is also what makes Windows work, where pnpm is not on
 *     PATH inside a packaged app.
 *
 * `packageManager` is the packaged-app marker: a plain `dsh web`/`dsh` launch has
 * none (the CLI uses PATH pnpm). A packaged app also owns the process lifecycle,
 * so self-restart stays off there — the same reason the legacy Desktop branch
 * hard-coded `allowRestart: false`.
 *
 * Pure on purpose: the precedence rules are the part worth testing, and they can
 * be tested without a host.
 */

/** The app's own package manager, as `profileContext` reports it. */
export interface PnpmInvocationLike {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** `profileContext`, as much of it as a plugin may rely on. */
export interface ProfileContextLike {
  readonly name?: unknown
  readonly dir?: unknown
  readonly patchPath?: unknown
  readonly home?: unknown
  readonly packageManager?: unknown
}

/** `desktopProfiles` (≤ 0.1.5-rc.2): the app-owned profile list. */
export interface LegacyDesktopProfilesLike {
  readonly current?: { readonly name?: unknown; readonly dir?: unknown }
}

/** Everything the resolution reads, injected so it stays testable. */
export interface HostShapeInput {
  /** Operator configuration (`cordis` config); wins over every discovery. */
  readonly configuredProfile?: string | undefined
  /** `profileContext` on 0.2.x, `undefined` on older hosts. */
  readonly profileContext?: ProfileContextLike | undefined
  /** `desktopProfiles` on older Desktop shells. */
  readonly legacyDesktop?: LegacyDesktopProfilesLike | undefined
  /** `--profile <name>` from the process arguments, when the host was launched that way. */
  readonly argvProfile?: string | undefined
}

/** The resolved launch facts the mount configuration is built from. */
export interface HostShape {
  /** Profile to operate on. */
  readonly profile: string
  /**
   * Directory of that profile, when the host told us where its own profile
   * lives. Only set while the resolved profile IS the launched one — a profile
   * the operator configured explicitly keeps the standard `<DSH_HOME>/profiles/
   * <name>` layout, and pointing it at the launched directory would mutate the
   * wrong files.
   */
  readonly profileDirectory?: string
  /** The app's bundled package manager, when a packaged application supplied one. */
  readonly packageManager?: PnpmInvocationLike
  /** True when a packaged application owns this process (marker: `packageManager`). */
  readonly packaged: boolean
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Read `profileContext.packageManager` without trusting its shape. */
function packageManagerOf(value: unknown): PnpmInvocationLike | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { command?: unknown; args?: unknown; env?: unknown }
  const command = nonEmptyString(candidate.command)
  if (command === undefined) return undefined
  const args = Array.isArray(candidate.args)
    ? candidate.args.filter((entry): entry is string => typeof entry === 'string')
    : []
  const env: Record<string, string> = {}
  if (candidate.env !== null && typeof candidate.env === 'object') {
    for (const [key, entry] of Object.entries(candidate.env as Record<string, unknown>)) {
      if (typeof entry === 'string') env[key] = entry
    }
  }
  return { command, args, env }
}

/**
 * Resolve the profile the galaxy should manage, and the facts the mount needs.
 *
 * Precedence: operator config → `profileContext` → argv → legacy desktop → `web`.
 * The directory rides along only for the launched profile (see {@link HostShape}).
 */
export function resolveHostShape(input: HostShapeInput): HostShape {
  const launched = nonEmptyString(input.profileContext?.name)
  const launchedDir = nonEmptyString(input.profileContext?.dir)
  const legacyName = nonEmptyString(input.legacyDesktop?.current?.name)
  const legacyDir = nonEmptyString(input.legacyDesktop?.current?.dir)

  const profile = nonEmptyString(input.configuredProfile)
    ?? launched
    ?? nonEmptyString(input.argvProfile)
    ?? legacyName
    ?? 'web'

  const profileDirectory = profile === launched
    ? launchedDir
    : profile === legacyName
      ? legacyDir
      : undefined

  const packageManager = packageManagerOf(input.profileContext?.packageManager)
  return {
    profile,
    ...(profileDirectory === undefined ? {} : { profileDirectory }),
    ...(packageManager === undefined ? {} : { packageManager }),
    packaged: packageManager !== undefined,
  }
}

/** The only context capability the reader needs — a cordis `Context` satisfies it. */
export interface ServiceReader {
  get(name: string): unknown
}

/**
 * Read `profileContext` from a host context, tolerantly.
 *
 * Only `get` is used: a cordis context throws on an un-injected property READ,
 * and this runs while the plugin mounts — an exception here would leave it
 * half-mounted. A host without the service simply returns `undefined`.
 */
export function readProfileContext(ctx: ServiceReader): ProfileContextLike | undefined {
  try {
    const service = ctx.get('profileContext')
    return service === null || typeof service !== 'object' ? undefined : service as ProfileContextLike
  } catch {
    return undefined
  }
}
