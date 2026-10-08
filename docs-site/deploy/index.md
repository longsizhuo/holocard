# 自托管部署

本页说明如何在自己的服务器上部署 HoloCard：运行要求、构建、模型权重、配置、反向代理、数据保留、内容审核、对外接口与登录。

HoloCard 的服务端是一个 Node 进程，同时负责分层处理、接口和前端静态文件（含本文档站）。上游只需一条反向代理：

```text
浏览器 → 反向代理（HTTPS） → holocard 服务（127.0.0.1:8791）
                               ├── /             前端静态文件（HOLOCARD_WEB_DIR）
                               ├── /docs/        文档站（构建在前端目录的 docs/ 下）
                               ├── /api/jobs     网页提交与轮询
                               ├── /api/layers/  产出的层文件
                               └── /v1/          对外接口
```

服务只监听 `127.0.0.1`，不直接对外暴露端口。

## 运行要求

| 项目 | 要求 |
|---|---|
| Node | 22.13 或更高（`node:sqlite` 自 22.13 起无需实验开关）。数据库使用 Node 内置的 `node:sqlite`，不需要额外的 SQLite 原生依赖 |
| pnpm | 10（`corepack enable` 后按 `package.json` 的 `packageManager` 字段自动安装） |
| 架构 | Linux x86_64 或 ARM64。推理在 CPU 上运行，不需要显卡 |
| ffmpeg | 导出 GIF 和动态照片时需要，须带 libx264。不安装时这两种导出不可用 |
| Chromium | 渲染分享图（OG 预览图）和导出动图时需要，通过 Playwright 安装，见[构建](#构建)。不安装时分享图和导出不可用，分层不受影响 |

### 内存

| 场景 | 内存 |
|---|---|
| 只按深度分层（不放抠主体权重） | 深度模型较小，常驻 Chromium 另需数百 MB |
| 抠主体（BiRefNet） | 推理峰值约 7GB，推理结束后回落到 1GB 以内；加上深度模型和 Chromium，建议给服务 10GB 上限 |

服务启动时读取自身进程的内存上限（`process.constrainedMemory()`，即 cgroup 的内存限制，例如 systemd 的 `MemoryMax`）：

- 上限低于 8GB（`server/index.ts` 的 `MATTE_MIN_MEMORY`）时，即使放了抠主体权重也不做抠主体，只按深度分层，避免推理时被 cgroup 终止。
- 没有设置上限时，只要权重存在就会抠主体，不检查物理内存。物理内存不足 10GB 的机器应当设置 `MemoryMax`，或者不放抠主体权重。

启动日志中「模型目录」一行会说明是否启用抠主体：括号内显示所用模型时为启用，显示「内存上限不够」或「没有抠图权重」时为未启用。

### CPU

推理线程数按服务所在 cgroup 的 CPU 配额（`cpu.max`，即 systemd 的 `CPUQuota`）计算，未设配额时按机器核数。分层推理在单个常驻工作线程中逐张进行。

参考耗时（ARM64 CPU，2 核配额）：深度估计约 3 秒；抠主体约 25 秒；导出一张动态照片约 30 秒，APNG 约 25 秒。

### 磁盘

| 内容 | 体积 |
|---|---|
| `node_modules`（transformers.js、onnxruntime-node、sharp 等） | 约 500MB |
| Playwright 的 Chromium | 约 660MB |
| 模型权重 | 深度 27MB；抠主体 214MB；裸露识别 12MB |
| 每张卡片的目录 | 中位数约 1.7MB，九成在 8MB 以内 |

产物目录所在分区的剩余空间低于 `HOLOCARD_MIN_FREE_GB`（默认 5GB）时，服务拒收新的上传。

## 构建

```bash
corepack enable
pnpm install
pnpm build          # 前端 → dist/，文档站 → dist/docs/
pnpm build:server   # 服务端 → dist-server/
```

| 产物 | 内容 |
|---|---|
| `dist/` | 前端静态文件，作为 `HOLOCARD_WEB_DIR`。文档站生成在 `dist/docs/`，由同一个服务在 `/docs/` 下提供 |
| `dist-server/holocard-server.mjs` | 服务入口（ESM） |
| `dist-server/segment-worker.mjs` | 分层工作线程 |
| `dist-server/chunks/` | 上述两者共用的代码 |

服务端包不含原生模块：`sharp`、`@huggingface/transformers`、`onnxruntime-node`、`playwright-core` 在运行时从 `node_modules` 解析。最简单的做法是直接在执行过 `pnpm install` 的仓库目录中运行 `dist-server/holocard-server.mjs`。

安装渲染分享图、导出动图所用的 Chromium（版本与 `playwright-core` 对应）：

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/holocard/browsers pnpm exec playwright-core install chromium
```

运行服务时须设置同样的 `PLAYWRIGHT_BROWSERS_PATH`。缺少系统库时，可用 `playwright-core install-deps chromium`（需要 root）安装。也可以通过 `HOLOCARD_BROWSER_CHANNEL` 改用系统中已安装的 Chrome 或 Edge。

### 构建时变量

| 变量 | 作用 |
|---|---|
| `VITE_UMAMI_ID` | umami 统计的站点 id，可选。未设置时前端不加载任何统计脚本，服务端也不上报对外接口的事件 |

构建时变量写在仓库根目录的 `.env.production`（该文件不进仓库）或构建命令的环境中，`pnpm build` 和 `pnpm build:server` 都会读取。统计的上报地址固定在代码中（`src/demo/track.ts` 的 `SCRIPT_URL` 与 `server/umami.ts` 的 `ENDPOINT`），使用自建的 umami 实例时须同时修改这两处。本机和局域网地址（`localhost`、`127.x`、`10.x`、`192.168.x` 等）上不加载统计。

## 模型权重

推理全部在服务端进行，权重放在 `HOLOCARD_MODEL_DIR`（默认 `/srv/holocard-models`）下。服务运行时不从网络下载模型（transformers.js 的 `allowRemoteModels` 为 `false`），权重须事先放好。

| 模型 | 用途 | 文件（相对模型目录） | 是否必需 |
|---|---|---|---|
| Depth Anything V2 Small（q8） | 深度估计 | `onnx-community/depth-anything-v2-small/` 下的 `config.json`、`preprocessor_config.json`、`onnx/model_quantized.onnx` | 必需 |
| BiRefNet_lite（fp32） | 抠主体 | `onnx-community/BiRefNet_lite-ONNX/` 下的 `config.json`、`onnx/model.onnx` | 可选。不放时只按深度分层 |
| NudeNet v3.4 `320n` | 裸露识别 | `nudenet/320n.onnx` | 网页可选；启用对外接口时必需，见[内容审核](#内容审核) |

以下命令中 `M` 为模型目录：

```bash
M=/srv/holocard-models

# 深度模型（必需，27MB）
D=$M/onnx-community/depth-anything-v2-small
B=https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main
mkdir -p $D/onnx
curl -sL $B/config.json -o $D/config.json
curl -sL $B/preprocessor_config.json -o $D/preprocessor_config.json
curl -sL $B/onnx/model_quantized.onnx -o $D/onnx/model_quantized.onnx

# 抠主体（可选，214MB）
D=$M/onnx-community/BiRefNet_lite-ONNX
B=https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main
mkdir -p $D/onnx
curl -sL $B/config.json -o $D/config.json
curl -sL $B/onnx/model.onnx -o $D/onnx/model.onnx
sha256sum $D/onnx/model.onnx
# 5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333，224005088 字节

# 裸露识别（GitHub 发布页的直链会跳转到登录页，用 gh 下载）
mkdir -p $M/nudenet
gh release download v3.4-weights -R notAI-tech/NudeNet -p 320n.onnx -D $M/nudenet
sha256sum $M/nudenet/320n.onnx
# c15d8273adad2d0a92f014cc69ab2d6c311a06777a55545f2c4eb46f51911f0f，12150158 字节
```

抠主体模型可以通过 `HOLOCARD_MATTE_MODEL`、`HOLOCARD_MATTE_SIZE`、`HOLOCARD_MATTE_DTYPE` 更换。权重文件名由精度决定：`fp32` 读 `onnx/model.onnx`，`fp16` 读 `onnx/model_fp16.onnx`，`q8` 读 `onnx/model_quantized.onnx`。

服务在 `/models/onnx-community/depth-anything-v2-small/` 下公开提供深度模型的三个文件，供浏览器端在无法访问 Hugging Face 时使用；其余路径返回 404。

## 运行

### 环境变量

以下变量均由服务端在启动时读取，修改后须重启服务。

**路径与地址**

| 变量 | 默认值 | 作用 |
|---|---|---|
| `HOLOCARD_PUBLIC_ORIGIN` | `https://holocard.longsizhuo.com`（官方站点） | 站点对外的地址，用于分享链接、OG 标签、`robots.txt`、`sitemap.xml` 和登录回调地址。自托管时必须设置 |
| `HOLOCARD_PORT` | `8791` | 监听端口，只绑定 `127.0.0.1` |
| `HOLOCARD_WEB_DIR` | 空 | 前端静态文件目录，通常为构建产物 `dist/`。为空时不提供静态文件（开发时由 Vite 提供） |
| `HOLOCARD_OUT_DIR` | `/srv/holocard-layers` | 产物目录，每张卡一个子目录 |
| `HOLOCARD_DB` | 产物目录上一级的 `holocard-data/holocard.db` | SQLite 数据库文件，所在目录不存在时自动创建 |
| `HOLOCARD_MODEL_DIR` | `/srv/holocard-models` | 模型权重目录 |
| `HOLOCARD_FFMPEG` | `ffmpeg` | ffmpeg 可执行文件路径 |
| `HOLOCARD_BROWSER_CHANNEL` | 空 | Playwright 的浏览器渠道（如 `chrome`、`msedge`）。为空时使用 Playwright 安装的 Chromium |

**处理与限流**

| 变量 | 默认值 | 作用 |
|---|---|---|
| `HOLOCARD_MAX_UPLOAD` | `16777216`（16MB） | 单次上传的字节上限 |
| `HOLOCARD_CONCURRENCY` | `1` | 同时处理的任务数。分层推理本身始终在单个工作线程中逐张进行 |
| `HOLOCARD_MAX_QUEUE` | `12` | 网页任务的队列上限，排满时返回 503 `queue_full` |
| `HOLOCARD_RATE_LIMIT` | `10` | 每个客户端 IP 在窗口内最多提交几次（`POST /api/jobs`）。IPv6 按 /64 计 |
| `HOLOCARD_RATE_WINDOW_MS` | `600000`（10 分钟） | 上述限流的窗口长度 |
| `HOLOCARD_MIN_FREE_GB` | `5` | 产物目录所在分区剩余空间低于此值（GB）时拒收上传 |
| `HOLOCARD_TTL_MS` | `604800000`（7 天） | 卡片保留期的基础窗口，见[数据与保留](#数据与保留) |
| `HOLOCARD_MAX_EXPORT_QUEUE` | `6` | 导出动图的队列上限 |
| `HOLOCARD_EXPORT_RATE_LIMIT` | `8` | 每个客户端 IP 在限流窗口（10 分钟）内最多导出几次 |
| `HOLOCARD_MATTE_MODEL` | `onnx-community/BiRefNet_lite-ONNX` | 抠主体模型，即模型目录下的子路径 |
| `HOLOCARD_MATTE_SIZE` | `1024` | 抠主体模型的输入边长，须与该 ONNX 导出时的尺寸一致 |
| `HOLOCARD_MATTE_DTYPE` | `fp32` | 抠主体模型的精度：`fp32`、`fp16` 或 `q8` |

**对外接口**

| 变量 | 默认值 | 作用 |
|---|---|---|
| `HOLOCARD_MAX_API_QUEUE` | `6` | 对外接口（`/v1`）在队列中最多同时有几张。网页任务总是排在接口任务之前 |
| `HOLOCARD_API_DAILY_LIMIT` | `500` | 所有 key 合计每 24 小时最多提交几张，超出返回 503 `api_daily_limit` |
| `HOLOCARD_SELF_SERVE_DAILY_LIMIT` | `20` | 登录用户在个人中心自助申请的 key，每 24 小时的额度 |

**登录**

| 变量 | 默认值 | 作用 |
|---|---|---|
| `HOLOCARD_SSO_SECRET` | 空 | 授权方为本站发放的 client secret。为空时不开启登录 |
| `HOLOCARD_SSO_CLIENT_ID` | `holocard` | 在授权方登记的 client id |
| `HOLOCARD_SSO_AUTHORIZE_URL` | `https://involutionhell.com/sso/authorize` | 授权页地址，浏览器跳转到此处 |
| `HOLOCARD_SSO_TOKEN_URL` | `http://127.0.0.1:8080/internal/sso/token` | 换码地址，由服务端直接请求 |
| `HOLOCARD_AUTH_FAKE` | 未设置 | 设为 `1` 时开启假登录，仅限本地开发，见[登录](#登录) |

此外，Playwright 自身读取 `PLAYWRIGHT_BROWSERS_PATH`，须与安装 Chromium 时的值一致。

### systemd 示例

以下示例假设仓库检出并构建在 `/opt/holocard`，数据放在 `/var/lib/holocard`，以专用的系统用户 `holocard` 运行。路径和域名按实际情况修改。

```ini
# /etc/systemd/system/holocard.service
[Unit]
Description=HoloCard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=holocard
Group=holocard
WorkingDirectory=/opt/holocard
ExecStart=/usr/bin/node /opt/holocard/dist-server/holocard-server.mjs
Environment=HOME=/var/lib/holocard
Environment=HOLOCARD_PUBLIC_ORIGIN=https://cards.example.com
Environment=HOLOCARD_WEB_DIR=/opt/holocard/dist
Environment=HOLOCARD_OUT_DIR=/var/lib/holocard/layers
Environment=HOLOCARD_DB=/var/lib/holocard/data/holocard.db
Environment=HOLOCARD_MODEL_DIR=/var/lib/holocard/models
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/holocard/browsers
# 登录的 client secret 等敏感值放在单独的文件里（权限 600），不写进 unit 文件
EnvironmentFile=-/etc/holocard/secrets.env
Restart=on-failure
RestartSec=5s

# 抠主体峰值约 7GB；低于 8GB 时服务自动不做抠主体
MemoryMax=10G
# 推理线程数随此配额调整
CPUQuota=200%

# 沙箱：文件系统只读，只有数据目录可写
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/holocard
PrivateTmp=yes
PrivateDevices=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now holocard
journalctl -u holocard -f
```

### 健康检查

`GET /api/health` 返回服务状态：

```json
{ "ok": true, "running": 0, "queued": 0, "concurrency": 1, "exporting": 0, "exportQueued": 0 }
```

分层工作线程未能加载（依赖缺失、`chunks/` 不完整、原生模块无法在线程中加载等）时返回 503，`ok` 为 `false`。发版脚本可在重启后轮询此接口，失败时回滚。

### 重启与升级

升级时重新构建并重启服务即可。

- 收到 `SIGTERM` 或 `SIGINT` 时，服务先把内存中累计的访问计数写入数据库再退出。
- 原图在提交时即写入磁盘，队列中只保存 id。重启后，状态为 `queued` 或 `running` 的任务从磁盘上的原图继续处理。上次处理到一半的任务在续跑时不做抠主体，以免同一张图反复导致进程崩溃。
- 数据库表结构在服务启动时创建和迁移。

## 反向代理

反向代理负责 HTTPS 终结并转发到 `127.0.0.1:8791`。需要注意：

- 必须使用 HTTPS。会话 cookie 使用 `__Host-` 前缀并带 `Secure` 属性，HTTP 下登录不可用；对外接口的 key 也不应以明文传输。
- 请求体上限须不小于 `HOLOCARD_MAX_UPLOAD`（默认 16MB）。
- 网页和接口均为「提交 + 轮询」，单个请求不会持续很久；超时可适当放宽，以容纳较慢网络下的上传。

### 客户端 IP 的信任

服务端按以下顺序确定客户端 IP，用于按 IP 的限流和访问计数去重：

1. 请求头 `CF-Connecting-IP`
2. 请求头 `X-Forwarded-For` 的第一项
3. TCP 连接的对端地址

服务无条件信任这两个请求头，因此必须保证它们只能由可信代理写入：

- **不经过 Cloudflare 时**，反向代理须删除客户端发来的 `CF-Connecting-IP`，并用连接的对端地址覆盖 `X-Forwarded-For`（而不是在原值后追加，追加时第一项仍由客户端控制）。
- **经过 Cloudflare 时**，`CF-Connecting-IP` 由 Cloudflare 设置。此时反向代理必须只接受来自 Cloudflare IP 段的连接，否则任何人都可以绕过 Cloudflare 直连源站并伪造该请求头。

不满足上述条件时，按 IP 的限流、导出限流和访问计数去重都可被绕过，网页队列也可被占满。

### Caddy

```caddyfile
cards.example.com {
    request_body {
        max_size 20MB
    }
    reverse_proxy 127.0.0.1:8791 {
        # 不经过 Cloudflare 时删除客户端伪造的请求头。
        # Caddy 默认用连接的对端地址设置 X-Forwarded-For，不信任客户端发来的值
        header_up -CF-Connecting-IP
        transport http {
            read_timeout 180s
            write_timeout 180s
        }
    }
}
```

Caddy 自动申请证书。经过 Cloudflare 时去掉 `header_up -CF-Connecting-IP` 一行，并按上一节限制来源 IP。

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name cards.example.com;

    ssl_certificate     /etc/ssl/cards.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/cards.example.com/privkey.pem;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:8791;
        proxy_set_header Host $host;
        # 覆盖而不是追加（不要用 $proxy_add_x_forwarded_for）
        proxy_set_header X-Forwarded-For $remote_addr;
        # 值为空字符串时 nginx 不转发该请求头。经过 Cloudflare 时删除此行
        proxy_set_header CF-Connecting-IP "";
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
    }
}
```

服务端自行设置各路径的 `Cache-Control`（带哈希的静态资源长期缓存，入口页 `no-cache`，HTML 响应带 `Vary: Accept-Language, Cookie`），反向代理无需额外配置缓存头。

## 数据与保留

### 存储位置

| 位置 | 内容 |
|---|---|
| `HOLOCARD_DB` | SQLite 数据库（WAL 模式）。每张卡一行，记录状态、原图与结果地址、保留期相关字段、删除口令、裸露识别分数；另有 API key、登录会话、性能埋点等表 |
| `HOLOCARD_OUT_DIR/<id>/` | 每张卡的目录：原图（摆正方向并去掉全部 EXIF）、各层 WebP、`manifest.json`、卡册缩略图 `thumb.jpg`、分享图 `preview*.jpg`、导出的动图 |
| `HOLOCARD_OUT_DIR/.removed/<id>/` | 站长下架的卡，见[内容审核](#内容审核) |

数据库的状态字段 `status` 取值为 `queued` → `running` → `done` / `error`，之后可能变为 `deleted`（上传者删除）、`expired`（过期清理）或 `removed`（站长下架）。`deleted` 和 `expired` 只删除文件，保留数据库中的行。

### 清理规则

清理以数据库为准（`server/cards.ts`），不依据目录的修改时间。服务启动时执行一次，之后每 15 分钟执行一次。

| 卡片 | 保留期起算点 | 保留时长 |
|---|---|---|
| 未分享 | 产出时间 | `HOLOCARD_TTL_MS`（默认 7 天） |
| 已分享 | 最后一次被访问 | 按访问次数分档，见下表 |
| 放进账号的（登录时制作或认领的） | — | 不过期 |
| 对外接口制作的 | 提交时间 | 24 小时（固定） |

已分享卡片的档位（以默认 7 天为例，其他值按比例）：

| 访问次数 | 保留时长 |
|---|---|
| 1 | 7 天 |
| 2–3 | 14 天 |
| 4–7 | 28 天 |
| 8–15 | 56 天 |
| 16 及以上 | 112 天（上限） |

- 访问计数按「卡片 + IP」做一小时去重，`HEAD` 请求不计。计数先在内存中累计，每分钟写入数据库一次。
- 处理失败的卡片删除半成品，保留原图供排查，随保留期一同清理。
- 站长下架的网页卡片不被自动清理；下架的接口卡片仍在提交 24 小时后清理。
- 性能埋点（`perf` 表，不存 IP）保留 90 天，最多 20 万条；过期的登录会话同时清理。

### 删除

上传者的删除口令只在 `POST /api/jobs` 的响应中返回一次，由前端存入 `localStorage`。`DELETE /api/cards/{id}` 须带 `x-holocard-token` 请求头。登录时制作或认领的卡片归属账号，按会话校验，不再使用口令。上传者删除为真删除，包括隔离区中的副本。

### 查询数据库

`scripts/db.mjs` 以只读方式打开数据库，服务运行时可以使用，不会打印删除口令：

```bash
export HOLOCARD_DB=/var/lib/holocard/data/holocard.db
node scripts/db.mjs                 # 各状态计数和最近 20 张
node scripts/db.mjs <id>            # 某一张卡的全部字段
node scripts/db.mjs "SELECT ..."    # 任意只读 SQL
node scripts/db.mjs perf [天数]      # 性能埋点汇总
node scripts/db.mjs nsfw [阈值]      # 疑似裸露的卡片
```

仓库中的脚本（`db.mjs`、`apikey.mjs`、`takedown.mjs`）默认数据库为 `/srv/holocard-data/holocard.db`，产物目录为 `/srv/holocard-layers`，不随服务的配置推算。路径不同时须显式设置 `HOLOCARD_DB`、`HOLOCARD_OUT_DIR`，并以服务的运行用户执行。

### 备份

需要备份的是数据库和产物目录；模型权重和构建产物可以重新获取。

- 数据库处于 WAL 模式，不能在服务运行时直接复制 `holocard.db` 单个文件。可以使用 SQLite 的在线备份（例如 `sqlite3 holocard.db ".backup '/backup/holocard.db'"`），或停止服务后连同 `holocard.db-wal`、`holocard.db-shm` 一起复制。
- 产物目录包含原图和全部层文件，可用 `rsync` 等工具增量备份。数据库与产物目录应在相近的时间点备份，以免两者状态不一致。

## 内容审核

### 裸露识别

每张卡片分层完成后，服务端使用 NudeNet（部位检测模型，`server/moderation.ts`）检查原图。只统计「完全裸露」的部位：露出的生殖器、肛门、女性乳房；泳装、低胸、露背等不计入。最高分及部位记入数据库的 `nsfw`（0..1）和 `nsfw_part` 字段。模型在本机运行，图片不离开服务器。

| 来源 | 分数 ≥ 0.4 时 | 模型不可用时 |
|---|---|---|
| 网页 | 只记录，并在日志中打印一行 `[nsfw]`；不影响上传与分享 | 跳过识别，启动后首次使用时在日志中提示一次 |
| 对外接口 | 拒绝交付，任务以 `nsfw_rejected` 失败 | 拒绝交付，任务以 `moderation_unavailable` 失败 |

因此启用对外接口时必须放置 NudeNet 权重。服务启动时会为尚未识别的存量卡片补做识别。

NudeNet 以 AGPL-3.0 发布，HoloCard 以 GPL-3.0 发布，两者可以组合（GPLv3 第 13 条）；组合后通过网络提供服务时，须向用户提供对应源码。

### 下架

```bash
node scripts/db.mjs nsfw            # 列出疑似的卡片：id、部位、分数、是否分享、访问次数；不打开图片
node scripts/db.mjs nsfw 0.2        # 使用其他阈值
node scripts/takedown.mjs <id>          # 下架
node scripts/takedown.mjs restore <id>  # 恢复
```

下架是软删除：文件移入 `HOLOCARD_OUT_DIR/.removed/<id>`（没有任何路由可以访问），数据库状态改为 `removed`。对外表现与删除相同，误判时可以原样恢复，恢复后网页卡片的保留期从恢复时重新计算（接口卡片仍按提交时间计算）。站点前面有 CDN 时，下架后须另行清除 `/api/layers/<id>/` 前缀下的缓存。

## 对外接口

对外接口（`/v1`）的用法见 [API 文档](/api/)。启用前须先完成以下事项：

- 反向代理启用 HTTPS，并按[客户端 IP 的信任](#客户端-ip-的信任)配置，否则 key 可能明文传输，按 IP 的限流也可被绕过。
- 放置 NudeNet 权重，否则所有接口任务都以 `moderation_unavailable` 失败。

### key 管理

数据库中只存 key 的 SHA-256，key 本身只在创建时显示一次。`api_keys` 表由服务启动时创建，须先启动过一次服务。

```bash
node scripts/apikey.mjs create <调用方名称> [每 24 小时上限，默认 50]   # 创建并打印 key（hc_ 开头）
node scripts/apikey.mjs list                                       # 所有 key 及 24 小时内用量
node scripts/apikey.mjs revoke <id>                                # 吊销，立即生效
node scripts/apikey.mjs admin <IH 账号 id>                          # 设为管理员：不受额度限制
node scripts/apikey.mjs unadmin <IH 账号 id>                        # 取消管理员
```

开启登录后，登录用户还可以在个人中心自助申请 key：每个账号最多同时 10 个，共用一份额度 `HOLOCARD_SELF_SERVE_DAILY_LIMIT`。`list` 会标出自助申请的 key 所属的账号，并列出管理员账号。

管理员账号（`admins` 表）名下的 key 不受账号额度和全站每日总量限制；同一 key 同时处理的数量、排队上限仍然有效。管理员账号的用量仍计入全站每日总量，可能挤占其他账号。

### 额度与排队

| 限制 | 值 |
|---|---|
| 单个 key 每 24 小时 | 创建时指定（默认 50）；自助申请的为 `HOLOCARD_SELF_SERVE_DAILY_LIMIT`，按账号合计 |
| 单个 key 同时在上传或处理中 | 3 张（固定） |
| 所有 key 合计每 24 小时 | `HOLOCARD_API_DAILY_LIMIT` |
| 接口任务在队列中 | `HOLOCARD_MAX_API_QUEUE`；网页任务总是排在接口任务之前 |

接口制作的卡片在提交 24 小时后清理。网页和接口中被限流、排满或因磁盘空间不足拒绝的请求（429、503、507）都会在日志中记录一行 `[reject]`。

## 登录

登录用于在线卡册、将卡片放进账号（不过期）和自助申请 key，协议实现见 `server/auth.ts`。未设置 `HOLOCARD_SSO_SECRET` 时不开启登录，页面不显示登录入口，其余功能不受影响。

默认配置对接 involutionhell（IH）通行证，只有在 IH 登记过的 client 才能使用。自托管时可以不开启登录，或对接一个满足以下协议的授权方。

### 协议要求

协议为授权码模式加 PKCE（S256），流程与 OAuth 2.0 类似，但换码接口的请求和响应格式是自定义的。

**1. 授权**：用户访问 `/auth/login?next=<站内路径>` 时，服务端以 302 跳转到 `HOLOCARD_SSO_AUTHORIZE_URL`，携带查询参数：

| 参数 | 值 |
|---|---|
| `client_id` | `HOLOCARD_SSO_CLIENT_ID` |
| `redirect_uri` | `<HOLOCARD_PUBLIC_ORIGIN>/auth/callback` |
| `state` | 随机值（43 个 base64url 字符） |
| `code_challenge` | PKCE verifier 的 SHA-256，base64url 编码 |
| `code_challenge_method` | `S256` |

授权方完成认证后，跳转回 `redirect_uri`，携带原样的 `state` 和一次性授权码 `code`。`code` 须由字母、数字、`_`、`-` 组成，长度 20–200。`state` 与 PKCE verifier 保存在 `__Host-hc_state` cookie 中，有效期 10 分钟。

**2. 换码**：服务端向 `HOLOCARD_SSO_TOKEN_URL` 发送 `POST` 请求（超时 10 秒）：

```json
{
  "clientId": "holocard",
  "clientSecret": "<HOLOCARD_SSO_SECRET>",
  "code": "<授权码>",
  "codeVerifier": "<PKCE verifier>",
  "redirectUri": "https://cards.example.com/auth/callback"
}
```

授权方须校验 client secret、PKCE、`redirectUri` 与登记值一致，以及授权码未使用、未过期。成功时返回 2xx 和以下 JSON：

```json
{
  "success": true,
  "data": {
    "sub": "1234567890",
    "username": "alice",
    "displayName": "Alice",
    "avatarUrl": "https://example.com/avatar.png"
  }
}
```

| 字段 | 要求 |
|---|---|
| `sub` | 用户的唯一 id，必须是 1–19 位数字组成的字符串 |
| `displayName`、`username` | 显示名取第一个非空的值，截断至 80 字符；都为空时显示为 `#<sub>` |
| `avatarUrl` | 可选，只接受 `https://` 开头的地址 |

非 2xx、`success` 不为 `true` 或字段不合规时，视为登录失败。

**3. 会话**：换码成功后，服务端发放自己的会话 cookie `__Host-hc_session`（`Secure`、`HttpOnly`、`SameSite=Lax`，30 天），数据库中只存其哈希。授权方的登录态不经过 HoloCard。退出为 `POST /auth/logout`。依赖会话的修改类请求只接受 `Sec-Fetch-Site: same-origin`。

### 配置

```ini
# /etc/holocard/secrets.env（权限 600），由 systemd 的 EnvironmentFile= 读入
HOLOCARD_SSO_SECRET=<授权方发放的 secret>
HOLOCARD_SSO_CLIENT_ID=<登记的 client id>
HOLOCARD_SSO_AUTHORIZE_URL=https://auth.example.com/sso/authorize
HOLOCARD_SSO_TOKEN_URL=https://auth.example.com/internal/sso/token
```

须在授权方登记回调地址 `<HOLOCARD_PUBLIC_ORIGIN>/auth/callback`。

### 假登录

`HOLOCARD_AUTH_FAKE=1` 时，`/auth/login` 不经过授权方，直接登录到一个共用的测试账号，供本地开发查看登录后的界面。开启后任何访问者都能登录同一个账号，不得在对公网开放的部署中使用。

## 统计

统计为可选功能，通过构建时变量 `VITE_UMAMI_ID` 开启，见[构建时变量](#构建时变量)。开启后：

- 前端加载 umami 脚本，上报页面浏览和上传、分享、导出等事件，不带文件名。卡片页 `/c/<id>` 归一为 `/c`。
- 服务端为对外接口上报 `api-submit`、`api-done`、`api-fail`、`api-fetch`、`api-reject` 等事件，与网页事件记入同一个站点。
- 无头浏览器用于截图的 `/render/` 页面不加载统计。

另外，前端在每次页面访问时测量约 10 秒的帧率并写入本地数据库的 `perf` 表（`POST /api/perf`），与 umami 无关，不存 IP，可用 `node scripts/db.mjs perf` 查看。
