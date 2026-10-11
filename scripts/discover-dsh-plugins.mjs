#!/usr/bin/env node
/**
 * Discover dsh plugins and produce the generator's input.
 *
 * Two channels, deliberately kept separate so their provenance stays auditable:
 *
 *   1. The public aggregator (https://awesome-dsh-plugin.com/plugins.json).
 *      This is where the ecosystem actually is — 3 6xx entries — and it is the
 *      only channel that yields entries WITH a curated category and star count.
 *      Snapshot verbatim into `catalog/source-upstream.json`.
 *   2. GitHub search (topics + name). Finds plugins the aggregator has NOT
 *      picked up yet, which is the only way to see something genuinely new. It
 *      yields repos, not catalog rows, so the entries are synthesised here and
 *      tagged `discoveredVia: 'github-search'`.
 *
 * Both go into `catalog/source-plugins.json` — the generator's default input —
 * so nothing downstream changes shape. Keep `source-upstream.json`: when an
 * entry looks wrong, it is the only way to tell whether upstream said it or we
 * invented it.
 *
 * GitHub search is capped at 10 req/min unauthenticated, 30/min with a token, so
 * this issues a handful of requests and pages only when asked. Without a token it
 * still runs; it just cannot page deeply.
 *
 * Usage:
 *   node scripts/discover-dsh-plugins.mjs                  # both channels
 *   node scripts/discover-dsh-plugins.mjs --no-github      # aggregator only
 *   node scripts/discover-dsh-plugins.mjs --offline        # reuse the local snapshot
 *   GITHUB_TOKEN=… node scripts/discover-dsh-plugins.mjs --pages 3
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1]
}
const flag = name => process.argv.includes(name)

const outDir = resolve(arg('--out', join(workspace, 'catalog')))
const upstreamFile = join(outDir, 'source-upstream.json')
const mergedFile = join(outDir, 'source-plugins.json')
const pages = Math.max(1, Number(arg('--pages', '1')))
const offline = flag('--offline')
const noVerify = flag('--no-verify')
/**
 * GitHub search is opt-out, not opt-in, but it must never be load-bearing:
 * on a restricted network api.github.com is simply unreachable, and the run has
 * to complete on the aggregator alone. `DSHG_NO_GITHUB=1` sets the same switch
 * for a whole shell session without threading a flag through every call.
 */
// `--offline` implies it: a flag documented as "no network" must not call
// api.github.com. Kept here as well as in the orchestrator so calling this
// script directly behaves the same.
const noGithub = flag('--no-github') || process.env.DSHG_NO_GITHUB === '1' || offline
const token = process.env.GITHUB_TOKEN || process.env.DSHG_GITHUB_TOKEN || ''

const UPSTREAM_URL = process.env.DSHG_REGISTRY_URL || 'https://awesome-dsh-plugin.com/plugins.json'

const HEADERS = {
  accept: 'application/json',
  'user-agent': 'dsh-plugin-galaxy-discover',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
}

/* ------------------------------------------------------------------ *
 * Channel 1 — the aggregator
 * ------------------------------------------------------------------ */

async function fetchUpstream() {
  console.log(`上游聚合源: ${UPSTREAM_URL}`)
  let response
  try {
    response = await fetch(UPSTREAM_URL, { headers: HEADERS })
  } catch (e) {
    // This one IS fatal — without the aggregator there is no catalog to build —
    // so fail loudly, but say what to do instead of surfacing a raw SocketError.
    throw new Error(
      `上游聚合源不可达（${e?.cause?.code ?? e?.message ?? 'fetch failed'}）。\n` +
        '  该源是必需的，无法跳过。网络受限时可改用上次的快照：加 --offline。',
    )
  }
  if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}`)
  const payload = await response.json()
  const entries = Array.isArray(payload) ? payload : (payload.plugins ?? payload.registry?.plugins ?? [])
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('上游响应里找不到 plugins 数组')
  // Keep the envelope: `registry.updated` is the upstream freshness signal the
  // delta report wants, and flattening it here would lose it.
  const snapshot = Array.isArray(payload) ? { registry: { plugins: entries, count: entries.length } } : payload
  writeFileSync(upstreamFile, JSON.stringify(snapshot, null, 2) + '\n')
  console.log(`  ✓ ${entries.length} 条 → ${upstreamFile}`)
  return entries
}

function readUpstreamSnapshot() {
  if (!existsSync(upstreamFile)) {
    throw new Error(`--offline 需要 ${upstreamFile}，但它不存在。先跑一次联网的发现。`)
  }
  const payload = JSON.parse(readFileSync(upstreamFile, 'utf8'))
  const entries = Array.isArray(payload) ? payload : (payload.plugins ?? payload.registry?.plugins ?? [])
  console.log(`上游快照(离线): ${entries.length} 条 ← ${upstreamFile}`)
  return entries
}

/* ------------------------------------------------------------------ *
 * Channel 2 — GitHub search
 * ------------------------------------------------------------------ */

/**
 * `dsh-plugin in:name` is the reliable query. The topic queries are NOT: GitHub
 * reports 18 647 repos under `topic:dsh-plugin` and the top results include
 * PicGo, WeKnora and reactive-resume — the topic is either spammed or fuzzily
 * matched. Topics are therefore only a cheap prefilter; the verdict comes from
 * verification below.
 */
const SEARCH_QUERIES = ['dsh-plugin in:name', 'topic:dsh-plugin', 'topic:deepseek-harness']

/** Cheap prefilter — intentionally loose, it only decides what to spend a request on. */
export function prefilterCandidate(repo) {
  const name = (repo.name ?? '').toLowerCase()
  const topics = repo.topics ?? []
  if (topics.includes('dsh-plugin') || topics.includes('deepseek-harness')) return true
  return /(^|[-_])dsh([-_]|$)/.test(name)
}

const stripBom = text => (text.charCodeAt(0) === 0xfe_ff ? text.slice(1) : text)

/**
 * Verify the repo actually declares itself a dsh plugin.
 *
 * The ecosystem's own contract is the `dsh` field in `package.json` — the galaxy
 * reads `dsh.hostVersion` / `dsh.engines.dsh` to decide compatibility, and the
 * host runs plugins inside its own Node process. Requiring it is therefore the
 * real installability bar, not a heuristic: a Python repo (e.g.
 * `AdamPlatin123/dsh-plugin-radar`, which surfaces in these searches) cannot be
 * installed as a plugin however it is tagged.
 *
 * Served from raw.githubusercontent.com (a CDN), not the API, so this does not
 * consume the 10/min search budget. One request per candidate.
 *
 * `ok: null` means the answer is unknown (network failure / 5xx) and must NOT be
 * reported as "not a plugin".
 */
export async function verifyDeclaresDsh(repo) {
  // The search result already carries the default branch, so the common case is
  // one request. The fallbacks only cover a truncated search payload.
  const refs = [repo.default_branch, 'HEAD', 'main', 'master'].filter(Boolean)
  const base = `https://raw.githubusercontent.com/${repo.owner?.login}/${repo.name}`
  for (const ref of [...new Set(refs)]) {
    let response
    try {
      response = await fetch(`${base}/${ref}/package.json`, { headers: { 'user-agent': 'dsh-plugin-galaxy-discover' } })
    } catch {
      return { ok: null, reason: '校验请求失败（网络）' }
    }
    if (response.status === 404) continue
    if (!response.ok) return { ok: null, reason: `校验请求失败（HTTP ${response.status}）` }

    // Reading the body is a separate network step: fetch() resolves as soon as
    // the headers arrive, so a connection reset mid-body rejects HERE, not at the
    // fetch above. Folding it into the parse catch would turn an unknown into a
    // confident "not a plugin" and drop a real one.
    let text
    try {
      text = await response.text()
    } catch {
      return { ok: null, reason: '校验请求失败（读取响应体）' }
    }
    let pkg
    try {
      pkg = JSON.parse(stripBom(text))
    } catch {
      return { ok: false, reason: 'package.json 无法解析' }
    }
    if (pkg.dsh !== undefined) return { ok: true, reason: 'package.json 声明了 dsh 字段' }
    const peers = Object.keys(pkg.peerDependencies ?? {})
    if (peers.some(dep => dep.includes('dsh'))) return { ok: true, reason: 'peerDependencies 依赖 dsh' }
    return { ok: false, reason: 'package.json 未声明 dsh 字段' }
  }
  return { ok: false, reason: '根目录无 package.json（非 Node 包，无法作为插件安装）' }
}

/** Aggregator-shaped entry for a repo that upstream has not listed. */
export function synthesiseEntry(repo, today) {
  const owner = repo.owner?.login ?? ''
  return {
    name: repo.name,
    url: repo.html_url,
    owner,
    // Deliberately blank: `build-opc-catalog.mjs` only falls back to the upstream
    // category when no keyword matched, and inventing one here would file the
    // plugin under a category the aggregator never claimed.
    category: 'uncategorized',
    stars: repo.stargazers_count ?? 0,
    install: `dsh plugin --profile web add github:${owner}/${repo.name}`,
    added: today,
    discoveredVia: 'github-search',
    ...(repo.description === null || repo.description === undefined ? {} : { description: repo.description }),
  }
}

async function searchGithub(existingKeys) {
  if (noGithub) {
    const why = process.env.DSHG_NO_GITHUB === '1' ? 'DSHG_NO_GITHUB=1' : flag('--no-github') ? '--no-github' : '--offline'
    console.log(`GitHub 搜索: 已关闭（${why}）—— 仅使用聚合源，流程照常完成`)
    return { verified: [], rejected: [] }
  }
  console.log(token ? 'GitHub 搜索: 已带 token' : 'GitHub 搜索: 未设 GITHUB_TOKEN —— 搜索限速 10 次/分钟')

  const seen = new Set()
  const candidates = []
  const today = new Date().toISOString().slice(0, 10)
  let failures = 0
  let attempts = 0

  for (const query of SEARCH_QUERIES) {
    for (let page = 1; page <= pages; page++) {
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=100&page=${page}`
      let response
      attempts++
      try {
        response = await fetch(url, { headers: { ...HEADERS, accept: 'application/vnd.github+json' } })
      } catch (e) {
        failures++
        console.log(`  ! ${query} p${page}: 请求失败 ${e.message}`)
        break
      }
      if (!response.ok) {
        failures++
        const hint = response.headers.get('x-ratelimit-remaining') === '0' ? '（搜索限速已用尽，稍后重试或加 token）' : ''
        console.log(`  ! ${query} p${page}: HTTP ${response.status} ${hint}`)
        break
      }
      const body = await response.json()
      const items = body.items ?? []
      if (items.length === 0) break

      for (const repo of items) {
        const key = `${repo.owner?.login ?? ''}/${repo.name}`.toLowerCase()
        if (repo.archived || existingKeys.has(key) || seen.has(key)) continue
        if (!prefilterCandidate(repo)) continue
        seen.add(key)
        candidates.push({ repo, key, query })
      }
    }
  }

  // Every request failed: almost always a blocked/restricted network rather than
  // a GitHub outage. Say so plainly — otherwise a silent zero looks like "no new
  // plugins exist" instead of "we could not look".
  if (attempts > 0 && failures === attempts) {
    console.log(`  ${'[33m'}! GitHub 不可达（${failures}/${attempts} 次请求全部失败）—— 已跳过该通道`)
    console.log('    网络受限时用 --no-github（或 DSHG_NO_GITHUB=1）可跳过这几次超时等待；仅聚合源也能完成整个流程')
    return { verified: [], rejected: [] }
  }

  console.log(`  预筛候选 ${candidates.length} 个（上游未收录）${failures ? `，${failures} 次请求失败` : ''}`)

  if (noVerify) {
    console.log('  ! --no-verify：跳过 package.json 校验，候选全部按通过处理')
    return { verified: candidates.map(c => synthesiseEntry(c.repo, today)), rejected: [] }
  }

  // Verification is one CDN request per candidate, so run them in small batches
  // instead of serially (160 candidates serially is minutes of dead time).
  const verified = []
  const rejected = []
  const BATCH = 12
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH)
    const verdicts = await Promise.all(batch.map(c => verifyDeclaresDsh(c.repo)))
    batch.forEach((candidate, index) => {
      const verdict = verdicts[index]
      if (verdict?.ok === true) {
        verified.push(synthesiseEntry(candidate.repo, today))
      } else {
        // `ok: null` is "could not tell" — kept out of the catalog but recorded
        // with its reason, rather than silently equated with "not a plugin".
        rejected.push({
          repo: candidate.key,
          stars: candidate.repo.stargazers_count ?? 0,
          reason: verdict?.reason ?? '校验未返回结果',
          unknown: verdict?.ok === null,
          via: candidate.query,
        })
      }
    })
    if (candidates.length > BATCH) process.stdout.write(`\r  校验中 ${Math.min(i + BATCH, candidates.length)}/${candidates.length}`)
  }
  if (candidates.length > BATCH) process.stdout.write('\n')

  console.log(`  ✓ 校验通过 ${verified.length} 个 / 剔除 ${rejected.length} 个`)
  return { verified, rejected }
}

/* ------------------------------------------------------------------ *
 * Merge
 * ------------------------------------------------------------------ */

async function main() {
  mkdirSync(outDir, { recursive: true })

  const upstream = offline ? readUpstreamSnapshot() : await fetchUpstream()

  const existingKeys = new Set(
    upstream.map(entry => {
      const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(entry.url ?? '')
      return m ? `${m[1]}/${m[2]}`.replace(/\.git$/, '').toLowerCase() : null
    }).filter(Boolean),
  )

  const { verified: discovered, rejected } = await searchGithub(existingKeys)

  const merged = [...upstream, ...discovered]
  const payload = {
    registry: {
      plugins: merged,
      count: merged.length,
      updated: new Date().toISOString().slice(0, 10),
    },
    discovery: {
      upstream: upstream.length,
      githubSearch: discovered.length,
      githubRejected: rejected.length,
      generatedAt: new Date().toISOString(),
    },
  }
  writeFileSync(mergedFile, JSON.stringify(payload, null, 2) + '\n')

  // Kept so a plugin that SHOULD be in the catalog but failed verification is
  // diagnosable instead of just absent.
  if (rejected.length) writeFileSync(join(outDir, 'discovery-rejected.json'), JSON.stringify(rejected, null, 2) + '\n')

  console.log('')
  console.log(`合并结果: 上游 ${upstream.length} + GitHub 搜索 ${discovered.length} = ${merged.length} 条`)
  console.log(`  → ${mergedFile}`)
  if (discovered.length) {
    console.log('')
    console.log('新发现（已通过 package.json 声明校验）:')
    for (const entry of discovered.slice(0, 20)) console.log(`  · ${entry.owner}/${entry.name}  ★${entry.stars}`)
    if (discovered.length > 20) console.log(`  … 另有 ${discovered.length - 20} 个`)
  }
  if (rejected.length) {
    console.log('')
    console.log(`剔除 ${rejected.length} 个（详见 ${join(outDir, 'discovery-rejected.json')}）:`)
    for (const item of rejected.slice(0, 8)) console.log(`  ✗ ${item.repo}  ★${item.stars}  ← ${item.reason}`)
    if (rejected.length > 8) console.log(`  … 另有 ${rejected.length - 8} 个`)
  }
  console.log('')
  console.log('下一步: node scripts/build-opc-catalog.mjs')
}

main().catch(e => {
  console.error(`发现失败: ${e.message}`)
  process.exitCode = 1
})
