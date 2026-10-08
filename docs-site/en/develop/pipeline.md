# Layering pipeline and edge refinement

The layering pipeline cuts a photo into layers ordered from far to near and outputs `.layers` (a manifest plus one transparent image per layer). The code is in `src/segmenter/`, and the server and the browser share the same implementation: in production it runs in the layering service's worker thread with sharp for image codecs; only deployments without a layering service run it in the browser. For the module layout see [Architecture](/en/develop/architecture).

## Flow

```text
photo
 └→ Depth Anything V2-Small ──→ continuous depth map (decides layer order)
      └→ cut at depth-histogram valleys ──→ adaptive, 2–4 layers
           └→ BiRefNet_lite subject matte (server only) ──→ the subject gets its own layer; only depth cuts behind it are kept
           └→ depth-edge snapping ──→ object edges become clean steps
                └→ guided-filter refinement ──→ layer boundaries snap to real object edges
                     └→ per-layer alpha (also that layer's foil mask)
                          └→ per-layer completion + mirrored texture fill + soft-edge background removal
                               └→ .layers ──→ renderer
```

`segmentToLayerSet` (`index.ts`) reports these stages, which the server stores as the job's `stage` and uses for time estimates:

| Stage | Work | Code |
|---|---|---|
| `loading-model` | Load the depth model | `depth.ts` |
| `estimating-depth` | Depth estimation | `depth.ts` |
| `analyzing` | Edge evidence and cut selection on the histogram | `slice.ts` |
| `finding-subject` | Subject matting and cut refitting (only when the caller provides `findSubject`) | `matte.ts`, `slice.ts` |
| `extracting` | Alpha and colour for each layer | `extract.ts`, `refine.ts`, `morph.ts` |

## Two kinds of information

Each layer plays two roles: an image with parallax, and the mask for that layer's foil. Two kinds of information are therefore needed:

- **Order (what is in front)**: from monocular depth estimation. A matting model only separates subject from background and cannot order three or more layers.
- **Boundary position**: the mask edge is the foil edge, so its quality is directly visible. The subject's boundary comes from the matting model (server side); boundaries inside the background come from depth. Depth maps are blurry slopes at object edges and often shrink a few pixels into the object, so they are refined separately, see [Edge refinement](#edge-refinement).

## Depth estimation

The depth model is Depth Anything V2-Small (Apache-2.0, 24.8M parameters). WebGPU uses fp16 weights (about 50 MB); WASM and the server CPU use q8 weights, which on the server's ARM CPU are twice as fast as fp16 and use 30% less memory. The depth map is normalised to 0..1, with 1 the nearest.

Weights come from, in order: `VITE_MODEL_HOST` set at build time; the site's own `/models/` (probed only by the browser fallback); the Hugging Face CDN. The server only reads its local model directory and never downloads at runtime.

## Slicing

### Cuts at depth-histogram valleys

Layer boundaries are not evenly spaced; they sit at valleys of the depth histogram, the distances where the scene has no content. Cutting where there is content would split an object in two. The number of layers is also data-driven; many photos have only two.

| Parameter (`DEFAULT_SLICE_OPTIONS`) | Value | Meaning |
|---|---|---|
| `minLayers` / `maxLayers` | 2 / 4 | Layer count range. More than 4 layers is invisible at card size and only costs rendering time |
| `bins` | 256 | Histogram bins |
| `smoothSigma` | 4 | Gaussian smoothing in bins; too little lets noise create false valleys |
| `minValleyProminence` | 0.08 | Valley prominence threshold. Prominence = (lower of the two neighbouring peaks − valley) / global maximum; using the lower peak keeps a small dip beside a large peak from counting |
| `minSeparationBins` | 18 | Minimum distance between cuts, avoiding thin slivers |

Cuts are picked greedily by prominence. If no prominent valley exists (for example a continuous sloping floor), slicing falls back to equal-mass cuts by pixel count, and those cuts are always rigid (see below). If the effective depth span (after dropping 1% of pixels at each end) is below 0.06, the image is not sliced and yields a single layer: forcing cuts on a flat colour field or a wall seen head-on produces a full-frame translucent ghost.

### Cuts need a visible edge

On flat-colour illustrations the depth model invents a smooth gradient across textureless areas, and valleys found in it are noise; cutting there gives two layers with different foils and a seam that does not exist in the original. Every cut is therefore checked against the photo:

- The photo is downscaled to 512 px and its luminance gradient computed; twice the mean gradient counts as an edge.
- Within the transition band of ±0.035 (depth units) around the cut, the share of pixels on an edge must be at least 3%; otherwise the cut is dropped.

### Rigid boundaries

A boundary that is visible but has no occlusion step in depth usually lies inside one object (the upper and lower halves of a face, a person printed on a flat poster). Splitting it for foils is fine, but the two layers must not slide against each other, or the object breaks in two.

- In the cut's transition band, the share of pixels whose depth drops by more than 0.2 within a neighbourhood of 1% of the image width is measured. Cuts below 12% are kept but marked rigid (`rigid`).
- Measured values: flat posters, cartoons and line drawings 0–4.6%; real photos with clean figure-ground separation 18.7%–40.7%. The threshold sits in the gap between them.

Adjacent layers joined by rigid boundaries form one parallax group and share one parallax coefficient.

### The subject gets its own layer

With depth alone a layer boundary is an iso-depth line; when a crowd stands at one distance their depth is one continuous blob, and the line runs through people wherever it falls. A more accurate depth model does not help. The server therefore mattes the subject first: the matte decides the subject's boundary, and depth only decides order and parallax.

- The matte is cleaned first: fragments smaller than 5% of the largest connected component are dropped, and faint values (shadows, passers-by) more than 1% of the image width away from what remains are zeroed. Otherwise a translucent copy appears on the subject layer, background removal amplifies its error, and a ghost follows the subject.
- The subject is one layer whose outline is the matte; no depth cut ever splits it.
- A depth cut is kept only if it lies behind the subject (at most 5% of the subject's pixels on its far side), is a real valley rather than an equal-mass fallback, and still leaves at least 2% of the image on its near side after removing the subject and a margin of 2% of the image width. Cuts through or in front of the subject are dropped.
- With the subject occupying one layer, at most `maxLayers − 2` depth cuts remain; extras are removed by lowest prominence.
- Whether the subject may slide against the layer behind it is decided by the same occlusion-step test, measured around the subject's outline. Lettering on a sign or the person on an ID photo get matted as the subject but lie in the same plane as the background, so they are marked rigid.
- The subject's depth is forced to be the nearest (maximum of the other layers + 0.05, capped at 1), so it sorts in front and gets the most parallax.

When no subject is found (pure landscapes) or when the browser does the layering as a fallback, layers are cut by depth only.

Occluders in front of the subject (a ribbon across the body, out-of-focus flowers in the foreground) currently belong to the background layer and slide behind the subject at large parallax.

### Parallax coefficients and default foils

Parallax coefficients are the mean depth of each parallax group normalised so that the farthest group is 0 and the nearest is 1, independent of the photo's depth range. If all groups have almost the same depth, they are spread evenly by order; if the whole image is one rigid body, every layer gets 0 and the layers serve only the foils.

Default foils follow how real holographic cards are printed (the base is foil; the subject is covered by opaque ink and is therefore matte):

| Layer | Default foil |
|---|---|
| The matted subject layer | `none` (matte) |
| Layers in the nearest layer's parallax group (no subject) | `none` |
| Layers in the farthest layer's parallax group | `sunpillar`, intensity 1 |
| Other middle layers | `holo`, intensity 0.8 |

Foils follow parallax groups rather than layer order, so one object split across several layers does not get different foils.

## Building each layer

`extractLayers` (`extract.ts`) turns the depth map and cuts into one RGBA image per layer, at most 1400 px on the long side.

| Parameter (`DEFAULT_EXTRACT_OPTIONS`) | Value | Meaning |
|---|---|---|
| `feather` | 0.035 | Feather half-width in depth units; gentle depth transitions blend with smoothstep |
| `maxDimension` | 1400 | Maximum output side length |
| `snapRadius` | 0.01 | Window radius of depth-edge snapping (fraction of image width) |
| `snapThreshold` | 0.12 | Only depth drops above this within the window count as occlusion edges and are snapped |
| `foregroundGrow` | 0 | Foreground growth width; currently no growth |
| `fringe` | 0.005 | Extra margin around areas covered by nearer layers whose colours are not used as fill sources |
| `mirrorReach` | 0.12 | Maximum depth into a covered area for mirrored texture fill; beyond it the fill is smooth |

### Feathered boundaries

Layer boundaries are feathered rather than hard-thresholded. A hard cut glues a ring of background pixels onto the foreground layer, and that dirty ring follows the subject under parallax.

### Depth-edge snapping

A monocular depth map has a slope at object edges, and the middle of that slope falls into the middle layer's range, forming a misclassified ring around the object that separates into a ghost when it moves. Snapping uses morphological toggle mapping to squash steep slopes into steps; gentle surfaces with drops below `snapThreshold` (floors and the like) are left alone to keep their smooth transitions.

### No foreground growth

Depth boundaries are offset from real object edges, and growing the foreground outward would make object edges follow the object. But the background swallowed by growth is opaque, background removal cannot clean it, and under parallax it becomes a bright rim along the outline. The foreground is therefore not grown; instead the background layer widens its covered area by `fringe` before completion, so object edges never stay behind in the background layer.

### Depth around the subject

The subject plus a margin of 2% of the image width takes the depth of the nearest pixel outside that margin, and depth slicing uses only this substituted depth. The subject's outline in the depth map is always a few pixels wider than the matte; without substitution that extra ring would go to the nearest depth layer, forming a halo around the subject and spreading behind it during completion.

### Per-layer completion

When the foreground moves away, what shows through should continue the layer directly behind it, so every layer except the front one is completed:

- The bottom layer covers the whole card with alpha 1, so no transparent holes appear when the foreground moves.
- Middle layers: for each covered pixel, find the nearest visible pixel; the layer it belongs to is taken to extend to the covered pixel.
- The originally visible part and the completed extension are merged into one mask before anti-aliasing. Anti-aliasing them separately leaves about 0.6 alpha on each side of the seam, and farther layers show through the crack.

Completing only the bottom layer would make middle layers stop at the foreground's original outline, breaking both the image and the foil.

### Mirrored texture fill

Foils use `color-dodge` to light up bright pixels of the underlying image, and flat colour patches do not light up. Filled colours therefore mirror real pixels from the other side of the boundary around the nearest source pixel. A push-pull pyramid fill is only the fallback, used where the mirror source is out of bounds or beyond `mirrorReach`.

Completion uses no neural network: parallax offsets are a few dozen pixels, so revealed areas are thin strips, not large holes. LaMa (Apache-2.0) was evaluated on the server: 10 seconds and 900 MB on two cores, and when the subject fills most of the frame it extends the subject's colour into the hole, producing a dark ghost. It was not adopted.

### Soft-edge background removal

A semi-transparent edge pixel mixes foreground and background: `C = a·F + (1 − a)·B`. Storing C as-is makes hair and fur edges carry the old background's colour when they move. Compositing from far to near, B is whatever currently sits behind the layer:

- **The original image is behind it** (feathered bands of gentle depth transitions): solve directly, `F = (C − (1 − a)·B) / a`. Stacked back together at rest, the layers reproduce the original exactly.
- **Filled colour is behind it** (on real object edges): the fill is a guess, and solving amplifies its error by `(1 − a)/a`. A glow, a rim light or a slightly wide matte pushes F to pure white and leaves a white outline following the subject. Here a two-level blur-fusion neighbourhood estimate is used instead (the same method as BiRefNet's official foreground estimation): a large window gives the local foreground mean F̄ and background mean B̄, and `F = C + (1 − a)·(F̄ − B̄)` pulls the original colour toward the foreground. The error is only scaled by `1 − a`, never amplified.

Pixels whose colour was filled in (covered by nearer layers) are skipped.

## Edge refinement

Edge refinement uses a **guided filter** (He, Sun, Tang, ECCV 2010) to snap layer boundaries to real object edges in the photo. It needs no download, is plain JS and works on any image. The code is in `refine.ts`.

### Principle

In each local window, the refined alpha is assumed to be a linear function of the guide image, `q = a·I + b`, fitted to the coarse mask by least squares. Where the guide has an edge, the alpha jumps along it; where the guide is flat, `a` tends to 0 and the result falls back to the local mean of the coarse mask.

Two constraints are added on top of the standard method, because the goal is to fix the layer boundary only, not to do general edge-preserving smoothing:

- It acts only inside the **uncertainty band** on both sides of a layer boundary; everything outside is left as is.
- The local goodness of fit **R²** is used as confidence. If the linear model cannot explain a boundary, the photo has no edge there (for example where near ground meets midground ground), and it is left alone.

| Parameter | Browser (`DEFAULT_REFINE_OPTIONS`) | Server (`SERVER_REFINE_OPTIONS`) |
|---|---|---|
| `workingWidth` (computation width) | 520 | 1400 (full resolution) |
| `windowRadius` (fraction of image width) | 0.016 | 0.008 |
| `epsilon` (regularisation) | 2e-3 | same |
| `bandRadius` (uncertainty band half-width, fraction of image width) | 0.016 | same |
| `confidenceLow` / `confidenceHigh` (R² ramp) | 0.35 / 0.75 | same |

The server computes at full resolution with a smaller window, halving the soft-edge width compared with the browser and shrinking the background-coloured band that follows the foreground under parallax, at a cost of about 1 second and about 90 MB of peak memory per image. The browser keeps the downscaled computation so that low-memory phones are not killed.

### Refining boundaries, not layers

Refinement works on boundaries rather than layers: each cut has a cumulative mask (how much nearer than that boundary a pixel is). Once a boundary is refined, the layers on both sides benefit and their alphas stay complementary. Two rules follow:

- **Layer alphas are combined by subtraction**: layer k's alpha is `A(k−1) − A(k)`, not the product `A(k−1)·(1 − A(k))`. Boundaries are nested, so an edge pixel covered by the foreground to degree t has value t for both: subtraction gives the middle layer 0, while the product gives `t(1−t)` (up to 0.25) and conjures a ring for the middle layer along every soft edge. After refining each boundary, the nesting order is restored (a nearer boundary never exceeds a farther one).
- **Boundaries on the same object edge share one refined edge**: for example a head directly against the sky with no middle layer nearby, where both boundaries should be identical. Refined separately, their soft edges differ and subtraction still leaves a ring. If layer k never appears within an uncertainty band of a pixel, the boundary below it copies the one above.

The subject's outline uses the matte's alpha directly without the guided filter: it is already a soft edge along the object including hair detail, and refinement would only pull it toward colour edges.

### Guide image

The guide is currently the photo's RGB. Anything that produces a foreground alpha can be added as an extra channel (`ExtractOptions.extraGuide`) without changing the algorithm.

A colour guide has inherent limits: outlines whose colour is close to the background cannot be separated (a black outline on a dark background is pulled toward the background by the linear colour model), and semi-transparent fine structure such as hair is handled worse than by a dedicated matting model.

## Subject matting on the server (BiRefNet)

The server uses BiRefNet_lite (MIT, `onnx-community/BiRefNet_lite-ONNX`, 1024×1024 input, fp32) for the subject alpha, used directly as the subject layer's boundary.

### No subject matting in browsers

The model cannot run in browsers; all four paths were tested:

| Path | Result |
|---|---|
| WebGPU | A 16-way Concat in the model needs 17 storage buffers in one shader; adapters usually allow 16 |
| WASM, 1024 input | `std::bad_alloc`: activations do not fit in the 32-bit WASM heap |
| WASM, arena allocator off | Same |
| WASM, 512 / 768 input | The ONNX export fixes the input at 1024×1024 and rejects other sizes |

To reproduce: `node scripts/probe-matte.mjs --image path/to/photo`. Using it in browsers would require re-exporting the model (splitting the wide Concat or freeing the input size).

### Memory and when matting is enabled

onnxruntime's CPU memory arena must be disabled: with it on, peak memory is never returned to the system and resident memory grows to about 12 GB; with it off, the peak is about 6.9 GB and drops to 0.6–0.8 GB after inference. If the service's memory limit (systemd `MemoryMax`) is below 8 GB, matting is disabled and layers are cut by depth only, so the process is not OOM-killed. A card that crashed the previous process is also resumed without matting.

### Model choice

Comparison on staging, 16 images, against the full model, 4-core ARM:

| Model | Per image | Peak memory | Versus full model |
|---|---|---|---|
| Full (Swin-L), 1024 input | 54 s | 8.8 GB | — |
| **lite (Swin-T), 1024 input** (current) | 23 s | 6.9 GB | Subject IoU 0.885, closest edges; treats the inside of figures in line art on white as background |
| 512, int8 quantised | 11 s | 4.4 GB | Subject IoU 0.885, blurrier edges; misses parts of sign lettering |

All three share the same training data; lite only has a smaller backbone. Half precision is 40% slower on ARM CPUs, and quantising lite to int8 is only 10% faster with identical results, so fp32 is kept.

To switch models, change `MATTE_MODEL_ID` and the input size in `src/segmenter/matte.ts`. For experiments no code change is needed: set `HOLOCARD_MATTE_MODEL`, `HOLOCARD_MATTE_SIZE` and `HOLOCARD_MATTE_DTYPE`, and evaluate with the [blind comparison](/en/develop/#blind-comparison-scripts-blind) scripts.

## Output

The pipeline outputs PNG layers named `layer-N.png`. The manifest `generator` field records the depth model, the matting model, the layer count, and each cut's position and prominence, for diagnosing slicing results. Before writing to disk, the server converts layers to WebP (lossy colour, lossless alpha, about a tenth the size of PNG) and rewrites the file names in the manifest. See [File format](/en/format/).
