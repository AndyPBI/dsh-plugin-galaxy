# 开发与发版门禁

> README 只保留安装与使用；开发命令、门禁与截图工具链放在这里，便于维护者查阅。

## 命令

```bash
npm run typecheck        # 服务端 + 客户端两套 tsconfig
npm run build            # tsc → lib/，tsdown → client/client.js
npm test                 # vitest
npm run smoke:client     # 按 __ModuleLoader__ 契约求值客户端 bundle 并渲染每个界面
npm run verify:dist      # 打包产物体检（入口/exports/patch/lib 引用/externals/files）
npm run check:desensitization   # 合规扫描（发布物与仓库面无内部标识/凭据/本机路径）
npm run check:host-surface      # 逐条核对宿主契约（slot/primitive/图标/令牌/peer/宿主补丁）
npm run check:host-settings     # 真实宿主 settings 服务下的设置接线
npm run check:layout            # 真 Chrome 布局探针（并给出"修复前"对照）
npm run screenshots             # 重新生成 README 截图（真宿主组件 + 真 client bundle），并复测工具栏几何
npm run release                 # 以上全部 + npm pack
```

## 约定

- **CI 跑的就是 `npm run release` 的每一步**（[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)），本地与 CI 不会漂移。
- 每条断言"为什么不是空过的"写在对应脚本/测试的顶部注释里；改门禁前先读那段注释。
- 改完 `src/` 要**先 `npm run build` 再跑依赖构建产物的脚本**（`check:host-surface`、`check:site-catalog`、`npm run screenshots`
  用的都是 `lib/` 与 `client/client.js`，曾因此验证到旧代码）。
- 宿主契约相关的坑（图标改名、设置卡片座位、打包应用 profile 解析、宿主补丁）见 `docs/host-compatibility.md` 与 `docs/host-patches.md`。
