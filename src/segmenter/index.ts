/**
 * 分层流水线：一张图片 → 一组 .layers
 *
 * 流程：
 *   estimateDepth  拿到连续深度，决定谁在前
 *   analyzeDepth   在深度直方图的谷底切层，层数自适应
 *   extractLayers  深度边缘吸附、引导滤波精修边界、逐层补全
 *
 * 产出的每一层同时承担两个角色：带视差的画面，以及这一层箔面的遮罩——
 * 参考项目里那张靠手工准备的 --mask 图，在这里是自动生成的。
 * 所以层边缘的干净程度直接决定箔面边缘好不好看。
 */

import {
  LAYERS_FORMAT_VERSION,
  defaultFoilFor,
  defaultHalo,
  type LayerEntry,
  type LayerSet,
} from '../format/types';
import { estimateDepth } from './depth';
import type { LoadProgress } from './runtime';
import { analyzeDepth, buildCutEvidence, type SliceOptions } from './slice';
import { extractLayers, type ExtractOptions } from './extract';
import { browserImages } from './image-io';

/** 算梯度证据时把原图缩到多大。只用于统计，不参与出图，512 足够且便宜 */
const EVIDENCE_SIZE = 512;

export type SegmentStage =
  | 'loading-model'
  | 'estimating-depth'
  | 'analyzing'
  | 'extracting'
  | 'done';

export interface SegmentProgress {
  stage: SegmentStage;
  /** 给人看的一句话（中文，日志和服务端用；界面按 stage / file 自己翻译） */
  detail: string;
  /** 正在下载的模型文件，只在 loading-model 阶段有 */
  file?: string;
  /** 0..1，拿不到确切进度时为 undefined */
  ratio?: number;
}

export interface SegmentOptions {
  slice: Partial<SliceOptions>;
  extract: Partial<ExtractOptions>;
  onProgress: (p: SegmentProgress) => void;
}

const STAGE_TEXT: Record<SegmentStage, string> = {
  'loading-model': '正在加载深度模型',
  'estimating-depth': '正在估计深度',
  analyzing: '正在分析深度分布',
  extracting: '正在切层与补洞',
  done: '完成',
};

/**
 * 把每层的深度中位数映射成视差系数。
 *
 * 用相对位置而不是深度绝对值：最远的层锚定为 0（完全不动），最近的层为 1。
 * 这样不管原图深度范围是宽是窄，视差观感都一致。
 */
function toParallax(depths: number[], rigid: boolean[]): number[] {
  const n = depths.length;
  if (n === 0) return [];

  /*
   * 被「刚性边界」连起来的层算作一组，同组共用一个视差值——它们不会相对滑动。
   * 刚性边界是「画面上看得见但深度上没有遮挡台阶」的分界，两侧多半是同一个物体，
   * 让它们错开的话物体就自己断成两截（用户报过的「分尸」）。
   */
  const group = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    group[i] = (group[i - 1] ?? 0) + (rigid[i - 1] ? 0 : 1);
  }
  const groupCount = (group[n - 1] ?? 0) + 1;
  // 整张图连成一个刚体：分层只为箔面服务，完全不做视差
  if (groupCount <= 1) return depths.map(() => 0);

  // 每组取组内深度均值当代表，再归一化——没有刚性边界时行为和以前完全一致
  const sum = new Array<number>(groupCount).fill(0);
  const count = new Array<number>(groupCount).fill(0);
  depths.forEach((d, i) => {
    const g = group[i] ?? 0;
    sum[g] = (sum[g] ?? 0) + d;
    count[g] = (count[g] ?? 0) + 1;
  });
  const groupDepth = sum.map((v, k) => v / (count[k] || 1));

  const min = Math.min(...groupDepth);
  const max = Math.max(...groupDepth);
  const span = max - min;
  // 各组深度几乎一样时退化成按组序均分，至少还有层次感
  const groupParallax =
    span < 1e-6
      ? groupDepth.map((_, k) => k / (groupCount - 1))
      : groupDepth.map((d) => (d - min) / span);

  return depths.map((_, i) => groupParallax[group[i] ?? 0] ?? 0);
}

/**
 * 生成者标识，把切层决策也写进去。
 * 排查「为什么这张图切成两层 / 为什么切在这个位置」时，看这一行就够了。
 */
function buildGeneratorTag(cuts: number[], prominences: number[]): string {
  const detail = cuts
    .map((c, i) => `${c.toFixed(3)}@${(prominences[i] ?? 0).toFixed(3)}`)
    .join(',');
  return `holocard-web/0.1.0 depth-anything-v2-small layers=${cuts.length + 1} cuts=[${detail}]`;
}

export async function segmentToLayerSet(
  image: Blob,
  options: Partial<SegmentOptions> = {},
): Promise<LayerSet> {
  const report = (stage: SegmentStage, ratio?: number): void => {
    options.onProgress?.({
      stage,
      detail: STAGE_TEXT[stage],
      ...(ratio === undefined ? {} : { ratio }),
    });
  };

  report('loading-model');
  const onModelProgress = (p: LoadProgress): void => {
    options.onProgress?.({
      stage: 'loading-model',
      detail: p.file ? `正在下载 ${p.file}` : STAGE_TEXT['loading-model'],
      ...(p.file ? { file: p.file } : {}),
      ...(typeof p.progress === 'number' ? { ratio: p.progress / 100 } : {}),
    });
  };

  /*
   * 推理这一步本身没有进度事件，但它在服务端的 ARM CPU 上要两三秒，
   * 不切阶段的话界面会一直停在「正在加载模型」。
   * 第二次上传时更明显：loadDepthModel 命中缓存直接返回，onModelProgress
   * 一次都不会触发，进度条会卡在调用方给的占位值上不动。
   */
  const depth = await estimateDepth(image, onModelProgress, () => report('estimating-depth'));

  report('analyzing');

  /*
   * 切层之前先拿一份原图的梯度，用来核对每条切点在画面上是否真有边界。
   *
   * 为什么需要：纯色背景的插画上，深度模型会在那片没有纹理的区域凭空给出一道平滑的
   * 深度渐变，直方图在这道渐变里找出的「谷底」纯属噪声。照着切会把背景沿一条等深度线
   * 劈成两层，两层各上各的箔，接缝就是一道裂纹，而原图那里什么都没有。
   *
   * 解码一份小图就够——这里只要统计量，不需要全分辨率；相对模型推理这点开销可以忽略。
   */
  const backend = options.extract?.images ?? browserImages;
  const evidence = await (async () => {
    try {
      const small = await backend.decodeScaled(image, EVIDENCE_SIZE);
      return buildCutEvidence(small.data, small.width, small.height);
    } catch {
      // 解不出来就退回纯按深度分布切，不因为这一步失败而整个流程挂掉
      return null;
    }
  })();

  const { cuts, prominences, rigid } = analyzeDepth(depth, options.slice ?? {}, evidence);

  report('extracting');
  const { images, stats, width, height } = await extractLayers(
    image,
    depth,
    cuts,
    options.extract ?? {},
  );

  const parallax = toParallax(
    stats.map((s) => s.depth),
    rigid,
  );
  const layers: LayerEntry[] = stats.map((stat, i) => ({
    file: `layer-${i}.png`,
    depth: stat.depth,
    parallax: parallax[i] ?? 0,
    bbox: stat.bbox,
    // 除最前层外，每一层都向遮挡它的层身后做了补全
    inpainted: i < stats.length - 1,
    // 按真实闪卡的印法给默认箔面：最远层上箔，最近层（主体）哑光
    foil: defaultFoilFor(i, stats.length),
  }));

  report('done');

  return {
    manifest: {
      version: LAYERS_FORMAT_VERSION,
      source: { width, height },
      generator: buildGeneratorTag(cuts, prominences),
      layers,
      effects: {
        halo: defaultHalo(),
        glare: true,
      },
    },
    images,
  };
}

/** 导出给调试面板看的切层诊断信息 */
export { analyzeDepth, type SliceOptions } from './slice';
export { estimateDepth } from './depth';
export { browserImages, type ImageBackend, type RgbaImage } from './image-io';
export type { ExtractOptions } from './extract';
export type { DepthMap } from './slice';
