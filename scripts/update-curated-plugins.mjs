#!/usr/bin/env node
/**
 * 甄选目录（best-plugin/）的版本检查与更新。
 *
 * 甄选插件不是上游聚合源的一部分：它们是人工下载的 GitHub ZIP，没有 .git，
 * 所以 fetch-opc-catalog.mjs 的 clone 逻辑永远不会碰它们。后果是 sources.json
 * 里的仓库停在下载那天的版本，官网上的「甄选」卡片会一直显示旧版号。
 *
 * 这一步不改变「谁进甄选」——名单仍然只由 sources.json 决定。它只负责把
 * 已列入清单的目录跟到 GitHub 最新版：
 *
 *   1. 用 raw.githubusercontent 读目标分支的 package.json，和本地版本比大小
 *   2. 远端更新（或在本地缺失 / --force）时，浅克隆到临时目录再原子替换
 *   3. 远端更旧、版本相同、或读不到远端时，保持原样并说明原因
 *
 * 网络失败不是致命错误：受限网络下聚合源仍然可用，甄选目录保持现状即可。
 * 真正的配置错误（清单损坏、与上游目录 key 冲突）才会以非零退出。
 *
 * 用法：
 *   node scripts/update-curated-plugins.mjs                # 检查并更新
 *   node scripts/update-curated-plugins.mjs --dry-run      # 只报告会做什么
 *   node scripts/update-curated-plugins.mjs --force        # 无条件重新下载
 *   node scripts/update-curated-plugins.mjs --catalog-dir <路径>
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { compareVersions, parseRepoUrl } from './fetch-opc-catalog.mjs'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1]
}

const catalogDir = resolve(
  arg('--catalog-dir', process.env.OPC_CATALOG_DIR || join(homedir(), 'Documents/9.Project/项目开发/opc-catalog')),
)
const curatedDir = join(catalogDir, 'best-plugin')
const sourcesFile = join(curatedDir, 'sources.json')
const dryRun = process.argv.includes('--dry-run')
const force = process.argv.includes('--force')

const HEADERS = { 'user-agent': 'dsh-plugin-galaxy-curated' }
const FETCH_TIMEOUT_MS = 15_000
const CLONE_TIMEOUT_MS = 120_000

/* ------------------------------------------------------------------ *
 * 纯函数（测试覆盖这一层，不做网络/文件系统操作）
 * ------------------------------------------------------------------ */

/**
 * 目录名后缀 → 默认分支。
 *
 * sources.json 的值只有仓库地址，没有分支。这些目录是从 `<repo>-<branch>.zip`
 * 解压来的，后缀就是当初下载的分支；猜错分支会 404，所以只在后缀可信时使用。
 */
export function branchFromDirName(name) {
  if (/-main$/.test(name)) return 'main'
  if (/-master$/.test(name)) return 'master'
  return null
}

/** 依次尝试的分支：URL 里写死的优先，其次目录名后缀，最后 main/master。 */
export function branchCandidates(dirName, urlBranch) {
  const ordered = [urlBranch, branchFromDirName(dirName), 'main', 'master'].filter(Boolean)
  return [...new Set(ordered)]
}

/**
 * 本地版本与远端版本 → 该做什么。
 *
 * "不相等" 不等于 "更新"：仓库 package.json 可能带着未发布的开发版，远端反而更旧。
 * 只有远端严格更新才覆盖，避免把本地更好的版本降级。compareVersions 无法解析时
 * 退化为字符串比较，宁可多更新一次也不漏掉。
 */
export function decideAction(localVersion, remoteVersion) {
  if (!remoteVersion) return 'unchecked'
  if (!localVersion) return 'update'
  const comparison = compareVersions(remoteVersion, localVersion)
  if (comparison === null) return remoteVersion === localVersion ? 'skip' : 'update'
  if (comparison > 0) return 'update'
  if (comparison < 0) return 'ahead'
  return 'skip'
}

/**
 * 清单与上游目录冲突检查：同一仓库同时出现在 best-plugin 和上游时，
 * 前端的 build 会因 key 重复直接失败。在这里提前指出，错误信息才可操作。
 */
export function findUpstreamConflicts(entries, upstreamUrls) {
  const upstream = new Set()
  for (const url of upstreamUrls) {
    const parsed = parseRepoUrl(url)
    if (parsed) upstream.add(`${parsed.owner}/${parsed.repo}`)
  }
  const conflicts = []
  for (const [dirName, url] of entries) {
    const parsed = parseRepoUrl(url)
    if (parsed && upstream.has(`${parsed.owner}/${parsed.repo}`)) {
      conflicts.push({ dirName, key: `${parsed.owner}/${parsed.repo}` })
    }
  }
  return conflicts
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

/** sources.json → [目录名, URL]；值可以是字符串或 { url, description }。 */
export function readSources(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  return Object.entries(raw)
    .filter(([key]) => !key.startsWith('_'))
    .map(([dirName, value]) => [dirName, typeof value === 'string' ? value : value?.url])
    .filter(([, url]) => typeof url === 'string' && url)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

function upstreamUrls() {
  const opc = readJson(join(catalogDir, 'opc-plugins.json'))
  return (opc?.plugins ?? []).map((plugin) => plugin.url).filter(Boolean)
}

/** 远端 package.json；404/网络错误都返回 null，由调用方归入 unchecked。 */
async function remotePackage(parsed, branch, subpath) {
  const path = subpath ? `${subpath.replace(/\/$/, '')}/package.json` : 'package.json'
  const url = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${branch}/${path}`
  try {
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) return null
    return JSON.parse((await response.text()).replace(/^﻿/, ''))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 下载与替换
 * ------------------------------------------------------------------ */

function assertSafeDirName(dirName) {
  if (!/^[A-Za-z0-9._-]+$/.test(dirName) || dirName.startsWith('.')) {
    throw new Error(`目录名不安全，拒绝操作：${dirName}`)
  }
}

/**
 * 浅克隆到临时目录，再把 `<subpath>`（或仓库根）原子换入目标目录。
 *
 * 先改名旧目录而不是直接删除：克隆失败或换入失败时能原样恢复，不会把一个
 * 甄选插件留在半新半旧的状态。临时目录放在 best-plugin/ 下，保证同一文件系统，
 * rename 才是原子的。
 */
async function replaceFromGithub(dirName, parsed, branch) {
  assertSafeDirName(dirName)
  const target = join(curatedDir, dirName)
  const staging = join(curatedDir, `.staging-${dirName}`)
  const backup = join(curatedDir, `.backup-${dirName}`)

  rmSync(staging, { recursive: true, force: true })
  rmSync(backup, { recursive: true, force: true })

  try {
    await run(
      'git',
      [
        'clone',
        '--quiet',
        '--depth',
        '1',
        '--single-branch',
        '--branch',
        branch,
        `https://github.com/${parsed.owner}/${parsed.repo}.git`,
        staging,
      ],
      { timeout: CLONE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    )
    rmSync(join(staging, '.git'), { recursive: true, force: true })

    const source = parsed.subpath ? resolve(staging, parsed.subpath) : staging
    const root = resolve(staging)
    if (source !== root && !source.startsWith(root + sep)) {
      throw new Error(`subpath 逃出了仓库目录：${parsed.subpath}`)
    }
    if (!existsSync(source)) throw new Error(`仓库里没有 subpath：${parsed.subpath}`)

    const hadTarget = existsSync(target)
    if (hadTarget) renameSync(target, backup)
    try {
      renameSync(source, target)
    } catch (error) {
      if (hadTarget && !existsSync(target)) renameSync(backup, target)
      throw error
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(backup, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  if (!existsSync(sourcesFile)) {
    console.error(`找不到 ${sourcesFile}`)
    process.exitCode = 1
    return
  }

  const entries = readSources(sourcesFile)
  const parseFailures = entries.filter(([, url]) => !parseRepoUrl(url))
  const valid = entries
    .map(([dirName, url]) => [dirName, url, parseRepoUrl(url)])
    .filter(([, , parsed]) => parsed)

  const conflicts = findUpstreamConflicts(
    valid.map(([dirName, url]) => [dirName, url]),
    upstreamUrls(),
  )
  if (conflicts.length) {
    console.error('✗ 甄选清单与上游目录冲突（前端 build 会因 key 重复失败）：')
    for (const { dirName, key } of conflicts) console.error(`    ${dirName} → ${key}`)
    console.error('  处理：从 best-plugin/sources.json 删掉该条目（官网仍会展示上游版本），')
    console.error('        或从上游目录排除该插件。两者不能同时收录。')
    process.exitCode = 1
    return
  }

  console.log(`甄选目录：${curatedDir}`)
  console.log(`清单条目：${entries.length}${parseFailures.length ? `（${parseFailures.length} 条地址无法解析）` : ''}`)
  if (dryRun) console.log('DRY RUN —— 只报告，不下载')
  console.log('')

  const counts = { updated: 0, skip: 0, ahead: 0, unchecked: 0, failed: 0 }
  const failures = []

  for (const [dirName, url] of entries) {
    const parsed = parseRepoUrl(url)
    if (!parsed) {
      counts.failed++
      failures.push(`${dirName}：地址不是 GitHub 仓库（${url}）`)
      console.log(`  ✗ ${dirName}  地址无法解析：${url}`)
      continue
    }

    const target = join(curatedDir, dirName)
    const localVersion = readJson(join(target, 'package.json'))?.version ?? null

    let branch = null
    let remote = null
    let remoteVersion = null
    for (const candidate of branchCandidates(dirName, parsed.branch)) {
      remote = await remotePackage(parsed, candidate, parsed.subpath)
      if (remote) {
        branch = candidate
        remoteVersion = typeof remote.version === 'string' ? remote.version : null
        break
      }
    }

    if (!remote) {
      counts.unchecked++
      console.log(`  ! ${dirName}  读不到远端 package.json（网络或分支），保持现状`)
      continue
    }

    const action = force && localVersion ? 'update' : decideAction(localVersion, remoteVersion)
    const from = localVersion ?? '（缺失）'
    const to = remoteVersion ?? '（未声明）'

    if (action === 'unchecked') {
      counts.unchecked++
      console.log(`  ! ${dirName}  远端 package.json 没有 version，保持现状`)
      continue
    }
    if (action === 'ahead') {
      counts.ahead++
      console.log(`  ↓ ${dirName}  本地 ${from} 比远端 ${to} 新，跳过（不降级）`)
      continue
    }
    if (action === 'skip') {
      counts.skip++
      console.log(`  ✓ ${dirName}  ${from} 已是最新`)
      continue
    }

    if (dryRun) {
      counts.updated++
      console.log(`  ↑ ${dirName}  将更新 ${from} → ${to}（${branch}）`)
      continue
    }

    try {
      await replaceFromGithub(dirName, parsed, branch)
      counts.updated++
      console.log(`  ↑ ${dirName}  ${from} → ${to}（${branch}）`)
    } catch (error) {
      counts.failed++
      failures.push(`${dirName}：${error.message}`)
      console.log(`  ✗ ${dirName}  更新失败，保留原目录：${error.message}`)
    }
  }

  console.log('')
  console.log(
    `  更新 ${counts.updated} · 已最新 ${counts.skip} · 本地领先 ${counts.ahead} · 无法比对 ${counts.unchecked} · 失败 ${counts.failed}`,
  )
  if (failures.length) {
    console.log('')
    console.log('  未完成的条目（下次运行会重试）：')
    for (const line of failures) console.log(`    · ${line}`)
    // 网络/单仓库失败不阻塞整条管线：聚合源照常可用，甄选保持上一版即可。
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
