# Plugin Galaxy — 实现契约（Implementation Contract）

> 本文件是并行实现模块时必须遵守的唯一接口契约：路由表、持久对象、规则、状态文件与错误语义。
> 产品身份、命名空间与目录布局都在本文件内自持定义；实现只以本文件与 `docs/client-contract.md` 为依据。

## 1. 产品身份与命名空间

| 项 | 值 |
|---|---|
| 包名 | `dsh-plugin-galaxy` |
| 产品名 | Plugin Galaxy |
| 端点前缀 | `/dsh-galaxy`（公共版本化 API：`/dsh-galaxy/api/v1`） |
| 数据目录 | `<profile>/.dsh-galaxy/` |
| 设置命名空间 | `dsh-plugin-galaxy.allowRestart` |
| cordis 插件名 | `dsh-plugin-galaxy` |
| 环境变量前缀 | `DSHG_*`（如 `DSHG_REGISTRY_URL`、`DSHG_NPM_MIRROR`、`DSHG_GITHUB_PROXY`、`DSHG_UPDATES_ORIGIN`） |

## 2. 目录与所有权

```text
src/
  core/       共享基础层（已完成，勿改）
  domain/     领域模块（本契约第 4 节分配）
  api/        路由层（routes-*.ts，每个模块组一个文件）
  client/     React 客户端
  index.ts    宿主入口（apply）
```

已完成、**不要修改**的文件：`src/core/types.ts`、`paths.ts`、`http.ts`、`log.ts`、`net.ts`、
`json.ts`、`locks.ts`、`profile.ts`、`state.ts`、`runtime.ts`、`src/api/host.ts`、`src/api/router.ts`。
若确需新增共享能力，写在自己的模块内，不要改这些文件。

## 3. 编码约定

1. TypeScript strict，ESM，`moduleResolution: bundler`；**import 必须带 `.ts` 扩展名**（如 `import { logEvent } from '../core/log.ts'`）。
2. 依赖只允许已声明的 `js-yaml`、`undici` 与 Node 内置模块。不得新增依赖。
3. 不得使用模块级可变状态（缓存/计数器）。需要跨请求状态时用 `GalaxyRuntime`（`runtime.cache/setCache`、`runtime.pendingRollbacks`、`runtime.hotMounts`、`runtime.activeProcess`、`runtime.restartScheduled`）。
4. 注释用英文；面向用户的字符串可用中英双语（`locales*.ts` 里 zh/en 两套 key 必须一一对应）。
5. 所有写文件必须走 `core/json.ts` 的原子写（`writeJsonAtomic` / `writeFileAtomic`）。
6. 所有日志走 `logEvent(level, event, detail)`；不要 `console.log`。
7. 所有出站 HTTP 走 `core/net.ts` 的 `marketFetch` / `fetchJson`。
8. 不要吞异常：捕获后必须 `logEvent('warn'|'error', ...)` 或返回带原因的失败对象。

## 4. 模块与路由所有权

| 组 | 领域模块 | 路由文件 | 注册函数 |
|---|---|---|---|
| A 目录与兼容 | `registry.ts`、`catalog-npm.ts`、`catalog-local-match.ts`、`compatibility.ts`、`discovery-compatibility.ts`、`sources.ts` | `api/routes-catalog.ts` | `registerCatalogRoutes(router, runtime)` |
| B 清单与调优 | `snapshot.ts`、`presets.ts`、`order.ts`、`patch.ts`、`groups.ts`、`themes.ts`、`hot.ts` | `api/routes-tuning.ts` | `registerTuningRoutes(router, runtime)` |
| C 诊断与可观测 | `check.ts`、`diagnostics.ts`、`verify.ts`、`trial.ts` | `api/routes-diagnostics.ts` | `registerDiagnosticsRoutes(router, runtime)` |
| D 保护与同步 | `backup.ts`、`gist.ts` | `api/routes-protection.ts` | `registerProtectionRoutes(router, runtime)` |
| E 更新与网络 | `updates.ts`、`changelog.ts`、`channels.ts`、`regions.ts`、`region-probe.ts`、`accelerate.ts`、`pnpm-compat.ts` | `api/routes-network.ts` | `registerNetworkRoutes(router, runtime)` |
| F 生命周期 | `dsh-cli.ts`、`install.ts`、`restart.ts`、`self-uninstall.ts`、`source-migration.ts`、`settings.ts`、`agents.ts` | `api/routes-lifecycle.ts` | `registerLifecycleRoutes(router, runtime)` |
| G 公共 v1 API | `update-api-v1.ts` | `api/routes-v1.ts` | `registerV1Routes(router, runtime)` |
| H 宿主运行时 | `ndjson.ts`、`progress.ts` | `api/routes-host.ts` | `registerHostRoutes(router, runtime)` |

**路由归属（不得重复注册同一 path）**

- A：`GET /dsh-galaxy/registry`、`POST /dsh-galaxy/discovery-compatibility`
- B：`GET /dsh-galaxy/installed`、`POST /dsh-galaxy/bundle-order`、`GET|POST /dsh-galaxy/presets`、
  `GET|POST /dsh-galaxy/snapshots`、`POST /dsh-galaxy/restore-snapshot`、`POST /dsh-galaxy/delete-snapshot`、
  `POST /dsh-galaxy/use-skin`、`POST /dsh-galaxy/toggle`、`POST /dsh-galaxy/note`、
  `POST /dsh-galaxy/favorite`、`POST /dsh-galaxy/groups`
- C：`GET /dsh-galaxy/check`、`GET /dsh-galaxy/logs`
- D：`GET /dsh-galaxy/backup`、`POST /dsh-galaxy/restore`、`POST /dsh-galaxy/webdav`、`POST /dsh-galaxy/gist`
- E：`GET /dsh-galaxy/updates`、`GET /dsh-galaxy/changelog`、`POST /dsh-galaxy/channel`、
  `POST /dsh-galaxy/region`、`POST /dsh-galaxy/github-proxy`
- F：`POST /dsh-galaxy/install`、`POST /dsh-galaxy/update`、`POST /dsh-galaxy/uninstall`、
  `POST /dsh-galaxy/migrate-source`、`POST /dsh-galaxy/rollback`、`POST /dsh-galaxy/self-uninstall`、
  `POST /dsh-galaxy/restart`、`POST /dsh-galaxy/approve-builds`、`POST /dsh-galaxy/cancel`、
  `POST /dsh-galaxy/setup-pnpm`
- G：`GET /dsh-galaxy/api/v1/capabilities`、`GET|POST /dsh-galaxy/api/v1/updates`、
  `GET /dsh-galaxy/api/v1/operations`、`POST /dsh-galaxy/api/v1/rollback`、
  `POST /dsh-galaxy/api/v1/restart`、`POST /dsh-galaxy/api/v1/cancelling`
- H：`GET /dsh-galaxy/status`

合计 42 个端点（`GET|POST` 计为一个 path 的两种方法）。

## 5. 跨模块函数签名（必须按此实现/调用）

```ts
// domain/patch.ts（组 B）
export function readUserPatchState(profile: string, explicitDir?: string): PatchState
export function isProtectedModule(name: string): boolean
export function enableRow(file: string, packageName: string): boolean
export function disableRow(file: string, packageName: string): boolean
export function removeRowBlocks(file: string, packageName: string): boolean

// domain/snapshot.ts（组 B）
export function createProfileSnapshot(profile: string, dir: string, maxSnapshots: number): ProfileSnapshot
export function listSnapshots(dir: string): ProfileSnapshot[]
export function restoreSnapshot(dir: string, id: string): { ok: boolean; reason?: string }
export function deleteSnapshot(dir: string, id: string): boolean
export function readSnapshot(dir: string, id: string): ProfileSnapshot | undefined

// domain/diagnostics.ts（组 C）
export function analyzeProfile(profile: string, explicitDir?: string): DiagnosticReport

// domain/registry.ts（组 A）
export function loadRegistry(profile: string, dir: string, force?: boolean): Promise<Registry>

// domain/sources.ts（组 A）
export function installTargetFor(registry: Registry, url: string): string | undefined
export function parseSourceSpec(spec: string): { kind: InstallKind; repo?: string; packageName: string }

// domain/updates.ts（组 E）
export function checkUpdates(profile: string, dir: string, options?: { force?: boolean; names?: string[] }): Promise<UpdateStatus[]>
export function invalidateUpdates(runtime: GalaxyRuntime): void
export function readInstalledVersionSafe(profile: string, name: string, explicitDir?: string): string | undefined

// domain/regions.ts（组 E）
export function resolveRegion(runtime: GalaxyRuntime): Region
export function applyRegion(runtime: GalaxyRuntime, region: Region): void
export function routesFor(region: Region): RegionRoutes
export function forgetCatalog(runtime: GalaxyRuntime): void
export function githubProxyManaged(): boolean
export function setCustomGithubProxy(runtime: GalaxyRuntime, proxy: string | null): void

// domain/channels.ts（组 E）
export function asChannel(value: unknown): Channel | undefined
export function distTagFor(channel: Channel): string

// domain/dsh-cli.ts（组 F）
export interface PluginRunner { (profile: string, args: string[]): Promise<InstallResult> }
export function createCliRunner(config: ResolvedConfig): PluginRunner
export function pnpmExtraPathDirs(): string[]

// domain/restart.ts（组 F）
export function restartAllowed(config: ResolvedConfig, runtime: GalaxyRuntime): boolean
export function restartCapability(config: ResolvedConfig, runtime: GalaxyRuntime): RestartCapability
export function scheduleRestart(config: ResolvedConfig, runtime: GalaxyRuntime): Promise<RestartSchedule>
export function detectedSupervisor(): string | undefined

// domain/agents.ts（组 F）
export interface AgentsServiceLike { list?: () => unknown; running?: () => unknown }
export function runningAgentsForGuard(service: AgentsServiceLike | undefined): string[]

// domain/settings.ts（组 F）
export function installGalaxySettings(ctx: unknown, config: { allowRestart?: boolean }): void

// domain/update-api-v1.ts（组 G）
export class UpdateOperationStoreV1 {
  constructor(bootId: string)
  create(packageName: string): UpdateOperationV1
  get(operationId: string): UpdateOperationV1 | undefined
  update(operationId: string, patch: Partial<UpdateOperationV1>): UpdateOperationV1 | undefined
  list(): UpdateOperationV1[]
  cancel(operationId: string): boolean
}
export function capabilitiesV1(runtime: GalaxyRuntime, endpoints: string[]): CapabilitiesV1
```

组 B 的 `api/routes-tuning.ts` 需要组 C 的 `analyzeProfile` 与组 E 的 `resolveRegion`：
按上面签名调用即可，文件由对端并行实现。

组 F 的路由需要组 B 的 `readUserPatchState`/`removeRowBlocks`、组 A 的 `loadRegistry`/`installTargetFor`、
组 E 的 `update` 相关函数；同样按签名调用。

## 6. HTTP 契约要点（来自 interface-index）

- **写路由**一律 `router.post(...)`（自动 sameOrigin 校验）。判定见 `core/http.ts` 的 `sameOrigin()`：
  ① `Origin` 与 `Host` 一致（浏览器形态）；② **无 `Origin` 且请求来自回环** —— 打包桌面壳转发请求时会删除
  `origin`/`host`/`cookie`/`sec-fetch-site` 并注入宿主 cookie（`apps/desktop/src/web-document.ts` → `forwardWebRequest`），
  所以桌面 UI 的写操作是"裸请求"，旧规则一律 403（面板能看不能装）；③ `Origin` 为 `dsh-app://` 协议且来自回环。
  ②③ 都**额外要求回环**，远程调用方伪造"无 Origin"也过不去；浏览器在跨源 POST 上必然带 `Origin`，
  因此"缺失"本身即有信号意义。`Origin: null`（沙箱 iframe / `file://`）属"存在但不可解析"，仍拒绝。
- **破坏性路由**（`/restart`、`/self-uninstall`、`/backup`）额外要求 loopback：
  `/restart`、`/self-uninstall` 用 `{ loopback: true, sameOrigin: true }`；
  `/backup` 用 `{ loopback: true }`（`<a download>` 不带 Origin）。
- 状态码约定：400 参数非法、403 信任拒绝、404 未知对象、405 方法不允许、409 忙/冲突、
  422 规则校验失败、500 内部错误、502 出站抓取失败。
- 变更路由必须走 `runtime.locks.withLock('install'|'write', label, task)`：
  `install` = 子进程/依赖写；`write` = 仅 galaxy 自有文件写。
- 长操作通过 `POST` 返回 `{ operationId }` 或 `{ ok }`，进度由 `GET /status` 轮询。

## 7. 证据与验证

- 每个模块顶部注释必须写明**它自己负责什么**（两三条即可，见 `src/domain/registry.ts` 的「What this module owns」段）——
  不引用任何外部文档的编号体系，模块的行为以本文件与代码注释为准。
- 完成后运行：`npx tsc -p tsconfig.json --noEmit`（根目录），必须 0 error。
