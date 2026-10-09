# 架构与模块

HoloCard 的一个仓库包含四个产物：线上站点的前端、分层服务、npm 包 `@holocard/player` 和本文档站。它们共用 `src/` 中的格式定义、分层流水线与渲染器。

## 仓库结构

```text
holocard/
├── index.html            前端页面（三种路由共用）
├── src/
│   ├── format/           .layers 格式：类型、读写与校验、作者配置
│   ├── segmenter/        分层流水线（服务端与浏览器端共用）
│   ├── renderer/         闪卡渲染器
│   ├── demo/             站点前端（holocard.longsizhuo.com）
│   ├── player/           <holo-card> 自定义元素，npm 包的入口
│   ├── i18n/             界面文字与语言判定（前后端共用）
│   └── lab/              双盲对比页
├── server/               分层服务（Node 单进程）
├── packages/player/      npm 包 @holocard/player 的发布目录
├── scripts/              验证脚本与运维脚本，见「本地开发」
├── lab/blind/            双盲对比页的 HTML
├── docs-site/            本文档站（VitePress）
├── deploy/               线上与 staging 的部署配置
├── public/               静态资源（示例卡 public/samples/demo、图标、分享图）
└── vite*.config.ts       各产物的构建配置
```

| 构建配置 | 命令 | 输出 |
|---|---|---|
| `vite.config.ts` | `pnpm dev` / `pnpm build` | `dist/`（站点前端），开发端口 5273 |
| `vite.server.config.ts` | `pnpm build:server` / `pnpm dev:server` | `dist-server/` |
| `vite.player.config.ts` | `pnpm build:player` | `packages/player/dist/holocard.js` |
| `vite.og.config.ts` | `pnpm og` | `.og-cache/bin/og-preview.mjs` |
| `vite.lab.config.ts` | 由 `scripts/blind/pack.mjs` 调用 | `dist-lab/blind/` |
| `docs-site/.vitepress/config.ts` | `pnpm build` / `pnpm docs:dev` | `dist/docs/` |

## 模块

### `src/format`

`.layers` 格式是分层算法与渲染器之间的中间表示：任何能产出 `LayerSet` 的程序都可以交给渲染器，渲染器也可以单独使用。格式说明见[文件格式](/format/)。

| 文件 | 职责 |
|---|---|
| `types.ts` | `LayerManifest`、`LayerSet` 等类型；格式版本 `LAYERS_FORMAT_VERSION`；箔面类型 `FOIL_TYPES`；默认箔面 `defaultFoilFor` 与默认炫光 `defaultHalo` |
| `io.ts` | 读取与校验 manifest（`parseManifest`、`loadLayerSet`），校验失败抛 `LayerFormatError`；层文件名只允许 manifest 同目录下的文件 |
| `config.ts` | 作者配置（箔面、炫光、视差）的校验与合并。前端与服务端共用，`PUT /api/cards/<id>/config` 只接受这几个字段 |

### `src/segmenter`

分层流水线：照片 → 深度估计 → 切层 →（服务端）抠主体 → 边缘精修 → 补全 → `LayerSet`。线上运行在服务端的工作线程中；只有部署中没有分层服务时，浏览器才运行它。算法与设计取舍见[分层流水线与边缘精修](/develop/pipeline)。

| 文件 | 职责 |
|---|---|
| `index.ts` | 总流程 `segmentToLayerSet`；视差系数与默认箔面的分配；写入 manifest 的 `generator` |
| `depth.ts` | Depth Anything V2-Small 深度估计 |
| `slice.ts` | 在深度直方图谷底找切点、核对切点的可见边界与遮挡台阶（刚性边界）；有主体时重定切点（`fitCutsToSubject`） |
| `extract.ts` | 按切点生成每层的 alpha 与颜色：深度边缘吸附、逐层补全、镜像纹理填充、软边去背景色 |
| `refine.ts` | 引导滤波边缘精修；服务端参数 `SERVER_REFINE_OPTIONS` |
| `morph.ts` | 形态学工具：深度边缘吸附、膨胀、最近源像素传播、alpha 抗锯齿、碎块清理 |
| `matte.ts` | BiRefNet_lite 抠主体，仅服务端使用 |
| `runtime.ts` | 权重来源（Hugging Face、`VITE_MODEL_HOST` 镜像或本站 `/models/`）、设备选择（WebGPU / WASM / CPU）、推理线程数 |
| `image-io.ts` | 图片解码 / 编码后端抽象。浏览器用 OffscreenCanvas，服务端注入 sharp 实现（`server/pipeline/images.ts`） |

### `src/renderer`

渲染器接收一个 `LayerSet`，生成可交互的闪卡，不依赖框架，也不依赖分层算法。详见[渲染器](/develop/renderer)。

| 文件 | 职责 |
|---|---|
| `card.ts` | `HoloCard` 类：DOM 结构、视差、弹簧驱动的交互、整卡炫光的角度模型、陀螺仪接管、`setPose` / `preview` |
| `card.css` | 结构样式、逐层箔面遮罩、整卡炫光与高光（遮罩随所在视差组平移、放大）、「减少动态效果」 |
| `foils.css` | 箔面配方，移植自 pokemon-cards-css（GPL-3.0） |
| `highlight.ts` | 高光保护：按画面亮度给箔面、炫光、高光的遮罩打折 |
| `spring.ts` | 弹簧积分，语义与 svelte/motion 一致 |
| `gyro.ts` | 设备倾斜 → 指针位置，基准姿态自动回正 |
| `textures.ts` | 箔面用的颗粒与闪粉纹理，运行时用固定种子程序化生成 |

### `src/demo`

站点前端，即 holocard.longsizhuo.com。

| 文件 | 职责 |
|---|---|
| `main.ts` | 页面入口：上传、分层、调参面板、分享、删除、导出、语言切换，以及三种路由的初始化 |
| `route.ts` | 路由解析与分享链接 |
| `api.ts` | 分层服务的客户端：提交与轮询、删除口令记录、分享、作者配置、账号与 key 接口。判断何时回退到浏览器端流水线 |
| `deck.ts` | 首页卡带：本次访问的卡左右切换，上传时先放卡包，开包后换成新卡 |
| `pack.ts` / `pack-gl.ts` / `pack-art.ts` | 卡包。`pack.ts` 是共用接口与外壳；`pack-gl.ts` 是 WebGL 三维铝箔袋；`pack-art.ts` 是无 WebGL 时的平面版图案 |
| `albums-ui.ts` | 「我的卡册」：本设备做过的卡（登录后加上账号名下的卡），原生 `<dialog>`，打开即为网格 |
| `account-ui.ts` | 个人中心：登录账号、退出、卡册入口，以及对外接口 key 的申请、用量与吊销 |
| `export.ts` | 导出动图：按设备选择 GIF / 动态照片 / APNG，提交并等待服务端生成 |
| `sfx.ts` | 开包音效，用 Web Audio 实时合成，开关保存在本机 |
| `track.ts` | umami 埋点，未配置 `VITE_UMAMI_ID` 时不加载任何脚本 |
| `perf.ts` | 性能埋点：页面静置后测量 10 秒帧率，发送到 `POST /api/perf` |
| `style.css` / `pearl-drift.css` | 珠光主题；`pearl-drift.css` 由 `scripts/pearl-keyframes.mjs` 生成，不得手改 |
| `ih-logo.svg` | involutionhell.com 的标志，印在卡包正面与卡背 |

### `src/player`

`index.ts` 定义 `<holo-card>` 自定义元素：读取 `src` 指向的 `.layers` 目录或 `manifest.json`，用 `src/renderer` 渲染。`card.css` 与 `foils.css` 以 `?inline` 字符串装入 Shadow DOM，与宿主页面互不影响。用法见[播放器](/player/)。

### `src/i18n`

| 文件 | 职责 |
|---|---|
| `messages.ts` | 中文、英文、日文界面文字。中文为源头，另外两份的类型由其推导，键缺失或多余时类型检查失败 |
| `core.ts` | 前后端共用：语言判定（`?lang=` → cookie `hc_lang` → `Accept-Language` → 中文）、`translate`、`localizeHtml` |
| `index.ts` | 前端：当前语言、`t()`、切换语言时原地替换页面文字 |

`index.html` 中的静态文字用 `data-i18n`、`data-i18n-html`、`data-i18n-title`、`data-i18n-aria` 标记。服务端发送页面时按语言替换，前端切换语言时原地重写，不刷新页面。

### `src/cardmask`

卡面遮罩（试验中，尚未接入站点）：从已经做好的平面卡图中分出边框与文字、主角、特效三张箔面遮罩。`frame.ts` 找卡面上的画框，不依赖模型：先找贯穿大半个卡宽的长直边，再在候选矩形中按「边的支持率」与「像插画的小块占比」选出画框。评测见[本地开发](/develop/)中的 `cardmask-eval`。

### `src/lab`

`blind.ts` 是双盲对比页的脚本，与 `lab/blind/index.html` 一起由 `scripts/blind/pack.mjs` 构建。用法见[本地开发](/develop/#双盲对比-scripts-blind)。

### `server`

分层服务是一个 Node 进程，同时发送前端静态文件并提供 `/api`、`/auth`、`/v1`。构建产物为 `dist-server/` 下的 `holocard-server.mjs`（入口）、`segment-worker.mjs`（分层工作线程）和 `chunks/`（共用代码），整个目录一起部署。

| 文件 | 职责 |
|---|---|
| `index.ts` | 入口：按路径分发请求、健康检查 `/api/health`、性能埋点 `POST /api/perf`、定时清理、启动（续跑中断的任务、补分享图与裸露识别） |
| `config.ts` | 环境变量与由其推导的配置（端口、目录、额度、保留期、登录、抠图模型），各模块从这里读取 |
| `http.ts` | JSON 与错误响应、读请求体、来源 IP、请求语言、限流、同源判断、HTML 转义 |
| `umami.ts` | 对外接口的活动由服务端发送到 umami |
| `routes/cards.ts` | 网页的卡片接口：上传、任务状态、分享、导出、作者配置、删除、层文件与缩略图、`/models/` 权重 |
| `routes/static.ts` | 前端静态文件：按语言发页面、首页与分享页的 OG 标签、`robots.txt`、`sitemap.xml` |
| `routes/account.ts` | `/auth/*` 登录与退出，`/api/me/*` 当前账号、认领与个人中心的 API key |
| `routes/v1.ts` | 对外接口 `/v1` |
| `pipeline/jobs.ts` | 分层任务：收上传（`acceptUpload`）、队列、调度工作线程、裸露识别、缩略图、启动时续跑 |
| `pipeline/segment-worker.ts` | 分层流水线的常驻工作线程 |
| `pipeline/images.ts` | sharp 图片编解码：原图规范化（摆正方向、去除 EXIF、HEIC 解码）、层图转 WebP、卡册缩略图 |
| `pipeline/moderation.ts` | NudeNet 裸露识别 |
| `pipeline/eta.ts` | 剩余时间估计：按阶段的耗时指数平均 |
| `render/preview.ts` | 用无头 Chromium 打开 `/render/<id>` 截分享图，浏览器常驻复用 |
| `render/previews.ts` | 分享图的渲染队列与失败重试 |
| `render/export.ts` / `render/motionphoto.ts` | 导出动图（GIF、APNG、安卓动态照片） |
| `render/exports.ts` | 导出的排队与状态 |
| `store/db.ts` | 卡片数据库（`node:sqlite`）：卡片、会话、API key、管理员、性能埋点；`store/index.ts` 打开库 |
| `store/cards.ts` | 保留策略（`keepMs`、`expiresAt`）、访问计数、过期清理、旧格式迁移 |
| `store/perf.ts` | 性能埋点的校验与表结构 |
| `account/auth.ts` | involutionhell（IH）账号登录：授权码 + PKCE、会话与 state cookie |
| `account/session.ts` | 请求属于哪个账号、是否为卡片主人 |
| `account/apikeys.ts` | 对外接口 key 的生成、哈希与从请求头读取 |
| `dev.env` | `pnpm dev:server` 的本地目录默认值 |

### `packages/player`

npm 包 `@holocard/player` 的发布目录：`package.json`、`README.md`、示例页 `demo/index.html`，构建产物 `dist/holocard.js` 不进仓库。推送 `player-v<版本>` 标签时，`.github/workflows/publish-player.yml` 核对标签与 `package.json` 的版本一致后发布到 npm。自检脚本为 `scripts/verify-player.mjs`。

### `docs-site`

本文档站。中文页面在 `docs-site/<栏目>/`，英文在 `docs-site/en/`，日文在 `docs-site/ja/`。`pnpm build` 将其构建到 `dist/docs`，由分层服务作为静态文件在 `/docs/` 下发送。

### `deploy`

线上（`deploy/production/`）与 staging（`deploy/staging/`）的安装脚本、systemd 单元与发版脚本。见[自托管部署](/deploy/)。

## 前后端协作

### 页面路由

三种路由共用同一个 `index.html`（`src/demo/route.ts`）：

| 路径 | 模式 | 说明 |
|---|---|---|
| `/` | `demo` | 首页卡带，可上传、调参 |
| `/c/<id>` | `card` | 分享的卡片。本设备首次打开时先显示卡包（记录在 `localStorage` 的 `holocard:seen`） |
| `/render/<id>` | `render` | 无界面的渲染页，固定姿态，供服务端截分享图与导出动图；不加载埋点 |

服务端发送页面时按请求语言替换静态文字，并为 `/c/<id>` 注入该卡片的 OG / Twitter 标签。

### 提交与轮询

一张卡的处理流程：

1. 前端 `POST /api/jobs`，请求体为图片字节。服务端读取并规范化原图、检查磁盘余量后写库入队，返回 `202 {id, position, deleteToken}`。
2. 前端每秒轮询 `GET /api/jobs/<id>`，响应包含 `state`（`queued` / `running` / `done` / `error`）、`stage`、`position`、`eta`，完成时包含 `layers`（层文件目录）与 `layerCount`。
3. 前端读取 `/api/layers/<id>/manifest.json` 与各层图片，卡带先显示卡包，开包后交给渲染器。

提交与轮询分开，是因为处理需要数十秒，长连接容易被中间的反向代理与 CDN 断开。

相关规则：

- **限流与排队**：网页提交按 IP 限流（默认 10 分钟 10 次，`rate_limited`）；网页任务排队上限默认 12（`queue_full`，503）。对外接口的任务排在网页任务之后，另有上限。
- **提交重试**：网络断开或 5xx 时按 1、3、6 秒重试三次；`queue_full`、`disk_full` 不重试，避免重复上传整张照片。
- **轮询容错**：轮询连续失败 60 秒才报错；排队期间不计入 5 分钟的总超时。
- **回退到浏览器端**：只有部署中根本没有分层服务时才回退，判据是 `POST /api/jobs` 返回 404 / 405，或开发模式下 Vite 代理返回 502。服务端临时不可用时只报错，不回退，因为回退需要下载深度模型。浏览器端流水线不抠主体。
- **剩余时间**：`eta` 由 `server/pipeline/eta.ts` 按阶段计算，各阶段耗时取本机最近几张图的指数平均，排队时再加上前面的任务。

### 分层工作线程

onnxruntime-node 的推理同步运行在调用线程上，切层与补全是纯 JS 计算。放在主线程会使整个服务在处理期间无法响应，因此流水线运行在 `server/pipeline/segment-worker.ts` 的工作线程中，主线程只负责收发请求。

- 工作线程常驻一个，启动时预加载模型；分层一次只处理一张图（`HOLOCARD_CONCURRENCY` 调大也不会并行）。
- 是否抠主体（`MATTE_READY`）取决于两个条件：模型目录中有抠图权重，且进程内存上限（systemd `MemoryMax`）不低于 8 GB 或未设上限。抠图模型可用 `HOLOCARD_MATTE_MODEL`、`HOLOCARD_MATTE_SIZE`、`HOLOCARD_MATTE_DTYPE` 更换。
- 推理线程数按进程分到的 CPU 配额（cgroup `cpu.max`）设置。
- 服务启动时仍处于 `running` 的卡片视为上次处理中崩溃，续跑时不抠主体。
- 工作线程未报告就绪即退出时，`/api/health` 返回 503，发版脚本据此拦截。
- 工作线程输出 PNG，主线程转为 WebP（画面有损、alpha 无损）后写盘，再写 `manifest.json`。随后生成卡册缩略图 `thumb.jpg`（最长边 480），并做裸露识别（网页上传只记录分数，不拦截）。

### 卡片存储与保留

`server/store/db.ts` 中每张卡一行，是卡片状态的唯一来源。状态有 `queued`、`running`、`done`、`error`、`deleted`（上传者删除，文件真删）、`expired`（过期清理）、`removed`（站长下架，文件移入 `.removed/<id>`，可恢复）。

保留期由 `server/store/cards.ts` 计算：

| 卡片 | 保留期 |
|---|---|
| 未分享 | 自创建起 `HOLOCARD_TTL_MS`（默认 7 天） |
| 已分享 | 自最后一次访问起计算，访问量每翻一番多留一档（7 天 × 2ⁿ），最多 5 档，即 112 天 |
| 归入账号的卡 | 不过期 |
| 对外接口的卡 | 提交后 24 小时 |

### 卡片主人与鉴权

卡片主人的判定（`owns`）有两种方式：

- **删除口令**：未登录时提交，服务端在 `POST /api/jobs` 的响应中返回一次 `deleteToken`，前端保存在本机。之后通过请求头 `X-HoloCard-Token` 携带。口令不放在 `GET /api/jobs/<id>` 中，因为卡片 id 在分享后是公开的。
- **会话**：登录状态下提交的卡直接归入账号，不发口令；请求须带有效会话，且 `Sec-Fetch-Site` 为 `same-origin`，以排除同站的兄弟子域借用访客会话。

需要主人身份的操作：

| 请求 | 作用 |
|---|---|
| `POST /api/cards/<id>/share` | 分享：卡片转为长期保留，公开卡片页，按分享人的语言排队渲染分享图 |
| `PUT /api/cards/<id>/config` | 保存作者配置（箔面、炫光、视差），经 `src/format/config.ts` 校验后合并进磁盘上的 manifest |
| `DELETE /api/cards/<id>` | 删除卡片及全部文件 |

### 分享图与导出动图

两者都由服务端用 Playwright 打开自己的 `/render/<id>` 页面截取，画面与用户看到的是同一套渲染。

- **分享图**（`server/render/preview.ts`）：1200×630，每种语言一张（`preview.jpg`、`preview-en.jpg`、`preview-ja.jpg`）。渲染队列一次一张，失败重试；卡片页被打开时发现缺图会补做，服务启动时也会补齐。
- **导出动图**（`server/render/export.ts`）：`POST /api/cards/<id>/export/<gif|motion|apng>` 提交，`GET` 同一地址查询状态。前端按设备选择格式：iPhone / iPad 为 GIF，安卓为动态照片（JPEG 末尾接 MP4），电脑为 APNG。导出按 IP 限流，生成的文件放在卡片目录中，随卡片一起过期或删除。

本地 `pnpm dev:server` 不发送前端页面，因此无法截图；调试这两项使用 `pnpm og`。

### 登录与会话

登录是可选功能，配置了 IH 的 client secret（`HOLOCARD_SSO_SECRET`）或开启假登录时启用。

| 路径 | 作用 |
|---|---|
| `GET /auth/login` | 生成 state 与 PKCE verifier，跳转到 IH 授权页 |
| `GET /auth/callback` | 校验 state，用授权码、client secret 与 PKCE verifier 向 IH 后端换取用户信息，建立会话 |
| `POST /auth/logout` | 注销会话 |
| `GET /api/me` | 是否启用登录、当前账号、账号名下仍有效的卡 |
| `POST /api/me/claim` | 凭口令把本设备上的卡认领到账号下，认领后原口令作废 |
| `GET` / `POST /api/me/keys`、`DELETE /api/me/keys/<id>` | 个人中心的对外接口 key：查看用量、申请（每个账号最多 10 个，共用额度）、吊销 |

- 会话 cookie `__Host-hc_session` 与 state cookie `__Host-hc_state` 使用 `__Host-` 前缀，防止兄弟子域覆盖。会话有效期 30 天，库中只存会话口令的 SHA-256。
- HoloCard 只获取账号的 id、名字与头像，不接触 IH 的登录状态。
- 假登录（`HOLOCARD_AUTH_FAKE=1`）直接登入测试账号，供本地开发使用；staging 地址未配置密钥时自动开启；正式地址下开启时服务拒绝启动。

### 对外接口

`/v1` 由 `server/routes/v1.ts` 处理，与网页共用上传处理（`acceptUpload`）和分层队列，区别如下：

- 以 `Authorization: Bearer hc_…` 鉴权，key 的哈希存在 `api_keys` 表。
- 卡片私有：只对提交它的 key 可见，在 `/api/jobs`、`/api/layers`、分享、导出、作者配置、`/c/<id>` 上视同不存在。
- 交付前做裸露识别，分数达到阈值时以 `nsfw_rejected` 拒绝；识别不可用时以 `moderation_unavailable` 拒绝。
- 排队时网页任务优先。

接口用法、配额与错误码见 [API](/api/)。

### 埋点

| 来源 | 去向 | 内容 |
|---|---|---|
| `src/demo/track.ts` | 自建 umami | 页面访问与事件：`upload`、`segment-ok`、`segment-fail`、`pack-open`、`parallax`、`share`、`share-copy`、`delete`、`export`、`export-share`、`export-fail`、`lang`、`login`、`card-view`、`claim`、`api-key`、`api-key-revoke` |
| `server/umami.ts` | 同一 umami 站点 | 对外接口的活动：`api-submit`、`api-reject`、`api-fetch`、`api-done`、`api-fail`。访客标识按账号或 key 编号 |
| `src/demo/perf.ts` | 本服务 `POST /api/perf` | 静置时 10 秒的帧率分布，一次访问最多一条，不带 id，服务端不存 IP |

umami 站点 id 在构建时从 `VITE_UMAMI_ID` 注入，未配置时前后端都不发送；本机与内网地址也不发送。`/render/<id>` 不加载埋点脚本。
