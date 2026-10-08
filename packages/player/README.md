# @holocard/player

`<holo-card>` — show a [HoloCard](https://holocard.longsizhuo.com) layered holographic card in any web page.
It tilts with the pointer or the phone, with the foils, glare and parallax the author chose.

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@holocard/player@0.1/dist/holocard.js"></script>

<holo-card src="https://example.com/cards/my-card"></holo-card>
```

Or from npm:

```sh
npm install @holocard/player
```

```js
import '@holocard/player'; // registers <holo-card>
```

It is a standard custom element, so it works in plain HTML, React, Vue, Svelte… without a wrapper.

## The files

A card is a `.layers` folder: `manifest.json` plus one image per layer (`layer-0.webp`, `layer-1.webp`, …).
You get one from the [HoloCard API](https://holocard.longsizhuo.com/docs/en/): when a card is done,
download `manifest.json` and every layer file into a folder on your own server (keep the file names), and point `src` at it.

`src` can be the folder (`/cards/my-card`) or the manifest itself (`/cards/my-card/manifest.json`).
If the files live on another domain, that server must allow CORS.

## Attributes

| attribute | |
|---|---|
| `src` | URL of the `.layers` folder or its `manifest.json` |
| `gyro` | follows phone tilt by default; `gyro="off"` turns it off. iOS asks for permission the first time the card is tapped |

## Events

| event | |
|---|---|
| `load` | the layers are loaded and the card is shown |
| `error` | loading failed; `event.detail.error` has the reason |

## Size

Set the width on the element (default 320px); the height follows the card's aspect ratio.

```css
holo-card { width: 100%; max-width: 360px; }
```

Styles live in a shadow root: your page's CSS does not reach inside the card, and the card adds no global styles.

## Pin a version

For production, pin an exact version (for example `@holocard/player@0.1.0`) and add a
[Subresource Integrity](https://www.jsdelivr.com/using-sri-with-dynamic-files) hash to the script tag.

## Credits

The foil effects are ported from [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css) by Simon Goellner;
its license text ships with this package as `LICENSE`. Source: https://github.com/longsizhuo/holocard
