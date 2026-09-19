# HoloCard

把任意照片自动切成前中后景，每层各上各的箔面，渲染成可交互的闪卡。全部在浏览器本地完成，图片不上传。

箔面效果和交互手感移植自 [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css)
（Simon Goellner，GPL-3.0）。那个项目的每张卡都要作者手工准备一张遮罩图，标出「箔面从哪里透出来」；
HoloCard 做的事情是**用分层算法自动生成这张遮罩**，于是任意一张照片都能变成闪卡。

> 状态：早期。渲染器与分层流水线已跑通，遮罩的边缘精修还没接。见下方路线图。

## 一张卡由什么叠成

结构对应真实闪卡的印法：底材是箔，主体用不透明油墨盖住所以哑光，背景不盖所以闪。

| | 作用范围 | 随视差移动 | 何时出现 |
|---|---|---|---|
| **景深层** | 各层自己的画面 | 是，各层系数不同 | 始终 |
| **每层的箔面** | 只在该层的 alpha 形状内 | 是，跟着所在层 | 一悬停就亮 |
| **整卡炫光** | 整张卡面 | 否 | 只在特定倾角浮出细微五彩 |
| **整卡高光** | 整张卡面 | 否 | 跟随指针 |

默认的箔面分配是「最远层上日柱、中间层上经典闪卡、最近层（主体）哑光」，
演示页上每层都有下拉框可以换。

每层的画面和箔面包在同一个带 `transform` 的容器里，这有两个作用：箔面天然跟着所在层一起动；
而且 `transform` 会产生独立的层叠上下文，箔面的 `color-dodge` 只和**这一层自己的画面**混合，
不会透下去染到更远的层。

## 分层流水线

```
照片
 └→ Depth Anything V2-Small ──→ 连续深度图（决定层序）
      └→ 深度直方图谷底切层 ──→ 层数自适应 2~4 层
           └→ smoothstep 羽化 ──→ 每层 alpha（同时也是这一层的箔面遮罩）
                └→ push-pull 填充 ──→ 补掉底层被遮挡的区域
                     └→ .layers ──→ 渲染器
```

每一层同时承担两个角色：带视差的画面，以及这一层箔面的遮罩。所以这里需要两种信息——

- **谁在前面**（排序）：来自单目深度估计。抠图模型只分「主体 / 背景」，给不出三层以上的层序。
- **边界在哪**（遮罩质量）：遮罩边缘就是箔面边缘，毛不毛一眼就能看出来。
  目前边界完全来自深度图，而深度图在物体边缘是糊的，这是当前最大的短板，
  也是下一步要接抠图模型（BiRefNet_lite）做边缘精修的原因。

几个设计决定：

**层边界落在深度直方图的谷底，不是均匀切。** 谷底就是场景中本来没什么东西的那些距离。
在有内容的地方硬切会把一个物体劈成两半。层数也是算出来的——很多照片本来就只有两层。

**边界羽化而不是硬阈值。** 硬切会把一圈背景像素粘在前景层上，一做视差位移那圈脏边就跟着主体飘。

**补洞不需要神经网络。** 卡片倾斜产生的视差位移只有几十像素，露出的空洞是细条不是大洞，
push-pull 金字塔填充（纯 JS，约 80 行）足够。

## 渲染器

交互手感逐条对齐上游：

- **弹簧驱动**：转角、高光、背景位移各一根弹簧，跟手时 `stiffness 0.066 / damping 0.25`；
  松手后等 500ms，再用很软的弹簧（`0.01 / 0.06`，soft 启动）缓缓回正。
  弹簧语义与 svelte/motion 一致，所以上游调好的参数可以原样用。
- **转角映射**：`rotateY(-(x-50)/3.5) rotateX((y-50)/3.5)`，最大约 ±14.3°，透视 600px。
  指针所在的一侧朝观察者抬起。
- **背景位移收窄**到 37%–63% / 33%–67%，箔面花纹只是微微游动，不会满屏乱扫。
- **`--pointer-from-center`** 调制亮度，越靠卡片边缘箔面越亮。

CSS 变量名（`--pointer-x`、`--background-x`、`--card-opacity` 等）刻意与上游保持一致，
以后要再移植别的稀有度，配方可以直接贴进 `foils.css`。

两张纹理（grain / glitter）是运行时程序化生成的，仓库里没有二进制素材。

我们自己加的部分：

**视差不用 `translateZ`。** 它会引入透视缩放，每层大小对不上。改成每层各自做 2D 位移，
位移量正比于该层的视差系数。近层的位移方向与指针相反——右缘抬起相当于观察者站到了右边，
近处的东西相对远处向左移。某一层平移 d 像素后另一侧会露白，所以每层按 `1 + 2d/宽度` 放大补偿。

**整卡炫光是角度事件。** 由当前转角推卡面法线，与「能把光源反射进眼睛」的那个朝向做点积，
宽窄两瓣叠加。默认参数下的强度：静止 0.12 / 峰值倾角 1.00 / 反方向 0.01。

**`setPose({x, y})`** 可以不走动画直接把卡片摆到指定姿态，用来生成静态预览图，
或者用陀螺仪之类的外部输入驱动。

## `.layers` 格式

这个格式把算法和渲染解耦。任何能产出它的东西都能喂给渲染器，渲染器也可以被单独拿去用——
手工在 Photoshop 里切的图一样能渲染。

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
    {
      "file": "layer-0.png", "depth": 0.08, "parallax": 0.0,
      "bbox": [0, 0, 734, 1024], "inpainted": true,
      "foil": { "type": "sunpillar", "intensity": 1 }
    },
    {
      "file": "layer-2.png", "depth": 0.92, "parallax": 1.0,
      "bbox": [120, 80, 500, 900], "inpainted": false,
      "foil": { "type": "none", "intensity": 1 }
    }
  ],
  "effects": {
    "halo": { "intensity": 0.35, "light": { "peakAt": [0.7, -0.7], "sharpness": 120 } },
    "glare": true
  }
}
```

`foil.type` 目前有四种：`none`（哑光）、`holo`（经典闪卡）、`sunpillar`（V 卡日柱）、`rainbow`（彩虹闪粉）。

## 跑起来

```bash
pnpm install
pnpm dev
```

演示页默认加载手工 SVG 素材（`public/samples/forest`），拖一张照片进去会走完整流水线。

## 部署：模型托管

**不需要自己托管模型。** transformers.js 默认从 Hugging Face 官方 CDN 拉权重，
整个站是纯静态的，GitHub Pages / Cloudflare Pages 直接部署。

| | |
|---|---|
| 浏览演示页 | 约 27KB（transformers.js 被动态 import 挡在首屏之外） |
| 首次处理照片 | 约 50MB 权重，一次性，之后走浏览器缓存 |
| 缓存后再处理 | 0 额外下载，单张几秒（WebGPU） |

**huggingface.co 在中国大陆访问困难**，需要镜像时改环境变量即可，见 `.env.example`：

```bash
VITE_MODEL_HOST=https://hf-mirror.com/
```

也可以指向自建的 R2 / OSS / jsDelivr 镜像，或用 `VITE_MODEL_DTYPE=q8` 把权重压到约 25MB。

**为什么不放服务端推理？** 「图片不出设备」这个卖点会没，而且推理成本随用户数线性增长。

## 模型选型与许可证

| 部件 | 选型 | 许可证 | 体积 |
|---|---|---|---|
| 深度估计 | [Depth Anything V2-Small](https://huggingface.co/onnx-community/depth-anything-v2-small) | Apache 2.0 | ~50MB (fp16) |
| 边缘精修（未接） | [BiRefNet_lite](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) | MIT | ~100MB (fp16) |
| 补洞 | push-pull 金字塔 | 本项目 | 0 |

避开的坑：

- **RMBG-1.4 和 RMBG-2.0 都是非商用许可**。RMBG-2.0 就是 BiRefNet 架构 + Bria 的私有数据。
- **Depth Anything V3 的 Large/Giant 是 CC-BY-NC**，只有 Small/Base 是 Apache 2.0，
  而且 V3 目前没有官方 ONNX 导出。
- **BiRefNet 全量 ONNX 有 973MB**，浏览器直接爆 WASM 内存，必须用 lite 版。
- **SAM 自动 mask 生成在浏览器不现实**——要在图上撒网格点跑几百次 decoder。

构建产物里有一个 26MB 的 `ort-wasm-simd-threaded.asyncify.wasm`，这是 ONNX Runtime 的 WASM 后端，
只在 WebGPU 不可用时按需拉取，不是首屏成本。

## 路线图

- [x] 渲染器：弹簧驱动的 3D 转卡、逐层箔面遮罩、分层视差、整卡炫光与高光
- [x] 三套箔面配方：holo / sunpillar / rainbow
- [x] `.layers` 格式与读写
- [x] 浏览器端深度估计（WebGPU / WASM 自动降级）、直方图谷底自适应切层、push-pull 补洞
- [x] 可配置的模型来源（支持国内镜像 / 自建 CDN）
- [ ] **BiRefNet_lite 精修遮罩边缘**——遮罩边缘就是箔面边缘，这是当前最大的短板
- [ ] 更多箔面配方：cosmos、radiant、secret rare、reverse holo
- [ ] 点击弹出放大（上游的 popover + 首次 360° 翻转）、首屏自动展示动画
- [ ] 陀螺仪驱动（移动端），`setPose` 已经留好了入口
- [ ] 导出 `.layers` 压缩包 / 导出视频
- [ ] Python CLI 轨：更大的模型，离线产出高质量层

## 已知限制

- 遮罩边缘来自深度图，头发、树枝这类细结构会糊，箔面边缘也就跟着糊。
- `color-dodge` 在暗部几乎不起作用，所以背景很暗的照片箔面会不明显。上游也是同样的特性。
- 地面、墙面这类**横跨整个深度范围的延展面**目前会被切开。
- 深度分布过于连续的图（比如一整片斜坡）切不出有意义的层，会退化成等质量切分。

## 致谢与许可

箔面配方（`src/renderer/foils.css`）和交互映射（`src/renderer/card.ts` 中标注的部分）
移植自 [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css)，
作者 Simon Goellner（[@simeydotme](https://github.com/simeydotme)），GPL-3.0。
弹簧的积分语义参照 [svelte/motion](https://github.com/sveltejs/svelte)（MIT）。

本项目以 **GPL-3.0** 发布，见 [LICENSE](LICENSE)。
