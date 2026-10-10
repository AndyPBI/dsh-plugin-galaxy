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
