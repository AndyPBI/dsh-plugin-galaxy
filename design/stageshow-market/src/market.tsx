import { Check, ChevronDown, RefreshCw, Search } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Button, Card, Stage, Window, type Act } from '@kit'
import './market.css'

// dsh-plugin-galaxy — the plugin market, 0.1.38. Rebuilt from the panel the
// product actually renders (docs/screenshots/01-market-all.png): a two-line
// toolbar, a result count, and a three-column CARD grid. The earlier draft drew
// a list of rows, which the product has never had.
//
// The change this composition argues for is the status row: six mutually
// exclusive chips became one slider with a travelling thumb, 分类筛选 and 排序
// moved onto its line, and the two actionable segments carry their counts.
//
// Real strings: the six segment labels, the search placeholder, the two select
// values, the count line, three plugin names and their category/score/actions.
// The other three cards run on filler for their category line.

type S = { filter: number }

const initial: S = { filter: 0 }

const SEGMENTS = ['全部', '甄选', '已安装', '推荐', '可更新', '不兼容']
const TARGETS = ['all', 'featured', 'installed', 'rec', 'upd', 'bad']
const COUNTS: Record<number, number> = { 2: 8, 4: 3 }

type P = {
  name: string
  score: number
  cat: string
  stars: string
  dl: string
  installed: boolean
  upd?: boolean
}

const PLUGINS: P[] = [
  { name: 'modsearch', score: 92, cat: '记忆与知识', stars: '875', dl: '46649', installed: true, upd: true },
  { name: 'dsh-office-tools', score: 89, cat: '办公与文档', stars: '37', dl: '10477', installed: true },
  { name: 'study-mate', score: 87, cat: '自动化与工作流', stars: '1144', dl: '6581', installed: false },
  { name: 'dsh-remote', score: 88, cat: '部署与运维', stars: '221', dl: '36398', installed: true },
  { name: 'dsh-browser', score: 86, cat: '浏览器与网页自动化', stars: '154', dl: '25770', installed: false },
  { name: 'dsh-gitbash-shell', score: 85, cat: '部署与运维', stars: '41', dl: '10427', installed: true },
  { name: 'dsh-paper-reader', score: 84, cat: '办公与文档', stars: '29', dl: '6754', installed: true },
  { name: 'meow-memory', score: 83, cat: '记忆与知识', stars: '342', dl: '20441', installed: true },
  { name: 'archify', score: 82, cat: '办公与文档', stars: '89901', dl: '39314', installed: false },
]

const INSTALLED_ONLY = 2
const shows = (p: P, filter: number) => (filter === INSTALLED_ONLY ? p.installed : true)
const REST = { at: 'rest', x: 0.5, y: 0.9 }

async function script(a: Act<S>) {
  await a.wait(1000)

  // 1. The pointer arrives on 已安装 — aimed at the cell's left margin, never
  //    across the label it is about to select.
  a.mark('hover')
  await a.move({ at: 'installed', x: 0.18, y: 0.5 })
  await a.wait(650)

  // 2. Press: the thumb travels 全部 -> 已安装, the grid drops to the installed
  //    three, and the count line follows.
  a.mark('switch')
  await a.click()
  await a.set({ filter: INSTALLED_ONLY })
  await a.wait(1500)

  // 3. The payoff: the installed set, its lifecycle actions, and the count.
  a.mark('result')
  await a.wait(2600)

  // 4. A caused reset: back to 全部, so the loop closes where it opened.
  a.mark('back')
  await a.move({ at: 'all', x: 0.18, y: 0.5 })
  await a.wait(500)
  await a.click()
  await a.set({ filter: 0 })
  await a.wait(1300)

  await a.move(REST)
  await a.wait(400)
}

function Slider({ filter }: { filter: number }) {
  // Measured, not index-multiplied: the segments are sized by their labels, so
  // the thumb's box comes from the active one.
  const track = useRef<HTMLDivElement | null>(null)
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const el = track.current
    if (el === null) return
    const active = el.querySelector<HTMLElement>('[data-on]')
    setThumb(active === null ? null : { left: active.offsetLeft, width: active.offsetWidth })
  }, [filter])

  return (
    <div className="gm2-slider" ref={track}>
      <span
        className="gm2-thumb"
        style={thumb === null ? { opacity: 0 } : { left: thumb.left, width: thumb.width }}
        aria-hidden="true"
      />
      {SEGMENTS.map((label, i) => (
        <button
          key={label}
          type="button"
          className="gm2-seg"
          data-on={i === filter || undefined}
          data-target={TARGETS[i]}
        >
          <span className="gm2-lab">{label}</span>
          {COUNTS[i] !== undefined && <span className="gm2-count">{COUNTS[i]}</span>}
        </button>
      ))}
    </div>
  )
}

function Toolbar({ filter }: { filter: number }) {
  return (
    <div className="gm2-toolbar">
      <div className="gm2-line">
        <div className="gm2-search">
          <Search size={15} strokeWidth={1.8} className="gm2-glyph" />
          <span className="gm2-ph">搜索插件，例如：通知、终端、记忆…</span>
        </div>
        <Button size="small" variant="secondary" icon={<RefreshCw size={12} strokeWidth={1.9} />}>
          刷新
        </Button>
      </div>
      <div className="gm2-line">
        <Slider filter={filter} />
        <span className="gm2-grow" />
        <span className="gm2-select">
          全部分类
          <ChevronDown size={13} strokeWidth={2} className="gm2-glyph" />
        </span>
        <span className="gm2-select">
          评分 · 降序
          <ChevronDown size={13} strokeWidth={2} className="gm2-glyph" />
        </span>
      </div>
    </div>
  )
}

function PluginCard({ p, filter }: { p: P; filter: number }) {
  const installed = filter === INSTALLED_ONLY ? true : p.installed
  return (
    <Card className="gm2-card" pad="small" gap={9}>
      <div className="gm2-head">
          <span className="gm2-name">{p.name}</span>
          {installed && (
            <span className="gm2-ok">
              <Check size={10} strokeWidth={3} />
              已安装
            </span>
          )}
          {installed && p.upd === true && <span className="gm2-warn">可更新</span>}
          <span className="gm2-grow" />
          <span className="gm2-score">{`推荐 S · ${String(p.score)}`}</span>
        </div>
      <span className="gm2-cat">{`分类：${p.cat}`}</span>
      <div className="gm2-meta">
          <span className="gm2-star">{`★ ${p.stars}`}</span>
          <span className="gm2-muted">{`下载量 ${p.dl}`}</span>
          <span className="gm2-pill">兼容性未知</span>
        </div>
      <div className="gm2-foot">
          <span className="gm2-link">官网插件页</span>
          <span className="gm2-link">查看评论</span>
          <span className="gm2-grow" />
          {installed
            ? <Button size="small" variant="secondary">停用</Button>
            : <Button size="small" variant="primary">安装</Button>}
        </div>
    </Card>
  )
}

function Scene({ s }: { s: S }) {
  const total = s.filter === INSTALLED_ONLY ? 8 : 321
  return (
    // The kit's window is the "app's own pane": cards inside one are laid out,
    // not framed as satellites — which is exactly what this panel is.
    <Window chrome="hairline" className="gm2-panel" body={{ className: 'gm2-body' }}>
      <Toolbar filter={s.filter} />
      <p className="gm2-total">{`${String(total)} 个插件`}</p>
      <div className="gm2-grid" data-target="rest">
        {PLUGINS.filter(p => shows(p, s.filter)).map(p => (
          <PluginCard key={p.name} p={p} filter={s.filter} />
        ))}
      </div>
    </Window>
  )
}

export default function GalaxyMarketMock() {
  return (
    <Stage
      width={860}
      height={470}
      compact={{ below: 620, width: 400, height: 380 }}
      accent="#14161b"
      initial={initial}
      poster={{ filter: INSTALLED_ONLY }}
      script={script}
      cursor={{ at: REST }}
      className="gm2-stage"
    >
      {(s) => <Scene s={s} />}
    </Stage>
  )
}
