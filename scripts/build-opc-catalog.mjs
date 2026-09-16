#!/usr/bin/env node
/**
 * Build the OPC (one-person-company) plugin catalog from the live DSH catalog.
 *
 * Why a generator and not a one-off list: the upstream catalog carries 3.6k
 * entries and changes daily. Everything here is derived, so the curated view can
 * be rebuilt in one command after an update — and the same JSON is what a
 * self-hosted catalog server would serve (`DSHG_REGISTRY_URL`), which is what
 * makes it usable for a deployment instead of a screenshot of one.
 *
 * Three facts about the source data drive the whole design:
 *
 *  1. **Stars are REPO level.** An entry is often a subpath of a monorepo
 *     (`dsh-web#packages/dsh-task-board`), so every package of that repo carries
 *     the repo's stars. Entries are therefore deduplicated by repository, and a
 *     subpath entry is marked as such — 6 000 stars for
 *     `some-huge-repo#integrations/deepseek-harness` is not the plugin's own
 *     popularity.
 *  2. **There is no description field**, only name/repo/category, so business
 *     classification is keyword scoring with explicit weights, exclusions for the
 *     traps that actually occur (`market` is a plugin marketplace, `post` hides
 *     inside `postgres`), and one primary category per repo.
 *  3. **Depth is uneven.** The report states, per category, how many repos exist
 *     and how many clear a star floor, instead of padding a list to 20 and
 *     implying an ecosystem that is not there.
 *
 * Usage:
 *   node scripts/build-opc-catalog.mjs [--source <plugins.json|url>] [--out <dir>]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1]
}

const source = arg('--source', join(workspace, 'catalog', 'source-plugins.json'))
const outDir = resolve(arg('--out', join(workspace, 'catalog')))

/* ------------------------------------------------------------------ *
 * Categories
 * ------------------------------------------------------------------ */

/**
 * `keep` are weighted keywords (higher = more decisive), `drop` are hard
 * exclusions for this category. Short or ambiguous tokens are matched with word
 * boundaries; longer ones as substrings.
 */
const CATEGORIES = [
  {
    id: 'service',
    label: '服务与交易（客服 / 订阅 / 开票 / 支付）',
    why: '一人公司的收入侧：把客服、订阅计费、开票、收款接进来。',
    keep: { 'support': 3, 'ticket': 3, 'helpdesk': 4, 'customer': 3, 'faq': 3, 'crm': 4, 'invoice': 4, 'billing': 3, 'payment': 3, 'stripe': 3, 'subscription': 4, 'checkout': 3, 'shopify': 3, 'order': 2, 'booking': 3, 'appointment': 3 },
  },
  {
    id: 'video',
    label: '视频与媒体（视频 / 图像 / 语音 / OCR）',
    why: '内容生产与素材处理：视频/音频转写、图像生成与识图、OCR。',
    keep: { 'video': 4, 'ffmpeg': 4, 'subtitle': 4, 'transcri': 4, 'youtube': 3, 'bilibili': 3, 'clip': 2, 'stream': 2, 'record': 3, 'camera': 2, 'screenshot': 3, 'ocr': 4, 'vision': 3, 'image': 3, 'photo': 3, 'audio': 3, 'tts': 4, 'voice': 3, 'podcast': 4, 'speech': 3, 'media': 2 },
  },
  {
    id: 'graphics',
    label: '动画与图形（图表 / 图解 / 动画）',
    why: '把数据与想法画出来：图表、图解、架构图、动画与原型。',
    keep: { 'anim': 4, 'motion': 3, 'gif': 3, 'lottie': 4, 'manim': 4, 'remotion': 4, 'chart': 3, 'graph': 2, 'diagram': 4, 'mermaid': 4, 'excalidraw': 4, 'canvas': 3, 'svg': 3, 'draw': 2, 'three': 2, 'render': 2, 'ascii': 2, 'design': 2, 'figma': 3, 'sketch': 2 },
  },
  {
    id: 'marketing',
    label: '营销与获客（广告 / 社媒投放 / 邮件 / 线索）',
    why: '一个人做增长：投放、内容分发、邮件与线索管理。',
    keep: { 'marketing': 4, 'seo': 4, 'ads': 4, 'advert': 3, 'campaign': 4, 'growth': 3, 'lead': 3, 'newsletter': 4, 'email': 3, 'mail': 2, 'social': 3, 'postiz': 4, 'brand': 3, 'promo': 3, 'funnel': 3, 'landing': 3 },
    drop: ['marketplace', 'plugin-market', 'market$'],
  },
  {
    id: 'office',
    label: '办公与文档（Office / PDF / 表格 / 任务 / 日程）',
    why: '日常运转：文档、表格、PDF、任务板与日程。',
    keep: { 'office': 4, 'docx': 4, 'xlsx': 4, 'pptx': 4, 'excel': 3, 'slide': 3, 'pdf': 4, 'sheet': 3, 'spreadsheet': 4, 'calendar': 3, 'schedule': 2, 'mail': 2, 'meeting': 3, 'todo': 3, 'taskboard': 4, 'task': 2, 'kanban': 4, 'jira': 3, 'notion': 3, 'obsidian': 3, 'wiki': 3, 'docs': 2, 'report': 2, 'notes': 2, 'reminder': 3 },
  },
  {
    id: 'writing',
    label: '自由撰写（写作 / 改写 / 翻译 / 内容）',
    why: '你的主要产出：长文、改写、翻译与内容工作流。',
    keep: { 'write': 3, 'writing': 4, 'writer': 3, 'novel': 4, 'screenplay': 4, 'blog': 3, 'article': 3, 'markdown': 2, 'translat': 4, 'polish': 2, 'proofread': 4, 'essay': 3, 'copywrite': 4, 'rewrite': 4, 'content': 2, 'editor': 2, 'summary': 2, 'i18n': 3, 'locale': 2, 'subtitle': 2, 'script': 2 },
  },
  {
    id: 'social',
    label: '社交与沟通（IM / 渠道 / 通知 / 收件箱）',
    why: '对外触达与对内提醒：渠道接入、通知、收件箱与会话管理。',
    keep: { 'social': 4, 'chat': 3, 'discord': 4, 'slack': 4, 'telegram': 4, 'feishu': 4, 'lark': 3, 'wecom': 4, 'dingtalk': 4, 'wechat': 3, 'weixin': 3, 'matrix': 3, 'mastodon': 4, 'comment': 2, 'community': 2, 'notify': 3, 'notification': 3, 'message': 2, 'inbox': 4, 'im': 2, 'channel': 2, 'pocket': 2, 'im-': 2 },
  },
  {
    id: 'memory',
    label: '记忆与知识（RAG / 记忆 / 检索）',
    why: '补充类目（数据充足）：让"一人公司"的经验与资料可复用。',
    keep: { 'memory': 4, 'knowledge': 4, 'rag': 4, 'embed': 3, 'vector': 3, 'recall': 3, 'viking': 3, 'memsearch': 4, 'graph-memory': 4, 'retrieval': 4, 'index': 2, 'corpus': 3, 'note': 2, 'wiki': 2, 'search': 2, 'dejavu': 3, 'context': 2 },
  },
  {
    id: 'automation',
    label: '自动化与工作流（编排 / 定时 / 触发 / 多智能体）',
    why: '补充类目（数据充足）：把重复劳动交给流程与智能体团队。',
    keep: { 'workflow': 4, 'flow': 3, 'automat': 4, 'pipeline': 3, 'schedule': 3, 'cron': 4, 'orchestr': 4, 'trigger': 3, 'hook': 3, 'batch': 2, 'agent-team': 4, 'agentteam': 4, 'loop': 3, 'ouroboros': 3, 'queue': 2 },
  },
  {
    id: 'cost',
    label: '成本与用量（token 计量 / 账单 / 配额）',
    why: '补充类目：一人公司必须看见自己的成本曲线（数据很充足）。',
    keep: { 'usage': 3, 'cost': 4, 'token': 3, 'billing': 3, 'quota': 4, 'budget': 4, 'price': 2, 'meter': 4, 'ledger': 4, 'stats': 2, 'metric': 2, 'telemetry': 3, 'damage': 3 },
  },
  {
    id: 'ops',
    label: '部署与运维（远程 / 服务器 / 备份 / 终端 / 移动端）',
    why: '补充类目：自建服务器后的日常运维与远程操作。',
    keep: { 'deploy': 4, 'devops': 4, 'docker': 4, 'kubernetes': 4, 'k8s': 4, 'ssh': 4, 'remote': 3, 'server': 3, 'pm2': 4, 'nginx': 4, 'systemd': 4, 'monitor': 3, 'log': 2, 'backup': 4, 'restore': 3, 'proxy': 3, 'tunnel': 4, 'wsl': 3, 'shell': 3, 'terminal': 3, 'mobile': 3, 'android': 3, 'ios': 3, 'sev': 3 },
  },
  {
    id: 'browser',
    label: '浏览器与网页自动化（抓取 / 表单 / 多标签）',
    why: '补充类目：一人公司的很多重复操作都在网页上（抓取、填表、巡检）。',
    keep: { 'browser': 4, 'chrome': 3, 'chromium': 3, 'playwright': 4, 'puppeteer': 4, 'selenium': 4, 'scrape': 4, 'crawl': 4, 'web-automation': 4, 'tab': 2, 'devtools': 3, 'bridge-browser': 4 },
  },
  {
    id: 'security',
    label: '安全与合规（权限 / 审计 / 密钥 / 沙箱）',
    why: '补充类目：一人公司同样要守住的底线。',
    keep: { 'security': 4, 'secret': 4, 'vault': 4, 'auth': 3, 'permission': 4, 'sandbox': 4, 'audit': 4, 'encrypt': 4, 'redact': 4, 'privacy': 4, 'license': 3, 'scan': 3, 'pentest': 4, 'redteam': 4, 'guard': 3, 'approval': 3, 'injection': 4 },
  },
  {
    id: 'data',
    label: '数据与分析（SQL / 报表 / 看板）',
    why: '补充类目：把经营数据变成可查询、可展示的东西。',
    keep: { 'sql': 4, 'database': 4, 'duckdb': 4, 'analytics': 4, 'dashboard': 4, 'data': 3, 'csv': 3, 'etl': 4, 'query': 3, 'sandbase': 3, 'insight': 3, 'research': 2 },
  },
  {
    id: 'dev',
    label: '开发与工程（Git / 代码审查 / 测试 / CI）',
    why: '补充类目（数据最多）：一人公司自己就是研发团队。',
    keep: { 'git': 3, 'code': 3, 'review': 3, 'test': 2, 'debug': 3, 'lint': 4, 'refactor': 4, 'build': 2, 'ci': 2, 'repo': 2, 'patch': 2, 'typescript': 3, 'python': 3, 'api': 2, 'sdk': 2, 'mcp': 2, 'codegraph': 3, 'pencil': 2 },
  },
]

const FLOOR = 10

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

/** Repository identity of one catalog entry (monorepo subpaths collapse). */
function repoOf(entry) {
  const match = /github\.com\/([^/]+\/[^/#?]+)/.exec(entry.url ?? '')
  if (match === null) return (entry.owner ?? '') + '/' + (entry.name ?? '')
  return match[1].replace(/\.git$/u, '')
}

/** The `#subpath` marker the source catalog uses for monorepo packages. */
function subpathOf(entry) {
  return typeof entry.name === 'string' && entry.name.includes('#') ? entry.name.split('#').slice(1).join('#') : ''
}

/**
 * Text the keywords are matched against.
 *
 * The OWNER is deliberately excluded: owners are personal handles, and including
 * them produced fake matches (`superdesigndev` → design, `lusblead` → lead,
 * `springbrand-lab` → brand, `SLin-code` → code). Only the plugin name, the
 * repository NAME and the upstream category carry intent.
 */
function haystack(entry) {
  const repoName = repoOf(entry).split('/').slice(1).join('/')
  // `category` on the raw catalog row; `sourceCategory` once it has been mapped
  // into a build row. Reading only one of the two silently dropped the upstream
  // taxonomy from the match, which cost whole projects their category
  // (`hindsight` is filed as `memory` upstream and matched nothing else).
  const upstream = entry.category ?? entry.sourceCategory ?? ''
  return `${entry.name ?? ''} ${repoName} ${subpathOf(entry)} ${upstream}`.toLowerCase()
}

/**
 * Tokens that must match a whole word.
 *
 * Substring matching is right for product-ish names (`mermaid`, `postiz`) but
 * wrong for short or word-like ones: `word` fired inside `passwords` and `stat`
 * inside a status rotator, each of which then "proved" the plugin belonged to a
 * category it has nothing to do with.
 */
const BOUNDARY_TOKENS = new Set(['im', 'ci', 'db', 'word', 'stat', 'note', 'notes', 'task', 'taskboard', 'mail', 'post', 'ads', 'log', 'chat'])

function hits(text, token) {
  return token.length <= 3 || BOUNDARY_TOKENS.has(token)
    ? new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, 'u').test(text)
    : text.includes(token)
}

/**
 * The plugin's own words: name, repository name and monorepo subpath.
 * Deliberately separate from the upstream category (see {@link classify}).
 */
function nameText(entry) {
  const repoName = repoOf(entry).split('/').slice(1).join('/')
  return `${entry.name ?? ''} ${repoName} ${subpathOf(entry)}`.toLowerCase()
}

/** The upstream catalog category, as a weaker signal. */
function categoryText(entry) {
  return String(entry.category ?? entry.sourceCategory ?? '').toLowerCase()
}

/**
 * Pick one category per entry: NAME first, upstream category only as a fallback.
 *
 * Weighting both together let the coarse upstream taxonomy overrule a clear name:
 * `Openwrite` (718★) is filed upstream as `workflow`, so "workflow + flow" beat
 * the `write` in its own name and it was listed under automation. The upstream
 * category is still useful when a name says nothing (`hindsight` → memory), which
 * is exactly what a fallback is for.
 */
function classify(entry) {
  const name = nameText(entry)
  const category = categoryText(entry)
  let best = null
  let fallback = null
  for (const spec of CATEGORIES) {
    if ((spec.drop ?? []).some(rule => new RegExp(rule, 'u').test(`${name} ${category}`))) continue
    let score = 0
    let categoryScore = 0
    const matched = []
    for (const [token, weight] of Object.entries(spec.keep)) {
      if (hits(name, token)) { score += weight; matched.push(token + ':' + String(weight)) }
      else if (hits(category, token)) { categoryScore += weight; matched.push(`${token}~:${String(weight)}`) }
    }
    if (score > 0 && (best === null || score > best.score)) best = { id: spec.id, score, matched }
    if (categoryScore > 0 && (fallback === null || categoryScore > fallback.score)) {
      fallback = { id: spec.id, score: categoryScore, matched }
    }
  }
  return best ?? fallback
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

const payload = JSON.parse(readFileSync(source, 'utf8'))
const entries = Array.isArray(payload) ? payload : (payload.plugins ?? payload.registry?.plugins ?? [])
if (!Array.isArray(entries) || entries.length === 0) {
  console.error(`no plugin entries found in ${source}`)
  process.exit(1)
}

/**
 * Classify EVERY entry, then keep the best entry per (category, repository).
 *
 * Deduplicating by repository first — which is what this did — silently lost
 * whole categories: a monorepo publishes several packages under one star count,
 * and collapsing to a single row before classifying meant `hindsight` (upstream
 * category `memory`, 23 540★) disappeared from the memory list because another
 * package of the same repo won the tie-break. Within one category the repo still
 * appears once, which is what the deduplication was for.
 */
const classified = new Map()
for (const category of CATEGORIES) classified.set(category.id, new Map())
const all = new Map()
let uncategorized = 0
for (const entry of entries) {
  const repo = repoOf(entry)
  const row = {
    name: entry.name,
    repo,
    subpath: subpathOf(entry),
    url: entry.url,
    npm: entry.npm ?? null,
    owner: entry.owner ?? null,
    stars: typeof entry.stars === 'number' ? entry.stars : 0,
    downloads: typeof entry.downloads === 'number' ? entry.downloads : null,
    sourceCategory: entry.category ?? null,
    added: entry.added ?? null,
    install: entry.install ?? null,
  }
  const seen = all.get(repo)
  if (seen === undefined || row.stars > seen.stars) all.set(repo, row)
  const verdict = classify(row)
  if (verdict === null) { uncategorized += 1; continue }
  const bucket = classified.get(verdict.id)
  const current = bucket.get(repo)
  if (current === undefined || row.stars > current.stars) bucket.set(repo, row)
}

const byCategory = new Map(CATEGORIES.map(category => [category.id, [...classified.get(category.id).values()]]))

/** Star-descending, with downloads as the tie-breaker. */
function ranked(list) {
  return [...list].sort((left, right) => (right.stars - left.stars) || ((right.downloads ?? 0) - (left.downloads ?? 0)))
}

const report = CATEGORIES.map(category => {
  const list = ranked(byCategory.get(category.id))
  return {
    ...category,
    total: list.length,
    strong: list.filter(entry => entry.stars >= FLOOR).length,
    top: list.slice(0, 20),
  }
})

mkdirSync(outDir, { recursive: true })

/** Machine-readable rows (one per category × plugin), CSV for spreadsheets. */
const rows = []
for (const category of report) {
  category.top.forEach((entry, index) => {
    rows.push({
      category: category.id,
      categoryLabel: category.label,
      rank: index + 1,
      name: entry.name,
      repo: entry.repo,
      subpath: entry.subpath,
      stars: entry.stars,
      downloads: entry.downloads,
      npm: entry.npm,
      url: entry.url,
      install: entry.install,
      added: entry.added,
      kind: entry.subpath === '' ? 'standalone' : 'monorepo-subpath',
    })
  })
}

const csv = [
  'category,categoryLabel,rank,name,repo,subpath,stars,downloads,npm,url,kind',
  ...rows.map(row => [row.category, row.categoryLabel, row.rank, row.name, row.repo, row.subpath, row.stars, row.downloads ?? '', row.npm ?? '', row.url, row.kind]
    .map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')),
].join('\n') + '\n'

/**
 * The catalog a DSH host can consume directly: `plugins[]` with the fields the
 * galaxy's loader reads (`name` + `npm` | `url` | `tarball`), extended with the
 * business category and the real star count so a self-hosted server can serve it
 * as-is.
 */
const catalogJson = {
  schema: 'dsh-plugin-catalog/1',
  generatedAt: new Date().toISOString(),
  source: { entries: entries.length, repos: all.size, floor: FLOOR, uncategorized },
  categories: report.map(category => ({
    id: category.id,
    label: category.label,
    why: category.why,
    matched: category.total,
    strong: category.strong,
  })),
  plugins: rows.map(row => ({
    name: row.name,
    ...(row.npm === null ? {} : { npm: row.npm }),
    url: row.url,
    owner: row.repo.split('/')[0],
    category: row.category,
    categoryLabel: row.categoryLabel,
    rank: row.rank,
    stars: row.stars,
    ...(row.downloads === null ? {} : { downloads: row.downloads }),
    ...(row.subpath === '' ? {} : { monorepo: row.subpath }),
    ...(row.install === null ? {} : { install: row.install }),
    ...(row.added === null ? {} : { added: row.added }),
  })),
}

/** Ready-to-run install commands, so a deployment does not start with copy-paste. */
const installScript = [
  '#!/bin/sh',
  '# OPC plugin starter set — generated by scripts/build-opc-catalog.mjs',
  '#',
  '# Every line is a package-manager operation. Read the report first: installing',
  '# 15 categories at once into one profile is a large, slow profile, and the',
  '# galaxy installs one package per command (it serializes on the install lock).',
  '#',
  '# Usage:  sh catalog/opc-install.sh memory        # one category, top 5',
  '#         sh catalog/opc-install.sh all           # everything (NOT recommended)',
  '#         PROFILE=web TOP=3 sh catalog/opc-install.sh dev',
  '',
  'PROFILE="${PROFILE:-web}"',
  'TOP="${TOP:-5}"',
  'wanted="${1:-}"',
  '',
  'install_one() {',
  '  echo "== dsh plugin --profile $PROFILE add $1"',
  '  dsh plugin --profile "$PROFILE" add "$1" || echo "   (failed: $1)"',
  '}',
  '',
]
for (const category of report) {
  installScript.push(`# ${category.label} — ${category.total} repos, ${category.strong} with ★>=${FLOOR}`)
  const specs = category.top.slice(0, 5).map(entry => entry.npm ?? entry.name)
  installScript.push(`if [ "$wanted" = "${category.id}" ] || [ "$wanted" = "all" ]; then`)
  specs.forEach((spec, index) => {
    installScript.push(`  [ ${index} -lt "$TOP" ] && install_one ${spec}`)
  })
  installScript.push('fi', '')
}
installScript.push('echo "done — restart the host if the plugin list did not refresh"')

const markdown = [
  '# OPC（一人公司）DSH 插件选型目录',
  '',
  `> 数据源：DSH 插件目录 ${entries.length} 条 → 去重后 **${all.size} 个仓库**；其中 ${uncategorized} 条未能归入任何类目（多为基础/界面/主题类，本目录不收录）；生成于 ${catalogJson.generatedAt}`,
  '> 星级是**仓库级**的：monorepo 内的插件条目（`repo#subpath`）会继承整个仓库的 star，已单独标注。',
  '',
  '## 分类深度（真实数据，不填充）',
  '',
  '| 分类 | 命中仓库 | ★≥10 | 能否凑满 20 |',
  '|---|---:|---:|---|',
  ...report.map(category => {
    // Three different truths hide behind "less than 20": not enough repos at all,
    // enough repos but a thin starred head, or a full 20 with real depth. Saying
    // which one it is, is the point of the column.
    const verdict = category.total < 20
      ? `**生态仅 ${category.total} 个**`
      : (category.strong >= 20 ? '20 个均 ★≥10' : `20 个（其中 ★≥10 仅 ${category.strong} 个）`)
    return `| ${category.label} | ${category.total} | ${category.strong} | ${verdict} |`
  }),
  '',
]
for (const category of report) {
  markdown.push(`## ${category.label}`, '', `_${category.why}_`, '', `命中 ${category.total} 个仓库，其中 ${category.strong} 个 ★≥${FLOOR}。`, '', '| # | 插件 | ★ | 仓库 | 类型 |', '|---:|---|---:|---|---|')
  category.top.forEach((entry, index) => {
    markdown.push(`| ${index + 1} | \`${entry.name}\` | ${entry.stars} | [${entry.repo}](https://github.com/${entry.repo}) | ${entry.subpath === '' ? '独立仓库' : `子包 ${entry.subpath}`} |`)
  })
  const standalone = category.top.filter(entry => entry.subpath === '').slice(0, 10)
  markdown.push('')
  markdown.push(`**独立仓库优先看这些**（monorepo 子包的星级属于整个仓库，不代表该插件本身）：${standalone.length === 0 ? '_本类目暂无独立仓库条目_' : standalone.map(entry => `\`${entry.name}\`(${entry.stars}★)`).join(' · ')}`)
  markdown.push('')
  markdown.push(`<sub>安装：\`dsh plugin --profile <profile> add <npm 名>\`；npm 名与安装命令见 \`opc-plugins.json\` / \`opc-plugins.csv\`。</sub>`)
  markdown.push('')
}

const deployment = [
  '',
  '## 部署到自己的服务器（这份目录怎么用）',
  '',
  '1. **直接托管成插件的 catalog**：`opc-plugins.json` 就是 DSH 插件目录格式（`plugins[]`，每条带 `name` + `npm`|`url`），',
  '   放到你的静态服务器上（建议带 `ETag`），再把宿主指向它：',
  '',
  '   ```bash',
  '   # 宿主侧（写进 profile 的启动环境或 systemd unit）',
  '   DSHG_REGISTRY_URL=https://你的域名/opc-plugins.json',
  '   ```',
  '',
  '   插件会照常做条件请求与 TTL 缓存，无需改代码。',
  '2. **按类目安装**：`sh catalog/opc-install.sh <category>`（默认 top 5，可用 `TOP`/`PROFILE` 覆盖）。',
  '3. **注意**：本目录只负责"能装什么"；装的仍是**上游 npm/GitHub 包**。生产机建议先在测试 profile 里装、跑一次',
  '   `dsh plugin --profile <p> add` 后再切正式 profile，并留意插件的 `dsh.engines.dsh` 是否要求更高宿主版本。',
  '4. **重名/重复仓库**：`opc-plugins.json` 里同一仓库只保留其在**该类目内**排名最高的一条，`monorepo` 字段标明子包路径。',
  '',
]
markdown.push(...deployment)

writeFileSync(join(outDir, 'opc-plugins.json'), JSON.stringify(catalogJson, null, 2) + '\n')
writeFileSync(join(outDir, 'opc-install.sh'), installScript.join('\n') + '\n')
writeFileSync(join(outDir, 'opc-plugins.csv'), csv)
writeFileSync(join(outDir, 'opc-top20.md'), markdown.join('\n') + '\n')

// `--why <text>` traces one plugin end to end: haystack, per-category scores,
// the winning category, and whether it survived that category's dedup. This is
// how a missing big project gets diagnosed without guessing.
const whyIndex = process.argv.indexOf('--why')
if (whyIndex !== -1 && process.argv[whyIndex + 1] !== undefined) {
  const needle = process.argv[whyIndex + 1].toLowerCase()
  for (const entry of entries) {
    if (!`${entry.name} ${entry.url}`.toLowerCase().includes(needle)) continue
    const row = { name: entry.name, repo: repoOf(entry), subpath: subpathOf(entry), url: entry.url, category: entry.category ?? null, stars: entry.stars ?? 0 }
    const scores = CATEGORIES.map(category => {
      const text = haystack({ ...row, owner: entry.owner ?? null, downloads: null, npm: null, added: null, install: null, sourceCategory: row.category })
      const dropped = (category.drop ?? []).some(rule => new RegExp(rule, 'u').test(text))
      const matched = Object.entries(category.keep).filter(([token]) => !dropped && hits(text, token))
      const score = matched.reduce((sum, [, weight]) => sum + weight, 0)
      return { id: category.id, score, matched: matched.map(([token, weight]) => `${token}:${weight}`) }
    }).filter(item => item.score > 0).sort((left, right) => right.score - left.score)
    const verdict = classify(row)
    const bucket = verdict === null ? undefined : classified.get(verdict.id)
    const winner = bucket?.get(row.repo)
    console.log(`\n${entry.name}  repo=${row.repo}  subpath="${row.subpath}"  stars=${String(row.stars)}  upstream=${row.category}`)
    console.log(`  haystack: ${haystack({ ...row, category: row.category }).trim()}`)
    console.log(`  scores:   ${scores.map(item => `${item.id}=${item.score}[${item.matched.join(',')}]`).join('  ') || '(none)'}`)
    const outcome = winner === undefined
      ? 'not in that category bucket'
      : (winner.name === row.name ? 'listed' : `superseded by ${winner.name} (${String(winner.stars)}★)`)
    console.log(`  verdict:  ${verdict?.id ?? '(uncategorized)'} — ${outcome}`)
  }
}

// `--explain` prints WHY each listed plugin landed in its category. Keyword
// classification is only as good as the traps it avoids (`word` inside
// `passwords`, `stat` inside a status rotator), and this is how those get found
// and fixed instead of being shipped as "the ecosystem has 106 office plugins".
if (process.argv.includes('--explain')) {
  for (const category of report) {
    console.log(`\n=== ${category.id} (${category.total} repos, ${category.strong} strong)`)
    for (const entry of category.top.slice(0, 12)) {
      const verdict = classify(entry)
      console.log(`  ${String(entry.stars).padStart(5)}★ ${entry.name.padEnd(38)} score=${String(verdict?.score).padStart(3)} [${(verdict?.matched ?? []).join(' ')}]`)
    }
  }
}

console.log(`entries=${entries.length} repos=${all.size} uncategorized=${uncategorized} listed=${rows.length} → ${outDir}`)
for (const category of report) {
  console.log(`  ${category.id.padEnd(11)} total=${String(category.total).padStart(4)} strong=${String(category.strong).padStart(3)} top=${category.top.length}`)
}
