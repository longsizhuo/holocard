# 开发

在本机把 HoloCard 跑起来、改完代码跑哪个验证脚本、常见的坑。
项目介绍和算法见 [README.md](README.md)，部署、服务器和数据库见 [deploy/README.md](deploy/README.md)。

## 第一次

- Node 22.15 以上：服务端用 `node:sqlite`，几个验证脚本直接跑 `.ts`
- pnpm 10：`corepack enable` 之后会按 `package.json` 里写的版本自动装

```bash
pnpm install
```

提示 `Ignored build scripts: onnxruntime-node, protobufjs` 不用管，onnxruntime-node 各平台的 CPU 版已经在包里了。

分层服务要深度模型的权重（27MB），放在 `.models/`（不进仓库）：

```bash
D=.models/onnx-community/depth-anything-v2-small
mkdir -p $D/onnx
B=https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main
curl -sL $B/config.json -o $D/config.json
curl -sL $B/preprocessor_config.json -o $D/preprocessor_config.json
curl -sL $B/onnx/model_quantized.onnx -o $D/onnx/model_quantized.onnx
```

另外两份权重可以不下：抠主体的 BiRefNet_lite（214MB，抠一张峰值约 7GB 内存，不放就只按深度切层），
裸露识别的 NudeNet（12MB，不放就跳过识别，但跑 `verify-api` 要它）。要下的话命令在 [deploy/README.md](deploy/README.md)「图片格式与权重」，
把里面的 `/srv/holocard-models` 换成 `.models`。

## 每天

开两个终端：

```bash
pnpm dev
```

```bash
pnpm dev:server
```

- 前端在 http://localhost:5273 ，改了自动热更新，`/api` 代理到 8791 的分层服务
- `pnpm dev:server` 先打包再启动，改了 `server/` 下的代码要重启它。模型读 `.models/`，产物和数据库写在 `out/`（见 [server/dev.env](server/dev.env)）
- 不起分层服务也能用：前端退回浏览器里分层，第一次要下约 50MB 模型
- 本地做过的卡都在 `out/` 下，想清空就删掉它
- 分享图、导出动图在本地用 `pnpm og` 调（见 README「调分享图」）。`pnpm dev:server` 不发前端页面，日志里的 `[preview] 渲染失败` 是正常的

## 改完跑什么

先 `pnpm typecheck`，提交前 `pnpm build`（顺带核对珠光动画的生成文件有没有被手改）。
再按改了哪里跑对应的验证脚本，每个脚本开头都写着它核对什么：

| 改了 | 跑 | 要先起 |
|---|---|---|
| 卡带、卡包、面板状态栏、上传区（`deck.ts`、`pack.ts`、`main.ts`、相关样式） | `node scripts/verify-pack.mjs` | `pnpm dev` |
| 卡包动效，想逐帧看 | `node scripts/film-pack.mjs`（拼胶片要 ImageMagick，没有就只留单帧） | `pnpm dev` |
| 珠光底（`style.css` 里的渐变、`scripts/pearl-keyframes.mjs` 的配置） | `node scripts/pearl-keyframes.mjs` 重新生成，再 `node scripts/verify-pearl.mjs` | `pnpm dev` |
| 什么时候退回浏览器端分层（`src/demo/api.ts`） | `pnpm build && node scripts/verify-fallback.mjs` | 不用，脚本自己起假服务 |
| 陀螺仪（`src/renderer/gyro.ts`） | `node scripts/verify-gyro.mjs` | 不用 |
| 作者配置的校验（`src/format/config.ts`） | `node scripts/verify-config.mjs` | 不用 |
| 性能埋点（`src/demo/perf.ts`、`server/perf.ts`） | `node scripts/verify-perf.mjs` | `pnpm dev` 和 `pnpm dev:server` |
| 对外接口 `/v1` | `HOLOCARD_DB=out/data/holocard.db HOLOCARD_OUT_DIR=out/layers node scripts/verify-api.mjs http://127.0.0.1:8791`（要先下 NudeNet：接口的卡过了裸露识别才交付，没有模型直接失败） | `pnpm dev:server` |
| 开包音效（`src/demo/sfx.ts`） | `node scripts/render-sfx.mjs`，听 `/tmp/sfx/reel.wav` | `pnpm dev` |
| 分享图、导出动图的样子 | `pnpm og`（参数见 README「调分享图」） | 不用 |

- 用浏览器的脚本在 macOS 上默认借用本机 Chrome、Windows 上借用 Edge，不用设什么；要换就设 `HOLOCARD_BROWSER_CHANNEL`
- `film-pack`、`render-sfx`、`verify-perf` 只认 Playwright 自带的浏览器，第一次用之前装一次：`pnpm exec playwright-core install chromium`（`verify-pearl --browser webkit` 要装 `webkit`）
- `verify-pack`、`film-pack` 在浏览器里拦下所有 `/api`，不碰后端；`verify-api`、`verify-perf` 会往本地库里写测试数据，别对着线上跑

## 其他脚本

- `pnpm capture --image 照片 --out out/demo.gif`：录演示 GIF。要本机有 Edge 和 ffmpeg，开着 `pnpm dev`
- `node scripts/probe-matte.mjs --image 照片`：复现 BiRefNet 在浏览器里跑不起来的那几条路（README「BiRefNet：服务端抠主体」）。要 Edge，开着 `pnpm dev`
- `node scripts/verify-live.mjs --image 照片`：对线上走一遍上传和分层，看新访客第一次用的开销。要 Edge
- `HOLOCARD_DB=out/data/holocard.db node scripts/db.mjs`：查本地的卡片库。线上怎么查见 deploy/README.md
- `scripts/apikey.mjs`、`scripts/takedown.mjs`、`scripts/deploy.sh`：线上运维，见 deploy/README.md
- `scripts/blind/`：抠图模型的双盲对比，见 [scripts/blind/README.md](scripts/blind/README.md)

## 常见问题

- **`Port 5273 is already in use`**：端口是固定的，被占不会自动换。`lsof -nP -iTCP:5273 -sTCP:LISTEN` 找到占着的进程关掉；8791 同理
- **分层服务一启动就退出，报 `mkdir '/srv/...'`**：跑的是 `pnpm start:server` 或者直接跑了 `dist-server/holocard-server.mjs`，那是线上用的，目录默认在 `/srv`。本地用 `pnpm dev:server`
- **脚本连不上 5273**：地址写 `localhost`，别写 `127.0.0.1`。macOS 上 Vite 只监听 IPv6 的 localhost
