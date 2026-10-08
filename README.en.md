# HoloCard

[中文](README.md) | English

[![npm @holocard/player](https://img.shields.io/npm/v/@holocard/player?label=npm%20%40holocard%2Fplayer)](https://www.npmjs.com/package/@holocard/player)

[![HoloCard](public/og-en.jpg)](https://holocard.longsizhuo.com/?lang=en)

HoloCard splits a photo into layers automatically and renders it as an interactive holographic card: the server estimates depth, separates the image into foreground, middle and background layers, assigns each layer its own foil, and the card turns with the pointer or device tilt. Live site: https://holocard.longsizhuo.com

The foil effects and interaction are ported from [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css) (Simon Goellner, GPL-3.0). That project requires a hand-drawn foil mask for every card; HoloCard generates the masks with a layering algorithm, so any photo can become a card.

## Documentation

The full documentation is published at https://holocard.longsizhuo.com/docs/en/ ; the sources are in [`docs-site/`](docs-site/).

| Topic | Link |
|---|---|
| Guide | [/docs/en/guide/](https://holocard.longsizhuo.com/docs/en/guide/) |
| API | [/docs/en/api/](https://holocard.longsizhuo.com/docs/en/api/) |
| Player `@holocard/player` | [/docs/en/player/](https://holocard.longsizhuo.com/docs/en/player/) |
| File format `.layers` | [/docs/en/format/](https://holocard.longsizhuo.com/docs/en/format/) |
| Local development and verification scripts | [/docs/en/develop/](https://holocard.longsizhuo.com/docs/en/develop/) |
| Architecture, layering pipeline, renderer | [/docs/en/develop/architecture](https://holocard.longsizhuo.com/docs/en/develop/architecture) |
| Self-hosting | [/docs/en/deploy/](https://holocard.longsizhuo.com/docs/en/deploy/) |

The operations runbook for the hosted site (servers, staging, releases) is in [`deploy/README.md`](deploy/README.md) (Chinese).

## Quick start

```bash
corepack enable && pnpm install
pnpm dev            # front end: http://localhost:5273
pnpm dev:server     # layering service: http://localhost:8791 (needs model weights; see Local development)
pnpm docs:dev       # documentation site
```

## License

GPL-3.0-only; see [LICENSE](LICENSE).
