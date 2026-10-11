# 插件目录数据管线

> 从公开渠道发现 dsh 插件 → 下载 → 按 license 分类 → 生成官网目录与推荐榜。
> 入口命令：`npm run catalog:update`（编排器 `scripts/update-galaxy-catalog.mjs`）。
> 日常触发：对 Claude 说「**检查并更新galaxy插件**」（skill `check-update-galaxy`）。

本文件是这条管线的**唯一权威说明**。改动任一环节前先读这里。

---

## 1. 总览

```
[1] discover   上游聚合源 + GitHub 搜索          → catalog/source-plugins.json

[2] generate   分类打分 + 每分类上限 20          → opc-plugins.json
                                                    opc-plugins.csv（含 kept/dropped 标记）
                                                    opc-top20.md / opc-install.sh

[3] fetch      clone + 按「仓库级 license」分类   → MIT/  non-MIT/
                                                    MANIFEST.tsv / download_report.json
               ──────────  non-MIT 到此为止，永不进官网  ──────────

[4] build      (PBISimulation-Frontend) 仅取 MIT/ → public/assets/plugins/catalog.json

[5] translate  (前端) DeepSeek 增量翻译            → scripts/.cache/desc-zh.json

[6] rebuild    (前端) 再 build 一次，并入译文

[7] converge   (前端) 循环 translate+build，直到 descEn 覆盖不再提升（见 3.1c）

[8] rank       (前端) 打分并回写 score/band        → catalog.json + ranking.json

[9] gate       产物测试 + check:site-catalog

── 停 ──  部署需人工确认（编排器不做）
```

两个仓库分工：本仓库（`dsh-Plugin-Galaxy`）负责 1–3 与消费侧校验；`PBISimulation-Frontend` 负责 4–7 的产物生成。编排器在本仓库，通过 `PBI_FRONTEND_DIR` 调用前端。

---

## 2. 脚本

| 脚本 | 作用 | 网络 |
|---|---|---|
| `scripts/discover-dsh-plugins.mjs` | 抓上游聚合源 + GitHub 搜索，产出生成器输入 | 需要 |
| `scripts/build-opc-catalog.mjs` | 关键词分类、每类上限、产出四种报告 | 否（只读本地） |
| `scripts/fetch-opc-catalog.mjs` | 逐仓库 clone、判定 license、刷新排行榜插件的版本 | 需要（API + git + npm） |
| `scripts/update-galaxy-catalog.mjs` | 编排以上 + 前端四步 + 门禁 | 取决于参数 |

前端（`PBISimulation-Frontend/scripts/`）：`build-plugin-catalog.mjs`、`translate-catalog.mjs`、`build-plugin-ranking.mjs`。

---

## 3. 关键约定（改前必读）

### 3.1 每分类上限 27（总数≈400），被淘汰的**不再静默丢弃**

`build-opc-catalog.mjs` 的 `TOP_PER_CATEGORY = 27`（可用 `--top` 覆盖）。**27 × 15 类 ≈ 405**，这就是"总量约 400"的来源。

上限是**展示**上限不是数据上限：候选不足 27 的类别（如 `service` 22、`marketing` 16）**保留全部**，所以实测总数约 389，而不是 405。

`opc-plugins.json` 的 `plugins[]` 只含上限内的条目；被截断的写进 `opc-plugins.csv` 并标 `status=dropped`，**保留真实名次**（28、29…），另外每类的 `droppedCount` 记在 `categories[]`。

> `categories[].matched` 是**封顶前**的候选数（如 memory=293），与 `plugins[]` 的实际条数（≤27/类）是两个不同的数。

### 3.1b 排行榜插件跟版本：不刷新就会永远冻结

`fetch-opc-catalog.mjs` 对**已存在的克隆直接跳过**，所以一个 9 月克隆的仓库会永远报 9 月的版本。对排行榜上的插件这是硬伤——那正是访客最会点开的一批。

`--refresh-ranked <ranking.json>`（编排器自动传 `public/assets/plugins/ranking.json`）在克隆前做一次比对：取排行榜 top 60，用条目的 `npm` 查 registry 的 `dist-tags.latest`，与本地克隆 `package.json` 的 `version` 比较，**只有确实更新**才重新克隆。

三个容易踩的点：

- **"不相等"不等于"更新"**，用 `compareVersions()` 判大小。仓库里 package.json 常常带着未发布的开发版（本地 0.3.11 而 npm 还是 0.3.7），只判相等会让这些仓库每轮都被无谓重克隆，还会把降级报成升级。预发布同样要按 semver 排（`0.3.3-rc.1` 高于 `0.3.2`）。
- **版本号来自 `package.json`，但只用于判断**；真正决定产物 `version` 的是重新克隆后的新代码。
- 排行榜是**上一轮**的产物（fetch 在 rank 之前跑）——这正是想要的窗口：刷新访客此刻正在看的那个榜。60 条里约 51 条有 `npm`，其余（仅 GitHub 来源）无法比对，会被列在 `unchecked` 里。

### 3.1c 翻译要跑到收敛，固定轮数不够

生成器的 `descFull` 在同一次 `build → translate → build` 里**不稳定**：

```
descFull = cachedFull || fullKey       # 生成器
```

pass 2 一旦写入中文译文 `zhFull`，`descFull` 就从「原文」翻成「译文」。而 pass 3 的缓存键 `srcEn` 取的是它**读产物时**的 `descFull`（即翻之前的原文），生成器却拿 `cached.srcEn === descFull` 校验 → 不等 → 该条 `descEn` 被丢弃，英文界面退回中文。

**只影响 pass 2 在同一轮改写过文本的条目**——也就是中文来源的新插件第一次进目录时。

实测：补一轮把覆盖从 94.4% 提到 99.3%，仍留 2 条（pass 2 又翻了一次）。所以 `converge` 步骤**循环** `translate → build`，每轮比对 `descEn` 计数，不再提升即停，硬上限 3 轮（防止缓存抖动时空转）。实测第 1 轮 286 → 288，第 2 轮无提升退出。

> 遗留：翻译缓存**没有绑定提示词版本**。改了 prompt 之后，旧译文仍会命中，需要手工剔除受影响的缓存条目（`scripts/.cache/desc-zh.json` 按 `owner/name` 索引）。彻底做法是在缓存里存 prompt 版本号，不匹配即作废。

### 3.1d 甄选插件：人工维护，不走上游

`<OPC_CATALOG_DIR>/best-plugin/` 下放人工挑选的插件（目录名任意），清单写在
`best-plugin/sources.json`：**键 = 目录名，值 = GitHub 仓库地址**。

- **不在清单里的目录一律忽略** —— 所以「下架」就是把键删掉。
- 值与 `package.json` 的 `repository` 字段无关，是因为这些目录是**从 GitHub 下载的 ZIP**
  （没有 `.git`），其中几个根本没写 `repository`，无法自动推出地址。猜地址会让官网链到
  别人的项目，所以手写死。值可以是字符串，也可以是 `{ url, description }`——后者用于补
  `package.json` 里没写描述的插件。
- **协议仍逐条检查**，读本地 LICENSE 正文（上游那套「看 MIT/ 目录名」的口径在这里不存在）。
  判不准一律按非 MIT 处理，与上游方向一致。
- 分类 id 固定为 `curated`，中文名 **甄选** / 英文 **Featured**，在 `categories[]` 里**排第一位**。
- **不参与评分**（`build-plugin-ranking.mjs` 里过滤掉）：它们是人工挑选、恒定置顶的，
  打分再与普通插件混排只会让定位含糊。前端 `sortPlugins` 也把 `curated` 放在首要比较位，
  不受当前排序项影响。

`best-plugin/` 目录本身与 `opc-catalog/` 一样**不进仓库**；只有派生的 `catalog.json` 会发布。

### 3.2 license 判定看目录，不看 package.json

只发布 MIT。判定依据是 `fetch-opc-catalog.mjs` 把仓库归入 `MIT/` 还是 `non-MIT/`——**不是** `package.json` 的 `license` 字段，后者两个方向都不准：有的仓库没写 license 但确实是 MIT，有的 monorepo 子包自称 MIT 而仓库整体是 Apache-2.0/AGPL。

前端生成器用 `DEFAULT_LICENSE_DIRS = ['MIT']` 只取 `MIT/` 目录。

### 3.3 关联 opc-plugins.json 与 MANIFEST.tsv 必须用 `url`

两个文件的 `name` 列都有重名（290 行只有 279 个唯一值），按 name 关联会静默串条目。`url` 是唯一键。

### 3.4 `build → translate → build → rank` 顺序不可颠倒

`catalog:build` 从零重建，会抹掉 `score` / `band` / `scoreParts` / `ranking` 块，而 `ranking.json` 还停在上一版。**这种状态下官网页面一切正常**（徽章、排序、搜索都不读这些字段），只有星系面板静默退化——肉眼看不出来，靠 `plugin-catalog.test.ts` 的「推荐块」断言拦。

### 3.5 GitHub 搜索是补充，网络受限可关

`api.github.com` 在受限网络下不可达。`--no-github`（或 `DSHG_NO_GITHUB=1`）关闭该通道，**仅用聚合源也能完成整个流程**。

topic 查询**不可信**（`topic:dsh-plugin` 报 1.8 万仓库，混入 PicGo 等无关项目），只用作预筛；真正的门禁是仓库 `package.json` 必须声明 `dsh` 字段——这也正是宿主判断兼容性所读的字段，没有它插件装不上。被剔除的清单写在 `discovery-rejected.json`，带原因。

### 3.6 `--source` 只接受本地文件

`build-opc-catalog.mjs` 的 `--source` 是 `readFileSync`，传 URL 会失败。联网抓取是 `discover-dsh-plugins.mjs` 的职责。

---

## 4. 目录结构

```
dsh-Plugin-Galaxy/catalog/            ← 随仓库提交
  source-upstream.json    上游聚合源原样快照（审计用，别改）
  source-plugins.json     合并后 = 生成器输入
  discovery-rejected.json GitHub 搜索被剔除的候选 + 原因
  opc-plugins.json        目录（每类 ≤top）
  opc-plugins.csv         全部候选 + status(kept/dropped)
  opc-top20.md / opc-install.sh / opc-catalog.zip

<OPC_CATALOG_DIR>/                    ← 仓库外，约 2.1GB，不进 git
  opc-plugins.json  MANIFEST.tsv  download_report.json
  MIT/  non-MIT/        281 个 blobless clone（owner__repo 命名）
  .state/opc-state.json 上次的 kept/dropped 集合，用于变更摘要
```

`OPC_CATALOG_DIR` 未设置时回退到 `~/Documents/9.Project/项目开发/opc-catalog`（脚本用 `homedir()` 推导，不写死用户名）。

---

## 5. 环境变量

| 变量 | 作用 |
|---|---|
| `GITHUB_TOKEN` / `DSHG_GITHUB_TOKEN` | GitHub API 额度。**强烈建议设置**：未认证搜索仅 10 次/分钟，且 `fetch-opc-catalog` 判 license 时 282 个仓库要 ~5 小时 |
| `DSHG_NO_GITHUB=1` | 关闭 GitHub 搜索通道 |
| `DSHG_REGISTRY_URL` | 覆盖上游聚合源地址 |
| `OPC_CATALOG_DIR` | 指定 opc-catalog 目录 |
| `PBI_FRONTEND_DIR` | 指定前端仓库路径 |
| `DEEPSEEK_API_KEY` | 翻译。未设时脚本警告并 exit 0，管线不阻塞 |

---

## 6. 部署

编排器**不部署**。门禁通过后人工执行：

```bash
cd <PBI_FRONTEND_DIR> && npm run build
scp -i ~/.ssh/yhaigc.pem public/assets/plugins/{catalog.json,ranking.json} \
    root@120.53.4.246:/www/wwwroot/pbisimulation-frontend/dist/assets/plugins/
ssh -i ~/.ssh/yhaigc.pem root@120.53.4.246 \
  "chmod a+r /www/wwwroot/pbisimulation-frontend/dist/assets/plugins/*.json"
```

两个 JSON 是非 hash 文件且 nginx 对 `assets/**/*.json` 设了 `no-cache`，**只需传这两个文件**——整个 dist 有 214MB（视频/模型），不必重传。

> ⚠️ `deploy/deploy.sh` 写的是 `/var/www/PBISimulation-Frontend/dist`，那是**装机模板不是生产路径**，别照抄。
