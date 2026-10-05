# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 先看哪里

- [DEVELOPMENT.md](DEVELOPMENT.md)：本地怎么跑、**改完代码跑哪个验证脚本**（「改完跑什么」那张表）、常见问题
- [README.md](README.md)：一张卡怎么叠、分层流水线和边缘精修的设计取舍、`.layers` 格式、对外接口
- [deploy/README.md](deploy/README.md)：线上、staging、数据库、权重。各源码目录的 README 写着每个文件管什么

## 常用命令

```bash
pnpm dev            # 前端 http://localhost:5273（strictPort，端口被占直接报错退出）
pnpm dev:server     # 分层服务 8791；本地目录默认值在 server/dev.env（模型 .models/，产物和库 out/）
pnpm typecheck      # tsc --noEmit，覆盖 src、server、scripts/og-preview.ts 和各 vite 配置
pnpm build          # 提交前跑：先核对生成的珠光动画没被手改，再 typecheck + 构建
```

没有单元测试框架，也没有 lint / 格式化配置。验证靠 `scripts/verify-*.mjs`，每个都能单独跑（如 `node scripts/verify-gyro.mjs`），文件开头写着核对什么、要先起什么。

- **改完代码**：先 `pnpm typecheck`，再按 DEVELOPMENT.md「改完跑什么」跑对应的脚本，跑了什么、结果如何写进 PR 的「验证」。加了验证脚本或改了开发流程，同时更新那张表
- 本地常常已经开着 `pnpm dev` / `pnpm dev:server`：起服务前先看端口（`lsof -nP -iTCP:5273 -sTCP:LISTEN`），能复用就复用，别关不是自己起的进程
- `verify-api`、`verify-perf` 往库里写测试数据，`verify-live` 打的是线上，都别对着线上跑

## 架构

一个仓库两半，共用 `src/` 里的代码：

- **前端**（`index.html` + `src/demo/`）就是线上站点。三种路由：`/` 首页卡带；`/c/<id>` 分享的卡（这台设备第一次打开先出卡包）；`/render/<id>` 无头渲染模式，页头藏起来，给服务端截图用
- **分层服务**（`server/`，`vite.server.config.ts` 打成 `dist-server/`）是一个 Node 进程：线上同时发前端静态文件；`/api` 管任务队列、层文件、分享、作者配置；`/v1` 是白名单 key 的对外接口；卡片存在 `node:sqlite`
- **分层流水线**（`src/segmenter/`）两边都能跑。线上在服务端的工作线程里跑（`server/segment-worker.ts`，注入 sharp 做图片编解码，另外用 BiRefNet 抠主体）；只有部署里根本没有后端（`/api/jobs` 回 404/405，开发时 Vite 代理回 502）时，浏览器才自己跑，判断在 `src/demo/api.ts`
- **渲染器**（`src/renderer/`）只吃一个 LayerSet（`src/format/` 定义的 `.layers`：manifest + 每层 webp），不依赖分层算法。每层的 alpha 同时是这一层箔面的遮罩；画面和箔面包在同一个带 transform 的容器里，`color-dodge` 只和本层混合。箔面配方 `foils.css` 移植自 pokemon-cards-css（GPL-3.0）

一张卡的路：上传 → `POST /api/jobs` → 轮询 `/api/jobs/<id>` → 读 `/api/layers/<id>/` 下的 manifest 和各层 → 卡带先放卡包，开包后交给渲染器。
删除口令只在创建时给一次、存在浏览器里；分享、删卡、存作者配置（`PUT /api/cards/<id>/config`）都靠它鉴权。
分享图和导出动图是服务端用 Playwright 打开自己的 `/render/<id>` 截的（`server/preview.ts`、`server/export.ts`），本地 `pnpm dev:server` 不发前端页面所以截不了，调这些用 `pnpm og`。

## 多语言

`src/i18n/messages.ts` 里中文是源头，英文、日文的类型由它推出来，少一个键、多一个键 typecheck 都过不去，加文案三份一起加。
`index.html` 里的静态文字用 `data-i18n` / `data-i18n-html` / `data-i18n-title` / `data-i18n-aria` 标记：线上服务端发页面时按语言替换（`src/i18n/core.ts` 的 `localizeHtml`），前端切语言时原地重写。随状态变的文字走 `src/demo/main.ts` 的 `setText` / `clearText`，切语言时自动重写。

## 约定

- 注释、文档、提交信息、PR 说明都用中文；注释写「为什么」，照仓库里现有的密度写
- 界面文案只放操作和状态，不放原理解释（首页按这个删过一轮说明文字）；调试信息和读数照常显示
- 提交信息一行写清改了什么、为什么，按评审改的以「按 #<PR> 评审修：」开头。PR 说明分节，最后一节「验证」列实际跑过的检查和结果
- 分支叫 `feat/…`、`fix/…`、`docs/…`。合进 main 就自动上线；PR 每次推送自动部署到 staging（https://holocard.staging.longsizhuo.com ）。用 merge commit 合并，合完不删分支
- tsconfig 开了 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`；import 不带扩展名
- `src/demo/pearl-drift.css` 由 `scripts/pearl-keyframes.mjs` 生成，别手改
