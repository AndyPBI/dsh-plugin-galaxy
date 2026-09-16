/**
 * Resolving a GitHub install through a region's proxy without proxying the
 * tarball pnpm records.
 *
 * pnpm does not fetch `github:owner/repo` with `git clone`; it resolves the
 * shortcut and downloads a tarball from codeload.github.com. Prefix-proxying
 * that tarball used to save time, but pnpm 11's fail-closed lockfile checks
 * changed the safety boundary: a URL shaped like
 * `https://proxy/https://codeload.github.com/.../<commit>` no longer has the
 * codeload hostname, so pnpm treats it as an ordinary remote tarball and
 * requires an integrity hash its GitHub resolver does not write
 * (ERR_PNPM_MISSING_TARBALL_INTEGRITY).
 *
 * The safe middle ground is to resolve HEAD through the regional route, then
 * hand pnpm a commit-pinned `github:owner/repo#<sha>` target. The ref lookup
 * avoids the slow/unreachable GitHub metadata request; pnpm itself fetches
 * the canonical codeload URL and keeps its integrity policy intact.
 *
 * - **The commit has to be pinned.** The profile reads each plugin's
 *   installed commit back out of the lockfile by matching a codeload URL
 *   ending in a 40-character SHA. A `HEAD` tarball installs perfectly and
 *   then reports no version forever.
 * - **A subpath entry is left alone.** `#path:/subdir` identifies a different
 *   package inside the repository, so the fragment is never rewritten.
 * - **Every failure falls back to the original target.** Acceleration is an
 *   optimisation, and an optimisation that can fail an install is a bug.
 */

import { logEvent } from '../core/log.ts'
import { marketFetch } from '../core/net.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { Region } from '../core/types.ts'
import { asRegion, githubRoutesFor, rememberGithubRoute } from './regions.ts'

/**
 * How long to wait for the SHA before giving up and installing directly.
 *
 * Short on purpose: this is spent BEFORE the download starts, and the whole
 * point is to avoid a slow or unreachable metadata lookup. A route that
 * cannot answer promptly should not delay pnpm's ordinary direct path.
 */
const RESOLVE_TIMEOUT_MS = 6000

/** A resolved HEAD is reused briefly; a push must become visible quickly. */
const HEAD_TTL_MS = 5 * 60 * 1000
const HEAD_CACHE_KEY = 'network.githubHead'

/** Parsed GitHub target: a repo plus an optional ref and subpath selector. */
export interface GithubTarget {
  /** `owner/repo`. */
  repo: string
  /** Branch, tag or `semver:` selector named in the spec, when any. */
  ref?: string
  /** Subpath selector (`#path:/sub`), which makes the spec ineligible. */
  subpath?: string
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA_RE = /^[0-9a-f]{40}$/u
const GITHUB_URL_RE = /^(?:git\+)?(?:https?:\/\/)?(?:www\.)?github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([^/?#]+))?(?:[?#].*)?$/iu

/**
 * Parse the GitHub source a spec names, in every supported spelling.
 *
 * @returns the parsed target, or null when the spec is not a GitHub source
 *   (an npm name, a local path, a private host) and must be left untouched.
 */
export function parseGithubTarget(spec: string): GithubTarget | null {
  const trimmed = spec.trim()
  if (trimmed.startsWith('github:')) {
    const rest = trimmed.slice('github:'.length)
    const hash = rest.indexOf('#')
    const identity = (hash === -1 ? rest : rest.slice(0, hash)).replace(/\.git$/u, '')
    if (!REPO_RE.test(identity)) return null
    if (hash === -1) return { repo: identity }
    const selector = rest.slice(hash + 1)
    if (selector === '') return { repo: identity }
    // A path selector identifies a different package inside the repository.
    // Any other selector expresses an explicit version/ref choice; a bare
    // commit is already pinned and needs no lookup.
    if (selector.startsWith('path:') || selector.includes('&')) return { repo: identity, subpath: selector }
    if (SHA_RE.test(selector)) return { repo: identity, ref: selector }
    return { repo: identity, ref: selector }
  }
  const url = GITHUB_URL_RE.exec(trimmed)
  if (url === null) return null
  return {
    repo: `${url[1]}/${url[2]}`,
    ...(url[3] === undefined ? {} : { ref: url[3] }),
  }
}

type HeadAttempt =
  | { kind: 'valid'; sha: string | null }
  | { kind: 'failed' }

/**
 * The commit `HEAD` points at, from git's own ref advertisement.
 *
 * This is the endpoint `git clone` reads before it fetches anything, and it is
 * the right one here for two measured reasons. It is not the REST API, so it
 * does not consume the 60-requests-per-hour unauthenticated quota that a user
 * installing a handful of plugins could plausibly exhaust. And it survives
 * prefix proxies: the response is git's pkt-line format, whose first ref line
 * carries `<sha> HEAD`, read with a pattern rather than a parser because one
 * 40-character hex string followed by `HEAD` is unambiguous in this payload.
 *
 * The same advertisement lists every branch and tag, which is what `ref`
 * uses: a plugin installed from `github:owner/repo#publish` is not asking
 * about the default branch at all, and answering with it made the update
 * check report an update forever. Branches are searched before tags because
 * that is what installs name.
 */
async function advertisementHead(
  base: string,
  repo: string,
  ref: string | undefined,
  signal: AbortSignal | undefined,
): Promise<HeadAttempt> {
  const url = `${base.replace(/\/+$/u, '')}/${repo}/info/refs?service=git-upload-pack`
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, RESOLVE_TIMEOUT_MS)
  try {
    const response = await marketFetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'git/2.40.0', accept: '*/*' },
    })
    if (!response.ok) return { kind: 'failed' }
    const body = await response.text()
    const contentType = response.headers?.get?.('content-type')?.toLowerCase() ?? ''
    // Public mirrors often answer a failed upstream request with their own
    // branded HTML and status 200. A git advertisement has both its service
    // prelude and at least one advertised ref; accepting anything else would
    // cache a route that never returned Git data in the first place.
    if (contentType.includes('text/html')
      || !body.includes('# service=git-upload-pack')
      || !/[0-9a-f]{40} (?:HEAD|refs\/(?:heads|tags)\/)/u.test(body)) {
      return { kind: 'failed' }
    }
    if (ref === undefined) {
      const found = /([0-9a-f]{40}) HEAD/u.exec(body)
      return { kind: 'valid', sha: found === null ? null : found[1] }
    }
    // Anchored to the ref's full name so `publish` cannot match a branch
    // called `publish-old`, and escaped because a ref may contain regex
    // metacharacters (`.` is legal in a branch name).
    const quoted = ref.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
    for (const namespace of ['heads', 'tags']) {
      const found = new RegExp(String.raw`([0-9a-f]{40}) refs/${namespace}/${quoted}(?![^\s])`, 'u').exec(body)
      if (found !== null) return { kind: 'valid', sha: found[1] }
    }
    // The advertisement is authoritative for this repository. Asking another
    // mirror cannot make a branch that is absent here appear.
    return { kind: 'valid', sha: null }
  } catch {
    return { kind: 'failed' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * Last resort: the public GitHub API, direct.
 *
 * Used only after every regional route failed. It is deliberately not
 * proxied: the documented prefix proxies refuse the API hostname, so wrapping
 * it would spend a request to receive the proxy's own error page.
 */
async function apiHead(repo: string, ref: string | undefined, signal: AbortSignal | undefined): Promise<string | null> {
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, RESOLVE_TIMEOUT_MS)
  try {
    const response = await marketFetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref ?? 'HEAD')}`, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-galaxy' },
    })
    if (!response.ok) return null
    const body = await response.json() as { sha?: unknown }
    return typeof body.sha === 'string' && SHA_RE.test(body.sha) ? body.sha : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * The current commit for a repo, on whichever route the region uses.
 *
 * Successful resolutions are cached for {@link HEAD_TTL_MS} per
 * (region, repo, ref). Failures are not cached: a route that was down a
 * minute ago must be retried, and a negative cache would keep an installer on
 * the slow direct path for the rest of the TTL.
 */
export async function resolveHeadCommit(
  repo: string,
  region: Region,
  runtime?: GalaxyRuntime,
  ref?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const key = `${region}\u0000${repo.toLowerCase()}\u0000${ref ?? ''}`
  const cache = runtime?.cache<Map<string, { at: number; sha: string | null }>>(HEAD_CACHE_KEY)
  const hit = cache?.get(key)
  if (hit !== undefined && Date.now() - hit.at < HEAD_TTL_MS) return hit.sha

  let sha: string | null = null
  for (const base of githubRoutesFor('git', region, runtime)) {
    const attempt = await advertisementHead(base, repo, ref, signal)
    if (attempt.kind === 'failed') continue
    rememberGithubRoute(runtime, 'git', base)
    sha = attempt.sha
    break
  }
  if (sha === null) sha = await apiHead(repo, ref, signal)
  if (sha !== null && cache !== undefined) cache.set(key, { at: Date.now(), sha })
  return sha
}

/**
 * Secondary call style used by the install pipeline
 * (`install.accelerateTarget` calls `accelerate(target, { region })`).
 *
 * Both spellings are accepted so the routing decision has exactly one
 * implementation: the contract form `(spec, region, runtime?, signal?)` and
 * the options form `(spec, { region, runtime?, signal? })`.
 */
export interface AccelerateTargetOptions {
  region?: Region
  runtime?: GalaxyRuntime
  signal?: AbortSignal
}

/**
 * The install target to actually hand pnpm, given the region in force.
 *
 * @param spec - the catalog/inventory source spec.
 * @param region - the download region, or the options object above.
 * @param runtime - carries the TTL cache and the route preferences.
 * @param signal - optional cancellation from the surrounding operation.
 * @returns a commit-pinned GitHub shortcut when a route resolves HEAD,
 *   otherwise `spec` unchanged.
 */
export async function acceleratedTarget(
  spec: string,
  region: Region | AccelerateTargetOptions = 'global',
  runtime?: GalaxyRuntime,
  signal?: AbortSignal,
): Promise<string> {
  const options: AccelerateTargetOptions = typeof region === 'string'
    ? {
        region,
        ...(runtime === undefined ? {} : { runtime }),
        ...(signal === undefined ? {} : { signal }),
      }
    : region
  const target = parseGithubTarget(spec)
  if (target === null) return spec
  if (target.subpath !== undefined) {
    logEvent('info', 'region', `${target.repo}: subpath target kept as-is (${spec})`)
    return spec
  }
  if (target.ref !== undefined && SHA_RE.test(target.ref)) return spec
  const activeRegion = asRegion(options.region) ?? 'global'
  const sha = await resolveHeadCommit(target.repo, activeRegion, options.runtime, target.ref, options.signal)
  if (sha === null) {
    logEvent('warn', 'region', `${target.repo}: no route resolved a commit; installing ${spec} unchanged`)
    return spec
  }
  return `github:${target.repo}#${sha}`
}
