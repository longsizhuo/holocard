# Local development

This page covers running HoloCard locally, which verification script to run after a change, and common problems. For the code layout see [Architecture](/en/develop/architecture); for production deployment see [Self-hosting](/en/deploy/).

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| Node.js | 22.18 or later | The server uses `node:sqlite`; `verify-gyro` and `verify-config` import `.ts` sources directly and rely on type stripping, which Node enables by default from 22.18 |
| pnpm | 10 | After `corepack enable`, the version in the `packageManager` field of `package.json` is installed automatically |
| ffmpeg | any | Only needed by `pnpm capture` |
| ImageMagick | any | Only needed by `film-pack.mjs` to assemble the contact sheet; without it only single frames are written |

There is no unit test framework and no lint or formatter configuration. Correctness is checked by `scripts/verify-*.mjs`. Each script runs on its own, and its header comment states what it checks and what it needs.

## First-time setup

```bash
pnpm install
```

The warning `Ignored build scripts: onnxruntime-node, protobufjs` can be ignored: the CPU builds of onnxruntime-node for each platform ship inside the package.

### Model weights

The layering service reads weights from `.models/` (not committed).

| Weights | Size | Required | Behaviour when missing |
|---|---|---|---|
| Depth Anything V2-Small (`onnx-community/depth-anything-v2-small`) | 27 MB | Yes | The layering service cannot process images |
| BiRefNet_lite (`onnx-community/BiRefNet_lite-ONNX`) | 214 MB | No | No subject matting; layers are cut by depth only. Matting one image peaks at about 7 GB of memory |
| NudeNet 320n | 12 MB | No | Nudity detection is skipped; `/v1` cards fail with `moderation_unavailable`, so it is required for `verify-api` |

Download the depth model:

```bash
D=.models/onnx-community/depth-anything-v2-small
mkdir -p $D/onnx
B=https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main
curl -sL $B/config.json -o $D/config.json
curl -sL $B/preprocessor_config.json -o $D/preprocessor_config.json
curl -sL $B/onnx/model_quantized.onnx -o $D/onnx/model_quantized.onnx
```

Download commands for the other two models are in [Self-hosting](/en/deploy/); replace `/srv/holocard-models` with `.models`.

## Day-to-day development

Run in two terminals:

```bash
pnpm dev          # frontend, http://localhost:5273
```

```bash
pnpm dev:server   # layering service on port 8791
```

- The frontend hot-reloads. Vite proxies `/api` to `HOLOCARD_API` (default `http://127.0.0.1:8791`). The port is fixed at 5273 (`strictPort`); if it is taken, Vite exits with an error.
- `pnpm dev:server` builds and then starts the server; restart it after changing anything under `server/`. It loads local directory settings with `node --env-file=server/dev.env`; values already set in the environment take precedence.
- Without the layering service, the Vite proxy returns 502 and the frontend falls back to in-browser layering, which first downloads the depth model (about 50 MB fp16 on WebGPU, about 25 MB q8 on WASM).
- Locally generated cards and the database live under `out/`; delete it to start clean.
- `pnpm dev:server` does not serve the frontend (`HOLOCARD_WEB_DIR` is empty), so `[preview] 渲染失败` in its log is expected. Use `pnpm og` to work on share images and exported animations locally.

`server/dev.env`:

| Variable | Value | Purpose |
|---|---|---|
| `HOLOCARD_MODEL_DIR` | `.models` | Model weights |
| `HOLOCARD_OUT_DIR` | `out/layers` | Card output |
| `HOLOCARD_DB` | `out/data/holocard.db` | SQLite database |

### `package.json` scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Frontend dev server (Vite, port 5273) |
| `pnpm dev:server` | Build and start the local layering service (port 8791, directories from `server/dev.env`) |
| `pnpm typecheck` | `tsc --noEmit` over `src/`, `server/`, `scripts/og-preview.ts` and the Vite configs |
| `pnpm build` | Runs `pearl-keyframes.mjs --check` on the generated file, then type-checks and builds the frontend (`dist/`) and this documentation site (`dist/docs`) |
| `pnpm preview` | Preview the `dist/` build |
| `pnpm build:server` | Type-check and build the server into `dist-server/` |
| `pnpm start:server` | Run `dist-server/holocard-server.mjs` with production defaults (directories under `/srv`) |
| `pnpm build:player` | Build the npm package `@holocard/player` into `packages/player/dist` |
| `pnpm og` | Preview share images and exported animations, see below |
| `pnpm capture` | Record a demo GIF, see [Other scripts](#other-scripts) |
| `pnpm docs:dev` | Preview this documentation site (VitePress) |

### Share images and exported animations

`pnpm og` renders through the same path as production: the frontend is built by Vite on the fly and screenshots call the server's `renderPreview` directly. Layering results are cached in `.og-cache/` by image content hash, so style changes do not re-run inference. Requires the weights in `.models/`.

```bash
pnpm og                    # render scripts/fixtures/og-test.jpg to out/og-preview.jpg and open it
pnpm og path/to/image      # use another image
pnpm og --watch            # watch src/ and re-render on save
pnpm og --pose 78,22       # pose (pointer position on the card, in percent)
pnpm og --size 1280x640    # size (GitHub social preview is 1280×640)
pnpm og --lang en          # caption on the right in English (en / ja)
pnpm og --out path --png --no-open
pnpm og --export gif       # exported animation: gif / motion / apng, written to out/export/
```

## Which verification script to run

Run `pnpm typecheck` first and `pnpm build` before committing. Then run the scripts that match the change:

| Changed | Command | Prerequisites |
|---|---|---|
| Card strip, card pack, panel status line, upload area (`deck.ts`, `pack.ts`, `main.ts` and related styles) | `node scripts/verify-pack.mjs [--url …] [--out /tmp/verify-pack]` | `HOLOCARD_API=http://127.0.0.1:9 pnpm dev` (the script intercepts every `/api` request in the browser; pointing the backend at a dead address prevents accidental real calls) |
| Pack-opening animation (frame by frame, `pack-gl.ts`, `deck.ts`) | `node scripts/film-pack.mjs [--url …] [--out /tmp/film-pack]` | Same as above; ImageMagick for the contact sheet |
| Pearl background (gradients in `style.css`, configuration in `pearl-keyframes.mjs`) | `node scripts/pearl-keyframes.mjs` to regenerate `src/demo/pearl-drift.css`, then `node scripts/verify-pearl.mjs [--browser chromium\|webkit]` | `pnpm dev` |
| When to fall back to in-browser layering (`src/demo/api.ts`) | `pnpm build && node scripts/verify-fallback.mjs` | None; the script runs its own fake server |
| Gyroscope (`src/renderer/gyro.ts`) | `node scripts/verify-gyro.mjs` | None |
| Author config validation (`src/format/config.ts`) | `node scripts/verify-config.mjs` | None |
| Performance beacon (`src/demo/perf.ts`, `server/perf.ts`) | `node scripts/verify-perf.mjs [--url …] [--browser chromium\|webkit\|firefox]` | `pnpm dev` and `pnpm dev:server` |
| Public API `/v1` (`handleV1` in `server/index.ts`, `server/apikeys.ts`) | `HOLOCARD_DB=out/data/holocard.db HOLOCARD_OUT_DIR=out/layers node scripts/verify-api.mjs http://127.0.0.1:8791` | `pnpm dev:server`, with NudeNet weights in `.models/` |
| Sign-in, card ownership and claiming, API keys in the account panel (`server/auth.ts` and related routes) | `pnpm build:server && HOLOCARD_MODEL_DIR=.models node scripts/verify-auth.mjs` | Depth model weights. The script starts its own fake IH and a temporary server; no dev servers needed |
| Header and account panel UI (`account-ui.ts`) | `pnpm build && pnpm build:server && node scripts/verify-account.mjs` | None. The script starts a temporary server with fake sign-in |
| Player `<holo-card>` (`src/player/`, `packages/player/`) | `pnpm build:player && node scripts/verify-player.mjs [screenshot dir]` | Chromium, see below |
| Pack sound effects (`src/demo/sfx.ts`) | `node scripts/render-sfx.mjs`, then listen to `/tmp/sfx/reel.wav` | `pnpm dev` |
| Look of share images and exported animations | `pnpm og` | None |

What each script checks:

- `verify-pack`: the full flow of upload → WebGL card pack → switching the card strip → tearing / tapping open → the new card's entrance; a shared card shows a pack on first open; the album opens straight to the grid (without sign-in, the header button opens the album directly); status line text; the upload area's accessible name and keyboard activation. Key moments are screenshotted to `--out`.
- `verify-pearl`: freezes the current implementation (12 updates per second, plus `will-change` on Chromium) and the per-frame smooth version at the same moments and compares them pixel by pixel; fails above the threshold. Run WebKit separately.
- `verify-fallback`: a fake server answers 404 (no backend → fall back), 502 / dropped connection (retry 3 times, then error without downloading the model) and 503 queue full (error immediately, no re-upload).
- `verify-gyro`: tilting moves the pointer; holding still recenters within seconds; slow continuous rotation does not accumulate; reading jumps when crossing vertical; axes swap in landscape.
- `verify-config`: valid configs merge unchanged and leave other fields alone; layer-count mismatches, unknown foil types, out-of-range values and attempts to change file names are rejected or ignored.
- `verify-perf`: an idle page sends one beacon and the server stores it; malformed payloads are rejected.
- `verify-api`: authentication, privacy (API cards do not exist on `/api`, share, export or delete routes), delivery and cache headers, quota, revocation, deletion during processing, web jobs jumping ahead, malformed request lines and oversized bodies. Each card is really layered, taking 30–60 seconds.
- `verify-account`: the header "Docs" link follows the interface language; the sign-in entry and local album in the account panel when signed out; requesting several keys when signed in, the new key shown only once, revoking one of them.
- `verify-auth`: the sign-in flow (state cookie, code exchange, PKCE, single-use codes, `next` limited to same-site paths); ownership of cards made while signed in; claiming by token; other accounts cannot act on a card; sessions end on sign-out; account cards do not expire; requesting (up to 10 per account) and revoking API keys in the account panel, the quota shared across an account's keys, and unlimited admin accounts; the server refuses to start with fake sign-in on the production origin.
- `verify-player`: both the directory URL and the `manifest.json` URL load and fire `load`; a bad URL fires `error`; host page CSS cannot reach inside the card and the component adds no styles to the host; the card tilts under the pointer. Set `PLAYER_URL=https://cdn.jsdelivr.net/npm/@holocard/player@<version>/dist/holocard.js` to check a published CDN build.
- `render-sfx`: renders each sound effect to wav offline and checks it is not silent and peaks below 1.

### Browsers and test data

- `verify-pack`, `verify-pearl` and `verify-fallback` use the system Chrome on macOS, Edge on Windows and Playwright's bundled Chromium elsewhere; override with `HOLOCARD_BROWSER_CHANNEL` (`chrome` / `msedge`, empty for the bundled build).
- `film-pack`, `render-sfx` and `verify-perf` only use Playwright's bundled browsers. Install once with `pnpm exec playwright-core install chromium`; `verify-pearl --browser webkit` needs `webkit`, `verify-perf --browser firefox` needs `firefox`.
- `verify-player` takes the browser executable from `CHROMIUM_PATH`. The fallback is a path hard-coded in the script, so set it explicitly on other machines.
- `verify-pack` and `film-pack` intercept every `/api` request inside the browser and never reach a backend. `verify-api` and `verify-perf` write test data into the target server's database; never run them against production.

## Other scripts

| Script | Purpose | Prerequisites |
|---|---|---|
| `pnpm capture --image photo [--out out/demo.gif]` | Record a demo GIF. Poses are set frame by frame with the renderer's `setPose`, so output is deterministic. `--dump` also exports each layer as PNG; `--no-gif` skips recording | System Edge, ffmpeg, `pnpm dev` |
| `node scripts/probe-matte.mjs --image photo [--out out/matte.png]` | Run the matting model alone in the browser and save the alpha, to reproduce why BiRefNet cannot run in browsers | System Edge, `pnpm dev` |
| `node scripts/verify-live.mjs --image photo [--url …]` | Production smoke test with a fresh browser profile: upload and layering, recording cross-origin isolation, large downloads and layer count | System Edge |
| `HOLOCARD_DB=out/data/holocard.db node scripts/db.mjs [id \| SQL \| perf [days] \| nsfw [threshold]]` | Read-only queries on the card database: recent cards and status counts, one card, any read-only SQL, performance beacon summary, suspected nudity | None |
| `node scripts/apikey.mjs create <name> [daily limit] \| list \| revoke <id> \| admin <account> \| unadmin <account>` | Issue, list and revoke public API keys; set admin accounts exempt from quotas. A key is printed once on `create`; only its SHA-256 is stored | Database from `HOLOCARD_DB` |
| `node scripts/takedown.mjs [restore] <card id>` | Take a card down or restore it. Soft delete: files move to `.removed/<id>` under the output directory and the status becomes `removed` | `HOLOCARD_OUT_DIR`, `HOLOCARD_DB` |
| `node scripts/webp-layers.mjs [--apply \| --cleanup]` | Convert older cards with PNG layers to WebP. Without flags it only lists; `--apply` writes WebP and atomically replaces the manifest; `--cleanup` deletes PNGs no longer referenced | `HOLOCARD_OUT_DIR` |
| `bash scripts/deploy.sh` | Manual release, see [Self-hosting](/en/deploy/) | SSH access to the server |

`apikey.mjs`, `takedown.mjs`, `webp-layers.mjs` and `db.mjs` default to production paths (`/srv/...`); point the environment variables at `out/` when using them locally.

### Blind comparison (`scripts/blind/`)

Compares the output of two server configurations (for example two matting models): each configuration makes one card per source image, a reviewer picks the better side pair by pair on a comparison page, and the answers are decoded into wins per configuration afterwards. The page source is `lab/blind/index.html` with `src/lab/blind.ts`; it uses the site's renderer and keeps cards A and B in the same pose.

```bash
# 1. Run each configuration in turn (not in parallel: matting peaks at about 7 GB)
pnpm build && pnpm build:server
node scripts/blind/run-variant.mjs --in source-dir --out /tmp/exp/lite --port 8781
HOLOCARD_MATTE_MODEL=onnx-community/BiRefNet_512x512-ONNX HOLOCARD_MATTE_SIZE=512 HOLOCARD_MATTE_DTYPE=q8 \
  node scripts/blind/run-variant.mjs --in source-dir --out /tmp/exp/512 --port 8782

# 2. Pack: keep only pairs whose subjects differ a lot, plus 6 near-identical pairs as a calibration group
node scripts/blind/pack.mjs --variant lite=/tmp/exp/lite --variant 512=/tmp/exp/512 --out /tmp/exp/pack \
  --min-iou 0.95 --calibration 6 --focus "Subject edges: halos, ghosting, missing parts"

# 3. Give /tmp/exp/pack/page to the reviewer and collect the result string from "copy results"

# 4. Decode
node scripts/blind/score.mjs /tmp/exp/pack/key.json "1A 2= 3B 4X ..." --candidate 512
```

| Script | Purpose |
|---|---|
| `run-variant.mjs` | Starts a temporary layering service at the lowest priority (`nice 19`), submits images one by one, and writes `layers/`, `ids.tsv` (source name → card id) and `timing.json`. The configuration under test is passed as environment variables; see `server/index.ts` for what the server reads (matting uses `HOLOCARD_MATTE_*`) |
| `pack.mjs` | Pairs cards, filters by `--min-iou`, randomises A/B, and writes the page `page/` and the answer key `key.json`. The manifest `generator` field (which names the model) is removed from page data |
| `score.mjs` | In the result string `A` / `B` means that side is better, `=` similar, `X` both have problems, `A!` / `B!` the other side has an obvious defect. Preferences and defect rates are counted separately; the calibration group is reported on its own |

Notes:

- Source images and experiment directories usually contain users' photos. Keep them outside the repository (`/tmp` or similar), delete them after review, and never commit them.
- Never send `key.json` along with the page; that breaks blinding.

## Troubleshooting

### `Port 5273 is already in use`

The port is fixed and is not changed automatically. Find the process with `lsof -nP -iTCP:5273 -sTCP:LISTEN` and stop it; the same applies to 8791.

### The layering service exits on start with `mkdir '/srv/...'`

`pnpm start:server` and `dist-server/holocard-server.mjs` use production directories under `/srv`. Use `pnpm dev:server` locally.

### Scripts cannot connect to 5273

Use `localhost`, not `127.0.0.1`. On macOS, Vite listens only on the IPv6 localhost.

### `verify-gyro` / `verify-config` fail with `ERR_UNKNOWN_FILE_EXTENSION`

Node is older than 22.18 and type stripping is not on by default. Upgrade Node, or on 22.15–22.17 run with `--experimental-strip-types`.
