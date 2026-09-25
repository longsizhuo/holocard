# 部署

线上地址：https://holocard.longsizhuo.com

```
浏览器 → Cloudflare → Caddy(:80) → holocard 服务 (127.0.0.1:8791)
                                      ├── /           前端静态文件 /srv/holocard-web/current
                                      ├── /api/jobs   提交与轮询
                                      └── /api/layers 产出的层文件
```

跑在一台 Oracle Ampere ARM64（4 核 / 23G 内存）。

源站 IP 不写在这里：站点是 Cloudflare 橙云代理的，源站地址本来就该藏着，
写进公开仓库等于任何人都能绕过 Cloudflare 直连——而这台机器上还跑着别的生产服务。
下面凡是要用到主机的地方，一律用 `~/.ssh/config` 里的别名 `oracle`。
那台机器同时跑着 involutionhell.com 的一整套服务和 Minecraft，所以分层服务有资源上限，见下。

**静态文件为什么也由 Node 发，而不是 Caddy 的 `file_server`**：那台机器的 Caddy 跑在 Docker 容器里，
给它加一个目录挂载要重建容器，会让同机所有站点瞬断。让服务自己发更安全，
副作用是它变得自包含——别人 clone 下来跑一个 Node 进程就是完整的站点，不需要任何反向代理。

## 日常发版

```bash
bash scripts/deploy.sh
```

构建前端与服务 → 从 HEAD 打源码包 → 上传到 `releases/<时间>-<commit>` → 原子切软链 → 重启服务并等健康检查通过。
工作区有未提交改动时会拒绝发版：源码包是从 HEAD 打的，不干净的话线上代码和提供下载的源码就对不上。

前端保留最近 5 个版本，回滚就是把软链指回去：

```bash
ssh oracle 'ls /srv/holocard-web/releases'
ssh oracle 'cd /srv/holocard-web && ln -sfn releases/<版本> current.new && mv -T current.new current'
```

服务端回滚需要重新发一次对应的 commit（`dist-server` 是覆盖式上传，不留历史）。

## 服务器上的布局

| 路径 | 内容 |
|---|---|
| `/opt/holocard/holocard-server.mjs` | 服务本体（单文件 ESM） |
| `/opt/holocard/node22/` | Node 22 运行时（系统自带的是 18，sharp 要求 ≥20.9） |
| `/opt/holocard/node_modules/` | transformers.js + onnxruntime-node + sharp，约 483MB |
| `/srv/holocard-models/` | Depth Anything V2-Small 权重（q8，27MB） |
| `/srv/holocard-web/` | 前端 releases + current 软链 |
| `/srv/holocard-layers/` | 每张卡一个目录：原图（去掉 EXIF）+ 层 PNG + manifest + 预览图 + 卡册缩略图 `thumb.jpg`（分层完成时做好；早期没存原图的卡在第一次有人要时用各层叠出来现做） |
| `/srv/holocard-data/holocard.db` | 卡片数据库（SQLite），每张卡的状态、原图地址、结果地址、保留期、删除口令 |
| `/opt/holocard/browsers/` | Playwright 的 arm64 Chromium，渲染 OG 预览图用，662MB |

## 资源限制

`/etc/systemd/system/holocard.service` 里：

```
MemoryMax=3G      # 推理峰值约 780MB，再加常驻 Chromium 约 400MB
CPUQuota=200%     # 4 核里最多占 2 核，留给 Minecraft 和数据库
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/holocard/browsers
```

渲染 OG 预览图的 Chromium 常驻复用，空闲 5 分钟自动关掉。导出动图也用它，一次开两个页面并行截帧。
那台 ARM 机器没有显卡，启动参数里必须带 `--disable-gpu --use-gl=swiftshader --in-process-gpu`，
否则 headless shell 截图直接报 `Unable to capture screenshot`。

服务侧：单并发（`HOLOCARD_CONCURRENCY=1`），队列上限 12，满了直接返回 503 而不是让人排十分钟。
上传上限 16MB，按魔数校验图片格式，拒绝解压炸弹。
按 IP 限流：10 分钟 10 次，取 `cf-connecting-ip`。

## 数据库

每张卡一行，是这张卡所有状态的唯一来源。用的是 Node 内置的 `node:sqlite`，没有任何原生依赖。

| 字段 | 说明 |
|---|---|
| `status` | `queued` → `running` → `done` / `error`；之后可能变成 `deleted`（上传者删的）或 `expired`（过期清理） |
| `stage` | 处理中所在阶段，前端轮询显示用 |
| `original_url` | 原图地址（经 CDN）。存之前摆正方向、**去掉全部 EXIF**——手机照片常带拍摄地 GPS，而这个地址是公开的 |
| `result_url` | 结果页 `/c/<id>`，也就是分享出去的地址 |
| `source_width/height` | 原图尺寸（摆正方向之后）。迁移来的老卡没有原图，这里是分层时的尺寸 |
| `shared` `hits` `last_hit_at` | 保留期怎么算，见下一节 |
| `delete_token` | 删除口令 |

`deleted` 和 `expired` 只删文件、不删行，留着做统计。

查库（服务器上没装 sqlite3 命令行，也不打算为此装系统包，用随服务一起发上去的脚本）：

```bash
ssh oracle 'cd /opt/holocard && node22/bin/node db.mjs'                 # 各状态计数 + 最近 20 张
ssh oracle 'cd /opt/holocard && node22/bin/node db.mjs <id>'            # 某一张的全部字段
ssh oracle "cd /opt/holocard && node22/bin/node db.mjs \"SELECT ...\""  # 任意 SQL
```

脚本以只读方式打开，服务在跑的时候查不会互相干扰（WAL 模式）。删除口令不会被打印。

**原图为什么要存**：算法会改。修「分尸」那次，存量卡没有原图，只能从层合成回近似原图再重跑，
既有损又麻烦。现在原图在，以后改进了可以直接重跑。失败的任务也留着原图（7 天后照常清掉），排查时最需要它。

**发版重启不丢排队中的任务**：原图在提交时就落盘了，队列里只放 id。服务重启时，
上次没处理完的（`queued` / `running`）会从磁盘上的原图接着跑。

**从旧格式迁移**：数据库之前每张卡目录里是一份 `meta.json`。服务启动时会把没进库的旧卡导进来，
删除口令原样保留（那些用户浏览器里存着它）。旧卡没有原图，`original_url` 为空。
回滚到数据库之前的版本需要注意：之后新建的卡没有 `meta.json`，旧代码会给它们生成新的删除口令，
这些卡的上传者就删不了了。

## 搜索引擎与 AI 抓取

目标是被搜到、被 AI 引用，同时**用户的照片不进任何索引**。

| | 做法 |
|---|---|
| `robots.txt` | 服务端按 `PUBLIC_ORIGIN` 现生成。允许所有爬虫（包括 AI 的），只挡 `/render/`（截分享图的内部页）、`/api/jobs`、`/api/cards` 和 `/models/`（27MB 的权重） |
| `sitemap.xml` | 同上，首页的中、英、日三个版本，每条都用 `xhtml:link` 列出全部语言版本；`lastmod` 取 index.html 的修改时间 |
| `llms.txt` | 给 AI 读的说明，静态文件 `public/llms.txt`，中英日三段，内容摘自 README |
| 首页 | 每种语言一个规范地址（`/`、`/?lang=en`、`/?lang=ja`）+ hreflang（`x-default` 指向不带参数、按浏览器语言自动选的 `/`）+ JSON-LD（`WebApplication` + `SoftwareSourceCode`）。结构化数据里的描述直接读页面的 meta description，不另写一份 |
| 卡片页 `/c/<id>` | `noindex, nofollow`，不进 sitemap |
| 层文件 `/api/layers/` | 响应头 `x-robots-tag: noindex`。**不在 robots.txt 里挡**：分享图就在这下面，Twitter 的爬虫遵守 robots.txt，挡了分享卡片就没图 |
| 不存在的路径 | 返回 404（页面照旧显示首页，人看不出区别）。以前一律 200，搜索引擎会把 `/abc` 这类当成首页的重复页 |
| 网站图标 | `public/favicon.svg`、`favicon.ico`（16/32/48）、`apple-touch-icon.png`（180，iOS 会把透明填成黑，所以带底色）。备选方案在 `docs/favicon-options/` |

**只能在各自后台做的**（需要账号）：

- Cloudflare → Security → Bots：确认没开「拦截 AI 爬虫」。开着的话 AI 爬虫在边缘就被挡了，从外面用伪造 UA 测不出来
- Google Search Console、Bing Webmaster Tools：验证站点、提交 `https://holocard.longsizhuo.com/sitemap.xml`
- 百度搜索资源平台：同上。站点没有 ICP 备案、服务器在海外，百度会收录得慢、排得靠后
- GitHub 仓库 Settings → Social preview：上传 `docs/social-preview.jpg`（中文）或 `docs/social-preview-en.jpg`（英文），没有 API，只能网页上传

## 多语言

界面有中文、英文、日文，文案全在 `src/i18n/messages.ts`：中文是源头，英文、日文的类型由它推出来，
少翻一个键类型检查就过不去。前端和服务端共用这一份。

这次请求用哪种语言，先到先得：地址上的 `?lang=` → 接口请求头 `x-holocard-lang` → cookie `hc_lang`
（页头手动切过一次就记住）→ `Accept-Language` → 中文。

- **页面**：服务端发 index.html 时按语言把标了 `data-i18n` 的静态文字、标题、描述都换好（`localizeHtml`），
  页面一出来就是对的语言，不会先闪一下中文。HTML 响应带 `Vary: Accept-Language, Cookie`。
  页头切换语言是就地换，不刷新页面——刷新会丢掉面板上还没保存的调参
- **接口报错**：返回 `code`（`rate_limited`、`card_not_found`…）和参数，前端按当前语言翻译；`error` 字段仍是中文原文
- **分享链接**：带分享人的语言（`/c/<id>?lang=en`，中文不带），对方看到的预览标题、描述、分享图和打开后的界面都是这个语言
- **做完卡自动分享**：服务端分层一完成，前端就用 `history.replaceState` 把地址栏换成这张卡的分享链接（不刷新页面），
  同时在后台调一次分享接口，分享框直接显示链接。原来要点「生成分享链接」，只有 28% 的人点；现在手机用户
  用浏览器菜单分享、复制地址栏，发出去的都是这张卡而不是首页，刷新也不会丢卡。
  刷新后落在 `/c/<id>`，卡的主人（本机有删除口令）照样看得到分享和删除入口；删卡后地址栏退回首页
- **首页分享图**：`public/og.jpg`、`og-en.jpg`、`og-ja.jpg`，都用 `pnpm og --lang <语言> --out public/og-<语言>.jpg` 从同一张测试图出。
  某个语言的图缺了就用中文那张

## 分享图

每张分享过的卡、每种语言一张（`preview.jpg`、`preview-en.jpg`、`preview-ja.jpg`），用无头浏览器截。
做完卡会自动分享（见上文），所以现在服务端产出的卡几乎每张都会截一张。

渲染排队，一次一张，失败隔 30 秒、60 秒再试，共三次；截图超时 90 秒。
以前分享那一下直接在后台渲染、失败就算了：上线头一天高峰期截图超时 18 次，32 张分享过的卡有 23 张一直没图。
现在另有两道兜底：**卡片页被打开时**发现这个语言的图缺了就排队补；**服务启动时**把分享过却缺中文图的都排上。

## 图片格式与权重

- **上传**：JPEG、PNG、WebP、AVIF 用 sharp；**HEIC** 用 heic-decode（libheif 的 WASM 版）——sharp 预编译包里的
  libheif 只有 AV1 解码器，解不了手机拍的 HEVC 编码的 HEIC，而微信、安卓的内置浏览器会把相册里的 HEIC 原图直接传上来。
  超过 16MB 的图前端先在浏览器里缩到 4096 以内再传
- **层图**：存成 WebP（画面有损 q88、alpha 无损），体积约为 PNG 的十分之一。老卡的 PNG 照常能用
- **权重**：服务端本来就有的 q8 权重在 `/models/` 下原样发出去，给浏览器端退回处理用（国内连不上 huggingface.co）。
  现在有后端的部署不会再退回浏览器端（见文末），线上这个路由暂时用不到
  只发三个文件，其余 404
- upng-js、heic-decode、libheif-js 是纯 JS/WASM，打进了服务端的包（`vite.server.config.ts` 的 `ssr.noExternal`），
  服务器上的 `node_modules` 不用动

## 保留与删除

清理只看数据库，不看目录 mtime——mtime 会被任何一次写入刷新，拿它当依据等于永不过期。

| | 窗口从哪算 | 多长 |
|---|---|---|
| 没分享过 | 产出时间 | 7 天 |
| 分享过 | **最后一次被打开** | 7 天起，访问量每翻一番延一档，封顶 112 天 |

档位：1 次 → 7 天，2-3 次 → 14 天，4-7 次 → 28 天，8-15 次 → 56 天，16 次以上 → 112 天。
关键是分享过的卡从「最后一次访问」起算：一直有人看就不断续期，等于长期保留；
彻底没人看了才开始倒计时。热门的留得久、冷的自然退场，磁盘占用有上界。
做完卡会自动分享，所以现在几乎所有卡都走第二行；没人看的卡和以前一样 7 天后清掉。

访问计数按 IP 做一小时去重（自己反复刷不会把保留期刷上去），`HEAD` 不计
（那多半是抓取工具和监控）。计数在内存里累计、每分钟合并写盘一次，
退出前（`SIGTERM`）也会落一次，所以发版重启不会丢掉一分钟的数据。

删除：产出时服务端生成一个删除口令，**只在 `POST /api/jobs` 的响应里给一次**，
前端存进 `localStorage`。`DELETE /api/cards/{id}` 带 `x-holocard-token` 头才能删。
口令不放在 `GET /api/jobs/{id}` 里——那个接口任何知道 id 的人都能打，而卡一分享出去
id 就是公开的。这个站没有账号，「所有者」就是「手上有口令的人」；用户清了浏览器数据
就等于放弃删除权，页面上写明了这一点。

## 导出动图

卡片旁边的导出按钮按设备给格式，文件都是服务端生成的：

| 设备 | 格式 | 卡片目录里的文件 |
|---|---|---|
| iPhone / iPad | GIF，手机竖屏画面 | `gif-v2.gif`，分享面板里「存储图像」进相册 |
| 安卓 | 动态照片（Motion Photo 1.0，另写老版 MicroVideo 字段） | `motion-v2.jpg`，JPEG 末尾接 MP4 |
| 电脑 | APNG | `sticker-v2.png`，透明底，无限循环 |

iPhone 起初给的是实况照片（JPEG + MOV 一对），真机实测走不通：网页只能经分享面板存文件，
「照片」不会把分开存进去的一对合成实况照片，MOV 还被分享面板当成了「文稿」，所以换成了 GIF。

`POST /api/cards/{id}/export/{gif|motion|apng}` 排队生成，`GET` 同一地址轮询状态。
文件随卡片过期、删除一起清掉；manifest 改过之后会重新生成。
文件名里的 `v2` 是 `server/export.ts` 的 `EXPORT_VERSION`：改了画面或封装参数就加一，存量自动作废。

依赖服务器上的 `ffmpeg`（要带 libx264，路径可用 `HOLOCARD_FFMPEG` 指定）。
单并发，排队上限 `HOLOCARD_MAX_EXPORT_QUEUE`（默认 6），
每个 IP 10 分钟最多导出 `HOLOCARD_EXPORT_RATE_LIMIT`（默认 8）次。
这台机器上（2 核额度、没有显卡）一张动态照片约 30 秒，APNG 约 25 秒。

本地看效果：`pnpm og --export gif`（或 `motion` / `apng`），产物在 `out/export/`。

## 埋点

自建 umami，站点 `HoloCard` / `holocard.longsizhuo.com`，
website id `a67a8797-af1a-41a9-8278-279c05b60c9c`，看板在 https://umami.involutionhell.com 。

id 通过 `.env.production` 里的 `VITE_UMAMI_ID` 在构建时注入。
**这个文件不进仓库**（见 `.gitignore`）：提交了的话，别人 clone 下来自托管会被动把数据上报到我们这。
所以每台发版机都要自己有一份；`deploy.sh` 开头会打印当前用的是哪个 id，缺了会警告。

上报的内容：页面浏览（`/c/<uuid>` 归一成 `/c`，具体哪张卡放在事件数据里，
否则页面列表会被几千个 uuid 撑爆）、`upload`（只带体积档位）、`segment-ok`、
`segment-fail`（错误信息前 120 字，外加走到哪一步 `stage`：upload / server / download / browser）、
`share`（手动点分享按钮；做完卡的自动分享不计）、`share-copy`（点「复制」）、
`card-view`（打开卡片页，卡的主人自己刷新不计）、`delete`、`export` / `export-fail` / `export-share`（带格式）、
`lang`（手动切换语言）。不带文件名。

本机和局域网地址（localhost、127.x、10.x、192.168.x…）上不加载统计：本地用生产配置构建时站点 id 也在，
以前在 127.0.0.1 上的测试全进了线上统计。查数据时照样加 `hostname = 'holocard.longsizhuo.com'`。

`/render/<id>`（无头浏览器截 OG 图的页面）不加载统计脚本——否则每生成一张预览图
就多一条假访问，而且刚好落在分享这个动作上，会把「分享后有多少人真的点开」打歪。

## 一次性配置

以下只在第一次部署时做过一遍，记录备查。

**1. 目录与运行时**

```bash
sudo mkdir -p /opt/holocard /srv/holocard-web/releases /srv/holocard-models /srv/holocard-layers /srv/holocard-data
sudo chown -R ubuntu:ubuntu /opt/holocard /srv/holocard-web /srv/holocard-models /srv/holocard-layers /srv/holocard-data

cd /opt/holocard
curl -sL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-arm64.tar.xz | tar -xJ
mv node-v22.14.0-linux-arm64 node22

printf '{"name":"holocard","private":true,"type":"module","dependencies":{"@huggingface/transformers":"4.3.0","sharp":"^0.35.4"}}' > package.json
PATH=/opt/holocard/node22/bin:$PATH npm install --no-audit --no-fund
```

**2. 模型权重**（服务端跑推理，浏览器不下载任何模型）

```bash
D=/srv/holocard-models/onnx-community/depth-anything-v2-small
mkdir -p $D/onnx
B=https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main
curl -sL $B/config.json -o $D/config.json
curl -sL $B/preprocessor_config.json -o $D/preprocessor_config.json
curl -sL $B/onnx/model_quantized.onnx -o $D/onnx/model_quantized.onnx
```

用 q8 而不是 fp16：在 ARM CPU 上实测快一倍（2.7s 对 5s+）、内存省三成，而深度图差别在切层这一步看不出来。

**2.5 渲染 OG 预览图的浏览器**

```bash
cd /opt/holocard
PLAYWRIGHT_BROWSERS_PATH=/opt/holocard/browsers npx --yes playwright@latest install chromium
```

注意别用 `npm install --save` 在这个目录里装东西——它会重写 package.json 并把
transformers.js、onnxruntime-node、sharp 全 prune 掉（我踩过）。要加依赖先改 package.json 再 `npm install`。

**3. systemd**：见 `/etc/systemd/system/holocard.service`，内容如上「资源限制」一节。

```bash
sudo systemctl enable --now holocard
```

**4. Caddy**：在 `/home/ubuntu/caddy-gateway/Caddyfile` 末尾追加。改之前先备份，改完先 `validate` 再 `reload`——
这个 Caddy 同时在服务 involutionhell.com 的一整套站点。

```
http://holocard.longsizhuo.com {
    reverse_proxy 127.0.0.1:8791 {
        # 一次分层要几秒到几十秒，别让网关提前掐断
        transport http {
            read_timeout 180s
            write_timeout 180s
        }
    }
}
```

```bash
sudo docker exec global-caddy-gateway caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo docker exec global-caddy-gateway caddy reload  --config /etc/caddy/Caddyfile --adapter caddyfile
```

**5. DNS**：在 Cloudflare 上把 `holocard` 指向源站 IP，A 记录、**必须开橙云（proxied）**，
和 `longsizhuo.com` 一样用 Flexible 模式（Caddy 只监听 80）。
关掉橙云会把源站 IP 直接暴露在 DNS 里，那台机器上的其他服务也跟着裸奔。

## 用户侧的流量

| | 来源 | 体积 |
|---|---|---|
| 页面 + 渲染器 | 本服务 | 约 27KB |
| 上传照片 | → 本服务 | 用户的原图 |
| 产出的层文件 | 本服务 | 约 6MB（3 张 PNG） |

**模型权重和推理运行时都不再下发给浏览器**。改造前每个新访客首次使用要下 47MB 权重 + 5.3MB wasm。

浏览器端的流水线代码仍然保留，但**只在部署里压根没有分层服务时**才回退过去（自托管的纯静态部署，
`POST /api/jobs` 回 404/405；开发时没起 `pnpm dev:server`，Vite 代理回 502），那时才会按需下载约 50MB 模型。

线上服务端临时不行时一律不回退，因为用户大多在手机上，50MB 模型的流量和内存都扛不住：

| 情况 | 前端的反应 |
|---|---|
| 发版重启（502）、Cloudflare 回源失败（52x）、网络断开 | 自动重试 3 次（间隔 1s / 3s / 6s），还不行就报「稍后再试」 |
| 排队满（503 `queue_full`） | 直接报错。自动重试要把整张照片重传一遍，手机上不划算 |
| 提交成功后轮询连续失败 60 秒，或总共等了 5 分钟 | 报「稍后再试」 |

改这块逻辑后跑一遍 `pnpm build && node scripts/verify-fallback.mjs`：它起一个假服务端，逐个场景核对前端提交了几次、有没有去下模型。

## 整个撤掉

```bash
sudo systemctl disable --now holocard
sudo rm /etc/systemd/system/holocard.service && sudo systemctl daemon-reload
sudo rm -rf /opt/holocard /srv/holocard-web /srv/holocard-models /srv/holocard-layers
# 从 Caddyfile 里删掉 holocard 那个 block，再 validate + reload
# 最后到 Cloudflare 后台删掉 holocard 这条记录
```
