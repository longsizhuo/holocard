# Architecture

The HoloCard repository produces four things: the frontend of the public site, the layering service, the npm package `@holocard/player`, and this documentation site. They share the format definitions, the layering pipeline and the renderer under `src/`.

## Repository layout

```text
holocard/
├── index.html            frontend page (shared by all three routes)
├── src/
│   ├── format/           .layers format: types, reading and validation, author config
│   ├── segmenter/        layering pipeline (shared by server and browser)
│   ├── renderer/         holographic card renderer
│   ├── demo/             site frontend (holocard.longsizhuo.com)
│   ├── player/           <holo-card> custom element, entry of the npm package
│   ├── i18n/             UI strings and language detection (shared by frontend and server)
│   └── lab/              blind comparison page
├── server/               layering service (single Node process)
├── packages/player/      publish directory of @holocard/player
├── scripts/              verification and operations scripts, see Local development
├── lab/blind/            HTML of the blind comparison page
├── docs-site/            this documentation site (VitePress)
├── deploy/               production and staging deployment configuration
├── public/               static assets (sample card public/samples/demo, icons, share images)
└── vite*.config.ts       build configuration for each output
```

| Build config | Command | Output |
|---|---|---|
| `vite.config.ts` | `pnpm dev` / `pnpm build` | `dist/` (site frontend); dev port 5273 |
| `vite.server.config.ts` | `pnpm build:server` / `pnpm dev:server` | `dist-server/` |
| `vite.player.config.ts` | `pnpm build:player` | `packages/player/dist/holocard.js` |
| `vite.og.config.ts` | `pnpm og` | `.og-cache/bin/og-preview.mjs` |
| `vite.lab.config.ts` | invoked by `scripts/blind/pack.mjs` | `dist-lab/blind/` |
| `docs-site/.vitepress/config.ts` | `pnpm build` / `pnpm docs:dev` | `dist/docs/` |

## Modules

### `src/format`

The `.layers` format is the intermediate representation between the layering algorithm and the renderer: anything that produces a `LayerSet` can be rendered, and the renderer can be used on its own. See [File format](/en/format/).

| File | Responsibility |
|---|---|
| `types.ts` | Types such as `LayerManifest` and `LayerSet`; format version `LAYERS_FORMAT_VERSION`; foil types `FOIL_TYPES`; default foils `defaultFoilFor` and default halo `defaultHalo` |
| `io.ts` | Reading and validating manifests (`parseManifest`, `loadLayerSet`); validation errors throw `LayerFormatError`; layer file names may only refer to files next to the manifest |
| `config.ts` | Validation and merging of the author config (foils, halo, parallax). Shared by frontend and server; `PUT /api/cards/<id>/config` accepts only these fields |

### `src/segmenter`

The layering pipeline: photo → depth estimation → slicing → (server) subject matting → edge refinement → completion → `LayerSet`. In production it runs in a worker thread of the layering service; the browser runs it only when the deployment has no layering service at all. Algorithms and design decisions are in [Layering pipeline](/en/develop/pipeline).

| File | Responsibility |
|---|---|
| `index.ts` | The overall flow `segmentToLayerSet`; parallax coefficients and default foil assignment; the manifest `generator` field |
| `depth.ts` | Depth Anything V2-Small depth estimation |
| `slice.ts` | Finds cuts at depth-histogram valleys, checks each cut for a visible edge and an occlusion step (rigid boundaries); refits cuts around the subject (`fitCutsToSubject`) |
| `extract.ts` | Builds each layer's alpha and colour from the cuts: depth-edge snapping, per-layer completion, mirrored texture fill, soft-edge background removal |
| `refine.ts` | Guided-filter edge refinement; server parameters `SERVER_REFINE_OPTIONS` |
| `morph.ts` | Morphology helpers: depth-edge snapping, dilation, nearest-source propagation, alpha anti-aliasing, fragment removal |
| `matte.ts` | BiRefNet_lite subject matting, server only |
| `runtime.ts` | Weight source (Hugging Face, a `VITE_MODEL_HOST` mirror, or the site's own `/models/`), device selection (WebGPU / WASM / CPU), inference thread count |
| `image-io.ts` | Image decode / encode backend abstraction. The browser uses OffscreenCanvas; the server injects a sharp implementation (`server/pipeline/images.ts`) |

### `src/renderer`

The renderer takes a `LayerSet` and produces an interactive card, with no framework and no dependency on the layering algorithm. See [Renderer](/en/develop/renderer).

| File | Responsibility |
|---|---|
| `card.ts` | The `HoloCard` class: DOM structure, parallax, spring-driven interaction, the halo angle model, gyroscope control, `setPose` / `preview` |
| `card.css` | Structural styles, per-layer foil masks, halo and glare (masks move and scale with their parallax group), reduced motion |
| `foils.css` | Foil recipes, ported from pokemon-cards-css (GPL-3.0) |
| `highlight.ts` | Highlight protection: attenuates foil, halo and glare masks by image luminance |
| `spring.ts` | Spring integration with svelte/motion semantics |
| `gyro.ts` | Device tilt → pointer position, with an auto-recentering baseline |
| `textures.ts` | Grain and glitter textures for the foils, generated procedurally at runtime from a fixed seed |

### `src/demo`

The site frontend, i.e. holocard.longsizhuo.com.

| File | Responsibility |
|---|---|
| `main.ts` | Page entry: upload, layering, tuning panel, share, delete, export, language switch, and setup for the three routes |
| `route.ts` | Route parsing and share links |
| `api.ts` | Client of the layering service: submit and poll, delete-token records, share, author config, account and key endpoints. Decides when to fall back to the in-browser pipeline |
| `deck.ts` | The card strip on the home page: cards made in this visit, a pack shown while uploading, replaced by the new card after opening |
| `pack.ts` / `pack-gl.ts` / `pack-art.ts` | Card packs. `pack.ts` is the shared interface and shell; `pack-gl.ts` is the WebGL 3D foil bag; `pack-art.ts` draws the flat fallback without WebGL |
| `albums-ui.ts` | "My albums": cards made on this device (plus the account's cards when signed in), a native `<dialog>` that opens straight to the grid |
| `account-ui.ts` | Account panel: signed-in account, sign-out, album entry, and requesting, monitoring and revoking public API keys |
| `export.ts` | Exported animations: picks GIF / motion photo / APNG by device, submits and waits for the server |
| `sfx.ts` | Pack sound effects synthesised with Web Audio; the on/off switch is stored locally |
| `track.ts` | umami analytics; loads nothing when `VITE_UMAMI_ID` is not set |
| `perf.ts` | Performance beacon: measures 10 seconds of frame rate on an idle page and sends it to `POST /api/perf` |
| `style.css` / `pearl-drift.css` | Pearl theme; `pearl-drift.css` is generated by `scripts/pearl-keyframes.mjs` and must not be edited by hand |
| `ih-logo.svg` | The involutionhell.com logo printed on the pack front and the card back |

### `src/player`

`index.ts` defines the `<holo-card>` custom element: it reads the `.layers` directory or `manifest.json` given in `src` and renders it with `src/renderer`. `card.css` and `foils.css` are loaded as `?inline` strings into a Shadow DOM, isolated from the host page. See [Player](/en/player/).

### `src/i18n`

| File | Responsibility |
|---|---|
| `messages.ts` | Chinese, English and Japanese UI strings. Chinese is the source; the other two are typed from it, so a missing or extra key fails type-checking |
| `core.ts` | Shared by frontend and server: language detection (`?lang=` → cookie `hc_lang` → `Accept-Language` → Chinese), `translate`, `localizeHtml` |
| `index.ts` | Frontend: current language, `t()`, and in-place replacement of page text when switching languages |

Static text in `index.html` is marked with `data-i18n`, `data-i18n-html`, `data-i18n-title` and `data-i18n-aria`. The server replaces it per language when serving the page, and the frontend rewrites it in place on a language switch without reloading.

### `src/cardmask`

The rule-based half of [card masks](/en/masks/), which runs no model:

| File | Responsibility |
|---|---|
| `frame.ts` | Finds the art window: long straight edges form candidate rectangles, chosen by edge completeness and the probability that blocks inside are artwork (logistic regression `ART_MODEL`, trained with `cardmask-eval --train`) |
| `masks.ts` | Builds the frame-and-text, character, effects and text masks from the window, the character probability map and the text probability map |

The page is `masks.html` with `src/masks/main.ts`: upload, polling, and a two-layer LayerSet built from the selected regions for the renderer's preview. See `cardmask-eval` in [Local development](/en/develop/) for evaluation.

### `src/lab`

`blind.ts` is the script of the blind comparison page; `scripts/blind/pack.mjs` builds it together with `lab/blind/index.html`. See [Local development](/en/develop/#blind-comparison-scripts-blind).

### `server`

The layering service is one Node process that serves the frontend's static files and provides `/api`, `/auth` and `/v1`. The build output in `dist-server/` is `holocard-server.mjs` (entry), `segment-worker.mjs` (layering worker thread) and `chunks/` (shared code); the whole directory is deployed together.

| File | Responsibility |
|---|---|
| `index.ts` | Entry: request dispatch, health check `/api/health`, performance beacon `POST /api/perf`, periodic sweep, startup (resuming interrupted jobs, backfilling share images and nudity scores) |
| `config.ts` | Environment variables and derived settings (port, directories, quotas, retention, sign-in, matting model); other modules read from here |
| `http.ts` | JSON and error responses, reading request bodies, client IP, request language, rate limiting, same-origin checks, HTML escaping |
| `umami.ts` | Sends public API activity to umami from the server |
| `routes/cards.ts` | Card endpoints for the website: upload, job status, sharing, export, author config, deletion, layer files and thumbnails, `/models/` weights |
| `routes/static.ts` | Frontend static files: pages in the request language, OG tags for the home and share pages, `robots.txt`, `sitemap.xml` |
| `routes/account.ts` | `/auth/*` sign-in and sign-out; `/api/me/*` current account, claiming and API keys in the account panel |
| `routes/v1.ts` | The public API `/v1` |
| `routes/cardmask.ts` | Card masks `/api/cardmask`: upload, status, mask files |
| `pipeline/jobs.ts` | Layering jobs: accepting uploads (`acceptUpload`), the queue, dispatching to the worker thread, nudity detection, thumbnails, resuming on startup |
| `pipeline/segment-worker.ts` | Long-lived worker thread running the layering pipeline |
| `pipeline/images.ts` | sharp image codecs: normalising originals (orientation, EXIF removal, HEIC decoding), converting layers to WebP, album thumbnails |
| `pipeline/moderation.ts` | NudeNet nudity detection |
| `pipeline/eta.ts` | Remaining-time estimate from exponentially averaged per-stage durations |
| `pipeline/cardmask.ts` | Card mask jobs: normalise the card, find the window, have the worker thread matte the character and detect text, build and write the masks; results live in `.cardmasks/<id>/` and are deleted after 24 hours |
| `pipeline/textdet.ts` | PP-OCRv4 text detection (onnxruntime-node), producing a text probability map only |
| `render/preview.ts` | Captures share images by opening `/render/<id>` in headless Chromium, keeping the browser warm |
| `render/previews.ts` | Share-image render queue and retries |
| `render/export.ts` / `render/motionphoto.ts` | Exported animations (GIF, APNG, Android motion photo) |
| `render/exports.ts` | Export queue and status |
| `store/db.ts` | Card database (`node:sqlite`): cards, sessions, API keys, admins, performance beacons; `store/index.ts` opens it |
| `store/cards.ts` | Retention (`keepMs`, `expiresAt`), hit counting, expiry sweep, legacy migration |
| `store/perf.ts` | Validation and schema for performance beacons |
| `account/auth.ts` | Sign-in with an involutionhell (IH) account: authorization code + PKCE, session and state cookies |
| `account/session.ts` | Which account a request belongs to, and whether it owns a card |
| `account/apikeys.ts` | Generating, hashing and reading public API keys from request headers |
| `dev.env` | Local directory defaults for `pnpm dev:server` |

### `packages/player`

Publish directory of `@holocard/player`: `package.json`, `README.md` and the sample page `demo/index.html`; the build output `dist/holocard.js` is not committed. Pushing a `player-v<version>` tag runs `.github/workflows/publish-player.yml`, which checks that the tag matches the version in `package.json` and publishes to npm. The self-test is `scripts/verify-player.mjs`.

### `docs-site`

This documentation site. Chinese pages live in `docs-site/<section>/`, English in `docs-site/en/`, Japanese in `docs-site/ja/`. `pnpm build` builds it into `dist/docs`, which the layering service serves as static files under `/docs/`.

### `deploy`

Install scripts, systemd units and release scripts for production (`deploy/production/`) and staging (`deploy/staging/`). See [Self-hosting](/en/deploy/).

## How frontend and server work together

### Page routes

All three routes share one `index.html` (`src/demo/route.ts`):

| Path | Mode | Description |
|---|---|---|
| `/` | `demo` | Home page card strip; upload and tuning |
| `/c/<id>` | `card` | A shared card. On the first visit from a device it opens with a card pack (remembered in `localStorage` under `holocard:seen`) |
| `/render/<id>` | `render` | A bare render page with a fixed pose, used by the server for share images and exported animations; loads no analytics |

When serving a page, the server replaces static text for the request language and injects the card's OG / Twitter tags into `/c/<id>`.

### Submit and poll

How a card is made:

1. The frontend sends `POST /api/jobs` with the image bytes as the body. The server reads and normalises the original, checks free disk space, writes the database row and enqueues the job, then returns `202 {id, position, deleteToken}`.
2. The frontend polls `GET /api/jobs/<id>` every second. The response carries `state` (`queued` / `running` / `done` / `error`), `stage`, `position`, `eta`, and when done `layers` (the layer directory) and `layerCount`.
3. The frontend reads `/api/layers/<id>/manifest.json` and the layer images. The card strip first shows a pack, and the renderer takes over once it is opened.

Submission and polling are separate because processing takes tens of seconds, and long-lived connections are easily cut by reverse proxies and CDNs in between.

Rules:

- **Rate limits and queueing**: web submissions are limited per IP (by default 10 per 10 minutes, `rate_limited`); the web queue holds 12 by default (`queue_full`, 503). Public API jobs queue behind web jobs with their own limit.
- **Submit retries**: on network errors or 5xx the frontend retries after 1, 3 and 6 seconds; `queue_full` and `disk_full` are not retried, to avoid re-uploading the whole photo.
- **Polling tolerance**: polling reports an error only after failing continuously for 60 seconds; time spent queued does not count toward the 5-minute overall timeout.
- **Falling back to the browser**: only when the deployment has no layering service at all, i.e. `POST /api/jobs` returns 404 / 405, or the Vite proxy returns 502 in development. A temporarily unavailable server yields an error, not a fallback, because the fallback downloads the depth model. The in-browser pipeline does not matte the subject.
- **Remaining time**: `eta` is computed per stage by `server/pipeline/eta.ts` from exponential averages of the last few images on this machine, plus the jobs ahead when queued.

### Layering worker thread

onnxruntime-node runs inference synchronously on the calling thread, and slicing and completion are plain JS. On the main thread this would make the whole service unresponsive during processing, so the pipeline runs in the worker thread of `server/pipeline/segment-worker.ts` and the main thread only handles requests.

- One long-lived worker preloads the models at startup; layering processes one image at a time (raising `HOLOCARD_CONCURRENCY` does not parallelise it).
- Subject matting (`MATTE_READY`) requires both matting weights in the model directory and a process memory limit (systemd `MemoryMax`) of at least 8 GB, or no limit. The matting model can be switched with `HOLOCARD_MATTE_MODEL`, `HOLOCARD_MATTE_SIZE` and `HOLOCARD_MATTE_DTYPE`.
- The inference thread count follows the process's CPU quota (cgroup `cpu.max`).
- Cards still `running` at startup are treated as having crashed the previous process and are resumed without matting.
- If the worker exits before reporting ready, `/api/health` returns 503 so that the release script can stop the rollout.
- The worker outputs PNG; the main thread converts each layer to WebP (lossy colour, lossless alpha) before writing it, then writes `manifest.json`. It then makes the album thumbnail `thumb.jpg` (480 px on the long side) and runs nudity detection (web uploads are only scored, never blocked).

### Storage and retention

`server/store/db.ts` keeps one row per card as the single source of truth. Statuses are `queued`, `running`, `done`, `error`, `deleted` (deleted by the uploader; files are really removed), `expired` (swept after retention) and `removed` (taken down by the operator; files are moved to `.removed/<id>` and can be restored).

Retention is computed in `server/store/cards.ts`:

| Card | Retention |
|---|---|
| Not shared | `HOLOCARD_TTL_MS` from creation (7 days by default) |
| Shared | Counted from the last visit; each doubling of hits adds a step (7 days × 2ⁿ), up to 5 steps, i.e. 112 days |
| In an account | Never expires |
| Public API | 24 hours after submission |

### Card ownership

A request is from the card's owner (`owns`) in one of two ways:

- **Delete token**: when submitting while signed out, the server returns `deleteToken` once in the `POST /api/jobs` response and the frontend stores it locally. It is sent in the `X-HoloCard-Token` header. The token is not included in `GET /api/jobs/<id>` because card ids become public once shared.
- **Session**: cards made while signed in belong to the account directly and get no token. The request must carry a valid session and `Sec-Fetch-Site: same-origin`, so that sibling subdomains on the same site cannot borrow a visitor's session.

Operations that require ownership:

| Request | Effect |
|---|---|
| `POST /api/cards/<id>/share` | Share: the card gets long-term retention, a public card page, and a queued share image in the sharer's language |
| `PUT /api/cards/<id>/config` | Save the author config (foils, halo, parallax), validated by `src/format/config.ts` and merged into the manifest on disk |
| `DELETE /api/cards/<id>` | Delete the card and all its files |

### Share images and exported animations

Both are captured by the server opening its own `/render/<id>` page with Playwright, so they use the same rendering users see.

- **Share images** (`server/render/preview.ts`): 1200×630, one per language (`preview.jpg`, `preview-en.jpg`, `preview-ja.jpg`). Rendering is queued one at a time with retries; a missing image is rendered when the card page is opened, and missing ones are backfilled at startup.
- **Exported animations** (`server/render/export.ts`): `POST /api/cards/<id>/export/<gif|motion|apng>` submits, `GET` on the same URL reports status. The frontend picks the format by device: GIF on iPhone / iPad, a motion photo (JPEG followed by MP4) on Android, APNG on desktop. Exports are rate-limited per IP, and the files live in the card directory, expiring or being deleted with the card.

`pnpm dev:server` does not serve the frontend, so it cannot take these screenshots; use `pnpm og` to work on them locally.

### Sign-in and sessions

Sign-in is optional and is enabled when an IH client secret (`HOLOCARD_SSO_SECRET`) is configured or fake sign-in is on.

| Path | Purpose |
|---|---|
| `GET /auth/login` | Creates the state and PKCE verifier and redirects to the IH authorization page |
| `GET /auth/callback` | Checks the state, exchanges the code, client secret and PKCE verifier with the IH backend for the user, and starts a session |
| `POST /auth/logout` | Ends the session |
| `GET /api/me` | Whether sign-in is enabled, the current account, and the account's live cards |
| `POST /api/me/claim` | Claims cards on this device into the account by their tokens; the old tokens stop working |
| `GET` / `POST /api/me/keys`, `DELETE /api/me/keys/<id>` | Public API keys in the account panel: usage, request (up to 10 per account, sharing one quota), revoke |

- The session cookie `__Host-hc_session` and state cookie `__Host-hc_state` use the `__Host-` prefix so sibling subdomains cannot overwrite them. Sessions last 30 days; only the SHA-256 of the session secret is stored.
- HoloCard receives only the account id, name and avatar, and never touches the IH sign-in state.
- Fake sign-in (`HOLOCARD_AUTH_FAKE=1`) logs straight into a test account for local development. It turns on automatically on the staging origin when no secret is configured, and the server refuses to start with it on the production origin.

### Public API

`/v1` is handled by `server/routes/v1.ts`. It shares upload handling (`acceptUpload`) and the layering queue with the website, with these differences:

- Authentication with `Authorization: Bearer hc_…`; key hashes are stored in the `api_keys` table.
- Cards are private: visible only to the key that submitted them, and treated as nonexistent on `/api/jobs`, `/api/layers`, share, export, author config and `/c/<id>`.
- Nudity detection runs before delivery; a score at the threshold rejects the card with `nsfw_rejected`, and unavailable detection rejects it with `moderation_unavailable`.
- Web jobs are served first.

Usage, quotas and error codes are documented in [API](/en/api/).

### Analytics

| Source | Destination | Content |
|---|---|---|
| `src/demo/track.ts` | self-hosted umami | Page views and events: `upload`, `segment-ok`, `segment-fail`, `pack-open`, `parallax`, `share`, `share-copy`, `delete`, `export`, `export-share`, `export-fail`, `lang`, `login`, `card-view`, `claim`, `api-key`, `api-key-revoke` |
| `server/umami.ts` | the same umami site | Public API activity: `api-submit`, `api-reject`, `api-fetch`, `api-done`, `api-fail`, with the visitor identified by account or key id |
| `src/demo/perf.ts` | this service, `POST /api/perf` | Frame-time distribution over 10 idle seconds; at most one per visit, no id, the server stores no IP |

The umami site id is injected at build time from `VITE_UMAMI_ID`; without it neither frontend nor server sends anything, and nothing is sent from localhost or private-network origins. `/render/<id>` loads no analytics script.
