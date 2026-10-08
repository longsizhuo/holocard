# HoloCard API

The HoloCard API converts a photo into a layered holographic card and returns a card manifest together with the layer images. Use [`@holocard/player`](/en/player/) to render the result on any web page.

## Quick start

The workflow has four steps:

1. Obtain an API key.
2. Submit an image.
3. Poll the job status and download the result files once it completes.
4. Display the card on a web page with the player.

```bash
# 1. Submit an image (replace photo.jpg with a local file path; for PNG images set Content-Type to image/png)
curl -X POST https://holocard.longsizhuo.com/v1/cards \
  -H "Authorization: Bearer hc_xxx" \
  -H "Content-Type: image/jpeg" --data-binary @photo.jpg
# Response: 202 {"id":"3f1c…","status":"queued","position":1,"url":"…"}

# 2. Query the job status (poll every few seconds; when status is done, the response includes the manifest and file URLs)
curl https://holocard.longsizhuo.com/v1/cards/3f1c… -H "Authorization: Bearer hc_xxx"

# 3. Download the result files (manifest and layer images; the API key is required)
curl -O https://holocard.longsizhuo.com/v1/cards/3f1c…/files/manifest.json -H "Authorization: Bearer hc_xxx"
curl -O https://holocard.longsizhuo.com/v1/cards/3f1c…/files/layer-0.webp -H "Authorization: Bearer hc_xxx"
```

Processing typically takes 30–60 seconds per image and longer when jobs are queued. **Result files are deleted 24 hours after submission**; download and store them yourself.

## Obtaining an API key

1. Go to [HoloCard](https://holocard.longsizhuo.com/?lang=en), select **Sign in** in the top-right corner and sign in with an involutionhell account (registration via GitHub is available).
2. Open the account panel from your avatar and select **Request an API key** under **Public API**.
3. The key starts with `hc_` and is displayed only once. Store it securely; if it is lost, simply request another and revoke the ones no longer in use.

Each account can hold up to 10 active API keys at a time, all sharing one quota. Revocation takes effect immediately. Send the key in the request header:

```http
Authorization: Bearer hc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

::: warning Security
The API key identifies your account. Use it only on your server; never embed it in client-side code or commit it to a public repository.
:::

## Endpoints

The base URL is `https://holocard.longsizhuo.com`. Responses are JSON. Failed requests return:

```json
{ "error": "description", "code": "error_type" }
```

### `POST /v1/cards` Submit an image

The request body is the raw image (not a form), with the image MIME type as `Content-Type`. Supported formats are JPEG, PNG, WebP, AVIF and HEIC, up to 16 MB. EXIF metadata is removed and the image is rotated according to its orientation.

On success the API returns `202 Accepted`:

```json
{ "id": "3f1c…", "status": "queued", "position": 1, "url": "https://holocard.longsizhuo.com/v1/cards/3f1c…" }
```

### `GET /v1/cards/{id}` Job status and result

| Field | Description |
|---|---|
| `status` | Job status: `queued`, `running`, `done` or `failed` |
| `position` | Position in the queue, including this job |
| `eta` | Estimated seconds remaining; returned while queued or running |
| `expiresAt` | Time at which the result files are deleted |
| `manifest` | Card manifest, returned when done; see [File format](/en/format/) |
| `files` | Map of file names to download URLs, returned when done |
| `error.code` | Failure reason, returned when failed: `nsfw_rejected` (nudity detected), `moderation_unavailable` (content screening temporarily unavailable) or `processing_failed` |

### `GET /v1/cards/{id}/files/{name}` Download a file

Available files are `manifest.json`, the layer images `layer-N.webp` (cards created early on use `.png`) and the original image with EXIF removed. Use the file names listed in `files`.

### `DELETE /v1/cards/{id}` Delete a card

Deletes all files of the card immediately and returns `{"deleted": true}`. Queued jobs are cancelled.

### Notes

- A card is visible only to the API key that submitted it. Requests for cards of other keys, or for deleted or expired cards, return `404`.
- Cards created through the API are not published on the website and cannot be shared or exported there.
- Results are screened for nudity before delivery; fully nude images are rejected (`nsfw_rejected`).
- Website users are served first; API jobs are queued behind them.

## Quotas and error codes

| Status | code | Description |
|---|---|---|
| 401 | — | Missing, invalid or revoked API key |
| 404 | `card_not_found` / `file_not_found` | The card does not exist, belongs to another key, or has been deleted or expired |
| 413 | `too_large` | The image exceeds 16 MB |
| 415 | `unsupported_image` | Unrecognized image format |
| 429 | `quota_exceeded` | 24-hour quota exceeded: 20 cards per account for self-service keys, counted across all of the account's keys (requesting a new key does not reset it) |
| 429 | `too_many_in_flight` | At most 3 jobs per key may be uploading, queued or processing at the same time |
| 429 | `rate_limited` | More than 30 submissions within 10 minutes |
| 503 | `api_daily_limit` / `queue_full` / `busy` | The daily API capacity is exhausted or the queue is full; retry later |
| 507 | `disk_full` | Insufficient server storage; retry later |

For a higher quota, contact the site administrator.
