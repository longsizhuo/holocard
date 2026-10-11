# Renderer

The renderer (`src/renderer/`) takes a `LayerSet` (a manifest plus one image per layer) and builds an interactive holographic card in the page. It depends on no framework and not on the layering algorithm: hand-cut layers render just as well. The site frontend, `@holocard/player` and the blind comparison page all use the same renderer.

The foil recipes and the feel of the interaction (pointer mapping to rotation, glare and background offset; spring parameters; the rhythm of returning to rest) are ported from [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css) (Simon Goellner, GPL-3.0). Parallax, per-layer foil masks, the halo angle model, highlight protection and gyroscope recentering are HoloCard's own.

## What a card is made of

The structure mirrors how real holographic cards are printed: the base is foil, the subject is covered with opaque ink and so is matte, and the uncovered background shines.

| Part | Area | Moves with parallax | When visible | Manifest field |
|---|---|---|---|---|
| Depth layers | Each layer's own image | Yes, by each layer's coefficient | Always | `layers[].parallax` |
| Per-layer foil | Only within that layer's alpha | Yes, with its layer | As soon as the pointer hovers | `layers[].foil` |
| Card-wide halo | Whole card | Mask follows its parallax group; the light itself does not move | Only at certain tilt angles | `effects.halo` |
| Card-wide glare | Whole card | Same as above | Follows the pointer | `effects.glare` |

## Files

| File | Responsibility |
|---|---|
| `card.ts` | The `HoloCard` class: DOM structure, parallax, spring-driven interaction, halo angle model, gyroscope control |
| `card.css` | Structural styles, per-layer foil masks, halo and glare, reduced motion |
| `foils.css` | Foil recipes |
| `highlight.ts` | Highlight-protection masks |
| `spring.ts` | Spring integration |
| `gyro.ts` | Device tilt → pointer position with an auto-recentering baseline |
| `textures.ts` | Procedural grain and glitter textures |

## Usage

```ts
import { HoloCard } from './renderer/card';
import { loadLayerSet } from './format/io';

const card = new HoloCard(document.querySelector('#card')!, { amplitude: 0.02 });
card.setLayerSet(await loadLayerSet('/api/layers/<id>'));
```

| Option / method | Description |
|---|---|
| `amplitude` | Parallax amplitude: the maximum offset between the nearest and farthest layers as a fraction of card width, default 0.02; 0 disables parallax. Author configs are capped at 0.16 (`PARALLAX_MAX`) |
| `tiltScale` | Tilt multiplier, default 1 (maximum rotation about 14.3°) |
| `setLayerSet(set)` | Mounts or replaces a set of layers. Checks that layer and image counts match before tearing down the old card |
| `setLayerFoil(index, foil)` / `setHalo(halo)` / `setOptions(patch)` | Change foil, halo or amplitude at runtime without rebuilding the DOM |
| `setPose({x, y} \| null)` | Jumps without animation to the pose for a pointer at `(x, y)` percent of the card; `null` returns to rest. Used for share images, exported animations and recording scripts |
| `preview()` | Turns smoothly to the angle where the halo peaks, holds 1.2 seconds, then returns. Called while dragging tuning-panel sliders |
| `enableGyro()` | Follows device tilt. On iOS the caller must first obtain `DeviceOrientationEvent.requestPermission()` inside a user gesture |
| `ready` | Resolves once all highlight-protection masks are applied. Await it before taking screenshots |
| `destroy()` | Removes the DOM and listeners and revokes all object URLs |

The renderer does not read `effects.parallax` itself; callers set `amplitude` from it (`src/player` uses 0 when the switch is off).

## DOM structure

```text
.hc                      root: --hc-aspect, --hc-amp, --hc-scale and pointer variables
└ .hc__translater        perspective: 600px
  └ .hc__rotator         3D rotation; receives pointer events
    └ .hc__stack
      ├ .hc__plane       one per layer: translate + scale
      │ ├ .hc__art       the layer image
      │ └ .hc__shine     the layer's foil; data-foil selects the recipe, --hc-mask is its mask
      └ .hc__fx          one per parallax group, above that group
        ├ .hc__halo      card-wide halo
        └ .hc__glare     card-wide glare (when effects.glare is true)
```

## Per-layer foil

Each layer's image and foil sit in the same `.hc__plane`, and the offset is applied to the plane. This does two things:

- The foil moves with its layer and never drifts from the image.
- `transform` makes the plane its own stacking context, so the foil's `color-dodge` blends only with that layer's image and never bleeds into farther layers.

The foil mask (`--hc-mask`) is the layer image itself, so foil appears only within the layer's alpha. The upstream project needs a hand-made mask per card; in HoloCard the layering result is that mask, generated automatically.

`foil.type` selects one of four recipes; `foil.intensity` (0..1) sets the strength:

| Type | Look | Upstream recipe |
|---|---|---|
| `none` | Matte, no foil | — |
| `holo` | Classic holo | `regular-holo.css` |
| `sunpillar` | V-card sun pillar | `v-regular.css` |
| `rainbow` | Rainbow glitter | `rainbow-holo.css` |

The gradients, blend modes and filter values in `foils.css` match upstream; there are four changes: selectors become `.hc__shine[data-foil=…]`; the upstream `clip-path` limiting foil to the art window is removed; `rainbow` omits the `:before` that depends on a per-card etch image; and the `sunpillar` diagonal layer is positioned at `100% - x` instead of `-x`, removing a vertical seam. CSS variable names (`--pointer-x`, `--background-x`, `--card-opacity` and so on) match upstream, so other recipes can be pasted in.

Grain and glitter textures are generated at runtime by `textures.ts` from a fixed seed (mulberry32); the repository contains no binary assets. Until they are ready, foils work without grain and glitter; environments without OffscreenCanvas fall back to plain gradients.

## Parallax

### 2D offsets instead of `translateZ`

`translateZ` introduces perspective scaling, so layers no longer line up. The renderer instead offsets each layer in 2D, proportional to its parallax coefficient and the amplitude:

```css
transform:
  translate3d(calc(var(--hc-nx) * var(--hc-parallax) * var(--hc-amp) * -1),
              calc(var(--hc-ny) * var(--hc-parallax) * var(--hc-amp) * -1), 0)
  scale(var(--hc-scale));
```

`--hc-nx` and `--hc-ny` are the spring-smoothed pointer position (-1..1, clamped against spring overshoot), so layers slide with the same feel as the card rotates. Near layers move opposite to the pointer: with the pointer on the right, the card's right edge lifts toward the viewer, as if the viewer stepped to the right, and near objects shift left relative to far ones.

### Focal plane in the middle

The focal plane is the midpoint between the farthest and nearest layers' parallax, and each layer's `--hc-parallax` is its parallax minus the focal plane: near layers move out, far layers move in, and each moves half as far for the same depth effect. At the default amplitude the subject and background separate by at most 10% of the card width. When all layers share one parallax value (the whole image is one rigid body), the focal plane sits on them and nothing moves.

### One scale factor for all layers

Offsets expose blank edges, so layers are scaled up by `1 + 2 × maxOffset × amplitude` (`maxOffset` is the largest offset of any layer from the focal plane). All layers must share the same factor: scaling is around the card centre, and scaling each layer by its own offset would leave the subject at rest a ring larger than the hole it leaves in the background, so the layers would not meet. With one factor, the resting card is the original image scaled uniformly and the layers fit exactly.

## Interaction

### Springs

Rotation, glare and background offset each have a spring (`spring.ts`), and the three share one `requestAnimationFrame` loop that stops once all are at rest. Spring semantics match svelte/motion (`stiffness`, `damping`, `precision`, and the `soft` and `hard` set options), so upstream's tuned parameters work unchanged.

| Situation | stiffness | damping | Notes |
|---|---|---|---|
| Following the pointer | 0.066 | 0.25 | Upstream `springInteractSettings` |
| Returning to rest | 0.01 | 0.06 | Starts 500 ms after the pointer leaves, with a 1-second `soft` start: the card hesitates, then settles slowly |
| Gyroscope | 0.25 | 0.85 | Near critical damping. Sensor readings are already smooth, and the soft pointer spring would lag noticeably |

Each frame's time step is measured in 1/60 s and capped at 3 frames, so a stalled page or a return from the background cannot fling the card; no reset is needed on visibility changes.

### Pointer mapping

| Quantity | Mapping |
|---|---|
| Rotation | `rotateY(-(x − 50) / 3.5)`, `rotateX((y − 50) / 3.5)`, at most about ±14.3°; the side under the pointer lifts toward the viewer |
| Background offset | x narrowed to 37%–63%, y to 33%–67%, so foil patterns drift gently |
| `--pointer-from-center` | Distance of the pointer from the card centre (0..1); foil gets brighter toward the edges |

Pointer coordinates come from the non-rotating root's rectangle; the bounding box of a rotating element deforms with it and would feed back into itself. A mouse button release does not end the interaction; only lifting a touch does.

### Halo angle model

The card-wide halo is an angle event: the card normal derived from the current rotation is dotted with the orientation that reflects the light source into the eye, and a wide and a narrow lobe are combined:

```text
intensity = 0.2 × dot^(sharpness / 5) + 0.8 × dot^sharpness
```

The wide lobe gives a faint base and the narrow lobe the main peak, so the halo is never completely absent yet still appears only at a particular angle. The light direction `effects.halo.light.peakAt` defaults to `[0.7, -0.7]` (upper right); `sharpness` defaults to 120 (tilts are only a dozen degrees, so normals differ by small angles and a high sharpness is needed to form an angular window); `intensity` defaults to 0.35. With the defaults the strength is about 0.12 at rest, 1.00 at the peak tilt and about 0.01 in the opposite direction. The normal computation matches CSS `rotateY(rx) rotateX(ry)` exactly; otherwise the halo angle would disagree with the visible pose.

The halo gradient's colour stops sweep across the card with the background offset. The stops move, not the background block, so no tiling seams appear.

### Highlight protection

Most foils use `color-dodge` (base ÷ (1 − foil)) and the glare uses `overlay`, so bright areas are pushed to pure white and the texture of white clothes or fur disappears. The masks of every layer's foil, the halo and the glare are therefore attenuated by image luminance (Rec.709): unchanged below 0.6, then smoothly reduced with smoothstep to 0.2 at pure white (`highlight.ts`). Shadows and midtones keep their full effect.

Masks start as the layer images and are swapped for the protected versions once computed asynchronously; foil is transparent at rest, so the swap is not visible. Await `ready` before taking screenshots.

### Halo and glare per parallax group

Adjacent layers with equal parallax form a group. Each group gets its own halo and glare (`.hc__fx`), whose mask applies highlight protection to that group's image only and moves and scales with the group; a nearer group covers the one below, so each pixel ends up with the halo of the topmost group there. The gradient itself does not move and remains one sheet of light across the card. With a single static card-wide mask, the outlines in the mask would drift away from the figure as layers move, leaving a white band along the figure's edge.

With the mask scaled to `--hc-scale` times the element, a mask position of `50% + n·s / (2·maxOffset)` (s is the group's parallax minus the focal plane) matches the plane's offset exactly, independent of amplitude; the derivation is in the comments of `card.ts`.

## Gyroscope

`TiltTracker` in `gyro.ts` converts device orientation (`beta`, `gamma`) into a pointer position on the card. It is pure computation with no DOM access and is verified by `scripts/verify-gyro.mjs`.

- **Range**: the pointer reaches the card edge at 16° of side-to-side tilt and 18° front-to-back, as in upstream's orientation version. The direction is reversed from upstream: the card turns with the phone, as if a card held in the hand were being turned.
- **Auto-recentering**: the baseline follows the current pose exponentially with a 3-second time constant (computed from real time, independent of event rate) instead of being fixed at the first reading. Held still, the card recenters within seconds; only the act of turning the phone produces a deflection; slow sensor drift does not accumulate.
- **Dead zone**: deviations under 1° count as no movement; the card recenters and the animation loop stops, so holding the phone does not redraw at 60 fps.
- **Reading jumps**: when a reading differs from the baseline by more than 60° (crossing vertical makes `beta` / `gamma` jump), the baseline is reset.
- **Landscape**: device coordinates are converted to screen coordinates using `screen.orientation.angle`, swapping the axes.

In `HoloCard`, the gyroscope yields while a finger is on the card or `preview()` is showing, and takes over again 1 second after the finger leaves; the baseline keeps following while it yields, so there is no jump on return. Orientation events are ignored while the page is hidden or the user prefers reduced motion.

## Reduced motion

Under `prefers-reduced-motion: reduce` the foils stay and geometric motion goes: `transform` on `.hc`, `.hc__rotator` and `.hc__plane` is locked, and halo masks return to their unscaled alignment; the foils' `background-position` still follows the pointer as an in-place shimmer. `card.ts` also skips the spring loop so that the card settles immediately without overshoot. The preference is read live, so changing the system setting needs no reload.
