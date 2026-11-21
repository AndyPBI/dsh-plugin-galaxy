# dsh-plugin-galaxy — 项目状态

本文件记录**当前客观状态**，供后续会话快速对齐。事实来源：git、GitHub PR、宿主 profile 与 superagent 工单。

> 最后核对：2026-11-21（滑块版本）

## 宿主安装（`~/.dsh/profiles/web`）

| 项 | 值 |
| --- | --- |
| 依赖声明 | `file:<repo>/dsh-plugin-galaxy-0.1.41.tgz` |
| 安装版本 | `0.1.41` |
| 对应代码 | 分支 `feat/market-slider`（工作树未提交的最新改动） |

`0.1.41` 由 `feat/market-slider` 构建（滑块按标签自适应 + 居中 + 窄容器单行不折行），装于 2026-11-21。
`0.1.38` 是同一分支的上一版（等分格滑块），已被 `0.1.39` 取代；`0.1.37-issue4r3`（PR #5 @ `f0bb7ff`）更早已被取代。

## 版本号现状

- `main` 与两个 `agent/*` 分支仍停在 **`0.1.37`**（未做版本提升）。
- **`0.1.41` 只存在于 `feat/market-slider`**：该分支连续提升版本（0.1.38 → 0.1.39 → 0.1.40 → 0.1.41），每次都是因为同版本无法替换已安装包。
- 早期 2026-11-10 那个同名 `0.1.38.tgz` 是本地试验包，已被 11-21 的真实构建覆盖。

## 分支与 PR

| 分支 | head | PR | 状态 |
| --- | --- | --- | --- |
| `main` | `b7d8f29` | — | 领先 `origin/main` 1 个提交，**未推送** |
| `agent/fix-tab-filter-coupling-48895bce6b69` | `3142992` | #3 | **OPEN** |
| `agent/polish-market-ux-709062ecc4de` | `f0bb7ff` | #5 | **OPEN** |
| `feat/market-slider` | `d4454c6` | — | 本地分支，基于 `f0bb7ff`，**未推送** |

## 分叉关系

- `main` 的 `b7d8f29`（「甄选目录跟随 GitHub 版本自动更新」）不在任何已发布构建中，也未推送。
- 两个工单分支的基点都是 `915dd66`，**都不含 `b7d8f29`**；两者彼此也分叉。
- `feat/market-slider` 基于 `f0bb7ff`，所以当前宿主构建 = PR #5 的改动 + 滑块重构，仍**不含** `b7d8f29`，也**不含** PR #3。

## 工单

- `709062ecc4de`「插件市场 UX 交互优化：点击态、甄选布局、排序项调整」— `open / person / review`。
- 旧工单 `48895bce6b69`（筛选耦合修复）已不在工单列表；其改动仍以 PR #3 形式未合并。

## 本地检出与 worktree

| 路径 | 角色 |
| --- | --- |
| `<repo>`（本工作区） | 主检出，当前停在 `feat/market-slider` @ `d4454c6`（`main` 仍在 `b7d8f29`） |
| `~/src/dsh-plugin-galaxy` | 基底克隆（superagent 的 worktree 来源） |
| `~/src/fix-tab-filter-coupling-48895bce6b69` | PR #3 的工单 worktree |
| `~/src/polish-market-ux-709062ecc4de` | PR #5 的工单 worktree |

## 发布产物

| 文件 | 内部版本 | 说明 |
| --- | --- | --- |
| `dsh-plugin-galaxy-0.1.37-issue4.tgz` | `0.1.37` | 11-19 首次构建 |
| `dsh-plugin-galaxy-0.1.37-issue4r2.tgz` | `0.1.37` | 同日返工 |
| `dsh-plugin-galaxy-0.1.37-issue4r3.tgz` | `0.1.37` | 同日返工，已被 `0.1.38` 取代 |
| `dsh-plugin-galaxy-0.1.38.tgz` | `0.1.38` | 11-21 等分格滑块版，已被 0.1.39 取代 |
| `dsh-plugin-galaxy-0.1.39.tgz` | `0.1.39` | 11-21 滑块自适应 + 居中 |
| `dsh-plugin-galaxy-0.1.40.tgz` | `0.1.40` | 11-21 修复轨道被挤压/横向滚动条 |
| `dsh-plugin-galaxy-0.1.41.tgz` | `0.1.41` | 11-21 窄容器下拉组不折行，当前宿主所用 |

三个 `0.1.37` 文件的 `r2`/`r3` 后缀表示同一需求的连续返工，不代表版本推进；版本推进发生在 `0.1.38` 与 `0.1.39`（后者因同版本无法替换已安装包而必须提升）。
