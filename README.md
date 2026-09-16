# Plugin Galaxy · dsh-plugin-galaxy

> DSH 可视化插件星系：逛一逛，点一下，装好。
> A visual plugin galaxy inside DeepSeek Harness — browse, search, and one-click install community plugins.

本仓库是一个 **DeepSeek Harness（DSH）插件项目**：一个装进宿主设置对话框的可视化插件星系
（浏览、搜索、一键安装、更新、启停、备份恢复、诊断）。它由两份**自持契约**驱动 ——
`docs/implementation-contract.md`（服务端）与 `docs/client-contract.md`（客户端）—— 三者随代码一起演进。

| 项 | 值 |
|---|---|
| 包名 | `dsh-plugin-galaxy` |
| 开发者 | AndyPBI（`dalianyunhai@gmail.com`）· <https://github.com/AndyPBI> |
| 仓库 | <https://github.com/AndyPBI/dsh-plugin-galaxy> |
| 端点前缀 | `/dsh-galaxy` |
| 宿主 | DeepSeek Harness（cordis 插件系统），Web + Desktop 两种运行模式 |
| 已验证宿主版本 | `0.1.5-alpha.1` → `0.1.5-rc.2`（源码级契约 diff：仅 `slot-catalog.ts` 与 `ui-primitives` 有改动，均不影响本项目；宿主版本由插件自动探测并显示在面板与诊断页） |
| 「推荐」视图 | 显示官网目录给出的**综合推荐前 20 条**（按 `ranking.top` 名次、跳过已安装并自动补位），每张卡片印 `#1`、`#2`、`#3`… 名次，另带分档徽标与"为什么推荐"；完整目录见「全部」。目录不带推荐块时这个入口退回「未安装」标签与完整列表。见 `docs/client-contract.md` §6.6 |
| 排序菜单 | 只有 名称 / Star 数 / npm 下载量 / 发布时间（各升降序）——「推荐」是视图不是排序，菜单里没有"推荐分"；「推荐」视图隐藏排序下拉（顺序由 `ranking.top` 决定）。见 `docs/client-contract.md` §6.7、`docs/site-linkage.md` §四之二 |
| 宿主补丁 | 升级宿主会丢掉**本机补丁**（如侧栏条目垂直排列）；清单与核对方式见 `docs/host-patches.md`，`npm run check:host-surface` 会逐条自动检查 |
| 面板形态 | 打开即是市场：副标题 + 搜索/筛选/排序 + 卡片。**没有标签栏，也没有常驻状态条**；五个筛选状态（全部/推荐/已安装/可更新/不兼容）**都是同一套卡片网格**，进度/取消/回滚在有活动时自动出现。见 `docs/client-contract.md` §5 |
| 客户端 | React 18 + tsdown 打包的 `client/client.js`，注入宿主设置对话框 |
| 数据存储 | 文件系统（`<profile>/.dsh-galaxy/`），无 SQL、无 ORM |
| 设计契约 | 服务端 `docs/implementation-contract.md`：路由表、对象、规则、状态文件；客户端 `docs/client-contract.md`：槽位、组件、文案与布局契约 |

## 1. 它做什么

Plugin Galaxy 把"找插件、装插件、管插件"收进**宿主设置对话框**里的一个星系面板。
插件不占用侧栏座位（`sidebar.footer.action`）——侧栏底部只保留宿主与其它插件的条目。

- **Discover**：拉取 curated catalog，搜索、按分类/安装态/兼容性筛选，一键安装。
- **Installed**：查看已装插件的版本、来源类型（npm/git/local）、bundle 归属；启停、更新、卸载、
  备注、分组、收藏、查看更新记录。
- **Favorites**：收藏尚未安装的 catalog 条目，作为待装书签。
- **Themes**：互斥激活主题型插件 bundle。
- **Operations**：变更操作的生命周期面板（排队/运行/需输入/完成/告警/失败），支持取消与回滚。
- **Diagnostics**：profile 包清单诊断（bundle 解析、peer 冲突、重名），以及脱敏日志导出。
- **Settings card**：备份/恢复、WebDAV、Gist 同步、下载区域、GitHub 代理、发布通道、一键重启、自我卸载。

## 2. 架构

```text
DSH 宿主（cordis）
   │ ctx.inject(['webServer','loader'])
   ▼
src/index.ts            apply(ctx, config)  ── Web 宿主分支 / Desktop 宿主分支
   │
src/api/index.ts        mountGalaxyRoutes() ── 注册 42 个端点 + 持久化日志 + 区域探测
   ├── src/api/router.ts        路由注册、同源/loopback 守卫、统一错误翻译
   ├── src/api/routes-*.ts      8 个路由组（catalog/tuning/diagnostics/protection/network/lifecycle/v1/host）
   ▼
src/domain/*.ts         领域模块（registry、updates、install、snapshot、presets、order、patch、
                        themes、groups、hot、backup、gist、regions、channels、restart、
                        self-uninstall、source-migration、pnpm-compat、diagnostics、check …）
   ▼
src/core/*.ts           共享基础层（types/http/log/net/json/locks/paths/profile/state/runtime）
   ▼
文件系统 · 子进程（dsh CLI / pnpm） · 出站 HTTP（catalog / npm / GitHub / WebDAV / Gist）
```

信任边界（与规范一致）：

1. **宿主信任边界**：插件运行在宿主进程内，直接拥有文件系统与子进程能力；市场 UI 只应暴露给 loopback。
2. **请求信任边界**：所有变更路由校验同源（`sameOrigin`）；破坏性路由（重启、自我卸载、备份下载）
   额外要求 loopback 且拒绝代理转发。
3. **数据边界**：profile 数据（可能包含凭据）只在用户显式操作时经备份/WebDAV/Gist 外发。

写一致性没有数据库事务，由三件事承担：**变更互斥锁**（install / write 两类队列）、**原子写**
（临时文件 + rename）、**失败回滚**（操作前捕获 manifest/lockfile 与回滚令牌）。

## 3. 安装与使用

```bash
# 在当前 profile 中安装（宿主会应用 cordis.patch.yml 并加载插件）
dsh plugin add dsh-plugin-galaxy

# 或本地开发
npm install
npm run build      # tsc 产出 lib/，tsdown 产出 client/client.js
```

安装后打开宿主设置对话框，左侧即出现 **Plugin Galaxy** 入口；插件自身的配置页出现在
设置 → 插件 → `dsh-plugin-galaxy` 卡片。

### 开发命令

```bash
npm run typecheck   # 服务端 + 客户端两套 tsconfig 全量类型检查
npm run build       # 服务端编译 + 客户端 bundle（含声明文件说明符修正）
npm test            # vitest（核心层与路由层）
npm run validate:registry   # 校验 catalog 载荷（CI 门禁）
```

### 安装前自检（推荐在 `dsh plugin add` 之前执行）

```bash
npm run preinstall-check   # 类型检查 + 构建 + 产物体检 + 客户端契约 + 测试
npm run verify:dist        # 打包产物体检：入口/exports/dsh.bundle.patch/lib 引用/客户端 externals/files
npm run smoke:client       # 按 __ModuleLoader__ 契约求值客户端 bundle 并渲染每个界面
npm run smoke:install      # 真实 cordis + 真实 host webserver 下的安装仿真（需 DSH checkout，可 --checkout 指定）
```

审计结论、宿主契约核对与已知项见 [`docs/pre-install-audit.md`](docs/pre-install-audit.md)。

## 4. 数据对象（物理文件）

| 路径 | 内容 |
|---|---|
| `<profile>/package.json` | profile 依赖清单、`dsh.profile.bundles` 顺序、pnpm allowBuilds |
| `<profile>/pnpm-lock.yaml` | 锁定的依赖解析（市场只做整体快照/恢复） |
| `<profile>/cordis.patch.yml` | 用户补丁层；市场写 disable/force 行 |
| `<profile>/.dsh-galaxy/state.json` | 星系自有状态（disabled/groups/notes/channel/region/favorites/githubProxy） |
| `<profile>/.dsh-galaxy/presets.json` | 命名组合预设 |
| `<profile>/.dsh-galaxy/snapshots/<id>.json` | profile 三文件快照（v2，显式记录缺失） |
| `<profile>/.dsh-galaxy/log.ndjson` | 脱敏事件日志（≤256KB，最新半量保留） |
| `<profile>/.dsh-galaxy/hot-<n>.yml` | 热装载输入文件 |
| `<profile>/.dsh-galaxy/discovery-cache.json` | npm manifest 兼容性事实缓存 |

## 5. 配置

| 配置 | 来源 | 默认 | 作用 |
|---|---|---|---|
| `profile` | cordis config / `--profile` / Desktop 宿主 | `web` | 被管理的 profile |
| `profileDirectory` | Desktop 宿主注入 | 由 `DSH_HOME` 推导 | 显式 profile 目录 |
| `allowRestart` | cordis config / settings | 未配置 | 一键重启开关；supervisor 下未显式开启即禁用 |
| `maxSnapshots` | cordis config | `20` | 每 profile 保留快照数 |
| `DSHG_REGISTRY_URL` | 环境变量 | `https://awesome-dsh-plugin.com/plugins.json` | 自定义 catalog |
| `DSHG_SITE_URL` | 环境变量 | 未设置（或由 catalog 的 origin 推导） | 你的插件官网基址；设置后星系里每个插件都链到 `<基址>/#/ai/p/<owner%2Fname>`（见 `docs/site-linkage.md`） |
| `DSHG_NPM_MIRROR` | 环境变量 | 未设置 | 覆盖 npm registry 基址 |
| `DSHG_GITHUB_PROXY` | 环境变量 | 未设置 | 操作员托管的 GitHub 前缀代理（设置后 UI 锁定） |
| `DSHG_UPDATES_ORIGIN` | 环境变量 | `https://awesome-dsh-plugin.com/updates.json` | release notes 来源 |
| `DSHG_INSTALL_TIMEOUT_MS` | 环境变量 | 15 分钟 | 安装子进程超时 |
| `DSHG_KILL_SETTLE_MS` | 环境变量 | 10 秒 | 杀掉安装子进程后，等待其落定的兜底时限（超时即带着已有输出返回，避免请求与 mutation 锁被永久占住） |
| `DSHG_DISCOVERY_TTL_MS` | 环境变量 | 6 小时 | 兼容性事实缓存 TTL |
| `DSH_HOST_VERSION` | 环境变量 | 自动探测 | 显式覆盖宿主版本（**宿主自己从不设置它**；未设置时按 profile 自身 `node_modules` → 共享依赖锚点 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-base` 顺序读取） |
| `catalogUrl` | `<profile>/.dsh-galaxy/state.json` | 未设置 | **profile 级**目录数据源（优先级低于 `DSHG_REGISTRY_URL`，高于内置公共目录） |
| `siteUrl` | `<profile>/.dsh-galaxy/state.json` | 未设置 | **profile 级**官网基址（优先级低于 `DSHG_SITE_URL`） |
| `DSH_HOME` | 环境变量 | `~/.dsh` | profile 根目录 |
| `HTTP(S)_PROXY` / `NO_PROXY` | 环境变量 | 未设置 | 市场出站与 pnpm 子进程代理 |

## 6. 公共更新 API v1

外部客户端（CI、桌面壳、脚本）使用版本化契约：

```
GET  /dsh-galaxy/api/v1/capabilities
GET  /dsh-galaxy/api/v1/updates?name=&force=
POST /dsh-galaxy/api/v1/updates           { packageName, force }
GET  /dsh-galaxy/api/v1/operations?operationId=
POST /dsh-galaxy/api/v1/rollback          { operationId }
POST /dsh-galaxy/api/v1/restart
POST /dsh-galaxy/api/v1/cancelling        { operationId }
```

稳定性为 `beta`：形状可能变化，`capabilities` 会声明当前特性集与限制。

## 7. 文档地图

| 想了解 | 看这里 |
|---|---|
| 它有哪些能力、怎么用 | 本文件 §1–§3 |
| 服务端契约：路由、对象、规则、状态文件、错误语义 | `docs/implementation-contract.md` |
| 客户端契约：宿主槽位、组件结构、文案与布局约束 | `docs/client-contract.md` |
| 与官网页面的联动（目录格式、推荐块、深链） | `docs/site-linkage.md` |
| 宿主补丁清单与核对方式 | `docs/host-patches.md` |
| 安装前审计（已修缺陷 A1–A12 与各道门禁） | `docs/pre-install-audit.md` |

## 8. 许可与作者

MIT，见 `LICENSE`（Copyright © 2026 AndyPBI）。

- 维护者：AndyPBI · <dalianyunhai@gmail.com>
- 仓库与问题反馈：<https://github.com/AndyPBI/dsh-plugin-galaxy>
- 第三方归属说明：`THIRD-PARTY-NOTICES.md`
