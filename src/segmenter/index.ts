/**
 * 分层流水线：一张图片 → 一组 .layers
 *
 * 流程：
 *   estimateDepth  拿到连续深度，决定谁在前
 *   analyzeDepth   在深度直方图的谷底切层，层数自适应
 *   findSubject    （仅服务端）抠出主体，主体单独一层、不被切开，深度切点只留主体身后的
 *   extractLayers  深度边缘吸附、引导滤波精修边界、逐层补全
 *   findEffects    （仅服务端）识别画里的特效（光带、光晕、魔法阵、火焰、闪电、闪光点），按类型单独成层，
 *                  紧跟在它所在的那层后面，默认上光效。识别模型 SAM3-Card 跑在单独的服务上，和前面几步同时进行
 *
 * 产出的每一层同时承担两个角色：带视差的画面，以及这一层箔面的遮罩——
 * 参考项目里那张靠手工准备的 --mask 图，在这里是自动生成的。
 * 所以层边缘的干净程度直接决定箔面边缘好不好看。
 */

import {
  EFFECTS_FOIL,
  LAYERS_FORMAT_VERSION,
  type EffectKind,
  defaultFoilFor,
  defaultHalo,
  type LayerEntry,
  type LayerSet,
} from '../format/types';
import { estimateDepth } from './depth';
import type { LoadProgress } from './runtime';
import { analyzeDepth, buildCutEvidence, fitCutsToSubject, type SliceOptions } from './slice';
import type { Matte } from './matte';
import { keepMainParts } from './morph';
import { extractLayers, type ExtractOptions } from './extract';
import { browserImages } from './image-io';

/** 算梯度证据时把原图缩到多大。只用于统计，不参与出图，512 足够且便宜 */
const EVIDENCE_SIZE = 512;

export type SegmentStage =
  | 'loading-model'
  | 'estimating-depth'
  | 'analyzing'
  | 'finding-subject'
  | 'extracting'
  | 'finding-effects'
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
  /**
   * 抠主体。返回 null 表示这张图认不出主体（或者抠图模型不可用），照旧只按深度切层。
   * 只有服务端给：浏览器里跑不动这个模型，见 matte.ts。
   */
  findSubject: (image: Blob) => Promise<Matte | null>;
  /** 抠图用的模型名，写进 manifest 的 generator，事后排查、对比实验时分得清是哪个模型做的 */
  subjectModel: string;
  /**
   * 识别画里的特效，每类一张遮罩（大小不必和原图一样，按比例缩放后用）。返回 null 或空数组表示没有特效
   * （或识别服务不可用），不出特效层。只有服务端给，见 server/pipeline/effects.ts
   */
  findEffects: (image: Blob) => Promise<EffectMask[] | null>;
}

/** 一类特效在图上的位置：0..1 的遮罩 */
export interface EffectMask extends Matte {
  kind: EffectKind;
}

const STAGE_TEXT: Record<SegmentStage, string> = {
  'loading-model': '正在加载深度模型',
  'estimating-depth': '正在估计深度',
  analyzing: '正在分析深度分布',
  'finding-subject': '正在识别主体',
  extracting: '正在切层与补洞',
  'finding-effects': '正在识别特效',
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
function buildGeneratorTag(cuts: number[], prominences: number[], subject: string | null, effects: number): string {
  const detail = cuts
    .map((c, i) => `${c.toFixed(3)}@${(prominences[i] ?? 0).toFixed(3)}`)
    .join(',');
  const layers = cuts.length + 1 + (subject ? 1 : 0);
  return `holocard-web/0.1.0 depth-anything-v2-small${subject ? ` ${subject}` : ''} layers=${layers} cuts=[${detail}]${subject ? ' +subject' : ''}${effects ? ` +effects=${effects}` : ''}`;
}

/** 遮罩在输出尺寸 (x, y) 处的值，双线性插值：遮罩是识别服务按缩小的图出的，直接取最近的像素边缘是锯齿 */
function sampleMask(mask: EffectMask, x: number, y: number, width: number, height: number): number {
  const fx = Math.min(mask.width - 1, Math.max(0, ((x + 0.5) * mask.width) / width - 0.5));
  const fy = Math.min(mask.height - 1, Math.max(0, ((y + 0.5) * mask.height) / height - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(mask.width - 1, x0 + 1);
  const y1 = Math.min(mask.height - 1, y0 + 1);
  const at = (mx: number, my: number): number => mask.data[my * mask.width + mx] ?? 0;
  const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * (fx - x0);
  const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * (fx - x0);
  return top + (bottom - top) * (fy - y0);
}

interface EffectLayer {
  /** 跟在第几层后面 */
  owner: number;
  kind: EffectKind;
  blob: Blob;
  bbox: readonly [number, number, number, number];
}

/**
 * 特效层：特效像素归给「此处看得见的那一层」（由近及远第一个盖到一半的层）。
 * 主体层也算：抠图常把角色手边绕着的光环一起抠进主体，这些光环就该跟着主体动。每层每类一份，
 * 紧跟在那一层后面、深度和视差相同，于是两者一起移动、排序时也挨着（parseManifest 按深度稳定排序）。
 * 画面就是原图：静止时和下面那层叠出来一模一样，只多一份按特效形状的光效
 */
async function buildEffectLayers(
  extracted: { source: Uint8ClampedArray; alphas: Float32Array[]; width: number; height: number },
  masks: EffectMask[],
  encode: (image: { data: Uint8ClampedArray; width: number; height: number }) => Promise<Blob>,
): Promise<EffectLayer[]> {
  const { source, alphas, width, height } = extracted;
  const owner = new Int8Array(width * height).fill(-1);
  for (let p = 0; p < owner.length; p++) {
    for (let i = alphas.length - 1; i >= 0; i--) {
      if ((alphas[i]?.[p] ?? 0) >= 0.5) {
        owner[p] = i;
        break;
      }
    }
  }
  const result: EffectLayer[] = [];
  for (const mask of masks) {
    const values = new Float32Array(width * height);
    for (let p = 0; p < values.length; p++) {
      const x = p % width;
      values[p] = sampleMask(mask, x, (p - x) / width, width, height);
    }
    for (let i = 0; i < alphas.length; i++) {
      const data = new Uint8ClampedArray(source);
      let minX = width, minY = height, maxX = -1, maxY = -1;
      for (let p = 0; p < owner.length; p++) {
        const a = owner[p] === i ? (values[p] ?? 0) : 0;
        data[p * 4 + 3] = Math.round(a * 255);
        if (a <= 0) continue;
        const x = p % width;
        const y = (p - x) / width;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      if (maxX < 0) continue;
      result.push({ owner: i, kind: mask.kind, blob: await encode({ data, width, height }), bbox: [minX, minY, maxX - minX + 1, maxY - minY + 1] });
    }
  }
  return result;
}

/** 模型名缩成 generator 里的一个词：onnx-community/BiRefNet_lite-ONNX → birefnet-lite */
function subjectLabel(model = 'onnx-community/BiRefNet_lite-ONNX'): string {
  return (model.split('/').pop() ?? model).replace(/-ONNX$/i, '').replace(/_/g, '-').toLowerCase();
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

  // 特效识别在别的服务上跑，和这边的估深度、抠主体同时进行，切完层再取结果
  const effectsPending = options.findEffects?.(image).catch(() => null);

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

  let sliced = analyzeDepth(depth, options.slice ?? {}, evidence);

  let subject: Matte | null = null;
  if (options.findSubject) {
    report('finding-subject');
    const found = await options.findSubject(image);
    if (found) {
      /*
       * 碎块（面积不到最大块 5%）扔掉，离留下的块超过 1% 图宽的淡值（阴影、旁边路人，0.1~0.4）清零。
       * 淡值留着的话，主体层上是一片半透明副本，去背景色时颜色误差放大 1/a 倍，一动就是一片跟着主体走的重影
       */
      const reach = Math.max(1, Math.round(found.width * 0.01));
      subject = { ...found, data: keepMainParts(found.data, found.width, found.height, 0.05, reach) };
      sliced = fitCutsToSubject(sliced, depth, subject, evidence, options.slice?.maxLayers);
    }
  }
  const { cuts, prominences, rigid } = sliced;

  report('extracting');
  const extracted = await extractLayers(image, depth, cuts, {
    ...options.extract,
    subject,
  });
  const { images, stats, width, height } = extracted;

  const depths = stats.map((s) => s.depth);
  if (subject && depths.length > 1) {
    /*
     * 主体一定是最前面那层。按深度中位数它不一定最近：远处的人、脚下一大片近处的地面，
     * 背景层的中位数可以比主体还近。那样主体反而动得比背景少，看起来像陷进卡里。
     * 改过的值要写进 manifest：加载时 parseManifest 按 depth 重排层序，写原值的话主体会被排到
     * 背景层底下，被那张铺满全卡的背景整个盖住。
     * 封顶 1（depth 的约定是 0..1）。背景也到 1 时和主体相等：排序是稳定的，主体照样排在最后
     */
    const others = Math.max(...depths.slice(0, -1));
    depths[depths.length - 1] = Math.min(1, Math.max(depths[depths.length - 1] ?? 0, others + 0.05));
  }
  const parallax = toParallax(depths, rigid);
  const nearest = parallax[stats.length - 1] ?? 0;
  const farthest = parallax[0] ?? 0;
  const base: LayerEntry[] = stats.map((stat, i) => ({
    file: `layer-${i}.png`,
    depth: depths[i] ?? stat.depth,
    parallax: parallax[i] ?? 0,
    bbox: stat.bbox,
    // 除最前层外，每一层都向遮挡它的层身后做了补全
    inpainted: i < stats.length - 1,
    /*
     * 按真实闪卡的印法给默认箔面：最远层上箔，最近层（主体）哑光。
     * 视差相同的层是被刚性边界连着的同一个物体（见 toParallax），箔面要跟着组走，不能按层序各给各的：
     * 和最近层一组的当主体哑光，和最远层一组的跟最远层用同一种箔。
     * 否则一张脸被切成三层时，中间那层会上 holo，脸上凭空多出几道竖条光栅；
     * 背景被切成两层时，同一面墙一半日柱一半 holo（issue #3 第 2 条的「分层断裂」）。
     * 整张图是一个刚体时两条都成立，主体优先：只有最远层上箔。
     * 抠出了主体时更简单：主体那层哑光、其余上箔，和视差怎么分组无关。
     */
    foil: (subject ? i === stats.length - 1 : i > 0 && (parallax[i] ?? 0) === nearest)
      ? { type: 'none', intensity: 1 }
      : defaultFoilFor((parallax[i] ?? 0) === farthest ? 0 : i, stats.length),
  }));

  // 特效层插在各自那一层后面
  let fx: EffectLayer[] = [];
  if (effectsPending) {
    report('finding-effects');
    const masks = await effectsPending;
    if (masks?.length) fx = await buildEffectLayers(extracted, masks, (img) => backend.encodePng(img));
  }
  const layers: LayerEntry[] = [];
  const blobs: Blob[] = [];
  base.forEach((layer, i) => {
    layers.push({ ...layer, file: `layer-${layers.length}.png` });
    blobs.push(images[i]!);
    for (const effect of fx) {
      if (effect.owner !== i) continue;
      layers.push({
        file: `layer-${layers.length}.png`,
        depth: layer.depth,
        parallax: layer.parallax,
        bbox: effect.bbox,
        inpainted: false,
        role: 'effects',
        effect: effect.kind,
        foil: { ...EFFECTS_FOIL },
      });
      blobs.push(effect.blob);
    }
  });
  const effectCount = layers.length - base.length;

  report('done');

  return {
    manifest: {
      version: LAYERS_FORMAT_VERSION,
      source: { width, height },
      generator: buildGeneratorTag(cuts, prominences, subject ? subjectLabel(options.subjectModel) : null, effectCount),
      layers,
      effects: {
        halo: defaultHalo(),
        glare: true,
      },
    },
    images: blobs,
  };
}

/** 导出给调试面板看的切层诊断信息 */
export { analyzeDepth, type SliceOptions } from './slice';
export { estimateDepth } from './depth';
export { browserImages, type ImageBackend, type RgbaImage } from './image-io';
export type { ExtractOptions } from './extract';
export type { DepthMap } from './slice';
