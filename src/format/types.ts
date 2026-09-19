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

/** 炫光花纹类型 */
export type HaloType = 'rainbow' | 'linear' | 'galaxy' | 'none';

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

/**
 * 卡面光照模型。
 *
 * 真实卡片的炫光不是「鼠标在哪就亮哪」，而是卡面法线转到某个角度、
 * 正好把光源反射进眼睛时才爆出虹彩，其余角度只剩很淡的底光。
 * 这里不直接描述光源坐标，而是用「虹彩最强时的卡片姿态」来描述——
 * 调起来直观得多，而且与倾斜角设成多少无关。
 */
export interface HaloLight {
  /** 虹彩最强时的卡片姿态，用归一化指针位置表示，各分量 -1..1 */
  peakAt: readonly [nx: number, ny: number];
  /**
   * 角度窗口锐度。越大，虹彩出现的倾角范围越窄，
   * 越接近真卡那种「转到某个角度突然爆开」的观感。
   */
  sharpness: number;
}

/**
 * 卡面炫光。
 *
 * 关键：这是卡面本身的物理属性，不属于任何景深层。
 * 真实卡片的箔膜压在卡面上，转动卡片时它不会跟着画面里的人物一起位移，
 * 所以 halo 既不参与视差，也默认铺满整张卡面。
 */
export interface HaloEffect {
  type: HaloType;
  /** 强度 0..1。真卡的虹彩是「细微的五彩」，默认给得克制 */
  intensity: number;
  /**
   * 压印形状：null = 整张卡面，这是真实卡片的常态。
   * 给层下标则用该层的 alpha 当压印形状——但压印依然在卡面上，不随视差移动，
   * 所以大角度倾斜时它会和画面里的主体轻微错开。这是对的：
   * 就像窗户上的灰尘不会跟着窗外的景物一起动。
   */
  maskLayer: number | null;
  light: HaloLight;
}

export interface LayerEffects {
  halo: HaloEffect;
  /** 跟随指针的镜面高光。同样是卡面效果，不随视差移动 */
  glare: boolean;
}

export const DEFAULT_HALO_LIGHT: HaloLight = {
  // 默认光源在右上方，卡片朝那个方向抬起时爆虹彩
  peakAt: [0.7, -0.7],
  // 倾斜角只有十几度，法线夹角很小，锐度必须给得很高才切得出角度窗口
  sharpness: 120,
};

/** 卡面炫光的默认配置：整张卡面、克制的强度 */
export function defaultHalo(): HaloEffect {
  return {
    type: 'rainbow',
    intensity: 0.55,
    maskLayer: null,
    light: { ...DEFAULT_HALO_LIGHT },
  };
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
