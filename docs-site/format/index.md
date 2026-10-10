# `.layers` 文件格式

`.layers` 是 HoloCard 的中间格式：分层流水线产出它，网站的渲染器和 [`@holocard/player`](/player/) 读取它。格式把分层算法与卡片渲染解耦，任何能产出这一格式的工具（包括在图像编辑软件中手工切图）都可以交给渲染器使用。[API](/api/) 交付的结果也是这一格式。

格式定义见 `src/format/types.ts`，读取与校验见 `src/format/io.ts`，可编辑字段的校验见 `src/format/config.ts`。

## 目录结构

一张卡是一个目录，包含一份 `manifest.json` 和每层一张图片：

```
mycard.layers/
├── manifest.json
├── layer-0.webp      # 最远
├── layer-1.webp
└── layer-2.webp      # 最近
```

- 每层图片与原图同尺寸，带透明通道，按 `manifest.json` 中的顺序由远及近叠放后还原原图。
- 图片的透明通道同时是这一层的形状和这一层箔面的遮罩。
- 图片可以是浏览器能解码的任何格式。服务端产出的是 WebP（画面有损、透明通道无损）。
- 文件名不限，但只能是与 `manifest.json` 同目录下的文件名，不能包含路径分隔符或 `..`。

## manifest.json

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `version` | number | 是 | 格式版本，当前必须为 `1`，其他值拒绝读取 |
| `source` | object | 是 | 原图尺寸，见下表 |
| `layers` | array | 是 | 各层，至少一项，见下表 |
| `effects` | object | 否 | 整卡效果，缺省时使用默认值，见下表 |
| `generator` | string | 否 | 生成者标识，用于排查，如 `holocard-web/0.1.0 depth-anything-v2-small layers=2` |

### `source`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source.width` | number | 是 | 原图宽度（像素） |
| `source.height` | number | 是 | 原图高度（像素） |

渲染器按 `width / height` 决定卡片的宽高比。

### `layers[]`

| 字段 | 类型 | 必填 | 缺省值 | 说明 |
|---|---|---|---|---|
| `file` | string | 是 | — | 层图片的文件名，相对 `manifest.json` 所在目录 |
| `depth` | number | 是 | — | 该层的代表深度，`0` 为最远，`1` 为最近 |
| `parallax` | number | 否 | 等于 `depth` | 视差系数，见「播放器与网站如何使用这些字段」 |
| `bbox` | `[x, y, w, h]` | 是 | — | 该层有效像素的包围盒，像素坐标，4 个数字 |
| `inpainted` | boolean | 否 | `false` | 该层被遮挡的区域是否已补全；只有值为 `true` 时视为已补全 |
| `foil` | object | 否 | 按层序给出，见下文 | 该层的箔面 |
| `foil.type` | string | 是（`foil` 存在时） | — | 箔面类型，取值见「箔面类型」 |
| `foil.intensity` | number | 否 | `1` | 箔面强度，0～1，超出范围时截断 |

读取时 `layers` 按 `depth` 从小到大重新排序，`layers[0]` 始终是最远层，与文件中的书写顺序无关。

`foil` 缺省或 `foil.type` 不合法时，按层序补默认箔面：

| 层数 | 最远层 | 中间层 | 最近层 |
|---|---|---|---|
| 1 | `sunpillar`，强度 1 | — | — |
| 2 及以上 | `sunpillar`，强度 1 | `holo`，强度 0.8 | `none`，强度 1 |

### `effects`

| 字段 | 类型 | 缺省值 | 取值范围 | 说明 |
|---|---|---|---|---|
| `effects.halo.intensity` | number | `0.35` | 0～1 | 整卡炫光强度，`0` 为关闭 |
| `effects.halo.light.peakAt` | `[nx, ny]` | `[0.7, -0.7]` | 各 -1～1 | 炫光最强时的指针位置，`[0, 0]` 为卡片中心；默认光源在右上方 |
| `effects.halo.light.sharpness` | number | `120` | 10～400 | 角度窗口的锐度，越大出现炫光的倾角范围越窄 |
| `effects.glare` | boolean | `true` | — | 是否显示跟随指针的整卡高光；只有值为 `false` 时关闭 |
| `effects.parallax` | object | 无 | — | 作者保存的视差设置，可以没有 |
| `effects.parallax.enabled` | boolean | — | — | 视差开关 |
| `effects.parallax.amplitude` | number | — | 0～0.16 | 视差振幅，占卡宽的比例；开关关闭时保留该值 |

`effects.parallax` 必须完整且合法（`enabled` 为布尔值、`amplitude` 在 0～0.16 之间）才会被采用，否则视为没有保存过。

## 箔面类型

`foil.type` 的取值（`FOIL_TYPES`）：

| 取值 | 网站上的名称 | 效果 | 上游配方（pokemon-cards-css） |
|---|---|---|---|
| `none` | 哑光（不上箔） | 不上箔，对应真实闪卡上被不透明油墨覆盖的主体 | — |
| `holo` | 经典闪卡 holo | 斜向彩虹、细扫描线与竖向光栅 | rare holo |
| `sunpillar` | 日柱 sunpillar | 斜向日柱彩虹，带金属颗粒 | rare holo v |
| `rainbow` | 彩虹闪粉 rainbow | 闪粉与多色渐变 | rare rainbow |

## 示例

网站首页的示例卡（`public/samples/demo/manifest.json`），两层，没有保存过视差设置：

```json
{
  "version": 1,
  "source": { "width": 1400, "height": 788 },
  "generator": "holocard-web/0.1.0 depth-anything-v2-small layers=2 cuts=[0.251@0.137]",
  "layers": [
    {
      "file": "layer-0.webp",
      "depth": 0.13380292057991028,
      "parallax": 0,
      "bbox": [0, 0, 1400, 788],
      "inpainted": true,
      "foil": { "type": "sunpillar", "intensity": 1 }
    },
    {
      "file": "layer-1.webp",
      "depth": 0.5165139436721802,
      "parallax": 1,
      "bbox": [436, 59, 832, 729],
      "inpainted": false,
      "foil": { "type": "none", "intensity": 1 }
    }
  ],
  "effects": {
    "halo": { "intensity": 0.35, "light": { "peakAt": [0.7, -0.7], "sharpness": 120 } },
    "glare": true
  }
}
```

卡的主人在网站上调整并保存后，`effects` 中会多出 `parallax`，例如：

```json
"parallax": { "enabled": true, "amplitude": 0.1 }
```

## 播放器与网站如何使用这些字段

网站的渲染器与 `@holocard/player` 使用同一套渲染代码（`src/renderer/`），对字段的处理相同，区别只在缺少 `effects.parallax` 时的视差振幅。

| 字段 | 用途 |
|---|---|
| `source.width` / `source.height` | 卡片的宽高比 |
| `layers[].depth` | 决定层的前后顺序；`parallax` 缺省时作为视差系数 |
| `layers[].parallax` | 每层的平移量 = (`parallax` − 焦平面) × 振幅。焦平面取全部层中最小与最大 `parallax` 的中点，近处的层向外移，远处的层向内退；全部层按同一倍数 1 + 2 × 最大偏移 × 振幅放大，避免边缘露白。`parallax` 相同的相邻层视为一组，一起移动，共用一份炫光与高光 |
| `layers[].file` | 层图片；它的透明通道同时作为该层箔面的遮罩 |
| `layers[].foil` | 该层的箔面类型与强度，箔面只在该层的形状内显示 |
| `layers[].bbox` | 描述有效像素范围，当前渲染器不使用 |
| `layers[].inpainted` | 标记是否已补全遮挡区域，当前渲染器不使用；未补全的层大幅位移时会露出空洞 |
| `effects.halo` | 整卡炫光的强度与角度窗口；网站调参时卡片自动转到 `peakAt` 对应的角度展示效果 |
| `effects.glare` | 为 `false` 时不显示整卡高光 |
| `effects.parallax` | 有：网站和播放器都按它（`enabled` 为 `false` 时振幅为 0）。没有：网站按看卡的人本机的「立体视差」偏好，振幅 2%；播放器使用默认振幅 0.02 |
| `generator` | 网站在处理完成时显示在状态栏，不参与渲染 |

### 作者配置

网站上可编辑并随分享保存的只有以下字段，称为作者配置（`CardConfig`）。卡的主人在面板上调整后，网站将它保存到服务端，服务端校验后合并进 `manifest.json`，分享页、分享预览图和导出的动图都按保存后的结果渲染：

| 作者配置 | 对应 manifest 字段 | 取值范围 |
|---|---|---|
| `foils[]`（与 `layers` 一一对应，由远及近） | `layers[].foil.type`、`layers[].foil.intensity` | `FOIL_TYPES` 之一；0～1 |
| `halo.intensity` | `effects.halo.intensity` | 0～1 |
| `halo.sharpness` | `effects.halo.light.sharpness` | 10～400 |
| `parallax.enabled`、`parallax.amplitude` | `effects.parallax` | 布尔值；0～0.16 |

层数必须与卡片一致，任何一项不合法时整份配置被拒绝。层文件名、深度、视差系数、`peakAt` 等字段由流水线决定，不能通过网站修改。

读取 `manifest.json` 时，`effects.halo.intensity` 与 `sharpness` 只要求是有限数，不检查范围；网站从这类 manifest 取出作者配置时会先截断到上表范围内。
