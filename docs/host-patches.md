# 宿主补丁清单（升级后必须重新应用）

> 本文件记录**打在 DeepSeek Harness checkout 里**、而不在任何插件里的补丁。
> 这类补丁最危险：它们不在插件的发布物里，**一次宿主升级就会静默丢掉**，
> 而症状看起来像"插件坏了"。每次升级宿主后，请对照本清单逐条确认。

自动核对：`npm run check:host-surface` 会把下面每一条都当成 FAIL 报出来（含修复指引），
并已用一个"缺补丁的假宿主"验证过失败路径（退出码 1）。

---

## P1 · 侧栏 footer 多个插件条目必须垂直排列

**症状**：左侧状态栏里，多个插件的条目挤在**同一行**——需要整栏宽度的插件
（如 `dsh-workvista` 的工作台，`width:100%`）被压成窄条，与兄弟按钮（如 `dsh-knowledge` 的按钮）争夺空间，
看上去"布局乱了/重叠"。**这是宿主侧布局，不是插件侧 bug。**

**补丁**：`packages/client/ui-sidebar/src/client/SidebarRoot.module.css`

```diff
 .footerActions {
   display: flex;
+  flex-direction: column;
+  gap: 4px;
 }
```

折叠（rail）模式下同一 `column` 方向也让图标保持垂直居中，与 rail 既有的竖向语言一致。

**历史**（同一处修过两次，所以记在这里）：

| 时间 | 宿主版本 | 提交 | 结果 |
|---|---|---|---|
| 2026-09-11 | `0.1.5-alpha.1` | `e7b5e49f99`（分支 `fix/sidebar-footer-actions-vertical`） | 修好；`ui-sidebar` 测试 241/241 |
| 2026-09-14 | 升级到 `0.1.5-rc.2` | —— | **补丁丢失**（rc.2 的 `.footerActions` 回到 `display:flex`），症状复现 |
| 2026-09-14 | `0.1.5-rc.2` | `f8c70eaa96`（分支 `upgrade/rc2`） | 重新应用；`packages/client/ui-sidebar/tests` 40/40；重建后产物 `packages/client/ui-sidebar/lib/client.js` 内含 `flex-direction:column;gap:4px` |

> 上游在 rc.2 大改过 `packages/client/ui-sidebar`（14 文件 / +596 −63），但**没有**处理这一处，
> 因此升级后仍需本机补丁。若将来上游修了，`check:host-surface` 会继续 PASS，可以删掉本条。

**应用步骤**（在 harness checkout 里）：

```bash
cd ~/Documents/AI/deepseek-harness
# 在 .footerActions 规则里补 flex-direction: column; gap: 4px;
pnpm vitest run packages/client/ui-sidebar/tests    # 期望全绿
pnpm run build                                      # 重建客户端产物
# 然后完整重启宿主
```

**核对**：`npm run check:host-surface` 输出
`PASS  host patch: sidebar footer actions stack vertically — column with gap`

---

## 与本插件的关系

Plugin Galaxy **自己不占侧栏座位**（`sidebar.footer.action`）——这是按需求刻意移除的，
所以它的入口不在侧栏，而在 **设置对话框左侧的 “Plugin Galaxy”**。
本清单里的补丁影响的是**其它插件**（workvista / knowledge / memory 等）在侧栏的排布，
但侧栏乱到看不清时，会连带让人无法确认插件是否都已加载，所以它同样是本项目的部署前置条件。

---

## 升级记录

| 日期 | 宿主版本 | P1（侧栏 footer 竖排） | 备注 |
|---|---|---|---|
| 2026-10-10 | 0.2.1-alpha.1（tag `dsh-v0.2.1-alpha.1`，分支 `upgrade/0.2.1-alpha.1`） | **仍需**，已在切换后重打并随 `pnpm run build` 生效 | 新代 `.footerActions` 依旧只有 `display: flex`，未上游化；`check:host-surface` 实测 `column with gap` PASS |
