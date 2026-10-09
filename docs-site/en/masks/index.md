# Card masks

Card masks split a finished flat card image into foil masks for renderers that control the foil area with masks, such as [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css). Unlike HoloCard's main feature, the input is a finished card with its frame and text rather than a photo, and the output is a set of mask images rather than parallax layers.

Open it at [holocard.longsizhuo.com/masks](https://holocard.longsizhuo.com/masks?lang=en), or with "Card masks" in the header of the home page.

## Usage

1. Click "Choose a card image" and upload the card. JPEG, PNG, WebP, AVIF and HEIC up to 16 MB are accepted; images whose long side exceeds 1400 pixels are scaled down first.
2. Processing takes about a minute; the page shows "Working" meanwhile.
3. When it finishes, the left side shows a preview card. Select where the foil goes and the foil type on the right; the preview updates accordingly.
4. The masks are listed below and can be downloaded one by one. "Download this combination" downloads a single mask combined from the selected regions.

## Output

Each mask has the same size as the card image and is a grayscale-plus-alpha PNG with both channels equal: white (opaque) marks the region. CSS `mask-image` uses alpha by default; using luminance (`mask-mode: luminance`) gives the same result.

| Mask | Content |
|---|---|
| Frame and text | The card outside the art window, plus detected text (including text inside the window); on full-art cards, the outer card border plus text |
| Character | The subject inside the art window; on full-art cards without a window, the whole card is used |
| Effects | Bright, saturated areas touching the character (flames, energy balls and the like), plus a band just inside the character's outline |
| Text | Detected text on its own, so it can be subtracted in combinations |

"Background" in the page preview is the part of the art window outside the character and effects; there is no separate file for it.

## Combinations

The foil on different rarities of physical cards roughly corresponds to different combinations of these masks. For Pokémon cards, compared with the official masks:

| Rarity | Foil area |
|---|---|
| Rare Holo | Background (window − character − effects) |
| Reverse Holo | Frame and text (outside the window; the text box is foiled as well) |
| V / VMAX / VSTAR | Everything except character, effects and text; on some cards the character is foiled too, depending on the card design |
| Secret Rare | Everything except character and text |
| Radiant | Outside the window, plus the character |

Cards of the same rarity can differ; follow the card design.

## How detection works and its limits

- **Art window**: no model. Long straight edges spanning most of the card's width form candidate rectangles; the window is chosen by how complete its edges are and whether its content looks like artwork. It assumes the window is in the upper half of the card, which holds for Pokémon, Magic and Yu-Gi-Oh!; when no window is found the card is treated as full art, and "Frame and text" is the outer area matching the card border colour plus the text.
- **Character**: BiRefNet_lite matting. On busy full-art cards, most of the image may be taken as the subject.
- **Effects**: rules, no model. When the background itself is bright and saturated (a sheet of flames, for example), too much or too little may be included.
- **Text**: the PaddleOCR PP-OCRv4 text detector, which locates text without reading it.

Evaluation results on public card images are described under `cardmask-eval` in [Local development](/en/develop/).

## Privacy and retention

Uploaded cards and generated masks are not stored in the database and are not public; their addresses are random and they are deleted after 24 hours. Processing runs on the HoloCard server and nothing is sent to third parties.
