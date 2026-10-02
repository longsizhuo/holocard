# src/renderer

闪卡渲染器：吃一个 LayerSet（`src/format`），产出一张可交互的卡。不依赖框架，也不依赖分层算法。

- `card.ts`：3D 结构、视差（焦平面在中间、所有层共用一个放大倍数）、弹簧驱动的交互、整卡炫光的角度模型；炫光和高光按视差分组各压一份
- `foils.css`：箔面配方，移植自 pokemon-cards-css（GPL-3.0）
- `card.css`：结构样式、逐层箔面遮罩、整卡炫光（遮罩跟着所在的组平移、放大）
- `highlight.ts`：高光保护，按画面亮度给箔面 / 炫光 / 高光的遮罩打折
- `spring.ts`：弹簧积分，语义对齐 svelte/motion
- `relief.ts`：浮雕。有深度图（manifest 的 `depthMap`）时，每层的图换成 WebGL 画布，铺成 64×64 网格、顶点按深度推开，层内也有前后（issue #29）。没有深度图、没有 WebGL 就是原来的 `<img>`。强度是 `HoloCardOptions.relief`，演示页可以用 `?relief=2` 临时调
- `gyro.ts`：手机倾斜 → 指针位置。基准姿态会慢慢跟上当前姿态（自动回正），拿着不动卡片自己归位；`node scripts/verify-gyro.mjs` 自检
- `textures.ts`：箔面用的颗粒和闪粉纹理，运行时程序化生成
