# HoloCard

把任意照片自动切成前中后景，渲染成可交互的分层视差闪卡。全部在浏览器本地完成，图片不上传。

灵感来自 [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css)，但那个项目是固定素材 + CSS 特效。
HoloCard 想解决的是：**任意一张照片，自动变成有真实层次感的闪卡**。

> 状态：早期。渲染器与分层流水线已跑通，边缘精修还没接。见下方路线图。

## 核心认知：分层 ≠ 抠图

这个项目最初的错误方向是「找一个更好的抠图算法」。但抠图和分层要的不是一回事：

- **抠图**（BiRefNet / RMBG / SAM）回答「边界在哪」，输出一个 alpha
- **分层视差**需要的是「谁在前面」——这是**排序**问题，抠图算法根本不输出这个信息

显著性抠图基于**视觉显著性**而非**距离**。照片里最显著的东西完全可能在中景（比如站在栏杆后面的人），
抠图不会告诉你栏杆比人更近。

所以主线是**单目深度估计**，抠图退居二线做边界精修。

## 架构：深度定序 + 羽化定边界 + 金字塔补洞

```
照片
 └→ Depth Anything V2-Small ──→ 连续深度图（决定层序）
      └→ 深度直方图谷底切层 ──→ 层数自适应 2~4 层
           └→ smoothstep 羽化 ──→ 每层 alpha
                └→ push-pull 填充 ──→ 补掉底层被遮挡的区域
                     └→ .layers ──→ 渲染器
```

三个设计决定值得说明：

**层边界落在深度直方图的谷底，不是均匀切。** 谷底就是场景中本来没什么东西的那些距离。
在有内容的地方硬切会把一个物体劈成两半，动起来直接撕裂。层数也是算出来的——
很多照片本来就只有两层，硬凑三层会在没有语义边界的地方撕开。

**边界羽化而不是硬阈值。** 深度图在物体边缘本来就是糊的（depth bleeding）。
硬切会把一圈背景像素粘在前景层上，静态看不出来，一做视差位移那圈脏边跟着主体飘，非常刺眼。

**补洞不需要神经网络。** 卡片倾斜产生的视差位移只有几十像素，露出的空洞是**细条**不是大洞。
push-pull 金字塔填充（纯 JS，约 80 行）对细条效果很好。真要做 3D Ken Burns 那种大幅绕飞再上 MI-GAN。

## `.layers` 格式

这个格式把算法和渲染彻底解耦。任何能产出它的东西都能喂给渲染器，
渲染器也可以被单独拿去用——手工在 Photoshop 里切的图一样能渲染。

```
mycard.layers/
├── manifest.json
├── layer-0.png      # 最远
├── layer-1.png
└── layer-2.png      # 最近
```

```json
{
  "version": 1,
  "source": { "width": 734, "height": 1024 },
  "layers": [
    { "file": "layer-2.png", "depth": 0.87, "parallax": 1.0,
      "bbox": [120, 80, 900, 1400], "inpainted": false }
  ],
  "effects": {
    "foil": { "layers": [2], "type": "rainbow", "intensity": 1 },
    "glare": true
  }
}
```

`effects.foil.layers` 是相对整卡光泽的关键差异：**光泽可以只作用在指定层的 alpha 形状内**，
比如只有人物闪、背景不闪。演示页上那个勾选框可以直接对比两种效果。

## 渲染器的一个坑

分层视差**不要用 `translateZ`**。它会引入透视缩放，每层大小对不上，需要额外 scale 补偿且很难调。
本项目改成每层各自做 2D 位移，位移量正比于该层的视差系数，完全可控。

另一个必须处理的细节：某一层向右移动 d 像素后，它的左边缘会露出空白。
所以每层要按 `1 + 2d/宽度` 放大补偿，这个系数由渲染器根据振幅自动算。

## 跑起来

```bash
pnpm install
pnpm dev
```

演示页默认加载手工 SVG 素材（`public/samples/forest`），拖一张照片进去会走完整流水线。
首次处理会下载约 50MB 的深度模型，之后走浏览器缓存。

## 选型与许可证

模型选择受开源许可证的硬约束，这部分踩过坑，记录下来：

| 部件 | 选型 | 许可证 | 体积 |
|---|---|---|---|
| 深度估计 | [Depth Anything V2-Small](https://huggingface.co/onnx-community/depth-anything-v2-small) | Apache 2.0 | ~50MB (fp16) |
| 边缘精修（未接） | [BiRefNet_lite](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) | MIT | ~100MB (fp16) |
| 补洞 | push-pull 金字塔 | 本项目 | 0 |

避开的坑：

- **RMBG-1.4 和 RMBG-2.0 都是非商用许可**，开源项目用不了。RMBG-2.0 就是 BiRefNet 架构 + Bria 的私有数据，
  网上一堆教程在推它，但许可证不允许。
- **Depth Anything V3 的 Large/Giant 是 CC-BY-NC**，只有 Small/Base 是 Apache 2.0。
  而且 V3 目前没有官方 ONNX 导出，浏览器端现阶段只能用 V2-Small。
- **BiRefNet 全量 ONNX 有 973MB**，浏览器直接爆 WASM 内存，必须用 lite 版。
- **SAM 自动 mask 生成在浏览器不现实**——不是 encoder 大的问题，是要在图上撒网格点跑几百次 decoder。

构建产物里有一个 26MB 的 `ort-wasm-simd-threaded.asyncify.wasm`，这是 ONNX Runtime 的 WASM 后端，
只在 WebGPU 不可用时按需拉取，不是首屏成本。自托管而不是走 CDN 是刻意的——「图片不出设备」要彻底。

## 路线图

- [x] 卡片渲染器：分层视差 + 逐层光泽 + 跟随指针高光
- [x] `.layers` 格式与读写
- [x] 浏览器端深度估计（Depth Anything V2-Small，WebGPU / WASM 自动降级）
- [x] 深度直方图谷底自适应切层
- [x] push-pull 补洞
- [ ] BiRefNet_lite 精修主体边缘（当前边界完全来自深度图，头发丝这类细节还不行）
- [ ] 渐进式加载：深度模型就绪先出粗卡，精修模型后台加载完再悄悄换上
- [ ] 导出 `.layers` 压缩包 / 导出视频
- [ ] Python CLI 轨：DA3 + SAM2 + LaMa，离线产出高质量层
- [ ] 陀螺仪支持（移动端）

## 已知限制

- 边界质量完全取决于深度图。头发、树枝这类细结构会糊，需要等边缘精修那一步。
- 地面、墙面这类**横跨整个深度范围的延展面**目前会被切开。已知的解法是先用分割拿到
  物体级 mask，再按 mask 内深度方差判断是不是延展面——这依赖尚未接入的分割模型。
- 深度分布过于连续的图（比如一整片斜坡）切不出有意义的层，会退化成等质量切分。

## License

MIT
