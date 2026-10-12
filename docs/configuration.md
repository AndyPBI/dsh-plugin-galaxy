# 配置参考

> 本文件收集 `dsh-plugin-galaxy` 的全部可配置项。README 只保留安装与使用，这些"查表用"的内容放在这里。

## 1. 插件配置（cordis config / 设置项）

| 配置 | 来源 | 默认 | 作用 |
|---|---|---|---|
| `profile` | cordis config / 宿主 | `web` | 被管理的 profile |
| `allowRestart` | cordis config / 设置项 | 未配置（=禁用） | 一键重启开关；宿主由 supervisor 托管时，未显式设为 `true` 即禁用 |
| `maxSnapshots` | cordis config | `20` | 每 profile 保留快照数 |

> 0.2.x 宿主把插件配置投影成设置表单（cordis `Config`）；0.1.x 走 settings 命名空间。两条路径读的是同一份值，
> 见 `docs/host-compatibility.md`。

## 2. 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSHG_REGISTRY_URL` | 内置公共目录 | 自定义 catalog |
| `DSHG_SITE_URL` | 未设置（由 catalog origin 推导） | 插件官网基址；设置后每张卡片都深链到 `<基址>/#/ai/p/<owner%2Fname>` |
| `DSHG_NPM_MIRROR` | 未设置 | 覆盖 npm registry 基址 |
| `DSHG_GITHUB_PROXY` | 未设置 | 操作员托管的 GitHub 前缀代理（设置后 UI 锁定） |
| `DSHG_UPDATES_ORIGIN` | 内置 | release notes 来源 |
| `DSHG_INSTALL_TIMEOUT_MS` | 15 分钟 | 安装子进程超时 |
| `DSHG_KILL_SETTLE_MS` | 10 秒 | 杀掉安装子进程后，等待其落定的兜底时限 |
| `DSHG_DISCOVERY_TTL_MS` | 6 小时 | 兼容性事实缓存 TTL |
| `DSH_HOST_VERSION` | 自动探测 | 显式覆盖宿主版本（**宿主自身从不设置它**） |
| `DSH_HOME` | `~/.dsh` | profile 根目录 |
| `HTTP(S)_PROXY` / `NO_PROXY` | 未设置 | 出站请求与 pnpm 子进程代理 |

## 3. profile 级设置（状态文件）

| 键 | 位置 | 作用 |
|---|---|---|
| `catalogUrl` | 面板「设置 → 目录来源」，落在 `<profile>/.dsh-galaxy/state.json` | profile 级目录数据源（优先级低于 `DSHG_REGISTRY_URL`） |
| `siteUrl` | 同上 | profile 级官网基址（优先级低于 `DSHG_SITE_URL`） |
| `channel` / `region` | 同上 | 发布通道与下载区域（面板设置卡片里可改） |
| `disabled` / `groups` / `notes` / `favorites` | 同上 | 启停、分组、备注、收藏 |

状态文件与其它落盘位置（快照、预设、日志）的完整清单见 `docs/implementation-contract.md`。

## 4. 目录来源（面板里可改）

面板「设置 → 目录来源」写的就是上面两个 profile 级键，读侧从 `/status` 返回：

| 显示 | 含义 |
|---|---|
| 当前生效 | 真正在用的 catalog URL |
| 来源 | `环境变量` / `本 profile 设置` / `内置公共目录` —— 环境变量优先，所以"保存了却不变"会在这里被解释清楚 |

> 一台机器上装了桌面版却"显示 4508 个插件、没有甄选、没有分类筛选"，就是这里没配：
> 回落到了内置公共目录（`awesome-dsh-plugin.com/plugins.json`，4508 条、无推荐块、
> `categories` 为映射形状）。配好 `catalogUrl` + `siteUrl` 即可。
