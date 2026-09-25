# src/renderer

闪卡渲染器：吃一个 LayerSet（`src/format`），产出一张可交互的卡。不依赖框架，也不依赖分层算法。

- `card.ts`：3D 结构、视差（焦平面在中间、所有层共用一个放大倍数）、弹簧驱动的交互、整卡炫光的角度模型
- `foils.css`：箔面配方，移植自 pokemon-cards-css（GPL-3.0）
- `card.css`：结构样式、逐层箔面遮罩、整卡炫光
- `highlight.ts`：高光保护，按画面亮度给箔面 / 炫光 / 高光的遮罩打折
- `spring.ts`：弹簧积分，语义对齐 svelte/motion
- `textures.ts`：箔面用的颗粒和闪粉纹理，运行时程序化生成
