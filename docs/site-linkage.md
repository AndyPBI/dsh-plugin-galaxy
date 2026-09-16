# 与官网（yhaigc.cn）的插件页关联

> 目标：**插件星系里的每个插件都链到官网自己的插件页**，并且两边用**同一个身份键**，不靠名字猜。

相关项目：官网仓库（与本仓库并列 checkout，默认路径由 `DSHG_SITE_URL` 指向的部署地址决定，
部署在 `www.yhaigc.cn`，插件页是 hash 路由 `#/ai`）。服务器与部署细节在该仓库自己的内部文档里。

## 一、身份键（关联的全部基础）

```
key = owner/name        ← 例如 FuRongJun-1999/dsh-memory
```

- 官网的目录由 `scripts/build-plugin-catalog.mjs:259` 生成 `key = owner/name`；galaxy 在
  `src/domain/site.ts:siteKeyOf()` 用**同一条规则**从同一份数据的同一字段推导；若目录行自带 `key` 则**优先用它**。
- **为什么不用 name**：目录里有重名（我生成的 OPC 目录 290 行只有 279 个唯一 name；上游 3632 行有 152 组重名），
  按名字做链接会静默打开**另一个**插件。
- monorepo 子包的 key 自带 `#`（`owner/repo#packages/pkg`），所以链接方必须百分号编码
  （`%23`），官网侧 `pluginKeyFromHash()` 负责解回来——两边都有测试钉住。

## 二、链接形状

```
https://www.yhaigc.cn/#/ai/p/<encodeURIComponent(key)>
例：https://www.yhaigc.cn/#/ai/p/FuRongJun-1999%2Fdsh-memory
```

## 三、三种激活方式（任选，第三种最适合部署）

| 方式 | 配置 | 效果 |
|---|---|---|
| A. 进程环境变量指定站点 | `DSHG_SITE_URL=https://www.yhaigc.cn` | 目录里**所有**能推出 key 的插件都链到官网 |
| B. 进程环境变量指向自托管目录 | `DSHG_REGISTRY_URL=https://www.yhaigc.cn/assets/plugins/catalog.json` | 星系展示的**就是官网收录的那批插件**，链接基址取自该 URL 的 origin |
| C. **profile 级配置**（推荐给部署） | `<profile>/.dsh-galaxy/state.json` 里的 `catalogUrl` / `siteUrl` | 配置**跟着 profile 走**：把 profile 复制到服务器，数据源与站点随之生效，不依赖谁在什么 shell 里启动进程 |

**优先级**（读时决定）：`DSHG_REGISTRY_URL` → profile 的 `catalogUrl` → 内置公共目录；
站点基址：`DSHG_SITE_URL` → profile 的 `siteUrl` → **目录 URL 的 origin**（自带，无需额外配置）。
运维用环境变量可以覆盖 profile，二者不冲突。

写法（也可由脚本调用插件的 `setCatalogUrl()/setSiteUrl()` 原子写入）：

```jsonc
// ~/.dsh/profiles/<profile>/.dsh-galaxy/state.json
{
  "catalogUrl": "https://www.yhaigc.cn/assets/plugins/catalog.json"
  // 可选："siteUrl": "https://www.yhaigc.cn"
}
```

> B 的安全性：从目录 origin 推导出的基址**只对带 `key` 字段的行生效**（那是官网目录的标志）。
> 所以指向上游公共目录（无 `key`）时**不会**凭空生成指向别人站点的链接——两个方向都有测试。

## 四、官网侧（`PBISimulation-Frontend`）的改动

| 文件 | 改动 |
|---|---|
| `src/hooks/useHashRoute.ts` | 新增 `pluginKeyFromHash`（解码 `%23`、容忍 `?query`、坏转义不抛）、`setPluginHash`、`usePluginKey`；原有 `parseHash`/`useHashRoute` API 不变 |
| `src/components/plugins/PluginAiPage.tsx` | 识别 `#/ai/p/<key>` → 打开该插件详情；点卡片时把地址栏写成深度链（可分享）；关闭回到 `#/ai`；**只在 catalog 加载成功且未失败**时才判定"未收录"（部署故障不能被说成"没这个插件"） |
| `src/i18n/{zh,en}.json` | `ai.deepLinkMissing` / `ai.deepLinkBack` |
| 新增测试 | `src/__tests__/hooks/pluginDeepLink.test.ts`（6）+ `src/__tests__/components/PluginAiPage.deepLink.test.tsx`（5） |

## 四之二、目录里的推荐块（与「未安装」视图的契约）

官网侧 `catalog:ranking` 会往 `catalog.json` 补两类东西（干跑可加 `--dry-run`）：

```jsonc
// 每行
{ "score": 90.44, "band": "S", "scoreVersion": "opc-ranking/1",
  "scoreParts": { "popularity": 17.3, "keywords": 10, ... },
  "pinReason": "生态里独一份的能力" }        // 仅编辑推荐条目
// 顶层
{ "ranking": { "version": "opc-ranking/1", "window": 20, "top": ["owner/name", ...], "pins": [{"key","reason"}] } }
```

`top` 是**有序**名次（当前 60 条），`window` 是一次显示多少（20）。星系据此渲染「推荐」：先跳过已安装，
再取前 `window` 条 —— 所以装掉一个会补上下一个。目录不带 `ranking` 时星系退回完整列表（对上游公共目录安全）。
公式与权重、人工复核清单都在 `PBISimulation-Frontend/docs/plugin-ranking.md`。

### 两侧各自的"名次"（2026-09 对齐，别把两个数字混起来）

官网在排名上做了一次微调，两边的分工因此固定下来：

| 表面 | 显示什么 | 依据 |
|---|---|---|
| 官网卡片徽章 / 详情弹窗 | 徽章 `推荐 S · 90`（分数取整）；弹窗里的「推荐排名」= **按推荐分降序的全站名次**（缺分时退回上游「分类排名」） | `PluginBandBadge.tsx`、`PluginAiPage.tsx` 的 `scoreRankByKey`、`PluginDetailModal.tsx` |
| 星系面板「推荐」（原「未安装」入口） | **窗口名次**：`ranking.top` 前 `window` 条跳过已安装，卡片上印 **`#1`、`#2`、`#3`…**（名次=列表顺序），另加徽章与悬停说明 | `MarketSection.tsx` 的推荐榜分支（`row.rank`） |
| 星系面板「全部 / 已安装」 | 排序只有 名称 / Star 数 / npm 下载量 / 发布时间 —— **没有"推荐分"这一项** | `SORTS`（`推荐` 是视图，不是排序） |

两个名次**故意不同**，而且不能互相冒充：官网弹窗的「推荐排名」是分数降序的全站名次；面板的 `#1…#20` 是
窗口顺序（掺了单类目上限与编辑推荐插位，53 分那条排第 18）。所以面板**不显示**官网弹窗那个分数名次，
官网也**不显示**窗口名次。能同时出现在两边的只有**徽章**（`推荐 S · 90`）和**悬停说明**（分项 + 编辑推荐理由），
这两样必须逐字一致（由 `check-site-catalog.mjs` 的 10.1 守着）。

`ranking.top` 的顺序就是面板的顺序，所以「推荐」视图里**排序下拉是隐藏的**：那个控件在该视图里不生效。

## 五、部署清单

```bash
# 官网侧
cd PBISimulation-Frontend
npm test                        # 496/496
npm run build                   # tsc && vite build
# 上传 dist/ + public/assets/plugins/{catalog.json,ranking.json}（catalog 必须在 dist 里同路径）

# galaxy 侧（先校验目录，再配置数据源）
cd dsh-Plugin-Galaxy
node scripts/check-site-catalog.mjs            # 默认读 ../PBISimulation-Frontend/public/.../catalog.json
node scripts/check-site-catalog.mjs --catalog https://www.yhaigc.cn/assets/plugins/catalog.json
#   线上那次会多跑「loader parity」（用星系真正的 loader 解析同一份产物）：key 解析、
#   ranking 顺序、score/band/scoreParts、pins 四项都要一致，否则网站认为正常而面板静默少几条
#   方式 C（推荐）：写进 profile 的 state.json（本机已写入 web profile）
#   {"catalogUrl": "https://www.yhaigc.cn/assets/plugins/catalog.json"}
#   方式 A/B：在宿主启动环境里设 DSHG_REGISTRY_URL 或 DSHG_SITE_URL
# 完整重启宿主
```

## 六、验收

1. `node scripts/check-site-catalog.mjs` → **PASS**（key 唯一、key 规则一致、分类可解析、计数自洽，
   推荐块 7.1–7.17 —— 含 `top` 每条可解析、pins 落在窗口内、`scoreParts` 求和等于 `score`、侧车与产物同序；
   8.1–8.6 —— 按面板规则重放后的窗口；URL 目标再加 9.1–9.6 loader parity），并打印 5 条可点开的深链样例。
2. 宿主重启后面板里随便挑一个插件 → 卡片上出现「官网插件页」→ 点开应**直接打开该插件详情**。
3. 打开一条**不存在**的 key（例：`https://www.yhaigc.cn/#/ai/p/nobody%2Fmissing`）→ 应显示「未收录这个插件」+「查看全部插件」，而不是空白。
4. 点「推荐」→ 恰好前 20 张卡片、每张左上角 `#1`…`#20` 与顺序一致、排序下拉消失（该视图顺序由 `ranking.top` 决定）；
   点「全部」→ 排序下拉回来，且其中**没有**"推荐分"这一项；切到无推荐块的目录（上游公共目录）→ 该入口标签退回「未安装」且不印名次。
