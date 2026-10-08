# 本地开发

本页说明如何在本机运行 HoloCard、修改代码后运行哪个验证脚本，以及常见问题。代码结构见[架构与模块](/develop/architecture)，线上部署见[自托管部署](/deploy/)。

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 22.18 及以上 | 服务端使用 `node:sqlite`；`verify-gyro`、`verify-config` 直接导入 `.ts` 源码，依赖 Node 默认开启的类型剥离（22.18 起） |
| pnpm | 10 | 执行 `corepack enable` 后按 `package.json` 的 `packageManager` 字段自动安装 |
| ffmpeg | 任意 | 仅 `pnpm capture` 需要 |
| ImageMagick | 任意 | 仅 `film-pack.mjs` 拼接胶片需要；缺失时只输出单帧 |

项目没有单元测试框架，也没有 lint / 格式化配置。正确性由 `scripts/verify-*.mjs` 验证，每个脚本可单独运行，文件头注释写明核对内容与前置条件。

## 首次安装

```bash
pnpm install
```

安装时提示 `Ignored build scripts: onnxruntime-node, protobufjs` 可以忽略：onnxruntime-node 各平台的 CPU 版本已包含在包内。

### 模型权重

分层服务从 `.models/` 读取权重（该目录不进仓库）。

| 权重 | 大小 | 是否必需 | 缺失时的行为 |
|---|---|---|---|
| Depth Anything V2-Small（`onnx-community/depth-anything-v2-small`） | 27 MB | 必需 | 分层服务无法处理图片 |
| BiRefNet_lite（`onnx-community/BiRefNet_lite-ONNX`） | 214 MB | 可选 | 不抠主体，只按深度切层。抠一张图峰值内存约 7 GB |
| NudeNet 320n | 12 MB | 可选 | 跳过裸露识别；`/v1` 的卡片会以 `moderation_unavailable` 失败，因此运行 `verify-api` 时必需 |

下载深度模型：

```bash
D=.models/onnx-community/depth-anything-v2-small
mkdir -p $D/onnx
B=https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main
curl -sL $B/config.json -o $D/config.json
curl -sL $B/preprocessor_config.json -o $D/preprocessor_config.json
curl -sL $B/onnx/model_quantized.onnx -o $D/onnx/model_quantized.onnx
```

另外两份权重的下载命令见[自托管部署](/deploy/)，将其中的 `/srv/holocard-models` 替换为 `.models`。

## 日常开发

在两个终端分别运行：

```bash
pnpm dev          # 前端，http://localhost:5273
```

```bash
pnpm dev:server   # 分层服务，监听 8791
```

- 前端支持热更新，`/api` 由 Vite 代理到 `HOLOCARD_API`（默认 `http://127.0.0.1:8791`）。端口固定为 5273（`strictPort`），被占用时直接报错退出。
- `pnpm dev:server` 先构建再启动，修改 `server/` 下的代码后需重启。它通过 `node --env-file=server/dev.env` 读取本地目录配置，环境变量中已设置的值优先。
- 未启动分层服务时，Vite 代理返回 502，前端回退到浏览器端分层，首次需下载深度模型（WebGPU 下 fp16 约 50 MB，WASM 下 q8 约 25 MB）。
- 本地生成的卡片与数据库都在 `out/` 下，删除该目录即清空。
- `pnpm dev:server` 不发送前端页面（`HOLOCARD_WEB_DIR` 为空），因此日志中的 `[preview] 渲染失败` 属正常现象。分享图与导出动图用 `pnpm og` 在本地调试。

`server/dev.env` 的内容：

| 变量 | 值 | 用途 |
|---|---|---|
| `HOLOCARD_MODEL_DIR` | `.models` | 模型权重目录 |
| `HOLOCARD_OUT_DIR` | `out/layers` | 卡片产物目录 |
| `HOLOCARD_DB` | `out/data/holocard.db` | SQLite 数据库 |

### `package.json` 脚本

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 启动前端开发服务器（Vite，端口 5273） |
| `pnpm dev:server` | 构建并启动本地分层服务（端口 8791，目录取 `server/dev.env`） |
| `pnpm typecheck` | `tsc --noEmit`，覆盖 `src/`、`server/`、`scripts/og-preview.ts` 与各 Vite 配置 |
| `pnpm build` | 先运行 `pearl-keyframes.mjs --check` 核对生成文件，再类型检查、构建前端（`dist/`）和文档站（`dist/docs`） |
| `pnpm preview` | 预览 `dist/` 构建结果 |
| `pnpm build:server` | 类型检查并构建服务端到 `dist-server/` |
| `pnpm start:server` | 运行 `dist-server/holocard-server.mjs`，目录默认在 `/srv`，供线上使用 |
| `pnpm build:player` | 构建 npm 包 `@holocard/player` 到 `packages/player/dist` |
| `pnpm og` | 预览分享图与导出动图，见下文「分享图与导出动图」 |
| `pnpm capture` | 录制演示 GIF，见[其他脚本](#其他脚本) |
| `pnpm docs:dev` | 本地预览文档站（VitePress） |

### 分享图与导出动图

`pnpm og` 用与线上相同的渲染路径出图：前端由 Vite 现场构建，截图直接调用服务端的 `renderPreview`。分层结果按图片内容哈希缓存在 `.og-cache/`，调整样式时不会重复推理。需要 `.models/` 下的权重。

```bash
pnpm og                    # 用 scripts/fixtures/og-test.jpg 出图，写到 out/og-preview.jpg 并打开
pnpm og 图片路径            # 换一张图
pnpm og --watch            # 监视 src/，保存后自动重出
pnpm og --pose 78,22       # 指定姿态（指针在卡面上的百分比位置）
pnpm og --size 1280x640    # 指定尺寸（GitHub 社交预览图为 1280×640）
pnpm og --lang en          # 右侧文字使用英文（en / ja）
pnpm og --out 路径 --png --no-open
pnpm og --export gif       # 导出动图：gif / motion / apng，写到 out/export/
```

## 改完代码运行哪个验证脚本

先运行 `pnpm typecheck`，提交前运行 `pnpm build`。再按修改范围运行对应脚本：

| 修改范围 | 命令 | 前置条件 |
|---|---|---|
| 卡带、卡包、面板状态栏、上传区（`deck.ts`、`pack.ts`、`main.ts` 及相关样式） | `node scripts/verify-pack.mjs [--url …] [--out /tmp/verify-pack]` | `HOLOCARD_API=http://127.0.0.1:9 pnpm dev`（脚本在浏览器内拦截全部 `/api`，后端指向不存在的地址可防止误连） |
| 开包动效（逐帧检查 `pack-gl.ts`、`deck.ts`） | `node scripts/film-pack.mjs [--url …] [--out /tmp/film-pack]` | 同上；拼接胶片需 ImageMagick |
| 珠光底（`style.css` 的渐变、`pearl-keyframes.mjs` 的配置） | `node scripts/pearl-keyframes.mjs` 重新生成 `src/demo/pearl-drift.css`，再 `node scripts/verify-pearl.mjs [--browser chromium\|webkit]` | `pnpm dev` |
| 回退到浏览器端分层的判断（`src/demo/api.ts`） | `pnpm build && node scripts/verify-fallback.mjs` | 无，脚本自带模拟服务端 |
| 陀螺仪（`src/renderer/gyro.ts`） | `node scripts/verify-gyro.mjs` | 无 |
| 作者配置的校验（`src/format/config.ts`） | `node scripts/verify-config.mjs` | 无 |
| 性能埋点（`src/demo/perf.ts`、`server/perf.ts`） | `node scripts/verify-perf.mjs [--url …] [--browser chromium\|webkit\|firefox]` | `pnpm dev` 与 `pnpm dev:server` |
| 对外接口 `/v1`（`server/index.ts` 的 `handleV1`、`server/apikeys.ts`） | `HOLOCARD_DB=out/data/holocard.db HOLOCARD_OUT_DIR=out/layers node scripts/verify-api.mjs http://127.0.0.1:8791` | `pnpm dev:server`，且 `.models/` 下有 NudeNet 权重 |
| 登录、卡片归属与认领、个人中心的 API key（`server/auth.ts` 及相关路由） | `pnpm build:server && HOLOCARD_MODEL_DIR=.models node scripts/verify-auth.mjs` | 深度模型权重。脚本自行启动模拟 IH 与临时服务端，不需要开发服务 |
| 页头与个人中心界面（`account-ui.ts`） | `pnpm build && pnpm build:server && node scripts/verify-account.mjs` | 无。脚本以假登录启动临时服务端 |
| 播放器 `<holo-card>`（`src/player/`、`packages/player/`） | `pnpm build:player && node scripts/verify-player.mjs [截图目录]` | Chromium，见下方说明 |
| 开包音效（`src/demo/sfx.ts`） | `node scripts/render-sfx.mjs`，试听 `/tmp/sfx/reel.wav` | `pnpm dev` |
| 分享图、导出动图的画面 | `pnpm og` | 无 |

各脚本的核对内容：

- `verify-pack`：上传 → WebGL 卡包 → 切换卡带 → 撕开 / 点开 → 新卡亮相的完整流程；分享卡首次打开出卡包；卡册直接显示网格（未开启登录时页头按钮直接打开卡册）；状态栏文字；上传区的读屏名称与键盘操作。关键步骤截图到 `--out`。
- `verify-pearl`：将当前写法（每秒 12 次、Chromium 下加 `will-change`）与逐帧平滑写法冻结在同一时刻逐像素比较，超过阈值则失败。WebKit 需单独运行一次。
- `verify-fallback`：模拟服务端返回 404（无后端，回退）、502 / 断开（重试 3 次后报错，不下载模型）、503 排队满（直接报错，不重传）。
- `verify-gyro`：转动后指针偏移、静止数秒后回正、持续慢转不累积偏移、越过竖直位置的读数跳变、横屏轴对调。
- `verify-config`：合法配置原样合并、其余字段不变；层数不符、未知箔面类型、数值越界、试图修改文件名等一律拒收或忽略。
- `verify-perf`：页面静置后上报一条埋点、服务端收到；畸形数据被拒。
- `verify-api`：鉴权、私有性（接口卡在 `/api`、分享、导出、删除路由上视同不存在）、交付与缓存头、配额、吊销、处理途中删除、网页任务优先、畸形请求行与超限请求的处理。每张卡实际分层，耗时 30–60 秒。
- `verify-account`：页头「文档」链接随界面语言切换；未登录时个人中心的登录入口与本机卡册；登录后申请多个 key、新 key 只显示一次、吊销其中一个。
- `verify-auth`：登录流程（state cookie、换码、PKCE、一次性授权码、`next` 只认本站路径）；登录状态下的卡片归属；凭口令认领；其他账号无权操作；退出后会话失效；账号名下的卡不过期；个人中心 API key 的申请（每个账号最多 10 个）、吊销、按账号合计的额度与管理员不限额度；正式地址下开启假登录时拒绝启动。
- `verify-player`：目录地址与 `manifest.json` 地址两种写法均可加载并触发 `load`；地址错误时触发 `error`；宿主页面 CSS 无法影响卡片内部、组件不向宿主注入样式；指针划过时卡片转动。设置 `PLAYER_URL=https://cdn.jsdelivr.net/npm/@holocard/player@<版本>/dist/holocard.js` 可核对已发布到 CDN 的版本。
- `render-sfx`：将每个音效离线渲染为 wav，并检查非静音、峰值小于 1。

### 浏览器与数据安全

- `verify-pack`、`verify-pearl`、`verify-fallback` 在 macOS 上默认使用本机 Chrome，在 Windows 上使用 Edge，其他系统使用 Playwright 自带的 Chromium；可通过 `HOLOCARD_BROWSER_CHANNEL`（`chrome` / `msedge`，留空则使用自带版本）更换。
- `film-pack`、`render-sfx`、`verify-perf` 只使用 Playwright 自带的浏览器，首次使用前执行 `pnpm exec playwright-core install chromium`；`verify-pearl --browser webkit` 需安装 `webkit`，`verify-perf --browser firefox` 需安装 `firefox`。
- `verify-player` 通过 `CHROMIUM_PATH` 指定浏览器可执行文件；未设置时使用脚本内写死的路径，在其他机器上需显式设置。
- `verify-pack`、`film-pack` 在浏览器内拦截全部 `/api` 请求，不访问后端。`verify-api`、`verify-perf` 会向目标服务的数据库写入测试数据，不得对线上运行。

## 其他脚本

| 脚本 | 用途 | 前置条件 |
|---|---|---|
| `pnpm capture --image 照片 [--out out/demo.gif]` | 录制演示 GIF。用渲染器的 `setPose` 逐帧摆姿态，结果确定可复现。`--dump` 另外导出每一层 PNG，`--no-gif` 跳过录制 | 本机 Edge、ffmpeg，`pnpm dev` |
| `node scripts/probe-matte.mjs --image 照片 [--out out/matte.png]` | 在浏览器中单独运行抠图模型并保存 alpha，用于复现 BiRefNet 在浏览器中无法运行的问题 | 本机 Edge，`pnpm dev` |
| `node scripts/verify-live.mjs --image 照片 [--url …]` | 线上冒烟测试：以全新浏览器配置走一遍上传与分层，记录跨源隔离状态、下载的大文件与层数 | 本机 Edge |
| `HOLOCARD_DB=out/data/holocard.db node scripts/db.mjs [id \| SQL \| perf [天数] \| nsfw [阈值]]` | 以只读方式查询卡片库：最近卡片与状态计数、单张卡、任意只读 SQL、性能埋点汇总、疑似裸露的卡 | 无 |
| `node scripts/apikey.mjs create <名字> [每天上限] \| list \| revoke <id> \| admin <账号> \| unadmin <账号>` | 发放、列出、吊销对外接口的 key，设置不受额度限制的管理员账号。key 只在 `create` 时打印一次，库中只存 SHA-256 | 数据库取 `HOLOCARD_DB` |
| `node scripts/takedown.mjs [restore] <卡片 id>` | 站长下架 / 恢复卡片。软删除：文件移入产物目录下的 `.removed/<id>`，状态改为 `removed` | 取 `HOLOCARD_OUT_DIR`、`HOLOCARD_DB` |
| `node scripts/webp-layers.mjs [--apply \| --cleanup]` | 将早期 PNG 层图的卡片转为 WebP。无参数时只列出；`--apply` 写入 WebP 并原子替换 manifest；`--cleanup` 删除 manifest 不再引用的 PNG | 取 `HOLOCARD_OUT_DIR` |
| `bash scripts/deploy.sh` | 手动发版，见[自托管部署](/deploy/) | SSH 访问服务器 |

`apikey.mjs`、`takedown.mjs`、`webp-layers.mjs`、`db.mjs` 的默认路径指向线上目录（`/srv/...`），本地使用时需通过环境变量指定 `out/` 下的路径。

### 双盲对比（`scripts/blind/`）

用于比较两种服务端配置（例如两种抠图模型）的输出：同一批原图用两种配置各出一张卡，评审在对比页上逐对选择，事后按答案还原各配置的胜负。对比页源码为 `lab/blind/index.html` 与 `src/lab/blind.ts`，使用与站点相同的渲染器，A、B 两张卡姿态同步。

```bash
# 1. 两种配置各运行一遍（须先后运行：抠图峰值约 7 GB，同时运行会耗尽内存）
pnpm build && pnpm build:server
node scripts/blind/run-variant.mjs --in 原图目录 --out /tmp/exp/lite --port 8781
HOLOCARD_MATTE_MODEL=onnx-community/BiRefNet_512x512-ONNX HOLOCARD_MATTE_SIZE=512 HOLOCARD_MATTE_DTYPE=q8 \
  node scripts/blind/run-variant.mjs --in 原图目录 --out /tmp/exp/512 --port 8782

# 2. 打包：只挑两版主体差异大的对，另混入 6 对几乎相同的作为核对组
node scripts/blind/pack.mjs --variant lite=/tmp/exp/lite --variant 512=/tmp/exp/512 --out /tmp/exp/pack \
  --min-iou 0.95 --calibration 6 --focus "重点看主体边缘：白边、残影、被切掉的部分"

# 3. 将 /tmp/exp/pack/page 交给评审，取回页面底部「复制结果」的结果串

# 4. 解码
node scripts/blind/score.mjs /tmp/exp/pack/key.json "1A 2= 3B 4X ..." --candidate 512
```

| 脚本 | 作用 |
|---|---|
| `run-variant.mjs` | 以最低优先级（`nice 19`）启动临时分层服务，逐张提交，输出 `layers/`、`ids.tsv`（原图名 → 卡片 id）与 `timing.json`。待比较的配置通过环境变量传入，服务端支持的变量见 `server/index.ts`（抠图模型为 `HOLOCARD_MATTE_*`） |
| `pack.mjs` | 配对、按 `--min-iou` 筛选、随机分配 A/B，生成对比页 `page/` 与答案 `key.json`。页面数据中去除了 manifest 的 `generator`（含模型名） |
| `score.mjs` | 结果串中 `A` / `B` 表示该侧更好，`=` 表示相近，`X` 表示两侧都有问题，`A!` / `B!` 表示对面有明显缺陷。分别统计偏好与缺陷率，核对组单独计算 |

注意事项：

- 原图与实验目录通常包含用户照片，应放在仓库之外（`/tmp` 等），评审结束后删除，不得提交。
- `key.json` 不得随对比页一起发出，否则失去双盲性。

## 常见问题

### `Port 5273 is already in use`

端口固定，被占用时不会自动更换。用 `lsof -nP -iTCP:5273 -sTCP:LISTEN` 找到占用进程后关闭；8791 同理。

### 分层服务启动后立即退出，报 `mkdir '/srv/...'`

运行的是 `pnpm start:server` 或直接运行了 `dist-server/holocard-server.mjs`，其目录默认在 `/srv`，供线上使用。本地请使用 `pnpm dev:server`。

### 脚本连接不上 5273

地址使用 `localhost`，不要使用 `127.0.0.1`。macOS 上 Vite 只监听 IPv6 的 localhost。

### `verify-gyro` / `verify-config` 报 `ERR_UNKNOWN_FILE_EXTENSION`

Node 版本低于 22.18，未默认开启类型剥离。升级 Node，或在 22.15–22.17 上加 `--experimental-strip-types` 运行。
