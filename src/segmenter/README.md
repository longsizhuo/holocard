# src/segmenter

分层流水线：照片 → 深度估计 → 切层 → 边缘精修 → 补全 → LayerSet。
线上跑在服务端（`server/` 注入 sharp 做图片编解码），没有后端的部署才在浏览器里跑。

- `index.ts`：总流程，视差系数和默认箔面也在这里定
- `depth.ts`：Depth Anything V2-Small 深度估计
- `slice.ts`：在深度直方图的谷底找切点，判定刚性边界
- `extract.ts`：按切点出每层的 alpha 和颜色：吸附深度边缘、逐层补全、镜像纹理填充、软边去背景色
- `refine.ts`：引导滤波，把层边界吸附到真实物体边缘
- `morph.ts`：形态学工具（膨胀、最近源像素、alpha 模糊）
- `matte.ts`：BiRefNet 抠图（实验性，没接进默认流程，原因见仓库 README）
- `runtime.ts` / `image-io.ts`：模型来源配置、图片解码后端
