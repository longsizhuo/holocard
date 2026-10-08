# HoloCard API

Turn a photo into a moving layered holographic card over HTTP, then play it on your own web page with our player.

## Quick start

Four steps: get a key → submit an image → wait for it and download the files → play them with the player.

```bash
# 1. Submit: replace photo.jpg with the path to an image on your computer (use image/png for PNG)
curl -X POST https://holocard.longsizhuo.com/v1/cards \
  -H "Authorization: Bearer hc_your_key" \
  -H "Content-Type: image/jpeg" --data-binary @photo.jpg
# → 202 {"id":"3f1c…","status":"queued","position":1,"url":"…"}

# 2. Poll every few seconds; when status is done you get the manifest and a URL for every file
curl https://holocard.longsizhuo.com/v1/cards/3f1c… -H "Authorization: Bearer hc_your_key"

# 3. Download the files (manifest and every layer), with the key as well
curl -O https://holocard.longsizhuo.com/v1/cards/3f1c…/files/manifest.json -H "Authorization: Bearer hc_your_key"
curl -O https://holocard.longsizhuo.com/v1/cards/3f1c…/files/layer-0.webp -H "Authorization: Bearer hc_your_key"
```

A card usually takes 30–60 seconds, longer when there is a queue. **Files are deleted 24 hours after submission**, so download them to your own server.

## Getting a key

1. On [HoloCard](https://holocard.longsizhuo.com/?lang=en), click “Sign in” at the top right and sign in with an involutionhell account (you can create one with GitHub).
2. Click your avatar to open your account panel, and under “Public API” click “Request an API key”.
3. The key looks like `hc_` plus 32 characters and is **shown only once** — copy it somewhere safe. If you lose it, revoke it and request a new one.

Each account has one working key at a time; revoking takes effect immediately. Send it in a header:

```http
Authorization: Bearer hc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

::: warning
The key is your identity: keep it on your server, never in front-end code or a public repository.
:::

## Endpoints

All under `https://holocard.longsizhuo.com`, returning JSON. Errors look like `{"error": "message", "code": "error_type"}`.

### `POST /v1/cards` — submit an image

The request body is the image itself (not a form), with the image type as `Content-Type`. JPEG, PNG, WebP, AVIF and HEIC up to 16MB. EXIF is stripped and the image is rotated upright.

Returns `202`:

```json
{ "id": "3f1c…", "status": "queued", "position": 1, "url": "https://holocard.longsizhuo.com/v1/cards/3f1c…" }
```

### `GET /v1/cards/{id}` — progress and result

| field | |
|---|---|
| `status` | `queued`, `running`, `done` or `failed` |
| `position` | place in the queue, counting this card |
| `eta` | estimated seconds left (while queued or running) |
| `expiresAt` | when the files are deleted |
| `manifest` | when done: the card manifest, see [File format](#file-format) |
| `files` | when done: file name → download URL |
| `error.code` | when failed: `nsfw_rejected` (nude photo), `moderation_unavailable` (screening temporarily unavailable) or `processing_failed` |

### `GET /v1/cards/{id}/files/{name}` — download a file

`manifest.json`, the layer images `layer-N.webp` (a few older cards use `.png`) and the EXIF-stripped original. Use the names listed in `files`.

### `DELETE /v1/cards/{id}` — delete early

Deletes the files right away and returns `{"deleted": true}`, also for cards still in the queue.

### Notes

- Only the key that submitted a card can read, download or delete it; anything else returns `404`.
- API cards are private: they never appear on the site and cannot be shared or exported there.
- The result is delivered after nudity screening; fully nude photos are rejected (`nsfw_rejected`). Swimwear and similar are fine.
- People using the website go first; API jobs queue behind them.

## Limits and errors

| status | code | meaning |
|---|---|---|
| 401 | | missing, wrong or revoked key |
| 404 | `card_not_found` / `file_not_found` | no such card, not yours, deleted or expired |
| 413 | `too_large` | image over 16MB |
| 415 | `unsupported_image` | not a recognisable image |
| 429 | `quota_exceeded` | 24-hour quota reached: 20 cards per account for self-service keys (revoking and requesting a new key does not reset it) |
| 429 | `too_many_in_flight` | at most 3 cards per key uploading, queued or processing at once |
| 429 | `rate_limited` | more than 30 submit attempts in 10 minutes |
| 503 | `api_daily_limit` / `queue_full` / `busy` | today's API total is used up, or the queue is full — try again later |
| 507 | `disk_full` | server out of space, try again later |

Need a higher quota? Contact the site owner.

## On your page

The downloaded files need our player to move. It is the npm package [`@holocard/player`](https://www.npmjs.com/package/@holocard/player), a standard custom element that works in plain HTML, React or Vue.

1. Put `manifest.json` and the layer images in one folder on your server, keeping the file names, e.g. `/cards/my-card/`.
2. Add to your page:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@holocard/player@0.1/dist/holocard.js"></script>
<holo-card src="/cards/my-card"></holo-card>
```

With a bundler: `npm install @holocard/player`, then `import '@holocard/player'`.

| | |
|---|---|
| `src` | the card folder, or its `manifest.json`. On another domain, that server must allow CORS |
| `gyro` | follows phone tilt by default; `gyro="off"` turns it off. iOS asks for permission on the first tap |
| size | set a width on `holo-card` (default 320px); the height follows the card's aspect ratio |
| events | `load` when the card is shown; `error` on failure, with the reason in `event.detail.error` |

Styles live in a shadow root, isolated from your page. In production, pin an exact version (for example `@0.1.0`).

## File format

A card is a folder: `manifest.json` plus one image per layer, ordered far to near, each the size of the original with transparency. The manifest looks roughly like this:

```json
{
  "version": 1,
  "source": { "width": 1400, "height": 788 },
  "layers": [
    { "file": "layer-0.webp", "depth": 0.13, "parallax": 0, "bbox": [0, 0, 1400, 788], "foil": { "type": "sunpillar", "intensity": 1 } },
    { "file": "layer-1.webp", "depth": 0.62, "parallax": 1, "bbox": [310, 0, 1090, 788], "foil": { "type": "none", "intensity": 1 } }
  ],
  "effects": {
    "halo": { "intensity": 0.35, "light": { "peakAt": [0.7, -0.7], "sharpness": 120 } },
    "glare": true,
    "parallax": { "enabled": true, "amplitude": 0.1 }
  }
}
```

Foils, glare and parallax are all in the manifest and the player follows them; you normally don't edit it.
