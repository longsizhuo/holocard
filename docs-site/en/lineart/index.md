# Line art

Line art turns an illustration into line art: the lines on a white background become lines on a transparent background, with a choice of line colour and the option to keep only the subject, downloaded as PNG.

Address: [holocard.longsizhuo.com/lineart](https://holocard.longsizhuo.com/lineart). It is a standalone tool, linked as "Line art" under "Tools" in the home page header.

## Usage

1. Click "Choose an image" and upload an illustration. JPEG, PNG, WebP, AVIF and HEIC are supported, up to 16 MB; images with a long side over 1024 pixels are scaled down first.
2. Processing takes about half a minute; the page shows "Working" meanwhile.
3. When done, the preview is on the left, with transparent areas shown as a checkerboard. On the right:

| Control | Effect | Values |
|---|---|---|
| "Line darkness" | The middle is the auto-levelled result; to the right faint lines turn black and lines get heavier, to the left only the strongest lines remain | 0–100, default 50 |
| "Line colour" | Colour of the lines | Any colour, default black |
| "Subject only" | Keeps only the lines on the subject and drops the background's; hidden when no subject is found | On / off, default on |

4. Click "Download PNG" to download the line art as previewed: transparent background, the same size as the processed image.

Results are deleted after 24 hours.

## How it works and its limits

The lines come from the improved version of [Anime2Sketch](https://github.com/Mukosame/Anime2Sketch) (MIT); the subject is matted by BiRefNet_lite (as in the [layering pipeline](/en/develop/pipeline)). Three things differ from the original project's usage:

- The original squashes images to a 512 square, which distorts lines on tall or wide images; here the image is scaled to a long side of 1024 with its aspect ratio kept, padded to a multiple of 256 on each side, and cropped back afterwards.
- The model's lines are often faint, by a different amount for each image. Levels are set from the image's own brightness: the darkest 1% becomes black and the median (the background) white, then "Line darkness" adjusts from there.
- Pixels below 5% opacity are treated as noise and dropped, so faint background texture does not turn into a haze.

The model is trained on anime-style illustrations and works best on flat colours with clear lines. On photos, painterly images and large dark areas the lines break up and dark regions may fill in; moving "Line darkness" to the left reduces the fill.

## API

The endpoints used by the page. No sign-in is needed; result addresses are random UUIDs:

| Request | Description |
|---|---|
| `POST /api/lineart` | Body is the image bytes; returns `202 { id }` |
| `GET /api/lineart/<id>` | Job status: `state` is `queued`, `done` or `error`; when done, also `width`, `height`, `subject` (whether there is a subject mask) and `files` |
| `GET /api/lineart/<id>/image.png` | The scaled-down original |
| `GET /api/lineart/<id>/line.png` | Greyscale line art (black lines on white, no levels applied) |
| `GET /api/lineart/<id>/subject.png` | Subject mask (greyscale, white is the subject); absent when `subject` is `false` |
