# Introduction and usage

HoloCard turns a photo into an interactive layered holo card. After upload, the server splits the image into foreground, midground and background layers and assigns each layer its own foil; as the card tilts on the page, the foils shift with the angle. Live site: <https://holocard.longsizhuo.com>.

The foil effects and interaction feel are ported from [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css) (Simon Goellner, GPL-3.0). In that project every card needs a hand-made mask marking where the foil shows through; HoloCard generates that mask automatically with its layering algorithm, so any photo can become a holo card. HoloCard is also released under GPL-3.0.

The interface is available in Chinese, English and Japanese; switch languages in the page header.

## What a card is made of

The structure mirrors how real holo cards are printed: the base stock is foil, the subject is covered with opaque ink and therefore matte, and the uncovered background shines.

| Part | Covers | Moves with parallax | When visible |
|---|---|---|---|
| Depth layers | Each layer's own image | Yes, by a different amount per layer | Always |
| Per-layer foil | Only inside that layer's shape | Yes, with its layer | When the card is tilted |
| Card-wide halo | The whole card face | No | Only at a specific tilt angle, as a faint iridescence |
| Card-wide glare | The whole card face | No | Follows the pointer |

### Layers and depth

The server estimates the photo's depth and splits it, far to near, into 2 to 4 layers depending on the content. When there is a clear subject (a person, an animal), the subject becomes its own nearest layer. Each layer is an image of the same size as the original with an alpha channel; stacked far to near, the layers reproduce the original. Areas hidden behind nearer layers are filled in, so when a foreground layer moves, what shows behind it is a continuation of the layer underneath.

### Parallax

When the card tilts, each layer shifts by an amount set by its parallax coefficient: near layers move outward and far layers move inward, which creates depth. All layers are scaled up by the same small factor so that no blank edge shows. Parallax can be turned off, in which case the card is a flat image.

### Foils

A layer's foil appears only inside that layer's shape and moves with the layer. Four foils are available:

| Foil | Label in the UI | Effect |
|---|---|---|
| `none` | Matte (no foil) | No foil |
| `holo` | Classic holo | Diagonal rainbow, fine scan lines and vertical grating |
| `sunpillar` | Sunpillar | Diagonal sun-pillar rainbow with metallic grain |
| `rainbow` | Rainbow glitter | Glitter with a multi-color gradient |

Default assignment: the farthest layer (background) gets Sunpillar, middle layers get Classic holo (intensity 0.8), and the nearest layer (subject) is Matte. A single-layer card gets Sunpillar.

### Halo and glare

The card-wide halo covers the whole face, does not take part in parallax, and appears only when the card is turned to the angle that reflects the light source toward the viewer; at other angles it is nearly invisible. The glare is a specular highlight that follows the pointer. Near-white areas of the image automatically receive less foil, halo and glare, so that the texture of white clothing, fur and similar areas is preserved.

## Usage

### Uploading and processing

Click the upload button on the page (tooltip "Upload a photo") to choose an image, or drag an image onto it.

- JPEG, PNG, WebP, AVIF and HEIC are accepted, up to 16 MB each. Images larger than 15 MB are first downscaled in the browser to 4096 px on the longest edge; downscaling also strips EXIF data, including location.
- Each IP address can submit at most 10 times per 10 minutes.
- Processing runs on the server; the browser does not download any model. The progress bar shows the current step (queued, finding the subject, estimating depth, splitting layers and filling holes, and so on) and an estimated time remaining.
- Only when a deployment has no layering server at all (for example, a static-only self-hosted deployment) does processing fall back to the browser, which downloads about 50 MB of model weights the first time. Cards made in the browser are not stored on a server and cannot be shared or exported.

### Opening the pack

After upload, a card pack appears at the right end of the deck. When processing finishes, the pack lights up (hint: "Swipe across to tear, or tap"):

- Swipe horizontally across the seal at the top of the pack to tear it; release after about 60% and the whole strip is torn off.
- Or tap the pack; it shakes and bursts open.

The new card rises out of the pack and spins once into view. Opening a pack plays sound effects; while a pack is present, a "Pack sounds" button appears at the bottom right of the deck to mute them, and the choice is remembered on the device. With the system's "Reduce motion" setting on, no animation plays and the card is shown directly.

A card someone else shared also opens with a pack the first time it is viewed on a device; afterwards it opens directly.

### Switching cards in the deck

The main stage of the home page is a deck holding the cards made during this visit, newest on the right. Switch with the "Previous card" and "Next card" buttons on either side of the card, or with the ← → keys. While a new card is processing you can go back to earlier cards; when the new card is ready and you are on another card, a dot appears on the "Next card" button.

The deck is kept in the current browser tab: it survives a reload and is cleared when the tab is closed. Every card made remains available in "My album".

### Adjusting effects

The panel next to the card adjusts the current card:

| Control | Purpose | Range |
|---|---|---|
| One row per layer: drop-down | Foil type of that layer | See the foil table above |
| One row per layer: slider ("Foil strength for this layer") | Foil strength; disabled for matte layers | 0–1 |
| "Parallax" switch | Turns parallax on or off | On / off |
| "Depth and halo" → "Parallax" | Parallax amplitude, as a fraction of card width | 0–16%, default 2% |
| "Depth and halo" → "Halo intensity" | Card-wide halo strength; 0 turns it off | 0–1, default 0.35 |
| "Depth and halo" → "Angle sharpness" | Tilt range in which the halo appears; higher is narrower | 10–400, default 120 |
| "Depth and halo" → "Current halo" | Read-only; how bright the halo is right now | — |

While a slider is dragged or a foil is changed, the card turns to the angle where the halo is brightest and returns after a moment, so the change is visible.

Changes made by the card's owner are saved to the server automatically about one second after the last change. The share page, the share preview image and exported animations all use the saved configuration. Changes made on someone else's card affect only the local view and are not saved. The "Parallax" switch is also remembered on the device and applies to cards that have no saved parallax setting.

### Sharing

A share link is created automatically when a card is finished and appears in the panel; click "Copy" to copy it. If automatic creation fails, the "Create share link" button stays in the panel for creating it manually.

- Links look like `https://holocard.longsizhuo.com/c/<id>`. Links created in the English or Japanese interface carry `?lang=en` or `?lang=ja`, so the title, description and preview image shown in chat apps are in the sharer's language.
- Only the card's owner can share it: the device holding the card's delete key, or the signed-in account the card belongs to.
- When the owner opens their own share link, they can keep adjusting, sharing and deleting. Other viewers can tilt and export the card; their adjustments are not saved.
- After sharing, retention is extended by views; see "Retention" below.

### Exporting an animation

The export button in the panel offers a format that can go straight into the device's photo library. The file is generated on the server from the card's saved configuration:

| Device | Button | Format | How it is saved |
|---|---|---|---|
| iPhone / iPad | "Save as GIF" | GIF | When ready, the button changes to "Save to Photos"; tap it again to open the share sheet and choose "Save Image". Older systems that cannot share files download it to the Files app |
| Android | "Save as Motion Photo" | Motion Photo (a JPEG with a video appended) | Downloaded directly |
| Computer | "Download animation" | APNG (`.png` extension) | Downloaded directly |

Export is not limited to the owner; cards shared by others can be exported too. The in-app browsers of WeChat and QQ block downloads; open the page in the system browser via "···" in the top right first.

### Deleting

When the owner clicks "Delete this card" and confirms, the layer files and preview images on the server are removed immediately and any share link stops working. This cannot be undone.

Without signing in, delete rights depend on the delete key stored in this device's browser. After browser data is cleared, the device can no longer delete or share cards made earlier; adding the cards to an account avoids this.

### Gyroscope

On phones the card follows the phone's tilt: it reaches its maximum angle at about 16° left/right and about 18° forward/back. iOS requires permission, requested by the system on the first tap on the deck; if declined, the card can still be moved with a finger.

The card's reference orientation slowly follows how the phone is held: when the phone is kept still, the card recenters within a few seconds, and only the act of tilting has an effect. Touch input takes priority over the gyroscope.

## Album and sign-in

### My album

The album shows the cards you have made in a grid, newest first; nothing needs to be added by hand. It is opened from the account panel: click "Sign in" at the top right of the header (your avatar and name once signed in), then "Open album". On deployments without sign-in, the header button is "My album" and opens the album directly. Click a thumbnail to open that card's page, where it can be shared, exported or deleted. Expired or deleted cards show "Expired".

Without signing in, the album is a local record: it is built from the delete keys stored in this device's browser and is visible only on this device.

### Signing in

HoloCard supports signing in with an [involutionhell](https://involutionhell.com) account. Signing in is optional; everything works without it. Sign in from the account panel (the "Sign in" button at the top right of the header) or with "Sign in with involutionhell" at the top of the album. HoloCard receives only the account's id, name and avatar, not the email address.

After signing in:

- The album title becomes "My online album" and lists the cards in the account, plus cards on this device that have not yet been added to it.
- Cards made while signed in go straight into the account and can be viewed, shared and deleted from any device after signing in.
- Cards in an account do not expire.

### Adding this device's cards to the account

After signing in, if this device has cards that are not in the account, the top of the album shows "Cards on this device not yet in your account: N" with their thumbnails, all checked by default. Uncheck any cards that are not yours (for example on a shared computer), then click "Add to account".

Added cards belong to the account and no longer expire; the delete keys previously stored on this device stop working, and the account becomes the owner. Deleted or expired cards cannot be added.

### Account page

The button at the top right of the header opens "Account". The header also has "Docs", which opens this documentation site in the page's current language.

When not signed in, the panel contains the sign-in entry and "My album" (the number of cards on this device and "Open album").

When signed in, the header button shows your avatar and name, and the panel contains:

- Account details and "Sign out".
- "My online album": the number of cards in the account; "Open album" opens the album.
- "Public API": a link to the API docs, usage over the last 24 hours, and the account's keys. "Request an API key" issues a new key, shown only once. An account can hold up to 10 keys at a time, all sharing one quota; if you lose track of a key, simply request another, and click "Revoke" on keys no longer in use. See the [API docs](/en/api/) for usage and the [player](/en/player/) for showing API-generated cards on a web page.

## Card masks

Card masks is a separate tool for trading cards at `/masks`, with no link on the home page: upload a finished flat card image to get six non-overlapping foil masks (border, frame, text, character, effects, background) and preview the foil for different combinations. See [Card masks](/en/masks/).

## Retention

Card files are stored on the server and deleted when they expire. Defaults on the public site:

| Card | Kept for | Counted from |
|---|---|---|
| Not shared | 7 days | Creation |
| Shared | 7 days or more, extended by views, up to 112 days | Last view |
| In an account (made while signed in, or added) | Does not expire | — |
| Made through the API | 24 hours | Submission |

Shared cards are kept according to their total views:

| Total views | Kept after the last view |
|---|---|
| 0–1 | 7 days |
| 2–3 | 14 days |
| 4–7 | 28 days |
| 8–15 | 56 days |
| 16 or more | 112 days |

- A view is an opening of the share link (the `/c/<id>` page). Views of the same card from the same IP address count once per hour.
- The share action itself counts as a view and restarts the clock.
- Because cards are shared automatically when finished, cards made on the website are normally in the shared state; a card counts as not shared only if automatic sharing failed and it was never shared manually.
- A deleted card is removed immediately, regardless of the table above.
- Self-hosted deployments can change the base retention with the `HOLOCARD_TTL_MS` environment variable (default 7 days).
