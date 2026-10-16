# Line art

Line art turns an illustration into line art: the lines on a white background become lines on a transparent background, with a choice of line colour and the option to keep only the subject, downloaded as PNG.

Address: [holocard.longsizhuo.com/lineart](https://holocard.longsizhuo.com/lineart). It is a standalone tool, linked as "Line art" under "Tools" in the home page header.

## Usage

1. Click "Choose an image" and upload an illustration. JPEG, PNG, WebP, AVIF and HEIC are supported, up to 16 MB; images with a long side over 1024 pixels are scaled down first.
2. Results usually take about 5 seconds. A cold start of the detection service (the first image after it has been idle) takes about a minute. When the detection service is unavailable the image is processed on the server itself: the line art appears after a few seconds and matting the subject takes about twenty seconds more; meanwhile the page shows "Finding the subject" and "Subject only" is unavailable, and the preview is redrawn with the subject once it is ready.
3. The preview is on the left, with transparent areas shown as a checkerboard. On the right:

| Control | Effect | Values |
|---|---|---|
| "Line darkness" | The middle is the auto-levelled result; to the right faint lines turn black and lines get heavier, to the left only the strongest lines remain | 0–100, default 50 |
| "Line colour" | Colour of the lines | Any colour, default black |
| "Subject only" | Keeps only the lines on characters and drops those of text, frames and background; every character in the picture counts; hidden when none is found | On / off, default on |

4. Click "Download PNG" to download the line art as previewed: transparent background, the same size as the processed image.

Results are deleted after 24 hours.

## How it works and its limits

Line art and subject are computed in one go by the detection service (`deploy/sam3/serve.py`, the same service as [effect detection](/en/develop/pipeline#server-side-effect-detection-sam3-card), running on a machine with a GPU):

- Line art: [MangaLineExtraction](https://github.com/ljsabc/MangaLineExtraction_PyTorch) (MIT), with the aspect ratio kept, a long side of 1024, padded to a multiple of 256 and cropped back.
- Subject: SAM 3 is asked for "character" and "person", and the masks of all characters are merged. Several people, expressions and turnarounds on a character sheet all count as subject; text and frames do not.

When the detection service is unavailable the server does it itself: the improved version of [Anime2Sketch](https://github.com/Mukosame/Anime2Sketch) (MIT) for the lines and BiRefNet_lite for the subject (which finds only the single most salient subject).

Adjustments on the page happen in the browser:

- The model's lines are often faint, by a different amount for each image. Levels are set from the image's own brightness: the darkest 1% becomes black and the median (the background) white, then "Line darkness" adjusts from there.
- Pixels below 5% opacity are treated as noise and dropped, so faint background texture does not turn into a haze.
- The subject mask edge is tightened over 0.35–0.65, so the soft fringe of a matte does not leave faint ghosts outside the subject.

Both line models are trained on anime-style art and work best on flat colours with clear lines. On painterly images, photos and large dark areas the lines break up and dark regions may fill in; moving "Line darkness" to the left reduces the fill. Very small text may blur.

## API

The endpoints used by the page. No sign-in is needed; result addresses are random UUIDs:

| Request | Description |
|---|---|
| `POST /api/lineart` | Body is the image bytes; returns `202 { id }` |
| `GET /api/lineart/<id>` | Job status: `state` is `queued`, `done` or `error`. It is `done` as soon as the line art is ready, with `width`, `height`, `files` and `subject`: `"pending"` while the subject is still being matted, `true` once the subject mask exists, `false` if there is none |
| `GET /api/lineart/<id>/image.png` | The scaled-down original |
| `GET /api/lineart/<id>/line.png` | Greyscale line art (black lines on white, no levels applied) |
| `GET /api/lineart/<id>/subject.png` | Subject mask (greyscale, white is the subject); only when `subject` is `true` |
