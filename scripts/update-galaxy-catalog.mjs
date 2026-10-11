#!/usr/bin/env node
/**
 * One command for the whole plugin-catalog refresh:
 * discover → generate → fetch → build → translate → build → rank → gate.
 *
 * Why an orchestrator instead of an npm-script chain: the order is load-bearing
 * but nothing enforced it. `catalog:build` rebuilds `plugins[]` from scratch, so
 * running it after `catalog:ranking` silently wipes `score`/`band`/`scoreParts`
 * and leaves `ranking.json` describing the previous version — a state where the
 * website looks perfectly fine and only the galaxy degrades. A chain cannot
 * express "build twice with a translate in between"; this can, and it can stop on
 * the first failure instead of producing a half-updated catalog.
 *
 * Non-MIT plugins stop at step 4. The frontend generator keeps only the `MIT/`
 * directory (`DEFAULT_LICENSE_DIRS`), so nothing below this line ever sees them —
 * the run reports how many were excluded rather than letting it be a surprise.
 *
 * Deployment is deliberately NOT part of this. The run stops after the gates,
 * prints what would ship, and hands the trigger back to a human.
 *
 * Usage:
 *   node scripts/update-galaxy-catalog.mjs                 # full run
 *   node scripts/update-galaxy-catalog.mjs --dry-run       # show the plan only
 *   node scripts/update-galaxy-catalog.mjs --no-github     # aggregator only (restricted network)
 *   node scripts/update-galaxy-catalog.mjs --offline --skip-fetch   # no network at all
 *   node scripts/update-galaxy-catalog.mjs --top 30        # raise the per-category cap
 *   node scripts/update-galaxy-catalog.mjs --from rank     # resume mid-way
 *
 * Flags: --dry-run --offline --no-github --skip-fetch --skip-translate
 *        --skip-gates --from <step> --top <n>
 * Env:   OPC_CATALOG_DIR  PBI_FRONTEND_DIR  GITHUB_TOKEN  DSHG_NO_GITHUB=1
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const catalogDir = resolve(process.env.OPC_CATALOG_DIR || '/Users/zhaojunping/Documents/9.Project/项目开发/opc-catalog')
const frontendDir = resolve(process.env.PBI_FRONTEND_DIR || '/Users/zhaojunping/Documents/AI/PBISimulation-Frontend')
const topN = arg('--top', null)
const dryRun = flag('--dry-run')
const offline = flag('--offline')
const skipFetch = flag('--skip-fetch') || offline
const skipTranslate = flag('--skip-translate')
const skipGates = flag('--skip-gates')
const fromStep = arg('--from', null)
/**
 * Turn off the GitHub discovery channel. Restricted networks cannot reach
 * api.github.com, and the aggregator alone is enough to complete the run — so
 * this is a supported mode, not a degraded one.
 */
// `offline` implies it too: claiming to be offline while still calling
// api.github.com is exactly the contradiction that makes the flag untrustworthy.
const noGithub = flag('--no-github') || process.env.DSHG_NO_GITHUB === '1' || offline
/** Echo every child command — how you check a flag actually reaches the step. */
const verbose = flag('--verbose')

const stateDir = join(catalogDir, '.state')
const stateFile = join(stateDir, 'opc-state.json')

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

const C = { dim: '[2m', red: '[31m', green: '[32m', yellow: '[33m', cyan: '[36m', reset: '[0m' }
const summary = []

function heading(text) {
  console.log(`\n${C.cyan}━━ ${text}${C.reset}`)
}

/**
 * Run a child process with inherited stdio so its own progress stays visible.
 *
 * `--verbose` echoes the exact command. Worth having: the steps hand flags to
 * each other (the fetch step's `--refresh-ranked`, the generate step's
 * `--source`), and a silently-dropped flag between two scripts is invisible in
 * the output otherwise.
 */
async function sh(command, args, cwd = workspace) {
  if (verbose) {
    const line = `${command} ${args.join(' ')}`
    console.log(`${C.dim}$ (cd ${cwd} && ${line})${C.reset}`)
  }
  // stdio:'inherit' — NOT the default. Without it execFile pipes the child's
  // output into a buffer we never print, so the steps' own progress (and the
  // fetch step's `ok 281 / failed 1` summary) is invisible while the run is
  // happening. Errors still abort via the rejection below.
  await run(command, args, { cwd, stdio: 'inherit', maxBuffer: 64 * 1024 * 1024 })
}

/* ------------------------------------------------------------------ *
 * Delta — what actually changed since the last run
 * ------------------------------------------------------------------ */

/**
 * Snapshot of which plugins were kept vs dropped, keyed by URL.
 *
 * Read back from `opc-plugins.csv` (the only artifact carrying `status` on every
 * candidate) so the delta can tell three different things apart: newly listed,
 * newly pushed out by the cap, and recovered from a previous cap cut. Without the
 * dropped set, "disappeared from the catalog" and "was always below the cap"
 * look identical.
 */
function readStatusSets() {
  const file = join(catalogDir, 'opc-plugins.csv')
  if (!existsSync(file)) return { kept: new Set(), dropped: new Set() }
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  const cols = lines[0].replaceAll('"', '').split(',')
  const urlAt = cols.indexOf('url')
  const statusAt = cols.indexOf('status')
  const kept = new Set()
  const dropped = new Set()
  for (const line of lines.slice(1)) {
    // The CSV quotes every field, so a naive split works only because no field
    // contains a comma — verified for url/status, which are all we read.
    const cells = line.replaceAll('"', '').split(',')
    const url = cells[urlAt]
    if (!url) continue
    ;(cells[statusAt] === 'kept' ? kept : dropped).add(url)
  }
  return { kept, dropped }
}

/**
 * Classify every TRANSITION between the previous and current kept/dropped sets.
 *
 * Each bucket must be mutually exclusive, or the summary double-counts: a plugin
 * pushed out by the cap is absent from `current.kept` too, so a naive
 * `prevKept \ current.kept` "dropped" bucket also swallows everything that
 * vanished upstream, and the printed numbers stop reconciling. Each moved URL
 * therefore belongs to exactly one bucket; unchanged URLs belong to none.
 */
export function computeDelta(previous, current) {
  if (!previous) return null
  const prevKept = new Set(previous.kept ?? [])
  const prevDropped = new Set(previous.dropped ?? [])
  const stillPresent = url => current.kept.has(url) || current.dropped.has(url)

  return {
    // never seen in either set before
    newlyListed: [...current.kept].filter(url => !prevKept.has(url) && !prevDropped.has(url)),
    // was cut by the cap last time, back inside it now
    recovered: [...current.kept].filter(url => prevDropped.has(url)),
    // was listed, now cut by the cap
    newlyDropped: [...prevKept].filter(url => current.dropped.has(url)),
    // new to the source, but ranked below the cap on arrival
    newButDropped: [...current.dropped].filter(url => !prevKept.has(url) && !prevDropped.has(url)),
    // was listed, gone from the source entirely
    vanished: [...prevKept].filter(url => !stillPresent(url)),
    // was already below the cap, and now gone from the source too
    droppedGone: [...prevDropped].filter(url => !stillPresent(url)),
  }
}

/**
 * How many plugins in the built artifact carry an English body.
 *
 * The convergence loop's stopping signal: `descEn` only ever appears once the
 * generator accepts pass 3's cache entry, so a round that does not raise this
 * number has nothing left to fix.
 */
function countDescEn() {
  const file = join(frontendDir, 'public/assets/plugins/catalog.json')
  if (!existsSync(file)) return 0
  try {
    return JSON.parse(readFileSync(file, 'utf8')).plugins.filter(p => p.descEn).length
  } catch {
    return 0
  }
}

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

const STEPS = [
  {
    id: 'discover',
    title: '发现（上游聚合源 + GitHub 搜索）',
    async run() {
      const args = ['scripts/discover-dsh-plugins.mjs', '--out', catalogDir]
      if (offline) args.push('--offline')
      if (noGithub) args.push('--no-github')
      await sh(process.execPath, args)
    },
  },
  {
    id: 'generate',
    title: '生成目录（含分类上限与淘汰标记）',
    async run() {
      // --source is passed explicitly, not left to the default: discovery writes
      // the snapshot into the catalog dir, and a mismatch here silently drops
      // everything discovery found.
      const args = [
        'scripts/build-opc-catalog.mjs',
        '--out', catalogDir,
        '--source', join(catalogDir, 'source-plugins.json'),
      ]
      if (topN) args.push('--top', String(topN))
      await sh(process.execPath, args)
    },
  },
  {
    id: 'fetch',
    title: '抓取（clone + MIT/non-MIT 判定）',
    async run() {
      const args = ['scripts/fetch-opc-catalog.mjs', '--catalog-dir', catalogDir]
      if (offline) args.push('--offline')
      // Keep the leaderboard's plugins on their current release. The ranking is
      // read from the PREVIOUS run's artifact, which is the right window: it is
      // the leaderboard visitors are actually looking at.
      const ranking = join(frontendDir, 'public/assets/plugins/ranking.json')
      if (existsSync(ranking)) args.push('--refresh-ranked', ranking)
      await sh(process.execPath, args)
    },
  },
  {
    id: 'build',
    title: '前端构建（仅 MIT 进产物）',
    async run() {
      await sh('npm', ['run', 'catalog:build'], frontendDir)
    },
  },
  {
    id: 'translate',
    title: '翻译（DeepSeek，增量缓存）',
    async run() {
      await sh('npm', ['run', 'catalog:translate'], frontendDir)
    },
  },
  {
    id: 'rebuild',
    title: '前端重建（并入译文）',
    async run() {
      // Not redundant: `catalog:build` regenerates from source, so the
      // translations only land in the artifact on a second pass.
      await sh('npm', ['run', 'catalog:build'], frontendDir)
    },
  },
  {
    id: 'converge',
    title: '翻译收敛（重建后重译，直到 descEn 覆盖不再提升）',
    async run() {
      // Why this exists — `descFull` is not stable inside one build→translate→build
      // cycle. The generator emits `descFull = cachedFull || fullKey`, so the moment
      // pass 2 writes the Chinese translation, `descFull` flips from the original
      // text to that translation. Pass 3 keys its cache entry (`srcEn`) on the text
      // it read from the PREVIOUS build, and the generator validates
      // `cached.srcEn === descFull` — so those entries quietly lose `descEn` and the
      // English UI falls back to Chinese.
      //
      // It bites entries whose text pass 2 rewrites in the same run: new
      // Chinese-source plugins on first appearance. A fixed number of extra rounds
      // is not enough — measured: one extra round took coverage 94.4% → 99.3% and
      // left two entries behind, because pass 2 flipped `descFull` again. So loop
      // until the coverage stops improving, with a hard cap so a thrashing cache
      // cannot spin forever.
      const MAX_ROUNDS = 3
      let previous = countDescEn()
      if (previous === 0) return
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        await sh('npm', ['run', 'catalog:translate'], frontendDir)
        await sh('npm', ['run', 'catalog:build'], frontendDir)
        const current = countDescEn()
        console.log(`  ${C.dim}第 ${round} 轮：descEn ${previous} → ${current}${C.reset}`)
        if (current <= previous) return
        previous = current
      }
      console.log(`  ${C.yellow}! 已达 ${MAX_ROUNDS} 轮上限，仍有条目未收敛。见 docs/catalog-pipeline.md 的收敛一节。${C.reset}`)
    },
  },
  {
    id: 'rank',
    title: '评分（必须最后，否则被 build 抹掉）',
    async run() {
      await sh('npm', ['run', 'catalog:ranking'], frontendDir)
    },
  },
  {
    id: 'gate',
    title: '门禁（产物测试 + 消费侧契约）',
    async run() {
      await sh('npx', ['vitest', 'run', 'src/__tests__/build/plugin-catalog.test.ts'], frontendDir)
      await sh(process.execPath, ['scripts/check-site-catalog.mjs'], workspace)
    },
  },
]

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  console.log(`${C.cyan}dsh 插件目录更新${C.reset}`)
  console.log(`  opc-catalog : ${catalogDir}`)
  console.log(`  前端        : ${frontendDir}`)
  if (topN) console.log(`  分类上限    : ${topN}`)
  if (dryRun) console.log(`  ${C.yellow}DRY RUN —— 不执行任何步骤${C.reset}`)

  if (!existsSync(catalogDir)) {
    // Created up front so discovery has somewhere to write on a cold start.
    if (dryRun) console.log(`  ${C.yellow}(目录不存在，正式运行时会创建)${C.reset}`)
    else mkdirSync(catalogDir, { recursive: true })
  }
  if (!existsSync(frontendDir)) {
    console.error(`${C.red}找不到前端目录 ${frontendDir}，用 PBI_FRONTEND_DIR 指定${C.reset}`)
    process.exitCode = 1
    return
  }
  if (noGithub) {
    console.log(`  GitHub 搜索: ${C.dim}已关闭 —— 仅用聚合源${C.reset}`)
  } else if (!process.env.GITHUB_TOKEN && !process.env.DSHG_GITHUB_TOKEN) {
    console.log(`  ${C.yellow}! 未设 GITHUB_TOKEN：GitHub 搜索限速 10 次/分钟，只跑单页${C.reset}`)
    console.log(`  ${C.dim}  网络受限时加 --no-github，避免几次超时等待${C.reset}`)
  }

  const previousState = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null
  const enabled = STEPS.filter(step => {
    if (fromStep && STEPS.findIndex(s => s.id === fromStep) > STEPS.findIndex(s => s.id === step.id)) return false
    if (skipFetch && step.id === 'fetch') return false
    // `converge` drives its own translate+build rounds, so skipping translation
    // must skip it too rather than leaving it to spin on unchanged data.
    if (skipTranslate && ['translate', 'rebuild', 'converge'].includes(step.id)) return false
    if (skipGates && step.id === 'gate') return false
    return true
  })

  if (dryRun) {
    console.log('\n将执行:')
    for (const step of enabled) console.log(`  · ${step.id.padEnd(10)} ${step.title}`)
    return
  }

  const startedAt = Date.now()
  for (const step of enabled) {
    heading(`${step.id} · ${step.title}`)
    const t0 = Date.now()
    try {
      await step.run()
    } catch (e) {
      // Abort here rather than continuing: every later step consumes this one's
      // output, so pushing on would publish a catalog built from stale parts.
      console.error(`\n${C.red}✗ ${step.id} 失败，已中止${C.reset}`)
      // The child's own stderr already streamed above (stdio:'inherit'), so this
      // is the wrapper's message — not a duplicate of the real error.
      console.error(String(e.message || e).slice(0, 2000))
      process.exitCode = 1
      return
    }
    summary.push({ id: step.id, ms: Date.now() - t0 })
    console.log(`${C.green}✓ ${step.id}${C.reset} ${C.dim}${((Date.now() - t0) / 1000).toFixed(1)}s${C.reset}`)
  }

  /* ---- delta + state ---- */
  heading('变更摘要')
  const current = readStatusSets()
  const delta = computeDelta(previousState, current)
  if (!previousState) {
    console.log('  首次运行，无历史可比（已记录基线）')
  } else {
    console.log(`  新收录        ${delta.newlyListed.length}`)
    console.log(`  被上限淘汰    ${delta.newlyDropped.length}`)
    console.log(`  从淘汰中回升  ${delta.recovered.length}`)
    console.log(`  上游消失      ${delta.vanished.length}`)
    // Printed only when non-zero, but both must be counted somewhere or the
    // buckets stop covering every transition and the numbers stop reconciling.
    if (delta.newButDropped.length) console.log(`  新出现即被挡  ${delta.newButDropped.length}`)
    if (delta.droppedGone.length) console.log(`  淘汰后消失    ${delta.droppedGone.length}`)
    for (const url of delta.newlyListed.slice(0, 10)) console.log(`    ${C.green}+${C.reset} ${url}`)
    for (const url of delta.newlyDropped.slice(0, 10)) console.log(`    ${C.yellow}-${C.reset} ${url}`)
    if (delta.newlyListed.length > 10 || delta.newlyDropped.length > 10) console.log('    …')
  }
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(
    stateFile,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), kept: [...current.kept], dropped: [...current.dropped] },
      null,
      2,
    ) + '\n',
  )

  /* ---- non-MIT exclusion ---- */
  const reportFile = join(catalogDir, 'download_report.json')
  if (existsSync(reportFile)) {
    const report = JSON.parse(readFileSync(reportFile, 'utf8'))
    const mit = report.repos.filter(r => r.folder.startsWith('MIT/')).length
    const nonMit = report.repos.filter(r => r.folder.startsWith('non-MIT/')).length
    console.log('')
    console.log(`  许可证分布    MIT ${mit} · non-MIT ${nonMit}`)
    console.log(`  ${C.dim}non-MIT 到此为止，不会进入前端产物${C.reset}`)
  }

  /* ---- what would ship ---- */
  heading('待部署（未自动执行）')
  const artifacts = ['catalog.json', 'ranking.json'].map(name => join(frontendDir, 'public/assets/plugins', name))
  for (const file of artifacts) {
    if (!existsSync(file)) {
      console.log(`  ${C.red}缺失 ${file}${C.reset}`)
      continue
    }
    const bytes = readFileSync(file).length
    console.log(`  ${(bytes / 1024).toFixed(1)} KB  ${file}`)
  }
  console.log('')
  console.log('  部署目标 /www/wwwroot/pbisimulation-frontend/dist/assets/plugins/')
  console.log('  （前端 dist 构建与 nginx 部署不在本脚本范围内）')

  console.log(`\n${C.green}全部完成${C.reset} ${C.dim}${((Date.now() - startedAt) / 1000).toFixed(1)}s${C.reset}`)
}

// Guard the entrypoint: without it, merely importing this module (a unit test,
// or another script reusing computeDelta) starts a full pipeline run against the
// real OPC_CATALOG_DIR and overwrites a 2.1 GB working tree.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(e => {
    console.error(e)
    process.exitCode = 1
  })
}
