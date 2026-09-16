# 模块与能力矩阵（Module & Capability Matrix）

> 本文件是**本项目自己的**模块与能力矩阵：每个能力落在哪个文件、每个端点由谁注册、
> 哪条不变量由谁执行。它与 `docs/implementation-contract.md`（服务端契约）、
> `docs/client-contract.md`（客户端契约）互为索引，三者随代码一起演进。
>
> 维护方式：改动实现时同步本文件的对应行；发版前的 `npm test` 会核对端点数量与槽位注册。

## 1. 产品身份与命名空间

| 项 | 值 |
|---|---|
| 包名 / 客户端 bundle id | `dsh-plugin-galaxy` |
| 端点前缀 | `/dsh-galaxy` |
| 公共 API 前缀 | `/dsh-galaxy/api/v1` |
| 数据目录 | `<profile>/.dsh-galaxy/` |
| 设置命名空间 | `dsh-plugin-galaxy.allowRestart` |
| `settings.section` id | `galaxy`（order 40） |
| locale 命名空间 | `dsh-plugin-galaxy` |
| 环境变量 | `DSHG_*`（`DSHG_REGISTRY_URL`、`DSHG_SITE_URL`、`DSHG_KILL_SETTLE_MS`、`DSHG_HOME`、代理变量……） |
| 备份格式 | `dsh-galaxy-backup`（同时接受早期版本写出的旧格式文件，只读兼容） |
| 快照格式 | `dsh-plugin-galaxy-snapshot` |
| v1 API schema | `dsh-galaxy-update-api` |
| 热装载超时等内部旋钮 | `DSHG_HOT_MOUNT_TIMEOUT_MS` 等 |

## 2. 架构分层

| 层 | 本项目位置 |
|---|---|
| 宿主入口 | `src/index.ts`（挂载路由、注册设置命名空间） |
| 共享基础层 | `src/core/`（11 个模块：路径、原子写、锁、日志、状态、HTTP 守卫、runtime……） |
| 领域层 | `src/domain/`（36 个模块：目录、安装、更新、备份、诊断、区域……） |
| 路由层 | `src/api/router.ts` + `src/api/routes-*.ts`（按域拆分的 8 个注册器） |
| 客户端 | `src/client/`（20 个文件，含 zh/en 两套 locale 片段） |
| 脚本 | `scripts/*.mjs`（目录校验器、站点构建、宿主探针、打包体检） |
| 静态站点 | `site/`（手写 HTML）→ `dist-site/`（`npm run build:site`） |

> 说明：早期把路由集中在一个四千余行的单文件里；本项目按领域拆分为 8 个路由组，
> 端点集合与语义保持一致；这是结构改进，不是功能变更。

## 3. 能力 → 实现位置

| 名称 | 主要实现位置 |
|---|---|
| 目录浏览/搜索/筛选 | `src/domain/registry.ts`、`catalog-npm.ts`、`catalog-local-match.ts`、`compatibility.ts`、`discovery-compatibility.ts`、`api/routes-catalog.ts`、`client/MarketSection.tsx` |
| 安装插件 | `src/domain/install.ts`、`dsh-cli.ts`、`api/routes-lifecycle.ts` |
| 更新插件 | `src/domain/updates.ts`、`install.ts`、`api/routes-lifecycle.ts` |
| 更新检测 | `src/domain/updates.ts`、`api/routes-network.ts` |
| 查看更新记录 | `src/domain/changelog.ts`、`api/routes-network.ts`、`client/MarketSection.tsx` |
| Git→npm 来源迁移 | `src/domain/source-migration.ts` |
| 卸载插件 | `src/domain/install.ts`、`patch.ts`、`api/routes-lifecycle.ts` |
| 操作回滚 | `src/api/routes-lifecycle.ts`、`api/routes-v1.ts` |
| 放行构建脚本并重试 | `src/domain/pnpm-compat.ts`、`api/routes-lifecycle.ts` |
| 取消运行中操作 | `src/domain/dsh-cli.ts`（activeProcess）、`api/routes-lifecycle.ts` |
| 插件启停 | `src/domain/patch.ts`、`hot.ts`、`themes.ts`、`api/routes-tuning.ts` |
| 自定义分组 | `src/domain/groups.ts`、`api/routes-tuning.ts` |
| 主题切换 | `src/domain/themes.ts`、`client/MarketSection.tsx` |
| Bundle 排序 | `src/domain/order.ts`、`api/routes-tuning.ts` |
| 命名预设 | `src/domain/presets.ts`、`api/routes-tuning.ts`、`client/preset-panel.tsx` |
| 快照管理 | `src/domain/snapshot.ts`、`api/routes-tuning.ts`、`client/snapshot-panel.tsx` |
| 插件备注 | `src/core/state.ts`、`api/routes-tuning.ts` |
| 收藏目录 | `src/core/state.ts`、`api/routes-tuning.ts` |
| 查看插件评论 | `src/client/comments.ts`、`CommentsModal.tsx` |
| 创建备份 | `src/domain/backup.ts`、`api/routes-protection.ts` |
| 恢复备份 | `src/domain/backup.ts`、`api/routes-protection.ts` |
| WebDAV 同步 | `src/domain/backup.ts`、`api/routes-protection.ts` |
| Gist 同步 | `src/domain/gist.ts`、`api/routes-protection.ts` |
| 下载区域 | `src/domain/regions.ts`、`region-probe.ts`、`api/routes-network.ts` |
| GitHub 代理路由 | `src/domain/regions.ts`、`api/routes-network.ts` |
| pnpm 一键供给 | `src/domain/pnpm-compat.ts`、`api/routes-lifecycle.ts` |
| GitHub HEAD 加速解析 | `src/domain/accelerate.ts` |
| 发布通道 | `src/domain/channels.ts`、`api/routes-network.ts` |
| 状态/进度轮询 | `src/domain/ndjson.ts`、`progress.ts`、`api/routes-host.ts` |
| 日志导出 | `src/core/log.ts`、`api/routes-diagnostics.ts`、`client/self-check.ts`、`ErrorBoundary.tsx` |
| 一键重启 | `src/domain/restart.ts`、`api/routes-lifecycle.ts` |
| 自我卸载 | `src/domain/self-uninstall.ts`、`api/routes-lifecycle.ts` |
| 一键诊断 | `src/domain/diagnostics.ts`、`check.ts`、`verify.ts`、`api/routes-diagnostics.ts`、`client/Diagnostics.tsx` |
| 公共更新 API v1 | `src/domain/update-api-v1.ts`、`api/routes-v1.ts` |
| 宿主启动挂载 | `src/index.ts`、`src/api/index.ts`、`client/index.ts`、`domain/settings.ts` |
| 操作记录面板 | `src/client/operations.ts`、`OperationsPanel.tsx` |
| CI/发布校验 | `.github/workflows/ci.yml`、`scripts/validate-registry.mjs` |
| 站点构建发布 | `scripts/build-site.mjs`、`site/index.html` |

**覆盖：38 / 38（100%）**

## 3.1 界面入口 → 宿主槽位

宿主槽位取自 `deepseek-harness/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`。

| 界面（`data-entry`） | 宿主槽位 | 实现 |
|---|---|---|
| `galaxy-section` | `settings.section`（id `galaxy`，order 40） | `src/client/index.ts` → `MarketSection.tsx` |
| `discover` / `installed` / `favorites` / `themes` | section 内的 4 个 Tab（值来自 `TAB_ENTRY`） | `src/client/MarketSection.tsx` |
| `operations` | section 内的浮动面板 | `src/client/OperationsPanel.tsx` |
| `comments` | 插件卡片上的弹窗 | `src/client/CommentsModal.tsx` |
| `snapshot-panel` / `preset-panel` | 面板 | `src/client/snapshot-panel.tsx` / `preset-panel.tsx` |
| `diagnostics` | 「诊断」Tab | `src/client/Diagnostics.tsx` |
| `settings-card` | `settings.plugin.item`（key `dsh-plugin-galaxy`） | `src/client/SettingsCard.tsx` |
| （无标记） | `shell.overlay` | `src/client/InstallToast.tsx` |
| （无标记） | section 渲染包裹 | `src/client/ErrorBoundary.tsx` |

> 侧栏座位 `sidebar.footer.action` **未被占用**：本插件的唯一 UI 表面是设置对话框。
> 曾实现过侧栏区块（竖排列表 + 56px rail 双形态），按需求已移除；
> 侧栏座位契约（`kind: 'list'`、owner props `{ wide: boolean }`、`wide === false` = 56px rail）
> 见 `docs/client-contract.md` §5。

## 4. 端点 → 路由文件

| 端点（本项目路径） | 路由文件 |
|---|---|
| `GET /dsh-galaxy/api/v1/capabilities` | `api/routes-v1.ts` |
| `GET\|POST /dsh-galaxy/api/v1/updates` | `api/routes-v1.ts` |
| `GET /dsh-galaxy/api/v1/operations` | `api/routes-v1.ts` |
| `POST /dsh-galaxy/api/v1/rollback` | `api/routes-v1.ts` |
| `POST /dsh-galaxy/api/v1/restart` | `api/routes-v1.ts` |
| `POST /dsh-galaxy/api/v1/cancelling` | `api/routes-v1.ts` |
| `GET /dsh-galaxy/registry` | `api/routes-catalog.ts` |
| `POST /dsh-galaxy/discovery-compatibility` | `api/routes-catalog.ts` |
| `GET /dsh-galaxy/installed` | `api/routes-tuning.ts` |
| `GET /dsh-galaxy/check` | `api/routes-diagnostics.ts` |
| `POST /dsh-galaxy/bundle-order` | `api/routes-tuning.ts` |
| `GET\|POST /dsh-galaxy/presets` | `api/routes-tuning.ts` |
| `GET\|POST /dsh-galaxy/snapshots` | `api/routes-tuning.ts` |
| `POST /dsh-galaxy/restore-snapshot` | `api/routes-tuning.ts` |
| `POST /dsh-galaxy/delete-snapshot` | `api/routes-tuning.ts` |
| `POST /dsh-galaxy/use-skin` | `api/routes-tuning.ts` |
| `POST /dsh-galaxy/toggle` | `api/routes-tuning.ts` |
| `POST /dsh-galaxy/note` | `api/routes-tuning.ts` |
| `POST /dsh-galaxy/favorite` | `api/routes-tuning.ts` |
| `POST /dsh-galaxy/groups` | `api/routes-tuning.ts` |
| `GET /dsh-galaxy/status` | `api/routes-host.ts` |
| `GET /dsh-galaxy/logs` | `api/routes-diagnostics.ts` |
| `GET /dsh-galaxy/updates` | `api/routes-network.ts` |
| `GET /dsh-galaxy/changelog` | `api/routes-network.ts` |
| `POST /dsh-galaxy/channel` | `api/routes-network.ts` |
| `POST /dsh-galaxy/region` | `api/routes-network.ts` |
| `POST /dsh-galaxy/github-proxy` | `api/routes-network.ts` |
| `GET /dsh-galaxy/backup` | `api/routes-protection.ts` |
| `POST /dsh-galaxy/restore` | `api/routes-protection.ts` |
| `POST /dsh-galaxy/webdav` | `api/routes-protection.ts` |
| `POST /dsh-galaxy/gist` | `api/routes-protection.ts` |
| `POST /dsh-galaxy/install` | `api/routes-lifecycle.ts` |
| `POST /dsh-galaxy/update` | `api/routes-lifecycle.ts` |
| `POST /dsh-galaxy/uninstall` | `api/routes-lifecycle.ts` |
| `POST /dsh-galaxy/migrate-source` | `api/routes-lifecycle.ts` |
| `POST /dsh-galaxy/rollback` | `api/routes-lifecycle.ts` |
| `POST /dsh-galaxy/self-uninstall` | `api/routes-lifecycle.ts` |
| `POST /dsh-galaxy/restart` | `api/routes-lifecycle.ts` |
| `POST /dsh-galaxy/approve-builds` | `api/routes-lifecycle.ts` |
| `POST /dsh-galaxy/cancel` | `api/routes-lifecycle.ts` |
| `POST /dsh-galaxy/setup-pnpm` | `api/routes-lifecycle.ts` |

**覆盖：42 / 42（100%）**，由 `tests/routes.test.ts` 的注册表断言逐路径校验。

## 5. 持久数据与外部数据源

| 数据 | 落盘位置 / 来源 | 实现 |
|---|---|---|
| profile manifest | `<profile>/package.json` | `src/core/profile.ts` |
| profile lockfile | `<profile>/pnpm-lock.yaml`（读取/恢复） | `src/core/profile.ts` |
| 星系自有状态 | `<profile>/.dsh-galaxy/state.json` | `src/core/state.ts` + `paths.ts` |
| 快照 | `<profile>/.dsh-galaxy/snapshots/<id>.json` | `src/domain/snapshot.ts` |
| 预设 | `<profile>/.dsh-galaxy/presets.json` | `src/domain/presets.ts` |
| 事件日志 | `<profile>/.dsh-galaxy/log.ndjson` | `src/core/log.ts` |
| 热装载输入 | `<profile>/.dsh-galaxy/hot-<n>.yml` | `src/domain/hot.ts` |
| 用户补丁层 | `<profile>/cordis.patch.yml` | `src/domain/patch.ts` |
| 兼容性预判缓存 | `<profile>/.dsh-galaxy/discovery-cache.json` | `src/domain/discovery-compatibility.ts` |
| 精选目录 | 外部 HTTPS JSON（`DSHG_REGISTRY_URL` / profile `catalogUrl` / 内置默认） | `src/domain/registry.ts`、`catalog-npm.ts` |
| npm registry | 外部 dist-tags | `src/domain/updates.ts` |
| release notes | 外部源（GitHub Releases / npm 元数据） | `src/domain/changelog.ts` |
| 目录校验器 | 内存（`runtime.cache('catalog.validators')`） | `src/domain/registry.ts` |
| 更新答案缓存 | 内存，30 分钟 TTL（`runtime.cache('updates.cache')`） | `src/domain/updates.ts` |
| v1 操作存储 | 内存 | `src/domain/update-api-v1.ts` |
| 回滚令牌 | 内存 | `src/core/runtime.ts` + `api/routes-lifecycle.ts` |
| 浏览器 boot 注解 | sessionStorage | `src/client/operations.ts` |
| 备份暂存 | 内存 | `src/domain/backup.ts` |
| bundle 顺序候选 | 内存 | `src/domain/order.ts` |

## 6. 不变量 → 执行位置

| 不变量 | 执行位置 |
|---|---|
| 同源 / 回环守卫：外部页面不能驱动本机插件管理 | `src/core/http.ts` + `src/api/router.ts` |
| 只安装目录内的来源（白名单） | `src/domain/sources.ts`（`installTargetFor`） |
| agent 接管时的安装保护 | `src/domain/agents.ts` |
| 变更串行化：所有 profile 变更走同一把锁 | `src/core/locks.ts` + 各变更路由 |
| 快照配额与 id 规则 | `src/domain/snapshot.ts` |
| 收藏配额、备注长度上限 | `src/core/state.ts` |
| 预设配额 | `src/domain/presets.ts` |
| 补丁信任与受保护模块（本插件自身不可卸载） | `src/domain/patch.ts` |
| Gist 体积上限 | `src/domain/gist.ts` |
| 备份体积上限 | `src/domain/backup.ts` |
| 重启由托管方（launchd/systemd/桌面壳）决定 | `src/domain/restart.ts` |
| 日志脱敏：家目录路径与凭据样式的串在写盘前替换 | `src/core/log.ts` |

## 7. 主要取舍（Deviation Log）

以下取舍均为**有意为之**，逐条给出理由。

1. **路由拆分**：早期为单文件 `routes.ts`（4504 行），本项目按域拆成 8 个 `routes-*.ts`。端点集合不变。
2. **显式共享基础层**：早期没有独立的 core 层（工具函数散落在各模块），本项目新增 `src/core/`，
   使守卫、日志、原子写、锁只有一份实现。这是结构改进。
3. **设置命名空间**：`dsh-plugin-galaxy.allowRestart`（产品身份下唯一的一套命名空间）。
4. **热装载**：本项目实现了 hot 文件写入与记录，但宿主实际热装载能力尚未接入，因此一律按"需要重启"反馈。
   这是**已知缺口**，影响 `install`/`toggle`/`use-skin` 的 `needsRestart` 语义（仍正确，只是不退化为免重启）。
5. **pnpm 版本探测**：`dsh-cli` 的子进程约定为 `dsh plugin …`，而 `pnpm-compat` 需要 `pnpm --version`
   形式。当前探测退化为文件系统查找（返回路径、无版本），`PnpmProbe.version` 可能缺失。**已知缺口**。
6. **安装风险提示（`introducedRisks`）**：`install` 响应中的 `risks` 字段目前不填充，因为那需要
   安装前后两次宿主兼容评估，而 `compatibility.ts` 只提供 `deriveHostCompatibility`/`introducedRisks`。
   **已知缺口**。
7. **`validateAddedPlugins` 为只读**：本项目只报告不删除坏包，由
   `install.ts` 的告警文案呈现。这是更保守的取舍（避免自动删除用户文件）。
8. **站点内容**：本项目提供可构建的最小落地页（`npm run build:site`）。

## 8. 验证结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 服务端类型检查 | `npx tsc -p tsconfig.json --noEmit` | **0 error** |
| 客户端类型检查 | `npx tsc -p tsconfig.client.json --noEmit` | **0 error** |
| 构建（服务端 + 客户端 bundle） | `npm run build` | **通过**（`lib/` 1.1MB，`client/client.js` 253KB / gzip 54KB） |
| 单元 + 集成测试 | `npm test` | **150/150 通过**（含端点注册断言、守卫、恢复落盘、推荐视图与客户端渲染） |
| 静态站点构建 | `npm run build:site` | **通过** |
| catalog 校验器 | `node scripts/validate-registry.mjs <fixture>` | 正常载荷 **PASS**，非法载荷 **FAIL(exit 1)** |

## 9. 怎么用这份矩阵

- 想了解某个能力怎么做：第 3 节找到能力名 → 打开对应实现文件。
- 想改某个接口：第 4 节找到端点 → 路由文件 → 第 3 节找到它服务的能力。
- 想核对数据落盘位置：第 5 节 → `src/core/state.ts` / `src/core/paths.ts`。
- 想核对安全约束：第 6 节 → `src/core/http.ts`、`src/api/router.ts`、各领域模块。
