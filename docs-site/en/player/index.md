# Player

`@holocard/player` is a Web Component (`<holo-card>`) that renders HoloCard cards in a web page. It is published on npm, has no framework dependency and works in plain HTML, React, Vue and other environments. Foil, glare and parallax are rendered from the parameters in the manifest (see [File format](/en/format/)), matching the HoloCard website.

## Installation

From a CDN:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@holocard/player@0.1/dist/holocard.js"></script>
```

Or install from npm and import it:

```bash
npm install @holocard/player
```

```js
import '@holocard/player'; // registers <holo-card>
```

In production, pin an exact version (for example `@0.1.0`) and add a [Subresource Integrity](https://www.jsdelivr.com/using-sri-with-dynamic-files) (SRI) hash to the `<script>` tag.

## Usage

1. Place the card's `manifest.json` and layer images in one directory on your server without renaming them, for example `/cards/my-card/`. Cards created through the [API](/en/api/) can be downloaded once the job completes.
2. Add the element to your page:

```html
<holo-card src="/cards/my-card"></holo-card>
```

`src` may point to the card directory or directly to `manifest.json`. For cross-origin resources, the server must allow CORS.

## Attributes

| Attribute | Default | Description |
|---|---|---|
| `src` | — | URL of the card directory or its `manifest.json`. Changing it reloads the card |
| `gyro` | on | Rotates the card with device tilt; set to `off` to disable. On iOS, gyroscope permission is requested on the first tap |

## Events

| Event | Description |
|---|---|
| `load` | The layers have loaded and the card is displayed |
| `error` | Loading failed; the reason is in `event.detail.error` |

```js
document.querySelector('holo-card').addEventListener('error', (event) => {
  console.error(event.detail.error);
});
```

## Size and styling

Set the element width with CSS (default `320px`); the height follows the card's aspect ratio:

```css
holo-card { width: 100%; max-width: 360px; }
```

The player's styles are encapsulated in a Shadow DOM: the host page's CSS does not affect the card, and the player adds no global styles.

## License

The foil effects are ported from [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css) (Simon Goellner); its license text ships with the npm package as `LICENSE`.
