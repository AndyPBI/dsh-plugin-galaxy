# DSH 插件开发通用规范（新插件复用手册）

> 本手册沉淀 `dsh-plugin-galaxy` 从 0.1.37 迭代到 0.1.55 的经验，面向**新的 DeepSeek Harness 插件项目**。
> 项目专属契约仍以本仓库的 [`implementation-contract.md`](./implementation-contract.md)、[`client-contract.md`](./client-contract.md)、[`host-compatibility.md`](./host-compatibility.md) 为准；本手册负责「新插件从零到发布」的通用规则与踩坑清单。
>
> **UI/UX 不另立标准**：以 `stageshow` 技能为唯一设计/复核依据。本手册第 4 节只做「如何把 stageshow 用在真实插件面板上」的桥接。

---

## 0. 怎么用这份手册

新插件的推荐顺序（不要跳步）：

1. **§1 工程骨架**：复制骨架、宿主注册、构建与打包。
2. **§2 宿主契约**：确定要用的 slot、primitive、图标、令牌与宿主版本范围。
3. **§3 服务端与数据**：先定接口、缓存、错误与重启语义。
4. **§4 UI/UX（stageshow）**：在**真实容器宽度**下先做 stageshow 稿，过 film/gate/复核；稿子是 UI 验收基线。
5. **§5 实现规范**：用宿主 primitives + CSS Modules 落地，严格按控件规格与布局清单。
6. **§6 验证门禁**：typecheck / tests / smoke / 真 Chrome 截图与几何探针。
7. **§7 踩坑清单**：提交前逐条对照。
8. **§8 复用清单与片段**：直接抄的骨架/片段与检查表。

参考实现（本仓库）：`src/client/index.ts`、`src/client/MarketSection.tsx`、`src/client/Galaxy.module.css`、`src/client/OperationsPanel.tsx`、`src/client/IntroModal.tsx`、`src/api/routes-catalog.ts`、`src/domain/site-intro.ts`、`scripts/screenshots.mjs`。

---

## 1. 最小工程骨架

### 1.1 目录

```
my-plugin/
├─ package.json
├─ tsdown.config.ts          # 客户端 __ModuleLoader__ 工厂 bundle
├─ cordis.patch.yml          # 需要宿主补丁时（可选）
├─ src/
│  ├─ index.ts               # 服务端宿主入口（apply / Config）
│  ├─ api/                   # 路由、宿主结构类型、错误语义
│  │  ├─ host.ts
│  │  ├─ router.ts
│  │  └─ routes-*.ts
│  ├─ domain/                # 纯业务：数据源、缓存、解析、状态机
│  └─ core/                  # 日志、HTTP、状态、运行时、路径
├─ src/client/
│  ├─ index.ts               # 客户端入口：slots / locale / theme / primitives 守卫
│  ├─ Section.tsx            # 设置区块或独立页面
│  ├─ Section.module.css     # 唯一样式表（CSS Modules）
│  ├─ locales.ts             # zh / en 全量文案
│  └─ data.ts                # 自己的 typed API 客户端（唯一出口）
├─ tests/                    # vitest：server + jsdom client + 契约
├─ scripts/screenshots.mjs   # 真宿主组件 + 真 bundle 的截图/几何探针
├─ docs/screenshots/         # README 用图
└─ AGENTS.md                 # 项目客观状态（版本/安装/分支/已知问题）
```

### 1.2 `package.json` 的关键面

| 字段 | 规则 |
| --- | --- |
| `type` | `module` |
| `main` / `exports["."]` | `lib/index.js` / 类型 `lib/types/index.d.ts` |
| `exports["./client"]` | `client/client.js`（宿主 loader 读它） |
| `dsh.bundle.patch` | 仅当需要宿主补丁；不要为空造文件 |
| `dsh.client.inject` | 客户端真正依赖的宿主客户端模块（如 locale、ui-settings、ui-theme） |
| `dsh.client.platform` | `web` |
| `dsh.hostVersion` / `dsh.engines.dsh` | 声明支持的宿主下限；与 `docs/host-compatibility.md` 保持一致 |
| `peerDependencies` | 宿主提供的 cordis（及可选 schemastery）；**不要**把宿主客户端模块装成普通依赖 |
| `files` | 只发 `lib`、`client`、`src`、必要的 patch/LICENSE；不要把测试、截图、设计稿打进去 |

参考：本仓库 `package.json` 的 `dsh` / `exports` / `files` 段。

### 1.3 客户端构建（tsdown）

客户端不是普通库，而是宿主 loader 的闭包工厂：

```js
// 产物形态（由 tsdown banner/footer 生成）
window.__ModuleLoader__.load({ id: 'my-plugin', factory: (require) => { /* bundle */ } })
```

硬性规则：

- `external`: `react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`——全部由宿主模块表提供。
- `platform: 'browser'`、`format: 'cjs'`、`target: 'es2022'`（宿主浏览器基线）。
- CSS Modules 用 lightningcss 编译，`pattern: '[hash]_[local]'`，样式以 `<style data-plugin="...">` 注入；**不要把绝对路径写进产物**（`//#region` 注释会泄露构建机路径）。
- 构建后跑 `verify:dist`：入口、exports、patch、externals、files 全对才算可发。

### 1.4 服务端入口

```ts
export const name = 'my-plugin'
export const inject = ['webServer', 'loader'] // 只列真正需要的宿主服务

export function apply(ctx: Context, config: MyConfig): void {
  // 路由注册必须在宿主服务就绪后；register 返回 disposer，卸载即撤路由
  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/my-plugin', handler })
  ctx.on('dispose', dispose)
}
```

- 宿主类型用**结构子集**声明在自己的 `api/host.ts`，不要依赖宿主内部类型包。
- 不要在路由注册时顺手读未 `inject` 的服务属性：在真实 Context 上会抛 `cannot get property ... without inject`，路由表会被静默截断。
- 配置：0.1.5-rc.2 走 settings 命名空间；0.2.x 投影 cordis `Config`。两代共存的写法见 `src/index.ts` 的 `Config`（手写 Standard Schema，不引入 schemastery 运行时）。

### 1.5 客户端入口

- `inject = ['slots', 'locale', 'theme']`（按需）。
- **primitives 守卫**：只检查 bundle 真正解引用的成员；缺失就跳过注册，让插件「整体缺席」，而不是让设置弹窗崩掉。参考 `src/client/index.ts` 的 `REQUIRED_PRIMITIVES` / `missingPrimitives`。
- **图标按宿主版本解析**：0.1.5-rc.2 按尺寸命名，0.2.x 按字重命名；两套名字都接受，任一存在即可。参考 `src/client/icons.ts`。
- 错误边界包住整个 Section；一个渲染错误不应拖垮宿主设置页。
- 文案全部走 `locale.register(ns, { zh, en })`，组件里只出现 `t('key')`。

### 1.6 验证与发布

- `npm run typecheck`（服务端 + 客户端两套 tsconfig）。
- `npm test`（vitest）。
- `npm run smoke:client`：按 `__ModuleLoader__` 契约求值真实 bundle。
- `npm run screenshots`：真宿主 primitives + 真 bundle 的截图与几何探针（见 §6）。
- **同版本无法替换已安装包**：每次安装前提升版本，`npm pack` 出新的 tgz，再改 profile 的依赖并安装。客户端改动刷新页面即可；**服务端改动必须重启宿主进程**；宿主补丁改动还要重打补丁并重启。

---

## 2. 宿主契约（跨代共存）

### 2.1 五条硬规则

1. **只 import 宿主承诺的模块**：客户端 primitives/locale/theme 由 loader 表提供；服务端用结构类型，不 import 宿主实现。
2. **primitives 只要求真正用到的成员**：多要求一个未使用的导出，会在精简版宿主上让整个插件消失。
3. **图标名成组兜底**：`[新名字, 旧名字]`，任一存在即可；不要只写一代。
4. **状态色只用真实别名**：`--dsw-alias-state-error-primary`、`state-warn-primary`、`state-success-primary` 等；不存在的别名会静默回退到浅色字面量，暗色主题下会「不跟主题」。
5. **宿主没有全局正文字号**：组件必须自己声明字号/行高，不要假设继承到 13px。

### 2.2 CSS Modules 与宿主样式

- 一个组件一个 section 根类（如 `.market` 或 `data-entry="..."`），所有内部规则挂在根下；**不要**在多个组件间复用 `toolbar` / `row` / `card` / `close` 这类泛名去表达不同布局。
- 需要覆盖宿主 primitive 的几何/图标时：
  - 给自己的弹窗/面板一个根类（如 `introModal`），用 `.introModal [class*='close']` 限定范围；
  - 先测计算样式（宽/高/内边距/约束），再决定 rule；
  - 宿主按钮的浏览器默认内边距（如 `1px 6px`）会挤压图标，覆盖时同时处理 `padding` 与 `flex:none`。
- 契约测试会**按字符串精确匹配**某些规则（例如“按钮不得被压扁”的选择器）。不要改那条字符串；需要新增按钮时**另写一条规则**，否则测试会找不到。
- 不要从外部重塑宿主 Button 的字体/圆角/内边距作为“通用风格”；只在有明确产品理由并且做过实测的局部覆盖。

### 2.3 重启矩阵

| 改动 | 生效方式 |
| --- | --- |
| 客户端 bundle / CSS / 文案 | 刷新页面 |
| 服务端路由 / 数据源 / 缓存 / 状态文件 | **重启宿主进程** |
| `cordis.patch.yml` / 宿主补丁 | 重打补丁 + 重启 |
| 宿主升级（rc.2 → 0.2.x） | 按 `host-compatibility.md` 逐项自查 + 重启 |

> 踩坑：服务端新增 `/intro` 路由后只刷新页面，按钮出现但接口 404；直到重启宿主才生效。

---

## 3. 服务端与数据

### 3.1 路由约定

- 路径统一前缀（本仓库 `/dsh-galaxy`）；`kind: 'exact' | 'prefix'`，disposer 随卸载撤销。
- 读接口：GET + JSON；写接口：POST + JSON body，**限制 body 大小**（如 32KB），字段校验失败 400，资源不存在 404，上游网络失败 502（不要伪装成 200+空数据）。
- 错误响应包含 `error`（可读文本）、可选的 `reason` 与 `proxyHint`；服务端日志记录一次 `warn`，不要打印凭据。
- 上游请求统一走 `fetchJson`/`marketFetch`：硬超时（默认 15s）、跟随系统代理、解析 JSON/文本；不要在路由里裸 `fetch`。

### 3.2 外部内容：CORS、缓存、兜底

外部站点（如官网目录）通常**没有 CORS 头**，浏览器不能直接取。做法：

1. 客户端只调自己的服务端；服务端去取外部资源。
2. 缓存整份数据（本仓库官网目录约 550KB，TTL 10 分钟）+ 并发去重；强制刷新走 `?force=1`。
3. 用**稳定键**匹配（官网与本插件都用 `owner/name`），不要用 display name（重名会错配）。
4. 清洗文本：去 HTML 标签、保留换行、trim；空值回退到短描述；再空则返回可读的「暂无简介」。
5. 失败要有明确状态：加载中 / 暂无内容 / 上游暂时不可用；不要留空白弹窗，也不要把整页拖死。

参考实现：`src/domain/site-intro.ts` + `src/api/routes-catalog.ts` 的 `/intro` + `src/client/IntroModal.tsx`。

### 3.3 变更、进度与结算

- 所有会写 profile 的动作：先确认，再乐观更新，成功/失败都重新读服务端；失败必须回滚乐观视图。
- 长任务必须有**可结束的忙碌态**：watchdog、上限、取消；不要出现永远转圈。
- 进度记录（operations）用状态机：
  - `queued/running` → `done` / `failed` / `cancelled`；
  - 结算时**清空运行中的 percent 与「正在安装…」明细**，否则完成后仍像在安装；
  - 宿主重启会打断运行中的记录：用 boot id 识别，标记为失败并给出可读原因（本地化）；
  - 页面只展示状态、进度条、明细、可执行动作；不要嵌套第二层折叠把记录藏起来。
- 需要重启才能生效的变更：横幅说明「需要重启」，记录里的 notes 写「刷新或重启后可见」，二者不要互相矛盾。

### 3.4 状态与身份

- 用户可见的决定（禁用、分组、收藏、备注、主题等）必须落盘在 profile 范围，不能只存组件 state。
- 数据身份用 `owner/name`；重名显示名只用于展示。
- 写入使用原子替换（临时文件 + rename）；卸载/异常时不破坏旧状态。

---

## 4. UI/UX：以 `stageshow` 技能为准

### 4.1 为什么先做 stageshow 稿

`stageshow` 编码的是「真实产品 UI 的工艺规则」：克制、层级、裁切、对齐、动效因果、复核。插件面板是在宿主设置弹窗里的一整块 UI，先把它当作 stageshow 场景设计，比直接写 React 更快暴露问题。

**必须读的 references**（按需）：

| 文件 | 用途 |
| --- | --- |
| `references/craft.md` | 静止帧：克制、字体、间距、图标、颜色、控件、设备 chrome |
| `references/framing.md` | 构图/裁切规则与布局表（含小尺寸与页面） |
| `references/motion.md` | 故事、循环、节奏、光标与拖拽、文本/数值变化 |
| `references/kit.md` | Stage/Window/Row 等部件；何时用、如何不重塑 |
| `references/looks.md` | 把产品 token 映射到 kit；主题/调色板/保真度 |
| `references/products.md` | 真实产品的交互借鉴（借交互，不借身份） |
| `references/rehearse.md` / `review.md` / `teaching.md` | 彩排、全新视角复核、正反例 |

### 4.2 插件 UI 的 stageshow 工作流

1. **介质与位置**：先量真实容器宽度。宿主设置弹窗的内容列约 564px；文档截图 harness 另跑 1044 / 420 / 380 三档。按真实宽度建场景，不要按「海报 860」直接缩放。
2. **外观**：用 `looks.md` 把宿主 tokens 映射进 kit（`--dsh-*` → `--dsw-alias-*` → 字面量）；亮/暗两套都要看。插件面板通常是 `standard` 保真度：关键文字真实，其余用占位条。
3. **屏幕**：3–7 个真实字符串预算；一个焦点对象；真实 chrome；不要把每个控件都填满字。
4. **故事/动效**：3–5 拍 + 收尾；每个移动都有原因；文本/数值要移动而不是原地换字；等待要有终点；循环要能回到起点。
5. **彩排**：用 `scripts/film.mjs` 在宽/窄两档出 contact sheet + `--gate`；读每一帧；修最大可见问题；最后 `rehearse.md` + `review.md` 全新视角复核，写 `REHEARSAL.md`。
6. **验收双基线**：
   - **stageshow 稿** = 设计基线（截图/poster）；
   - **插件自己的截图 harness**（真 client bundle + 真宿主 primitives，见 §6）= 实现基线。两者并排看，差异必须能解释。

> 不要把 stageshow 的 faux kit 组件直接搬进生产插件；生产用宿主 primitives + 自己的 CSS Modules。stageshow 只提供设计与复核方法。

### 4.3 stageshow 的五个失败，在插件里的具体表现

| stageshow 失败 | 插件里的样子 | 修法 |
| --- | --- | --- |
| Too much | 每张卡堆版本、作者、描述、多个按钮 | 只保留故事需要的字段；版本/作者放详情；动作收敛到一行 |
| Wireframe | 两个灰块 + 按钮，认不出产品 | 用真实数据、真实控件与图标；保留分类/状态等识别信息 |
| Boxed | 面板外再套一层卡片、四周等距留白 | 让宿主弹窗本身就是 ground；Section 不画外框/阴影 |
| Flat | 所有对象同权重、同边框 | 建立层级：标题/状态/分数/次要信息各有重量；动作组右对齐 |
| Bland | 灰色窗口 + 光标，没有产品气质 | 用宿主 token 与真实内容；亮/暗、窄/宽都成立 |

### 4.4 控件规格（经过实测的统一值）

| 控件 | 高度 | 圆角 | 描边 | 字号/字重 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 搜索框 / 刷新 / 状态滑轨 / 排序 | 34px | 8px | 1px | 13px | 同一行控件必须同高、同圆角、同底色 |
| 滑轨内标签 | 28px | 6px | 无 | 13px（窄 12px） | 标签垂直居中；六段等分；激活块 28px/6px |
| 卡片动作按钮 | 28px | 宿主值 | 宿主 outline | 12px | 同组 `min-width` 统一（窄 48，宽 56）；`border` 会让主按钮少 2px，需 `min-width` 拉平 |
| 任务记录类型标签 / 记录动作按钮 | 28px | 8px | 1px | 12px | 与动作按钮同一矩形；危险动词只换文字色 |
| 行间距/控件间距 | — | — | — | — | 行内 gap 8；控件内边距 12；卡片 padding 12 |

### 4.5 布局配方（本仓库验证过的）

- **工具条两行**：搜索 + 刷新（8px 间距）；滑轨占满剩余宽度 + 排序（8px 间距）。滑轨与排序放不下时整组右对齐换行，不要横向滚动。
- **卡片两列**：`grid-template-columns: repeat(2, minmax(0, 1fr))`；容器 ≤520px 时一列。不要用 `minmax(320px)` 在窄弹窗里「自动塌成一列」。
- **卡片四行**：标题行（名称 + 状态词 + 右侧分档）→ 分类行 → 指标行（★/下载量/兼容性）→ 动作行（官网/简介 + 右侧按钮）。名称过长用 ellipsis + `title`，动作 `flex:none` 永远同一行。
- **窄卡片适配**：隐藏分档前缀词（只留 `S·92`）；动作按钮缩到 48；链接与动作仍一行，必要时整组右对齐换行。
- **记录面板**：一层展开即可；分组标题 + 记录行；行内 12px；类型标签与动作按钮 28px/8px；进度条 + 百分比；结算后不再保留运行进度。
- **弹窗**：宿主 Modal；正文 13/22；来源说明用 `hint`；关闭图标 18×18（28 按钮），不要默认 14；底部左侧官网链接、右侧关闭。

### 4.6 动效

- 每次移动有原因：点击 → 状态变化 → 结算；没有原因的位移/闪烁一律去掉。
- 文本/数值原地变化用 `Roll`/`Swap`/`Count` 类做法，别整块替换。
- 过渡期间给出可预期的时长（约 200–300ms）；切换筛选时不要让邻近按钮瞬移。
- 等待必须有尽头：进度、取消、超时、错误；加载骨架用内容的几何，不用转圈占位。
- 尊重 `prefers-reduced-motion`：直接给稳定态（poster）。

### 4.7 可访问性、主题、i18n

- 交互控件必须有可访问名；状态用 `aria-pressed` / `aria-expanded`；计数不要进入可访问名。
- 焦点可见；Modal 由宿主负责返回焦点；28×28 是最小可接受命中区（触屏目标更大）。
- 亮/暗两套都要用宿主 token 验证；不要写死在暗色下不成立的浅色字面量。
- 所有文案（含错误、空状态、来源说明、按钮）都在 locale 里；英文回退链要有；官网内容优先 `descEn`，没有则回退中文全文。

### 4.8 固定品牌配色（10.Logo）

来源：`10.Logo/logo-design-spec.md`。三色渐变**顺序固定 蓝 → 橙 → 红**，语义固定：

| 语义 | 渐变（上→下） | 小字号 ink（亮 / 暗） |
| --- | --- | --- |
| 正常 / 首选 / 已安装 | `#36D1DC → #1a6dd4` | `#1a6dd4` / `#36D1DC` |
| 警告 / 可更新 / 停用 | `#FDBB2D → #e67e22` | `#b9630f` / `#FDBB2D` |
| 风险 / 弃用 / 卸载 | `#FF5F6D → #c0392b` | `#c0392b` / `#FF5F6D` |

结构中性色（只画结构，不表达品牌）：线 `#EDF1F4`、分隔 `#F0F3F6`、未选中填充 `#E6EBF0`、未选中描边 `#D5DAE0`。

落地规则（见 `Galaxy.module.css`）：

- 变量名 `--gal-*`，声明在 **`:root`**：宿主 Modal 会 portal 到 `.root` 之外，声明在 `.root` 会让弹窗里的链接/徽标取不到变量（`var()` 失效 → 继承色）。插件前缀保证不污染宿主。
- 暗色用 **`body[data-ds-dark-theme]`** 覆盖，不要用 `prefers-color-scheme`：宿主的主题是 body 属性（见 `design-platform.css`），应用内选「浅色」而系统是暗色时，媒体查询会错误地切到暗色 ink。
- **文字只用 ink，渐变只给无文字的填充**：白字在 `#36D1DC` 上只有 ~1.9:1；滑轨激活块因此用 `#1a78cd → #155cb8`（白字仍 ≥4.5:1）。进度条、头像可以用完整渐变。
- 宿主语义 token 仍负责「大面」：卡片/输入框底色、边框、banner（`tests/host-contract.test.ts` 钉死 banner 必须用宿主中性层 + 红灯主色），品牌层只接管卡片、控件、行内状态词。
- 状态词一套词汇：已安装=蓝（正常）、可更新/停用=橙（警告）、弃用/卸载=红（风险）。不要再给「已安装」用绿色。

---

## 5. 组件与样式实现清单

### 5.1 命名与作用域

- CSS Module 的泛名只在一个组件里使用；跨组件复用只复用「语义相同的部件」。
- 给每个 Section/Modal 一个根类或 `data-entry`，所有覆盖挂在根下；禁止全局 `button {}`、`svg {}`。
- 需要针对宿主 hashed class 时用 `[class*='close']` 这类弱匹配**限定在自己的根类下**，并测试计算样式，不靠猜。

### 5.2 Flex 常见坑（本仓库全部踩过）

| 现象 | 原因 | 规则 |
| --- | --- | --- |
| 文字偏上/偏下 | `align-items: baseline` + 小字号子元素 | 单行标签用 `align-items:center` |
| 两个控件间距多出 8px | 零宽 spacer + flex `gap` 叠加成两个 gap | 有 `flex:1` 的元素直接相邻，不要 spacer |
| 长名称把动作挤到下一行 | 头部 `flex-wrap:wrap` 先按假设宽度换行 | 头部 `nowrap`；名称 `flex:1 1 auto; min-width:0; ellipsis`；状态/动作 `flex:none` |
| 六个分类宽度不均 | 内容定宽 + 右侧留白 | 滑轨 `flex:1`，每段 `flex:1 1 0`，文字居中 |
| 主按钮比次按钮大 | outline 多 1px border | `min-width` + 固定高度；或用同一 variant |
| 图标被压扁 | 按钮默认 `padding` + flex shrink | `padding:0`（图标按钮） + `flex:none` + 明确宽高 |
| 卡片高度参差 | 网格 `align-items:start` | `.cardGrid` 拉伸 + 动作 `margin-top:auto` |

### 5.3 状态设计

每个异步区必须回答四个问题：

1. 正在加载什么？（骨架/进度，而不是空）
2. 没有数据是什么样？（可读的空状态 + 下一步）
3. 失败是什么样？（错误文本 + 重试/官网链接）
4. 操作完成后，旧进度/旧按钮/旧提示是否清理干净？

按钮：危险动作要确认；忙碌时禁用并给出原因；失败后可重试；不要用 `disabled` 掩盖失败。

### 5.4 性能与载荷

- 不在每次 registry 轮询里携带大段外部文本；按需接口 + 服务端缓存。
- 客户端 bundle 只 external 宿主提供的模块，其余 inline；避免把 550KB 的目录打进客户端。
- 列表分页/可见行限制；大目录不要一次渲染全部 DOM。

---

## 6. 验证与门禁

### 6.1 命令

```bash
npm run typecheck      # 两套 tsconfig
npm test               # vitest：server / jsdom client / 契约
npm run build          # tsc（lib）+ tsdown（client）
npm run smoke:client   # 真实 __ModuleLoader__ 契约渲染所有界面
npm run verify:dist    # 入口/exports/patch/externals/files
npm run screenshots    # 真宿主 primitives + 真 bundle 截图与几何探针
npm run release        # 全套 + 合规 + 打包
```

### 6.2 jsdom 与真 Chrome

- jsdom **没有布局**：不要用它断言几何；它负责行为、文案、类名、可访问性、数据流。
- 几何（高度/圆角/间距/换行/零尺寸）必须在真 Chrome 里测：本仓库 `scripts/screenshots.mjs` 同时截图和断言。
- 截图 harness 的硬规则：
  - 按 **`aria-label`** 找筛选按钮，不要按 `textContent === label`（计数/装饰文本会破坏匹配）；
  - 点击后等过渡落定（例如滑轨 300ms）再截图；
  - 零尺寸 `getBoundingClientRect` 不能算通过（隐藏控件曾「空过」检查）；
  - 推荐视图没有排序控件，守卫要按视图分支；
  - fixtures 用真宿主路由响应；外部文案用真站点目录/缓存；
  - 每张图至少检查：控制同高同圆角、两组间距一致、按钮同尺寸、无横向溢出。
- 亮/暗、宽/窄、空/加载/错误、Hover/Focus/Pressed、重启前后：都要看。

### 6.3 stageshow 彩排（UI 变更必做）

```bash
# 在 stageshow 技能目录（或复用其 scripts）
node scripts/film.mjs "<preview>/?capture=<scene>" --out shots/sheet.png --every 500 --count 24 --gate
```

- 先 `poster`（最常被看到的一帧），再整段循环；宽/窄两档。
- 读 contact sheet 的每一行；修最大可见问题（构图 → 层级 → 动效 → 细节）。
- 全新视角复核（`references/review.md`）；写 `REHEARSAL.md`（复制自 `references/verify.md` 模板）。
- 插件自己的 screenshot harness 必须与 stageshow 稿并排比对，差异要能解释。

### 6.4 提交前检查表

- [ ] 版本已提升，新的 tgz 已生成并安装到 profile
- [ ] 客户端改动刷新即可；服务端/补丁改动已重启宿主
- [ ] typecheck / tests / smoke / release 全绿
- [ ] 亮/暗、宽/窄截图通过；控制规格断言通过
- [ ] 所有异步态有加载/空/错误/完成清理
- [ ] 文案 zh/en 完整，没有硬编码；危险动作有确认
- [ ] AGENTS.md 的状态/版本/已知问题已更新

---

## 7. 踩坑清单（症状 → 原因 → 规则）

| 症状 | 根因 | 规则 |
| --- | --- | --- |
| 操作记录是一个高大的空框，里面只有标题/转圈/数字 | 内层折叠按钮误用了市场的 `.toolbar` 列布局类；真正的记录被第二层折叠藏住 | 每个组件用专属类；记录面板一层展开；去掉二次 toggle |
| 安装完成后记录仍显示 42% / 「正在安装…」 | 结算只改了 state，没清 percent/detail | 结算/失败/中断时清空运行进度；用状态机测 |
| 记录一直转圈 | 宿主重启打断运行中的记录，或状态轮询没有结算 | boot id 变更即标记失败并本地化原因；忙碌态必须有尽头 |
| 简介弹窗的 X 很小，放大后被挤扁 | 宿主 Modal 默认 14px；按钮浏览器默认 `1px 6px` padding 在 28px 内挤压图标 | 局部覆盖：`padding:0`，图标 18×18，`flex:none`；先测计算样式 |
| 「安装」比「停用/更新」显大 | 实心 primary vs 描边按钮的视觉重量；实际尺寸可能相同 | 先量矩形（96×56 vs 96×56），需要统一时用同一 variant/同填充 |
| 安装 44px、停用 46px | outline 多 1px border | `min-width` + 固定高度；同组统一 |
| 标签在滑轨里偏上 6px | `align-items:baseline` | 单行标签 `center` |
| 滑轨是胶囊、排序是 8px 矩形，高度差 2px | 两套控件规格 | 统一 34px/8px/1px/elevated |
| 搜索与刷新间距 16px，滑轨与排序 8px | 零宽 spacer 产生第二个 flex gap | 有 `flex:1` 时删 spacer；实测两组 gap 相等 |
| 分类下拉/计数让工具栏折成三行 | 固定宽度 + 计数 + 分类下拉挤占 | 滑轨 `flex:1`、六段均分；按需移除下拉/计数；窄宽换行整组右对齐 |
| 卡片在真实弹窗里塌成一列 | `minmax(320px)` 在 564px 内容宽下只能一列 | 固定 `repeat(2, minmax(0,1fr))`；容器 ≤520 才一列 |
| 分类药丸换成两行边框盒 | 带边框 tag + 完整括号标签 | 分类改为纯文本短标签，完整值放 `title` |
| 长 URL/长名把动作挤到下一行 | 头部可换行 + 名称不收缩 | `nowrap` + 名称 ellipsis + 动作 `flex:none` |
| 截图截错视图（已安装截图显示全部） | 按钮文本含计数，`textContent === label` 匹配失败 | 用 `aria-label` 匹配；点击后等动画结束 |
| 窄宽度检查「空过」 | 隐藏控件的 rect 全 0，比较 0 仍通过 | 检查 `width > 0`；零尺寸判失败 |
| 服务端新增接口刷新后 404 | 服务端路由只在宿主启动时加载 | 服务端改动必须重启宿主；客户端改动才刷新 |
| 同版本安装没替换 | 包管理器按版本识别已安装 | 每次安装提升版本并重新 pack/install |
| 外部站点内容请求被 CORS 拦 | 官网静态文件无 CORS 头 | 服务端代取 + 缓存；客户端只调自己路由 |
| 状态色不跟暗色主题 | 引用了不存在的别名，静默回退浅色字面量 | 只用宿主真实语义别名；亮/暗都验 |
| 单元测试没有布局也「通过」 | jsdom 不计算几何 | 几何交给真 Chrome harness；jsdom 测行为/文案 |
| 改了契约测试 pin 的选择器，测试挂了 | 测试按字符串精确匹配 | 不改原规则；新增规则另写一条 |
| 主分支合并后推送失败/不确定 | 远端分支保护/权限/分叉 | `git fetch` + `git push --dry-run` + 查 branch protection；不盲目 force |

---

## 8. 新项目复用清单

> 配套的**可运行 starter 仓库**：`dsh-plugin-template`。它是一个独立仓库（本机位于 `Documents/AI/dsh-plugin-template`），已经包含本文的最小 server / client / tsdown / tests / 真宿主截图 harness；新项目直接复制或 clone 它，按 README 的改名清单开始。

### 8.1 从零到首个可安装版本

1. 从 starter 仓库 `dsh-plugin-template` 开始（或按 §1.1 自建），复制 `package.json` / `tsdown.config.ts` 的宿主契约部分并改名。
2. 写服务端入口 + 一个健康路由；`npm run build && npm run smoke:client` 通过。
3. 定客户端 slot 与最小 Section；primitives 守卫 + 错误边界。
4. **UI 前**：用 stageshow 在真实容器宽度做稿（§4.2），过 film/gate + 复核，产出 poster 作为验收基线。
5. 按 §5 用宿主 primitives + CSS Modules 实现；按 §4.4 的控件规格落地。
6. 写 jsdom 行为测试 + 真 Chrome 截图/几何探针（§6）。
7. 跑 release；升版本、pack、装进 profile；客户端刷新 / 服务端重启。
8. 更新 AGENTS.md：版本、安装路径、已知问题、未验证项。

### 8.2 可直接套用的片段（来自本仓库）

- 可运行 starter：`dsh-plugin-template`（server + client + tsdown + tests + 截图 harness；本文 §1/§5/§6 的骨架实现）
- 客户端注册与守卫：`src/client/index.ts`
  - `REQUIRED_PRIMITIVES`、`missingPrimitives`、`ICON_ALTERNATIVES`、`inject` 列表。
- 唯一 API 客户端：`src/client/market-data.ts`
  - 同源 `/dsh-galaxy` 请求、`request`/`fetchIntro`、错误 envelope、类型再声明（服务端类型不进 bundle）。
- 服务端路由：`src/api/routes-catalog.ts`
  - `BASE_PATH`、`sendJson`、400/404/502、body 限制、上游 fetch 与缓存。
- 外部内容缓存：`src/domain/site-intro.ts`
  - `fetchJson`、TTL、并发去重、key/name 回退、文本清洗。
- 任务记录状态机：`src/client/operations.ts` + `src/client/OperationsPanel.tsx`
  - 三桶分组、进度、结算清空、boot 中断、专属样式类。
- 控件规格与布局：`src/client/Galaxy.module.css`
  - 34px/8px 工具条、28px/6px 滑轨段、16px/20px 图标、卡片两列与窄卡适配。
- 截图与几何探针：`scripts/screenshots.mjs`
  - fixtures 捕获、`aria-label` 视图切换、gap/height/radius 断言、零尺寸守卫。
- 契约与行为测试：`tests/*.test.ts`
  - `host-contract.test.ts`（宿主表面）、`client-market.test.ts`（jsdom 交互）、`site-intro.test.ts`（纯数据映射）。

### 8.3 UI 验收双基线（复制到新项目 README/AGENTS）

- **设计基线**：stageshow poster/contact sheet（宽 + 窄），`--gate` 通过，复核记录在 `REHEARSAL.md`。
- **实现基线**：`npm run screenshots` 的宽/窄/暗截图 + 几何断言；与设计基线并排比对，差异必须解释。
- **状态基线**：空 / 加载 / 错误 / 完成清理 / 禁用原因 / 重启提示，全部有画面。

---

## 9. 参考索引

### 本仓库（实现参考）

- 服务端契约：[`implementation-contract.md`](./implementation-contract.md)
- 客户端契约：[`client-contract.md`](./client-contract.md)
- 宿主版本兼容：[`host-compatibility.md`](./host-compatibility.md)
- 开发命令与门禁：[`development.md`](./development.md)
- 官网页联动：[`site-linkage.md`](./site-linkage.md)
- 目录数据管线：[`catalog-pipeline.md`](./catalog-pipeline.md)

### stageshow 技能

- 入门与工作流：技能根目录的 `SKILL.md`
- 静止帧工艺：`references/craft.md`
- 构图与布局：`references/framing.md`
- 动效与故事：`references/motion.md`
- 部件与不重塑：`references/kit.md`
- token 映射：`references/looks.md`
- 彩排：`references/rehearse.md`
- 复核：`references/review.md`、`references/teaching.md`

> 原则：**设计靠 stageshow，落地靠宿主 primitives，验收靠真 Chrome 截图与几何断言。** 三者缺一，都会把「看起来没问题」带进发布。
