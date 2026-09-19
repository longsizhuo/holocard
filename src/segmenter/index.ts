/**
 * 分层流水线：一张图片 → 一组 .layers
 *
 * 流程是「深度定序 + 羽化定边界 + push-pull 补洞」：
 *   estimateDepth  拿到连续深度，决定谁在前
 *   analyzeDepth   在深度直方图的谷底切层，层数自适应
 *   extractLayers  羽化出每层 alpha，并把底层的遮挡区补掉
 *
 * 产出的每一层同时承担两个角色：带视差的画面，以及这一层箔面的遮罩——
 * 参考项目里那张靠手工准备的 --mask 图，在这里是自动生成的。
 * 所以层边缘的干净程度直接决定箔面边缘好不好看。
 *
 * 边缘精修（BiRefNet_lite 出主体 alpha）还没接，见 README 的路线图。
 */

import {
  LAYERS_FORMAT_VERSION,
  defaultFoilFor,
  defaultHalo,
  type LayerEntry,
  type LayerSet,
} from '../format/types';
import { estimateDepth, type LoadProgress } from './depth';
import { analyzeDepth, type SliceOptions } from './slice';
import { extractLayers, type ExtractOptions } from './extract';

export type SegmentStage =
  | 'loading-model'
  | 'estimating-depth'
  | 'analyzing'
  | 'extracting'
  | 'done';

export interface SegmentProgress {
  stage: SegmentStage;
  /** 给人看的一句话 */
  detail: string;
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
function toParallax(depths: number[]): number[] {
  if (depths.length === 0) return [];
  const min = Math.min(...depths);
  const max = Math.max(...depths);
  const span = max - min;
  // 所有层深度几乎一样时，退化成按层序均分，至少还有层次感
  if (span < 1e-6) {
    return depths.map((_, i) => (depths.length > 1 ? i / (depths.length - 1) : 0));
  }
  return depths.map((d) => (d - min) / span);
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
      ...(typeof p.progress === 'number' ? { ratio: p.progress / 100 } : {}),
    });
  };

  const depth = await estimateDepth(image, onModelProgress);

  report('analyzing');
  const { cuts, prominences } = analyzeDepth(depth, options.slice ?? {});

  report('extracting');
  const { images, stats, width, height } = await extractLayers(
    image,
    depth,
    cuts,
    options.extract ?? {},
  );

  const parallax = toParallax(stats.map((s) => s.depth));
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
export type { DepthMap } from './slice';
