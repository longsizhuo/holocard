# The `.layers` file format

`.layers` is HoloCard's intermediate format: the layering pipeline produces it, and the website's renderer and [`@holocard/player`](/en/player/) read it. The format decouples the layering algorithm from card rendering, so anything that produces it (including layers cut by hand in an image editor) can be fed to the renderer. Results delivered by the [API](/en/api/) use the same format.

The format is defined in `src/format/types.ts`; reading and validation are in `src/format/io.ts`; validation of editable fields is in `src/format/config.ts`.

## Directory layout

A card is a directory containing one `manifest.json` and one image per layer:

```
mycard.layers/
├── manifest.json
├── layer-0.webp      # farthest
├── layer-1.webp
└── layer-2.webp      # nearest
```

- Every layer image has the same size as the original and an alpha channel; stacked far to near in `manifest.json` order, the layers reproduce the original image.
- A layer's alpha channel is both the layer's shape and the mask for that layer's foil.
- Images can be in any format the browser can decode. The server produces WebP (lossy color, lossless alpha).
- File names are free-form but must be plain names in the same directory as `manifest.json`, with no path separators and no `..`.

## manifest.json

### Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | number | Yes | Format version; must currently be `1`, any other value is rejected |
| `source` | object | Yes | Original image size, see below |
| `layers` | array | Yes | Layers, at least one, see below |
| `effects` | object | No | Card-wide effects; defaults apply when missing, see below |
| `generator` | string | No | Producer identifier for troubleshooting, e.g. `holocard-web/0.1.0 depth-anything-v2-small layers=2` |

### `source`

| Field | Type | Required | Description |
|---|---|---|---|
| `source.width` | number | Yes | Original width in pixels |
| `source.height` | number | Yes | Original height in pixels |

The renderer uses `width / height` as the card's aspect ratio.

### `layers[]`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `file` | string | Yes | — | Layer image file name, relative to the directory of `manifest.json` |
| `depth` | number | Yes | — | Representative depth of the layer; `0` is farthest, `1` is nearest |
| `parallax` | number | No | Same as `depth` | Parallax coefficient; see "How the player and the website use these fields" |
| `bbox` | `[x, y, w, h]` | Yes | — | Bounding box of the layer's non-transparent pixels, in pixel coordinates, 4 numbers |
| `inpainted` | boolean | No | `false` | Whether occluded areas of the layer have been filled; only `true` counts as filled |
| `foil` | object | No | By layer order, see below | The layer's foil |
| `foil.type` | string | Yes (when `foil` is present) | — | Foil type; see "Foil types" |
| `foil.intensity` | number | No | `1` | Foil strength, 0–1; out-of-range values are clamped |

On load, `layers` is re-sorted by ascending `depth`, so `layers[0]` is always the farthest layer regardless of the order in the file.

When `foil` is missing or `foil.type` is invalid, a default is assigned by layer order:

| Layer count | Farthest | Middle | Nearest |
|---|---|---|---|
| 1 | `sunpillar`, intensity 1 | — | — |
| 2 or more | `sunpillar`, intensity 1 | `holo`, intensity 0.8 | `none`, intensity 1 |

### `effects`

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `effects.halo.intensity` | number | `0.35` | 0–1 | Card-wide halo strength; `0` turns it off |
| `effects.halo.light.peakAt` | `[nx, ny]` | `[0.7, -0.7]` | each -1 to 1 | Pointer position where the halo is strongest; `[0, 0]` is the card center. The default light source is at the top right |
| `effects.halo.light.sharpness` | number | `120` | 10–400 | Sharpness of the angle window; higher values make the halo appear over a narrower tilt range |
| `effects.glare` | boolean | `true` | — | Whether the pointer-following glare is shown; only `false` turns it off |
| `effects.parallax` | object | none | — | Parallax setting saved by the author; optional |
| `effects.parallax.enabled` | boolean | — | — | Parallax on or off |
| `effects.parallax.amplitude` | number | — | 0–0.16 | Parallax amplitude as a fraction of card width; kept when the switch is off |

`effects.parallax` is used only when it is complete and valid (`enabled` is a boolean and `amplitude` is between 0 and 0.16); otherwise it is treated as never saved.

## Foil types

Values of `foil.type` (`FOIL_TYPES`):

| Value | Name on the website | Effect | Upstream recipe (pokemon-cards-css) |
|---|---|---|---|
| `none` | Matte (no foil) | No foil; corresponds to a subject covered with opaque ink on a real card | — |
| `holo` | Classic holo | Diagonal rainbow, fine scan lines and vertical grating | rare holo |
| `sunpillar` | Sunpillar | Diagonal sun-pillar rainbow with metallic grain | rare holo v |
| `rainbow` | Rainbow glitter | Glitter with a multi-color gradient | rare rainbow |

## Example

The sample card on the website's home page (`public/samples/demo/manifest.json`), with two layers and no saved parallax setting:

```json
{
  "version": 1,
  "source": { "width": 1400, "height": 788 },
  "generator": "holocard-web/0.1.0 depth-anything-v2-small layers=2 cuts=[0.251@0.137]",
  "layers": [
    {
      "file": "layer-0.webp",
      "depth": 0.13380292057991028,
      "parallax": 0,
      "bbox": [0, 0, 1400, 788],
      "inpainted": true,
      "foil": { "type": "sunpillar", "intensity": 1 }
    },
    {
      "file": "layer-1.webp",
      "depth": 0.5165139436721802,
      "parallax": 1,
      "bbox": [436, 59, 832, 729],
      "inpainted": false,
      "foil": { "type": "none", "intensity": 1 }
    }
  ],
  "effects": {
    "halo": { "intensity": 0.35, "light": { "peakAt": [0.7, -0.7], "sharpness": 120 } },
    "glare": true
  }
}
```

After the owner adjusts and saves the card on the website, `effects` also contains `parallax`, for example:

```json
"parallax": { "enabled": true, "amplitude": 0.1 }
```

## How the player and the website use these fields

The website's renderer and `@holocard/player` share the same rendering code (`src/renderer/`) and treat every field the same way; they differ only in the parallax amplitude used when `effects.parallax` is missing.

| Field | Use |
|---|---|
| `source.width` / `source.height` | Card aspect ratio |
| `layers[].depth` | Front-to-back order; used as the parallax coefficient when `parallax` is missing |
| `layers[].parallax` | Each layer's shift = (`parallax` − focal plane) × amplitude. The focal plane is the midpoint of the smallest and largest `parallax`, so near layers move outward and far layers move inward. All layers are scaled by the same factor, 1 + 2 × largest offset × amplitude, so no blank edge shows. Adjacent layers with equal `parallax` form a group that moves together and shares one halo and glare |
| `layers[].file` | Layer image; its alpha channel is also the mask for the layer's foil |
| `layers[].foil` | The layer's foil type and strength; the foil appears only inside the layer's shape |
| `layers[].bbox` | Describes the extent of non-transparent pixels; not used by the current renderer |
| `layers[].inpainted` | Marks whether occluded areas were filled; not used by the current renderer. Layers that were not filled show holes when shifted far |
| `effects.halo` | Strength and angle window of the card-wide halo. While adjusting on the website, the card turns to the angle given by `peakAt` to show the effect |
| `effects.glare` | When `false`, the glare is not shown |
| `effects.parallax` | Present: both the website and the player follow it (amplitude 0 when `enabled` is `false`). Missing: the website uses the viewer's local "Parallax" preference with a 2% amplitude; the player uses its default amplitude of 0.02 |
| `generator` | Shown in the website's status line when processing finishes; not used for rendering |

### Author configuration

Only the following fields can be edited on the website and are saved with the card; together they form the author configuration (`CardConfig`). When the owner adjusts them in the panel, the website saves them to the server, which validates them and merges them into `manifest.json`. The share page, share preview image and exported animations are all rendered from the saved result.

| Author configuration | manifest field | Range |
|---|---|---|
| `foils[]` (one per layer, far to near) | `layers[].foil.type`, `layers[].foil.intensity` | One of `FOIL_TYPES`; 0–1 |
| `halo.intensity` | `effects.halo.intensity` | 0–1 |
| `halo.sharpness` | `effects.halo.light.sharpness` | 10–400 |
| `parallax.enabled`, `parallax.amplitude` | `effects.parallax` | boolean; 0–0.16 |

The number of foils must match the card's layer count, and the whole configuration is rejected if any value is invalid. Layer file names, depths, parallax coefficients, `peakAt` and other fields are set by the pipeline and cannot be changed through the website.

When `manifest.json` is read, `effects.halo.intensity` and `sharpness` are only required to be finite numbers and are not range-checked; the website clamps them to the ranges above when it extracts the author configuration from such a manifest.
