# Self-hosting

This page describes how to deploy HoloCard on your own server: requirements, build, model weights, configuration, reverse proxy, data retention, content moderation, the public API and login.

The HoloCard server is a single Node process that handles layer processing, the APIs and the frontend static files (including this documentation site). Only one reverse proxy is needed in front of it:

```text
Browser → reverse proxy (HTTPS) → holocard service (127.0.0.1:8791)
                                   ├── /             frontend static files (HOLOCARD_WEB_DIR)
                                   ├── /docs/        documentation site (built into docs/ under the frontend directory)
                                   ├── /api/jobs     web submission and polling
                                   ├── /api/layers/  generated layer files
                                   └── /v1/          public API
```

The service listens on `127.0.0.1` only and does not expose a port directly.

## Requirements

| Item | Requirement |
|---|---|
| Node | 22.13 or later (`node:sqlite` needs no experimental flag since 22.13). The database uses Node's built-in `node:sqlite`; no separate native SQLite dependency is needed |
| pnpm | 10 (after `corepack enable`, the version in the `packageManager` field of `package.json` is installed automatically) |
| Architecture | Linux x86_64 or ARM64. Inference runs on the CPU; no GPU is required |
| ffmpeg | Required for GIF and motion photo export, with libx264. Without it, these two export formats are unavailable |
| Chromium | Required for share images (OG previews) and animated exports; installed through Playwright, see [Build](#build). Without it, share images and exports are unavailable; layering is unaffected |

### Memory

| Scenario | Memory |
|---|---|
| Depth-only layering (no subject matting weights) | The depth model is small; the resident Chromium needs a few hundred MB more |
| Subject matting (BiRefNet) | Inference peaks at about 7 GB and drops below 1 GB afterwards; with the depth model and Chromium, a 10 GB limit for the service is recommended |

At startup the service reads its own memory limit (`process.constrainedMemory()`, i.e. the cgroup memory limit such as systemd's `MemoryMax`):

- If the limit is below 8 GB (`MATTE_MIN_MEMORY` in `server/config.ts`), subject matting is disabled even when its weights are present, and layering uses depth only. This prevents the cgroup from killing the process during inference.
- If no limit is set, matting is enabled whenever the weights exist; physical memory is not checked. On machines with less than 10 GB of RAM, set `MemoryMax` or leave out the matting weights.

The "模型目录" (model directory) line in the startup log shows whether matting is enabled: it lists the model in parentheses when enabled, and states that the memory limit is insufficient or that the matting weights are missing otherwise.

### CPU

The number of inference threads follows the CPU quota of the service's cgroup (`cpu.max`, i.e. systemd's `CPUQuota`), or the machine's core count when no quota is set. Layer inference runs one image at a time in a single resident worker thread.

Reference timings (ARM64 CPU, 2-core quota): depth estimation about 3 s; subject matting about 25 s; exporting a motion photo about 30 s, an APNG about 25 s.

### Disk

| Content | Size |
|---|---|
| `node_modules` (transformers.js, onnxruntime-node, sharp, etc.) | about 500 MB |
| Playwright Chromium | about 660 MB |
| Model weights | depth 27 MB; matting 214 MB; nudity detection 12 MB |
| Per-card directory | median about 1.7 MB, 90% under 8 MB |

When free space on the partition holding the output directory drops below `HOLOCARD_MIN_FREE_GB` (default 5 GB), the service rejects new uploads.

## Build

```bash
corepack enable
pnpm install
pnpm build          # frontend → dist/, documentation site → dist/docs/
pnpm build:server   # server → dist-server/
```

| Output | Contents |
|---|---|
| `dist/` | Frontend static files, used as `HOLOCARD_WEB_DIR`. The documentation site is generated into `dist/docs/` and served by the same service under `/docs/` |
| `dist-server/holocard-server.mjs` | Server entry point (ESM) |
| `dist-server/segment-worker.mjs` | Layering worker thread |
| `dist-server/chunks/` | Code shared by the two files above |

The server bundle does not include native modules: `sharp`, `@huggingface/transformers`, `onnxruntime-node` and `playwright-core` are resolved from `node_modules` at runtime. The simplest setup is to run `dist-server/holocard-server.mjs` directly inside the repository directory where `pnpm install` was run.

Install the Chromium used for share images and animated exports (matching the `playwright-core` version):

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/holocard/browsers pnpm exec playwright-core install chromium
```

The service must run with the same `PLAYWRIGHT_BROWSERS_PATH`. If system libraries are missing, install them with `playwright-core install-deps chromium` (requires root). Alternatively, `HOLOCARD_BROWSER_CHANNEL` selects an installed system Chrome or Edge.

### Build-time variables

| Variable | Purpose |
|---|---|
| `VITE_UMAMI_ID` | Optional umami website id. When unset, the frontend loads no analytics script and the server sends no public API events |
| `VITE_UMAMI_URL` | Optional umami instance URL, without a trailing slash. Defaults to `https://umami.involutionhell.com` |

Build-time variables go in `.env.production` at the repository root (not committed) or in the environment of the build commands; both `pnpm build` and `pnpm build:server` read them. To use your own umami instance, set `VITE_UMAMI_URL`; both the frontend script and the server events use it. Analytics is not loaded on local and LAN addresses (`localhost`, `127.x`, `10.x`, `192.168.x`, etc.).

## Model weights

All inference runs on the server. Weights are stored under `HOLOCARD_MODEL_DIR` (default `/srv/holocard-models`). The service does not download models at runtime (transformers.js `allowRemoteModels` is `false`), so the weights must be in place beforehand.

| Model | Purpose | Files (relative to the model directory) | Required |
|---|---|---|---|
| Depth Anything V2 Small (q8) | Depth estimation | `config.json`, `preprocessor_config.json`, `onnx/model_quantized.onnx` under `onnx-community/depth-anything-v2-small/` | Yes |
| BiRefNet_lite (fp32) | Subject matting | `config.json`, `onnx/model.onnx` under `onnx-community/BiRefNet_lite-ONNX/` | Optional. Without it, layering uses depth only |
| NudeNet v3.4 `320n` | Nudity detection | `nudenet/320n.onnx` | Optional for the web app; required when the public API is enabled, see [Content moderation](#content-moderation) |
| PaddleOCR PP-OCRv4 text detection (ONNX converted by RapidOCR, Apache-2.0) | Text in [card masks](/en/masks/) | `RapidOCR/ch_PP-OCRv4_det_infer.onnx` | Optional. Card masks need it and BiRefNet; if either is missing, `/api/cardmask` returns `cardmask_unavailable` |

In the commands below, `M` is the model directory:

```bash
M=/srv/holocard-models

# Depth model (required, 27 MB)
D=$M/onnx-community/depth-anything-v2-small
B=https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main
mkdir -p $D/onnx
curl -sL $B/config.json -o $D/config.json
curl -sL $B/preprocessor_config.json -o $D/preprocessor_config.json
curl -sL $B/onnx/model_quantized.onnx -o $D/onnx/model_quantized.onnx

# Subject matting (optional, 214 MB)
D=$M/onnx-community/BiRefNet_lite-ONNX
B=https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main
mkdir -p $D/onnx
curl -sL $B/config.json -o $D/config.json
curl -sL $B/onnx/model.onnx -o $D/onnx/model.onnx
sha256sum $D/onnx/model.onnx
# 5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333, 224005088 bytes

# Nudity detection (direct GitHub release links redirect to a login page; download with gh)
mkdir -p $M/nudenet
gh release download v3.4-weights -R notAI-tech/NudeNet -p 320n.onnx -D $M/nudenet
sha256sum $M/nudenet/320n.onnx
# c15d8273adad2d0a92f014cc69ab2d6c311a06777a55545f2c4eb46f51911f0f, 12150158 bytes

# Text detection for card masks (optional, 4.7 MB)
mkdir -p $M/RapidOCR
curl -sL https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx -o $M/RapidOCR/ch_PP-OCRv4_det_infer.onnx
sha256sum $M/RapidOCR/ch_PP-OCRv4_det_infer.onnx
# d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9, 4745517 bytes
```

The matting model can be changed with `HOLOCARD_MATTE_MODEL`, `HOLOCARD_MATTE_SIZE` and `HOLOCARD_MATTE_DTYPE`. The weight file name depends on the precision: `fp32` reads `onnx/model.onnx`, `fp16` reads `onnx/model_fp16.onnx`, `q8` reads `onnx/model_quantized.onnx`.

The service publicly serves the three depth model files under `/models/onnx-community/depth-anything-v2-small/` for the in-browser pipeline when Hugging Face is unreachable; all other paths return 404.

## Running

### Environment variables

All variables below are read by the server at startup; restart the service after changing them.

**Paths and addresses**

| Variable | Default | Purpose |
|---|---|---|
| `HOLOCARD_PUBLIC_ORIGIN` | `https://holocard.longsizhuo.com` (the official site) | Public origin of the site, used for share links, OG tags, `robots.txt`, `sitemap.xml` and the login callback URL. Must be set when self-hosting |
| `HOLOCARD_PORT` | `8791` | Listening port, bound to `127.0.0.1` only |
| `HOLOCARD_WEB_DIR` | empty | Frontend static file directory, usually the build output `dist/`. When empty, no static files are served (Vite serves them during development) |
| `HOLOCARD_OUT_DIR` | `/srv/holocard-layers` | Output directory, one subdirectory per card |
| `HOLOCARD_DB` | `holocard-data/holocard.db` next to the output directory | SQLite database file; its directory is created if missing |
| `HOLOCARD_MODEL_DIR` | `/srv/holocard-models` | Model weight directory |
| `HOLOCARD_FFMPEG` | `ffmpeg` | Path to the ffmpeg executable |
| `HOLOCARD_BROWSER_CHANNEL` | empty | Playwright browser channel (e.g. `chrome`, `msedge`). When empty, the Chromium installed by Playwright is used |

**Processing and rate limits**

| Variable | Default | Purpose |
|---|---|---|
| `HOLOCARD_MAX_UPLOAD` | `16777216` (16 MB) | Maximum upload size in bytes |
| `HOLOCARD_CONCURRENCY` | `1` | Number of jobs processed at the same time. Layer inference itself always runs one image at a time in a single worker thread |
| `HOLOCARD_MAX_QUEUE` | `12` | Queue limit for web jobs; when full, the server returns 503 `queue_full` |
| `HOLOCARD_RATE_LIMIT` | `10` | Maximum submissions (`POST /api/jobs`) per client IP within the window. IPv6 addresses are counted per /64 |
| `HOLOCARD_RATE_WINDOW_MS` | `600000` (10 minutes) | Window length for the limit above |
| `HOLOCARD_MIN_FREE_GB` | `5` | Uploads are rejected when free space (GB) on the output directory's partition falls below this value |
| `HOLOCARD_TTL_MS` | `604800000` (7 days) | Base retention window for cards, see [Data and retention](#data-and-retention) |
| `HOLOCARD_MAX_EXPORT_QUEUE` | `6` | Queue limit for animated exports |
| `HOLOCARD_EXPORT_RATE_LIMIT` | `8` | Maximum exports per client IP within a 10-minute window |
| `HOLOCARD_MATTE_MODEL` | `onnx-community/BiRefNet_lite-ONNX` | Matting model, as a subpath of the model directory |
| `HOLOCARD_MATTE_SIZE` | `1024` | Input size of the matting model; must match the size the ONNX file was exported with |
| `HOLOCARD_MATTE_DTYPE` | `fp32` | Precision of the matting model: `fp32`, `fp16` or `q8` |

**Public API**

| Variable | Default | Purpose |
|---|---|---|
| `HOLOCARD_MAX_API_QUEUE` | `6` | Maximum public API (`/v1`) jobs in the queue at once. Web jobs are always queued ahead of API jobs |
| `HOLOCARD_API_DAILY_LIMIT` | `500` | Maximum submissions per 24 hours across all keys; beyond that the server returns 503 `api_daily_limit` |
| `HOLOCARD_SELF_SERVE_DAILY_LIMIT` | `20` | 24-hour quota of keys that signed-in users create themselves on the account page |

**Login**

| Variable | Default | Purpose |
|---|---|---|
| `HOLOCARD_SSO_SECRET` | empty | Client secret issued to this site by the authorization server. Login is disabled when empty |
| `HOLOCARD_SSO_CLIENT_ID` | `holocard` | Client id registered with the authorization server |
| `HOLOCARD_SSO_AUTHORIZE_URL` | `https://involutionhell.com/sso/authorize` | Authorization page the browser is redirected to |
| `HOLOCARD_SSO_TOKEN_URL` | `http://127.0.0.1:8080/internal/sso/token` | Code exchange endpoint, called directly by the server |
| `HOLOCARD_AUTH_FAKE` | unset | When `1`, enables fake login for local development only, see [Login](#login) |

In addition, Playwright reads `PLAYWRIGHT_BROWSERS_PATH`, which must match the value used when installing Chromium.

### systemd example

The example below assumes the repository is checked out and built in `/opt/holocard`, data lives in `/var/lib/holocard`, and the service runs as a dedicated system user `holocard`. Adjust paths and the domain as needed.

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
# Keep sensitive values such as the login client secret in a separate file (mode 600), not in the unit file
EnvironmentFile=-/etc/holocard/secrets.env
Restart=on-failure
RestartSec=5s

# Matting peaks at about 7 GB; below 8 GB the service disables matting automatically
MemoryMax=10G
# The number of inference threads follows this quota
CPUQuota=200%

# Sandbox: read-only file system, only the data directory is writable
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

### Health check

`GET /api/health` returns the service status:

```json
{ "ok": true, "running": 0, "queued": 0, "concurrency": 1, "exporting": 0, "exportQueued": 0 }
```

If the layering worker thread fails to load (missing dependencies, incomplete `chunks/`, native modules that cannot load in a thread, etc.), it returns 503 with `ok` set to `false`. Deployment scripts can poll this endpoint after a restart and roll back on failure.

### Restarts and upgrades

To upgrade, rebuild and restart the service.

- On `SIGTERM` or `SIGINT`, the service writes the visit counts accumulated in memory to the database before exiting.
- Originals are written to disk on submission and the queue holds only ids. After a restart, jobs in the `queued` or `running` state resume from the original on disk. A job that was mid-processing when the previous process stopped resumes without subject matting, so that one image cannot crash the process repeatedly.
- Database tables are created and migrated at startup.

## Reverse proxy

The reverse proxy terminates HTTPS and forwards to `127.0.0.1:8791`. Note the following:

- HTTPS is required. The session cookie uses the `__Host-` prefix with the `Secure` attribute, so login does not work over HTTP; public API keys should not travel in plain text either.
- The request body limit must be at least `HOLOCARD_MAX_UPLOAD` (default 16 MB).
- Both the web app and the API use submit-and-poll, so individual requests are short; timeouts may be relaxed to accommodate uploads over slow networks.

### Trusting the client IP

The server determines the client IP in this order, for per-IP rate limits and visit-count deduplication:

1. The `CF-Connecting-IP` request header
2. The first entry of the `X-Forwarded-For` request header
3. The peer address of the TCP connection

The server trusts both headers unconditionally, so they must only be set by a trusted proxy:

- **Without Cloudflare**, the reverse proxy must remove any `CF-Connecting-IP` sent by the client and overwrite `X-Forwarded-For` with the peer address (not append to it; when appending, the first entry is still client-controlled).
- **Behind Cloudflare**, `CF-Connecting-IP` is set by Cloudflare. The reverse proxy must then accept connections only from Cloudflare IP ranges; otherwise anyone can bypass Cloudflare, connect to the origin directly and forge the header.

If these conditions are not met, per-IP submission limits, export limits and visit-count deduplication can all be bypassed, and the web queue can be filled.

### Caddy

```caddyfile
cards.example.com {
    request_body {
        max_size 20MB
    }
    reverse_proxy 127.0.0.1:8791 {
        # Without Cloudflare, drop the header so clients cannot forge it.
        # Caddy sets X-Forwarded-For from the peer address by default and ignores client-supplied values
        header_up -CF-Connecting-IP
        transport http {
            read_timeout 180s
            write_timeout 180s
        }
    }
}
```

Caddy obtains certificates automatically. Behind Cloudflare, remove the `header_up -CF-Connecting-IP` line and restrict source IPs as described in the previous section.

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
        # Overwrite, do not append (do not use $proxy_add_x_forwarded_for)
        proxy_set_header X-Forwarded-For $remote_addr;
        # nginx does not forward a header whose value is an empty string. Remove this line behind Cloudflare
        proxy_set_header CF-Connecting-IP "";
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
    }
}
```

The server sets `Cache-Control` for each path itself (long-lived caching for hashed assets, `no-cache` for entry pages, `Vary: Accept-Language, Cookie` on HTML responses), so the reverse proxy needs no extra cache headers.

## Data and retention

### Storage locations

| Location | Contents |
|---|---|
| `HOLOCARD_DB` | SQLite database (WAL mode). One row per card with its status, original and result URLs, retention fields, delete token and nudity score; plus tables for API keys, login sessions and performance samples |
| `HOLOCARD_OUT_DIR/<id>/` | One directory per card: the original (orientation normalized, all EXIF removed), WebP layers, `manifest.json`, album thumbnail `thumb.jpg`, share images `preview*.jpg` and exported animations |
| `HOLOCARD_OUT_DIR/.removed/<id>/` | Cards taken down by the operator, see [Content moderation](#content-moderation) |

The `status` field moves through `queued` → `running` → `done` / `error`, and may later become `deleted` (deleted by the uploader), `expired` (removed by retention cleanup) or `removed` (taken down by the operator). For `deleted` and `expired`, only the files are removed; the database row is kept.

### Cleanup rules

Cleanup is driven by the database (`server/store/cards.ts`), not by directory modification times. It runs once at startup and every 15 minutes afterwards.

| Card | Retention starts at | Retention |
|---|---|---|
| Not shared | Creation | `HOLOCARD_TTL_MS` (default 7 days) |
| Shared | Last visit | Tiered by visit count, see below |
| Saved to an account (created while signed in, or claimed) | — | Never expires |
| Created through the public API | Submission | 24 hours (fixed) |

Tiers for shared cards (with the default 7 days; other values scale proportionally):

| Visits | Retention |
|---|---|
| 1 | 7 days |
| 2–3 | 14 days |
| 4–7 | 28 days |
| 8–15 | 56 days |
| 16 or more | 112 days (cap) |

- Visits are deduplicated per card and IP for one hour; `HEAD` requests are not counted. Counts accumulate in memory and are written to the database once a minute.
- Failed jobs have their partial output removed; the original is kept for troubleshooting and cleaned up with the normal retention window.
- Web cards taken down by the operator are not cleaned up automatically; API cards that were taken down are still removed 24 hours after submission.
- Performance samples (`perf` table, no IPs stored) are kept for 90 days, up to 200,000 rows; expired login sessions are pruned at the same time.

### Deletion

The uploader's delete token is returned only once, in the response to `POST /api/jobs`, and the frontend stores it in `localStorage`. `DELETE /api/cards/{id}` requires the `x-holocard-token` header. Cards created while signed in, or claimed, belong to the account and are authorized by the session instead of a token. Deletion by the uploader is permanent and also removes any quarantined copy.

### Querying the database

`scripts/db.mjs` opens the database read-only, can be used while the service is running and never prints delete tokens:

```bash
export HOLOCARD_DB=/var/lib/holocard/data/holocard.db
node scripts/db.mjs                 # counts per status and the latest 20 cards
node scripts/db.mjs <id>            # all fields of one card
node scripts/db.mjs "SELECT ..."    # any read-only SQL
node scripts/db.mjs perf [days]     # performance sample summary
node scripts/db.mjs nsfw [threshold] # cards flagged for nudity
```

The repository scripts (`db.mjs`, `apikey.mjs`, `takedown.mjs`) default to `/srv/holocard-data/holocard.db` for the database and `/srv/holocard-layers` for the output directory; they do not derive these from the service configuration. With other paths, set `HOLOCARD_DB` and `HOLOCARD_OUT_DIR` explicitly and run the scripts as the service user.

### Backups

Back up the database and the output directory; model weights and build outputs can be obtained again.

- The database runs in WAL mode, so do not copy `holocard.db` alone while the service is running. Use SQLite's online backup (for example `sqlite3 holocard.db ".backup '/backup/holocard.db'"`), or stop the service and copy `holocard.db` together with `holocard.db-wal` and `holocard.db-shm`.
- The output directory contains the originals and all layer files and can be backed up incrementally with tools such as `rsync`. Back up the database and the output directory at about the same time so that their states stay consistent.

## Content moderation

### Nudity detection

After each card is layered, the server checks the original with NudeNet (a body-part detection model, `server/pipeline/moderation.ts`). Only full nudity counts: exposed genitalia, anus or female breasts; swimwear, low necklines, bare backs and similar are not counted. The highest score and the part are stored in the `nsfw` (0..1) and `nsfw_part` columns. The model runs locally; images never leave the server.

| Source | Score ≥ 0.4 | Model unavailable |
|---|---|---|
| Web | Recorded only, with an `[nsfw]` log line; uploads and sharing are unaffected | Detection is skipped; a message is logged once on first use |
| Public API | Delivery is refused; the job fails with `nsfw_rejected` | Delivery is refused; the job fails with `moderation_unavailable` |

The NudeNet weights are therefore required when the public API is enabled. At startup, the service scores existing cards that have not been checked yet.

NudeNet is released under AGPL-3.0 and HoloCard under GPL-3.0; the two may be combined (GPLv3 section 13). When the combination is offered as a network service, the corresponding source must be made available to its users.

### Takedown

```bash
node scripts/db.mjs nsfw            # list flagged cards: id, part, score, shared or not, visit count; images are not opened
node scripts/db.mjs nsfw 0.2        # use a different threshold
node scripts/takedown.mjs <id>          # take down
node scripts/takedown.mjs restore <id>  # restore
```

A takedown is a soft delete: the files move to `HOLOCARD_OUT_DIR/.removed/<id>` (not reachable through any route) and the status becomes `removed`. To visitors it looks the same as a deletion, and a mistaken takedown can be restored as is. After a restore, the retention of web cards restarts from the time of restore (API cards still count from submission). If a CDN sits in front of the site, purge the cache under the `/api/layers/<id>/` prefix after a takedown.

## Public API

See the [API documentation](/en/api/) for how to use the public API (`/v1`). Before enabling it:

- Enable HTTPS on the reverse proxy and configure it as described in [Trusting the client IP](#trusting-the-client-ip); otherwise keys may travel in plain text and per-IP limits can be bypassed.
- Install the NudeNet weights; otherwise every API job fails with `moderation_unavailable`.

### Key management

The database stores only the SHA-256 of each key; the key itself is shown once, at creation. The `api_keys` table is created when the service starts, so start the service at least once first.

```bash
node scripts/apikey.mjs create <caller name> [limit per 24 hours, default 50]   # create and print a key (starts with hc_)
node scripts/apikey.mjs list                                               # all keys with 24-hour usage
node scripts/apikey.mjs revoke <id>                                        # revoke, effective immediately
node scripts/apikey.mjs admin <IH account id>                              # make an admin: no quota
node scripts/apikey.mjs unadmin <IH account id>                            # remove admin
```

With login enabled, signed-in users can also create keys themselves on the account page: up to 10 per account at a time, sharing one `HOLOCARD_SELF_SERVE_DAILY_LIMIT` quota. `list` marks self-service keys with the owning account and lists admin accounts.

Keys of admin accounts (the `admins` table) are exempt from the account quota and the site-wide daily total; the per-key in-flight limit and the queue limit still apply. Admin usage still counts toward the site-wide daily total and can crowd out other accounts.

### Quotas and queueing

| Limit | Value |
|---|---|
| Per key, per 24 hours | Set at creation (default 50); `HOLOCARD_SELF_SERVE_DAILY_LIMIT` for self-service keys, counted per account |
| Per key, uploading or processing at once | 3 (fixed) |
| All keys combined, per 24 hours | `HOLOCARD_API_DAILY_LIMIT` |
| API jobs in the queue | `HOLOCARD_MAX_API_QUEUE`; web jobs are always queued ahead of API jobs |

Cards created through the API are removed 24 hours after submission. Requests rejected by rate limits, a full queue or low disk space (429, 503, 507), from both the web app and the API, each produce a `[reject]` log line.

## Login

Login enables the online album, saving cards to an account (where they never expire) and self-service API keys; the protocol is implemented in `server/account/auth.ts`. When `HOLOCARD_SSO_SECRET` is not set, login is disabled, no login entry is shown, and all other features work normally.

The defaults point to the involutionhell (IH) account service, which only accepts clients registered with IH. A self-hosted deployment can leave login disabled or connect to an authorization server that implements the protocol below.

### Protocol requirements

The protocol is an authorization code flow with PKCE (S256). It resembles OAuth 2.0, but the request and response formats of the code exchange endpoint are custom.

**1. Authorization**: when a user visits `/auth/login?next=<path on this site>`, the server redirects (302) to `HOLOCARD_SSO_AUTHORIZE_URL` with these query parameters:

| Parameter | Value |
|---|---|
| `client_id` | `HOLOCARD_SSO_CLIENT_ID` |
| `redirect_uri` | `<HOLOCARD_PUBLIC_ORIGIN>/auth/callback` |
| `state` | Random value (43 base64url characters) |
| `code_challenge` | SHA-256 of the PKCE verifier, base64url-encoded |
| `code_challenge_method` | `S256` |

After authenticating the user, the authorization server redirects back to `redirect_uri` with the unchanged `state` and a single-use authorization `code`. The `code` must consist of letters, digits, `_` and `-`, 20 to 200 characters long. The `state` and PKCE verifier are kept in the `__Host-hc_state` cookie for 10 minutes.

**2. Code exchange**: the server sends a `POST` request to `HOLOCARD_SSO_TOKEN_URL` (10-second timeout):

```json
{
  "clientId": "holocard",
  "clientSecret": "<HOLOCARD_SSO_SECRET>",
  "code": "<authorization code>",
  "codeVerifier": "<PKCE verifier>",
  "redirectUri": "https://cards.example.com/auth/callback"
}
```

The authorization server must verify the client secret, the PKCE verifier, that `redirectUri` matches the registered value, and that the code is unused and unexpired. On success it returns a 2xx status with this JSON:

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

| Field | Requirement |
|---|---|
| `sub` | Unique user id; must be a string of 1 to 19 digits |
| `displayName`, `username` | The display name is the first non-empty value, truncated to 80 characters; if both are empty, `#<sub>` is shown |
| `avatarUrl` | Optional; only `https://` URLs are accepted |

A non-2xx status, `success` other than `true`, or invalid fields are treated as a failed login.

**3. Session**: after a successful exchange, the server issues its own session cookie `__Host-hc_session` (`Secure`, `HttpOnly`, `SameSite=Lax`, 30 days) and stores only its hash in the database. The authorization server's own session never passes through HoloCard. Sign-out is `POST /auth/logout`. Session-authenticated requests that modify data are accepted only with `Sec-Fetch-Site: same-origin`.

### Configuration

```ini
# /etc/holocard/secrets.env (mode 600), loaded by systemd's EnvironmentFile=
HOLOCARD_SSO_SECRET=<secret issued by the authorization server>
HOLOCARD_SSO_CLIENT_ID=<registered client id>
HOLOCARD_SSO_AUTHORIZE_URL=https://auth.example.com/sso/authorize
HOLOCARD_SSO_TOKEN_URL=https://auth.example.com/internal/sso/token
```

Register the callback URL `<HOLOCARD_PUBLIC_ORIGIN>/auth/callback` with the authorization server.

### Fake login

With `HOLOCARD_AUTH_FAKE=1`, `/auth/login` skips the authorization server and signs in to a shared test account, so the signed-in interface can be checked during local development. Anyone can then sign in to the same account; never use it on a deployment reachable from the internet.

## Analytics

Analytics is optional and enabled by the build-time variable `VITE_UMAMI_ID`, see [Build-time variables](#build-time-variables). When enabled:

- The frontend loads the umami script and reports page views and events such as upload, share and export, without file names. Card pages `/c/<id>` are normalized to `/c`.
- The server reports public API events such as `api-submit`, `api-done`, `api-fail`, `api-fetch` and `api-reject` to the same website as the web events.
- The `/render/` pages used by the headless browser for screenshots do not load analytics.

Separately, on each page visit the frontend measures the frame rate for about 10 seconds and stores the result in the local database's `perf` table (`POST /api/perf`). This is independent of umami, stores no IPs, and can be viewed with `node scripts/db.mjs perf`.
