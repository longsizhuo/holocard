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
 */

/** 当前格式版本，破坏性变更时递增 */
export const LAYERS_FORMAT_VERSION = 1;

/** 包围盒，像素坐标，[x, y, width, height] */
export type BBox = readonly [x: number, y: number, width: number, height: number];

/** 光泽类型 */
export type FoilType = 'rainbow' | 'linear' | 'galaxy' | 'none';

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
}

export interface FoilEffect {
  /** 光泽作用在哪几层（LayerEntry 在数组中的下标）。空数组 = 整卡统一光泽 */
  layers: number[];
  type: FoilType;
  /** 强度 0..1 */
  intensity: number;
}

export interface LayerEffects {
  foil: FoilEffect;
  /** 是否启用跟随指针的高光 */
  glare: boolean;
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
