#!/usr/bin/env node
/**
 * Fetch the opc-catalog working tree: clone every repo in opc-plugins.json and
 * sort it into MIT/ or non-MIT/ by the *repository's* license.
 *
 * Why this file exists again: the step that produced the 2026-09-14 catalog was
 * run inline and never saved, so `catalog/opc-plugins.json` could be regenerated
 * but its 281 clones could not. This rewrites that step against the contract the
 * surviving artifacts define (see CONTRACT below) — nothing invents new fields.
 *
 * CONTRACT (pinned from the 2026-09-14 artifacts; do not change casually —
 * PBISimulation-Frontend/scripts/build-plugin-catalog.mjs reads these):
 *
 *   MANIFEST.tsv   header: name / repo / kind / url / local_folder / local_subpath
 *                  one row per opc-plugins.json entry, IN THE SAME ORDER
 *                  kind          = "monorepo-subpath" | "standalone"  (from entry.monorepo)
 *                  local_folder  = <MIT|non-MIT>/<owner>__<repo>
 *                  local_subpath = the monorepo subpath, "" for standalone
 *
 *   download_report.json
 *                  { total_rows, unique_repos, unparsed_urls,
 *                    summary: { ok, failed },
 *                    repos: [{ owner, repo, status, folder, branch, subpaths, error }] }
 *                  `folder` is recorded even when the clone fails — the license
 *                  is decided BEFORE cloning, from the GitHub API.
 *
 * Three facts drive the design:
 *
 *  1. **The license is the REPOSITORY's, not the package's.** The consumer only
 *     ships the MIT/ directory, and package.json lies in both directions: 11
 *     repos declare nothing yet are MIT, and 2 monorepo subpackages claim MIT
 *     while the repo is Apache-2.0/AGPL. So: ask GitHub (which detects from the
 *     LICENSE file and other sources), never read package.json.
 *  2. **Clone URL and plugin identity are different things.** One repo yields up
 *     to 3 catalog entries (`zhu1090093659/dsh-web` has 3 subpaths). Repos are
 *     therefore deduplicated for cloning, while MANIFEST keeps all 290 rows.
 *  3. **The API is the bottleneck, not the disk.** 282 repos unauthenticated is
 *     60 req/h ≈ 5 h. With a token it is seconds. Set GITHUB_TOKEN (or
 *     DSHG_GITHUB_TOKEN). Without one the script still works but warns, and
 *     --offline falls back to reading the LICENSE text from an existing clone.
 *
 * Usage:
 *   node scripts/fetch-opc-catalog.mjs --dry-run          # show the plan, touch nothing
 *   node scripts/fetch-opc-catalog.mjs --verify           # re-check existing clones, no cloning
 *   node scripts/fetch-opc-catalog.mjs                    # fetch what is missing
 *   GITHUB_TOKEN=… node scripts/fetch-opc-catalog.mjs
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1]
}
const flag = name => process.argv.includes(name)

const catalogDir = resolve(
  arg('--catalog-dir', process.env.OPC_CATALOG_DIR || join(homedir(), 'Documents/9.Project/项目开发/opc-catalog')),
)
const jobs = Math.max(1, Number(arg('--jobs', '4')))
const limit = arg('--limit', null) === null ? Infinity : Number(arg('--limit'))
const dryRun = flag('--dry-run')
const verifyOnly = flag('--verify')
const offline = flag('--offline')
const force = flag('--force')
/**
 * Path to the published `ranking.json`. When given, every plugin in its top
 * window is re-checked against the npm registry and re-cloned if it has moved on.
 *
 * Without this the clones are write-once: the skip below means a repo cloned in
 * September still reports its September version forever, so the site shows a
 * stale `version` for the plugins that matter most — the ones on the leaderboard.
 */
const refreshRanked = arg('--refresh-ranked', null)

const token = process.env.GITHUB_TOKEN || process.env.DSHG_GITHUB_TOKEN || ''

/* ------------------------------------------------------------------ *
 * Source list
 * ------------------------------------------------------------------ */

/**
 * Parse a catalog URL into the clone target plus any monorepo subpath.
 *
 *   https://github.com/o/r                        -> { owner, repo, branch: null, subpath: null }
 *   https://github.com/o/r/tree/main/plugins/x    -> { owner, repo, branch: 'main', subpath: 'plugins/x' }
 *
 * Returns null for anything else; the caller collects those into
 * `unparsed_urls` rather than guessing, because a wrong URL here silently
 * clones the wrong repository.
 */
export function parseRepoUrl(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)\/(.+?))?\/?$/.exec(url ?? '')
  if (!match) return null
  const [, owner, repo, branch, subpath] = match
  return { owner, repo, branch: branch ?? null, subpath: subpath ?? null }
}

/** readManifest — re-read an existing MANIFEST.tsv keyed by url (the join key the consumer uses). */
export function readManifest(text) {
  const [header, ...lines] = text.trim().split('\n')
  const cols = header.split('\t')
  return lines.filter(Boolean).map(line => {
    const cells = line.split('\t')
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']))
  })
}

/** Collapse the 290 catalog entries into the 282-ish repos that actually get cloned. */
export function groupByRepo(plugins) {
  const byKey = new Map()
  const unparsed_urls = []
  for (const entry of plugins) {
    const parsed = parseRepoUrl(entry.url)
    if (!parsed) {
      unparsed_urls.push(entry.url ?? null)
      continue
    }
    const key = `${parsed.owner}/${parsed.repo}`
    if (!byKey.has(key)) byKey.set(key, { owner: parsed.owner, repo: parsed.repo, branch: null, subpaths: [] })
    const repo = byKey.get(key)
    if (parsed.branch) repo.branch = parsed.branch
    if (parsed.subpath && !repo.subpaths.includes(parsed.subpath)) repo.subpaths.push(parsed.subpath)
  }
  return { repos: [...byKey.values()], unparsed_urls }
}

/* ------------------------------------------------------------------ *
 * License — repository level, never package.json
 * ------------------------------------------------------------------ */

/**
 * Ask GitHub for the repository's detected license.
 *
 * `license.spdx_id` is "MIT" for MIT repos and "NOASSERTION"/null otherwise.
 * This is the same detection the repo page shows, so it absorbs the awkward
 * cases the consumer's CLAUDE.md calls out.
 */
async function licenseFromApi({ owner, repo }) {
  let response
  try {
    response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-plugin-galaxy-fetch-opc-catalog',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
  } catch (e) {
    // Unreachable / reset / TLS failure. Must be caught: this runs once per repo,
    // and an unhandled rejection here killed the whole run on a flaky network.
    return { spdx: null, error: `网络不可达（${e?.cause?.code ?? e?.message ?? 'fetch failed'}）` }
  }
  if (response.status === 404) return { spdx: null, error: 'repo not found (404)' }
  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining')
    return { spdx: null, error: `HTTP ${response.status}${remaining === '0' ? ' (rate limit exhausted)' : ''}` }
  }
  let body
  try {
    body = await response.json()
  } catch {
    // Headers arrived but the body did not — same class of failure as above.
    return { spdx: null, error: '响应体读取失败' }
  }
  return { spdx: body?.license?.spdx_id ?? null, error: null }
}

/**
 * Classify from an already-cloned tree — the --offline path, and the only way to
 * check a repo when the API is unreachable.
 *
 * Deliberately conservative: it recognises the MIT body text, and calls
 * everything else non-MIT. That under-includes rather than over-includes, which
 * is the safe direction when the consumer ships only MIT/.
 */
export function licenseFromLocalTree(dir) {
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING']
  for (const name of candidates) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8').slice(0, 20_000)
    const isMit =
      /permission is hereby granted, free of charge/i.test(text) && /THE SOFTWARE IS PROVIDED "AS IS"/i.test(text)
    return { spdx: isMit ? 'MIT' : null, error: null }
  }
  return { spdx: null, error: 'no LICENSE file in clone' }
}

/** The only place the MIT/non-MIT split is decided. */
export const licenseDirFor = spdx => (spdx === 'MIT' ? 'MIT' : 'non-MIT')

/* ------------------------------------------------------------------ *
 * Ranked refresh — keep the leaderboard's plugins on their current release
 * ------------------------------------------------------------------ */

/**
 * Compare two versions, returning >0 when `a` is newer.
 *
 * Needed because "different" is not "newer": a repo whose package.json carries an
 * unreleased dev version (0.3.11 while npm still serves 0.3.7) would otherwise be
 * re-cloned every run for no change, and a prerelease would be reported as an
 * upgrade when it is actually ahead (`0.3.3-rc.1` vs `0.3.2`). Returns null when
 * either side is not a version we understand.
 */
export function compareVersions(a, b) {
  const parse = value => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? '').trim())
    if (!match) return null
    return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null }
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return null

  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1
  }
  // A release outranks any prerelease of the same core version.
  if (left.pre === right.pre) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1

  const l = left.pre.split('.')
  const r = right.pre.split('.')
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === undefined) return -1
    if (r[i] === undefined) return 1
    if (l[i] === r[i]) continue
    const ln = /^\d+$/.test(l[i])
    const rn = /^\d+$/.test(r[i])
    if (ln && rn) return Number(l[i]) > Number(r[i]) ? 1 : -1
    if (ln !== rn) return ln ? -1 : 1 // numeric identifiers rank below alphanumeric
    return l[i] > r[i] ? 1 : -1
  }
  return 0
}

/** npm `dist-tags.latest`, or null when unknown (offline, 404, unpublished). */
async function npmLatest(pkg) {
  let response
  try {
    // Scoped names (`@scope/name`) are accepted verbatim in the path — the
    // registry does not want the slash percent-encoded.
    response = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
  } catch {
    return null
  }
  if (!response.ok) return null
  try {
    return (await response.json())['dist-tags']?.latest ?? null
  } catch {
    return null
  }
}

/**
 * Which license directory a repo is ALREADY filed under, or null.
 *
 * Used to refuse a downgrade: when the API cannot answer (rate limit, outage),
 * `spdx` is null and `licenseDirFor(null)` says non-MIT — which would rewrite the
 * MANIFEST entry of a repo that is sitting in MIT/, and the frontend generator
 * reads that first path segment to decide what ships. One API hiccup would
 * therefore delete the plugin from the website.
 */
function existingLicenseDir(catalogDir, owner, repo) {
  for (const dir of ['MIT', 'non-MIT']) {
    if (existsSync(join(catalogDir, dir, `${owner}__${repo}`))) return dir
  }
  return null
}

/** Version declared in an already-cloned tree, or null if there is no clone there. */
function localVersion(catalogDir, folder, subpath) {
  // `folder` is empty when the license step could not decide a directory.
  if (!folder) return null
  const candidates = [
    join(catalogDir, folder, subpath ?? '', 'package.json'),
    join(catalogDir, folder, 'package.json'),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/u, '')).version ?? null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Which leaderboard repos have a published version newer than their clone.
 *
 * Contract detail that matters: ranking keys are `owner/name`, and for a monorepo
 * `name` is `Repo#subpath`, so several keys can point at one repo. Results are
 * therefore keyed by REPO — re-cloning is per repo, not per plugin.
 */
async function findStaleRanked(repos, plugins) {
  if (!refreshRanked) return { stale: new Map(), unchecked: [] }
  // Same rule as everywhere else: --offline means no network, and the npm
  // registry is network.
  if (offline) return { stale: new Map(), unchecked: [{ key: '(全部)', reason: '--offline，跳过排行榜版本检查' }] }
  if (!existsSync(refreshRanked)) {
    console.error(`--refresh-ranked 指向的 ${refreshRanked} 不存在，跳过排行榜版本检查`)
    return { stale: new Map(), unchecked: [] }
  }

  const ranking = JSON.parse(readFileSync(refreshRanked, 'utf8'))
  const keys = (ranking.top ?? []).map(entry => entry.key)
  if (keys.length === 0) return { stale: new Map(), unchecked: [] }

  const pluginByKey = new Map(plugins.map(p => [`${p.owner ?? ''}/${p.name ?? ''}`, p]))
  const repoByKey = new Map(repos.map(r => [`${r.owner}/${r.repo}`.toLowerCase(), r]))

  // Resolve each ranking key to its repo + npm package once, then query npm in
  // batches — serially would be ~15 s of dead time for no reason.
  const candidates = []
  const unchecked = []
  for (const key of keys) {
    const plugin = pluginByKey.get(key)
    const parsed = plugin ? parseRepoUrl(plugin.url) : null
    if (!parsed) {
      unchecked.push({ key, reason: '排行榜条目在本轮目录里找不到对应来源' })
      continue
    }
    if (!plugin.npm) {
      unchecked.push({ key, reason: '未声明 npm 包，无法比对版本' })
      continue
    }
    candidates.push({ key, npm: plugin.npm, repo: repoByKey.get(`${parsed.owner}/${parsed.repo}`.toLowerCase()) })
  }

  const stale = new Map()
  const BATCH = 10
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH)
    const latest = await Promise.all(batch.map(c => npmLatest(c.npm)))
    batch.forEach((candidate, index) => {
      const newest = latest[index]
      if (!candidate.repo) return
      const repoKey = `${candidate.repo.owner}/${candidate.repo.repo}`
      const folder = ['MIT', 'non-MIT']
        .map(d => `${d}/${candidate.repo.owner}__${candidate.repo.repo}`)
        .find(d => existsSync(join(catalogDir, d)))
      const current = localVersion(catalogDir, folder, candidate.repo.subpaths[0])
      if (!newest) {
        unchecked.push({ key: candidate.key, reason: `npm 查询失败（${candidate.npm}）` })
        return
      }
      // `current === null` means the clone is missing/versionless — that repo
      // gets cloned anyway, so it is not a "refresh".
      if (current === null) return
      if (current === newest) return
      // Only a genuinely NEWER published version counts. Unparseable versions
      // fall back to "different", which is the conservative direction: worst case
      // is a redundant re-clone, never a silently frozen plugin.
      const order = compareVersions(newest, current)
      if (order !== null && order <= 0) return
      stale.set(repoKey.toLowerCase(), { key: candidate.key, npm: candidate.npm, from: current, to: newest })
    })
  }

  return { stale, unchecked }
}

/* ------------------------------------------------------------------ *
 * Clone
 * ------------------------------------------------------------------ */

/**
 * Shallow, single-branch, blobless — the flags the 2026-09-14 run used, which is
 * what keeps 281 repos at ~2.1 GB instead of tens of GB.
 *
 * Clones into a staging path first and only then moves into MIT/ or non-MIT/:
 * a killed run then leaves at most one stray directory instead of a half-cloned
 * repo that looks complete to a resume check.
 */
async function cloneRepo({ owner, repo }, destDir, stageRoot) {
  const name = `${owner}__${repo}`
  const stage = join(stageRoot, name)
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true })
  await run(
    'git',
    ['clone', '--quiet', '--depth', '1', '--single-branch', '--filter=blob:none', `https://github.com/${owner}/${repo}.git`, stage],
    { maxBuffer: 32 * 1024 * 1024 },
  )
  mkdirSync(dirname(destDir), { recursive: true })
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
  renameSync(stage, destDir)
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const opcFile = join(catalogDir, 'opc-plugins.json')
  if (!existsSync(opcFile)) {
    console.error(`找不到 ${opcFile}`)
    console.error('  先跑 node scripts/build-opc-catalog.mjs，或用 --catalog-dir / OPC_CATALOG_DIR 指定目录。')
    process.exitCode = 1
    return
  }

  const plugins = JSON.parse(readFileSync(opcFile, 'utf8')).plugins
  const { repos: allRepos, unparsed_urls } = groupByRepo(plugins)
  const repos = allRepos.slice(0, limit)

  console.log(`opc-catalog : ${catalogDir}`)
  console.log(`条目        : ${plugins.length}  →  ${allRepos.length} 个唯一仓库${limit < Infinity ? ` (本次限制 ${repos.length})` : ''}`)
  console.log(`模式        : ${dryRun ? 'dry-run' : verifyOnly ? 'verify' : 'fetch'}${offline ? ' + offline' : ''}`)
  if (unparsed_urls.length) console.log(`无法解析 URL: ${unparsed_urls.length}`)
  if (!token && !offline && !dryRun) {
    console.log('')
    console.log('⚠  未设 GITHUB_TOKEN —— 未认证的 GitHub API 限速 60 次/小时，')
    console.log(`   ${repos.length} 个仓库大约需要 ${Math.ceil(repos.length / 60)} 小时，且中途会 403。`)
    console.log('   建议：GITHUB_TOKEN=<token> node scripts/fetch-opc-catalog.mjs')
  }
  // A symlinked license dir means the catalog directory is a sandbox pointing at
  // real data, so every clone would land in the real tree instead. Caught the hard
  // way: a test harness linked MIT/ and non-MIT/ into a temp dir, and 43 repos got
  // cloned straight into the production catalog.
  for (const dir of ['MIT', 'non-MIT']) {
    const path = join(catalogDir, dir)
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      console.error(`${dir} 是指向别处的符号链接：${path} → ${readlinkSync(path)}`)
      console.error('  拒绝写入：克隆会穿透符号链接落到真实数据上。请用真实目录，别用软链做沙箱。')
      process.exitCode = 1
      return
    }
  }

  console.log('')

  // ── leaderboard version check (before cloning, so the loop can act on it)
  const { stale, unchecked } = await findStaleRanked(allRepos, plugins)
  if (refreshRanked) {
    console.log(`排行榜版本检查: ${stale.size} 个仓库有新版本${unchecked.length ? `，${unchecked.length} 个无法比对` : ''}`)
    for (const [repo, info] of stale) console.log(`  ↑ ${repo.padEnd(46)} ${info.from} → ${info.to}`)
    for (const item of unchecked.slice(0, 5)) console.log(`  · ${item.key} — ${item.reason}`)
    console.log('')
  }

  const stageRoot = join(catalogDir, '.staging')
  const rows = []
  let ok = 0
  let failed = 0
  let skipped = 0
  let refreshed = 0
  let unresolvedReused = 0
  let unresolvedRescued = 0

  for (const [index, repo] of repos.entries()) {
    const label = `${repo.owner}/${repo.repo}`.padEnd(48)
    const progress = `[${String(index + 1).padStart(3)}/${repos.length}]`

    // ── 1. license (before cloning: the report records a folder even on failure)
    let spdx = null
    let error = null
    const existing = ['MIT', 'non-MIT'].map(d => join(catalogDir, d, `${repo.owner}__${repo.repo}`)).find(existsSync)

    if (offline && existing) ({ spdx, error } = licenseFromLocalTree(existing))
    else ({ spdx, error } = await licenseFromApi(repo))

    // An unanswered API call must never reclassify a repo we already know —
    // see existingLicenseDir(). `null` here means "unknown", not "not MIT".
    const filedUnder = existingLicenseDir(catalogDir, repo.owner, repo.repo)
    const unresolved = spdx === null && !offline
    let folder = `${spdx === null && filedUnder ? filedUnder : licenseDirFor(spdx)}/${repo.owner}__${repo.repo}`
    if (unresolved && filedUnder) unresolvedReused++

    // ── 2. clone
    const staleInfo = stale.get(`${repo.owner}/${repo.repo}`.toLowerCase())
    let status = 'ok'
    if (verifyOnly || dryRun) {
      status = existing ? 'ok' : 'missing'
    } else if (existing && !force && !staleInfo) {
      status = 'ok'
      skipped++
    } else {
      if (staleInfo) refreshed++
      try {
        await cloneRepo(repo, join(catalogDir, folder), stageRoot)
      } catch (e) {
        status = 'failed'
        error = e instanceof Error ? e.message.split('\n')[0] : String(e)
      }

      // A repo the API could not classify was cloned on a guess (non-MIT). Now
      // that the tree is on disk, read its LICENSE — otherwise every new MIT
      // plugin lands in non-MIT and never reaches the site.
      if (status === 'ok' && unresolved && !filedUnder) {
        const verdict = licenseFromLocalTree(join(catalogDir, folder))
        if (verdict.spdx === 'MIT') {
          const corrected = `MIT/${repo.owner}__${repo.repo}`
          renameSync(join(catalogDir, folder), join(catalogDir, corrected))
          folder = corrected
          unresolvedRescued++
        }
      }
    }

    if (status === 'ok') ok++
    else if (status === 'failed') failed++

    const mark = status === 'ok' ? '✓' : status === 'missing' ? '·' : '✗'
    const refreshNote = staleInfo && status === 'ok' ? `  ↑ ${staleInfo.from} → ${staleInfo.to}` : ''
    const note = error ? `  ← ${error}` : dryRun || verifyOnly ? `  (${existing ? 'present' : 'absent'})` : ''
    console.log(`${progress} ${mark} ${label} → ${folder.split('/')[0]}${note}${refreshNote}`)

    rows.push({
      owner: repo.owner,
      repo: repo.repo,
      status,
      folder,
      branch: repo.branch,
      subpaths: repo.subpaths,
      error,
      ...(staleInfo ? { refreshed: { from: staleInfo.from, to: staleInfo.to, npm: staleInfo.npm } } : {}),
    })
  }

  if (!verifyOnly && !dryRun && existsSync(stageRoot)) rmSync(stageRoot, { recursive: true, force: true })

  // ── MANIFEST — one row per catalog entry, in catalog order
  const header = ['name', 'repo', 'kind', 'url', 'local_folder', 'local_subpath']
  const byKey = new Map(rows.map(r => [`${r.owner}/${r.repo}`, r]))
  const manifest = plugins.map(entry => {
    const parsed = parseRepoUrl(entry.url)
    const row = parsed ? byKey.get(`${parsed.owner}/${parsed.repo}`) : null
    const folder = row ? row.folder : ''
    return [
      entry.name,
      parsed ? `${parsed.owner}/${parsed.repo}` : '',
      entry.monorepo ? 'monorepo-subpath' : 'standalone',
      entry.url ?? '',
      folder,
      parsed?.subpath ?? '',
    ].join('\t')
  })

  const report = {
    total_rows: plugins.length,
    unique_repos: allRepos.length,
    unparsed_urls,
    summary: { ok, failed },
    ...(refreshRanked ? { rankedRefresh: { stale: refreshed, unchecked: unchecked.length } } : {}),
    repos: rows,
  }

  console.log('')
  console.log(
    `ok ${ok} / failed ${failed}${skipped ? ` / skipped ${skipped}` : ''}${refreshed ? ` / 排行榜刷新 ${refreshed}` : ''}${verifyOnly || dryRun ? ' / 未写盘' : ''}`,
  )
  if (unresolvedReused || unresolvedRescued) {
    // Loud, because both mean the API did not answer: the run is still correct,
    // but the classification of new repos came from LICENSE text, not GitHub.
    console.log(
      `许可证未能从 API 判定: 沿用已有分类 ${unresolvedReused} 个${unresolvedRescued ? ` / 依 LICENSE 文本救回 MIT ${unresolvedRescued} 个` : ''}`,
    )
    console.log('  （多为限速。想避免请设置 GITHUB_TOKEN；分类未被降级，可继续。）')
  }

  if (verifyOnly || dryRun) {
    console.log('未写盘（verify / dry-run）。')
    if (dryRun) console.log(`将写入: ${join(catalogDir, 'MANIFEST.tsv')} 与 ${join(catalogDir, 'download_report.json')}`)
    return
  }

  // Write MANIFEST before the report so a half-written pair is detectable.
  writeFileSync(join(catalogDir, 'MANIFEST.tsv'), [header.join('\t'), ...manifest].join('\n') + '\n')
  writeFileSync(join(catalogDir, 'download_report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`已写入 ${join(catalogDir, 'MANIFEST.tsv')} (${manifest.length} 行)`)
  console.log(`已写入 ${join(catalogDir, 'download_report.json')}`)
  console.log('')
  console.log('下一步（在 PBISimulation-Frontend）: npm run catalog:build → catalog:translate → catalog:build → catalog:ranking')
}

// Only run when invoked directly, so tests can import the pure helpers.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(e => {
    console.error(e)
    process.exitCode = 1
  })
}
