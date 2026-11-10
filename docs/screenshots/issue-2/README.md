# 修复前后对照（Issue #2：状态筛选与分类筛选）

两张图并排：左=修改前（baseline `915dd66`），右=修改后（本 PR）。同一套合成目录、同一视口
（1044 × 900，2x）、同一浅色主题；合成目录只含演示数据，不含任何真实 profile。

| 文件 | 场景 | 修改前 | 修改后 |
|---|---|---|---|
| `combo.png` | 状态「推荐」+ 分类「甄选」 | 状态行里混着「甄选」chip；空状态只说"该分类下没有可显示的条目" | 状态行只剩互斥状态；空状态说明这是 **AND 组合**、列出两个条件，并给出「切到「全部」查看该分类」「清除分类筛选」出口 |
| `picked.png` | 只选分类「甄选」（状态「全部」） | 甄选是状态行里的 chip，看起来像第六种状态 | 甄选快捷 chip 位于分类控件区；出现「已选筛选条件」条（分类：甄选 × / 清除全部）；排序标注「当前结果内」 |
| `installed.png` | 状态「已安装」+ 分类「甄选」 | 分类被「已安装」分支忽略：仍显示 3 个已安装插件（错误） | 分类在已安装集合内生效：组合为空并解释"目录外插件没有分类信息" |

## 生成方式

1. baseline：`git worktree add --detach /tmp/galaxy-before 915dd66`，`npm run build:client`；
2. 修改后：本分支 `npm run build:client`；
3. 用仓库自带的 `scripts/screenshots.mjs` 同款 harness（真宿主 primitives + 真 client bundle）驱动到对应状态截图；
   合成目录带 `categories` 与 `ranking`（window=3），以保证「推荐」与「甄选」的组合可复现；
4. 用 ImageMagick 并排拼接并加标注。

想自己复现时，可临时复制 `scripts/screenshots.mjs`，把 `captureFixtures()` 的 fallback 目录换成上面的合成数据，
并在页面启动脚本里依次点击状态 chip、`selectOption` 分类即可；仓库只保留结果图，不保留一次性脚本。
