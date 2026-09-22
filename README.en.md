# HoloCard

[中文](README.md) | English

https://github.com/longsizhuo/holocard ｜ Live: https://holocard.longsizhuo.com

Upload a photo: it is split into foreground, midground and background, each layer gets its own holographic foil, and the result is an interactive holo card.

The foil effects and the interaction feel are ported from [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css)
(Simon Goellner, GPL-3.0). In that project every card needs a hand-made mask image that marks "where the foil shows through";
what HoloCard adds is **generating that mask automatically with a layering algorithm**, so any photo can become a holo card.

> Status: early. The renderer, the layering pipeline, edge refinement and server-side processing all work and are live: https://holocard.longsizhuo.com
> The site is available in Chinese, English and Japanese; finished cards can be saved as an iPhone Live Photo, an Android Motion Photo, or an animated PNG on desktop.

## What a card is made of

The structure mirrors how real holo cards are printed: the base is foil, the subject is covered with opaque ink so it stays matte, the background is not, so it shines.

| | Covers | Moves with parallax | When it shows |
|---|---|---|---|
| **Depth layers** | Each layer's own image | Yes, each with its own factor | Always |
| **Per-layer foil** | Only inside that layer's alpha shape | Yes, with its layer | As soon as you hover |
| **Card-wide halo** | The whole card | No | A faint rainbow, only at certain tilt angles |
| **Card-wide glare** | The whole card | No | Follows the pointer |

By default the farthest layer gets a sunpillar foil, the middle layer a classic holo foil, and the nearest layer (the subject) stays matte.
The demo page has a dropdown per layer to change it.

Each layer's image and foil are wrapped in the same container with a `transform`, which does two things: the foil naturally moves with its layer,
and the `transform` creates its own stacking context, so the foil's `color-dodge` only blends with **that layer's own image**
instead of bleeding into the layers behind it.

## Layering pipeline

```
photo
 └→ Depth Anything V2-Small ──→ continuous depth map (decides layer order)
      └→ cut at valleys of the depth histogram ──→ adaptive, 2–4 layers
           └→ depth-edge snapping + foreground growth ──→ object edges become clean steps
                └→ guided-filter refinement ──→ layer boundaries snap to real object edges in the photo
                     └→ per-layer alpha (which is also that layer's foil mask)
                          └→ per-layer completion + mirrored texture fill ──→ each layer extends behind the layers covering it
                               └→ .layers ──→ renderer
```

Each layer plays two roles at once: an image with parallax, and the mask for that layer's foil. So two kinds of information are needed:

- **What is in front** (ordering): from monocular depth estimation. A matting model only separates "subject / background" and cannot order three or more layers.
- **Where the boundary is** (mask quality): the mask edge is the foil edge, and a ragged edge is obvious at a glance.
  Depth maps are blurry at object edges and often shrink a few pixels into the object, so the boundary is refined separately, see "Edge refinement" below.

A few design decisions:

**Layer boundaries sit at valleys of the depth histogram instead of being evenly spaced.** Valleys are the distances where the scene has little content.
Cutting through content splits an object in two. The number of layers is computed too: many photos really only have two.

**Boundaries are feathered, not hard thresholds.** A hard cut glues a ring of background pixels onto the foreground layer, and that dirty ring floats with the subject once parallax kicks in.

**Depth edges are snapped into steps first.** A monocular depth map has a slope at object edges, and the middle of that slope falls right into
the "middle layer" range, forming a thin misclassified ring around the object that separates into a ghost as soon as it moves.
Morphological toggle mapping squashes steep slopes into steps; gentle surfaces with a small drop are left alone, since that is exactly where a smooth transition is wanted.

**The foreground grows outward a little.** Depth boundaries are always a few pixels off from real object edges, and usually shrink into the object;
the ring that shrinks in stays behind in the layer below, so when the object moves, its own outline is left in place.
Growing every nearer region outward by a few pixels makes object edges always travel with the object.

**Every layer except the front one is completed, not just the bottom one.** When the foreground moves away, what shows through should be a continuation of the layer right behind it.
How: for each covered pixel, find which layer the nearest visible pixel belongs to, and treat that layer as extending to it.
Completing only the bottom layer would make the middle layer end abruptly at the foreground's original outline, breaking both the image and the foil.

**The fill needs texture.** Foil uses `color-dodge` to light up bright pixels of the underlying image, and flat color patches do not light up.
So the fill mirrors real pixels from the other side of the boundary around the nearest source pixel; a push-pull smooth fill is only the fallback.
No neural network is involved: parallax offsets are only a few dozen pixels, so what gets revealed are thin strips, not big holes.

## Edge refinement

A **guided filter** snaps layer boundaries to real object edges in the photo. No download, pure JS, works on any image.

Principle: in each local window, assume the refined alpha is a linear function of the guide image, `q = a·I + b`, fitted to the coarse mask by least squares.
Where the guide has an edge, the alpha jumps along that edge; where the guide is flat, there is nothing to fit.
On top of the standard method there are two safeguards, because we only want to fix "the layer boundary", not do general smoothing:

- It only acts inside the **uncertainty band** on both sides of a layer boundary; everything outside is left as is
- The local goodness of fit **R²** is used as confidence. If the linear model cannot explain a boundary, the photo has no edge there
  (for example where near ground meets midground ground), so it is left alone

Refinement works on "boundaries", not on "layers": once a boundary is fixed, the layers on both sides benefit, and their alphas are complementary by construction.
Two pitfalls only showed up after refinement was added:

- Layer alphas must be built from boundary masks by **subtraction**, `A₀ − A₁`, not multiplication `A₀·(1 − A₁)`.
  Boundaries are nested: an edge pixel covered by the foreground to degree t has value t for both boundaries. Subtraction gives the middle layer 0,
  multiplication gives `t(1−t)`, which conjures a ring for the middle layer along every soft edge. On hard edges they are the same, which is why it went unnoticed.
- When two boundaries fall on the same object edge (a head directly against the sky, with no middle layer nearby), they must **share the same refined edge**,
  otherwise each is refined separately, the soft edges differ, and subtracting still leaves a ring.

The guide is replaceable. It is currently the photo's RGB; anything that produces a foreground alpha can be added as an extra guide channel
(`ExtractOptions.extraGuide`) without changing the algorithm.

### Why not BiRefNet

The original plan was to use BiRefNet_lite (MIT, fp16 about 109MB) to produce a foreground alpha for refinement. In practice it does not run in the browser;
all four routes were tried:

| Route | Result |
|---|---|
| WebGPU | The model has a 16-way Concat; a single shader would bind 17 storage buffers, the adapter limit is 16 |
| WASM, 1024 input | `std::bad_alloc`, the activations do not fit in the 32-bit WASM heap |
| WASM, arena allocator off | Same as above |
| WASM, 512 / 768 input | This ONNX export has the input fixed at 1024×1024 and rejects other sizes |

To reproduce: `node scripts/probe-matte.mjs --image path/to/photo`.

Actually using it would require re-exporting the model: split that wide Concat into two levels, or free up the input size. `src/segmenter/matte.ts` is kept,
with a capability check that decides **before downloading any weights** whether this machine can run it, and refuses right away if not, so no bandwidth is wasted.

A guided filter that uses color as the guide has a ceiling: **outlines whose color is close to the background cannot be separated**
(a black outline on a dark background gets pulled toward the background by the linear color model), and fine semi-transparent structures like hair are not as good as with a dedicated matting model.

## Renderer

The interaction feel matches upstream point by point:

- **Spring-driven**: one spring each for rotation, glare and background offset; while following the pointer `stiffness 0.066 / damping 0.25`;
  after release it waits 500ms, then eases back with a very soft spring (`0.01 / 0.06`, soft start).
  The spring semantics match svelte/motion, so upstream's tuned parameters can be used as is.
- **Rotation mapping**: `rotateY(-(x-50)/3.5) rotateX((y-50)/3.5)`, up to about ±14.3°, perspective 600px.
  The side under the pointer lifts toward the viewer.
- **Background offset is narrowed** to 37%–63% / 33%–67%, so the foil pattern drifts slightly instead of sweeping across the whole card.
- **`--pointer-from-center`** modulates brightness: the foil gets brighter toward the edges of the card.

CSS variable names (`--pointer-x`, `--background-x`, `--card-opacity` and so on) deliberately match upstream,
so more rarities can be ported later by pasting their recipes into `foils.css`.

The two textures (grain / glitter) are generated procedurally at runtime; the repository has no binary assets for them.

The parts that are our own:

**Parallax does not use `translateZ`.** It introduces perspective scaling and the layer sizes stop matching. Instead each layer gets its own 2D offset,
proportional to that layer's parallax factor. Near layers move opposite to the pointer: lifting the right edge is like the viewer stepping to the right,
so nearby things shift left relative to far ones. A layer shifted by d pixels reveals a gap on the other side, so each layer is scaled up by `1 + 2d/width` to compensate.

**The card-wide halo is an angle event.** The card's surface normal is derived from the current rotation and dotted with the orientation that "reflects the light into the eye",
with a wide and a narrow lobe added together. With the default parameters the intensity is 0.12 at rest, 1.00 at the peak tilt, 0.01 at the opposite tilt.

**`setPose({x, y})`** puts the card straight into a pose without animation, for rendering static previews
or driving it from external input such as a gyroscope.

## The `.layers` format

This format decouples the algorithm from the renderer. Anything that produces it can feed the renderer, and the renderer can be used on its own:
layers cut by hand in Photoshop render just as well.

```
mycard.layers/
├── manifest.json
├── layer-0.png      # farthest
├── layer-1.png
└── layer-2.png      # nearest
```

```json
{
  "version": 1,
  "source": { "width": 734, "height": 1024 },
  "layers": [
    {
      "file": "layer-0.png", "depth": 0.08, "parallax": 0.0,
      "bbox": [0, 0, 734, 1024], "inpainted": true,
      "foil": { "type": "sunpillar", "intensity": 1 }
    },
    {
      "file": "layer-2.png", "depth": 0.92, "parallax": 1.0,
      "bbox": [120, 80, 500, 900], "inpainted": false,
      "foil": { "type": "none", "intensity": 1 }
    }
  ],
  "effects": {
    "halo": { "intensity": 0.35, "light": { "peakAt": [0.7, -0.7], "sharpness": 120 } },
    "glare": true
  }
}
```

Layer images can be any format the browser can decode; the server stores them as WebP (lossy image, lossless alpha), about a tenth of the PNG size.

`foil.type` currently has four values: `none` (matte), `holo` (classic holo), `sunpillar` (V-card sunpillar), `rainbow` (rainbow glitter).

## Running it

```bash
pnpm install
pnpm dev           # frontend, fixed at port 5273
pnpm dev:server    # in another terminal: the layering service, listens on 8791
```

The demo page loads a pre-layered sample card by default (`public/samples/demo`, the same card as in the social preview); dropping a photo runs the whole pipeline.
`pnpm dev` proxies `/api` to 8791; without the server it still works and falls back to the in-browser pipeline.

The server needs the weights locally on first run:

```bash
D=.models/onnx-community/depth-anything-v2-small
mkdir -p $D/onnx
B=https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main
curl -sL $B/config.json -o $D/config.json
curl -sL $B/preprocessor_config.json -o $D/preprocessor_config.json
curl -sL $B/onnx/model_quantized.onnx -o $D/onnx/model_quantized.onnx
HOLOCARD_MODEL_DIR=$PWD/.models pnpm dev:server
```

Recording a demo GIF (needs Edge and ffmpeg on the machine, and the dev servers running):

```bash
pnpm capture --image path/to/photo --out out/demo.gif
```

The script drives headless Edge through the real upload path, then poses the card frame by frame with `setPose` and takes screenshots, so every frame is deterministic.
Add `--dump` to also export every layer as PNG, which helps when debugging layering; add `--no-gif` if you only want the layers.

### Tuning the share image

```bash
pnpm og                    # render a share image from scripts/fixtures/og-test.jpg to out/og-preview.jpg and open it
pnpm og path/to/photo      # use another photo
pnpm og --watch            # re-render on save when styles or code under src/ change (about 2 seconds)
pnpm og --pose 20,80       # look at the foil and halo from another angle
pnpm og --size 1280x640    # the size of a GitHub repository social preview
pnpm og --lang en          # English copy on the right (en / ja)
pnpm og --export live      # export a Live Photo (or motion / apng) to out/export/
```

It is the same rendering as production: the frontend is built on the spot and the screenshot calls the server's `renderPreview`, so what you see here is exactly what gets shared.
Layering results are cached in `.og-cache/` by image hash, so the model does not re-run while you tweak styles. Needs the weights under `.models/`.
