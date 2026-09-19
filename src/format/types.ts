/**
 * .layers 格式 —— HoloCard 的中间表示。
 *
 * 这个格式把「分层算法」和「卡片渲染」彻底解耦：
 * 任何能产出 LayerSet 的东西（浏览器端模型、Python CLI、甚至 Photoshop 手工导出）
 * 都能喂给渲染器；反过来渲染器也可以被单独拿去用。
 *
 * 磁盘布局：
 *   mycard.layers/
 *   ├── manifest.json   ← LayerManifest
 *   ├── layer-0.png     ← 最远
 *   ├── layer-1.png
 *   └── layer-2.png     ← 最近
 *
 * 一张卡由四样东西叠成，这个划分对应真实闪卡的印刷结构：
 *   1. 景深层        画面内容，带视差
 *   2. 每层的箔面    各层各有各的箔，随所在层一起移动（LayerEntry.foil）
 *   3. 整卡炫光      铺满卡面的细微五彩，只在特定倾角出现（effects.halo）
 *   4. 整卡高光      跟随指针的镜面反光（effects.glare）
 */

/** 当前格式版本，破坏性变更时递增 */
export const LAYERS_FORMAT_VERSION = 1;

/** 包围盒，像素坐标，[x, y, width, height] */
export type BBox = readonly [x: number, y: number, width: number, height: number];

/**
 * 箔面配方。配方本身移植自 pokemon-cards-css（GPL-3.0），见 renderer/foils.css。
 *   none       哑光，不上箔。真实闪卡的主体通常就是这样：不透明油墨把箔底盖住了
 *   holo       经典闪卡：斜向彩虹 + 细扫描线 + 竖向光栅（原 rare holo）
 *   sunpillar  V 卡那种斜向日柱彩虹，带金属颗粒（原 rare holo v）
 *   rainbow    彩虹稀有：闪粉 + 多色渐变（原 rare rainbow）
 */
export type FoilType = 'none' | 'holo' | 'sunpillar' | 'rainbow';

export const FOIL_TYPES: readonly FoilType[] = ['none', 'holo', 'sunpillar', 'rainbow'];

export interface LayerFoil {
  type: FoilType;
  /** 强度 0..1 */
  intensity: number;
}

export interface LayerSource {
  /** 原图宽度（像素） */
  width: number;
  /** 原图高度（像素） */
  height: number;
}

export interface LayerEntry {
  /** 相对 manifest.json 的文件名，如 "layer-0.png" */
  file: string;

  /**
   * 该层的代表深度，0 = 最远，1 = 最近。
   * 来自深度图在该层 alpha 区域内的中位数。
   */
  depth: number;

  /**
   * 视差系数。渲染时该层的位移量 = parallax × 全局振幅。
   * 默认由 depth 线性推导，但允许手工覆盖——
   * 因为「物理正确的视差」和「好看的视差」经常不是一回事。
   */
  parallax: number;

  /**
   * 有效像素的包围盒。渲染器可以只上传这块区域到 GPU 省显存，
   * 背景层通常是满幅，前景层往往只占一小块。
   */
  bbox: BBox;

  /** 该层被遮挡区域是否已经做过补洞。未补洞的层大幅位移时会露出空洞 */
  inpainted: boolean;

  /**
   * 这一层的箔面。箔只出现在该层自己的 alpha 形状里，并随该层一起做视差位移。
   *
   * 参考项目里这件事靠作者为每张卡手工准备的 --mask 图来做；
   * 我们的分层结果就是自动生成的 mask。
   */
  foil: LayerFoil;
}

/**
 * 整卡炫光的光照模型。
 *
 * 炫光不是「鼠标在哪就亮哪」，而是卡面转到某个角度、
 * 正好把光源反射进眼睛时才浮出细微的五彩，其余角度几乎看不见。
 * 这里用「五彩最强时的指针位置」来描述那个角度，比直接写光源坐标好调。
 */
export interface HaloLight {
  /** 五彩最强时的指针位置，归一化到 -1..1，[0,0] 是卡片中心 */
  peakAt: readonly [nx: number, ny: number];
  /** 角度窗口锐度。越大，出五彩的倾角范围越窄 */
  sharpness: number;
}

/**
 * 整卡炫光：铺满整张卡面、压在所有层之上、不参与视差。
 * 和每层的箔面是两回事——箔面是主角，这个只是面向光源时浮出的一层细微五彩。
 */
export interface HaloEffect {
  /** 强度 0..1，0 即关闭。应当给得克制 */
  intensity: number;
  light: HaloLight;
}

export interface LayerEffects {
  halo: HaloEffect;
  /** 跟随指针的整卡镜面高光 */
  glare: boolean;
}

export const DEFAULT_HALO_LIGHT: HaloLight = {
  // 默认光源在右上方
  peakAt: [0.7, -0.7],
  // 倾斜角只有十几度，法线夹角很小，锐度必须给得很高才切得出角度窗口
  sharpness: 120,
};

export function defaultHalo(): HaloEffect {
  return { intensity: 0.35, light: { ...DEFAULT_HALO_LIGHT } };
}

/**
 * 按层序给出默认箔面。
 *
 * 思路来自真实闪卡的印法：底材是箔，主体用不透明油墨盖住所以哑光，
 * 背景不盖所以闪。于是最远层上最抢眼的箔，最近层（主体）保持哑光，
 * 中间层用另一种箔拉开层次。
 */
export function defaultFoilFor(index: number, layerCount: number): LayerFoil {
  if (layerCount <= 1) return { type: 'sunpillar', intensity: 1 };
  if (index === layerCount - 1) return { type: 'none', intensity: 1 };
  if (index === 0) return { type: 'sunpillar', intensity: 1 };
  return { type: 'holo', intensity: 0.8 };
}

export interface LayerManifest {
  version: typeof LAYERS_FORMAT_VERSION;
  source: LayerSource;
  /** 按深度从远到近排序，layers[0] 最远 */
  layers: LayerEntry[];
  effects: LayerEffects;
  /** 生成者标识，便于排查是哪条流水线产出的，如 "holocard-web/0.1.0 da2-small" */
  generator?: string;
}

/**
 * 运行时的层集合：manifest + 每层的图片数据。
 * 渲染器吃这个，不关心图片是从磁盘来的还是内存里现算的。
 *
 * 这里刻意用 Blob 而不是 ImageBitmap：CSS 的 mask-image 只认 URL，
 * 而 ImageBitmap 没法直接喂给 mask-image 或 <img>。
 * object URL 的创建与回收由渲染器负责。
 */
export interface LayerSet {
  manifest: LayerManifest;
  /** 与 manifest.layers 一一对应的图片数据，顺序相同 */
  images: Blob[];
}
