/**
 * Real-browser layout probe for the two panel defects that unit tests cannot
 * see, because jsdom has no layout engine:
 *
 *  1. **Vertical button labels.** The host `Button` primitive is
 *     `display:inline-flex` with no `white-space:nowrap` and no `min-width:0`,
 *     so inside a constrained row it shrinks to its min-content width — ONE
 *     Chinese character — and its label wraps one glyph per line. The restart
 *     banner's "关闭" button did exactly that.
 *  2. **Scrambled list rows.** In "已安装 → 列表" the badge line claimed its full
 *     intrinsic width, squeezing the action buttons to that same one-glyph width
 *     and overflowing the row.
 *
 * The probe renders the real DOM structure and the real CSS — extracted from the
 * built `client/client.js`, so the artifact under test is the shipped one — with
 * the host's own `Button.module.css` verbatim. Each scenario is rendered twice:
 * with the current rules ("after") and with the pre-fix rules restored by an
 * override ("before"), which is the mutation control: the "after" assertions
 * must hold, and the "before" metrics are reported so a probe that fails to
 * reproduce the defect says so instead of pretending to prove anything.
 *
 * Layout is measured, not eyeballed: the number of line boxes a label occupies
 * (`Range.getClientRects().length`) is 1 exactly when the text is horizontal.
 *
 * Usage: node scripts/layout-check.mjs [--chrome <path>] [--keep]
 *   Chrome is required; when it is missing the check SKIPs with exit code 2.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')
const probeDir = join(workspace, '.layout-probe')
const PANEL_WIDTH = 420

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

function chromePath() {
  const flag = process.argv.indexOf('--chrome')
  if (flag !== -1 && process.argv[flag + 1] !== undefined) return resolve(process.argv[flag + 1])
  if (process.env.CHROME_PATH !== undefined && process.env.CHROME_PATH !== '') return process.env.CHROME_PATH
  return CHROME_CANDIDATES.find(candidate => existsSync(candidate))
}

function harnessRoot() {
  const flag = process.argv.indexOf('--harness')
  if (flag !== -1 && process.argv[flag + 1] !== undefined) return resolve(process.argv[flag + 1])
  if (process.env.DSH_HARNESS !== undefined && process.env.DSH_HARNESS !== '') return resolve(process.env.DSH_HARNESS)
  return resolve(workspace, '..', 'deepseek-harness')
}

const chrome = chromePath()
if (chrome === undefined) {
  console.error('SKIP  no Chrome/Chromium found; pass --chrome <path> or set CHROME_PATH.')
  process.exit(2)
}

/* ---------------------------------------------------------------- *
 * Inputs: the shipped CSS + the host's button rules
 * ---------------------------------------------------------------- */

const bundle = join(workspace, 'client', 'client.js')
if (!existsSync(bundle)) {
  console.error(`SKIP  ${bundle} not found; run npm run build:client first.`)
  process.exit(2)
}
const bundleSource = readFileSync(bundle, 'utf8')

/** The CSS text the bundle injects, and its class-name map. */
function extractStyles(source) {
  const cssMatch = source.match(/const css = ("(?:[^"\\]|\\.)*");\s*\n\s*const tagId = "dsh-plugin-galaxy\/Galaxy\.module\.css"/)
  if (cssMatch === null) throw new Error('could not find the injected CSS in client/client.js')
  const css = JSON.parse(cssMatch[1])
  const mapMatch = source.match(/var Galaxy_module_css_default = \{([\s\S]*?)\n\t*\};/)
  if (mapMatch === null) throw new Error('could not find the class-name map in client/client.js')
  const classes = {}
  for (const [, key, value] of mapMatch[1].matchAll(/"([^"]+)": "([^"]+)"/g)) classes[key] = value
  return { css, classes }
}

const { css, classes } = extractStyles(bundleSource)
for (const required of ['listRow', 'listActions', 'stack', 'row', 'banner', 'bannerWarn', 'cardActions', 'cardTitle', 'badge', 'tag', 'muted', 'ellipsis', 'hint', 'select', 'spacer', 'actionLink']) {
  if (classes[required] === undefined) throw new Error(`the bundle has no class for "${required}" — was the CSS renamed?`)
}

const hostButtonCssPath = join(harnessRoot(), 'packages', 'client', 'ui-primitives', 'src', 'Button.module.css')
if (!existsSync(hostButtonCssPath)) {
  console.error(`SKIP  host Button.module.css not found at ${hostButtonCssPath}\n      pass --harness <deepseek-harness dir> or set DSH_HARNESS.`)
  process.exit(2)
}
// Verbatim: the probe's buttons carry the host's own class names, so its
// geometry is the production geometry.
const hostButtonCss = readFileSync(hostButtonCssPath, 'utf8')

/** Pre-fix rules, restored to prove the probe reproduces the reported defect. */
const beforeOverrides = `
.before .${classes.banner} > button{flex-shrink:1;white-space:normal}
.before .${classes.banner} > .${classes.stack}{flex:0 1 auto}
.before .${classes.listRow}{flex-wrap:nowrap}
.before .${classes.listRow} > .${classes.stack}{flex:0 1 auto}
.before .${classes.listActions}{flex-shrink:1;margin-left:0}
.before .${classes.cardActions} > button{flex-shrink:1;white-space:normal}
`

/* ---------------------------------------------------------------- *
 * Probe document
 * ---------------------------------------------------------------- */

const bannerTitle = '需要重启才能完全生效 · @openviking/dsh-memory-plugin'
const bannerBody = '变更已写入 profile，但当前宿主进程仍在运行旧状态（插件仍在内存与侧栏中）。请完整重启 DeepSeek Harness。'

function button(label, variant) {
  return `<button type="button" class="button sm ${variant}">${label}</button>`
}

function banner({ before }) {
  const spacer = before ? `<span class="${classes.spacer}"></span>` : ''
  return `
  <div class="${classes.banner} ${classes.bannerWarn}" role="status" data-scenario="${before ? 'banner-before' : 'banner-after'}">
    <span class="${classes.stack}">
      <span>${bannerTitle}</span>
      <span class="${classes.muted}">${bannerBody}</span>
    </span>
    ${spacer}
    ${button('关闭', 'ghost')}
  </div>`
}

/**
 * One card-actions row: the site link beside the host's small buttons.
 *
 * `before` is the shipped-pre-fix markup — the anchor carries only `.link`, so it
 * inherits whatever the dialog sets (the host sets nothing, so the browser's
 * 16px) while 「查看评论」 is a `Button size="sm"` at 12px.
 *
 * The wrapper pins the inherited size because that is the whole variable: the
 * panel does not control it, and 16px is what an unstyled descendant of the host
 * shell actually gets (body/html/#root carry no font-size in its shipped CSS).
 */
function actionRow({ before }) {
  return `
  <div class="${classes.cardActions}" data-scenario="${before ? 'actions-before' : 'actions-after'}">
    <a class="${before ? classes.link : `${classes.link} ${classes.actionLink}`}"
       href="https://www.yhaigc.cn/#/ai/p/liustack%2Fmodlens" target="_blank" rel="noreferrer noopener"
       title="在官网查看该插件的详情与安装说明">官网插件页</a>
    ${button('查看评论 (3)', 'ghost')}
    <span class="${classes.spacer}"></span>
    ${button('安装', 'primary')}
  </div>`
}

/** One "已安装 → 列表" row, exactly as InstalledRow renders it. */
function listRow({ before }) {
  const spacer = before ? `<span class="${classes.spacer}"></span>` : ''
  return `
  <div role="listitem" class="${classes.listRow}" data-scenario="${before ? 'list-before' : 'list-after'}">
    <div class="${classes.stack}">
      <div class="${classes.row}">
        <span class="${classes.cardTitle}">@openviking/dsh-memory-plugin</span>
        <span class="${classes.badge}">0.3.0</span>
        <span class="${classes.tag}">来源: npm</span>
        <span class="${classes.badge} ${classes.badgeMuted}">bundle</span>
      </div>
      <span class="${classes.muted} ${classes.ellipsis}">@openviking/dsh-memory-plugin@^0.3.0</span>
    </div>
    ${spacer}
    <div class="${classes.cardActions} ${classes.listActions}">
      ${button('停用', 'outline')}
      ${button('更新', 'primary')}
      ${button('添加备注', 'ghost')}
      <label class="${classes.row}">
        <span class="${classes.muted}">分组</span>
        <select class="${classes.select}"><option>未分组</option></select>
      </label>
      ${button('加入收藏', 'ghost')}
      ${button('更新日志', 'ghost')}
      ${button('卸载', 'outline')}
    </div>
  </div>`
}

const probeHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>dsh-plugin-galaxy layout probe</title>
<style>
${hostButtonCss}
/* Cosmetic only (labels/backgrounds for the screenshot); the assertions below
 * never read a colour. Values mirror the host's light theme. */
:root{
  --dsw-alias-label-primary:#1f2328;
  --dsw-alias-label-primary-foreground:#ffffff;
  --dsw-alias-label-secondary:#6b7280;
  --dsw-alias-label-tertiary:#8b93a1;
  --dsw-alias-bg-layer-1:#ffffff;
  --dsw-alias-bg-layer-2:#f5f6f8;
  --dsw-alias-border-l2:#e5e7eb;
  --dsw-alias-border-l3:#c9ced8;
  --dsw-alias-brand-primary:#4f6ef7;
  --dsw-alias-button-primary-fill:#4f6ef7;
  --dsw-alias-interactive-bg-hover:#eef0f4;
  --dsw-alias-state-warn-primary:#a3670b;
}
body{margin:0;padding:16px;font:12px/18px -apple-system,"Segoe UI","PingFang SC",sans-serif;background:#fff;color:#1f2328}
h1{font-size:13px;margin:0 0 8px}
h2{font-size:12px;margin:16px 0 6px;color:#6b7280}
.panel{width:${PANEL_WIDTH}px;border:1px dashed #c9ced8;padding:8px;margin:0 0 4px}
${css}
${beforeOverrides}
</style></head>
<body>
<h1>dsh-plugin-galaxy — 面板布局探针 (${PANEL_WIDTH}px)</h1>
<h2>重启提示横幅 · before（修复前规则）</h2>
<div class="panel before">${banner({ before: true })}</div>
<h2>重启提示横幅 · after（当前规则）</h2>
<div class="panel">${banner({ before: false })}</div>
<h2>已安装 → 列表 · before（修复前规则）</h2>
<div class="panel before"><div class="${classes.list}">${listRow({ before: true })}</div></div>
<h2>已安装 → 列表 · after（当前规则）</h2>
<div class="panel"><div class="${classes.list}">${listRow({ before: false })}</div></div>
<h2>插件卡片操作行 · before（链接只带 .link，继承 16px）</h2>
<div class="panel" style="font-size:16px">${actionRow({ before: true })}</div>
<h2>插件卡片操作行 · after（链接与 sm 按钮同为 12px）</h2>
<div class="panel" style="font-size:16px">${actionRow({ before: false })}</div>
<pre id="result"></pre>
<script>
/** Line boxes a button's label occupies: 1 means the text is horizontal. */
function labelLineBoxes(element) {
  const range = document.createRange()
  range.selectNodeContents(element)
  return range.getClientRects().length
}
function measure(scenario) {
  const root = document.querySelector('[data-scenario="' + scenario + '"]')
  const panel = root.parentElement
  const boxes = element => {
    const r = element.getBoundingClientRect()
    return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height }
  }
  try {
    const buttons = Array.from(root.querySelectorAll('button'))
    const info = root.querySelector('.${classes.stack}')
    const actions = root.querySelector('.${classes.listActions}')
    const infoBox = info === null ? null : boxes(info)
    const actionBox = actions === null ? null : boxes(actions)
    /**
     * Text metrics of an action-row link vs the small buttons beside it. Read
     * with getComputedStyle (the resolved values), not from the rule text: that
     * is what the user actually sees.
     */
    const link = root.querySelector('a')
    const linkStyle = link === null ? null : getComputedStyle(link)
    const buttonStyle = buttons.length === 0 ? null : getComputedStyle(buttons[0])
    return {
      scenario,
      buttonLabels: buttons.map(b => ({ label: b.textContent.trim(), lineBoxes: labelLineBoxes(b), width: Math.round(b.getBoundingClientRect().width * 10) / 10 })),
      widestLabelBoxes: Math.max(...buttons.map(b => labelLineBoxes(b))),
      info: infoBox,
      actions: actionBox,
      link: linkStyle === null ? null : { fontSize: linkStyle.fontSize, lineHeight: linkStyle.lineHeight, text: link.textContent.trim() },
      button: buttonStyle === null ? null : { fontSize: buttonStyle.fontSize, lineHeight: buttonStyle.lineHeight, text: buttons[0].textContent.trim() },
      // "stacked": the action group did not fit beside the info block and moved
      // to its own line, which is the intended narrow-panel behaviour.
      stacked: infoBox !== null && actionBox !== null && actionBox.top >= infoBox.bottom - 1,
      horizontalOverflow: panel.scrollWidth - panel.clientWidth,
    }
  } catch (error) {
    return { scenario, error: String(error) }
  }
}
const scenarios = ['banner-before', 'banner-after', 'list-before', 'list-after', 'actions-before', 'actions-after']
document.getElementById('result').textContent = JSON.stringify(scenarios.map(measure))
</script>
</body></html>`

mkdirSync(probeDir, { recursive: true })
const htmlPath = join(probeDir, 'probe.html')
writeFileSync(htmlPath, probeHtml, 'utf8')

/* ---------------------------------------------------------------- *
 * Run Chrome: measure, then screenshot
 * ---------------------------------------------------------------- */

/**
 * Run Chrome headless. Two environment quirks are handled here:
 *
 *  - a private profile dir, because the user's own Chrome may be running and
 *    headless must not attach to it;
 *  - a hard timeout with SIGKILL. On macOS `--screenshot` WRITES the PNG and
 *    then never exits (`CVDisplayLinkCreateWithCGDisplay failed`), so the
 *    screenshot call is allowed to be killed and its artifact is checked
 *    instead of its exit status.
 */
function runChrome(args, { timeoutMs = 30_000 } = {}) {
  const profile = join(probeDir, 'chrome-profile')
  try {
    return execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check', '--disable-crash-reporter',
      `--user-data-dir=${profile}`, ...args,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    })
  } catch (error) {
    // Chrome on macOS routinely writes its complete output and then never
    // exits (`CVDisplayLinkCreateWithCGDisplay failed`), so the captured stdout
    // is authoritative and a timeout kill is not a failure. A run that produced
    // nothing at all still throws.
    if (typeof error.stdout === 'string' && error.stdout.length > 0) return error.stdout
    throw error
  }
}

const dumped = runChrome([`--window-size=${PANEL_WIDTH + 80},1400`, '--dump-dom', pathToFileURL(htmlPath).href])
const resultMatch = dumped.match(/<pre id="result">([\s\S]*?)<\/pre>/)
if (resultMatch === null) {
  console.error('FAIL  the probe page produced no measurements')
  process.exit(1)
}
const decode = text => text.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const results = JSON.parse(decode(resultMatch[1]))
const broken = results.filter(entry => entry.error !== undefined)
if (broken.length > 0) {
  console.error(`FAIL  the probe page could not measure: ${broken.map(entry => `${entry.scenario}: ${entry.error}`).join('; ')}`)
  process.exit(1)
}
const byScenario = Object.fromEntries(results.map(entry => [entry.scenario, entry]))

let failures = 0
let warnings = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
function warn(label, detail) {
  warnings += 1
  console.log(`WARN  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const bannerBefore = byScenario['banner-before']
const bannerAfter = byScenario['banner-after']
const listBefore = byScenario['list-before']
const listAfter = byScenario['list-after']

// --- the control: the pre-fix rules must still break ------------------------
if (bannerBefore.widestLabelBoxes < 2) {
  warn('probe reproduces the vertical "关闭" label', `pre-fix label boxes = ${bannerBefore.widestLabelBoxes} (expected >= 2); the probe may not reproduce the reporter's width`)
} else {
  console.log(`INFO  pre-fix banner label boxes = ${bannerBefore.widestLabelBoxes} (vertical text reproduced)`)
}
if (bannerBefore.horizontalOverflow > 0) console.log(`INFO  pre-fix banner overflow = ${bannerBefore.horizontalOverflow}px`)
if (listBefore.horizontalOverflow > 0) console.log(`INFO  pre-fix list row overflow = ${listBefore.horizontalOverflow}px`)
const listBeforeWidest = Math.max(...listBefore.buttonLabels.map(entry => entry.lineBoxes))
console.log(`INFO  pre-fix list row widest label boxes = ${listBeforeWidest}`)

// --- the fix: horizontal labels, natural widths, no overflow ---------------
const closeAfter = bannerAfter.buttonLabels.find(entry => entry.label === '关闭')
check('banner 关闭 label occupies one line box', closeAfter?.lineBoxes === 1, `lineBoxes=${closeAfter?.lineBoxes}`)
check('banner 关闭 keeps its natural width', (closeAfter?.width ?? 0) >= 40, `width=${closeAfter?.width}px`)
check('banner does not overflow the panel', bannerAfter.horizontalOverflow <= 0, `overflow=${bannerAfter.horizontalOverflow}px`)

check('every list-row action label occupies one line box', listAfter.widestLabelBoxes === 1, `max lineBoxes=${listAfter.widestLabelBoxes}`)
check('every list-row action keeps a natural width', listAfter.buttonLabels.every(entry => entry.width >= 40),
  listAfter.buttonLabels.map(entry => `${entry.label}=${entry.width}`).join(' '))
check('list row does not overflow the panel', listAfter.horizontalOverflow <= 0, `overflow=${listAfter.horizontalOverflow}px`)
check('list row actions are beside or below the info block', listAfter.stacked || listAfter.info.right <= listAfter.actions.left + 0.5,
  `info.right=${Math.round(listAfter.info.right)} actions.left=${Math.round(listAfter.actions.left)} stacked=${listAfter.stacked}`)

// --- the site link in an action row matches the small buttons --------------
const actionsBefore = byScenario['actions-before']
const actionsAfter = byScenario['actions-after']
if (actionsBefore.link.fontSize === actionsBefore.button.fontSize) {
  warn('probe reproduces the action-link font mismatch',
    `pre-fix both read ${actionsBefore.link.fontSize}; the probe may not reproduce the reporter's inheriting font size`)
} else {
  console.log(`INFO  pre-fix action link = ${actionsBefore.link.fontSize} vs button ${actionsBefore.button.fontSize} (${actionsBefore.link.text} next to ${actionsBefore.button.text})`)
}
check('action-row link matches the small button font size',
  actionsAfter.link.fontSize === actionsAfter.button.fontSize,
  `link=${actionsAfter.link.fontSize} button=${actionsAfter.button.fontSize}`)
check('action-row link matches the small button line height',
  actionsAfter.link.lineHeight === actionsAfter.button.lineHeight,
  `link=${actionsAfter.link.lineHeight} button=${actionsAfter.button.lineHeight}`)

const screenshot = join(probeDir, 'layout.png')
// The PNG is written before Chrome hangs, so the file is the artifact and the
// exit status is ignored. See `runChrome`.
try {
  runChrome([`--window-size=${PANEL_WIDTH + 80},1400`, `--screenshot=${screenshot}`, pathToFileURL(htmlPath).href], { timeoutMs: 20_000 })
} catch {
  // ignored on purpose
}
if (!existsSync(screenshot) || statSync(screenshot).size === 0) {
  console.error(`FAIL  Chrome wrote no screenshot at ${screenshot}`)
  process.exit(1)
}

console.log(`\nprobe html: ${htmlPath}\nscreenshot:  ${screenshot}`)
if (failures > 0) {
  console.log(`\nLAYOUT CHECK: FAIL (${failures}${warnings > 0 ? `, ${warnings} warning(s)` : ''})`)
  process.exit(1)
}
console.log(`\nLAYOUT CHECK: PASS${warnings > 0 ? ` (${warnings} warning(s))` : ''}`)
