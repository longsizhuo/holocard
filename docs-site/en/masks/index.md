# Card masks

Card masks split a finished flat card image into foil masks for renderers that control the foil area with masks, such as [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css). Unlike HoloCard's main feature, the input is a finished card with its frame and text rather than a photo, and the output is a set of mask images rather than parallax layers.

Open it at [holocard.longsizhuo.com/masks](https://holocard.longsizhuo.com/masks?lang=en). It is a separate tool for trading cards and has no link on the home page.

## Usage

1. Click "Choose a card image" and upload the card. JPEG, PNG, WebP, AVIF and HEIC up to 16 MB are accepted; images whose long side exceeds 1400 pixels are scaled down first.
2. Processing takes about a minute; the page shows "Working" meanwhile.
3. When it finishes, the left side shows a preview card. Select where the foil goes and the foil type on the right; the preview updates accordingly.
4. The masks and a region overview are listed below and can be downloaded one by one. "Download this combination" downloads a single mask combined from the selected regions.

## Output

There are six masks and they do not overlap: at every pixel their values add up to exactly 255. Adding any of them together therefore gives their union, with no gaps or double coverage at the seams, and the soft edge of the character is preserved.

Each mask has the same size as the card image and is a grayscale-plus-alpha PNG with both channels equal: white (opaque) marks the region. CSS `mask-image` uses alpha by default; using luminance (`mask-mode: luminance`) gives the same result.

| Mask | Content |
|---|---|
| Border | The outermost strip in the card border colour (the yellow or silver edge of Pokémon cards) |
| Frame | The card outside the art window and inside the border: name bar, text box, bottom bar. On full-art cards, the area outside the inner panel; empty when there is neither a window nor a panel |
| Text | Detected text, including text inside the window and text printed over the artwork |
| Character | The subject inside the art window; on full-art cards, inside the inner panel; otherwise the whole card |
| Effects | Bright, saturated areas touching the character (flames, energy balls and the like), plus a band just inside the character's outline |
| Background | The part of the window (or panel) outside the character, effects and text |

Where regions overlap, the pixel goes to the first in the order text > effects > character > border > frame; the background takes the rest.

A region overview, `labels.png` (RGB), colours each pixel by the mask with the largest value, for viewing and for programs to read.

| Colour | RGB | Region |
|---|---|---|
| Grey | 148, 163, 184 | Border |
| Blue | 59, 130, 246 | Frame |
| Orange | 245, 158, 11 | Text |
| Red | 239, 68, 68 | Character |
| Purple | 168, 85, 247 | Effects |
| Green | 34, 197, 94 | Background |

When the job is done, `GET /api/cardmask/<id>` also returns the layout: `window` is the art window and `panel` the inner panel of a full-art card (both normalized to the card size, `null` when absent); `lines` lists each detected line of text with its position and role: `name` (left of the name bar), `hp` (right of the name bar), `body` (attacks and effect text), `footer` (bottom bar, number, copyright) or `art` (text inside the artwork).

## Combinations

The foil on different rarities of physical cards roughly corresponds to different combinations of these masks. For Pokémon cards, compared with the official masks:

| Rarity | Foil area |
|---|---|
| Rare Holo | Background; add effects when flames or light in the artwork are foiled too |
| Reverse Holo | Frame + text (the border is not foiled) |
| V / VMAX | Border + frame + background; on some cards the character is foiled too, so add character and effects |
| VSTAR | Background (only the inner panel is foiled); add character and effects when the character is foiled |
| Secret Rare | Border + frame + background + effects |
| Radiant | Border + frame + text + character + effects |

Cards of the same rarity can differ; follow the card design.

## How detection works and its limits

The elements of a trading card sit in roughly fixed places, and detection relies on that (a layout prior):

- **Art window and inner panel**: no model. Long straight edges spanning most of the card's width form candidate rectangles; the window is chosen by how complete its edges are and whether its content looks like artwork. It assumes the window is in the upper half of the card, which holds for Pokémon, Magic and Yu-Gi-Oh!. A rectangle that touches the border on both sides and is taller than half the card is not a window but the outer frame line of a full-art card; the inner panel is looked for instead: about 4% in from each side, its top just below the name bar, about 77–80% of the card height. With neither, the whole card is treated as artwork.
- **Text**: the PaddleOCR PP-OCRv4 text detector, which locates text without reading it. Detected lines get a role by position: above the window (or panel) is the name bar, below it the text box, at the very bottom the bottom bar; on full-art cards, text in the upper half is treated as part of the artwork.
- **Character**: BiRefNet_lite matting. On full-art cards the matting model often takes the attack boxes or energy balls in the lower half as the subject, while the character on a real card rarely extends into the text box, so the character fades out downwards from the topmost line of attack text. On busy artwork, most of the image may still be taken as the subject.
- **Border**: the connected area near the edges whose colour is close to the median colour of the image edges. Borders whose colour varies strongly (holographic silver, for example) may be picked up only in part.
- **Effects**: rules, no model. When the background itself is bright and saturated (a sheet of flames, for example), too much or too little may be included.

Evaluation results on public card images are described under `cardmask-eval` in [Local development](/en/develop/).

## Privacy and retention

Uploaded cards and generated masks are not stored in the database and are not public; their addresses are random and they are deleted after 24 hours. Processing runs on the HoloCard server and nothing is sent to third parties.
