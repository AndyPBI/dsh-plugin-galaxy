# Plugin Galaxy · `dsh-plugin-galaxy`

[![ci](https://github.com/AndyPBI/dsh-plugin-galaxy/actions/workflows/ci.yml/badge.svg)](https://github.com/AndyPBI/dsh-plugin-galaxy/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![host](https://img.shields.io/badge/DSH-0.1.5%20%7C%200.2.1-informational)](docs/host-compatibility.md)
[![telemetry](https://img.shields.io/badge/telemetry-none-success)](#权限与安全)

> **于万千插件中甄选价值，DeepSeek Harness 扩展更轻盈。**
> A visual plugin galaxy inside DeepSeek Harness — browse, search, and install community plugins without leaving the app.

装在 **DeepSeek Harness（DSH）设置对话框**里的插件市场：逛、搜、看排名、一键安装，
更新/启停/卸载/备份恢复/诊断也在同一个面板里完成。它**不占侧栏座位**，
不往会话里塞命令，也不在后台偷偷跑活儿 —— 只有你打开设置时才出现。

![全部：卡片网格 + 搜索/筛选/排序](https://raw.githubusercontent.com/AndyPBI/dsh-plugin-galaxy/main/docs/screenshots/01-market-all.png)

| | |
|---|---|
| 包名 | `dsh-plugin-galaxy` |
| 宿主 | DeepSeek Harness（cordis 插件系统），Web + Desktop |
| 已验证宿主 | `0.1.5-alpha.1` → `0.2.1-alpha.1`，**Web 与桌面版**（Windows/macOS）两代同时支持；差异在运行时兜底，见 [`docs/host-compatibility.md`](docs/host-compatibility.md) |
| 依赖 | 无运行时第三方依赖（React/宿主组件由宿主注入）；peer 只有 `cordis` 与 `schemastery` |
| 数据 | 文件系统：`<profile>/.dsh-galaxy/`，无数据库 |
| 遥测 | 无。不采集、不上报任何使用数据 |
| 许可 | MIT © 2026 AndyPBI |

---

## 1. 为什么值得装

- **排名是真的**：面板直接读官网目录的综合推荐榜（`ranking.top`），
  卡片带 `#1`、`#2`… 名次与分档徽标，点开有"为什么推荐"的评分构成。
  没有把"下载量最高"包装成"推荐"。
- **装完就能用**：安装、更新、启停、卸载、回滚都在面板里，进度/取消/回滚有独立的状态面板；
  失败会留下可读原因，而不是让 profile 处于半坏状态。
- **敢动你的 profile**：每次破坏性操作前先做 profile 快照（三文件 + 回滚令牌），
  失败自动回滚；写操作走互斥锁 + 原子写（临时文件 + rename），不靠"应该没问题"。
- **两代宿主都能跑**：宿主在 0.2.x 改了图标命名、设置卡片座位与插件设置项三处契约，
  本插件用运行时解析同时兼容 `0.1.5-rc.2` 与 `0.2.1-alpha.1`，不是"只支持最新版"。
- **失败隔离**：客户端有 error boundary（面板崩了给恢复面板 + 导出日志），
  服务端每个路由都独立捕获 —— 本插件出问题不会让你的宿主起不来。

## 2. 功能

### 2.1 发现与安装

| 能力 | 说明 |
|---|---|
| 五个筛选 | **全部 / 推荐 / 已安装 / 可更新 / 不兼容**，都是同一套卡片网格；筛选是视图，不是排序 |
| 分类筛选 | 工具栏「分类筛选」由**官网目录的分类词表**生成（顺序与标签同官网，数字按目录实时统计）：官网新增分类（如「甄选」）面板自动出现，可与状态筛选、搜索叠加 |
| 推荐视图 | 官网 `ranking.top` 前 20（跳过已安装自动补位），每张卡片印名次与分档（S/A/B/C）、评分与"为什么推荐"（编辑推荐条目带 🖊 与理由） |
| 搜索 | 名称 / npm 包名 / 分类（标签与 slug 都认）/ 描述 / 作者，同时认**官网展示名**与原始包名 |
| 排序 | 名称 / Star 数 / npm 下载量 / 发布时间，各升降序（推荐视图按名次，不排序） |
| 卡片信息 | 分类（标签随官网目录下发，中英随界面语种；官网新增/改名分类自动跟随）、★ Star、下载量、版本、来源类型（npm / github / 本地）、bundle 归属、兼容性判定、评论入口 |
| 一键安装 | 直接调用宿主 CLI 安装到当前 profile；可选 GitHub 前缀代理 |

![推荐：官网排名前 20](https://raw.githubusercontent.com/AndyPBI/dsh-plugin-galaxy/main/docs/screenshots/02-recommended.png)

### 2.2 已安装与生命周期

![已安装：启停/更新/卸载](https://raw.githubusercontent.com/AndyPBI/dsh-plugin-galaxy/main/docs/screenshots/03-installed.png)

- 版本、来源类型、bundle 归属一览；**启用 / 停用、更新、卸载**（本插件自己的卡片不提供自我卸载按钮，
  避免把自己卸掉后连界面一起消失）
- **备注与分组**：给自己的插件写备注、分组，收藏待装条目
- **更新检查**：npm 与 GitHub 两种来源，可强制刷新；本地安装（`file:` tarball）明确标注不检查更新
- **操作面板**：排队 / 运行 / 需要输入 / 完成 / 告警 / 失败，支持取消与回滚
- **更新日志**：按插件查看 release notes（来源可配置）

### 2.3 备份、迁移与自救（设置卡片）

- **快照与预设**：把 profile 三文件（`package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`）
  存成命名快照或组合预设，一键恢复；保留数量可配（默认 20）
- **WebDAV / GitHub Gist 同步**：把备份推到自己的存储；只在显式点击时外发
- **下载区域 / 发布通道**：选择目录与更新来源的区域与通道
- **一键重启**（默认关闭，见[权限与安全](#权限与安全)）、**自我卸载**
- **诊断**：bundle 解析、peer 冲突、重名包清单；**脱敏日志导出**（token/密码打码）用于反馈问题
- **收藏与主题**：收藏待装条目；互斥激活主题型插件 bundle

![插件详情：评分构成与来源](https://raw.githubusercontent.com/AndyPBI/dsh-plugin-galaxy/main/docs/screenshots/04-detail-modal.png)

## 3. 安装

> **本插件不在 npm 上**（`registry.npmjs.org/dsh-plugin-galaxy` 不存在），
> 所以 `dsh plugin add dsh-plugin-galaxy` 不会成功。请用下面两条路径之一。

### 路径 A：从源码构建（推荐，当前确定可用）

```bash
git clone https://github.com/AndyPBI/dsh-plugin-galaxy.git
cd dsh-plugin-galaxy
npm ci                 # 没有 lockfile 的旧版本可用 npm install
npm run build          # 服务端 tsc → lib/，客户端 tsdown → client/client.js
npm pack               # 产出 dsh-plugin-galaxy-<version>.tgz

# 装进你的 profile（把 web 换成你的 profile 名）
dsh plugin --profile web add ./dsh-plugin-galaxy-0.1.29.tgz
```

### 路径 B：从 Release 附件安装（仓库发布 Release 后）

```bash
dsh plugin --profile web add \
  https://github.com/AndyPBI/dsh-plugin-galaxy/releases/download/v0.1.29/dsh-plugin-galaxy-0.1.29.tgz
```

### 装完怎么用

1. **完整重启宿主**（退出并重新启动 `dsh`；只刷新页面不够 —— 插件是在宿主启动时装载的）。
2. 打开**设置对话框 → 插件星系**：打开即是市场。
3. 卸载：`dsh plugin --profile web remove dsh-plugin-galaxy`，或在面板里用自我卸载。

### 环境要求

| | |
|---|---|
| DSH | `>=0.1.5-alpha.1`（含 `0.2.1-alpha.1`）；0.2.x 要求 Node `^22.19.0 \|\| >=24.0.0`；桌面版（含 Windows）用应用自带的 pnpm，无需系统 pnpm |
| 包管理 | 宿主自带的 pnpm（安装/卸载由 `dsh plugin` 转发给 pnpm） |
| 网络 | 拉目录、查 npm 版本、看 GitHub 更新日志需要出站；离线时面板显示缓存与明确错误 |

## 4. 权限与安全

**它读写什么**

| 位置 | 用途 |
|---|---|
| `<profile>/package.json`、`pnpm-lock.yaml`、`cordis.patch.yml` | 安装/启停/卸载的写入目标；每次改动前先快照，失败回滚 |
| `<profile>/.dsh-galaxy/state.json` | 星系自有状态：禁用列表、分组、备注、收藏、通道、区域、GitHub 代理、目录地址 |
| `<profile>/.dsh-galaxy/presets.json`、`snapshots/<id>.json` | 组合预设与 profile 快照 |
| `<profile>/.dsh-galaxy/log.ndjson` | 脱敏事件日志（≤256KB，只保留最新一半），可导出用于反馈 |

**它访问哪些网络**（全部出站，且都有开关）

| 目的地 | 何时 |
|---|---|
| 插件目录（默认官网 `yhaigc.cn`，可用 `DSHG_REGISTRY_URL` / `catalogUrl` 改） | 拉取目录与推荐榜（带 ETag 复用） |
| npm registry（可用 `DSHG_NPM_MIRROR` 改） | 版本、下载量、兼容性事实 |
| GitHub API（可用 `DSHG_GITHUB_PROXY` 走你的代理） | 更新日志、仓库信息 |
| 你配置的 WebDAV / Gist | **只在你点击同步时** |

**它执行什么子进程**

- `dsh plugin --profile <p> add|remove|…`：把 pnpm 参数**原样转发**给宿主 CLI，安装逻辑不自己实现
- Desktop 形态下可选调用宿主提供的 `desktopPnpm` 服务
- 安装子进程有超时与"杀掉后等待落定"的兜底（`DSHG_INSTALL_TIMEOUT_MS` / `DSHG_KILL_SETTLE_MS`）

**它暴露什么**

- 所有 HTTP 端点挂在 `/dsh-galaxy` 前缀下（默认只监听宿主已暴露的地址）
- **所有变更路由校验同源**；破坏性路由（重启、自我卸载、备份下载）额外要求 **loopback** 且拒绝代理转发
- 公开更新 API v1（`/dsh-galaxy/api/v1/*`）供 CI/脚本使用，稳定性标注为 `beta`

**不会做的事**

- **无遥测**：不采集使用数据、不上报统计、不发任何"心跳"
- **不落盘凭据**：WebDAV/Gist 凭据由宿主设置或环境变量提供，插件不写入自己的状态文件；日志导出会脱敏
- **不默认重启宿主**：`allowRestart` 默认未配置即视为关闭；宿由 launchd（或其它 supervisor）托管时，
  只有你显式设为 `true` 才允许自重启 —— 避免和托管方抢夺进程所有权
- **无 postinstall 脚本**；发布物只含 `lib/`、`src/`、`client/`、`cordis.patch.yml`、`LICENSE`
- **失败不改宿主**：客户端 error boundary + 服务端逐路由捕获，本插件异常不影响宿主启动

## 5. 配置

| 配置 | 来源 | 默认 | 作用 |
|---|---|---|---|
| `profile` | cordis config / 宿主 | `web` | 被管理的 profile |
| `allowRestart` | cordis config / 设置项 | 未配置（=禁用） | 一键重启开关 |
| `maxSnapshots` | cordis config | `20` | 每 profile 保留快照数 |
| `DSHG_REGISTRY_URL` | 环境变量 | 内置公共目录 | 自定义 catalog |
| `DSHG_SITE_URL` | 环境变量 | 未设置（由 catalog origin 推导） | 插件官网基址；设置后每张卡片都深链到 `<基址>/#/ai/p/<owner%2Fname>` |
| `DSHG_NPM_MIRROR` | 环境变量 | 未设置 | 覆盖 npm registry 基址 |
| `DSHG_GITHUB_PROXY` | 环境变量 | 未设置 | 操作员托管的 GitHub 前缀代理（设置后 UI 锁定） |
| `DSHG_UPDATES_ORIGIN` | 环境变量 | 内置 | release notes 来源 |
| `DSHG_INSTALL_TIMEOUT_MS` | 环境变量 | 15 分钟 | 安装子进程超时 |
| `DSHG_KILL_SETTLE_MS` | 环境变量 | 10 秒 | 杀进程后等待落定的兜底时限 |
| `DSHG_DISCOVERY_TTL_MS` | 环境变量 | 6 小时 | 兼容性事实缓存 TTL |
| `DSH_HOST_VERSION` | 环境变量 | 自动探测 | 显式覆盖宿主版本（宿主自身从不设置它） |
| `catalogUrl` / `siteUrl` | `<profile>/.dsh-galaxy/state.json` | 未设置 | profile 级目录/官网地址（优先级低于同名环境变量） |
| `DSH_HOME` | 环境变量 | `~/.dsh` | profile 根目录 |
| `HTTP(S)_PROXY` / `NO_PROXY` | 环境变量 | 未设置 | 出站与 pnpm 子进程代理 |

## 6. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 设置里看不到「插件星系」 | 装完必须**完整重启宿主**；确认 profile 里已启用（面板「已安装」或 `dsh plugin --profile web list`） |
| 目录是旧的 / 有新插件看不到 | 面板右上「刷新」强制重新校验（ETag）；或检查 `catalogUrl` 指向 |
| 桌面版里看不到「一键重启」 | 设计如此：打包应用拥有进程生命周期，重启由应用负责（Web 形态下 supervisor 未显式允许时同样禁用） |
| 更新检查说"不检查更新" | 该插件是从本地 tarball（`file:`）装的，没有可比对的远端版本 |
| 兼容性显示"未知" | 尚未拿到该包的 manifest 事实（首次会异步探测，之后按 TTL 缓存） |
| 安装失败 | 面板会给出 pnpm 的原始输出；确认网络与 registry，必要时配置 `DSHG_NPM_MIRROR` / `HTTP(S)_PROXY` |
| 面板显示"界面崩溃了" | 恢复面板可导出脱敏日志；把日志附在 issue 里即可复现 |

## 7. 开发与发版门禁

```bash
npm run typecheck        # 服务端 + 客户端两套 tsconfig
npm run build            # tsc → lib/，tsdown → client/client.js
npm test                 # vitest
npm run smoke:client     # 按 __ModuleLoader__ 契约求值客户端 bundle 并渲染每个界面
npm run verify:dist      # 打包产物体检（入口/exports/patch/lib 引用/externals/files）
npm run check:desensitization   # 合规扫描（发布物与仓库面无内部标识/凭据/本机路径）
npm run check:host-surface      # 逐条核对宿主契约（slot/primitive/图标/令牌/peer/宿主补丁）
npm run check:host-settings     # 真实宿主 settings 服务下的设置接线
npm run check:layout            # 真 Chrome 布局探针（并给出"修复前"对照）
npm run screenshots             # 重新生成 README 截图（真宿主组件 + 真 client bundle）
npm run release                 # 以上全部 + npm pack
```

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）跑的就是 `npm run release` 的每一步，
本地与 CI 不会漂移。测试与门禁的判据写在各自脚本的顶部注释里（含"这条断言为什么不是空过的"）。

## 8. 文档地图

| 想了解 | 看这里 |
|---|---|
| 服务端契约：路由、对象、规则、状态文件、错误语义 | [`docs/implementation-contract.md`](docs/implementation-contract.md) |
| 客户端契约：槽位、组件结构、文案与布局约束 | [`docs/client-contract.md`](docs/client-contract.md) |
| 与官网页面的联动（目录格式、推荐块、深链） | [`docs/site-linkage.md`](docs/site-linkage.md) |
| 宿主版本兼容（两代差异与运行时兜底） | [`docs/host-compatibility.md`](docs/host-compatibility.md) |
| 宿主补丁清单与核对方式 | [`docs/host-patches.md`](docs/host-patches.md) |
| 规范与实现的映射 | [`docs/spec-implementation-mapping.md`](docs/spec-implementation-mapping.md) |
| 插件目录数据管线（发现 / 下载 / 分类 / 评分 / 同步到官网） | [`docs/catalog-pipeline.md`](docs/catalog-pipeline.md) |

English overview: [`README.en.md`](README.en.md)

## 9. 许可与作者

MIT，见 [`LICENSE`](LICENSE)（Copyright © 2026 AndyPBI）。

- 维护者：AndyPBI · <dalianyunhai@gmail.com>
- 仓库与问题反馈：<https://github.com/AndyPBI/dsh-plugin-galaxy>
- 第三方归属说明：[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)

> 插件目录与排名由社区站点 <https://www.yhaigc.cn> 提供；本插件与该站点无隶属关系，
> 目录地址可用环境变量替换为任何兼容的 catalog。
