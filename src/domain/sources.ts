/**
 * Registry-source knowledge: how a curated catalog entry maps to an
 * installable package-manager target, and how a dependency spec is classified.
 * Pure string logic — no I/O, no network.
 *
 * What this module owns:
 *   - an install source is accepted only when the
 *    curated catalog publishes it,
 *   - the catalog entry shape this module reads,
 *   - used by the install preflight,
 *   - turning a chosen catalog card into a target,
 *   - naming specs a backup cannot reproduce.
 */

import type { InstallKind, Registry, RegistryPlugin } from '../core/types.ts'

/** Repository identity: exactly `owner/name`, no path or scheme. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** Registry tarball names must be plain npm package names, nothing fancier. */
export const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** A github.com repository URL, optionally with a `/tree/<ref>/<subpath>` suffix. */
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/

/** True when a dependency spec points at a local checkout or archive. */
export function isLocalSpec(spec: string): boolean {
  return /^(?:link|file|workspace):/i.test(spec.trim())
}

function stripGitSuffix(repo: string): string {
  return repo.replace(/\.git$/i, '')
}

function repoName(repo: string): string {
  const at = repo.lastIndexOf('/')
  return at === -1 ? repo : repo.slice(at + 1)
}

/** Valid subpath: no empty, dot or traversal segments. */
export function validSubpath(subpath: string): boolean {
  if (!/^[A-Za-z0-9_./-]+$/.test(subpath)) return false
  return !subpath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
}

/** Last path segment of a spec or URL, with any archive/git suffix removed. */
function basenameWithoutExt(value: string): string {
  const withoutQuery = value.trim().split(/[?#]/)[0] ?? ''
  const withoutSlash = withoutQuery.replace(/\/+$/u, '')
  const segment = withoutSlash.slice(withoutSlash.lastIndexOf('/') + 1)
  let decoded = segment
  try {
    decoded = decodeURIComponent(segment)
  } catch { /* keep the literal spelling for a malformed escape */ }
  return decoded.replace(/\.(?:git|tgz|tar\.gz|zip)$/i, '')
}

/** Normalize a value for comparison: trimmed, no trailing slash, lowercased. */
function comparisonKey(value: string): string {
  return value.trim().replace(/^git\+/i, '').replace(/\/+$/u, '').toLowerCase()
}

/** The `path:` selector of a `github:` fragment, or null when there is none. */
function subpathFromSelectors(fragment: string | undefined): string | null {
  for (const selector of (fragment ?? '').split('&')) {
    const match = /^path:\/(.+)$/.exec(selector)
    if (match === null) continue
    const candidate = match[1] as string
    return validSubpath(candidate) ? candidate : null
  }
  return null
}

/** Github target behind any spec spelling, or undefined when not GitHub. */
function githubTargetOf(spec: string): { repo: string; subpath: string | null } | undefined {
  const trimmed = spec.trim()

  // `github:owner/repo`, `github:owner/repo#path:/sub`,
  // `github:owner/repo#<sha>&path:/sub` — the market's canonical spelling.
  const shortcut = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.*))?$/.exec(trimmed)
  if (shortcut !== null) {
    const repo = stripGitSuffix(shortcut[1] as string)
    if (!REPO_RE.test(repo)) return undefined
    return { repo, subpath: subpathFromSelectors(shortcut[2]) }
  }

  // A commit-pinned codeload tarball, direct or behind a prefix proxy. Matched
  // unanchored because the proxy sits in FRONT of the real URL.
  const codeload = /codeload\.github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/tar\.gz\/[0-9a-fA-F]{40}/.exec(trimmed)
  if (codeload !== null) {
    const repo = stripGitSuffix(codeload[1] as string)
    return REPO_RE.test(repo) ? { repo, subpath: null } : undefined
  }

  // Any GitHub URL: https, git+https, ssh, or the scp form.
  const web = /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/[^/]+\/([^?#]+?))?(?:[?#]|$)/.exec(trimmed)
  if (web === null) return undefined
  const repo = stripGitSuffix(web[1] as string)
  if (!REPO_RE.test(repo)) return undefined
  const subpath = web[2] === undefined ? null : web[2]
  if (subpath !== null && !validSubpath(subpath)) return undefined
  return { repo, subpath }
}

/** Repo-verified npm name, then
 *  author-supplied release archive, then the repository itself. */
function targetForEntry(entry: RegistryPlugin): string | undefined {
  const npm = typeof entry.npm === 'string' ? entry.npm.trim() : ''
  const source = typeof entry.url === 'string' ? GITHUB_URL.exec(entry.url.trim()) : null
  const repo = source === null ? undefined : stripGitSuffix(source[1] as string)
  if (repo !== undefined && !REPO_RE.test(repo)) return undefined

  // An npm package is the cheapest target and skips local build scripts.
  if (npm !== '' && NPM_NAME_RE.test(npm)) return npm

  const tarball = typeof entry.tarball === 'string' ? entry.tarball.trim() : ''
  if (tarball !== '') {
    // A prebuilt archive belonging to the entry's own repository is accepted.
    // When the entry names no GitHub repo there is nothing to bind it to, so
    // the catalog's own row is the only evidence and it is trusted as such.
    if (repo === undefined || releaseTarballTarget(tarball, repo) !== undefined) return tarball
  }

  if (repo !== undefined) {
    const subpath = source === null ? null : source[2]
    if (subpath !== undefined && subpath !== null && !validSubpath(subpath)) return undefined
    return subpath === undefined || subpath === null ? `github:${repo}` : `github:${repo}#path:/${subpath}`
  }
  return undefined
}

/**
 * A curated prebuilt GitHub Release archive accepted as a package-manager
 * target — but only one belonging to `repo`, the entry's own repository.
 *
 * The binding is the point. The catalog row below would otherwise let a row
 * name a trusted repository and install an archive from somewhere else:
 *
 *     url:     https://github.com/good/plugin
 *     tarball: https://github.com/evil/repo/releases/download/v1/p.tgz
 *
 * The release CDNs are rejected for the same reason: their paths carry no
 * owner or repository, so there is nothing to bind the archive to.
 */
export function releaseTarballTarget(value: unknown, repo: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const target = value.trim()
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined
  if (!url.pathname.endsWith('.tgz') && !url.pathname.endsWith('.tar.gz')) return undefined
  const segments = url.pathname.split('/').filter(segment => segment !== '')
  if (segments.length < 4 || segments[2] !== 'releases') return undefined
  const owner = `${segments[0]}/${segments[1]}`
  return comparisonKey(owner) === comparisonKey(repo) ? target : undefined
}

/** Every install target the entry itself publishes, for source matching. */
function entryKeys(entry: RegistryPlugin): Set<string> {
  const keys = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') keys.add(comparisonKey(value))
  }
  add(entry.name)
  add(entry.npm)
  add(entry.tarball)
  add(entry.url)
  const target = targetForEntry(entry)
  if (target !== undefined) keys.add(comparisonKey(target))
  if (typeof entry.url === 'string') {
    const parsed = githubTargetOf(entry.url)
    if (parsed !== undefined) keys.add(comparisonKey(identityOf(parsed.repo, parsed.subpath) ?? ''))
  }
  return keys
}

/**
 * The package-manager target for a source the client
 * asked to install, or undefined when the curated catalog does not publish it.
 *
 * A page cannot make up an install source: the only strings this function can
 * return are derived from a catalog row, and the row is found by matching the
 * requested source against that row's own `url`, `npm`, `tarball` and `name`.
 * Matching is intentionally forgiving about spelling (case, trailing slash,
 * `git+` prefix, repository-identity form) because the point is to recognize
 * the catalog's own source, not to reject harmless variants of it.
 */
export function installTargetFor(registry: Registry, url: string): string | undefined {
  const requested = comparisonKey(url)
  if (requested === '') return undefined
  const requestedGithub = githubTargetOf(url)
  const requestedIdentity = requestedGithub === undefined
    ? undefined
    : identityOf(requestedGithub.repo, requestedGithub.subpath)
  for (const entry of registry.plugins) {
    if (!entryMatchesRequest(entry, requested, requestedIdentity)) continue
    const target = targetForEntry(entry)
    // A matched row with no usable source is skipped rather than ending the
    // search: a later row may publish the same source with an install target.
    if (target !== undefined) return target
  }
  return undefined
}

/** Whether a catalog row publishes the source the caller asked for. */
function entryMatchesRequest(
  entry: RegistryPlugin,
  requestedKey: string,
  requestedIdentity: string | undefined,
): boolean {
  if (entryKeys(entry).has(requestedKey)) return true
  if (requestedIdentity === undefined || typeof entry.url !== 'string') return false
  const parsed = githubTargetOf(entry.url)
  return parsed !== undefined && identityOf(parsed.repo, parsed.subpath) === requestedIdentity
}

/**
 * The package a spec installs, in a form that is useful without any I/O.
 *
 * @returns the install kind, the GitHub `owner/repo` when the spec is
 *   GitHub-hosted, and the name the package is expected to arrive under.
 */
export function parseSourceSpec(spec: string): { kind: InstallKind; repo?: string; packageName: string } {
  const trimmed = spec.trim()
  if (trimmed === '') return { kind: 'unknown', packageName: '' }

  const github = githubTargetOf(trimmed)
  if (github !== undefined) {
    return {
      kind: 'git',
      repo: github.repo,
      packageName: github.subpath === null ? repoName(github.repo) : basenameWithoutExt(github.subpath),
    }
  }

  if (isGitHostedSpec(trimmed)) {
    const name = basenameWithoutExt(trimmed)
    return { kind: 'git', packageName: name === '' ? 'plugin' : name }
  }

  if (isLocalSpec(trimmed)) {
    return { kind: 'local', packageName: basenameWithoutExt(trimmed.replace(/^[a-z]+:/i, '')) }
  }

  if (/\.(?:tgz|tar\.gz|zip)(?:[?#].*)?$/i.test(trimmed)) {
    return { kind: 'tarball', packageName: basenameWithoutExt(trimmed) }
  }

  if (/^npm:/i.test(trimmed)) {
    const aliased = npmNameFromSpec(trimmed.slice('npm:'.length))
    return { kind: 'alias', packageName: aliased ?? basenameWithoutExt(trimmed) }
  }

  const npm = npmNameFromSpec(trimmed)
  if (npm !== undefined) return { kind: 'npm', packageName: npm }
  return { kind: 'unknown', packageName: '' }
}

/** The npm package name a plain dependency spec names, or undefined. */
function npmNameFromSpec(spec: string): string | undefined {
  const first = spec.trim().split(/\s*\|\|\s*/u)[0]?.trim() ?? ''
  if (first === '' || first === '*' || first === 'latest') return undefined
  let name = first
  if (name.startsWith('@')) {
    const slash = name.indexOf('/')
    if (slash === -1) return undefined
    const versionAt = name.indexOf('@', slash)
    if (versionAt !== -1) name = name.slice(0, versionAt)
  } else {
    const versionAt = name.indexOf('@')
    if (versionAt !== -1) name = name.slice(0, versionAt)
  }
  return NPM_NAME_RE.test(name) ? name : undefined
}

/**
 * True when a spec installs from a git remote rather than from a registry —
 * GitHub shortcuts, codeload tarballs, and any other host.
 *
 * Used wherever "update this" must not silently degrade into "fetch the npm
 * package of the same name": a colliding registry package must never replace a
 * git install.
 */
export function isGitHostedSpec(spec: string): boolean {
  const trimmed = spec.trim()
  if (trimmed === '' || isLocalSpec(trimmed)) return false
  if (trimmed.startsWith('github:')) return true
  if (githubTargetOf(trimmed) !== undefined) return true
  if (/^git\+/i.test(trimmed) || /^git:\/\//i.test(trimmed) || /^ssh:\/\//i.test(trimmed)) return true
  if (/^git@[^/\s:]+:\S+/.test(trimmed)) return true
  if (/^https?:\/\/[^\s]+\/[^\s]+?\.git(?:[#?].*)?$/i.test(trimmed)) return true
  return looksLikeHttpsGitRemote(trimmed)
}

/**
 * `https://host/owner/repo` (optional `.git`, fragment, query) that is not an
 * npm registry, a release archive, or a codeload tarball. Deeper paths are too
 * ambiguous to treat as a git remote.
 */
function looksLikeHttpsGitRemote(spec: string): boolean {
  const bare = spec.trim().split(/[?#]/)[0] ?? ''
  let url: URL
  try {
    url = new URL(bare)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'registry.npmjs.org' || host.endsWith('.npmjs.org')) return false
  if (host === 'registry.npmmirror.com' || host === 'cdn.npmmirror.com') return false
  if (host === 'codeload.github.com') return false
  if (/\.(?:tgz|tar\.gz|zip)$/i.test(url.pathname)) return false
  if (/\/(?:releases|archive)\//i.test(url.pathname)) return false
  const segments = url.pathname.split('/').filter(segment => segment !== '')
  if (segments.length !== 2) return false
  const owner = segments[0] as string
  const repo = (segments[1] as string).replace(/\.git$/i, '')
  return /^[A-Za-z0-9_.-]+$/.test(owner) && /^[A-Za-z0-9_.-]+$/.test(repo)
}

/** Normalized repository identity, subpath-aware. */
function identityOf(repo: string, subpath: string | null): string | undefined {
  const normalized = repo.toLowerCase()
  if (!REPO_RE.test(normalized)) return undefined
  return subpath === null ? normalized : `${normalized}#path:/${subpath.toLowerCase()}`
}

/**
 * Repository identities carried by the dependency map, keyed by package name.
 *
 * A dependency spec spells its origin in several ways (`github:owner/repo`,
 * a proxied codeload tarball, a `git+https://…` remote, a `/tree/…` URL), and
 * a monorepo package is identified by its subpath rather than by the
 * collection root. Every spelling is reduced to one lowercase identity so two
 * records of the same plugin compare equal. Dependencies whose spec is a plain
 * registry range carry no repository evidence and are omitted; their identity
 * lives in the installed manifest, which this function cannot see.
 *
 * The single-URL overload answers the same question for one declared
 * `repository` field, where a collection root contributes both the root and
 * the subpath identity.
 */
export function githubRepoIdentities(deps: Record<string, string>): Record<string, string>
export function githubRepoIdentities(url: string, directory?: string | null): string[]
export function githubRepoIdentities(
  input: string | Record<string, string>,
  directory?: string | null,
): Record<string, string> | string[] {
  // One spell of the same question — "what repository does this name?" — used
  // both for a whole dependency map and for a single declared repository URL.
  if (typeof input === 'string') return remoteIdentitiesOf(input, directory)
  const identities: Record<string, string> = {}
  for (const [name, spec] of Object.entries(input)) {
    if (typeof spec !== 'string') continue
    const target = githubTargetOf(spec)
    if (target === undefined) continue
    const identity = identityOf(target.repo, target.subpath)
    if (identity !== undefined) identities[name] = identity
  }
  return identities
}

/** Identities a git remote contributes, best effort. */
function remoteIdentitiesOf(remote: string, directory?: string | null): string[] {
  const trimmed = remote.trim()
  if (trimmed === '') return []
  // A local origin may carry a proxy prefix (for example
  // `https://proxy/https://github.com/o/r.git`), so every occurrence is
  // considered and the LAST one wins: the proxy's own host is not GitHub.
  const matches = [...trimmed.matchAll(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=$|[\/?#\s])/giu)]
  const match = matches.at(-1)
  if (match === undefined) return []
  const repo = identityOf(stripGitSuffix(`${match[1]}/${match[2]}`), null)
  if (repo === undefined) return []
  const trimmedDirectory = typeof directory === 'string' ? directory.trim() : ''
  if (trimmedDirectory === '') return [repo]
  const subpath = trimmedDirectory.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  // A monorepo checkout contributes the collection root AND its own subpath,
  // mirroring the identities extracted from `github:owner/repo#path:/pkg`.
  return validSubpath(subpath) ? [repo, `${repo}#path:/${subpath.toLowerCase()}`] : [repo]
}

/**
 * Best-effort repository identities for a git remote (or a name → remote map).
 *
 * A remote may be unreadable, absent, or proxy-prefixed; every failure mode
 * returns an empty list rather than guessing. These identities are weak
 * evidence — a local checkout's origin — and callers must not use them to
 * reject a unique name/npm match, only to confirm one.
 */
export function githubRemoteIdentities(remote: string, directory?: string | null): string[]
export function githubRemoteIdentities(remotes: Record<string, string>, directory?: string | null): Record<string, string[]>
export function githubRemoteIdentities(
  input: string | Record<string, string>,
  directory?: string | null,
): string[] | Record<string, string[]> {
  if (typeof input === 'string') return remoteIdentitiesOf(input, directory)
  const identities: Record<string, string[]> = {}
  for (const [name, remote] of Object.entries(input)) {
    if (typeof remote !== 'string') continue
    identities[name] = remoteIdentitiesOf(remote, directory)
  }
  return identities
}

/** Absolute local path: POSIX, Windows drive-letter, or UNC. */
function isAbsolutePath(path: string): boolean {
  return /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)
}

/**
 * Dependency specs a backup cannot reproduce on another machine.
 *
 * A backup carries spec strings, not source trees. Three shapes therefore
 * cannot be restored faithfully:
 *   - `link:`/`file:` specs naming an absolute path (the path exists only on
 *     the machine that wrote it, so the restored install fails on it),
 *   - bare absolute path specs,
 *   - git-hosted specs, which resolve to whatever the remote's branch or HEAD
 *     happens to be at install time rather than to the code that was backed up.
 *
 * Relative `file:./vendor/x` specs are NOT reported: they resolve against the
 * profile directory, which a restore recreates, so they travel fine. Naming
 * these specs is what lets the operator decide before the install runs.
 */
export function unportableDeps(deps: Record<string, string>): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const spec of Object.values(deps)) {
    if (typeof spec !== 'string') continue
    const trimmed = spec.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    if (!isUnportableSpec(trimmed)) continue
    seen.add(trimmed)
    found.push(trimmed)
  }
  return found
}

function isUnportableSpec(spec: string): boolean {
  const local = /^(?:link|file):(.*)$/i.exec(spec)
  if (local !== null) {
    let path = local[1] as string
    try {
      path = decodeURIComponent(path)
    } catch { /* keep the literal spelling */ }
    return isAbsolutePath(path)
  }
  if (isAbsolutePath(spec)) return true
  return isGitHostedSpec(spec)
}
