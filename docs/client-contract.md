# Plugin Galaxy — 客户端实现契约（Client Contract）

> 与 `docs/implementation-contract.md` 配套，约束 `src/client/` 的并行实现。
> 服务端契约见 `docs/implementation-contract.md`；客户端只通过 `market-data.ts` 访问服务端。

## 1. 运行形态

- 产物：tsdown 打包的 CJS 工厂 bundle `client/client.js`，由宿主 loader 注入（外部依赖：`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`）。
- 入口：`src/client/index.ts`，导出 `name`、`inject = ['slots','locale','theme']`、`apply(ctx)`。
- 命名空间常量 `NS = 'dsh-plugin-galaxy'`（locale 命名空间、settings.plugin.item 的 key 都是它）。
- 服务端前缀：`/dsh-galaxy`。所有请求相对同源。

## 2. 注册契约（src/client/index.ts）

```ts
export const name = 'dsh-plugin-galaxy'
export const inject = ['slots', 'locale', 'theme']
export const REQUIRED_PRIMITIVES = ['Menu', 'DisclosureRow', 'Tooltip', 'Toast'] as const
export function missingPrimitives(mod: Record<string, unknown>, required?: readonly string[]): string[]
export function apply(ctx: GalaxyClientContext): void
```

- `ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-galaxy: dictionaries')`
- `const t = ctx.locale.bind(NS)`
- `ctx.slots.inject('settings.section', ...)` → 注册 `{ name:'settings.section', id:'galaxy', order: 40, label: () => t('nav'), locale: NS, inject: () => ({ t }) }`，渲染 `GalaxyErrorBoundary` 包裹的 `MarketSection`。
- `(ctx as {inject(services: string[], cb)}).inject(['settingsScope'], scoped => scoped.slots.inject('settings.plugin.item', ...))` → key 为 `NS`，渲染 `SettingsCard`。
- `ctx.slots.inject('shell.overlay', ...)` → 渲染 `InstallToast`。
- 宿主 primitives 缺 rc.6 导出时：打印警告并跳过注册（不得抛异常导致设置对话框白屏）。
- `themeStore`：`{ subscribe: cb => ctx.on('theme/change', cb), getSnapshot: () => ctx.theme.getTheme() }`。

`GalaxyClientContext` 结构（本地声明，不 import 宿主内部类型包）：

```ts
interface GalaxyClientContext {
  effect(callback: () => unknown, label?: string): void
  on(event: string, callback: () => void): () => void
  inject(services: string[], callback: (scoped: unknown) => void): void
  locale: {
    register(namespace: string, dicts: { zh: Dict; en: Dict }): unknown
    bind(namespace: string): Translate
    subscribe(callback: () => void): () => void
    getSnapshot(): { active: string }
  }
  slots: {
    inject(slot: string, register: () => unknown): void
    register(meta: Record<string, unknown>, component: (props: any) => unknown): unknown
  }
  theme: { getTheme(): ThemeSnapshot | null; setTheme(id: string): void }
}
```

## 3. `market-data.ts` 导出面（唯一 API 客户端）

类型来自服务端同名类型（客户端本地再声明一份等价结构，避免跨目录 import `../core/types.ts` 进入浏览器 bundle）。

```ts
export interface GalaxyApiError extends Error { status: number; payload: unknown }
export function isGalaxyApiError(value: unknown): value is GalaxyApiError

// —— 读取 ——
export function fetchRegistry(): Promise<{ registry: Registry; hostVersion?: string }>
export function fetchInstalled(): Promise<InstalledPayload>
export function fetchStatus(): Promise<GalaxyStatus>
export function fetchUpdates(force?: boolean): Promise<UpdateStatus[]>
export function fetchChangelog(name: string): Promise<ChangelogPayload>
export function fetchCheck(): Promise<DiagnosticReport>
export function fetchLogsText(): Promise<string>
export function fetchBackup(): Promise<ProfileBackup>

// —— 目录与兼容 ——
export function discoveryCompatibility(packages: string[]): Promise<HostCompatibility[]>

// —— 生命周期 ——
export function installPlugin(url: string): Promise<InstallResponse>
export function updatePlugin(name: string, options?: { force?: boolean; restore?: boolean }): Promise<UpdateResponse>
export function uninstallPlugin(name: string, force?: boolean): Promise<OkResponse>
export function migrateSource(name: string): Promise<OkResponse>
export function rollbackOperation(rollbackId: string): Promise<OkResponse>
export function cancelOperation(): Promise<{ ok: boolean; cancelled: boolean }>
export function approveBuilds(packages: string[]): Promise<{ ok: boolean; approved: string[] }>
export function setupPnpm(): Promise<PnpmProbe>
export function restartHost(): Promise<RestartSchedule>
export function selfUninstall(confirm: boolean, purge: boolean): Promise<OkResponse>

// —— 调优 ——
export function togglePlugin(name: string, enabled: boolean): Promise<OkResponse>
export function saveNote(name: string, text: string): Promise<OkResponse>
export function favoriteUrl(url: string, favorited: boolean): Promise<OkResponse>
export function groupAction(action: GroupAction, payload?: GroupPayload): Promise<OkResponse>
export function reorderBundles(order: string[]): Promise<BundleOrderResult>
export function listSnapshots(): Promise<ProfileSnapshot[]>
export function createSnapshot(): Promise<{ ok: boolean; snapshot: ProfileSnapshot }>
export function restoreSnapshotFile(id: string): Promise<OkResponse>
export function deleteSnapshotFile(id: string): Promise<OkResponse>
export function listPresets(): Promise<Preset[]>
export function presetAction(action: 'save'|'apply'|'delete'|'preview', payload: { name: string; bundleOrder?: string[]; disabled?: string[] }): Promise<{ ok: boolean; presets?: Preset[]; order?: string[]; disabled?: string[]; reason?: string }>
export function useSkin(name: string): Promise<OkResponse>

// —— 保护与同步 ——
export function restoreBackupFile(backup: ProfileBackup): Promise<{ ok: boolean; restored: string[]; skipped: string[] }>
export function webdavAction(action: 'upload'|'download', options: { url: string; username?: string; password?: string; backup?: ProfileBackup }): Promise<{ ok: boolean; backup?: ProfileBackup; error?: string }>
export function gistAction(action: 'create'|'update'|'read'|'verify', options: { token?: string; gistId?: string; includeDeps?: boolean; includeConfig?: boolean }): Promise<GistResult>

// —— 网络 ——
export function setChannel(channel: Channel): Promise<OkResponse>
export function setRegion(region: Region): Promise<OkResponse>
export function setGithubProxy(proxy: string): Promise<OkResponse>

// —— 工具 ——
export function absoluteApiUrl(path: string): string
export function downloadTextFile(filename: string, text: string): void
export function themeStoreFrom(theme: ThemeServiceLike): ThemeStore   // useSyncExternalStore 兼容
```

`ThemeSnapshot = { id: string; mode?: 'light'|'dark'; [key: string]: unknown } | null`

所有 POST 请求必须带 `credentials: 'same-origin'` 且设置 `content-type: application/json`；非 2xx 时抛出带 `status` 与解析后 `payload` 的 `GalaxyApiError`。

## 4. 组件契约

| 文件 | 导出 | 关键 props |
|---|---|---|
| `MarketSection.tsx` | `MarketSection` | `{ t: Translate; locale: LocaleServiceLike; theme: ThemeServiceLike; themeStore: ThemeStore; preferredSubsectionId?: string }` |
| `SettingsCard.tsx` | `SettingsCard` | `{ t: Translate; onRemoved?: () => void }` |
| `OperationsPanel.tsx` | `OperationsPanel` | `{ t: Translate; records: OperationRecord[]; onRollback: (record) => void; onCancel: () => void; onApproveBuilds: (packages: string[]) => void; onSetupPnpm: () => void }` |
| `Diagnostics.tsx` | `Diagnostics` | `{ t: Translate; report: DiagnosticReport \| null; onRefresh: () => void }` |
| `CommentsModal.tsx` | `CommentsModal` | `{ t: Translate; open: boolean; plugin: RegistryPlugin \| null; onClose: () => void }` |
| `InstallToast.tsx` | `InstallToast` | `{ t: Translate }`（自订阅 `/status`，安装完成时提示） |
| `ErrorBoundary.tsx` | `GalaxyErrorBoundary` | `{ text: {title,hint,reload,details}; actions?: ReactNode; children: ReactNode }` |
| `snapshot-panel.tsx` | `SnapshotPanel` | `{ t: Translate; open: boolean; onClose: () => void; onChanged?: () => void }` |
| `preset-panel.tsx` | `PresetPanel` | `{ t: Translate; open: boolean; onClose: () => void; onChanged?: () => void }` |

`Translate = (key: string, params?: Record<string, string \| number>) => string`

`operations.ts` 导出：`recordFromStatus(previous: OperationRecord[], status: GalaxyStatus, boot: string): OperationRecord[]`、`bucketOf(record): OperationBucket`、`groupRecords(records): { busy: OperationRecord[]; ok: OperationRecord[]; attention: OperationRecord[] }`、`recordId(kind, name): string`。

`comments.ts` 导出：`parseComments(text: string): { author?: string; body: string }[]`（catalog 条目里的评论文本 → 结构化评论）。

`self-check.ts` 导出：`exportGalaxyLog(): Promise<void>`（拉取 `/logs` 文本并用 `downloadTextFile` 下载）、`runSelfCheck(): Promise<{ ok: boolean; problems: string[] }>`（检查 fetch 可用、status 可达、registry 可达）。

## 5. 界面结构

面板**没有标签栏，也没有常驻状态条**：打开就是市场本身（副标题 + 搜索/筛选/排序 + 卡片）。
每个挂载点都带一个 `data-entry` 标记（值是**中立短名**，只描述位置，便于探针与调试器定位）：

| `data-entry` | 组件 | 位置 |
|---|---|---|
| `galaxy-section` | `MarketSection` | `settings.section`（id `galaxy`，order 40） |
| `discover` | 市场区（工具栏 + 卡片网格） | `MarketSection.tsx`（值来自 `TAB_ENTRY`） |
| `installed` | 已安装列表 / 分组编辑器 | **保留但不可达**（`tab === 'installed'` 不再被设置）；卡片形态由「已安装」筛选给出 |
| `favorites` / `themes` | 收藏 / 主题 | 组件保留，仅宿主 `preferredSubsectionId` 深链可达 |
| `operations` | `OperationsPanel` | **仅有记录时**渲染（运行中自动展开），活跃操作 + 已完成记录 |
| `comments` | `CommentsModal` | 插件卡片的「查看评论」 |
| `snapshot-panel` / `preset-panel` | 两个面板 | 组件保留，面板内当前无入口 |
| `diagnostics` | `Diagnostics` | 组件保留，面板内当前无入口 |
| `settings-card` | `SettingsCard` | `settings.plugin.item`（key `dsh-plugin-galaxy`） |
| （无标记） | `InstallToast` | `shell.overlay` |
| （无标记） | `GalaxyErrorBoundary` + 导出日志按钮 | 包裹 section 渲染 |

**入口规则**（0.1.26 定的形态）：

| 想做的 | 入口 |
|---|---|
| 浏览 / 搜索 / 安装 | 打开面板即是；「全部 / 推荐 / 已安装 / 可更新 / 不兼容」在工具栏 |
| 管理已安装（启停/更新/备注/收藏/日志/卸载） | 筛选行点「已安装」→ **与其它筛选完全一致的卡片网格**（一插件一卡），搜索/排序/刷新共用同一套控件 |
| 看进度 / 取消 / 回滚 | 有活动时操作记录区自动出现并展开；空闲时**不渲染**（这就是删掉的「共 0 条记录」条） |

> 版本/宿主版本行、快照/预设/诊断按钮、四个标签（发现/已安装/收藏/主题）都已从面板移除；
> 对应组件与路由调用**保留在代码里**，但面板不再提供入口（收藏/主题仍可由宿主深链打开）。
> 「已安装」的**列表形态**（行式 + 分组编辑器）同样保留但不再可达——它对本插件自身那一行不显示启停/卸载，
> 卡片形态则由 `PluginCard` 的同一守卫保证。

> **侧栏座位未被占用**：本插件的唯一 UI 表面是设置对话框（`settings.section` + `settings.plugin.item`），
> **不注册** `sidebar.footer.action`——侧栏底部只保留宿主与其它插件的条目。
> 若将来要做侧栏形态，宿主
> `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` 记录了该座位的完整契约
> （`kind: 'list'`、owner props `{ wide: boolean }`、`wide === false` = 56px rail、子座位用 `children` 声明）。

## 6. 样式与可访问性

- 样式集中在 `src/client/Galaxy.module.css`（CSS Modules，由 tsdown 内联）。组件只 import 该类映射。
- 不用内联 `style` 传递主题色；用宿主的 CSS 变量（`var(--dsh-*)`）并保证亮/暗主题都可读。

### 6.1 状态色只能引用宿主**真实存在**的令牌（踩过的坑）

CSS 变量**不会报错**：写了一个宿主没定义的 `--dsw-alias-*` 名字，浏览器会静默跳到下一个 fallback。我们曾用
`--dsw-alias-bg-error` / `--dsw-alias-label-error` / `--dsw-alias-border-error` / `--dsw-alias-bg-warning`
等名字——宿主**没有**这一族，于是全部回退到硬编码的浅色字面量（`#fdeaea` 之类），暗色主题下错误提示与状态徽标
一直是一块粉底，跟插件其余部分不搭（"颜色没跟随主题"）。

宿主真实可用（`packages/client/ui-theme/src/styles/design-platform.css`，0.1.5-alpha.1 与 **0.1.5-rc.2** 双向核对，令牌表两者一致）：

| 用途 | 真实令牌 |
|---|---|
| 错误 | `--dsw-alias-state-error-primary` / `-secondary` |
| 警告 | `--dsw-alias-state-warn-primary` / `-secondary` / `-tertiary` / `-label`（**是 `warn`，不是 `warning`**） |
| 成功 | `--dsw-alias-state-success-primary` / `-secondary` / `-tertiary` |
| 中性表面层 | `--dsw-alias-bg-layer-1/2/3` |
| 危险悬停底 | `--dsw-alias-interactive-bg-hover-danger` |

**不存在的族**（不要用）：`bg-error` / `label-error` / `border-error` / `bg-warning` / `label-warning` /
`border-warning` / `bg-success` / `label-success` / `state-danger` / **整个 `fill-*` 族**。

**正确配法**（宿主自家组件也这么做）：**中性表面层 + 状态色只用于描边/文字**——
`background: var(--dsw-alias-bg-layer-2); border-color/color: var(--dsw-alias-state-error-primary)`。

`tests/host-contract.test.ts` 会扫描本样式表（先剥离注释）并断言每个 `--dsw-alias-*` 都在白名单内，
新增名字前请先在宿主令牌表里核实。

### 6.2 宿主 `Button` 会被压扁，标签会**竖排**（踩过的坑）

宿主 `Button` 是 `display:inline-flex`，且**没有** `white-space:nowrap`、**没有** `min-width:0`
（`packages/client/ui-primitives/src/Button.module.css`）。作为 flex 项，它的自动最小尺寸就是 min-content ——
中文标签的 min-content 是**一个汉字**。于是一旦它所在的行空间不足，按钮会被压到约 32px 宽，标签逐字换行，
视觉上就是「文字竖排」（用户报告：「关闭」两字上下排、列表行按钮竖排）。

规律：**长文案 + 尾部按钮**的 flex 行必须让文案让位，而不是让按钮让位：

```css
.banner > .stack{flex:1 1 0;min-width:0}                /* 文案吸收/让出空间并换行 */
.row > button,.banner > button,.cardActions > button{flex:none;white-space:nowrap}  /* 按钮保持自然宽度 */
```

同理，**信息块（徽章行）+ 操作组**的行必须可换行且信息块可收缩（`.listRow{flex-wrap:wrap}` +
`.listRow > .stack{min-width:0}` + 徽章行 `flex-wrap:wrap`），否则徽章按 max-content 占满一行，把整行挤出面板。
操作组本身可以收缩（组内按钮再换行），但按钮不能：`.listActions{flex:0 1 auto}`。

这类缺陷**没有排版引擎就看不见**，因此有两道防线：
`tests/host-contract.test.ts` 静态断言上述规则存在；`npm run check:layout` 用 Chrome headless 真实测量
标签行框数与面板溢出（并保留"修复前"对照）。详见 `docs/pre-install-audit.md` §2 A7。
### 6.3 变更请求必须有尽头（A8 的客户端一半）

`send()` 是裸 `fetch`，没有超时；服务端在极端情况下也可能永不返回（子进程被杀后 `close` 事件不来）。
因此 `mutate()` 把请求与看门狗 **race**：

- 20s（`MUTATION_WATCHDOG_MS`）后忙碌行显示**已用秒数**与**取消**按钮（取消 = 先 `POST /cancel` 再停止等待）；
- 20 分钟（`MUTATION_CAP_MS`，**刻意长于**服务端 `DSHG_INSTALL_TIMEOUT_MS` 的 15 分钟）放弃等待，进红色横幅并写明可查看日志；
- 被放弃的请求由后台收下（`running.catch(() => undefined)`），避免未处理拒绝；
- 若 `serverBusy` 而本页并未在等（刷新后），同样给出提示与取消。

规则：**任何 mutation 都必须能结束**——要么有结果，要么有提示，绝不能只有一行"忙碌"。新增 mutation 时沿用 `mutate()`，
不要自己 `await` 请求。

### 6.4 忙碌期必须显示**服务端的真实进度**

`GET /status` 的 `progress` 是服务端在跑什么、跑到哪、以及**子进程自己输出了什么**的唯一来源：
`phase`（`install`/`verify`/`activate`/`done`…）、`downloaded`/`done` 计数器、`lines`（最近 8 行）、`seconds`。

面板在 `pendingTarget !== null` 时轮询（忙碌 1.5s）并显示：阶段名 + 已用时间 + 计数器 + 最近 4 行原始输出（等宽框）。
规则与 §6.3 一起构成契约：**忙碌期既要能看出在动，也要有出口**；只读操作（刷新、搜索、排序、过滤、切换标签）不得随忙碌禁用。

- 每个交互控件必须有 `aria-label` 或可见文本；对话框用宿主 `Modal` 原语。

### 6.5 本项目使用的槽位在 rc.2 的存续情况

0.1.5-rc.2 的 `slot-catalog.ts` 有一次面板 API 调整：**新增** `main`、`main.conversation`、`rightbar.session`、
`sidebar.panellist`、`sidebar.right.tab.document`，并把原来的 `conversation` 槽位**迁移为 `main` 下的 `conversation` key**。

本项目只用三个槽位，且**三个都原样保留**：`settings.section`（`kind: list`）、`settings.plugin.item`（`kind: keyed`）、
`shell.overlay`（`kind: list`）。**不要**在代码或文档里再引用已移除的 `conversation`。

### 6.6 「推荐」= 官网推荐榜（只显示前 N 条，卡片印名次）

官网的目录里带一个推荐块（`registry.ranking`：`{ version, window, top[], pins[] }`），`top` 是**站点侧算好的名次**，
按 `owner/name`（`key`）排列。客户端据此渲染「推荐」（内部筛选 id 仍是 `not-installed`）：

| 规则 | 原因 |
|---|---|
| 筛选标签在**有推荐块时叫「推荐」**，没有时退回「未安装」 | 这个入口在有榜时就是官网推荐榜；指向上游公共目录时它只是普通的未安装列表，叫「推荐」会名不副实 |
| **顺序完全按 `top`，不再排序** | 名次就是排名；再按"名称/星数"排一次会把名次打乱（实测未安装视图变成 one/three/two） |
| 先**跳过已安装**，再取前 `window`（默认 20）条 | 榜单与"谁已安装"无关；`top` 比窗口长（站点侧 60 条），所以装掉一个会自动补上下一个 |
| 每张卡片印 **`#1`、`#2`、`#3`…**（`row.rank`） | 这个视图的顺序就是名次，数字与列表顺序一一对应；名次在**搜索过滤之前**定下来，搜过的视图里仍是真实名次 |
| 卡片显示**分档徽标**（S/A/B/C + 分数）与**编辑推荐**徽标，悬停给分项与理由 | 让"为什么推荐"可解释，而不是黑箱 |
| 目录**没带 `ranking` 时退回原行为**（完整未安装列表，且不印名次） | 指向上游公共目录（无推荐块）时不能变空/报错 |
| 底部说明"综合推荐前 20 条 · 完整目录见「全部」" | 不在榜上的插件仍可在「全部」里搜到 |
| 该视图里**隐藏排序下拉**（其他筛选照常显示） | 这个视图的顺序由 `top` 决定，排序在这里不生效；留一个"点了没反应"的控件比没有更糟 |

分数与分项（`score` / `band` / `scoreParts` / `pinReason`）同样由目录提供；公式、权重与人工复核在站点侧
（`docs/plugin-ranking.md`），插件只负责"按名次渲染 + 解释来源"。

### 6.7 排序菜单里没有"推荐"

「推荐」是一个**视图**，不是一种排序：排序下拉保持名称 / Star 数 / npm 下载量 / 发布时间四项（各升降序），
**不加"推荐分"**。

| 规则 | 原因 |
|---|---|
| 排序菜单里不出现 `score` / `推荐分` 选项 | 推荐榜已经由「推荐」这个入口呈现；再来一个按分排序会与它抢同一件事，而且窗口名次（掺了类目上限与编辑 pins）与分数不成单调关系 |
| `score` 只出现在两处：卡片徽章（`推荐 S · 90`）与悬停说明（分项 + 编辑推荐理由） | 分数是"为什么推荐"的解释，不是排序维度 |
| 面板**不显示官网弹窗里的「推荐排名」**（按分数降序的全站名次） | 那是官网详情弹窗的数字；面板的 `#1…#20` 是窗口顺序。两套数字混在一起就会"分数和名次对不上" |

## 7. 约束

1. TypeScript strict + React 18 函数组件 + hooks；JSX 使用 `react/jsx-runtime`（`jsx: react-jsx`）。
2. 只 import：`react`、`@deepseek-ai/dsh-client-ui-primitives`、同目录模块。不得 import `../core/*`（服务端代码不进浏览器 bundle）。
3. 不得新增依赖。
4. 所有文案走 `t('key')`；`locales.ts` 必须同时提供 `zh` 与 `en` 两套 key，key 集合完全一致。
5. 不得在模块级执行副作用（注册、请求）；只在组件 effect / `apply()` 内执行。
6. 注释用英文；文件头注明对应的元模型 ID。
