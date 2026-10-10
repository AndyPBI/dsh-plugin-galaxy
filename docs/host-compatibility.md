# 宿主版本兼容（跨代共存）

> 本插件要在**两代宿主**上都能用：

| | 0.1.5-rc.2（旧代） | 0.2.1-alpha.1（新代） |
|---|---|---|
| 生效版本链 | checkout / profile 锚点 / 运行进程 | 同上 |
| 本插件声明范围 | `>=0.1.5-alpha.1`（两代都满足，靠**运行时解析**而不是靠抬高下限） | 同 |
| 结论 | `npm run check:host-surface` + `check:host-settings` + 153 项测试 **PASS** | 同（已在真 0.2.1 上复跑） |

两代的差异集中在**三个面**。差异不是猜的：都用 `git show <ref>:<path>` 逐字对比过
（旧代 `upgrade/rc2`，新代 tag `dsh-v0.2.1-alpha.1`），并做了**双向**核对
（旧名字在新代是否还在、新名字在旧代是否存在）。

---

## 1. 图标：按尺寸命名 → 按字重命名

| 旧代 | 新代 |
|---|---|
| `IconSearchOutline16` | `IconSearchOutlineRegular` / `…Medium` |
| `IconRefreshOutline14` / `…16` | `IconRefreshOutlineRegular` / `…Medium` |
| `IconSparkle16` | `IconSparkleRegular` / `…Medium` |

**旧名字在新代全树 0 命中、新名字在旧代 0 命中**（无别名）。若按名字静态 import，缺的那个导出是
`undefined`，而本插件有一道"缺宿主 primitive 就不注册"的守卫 —— 结果是**整块面板消失**（不是崩溃，是静默不可用）。

修法（`src/client/icons.ts`）：

- 静态只 import `* as primitives`（模块对象），三个图标各给一组**候选名**（新名在前），
  `resolveIcon()` 取运行宿主真正提供的那个；两组都没有才返回空渲染占位。
- `REQUIRED_PRIMITIVES` 只留两代都有的稳定成员（Button / Input / Modal / Toast），
  图标改成**分组"任一即可"**（`ICON_ALTERNATIVES`），`missingPrimitives()` 按组判定。
- `primitives.d.ts` **同时声明两代拼写**（新名标 `| undefined`），并用单测覆盖
  "两代都有取新名 / 只有旧名回退 / 都没有返回 undefined / 非组件值忽略"。

## 2. 设置卡片座位：`settings.plugin.item` → `plugins.detail.section`

- 旧代：服务 `settingsScope` + keyed 槽位 `settings.plugin.item`（按包名占位）。
- 新代：这两个都没了；改由 `ui-plugin-manager` 的插件详情页声明
  `plugins.detail.section`（list，ownerProps `{ subject }`），条目**自己判断**主语是不是本插件。
- `slots.register` 对**未声明的槽位会抛错**，所以两条路径都用 `slots.inject(<槽位名>, …)` 作闸门：
  座位由属主在运行时声明，另一边根本不会触发（不是 try/catch 兜住异常）。
- 主语判定 `isOwnPluginSubject()`：`kind: 'bundle' | 'row'` 且 `pkg.name === 'dsh-plugin-galaxy'`；
  `kind: 'item'`（官方插件按自己的 id 编址）不算命中 —— 否则本插件的卡片会出现在**别人的插件页**上。

## 3. 插件设置项：settings 命名空间 → cordis `Config` 投影

- 旧代：`settings.register(ns, schema, { base })` 注册命名空间，卡片里的开关写用户层。
- 新代：`settings` 包已经没有 `register`，改为把条目声明的 cordis **`Config`** 投影成表单
  （`SettingsForms` 服务）。条目没有 `Config` 导出 → 设置项静默消失。
- 修法：`src/index.ts` 导出 `Config`（手写 **Standard Schema v1**：无需引入 schemastery 静态依赖，
  未知键丢弃而非让条目加载失败），`apply(ctx, config)` 两代都从同一个 config 读值；
  旧的命名空间注册保留，遇到没有 `register` 的服务时**静默不动作**（`check:host-settings` 会在
  新代分支里验证这一点）。

---

## 4. 逐项核对结论（0.2.1-alpha.1）

| 面 | 结论 |
|---|---|
| `PLATFORM_MODULES` / 我们的 externals | 未变 |
| `Button` / `Input` / `Modal` / `Toast` | 未变（Button 改 `forwardRef`，variant/size 取值不变；`.sm` 仍是 12px/18px） |
| `settings.section`、`shell.overlay` | 未变（`label` 仍接受 thunk；`settings.section` 的 ownerProps 两代逐字相同） |
| 13 个 `--dsw-alias-*` 设计令牌 | 全部仍在 |
| `webServer.register({kind,path,handler}) → disposer` | 签名逐字相同 |
| CLI `dsh plugin --profile <p> <pnpm 参数>` | 仍在（新代只是把 `desktop` 小写归一） |
| 清单语义 `dsh.bundle.patch` / `dsh.client.inject` | 未变 |
| peer：`cordis` 4.0.5-alpha.1、`schemastery` 3.18.5-alpha.1 | **范围已放宽**（`^4.0.1 \|\| ^4.0.5-alpha.1`） |
| Node engines | 新代要求 `^22.19.0 \|\| >=24.0.0` |
| 宿主补丁（侧栏 footer 竖排） | 新代**仍需**，升级后按 `docs/host-patches.md` 重打 |

## 5. 升级宿主后怎么自查

```bash
# 1) 确认生效版本链（三者应一致）
cd <deepseek-harness> && git log -1 --oneline && node apps/cli/lib/bin.js --version
# 2) 插件侧三件套
cd <plugin> && npm run check:host-surface && npm run check:host-settings && npm run check:layout
# 3) 重打宿主补丁（若 check:host-surface 报 sidebar footer actions）
```

`npm run check:host-surface` 会把**版本相关的每一条**都验一遍：primitive（含图标分组）、槽位
（两代任一）、设计令牌、peer 范围、宿主补丁、`.actionLink` 字号。

---

## 6. 桌面版 / Windows（0.2.x 的又一处契约合并）

0.2.x 把桌面壳过去给插件的**两个服务合并成了一个**，因此"只认旧名字"的插件在桌面版里会
**静默走错分支**：

| 旧（≤ 0.1.5-rc.2 的 Desktop） | 新（0.2.x，含 Windows 桌面版） |
|---|---|
| `desktopProfiles`（应用自有的 profile 列表） | **`profileContext`**（每个由 dsh 启动的 profile 都有：`name` / `dir` / `patchPath` / `home` / `packageManager` / `startedBundles` / `overlays`） |
| `desktopPnpm`（应用替插件跑 pnpm 的服务） | `profileContext.packageManager = { command, args, env }`：应用把自己的**内置运行时**交出来，由插件直接启动 |

为什么"只认旧名字"会坏：

- 桌面宿主**不是**以 `dsh --profile <name>` 启动的（它起自己的 `dsh-desktop-host <runtimeDir> <projectDir> …`），
  所以 argv 里没有 profile 可退；只认旧服务的插件会把 profile 解析成 `web` ——
  **读写错 profile**。
- 打包应用**没有 PATH 上的 pnpm**（Windows 上更是如此：命令是应用自带的 `node.exe` + pnpm 入口），
  拿不到内置运行时 = 安装/更新/卸载全部失败。
- 打包应用**拥有进程生命周期**：插件若还开着"一键重启"，就会绕过应用的启动器与 IPC。

本插件的做法（`src/domain/host-shape.ts`，纯函数 + 单测）：

1. 解析顺序：**操作员 config → `profileContext` → argv → `desktopProfiles`（旧桌面）→ `web`**；
   `profileDirectory` 只在"解析出的 profile 就是被启动的那个"时才跟着走
   （显式配置了别的 profile 时仍用标准 `<DSH_HOME>/profiles/<name>`，否则会动错文件）。
2. `profileContext.packageManager` 存在即视为**打包应用**：用 `createPackagedRunner` 直接启动它
   （`cwd` = 该 profile 目录，`env` 以应用给出的为准；Windows 上只有 `.cmd` 垫片才走 `cmd.exe /c`，自带 `node.exe` 直接起），
   跳过 CLI 的 `plugin --profile` 包装（它无法指向非标准目录）。
3. 打包应用下 `allowRestart` 强制 `false`，与旧桌面分支同一条理由：生命周期归外壳。

Windows 侧另有既有实现（非本次新增，均有注释与门禁）：`dsh.cmd` 必须经 shell 启动、
`taskkill /t /f` 杀进程树、PATH 分隔符、`ComSpec`、`windowsHide`；本次补的两处：

- **原子写的 Windows 窗口**：`rename` 覆盖被占用的目标会 EPERM/EACCES/EBUSY → 重试一次，仍失败则就地写
  （丢一次原子性优于丢一次设置写入）；
- **盘符 / UNC 绝对路径** 归入"本地来源"（否则被当成未知来源，本地 tarball 会被提示一个永远拿不到的 npm 更新）。

> 诚实说明：以上是**契约级适配 + 单元测试**（`tests/host-desktop.test.ts`）。Windows 桌面版的
> **运行时**验证需要一台 Windows 机器：安装后确认「设置 → 插件星系」能列出 profile、
> 安装/卸载走的是应用内置 pnpm、且没有出现"重启"入口。macOS 上的 `check:*` 门禁无法覆盖它。
