# HoloCard

中文 | [English](README.en.md)

[![npm @holocard/player](https://img.shields.io/npm/v/@holocard/player?label=npm%20%40holocard%2Fplayer)](https://www.npmjs.com/package/@holocard/player)

[![HoloCard](public/og.jpg)](https://holocard.longsizhuo.com)

HoloCard 将照片自动分层，渲染为可交互的全息卡片：服务端估计照片深度并切分为前、中、后景若干层，每层配置独立的箔面，卡片随指针或设备倾斜转动。线上地址：https://holocard.longsizhuo.com

箔面效果与交互手感移植自 [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css)（Simon Goellner，GPL-3.0）。该项目的每张卡片需要手工绘制箔面遮罩，HoloCard 使用分层算法自动生成遮罩，使任意照片都可以制作成卡片。

## 文档

完整文档发布在 https://holocard.longsizhuo.com/docs/ ，源文件位于 [`docs-site/`](docs-site/)。

| 主题 | 链接 |
|---|---|
| 介绍与使用 | [/docs/](https://holocard.longsizhuo.com/docs/) |
| API | [/docs/api/](https://holocard.longsizhuo.com/docs/api/) |
| 播放器 `@holocard/player` | [/docs/player/](https://holocard.longsizhuo.com/docs/player/) |
| 文件格式 `.layers` | [/docs/format/](https://holocard.longsizhuo.com/docs/format/) |
| 本地开发与验证脚本 | [/docs/develop/](https://holocard.longsizhuo.com/docs/develop/) |
| 架构、分层流水线、渲染器 | [/docs/develop/architecture](https://holocard.longsizhuo.com/docs/develop/architecture) |
| 自托管部署 | [/docs/deploy/](https://holocard.longsizhuo.com/docs/deploy/) |

本站自身的运维手册（服务器、staging、发版）见 [`deploy/README.md`](deploy/README.md)。

## 快速开始

```bash
corepack enable && pnpm install
pnpm dev            # 前端：http://localhost:5273
pnpm dev:server     # 分层服务：http://localhost:8791（需要模型权重，见本地开发文档）
pnpm docs:dev       # 文档站
```

## 许可

GPL-3.0-only，见 [LICENSE](LICENSE)。
