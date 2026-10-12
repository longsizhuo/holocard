---
name: holocard-card-masks
description: Split a finished trading-card image into per-region masks (border, frame, text, character, effects, background) with the HoloCard API, for applying different holographic foil effects to each region. Use when the user wants foil/holo masks, layer masks or region masks for a card design.
---

# HoloCard card masks

Calls `https://holocard.longsizhuo.com/v1/masks`. Full reference: https://holocard.longsizhuo.com/docs/en/api/

## Requirements

- An API key (`hc_…`) from https://holocard.longsizhuo.com/docs/en/api/#obtaining-an-api-key. Read it from the `HOLOCARD_API_KEY` environment variable; never write it into files or logs.
- A flat card image (JPEG, PNG, WebP, AVIF or HEIC, at most 16 MB).

## Steps

1. Submit the image as the raw request body (not a form):

   ```bash
   curl -sS -X POST https://holocard.longsizhuo.com/v1/masks \
     -H "Authorization: Bearer $HOLOCARD_API_KEY" \
     -H "Content-Type: image/png" --data-binary @card.png
   ```

   The response is `202 {"id": "…", "status": "queued", "url": "…"}`.

2. Poll `GET /v1/masks/{id}` with the same header every 3–5 seconds until `status` is `done` or `failed`. A card usually takes 20–40 seconds.

3. When done, download what the user needs from the `files` map. Each URL needs the same header:

   | File | Content |
   |---|---|
   | `border.png` | Card border |
   | `frame.png` | Frame |
   | `text.png` | Text |
   | `character.png` | Main character |
   | `effects.png` | Effects (rule-based for now, limited coverage) |
   | `background.png` | Background |
   | `labels.png` | Color-coded overview of all regions |
   | `card.png` | The card, scaled so its long side is at most 1400 px |

   Masks are grayscale-plus-alpha PNGs at the size of `card.png`; they do not overlap and together cover the card. They work directly as a CSS `mask-image`.

4. Results are deleted 24 hours after submission, so save the files locally.

## Errors

| Status | Meaning | What to do |
|---|---|---|
| 401 | Missing, invalid or revoked key | Ask the user for a valid key |
| 404 | Masks expired or belong to another key | Submit again |
| 413 / 415 | Image too large / unsupported format | Convert or downscale, then submit again |
| 429 | Too many submissions in 10 minutes | Wait a few minutes, then retry |
| 503 | Mask queue full or server busy | Retry after a minute |

`status: failed` with `error.code: processing_failed` means the image could not be processed; tell the user rather than retrying in a loop.
