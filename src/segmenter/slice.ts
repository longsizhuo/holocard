/**
 * 深度图 → 层边界
 *
 * 核心思路：层的分界不该均匀切，而该落在深度直方图的「谷底」——
 * 也就是场景中本来就没什么东西的那些距离。
 * 在有内容的地方硬切会把一个物体劈成两半，动起来直接撕裂。
 *
 * 层数也是算出来的，不是定死三层。很多照片本来就只有两层，
 * 硬凑三层会在没有语义边界的地方撕开。
 */

/** 归一化后的深度图，data 取值 0..1，1 表示最近 */
export interface DepthMap {
  data: Float32Array;
  width: number;
  height: number;
}

export interface SliceOptions {
  /** 最少切几层 */
  minLayers: number;
  /** 最多切几层。超过 4 层在卡片这种尺寸上看不出区别，只会拖慢渲染 */
  maxLayers: number;
  /** 直方图桶数 */
  bins: number;
  /** 平滑强度，单位是桶。太小会被噪声骗出一堆假谷底 */
  smoothSigma: number;
  /**
   * 谷底显著性阈值 0..1。
   * 谷有多深是相对两侧较矮的那个峰算的，低于这个值就不认。
   */
  minValleyProminence: number;
  /** 两个切点之间至少隔多少个桶，避免切出一堆薄片 */
  minSeparationBins: number;
}

export const DEFAULT_SLICE_OPTIONS: SliceOptions = {
  minLayers: 2,
  maxLayers: 4,
  bins: 256,
  smoothSigma: 4,
  minValleyProminence: 0.08,
  minSeparationBins: 18,
};

export interface SliceResult {
  /** 层分界点，深度值 0..1，升序。长度 = 层数 - 1 */
  cuts: number[];
  /** 平滑后的直方图，调试和 UI 可视化用 */
  histogram: Float32Array;
  /** 每个切点的显著性，和 cuts 一一对应 */
  prominences: number[];
}

/** 统计深度直方图 */
function buildHistogram(data: Float32Array, bins: number): Float32Array {
  const hist = new Float32Array(bins);
  const last = bins - 1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] ?? 0;
    // v 已归一化到 0..1，越界的按边界桶算
    const bin = Math.min(last, Math.max(0, Math.round(v * last)));
    hist[bin] = (hist[bin] ?? 0) + 1;
  }
  return hist;
}

/** 一维高斯平滑，边界用最近值延拓 */
function smoothHistogram(hist: Float32Array, sigma: number): Float32Array {
  if (sigma <= 0) return hist.slice();

  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = w;
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) {
    kernel[i] = (kernel[i] ?? 0) / sum;
  }

  const out = new Float32Array(hist.length);
  const last = hist.length - 1;
  for (let i = 0; i < hist.length; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const idx = Math.min(last, Math.max(0, i + k));
      acc += (hist[idx] ?? 0) * (kernel[k + radius] ?? 0);
    }
    out[i] = acc;
  }
  return out;
}

interface Valley {
  bin: number;
  prominence: number;
}

/**
 * 找出所有显著的谷底。
 *
 * 显著性定义为：谷两侧「较矮的那个峰」比谷底高出多少，再除以全局最大值。
 * 用较矮的峰而不是较高的，是为了避免一个大峰旁边的小坑被误判成分界。
 */
function findValleys(hist: Float32Array): Valley[] {
  const n = hist.length;
  let globalMax = 0;
  for (let i = 0; i < n; i++) {
    globalMax = Math.max(globalMax, hist[i] ?? 0);
  }
  if (globalMax === 0) return [];

  const valleys: Valley[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = hist[i] ?? 0;
    // 平台型谷底只取左端点，避免同一个谷报多次
    if (v > (hist[i - 1] ?? 0) || v >= (hist[i + 1] ?? 0)) continue;

    let leftPeak = v;
    for (let j = i - 1; j >= 0; j--) {
      const h = hist[j] ?? 0;
      if (h < leftPeak && h < v) break;
      leftPeak = Math.max(leftPeak, h);
    }
    let rightPeak = v;
    for (let j = i + 1; j < n; j++) {
      const h = hist[j] ?? 0;
      if (h < rightPeak && h < v) break;
      rightPeak = Math.max(rightPeak, h);
    }

    const prominence = (Math.min(leftPeak, rightPeak) - v) / globalMax;
    if (prominence > 0) {
      valleys.push({ bin: i, prominence });
    }
  }
  return valleys;
}

/** 按显著性贪心挑选切点，同时保证彼此间隔足够远 */
function pickCuts(valleys: Valley[], maxCuts: number, minSeparation: number, minProminence: number): Valley[] {
  const picked: Valley[] = [];
  const sorted = [...valleys].sort((a, b) => b.prominence - a.prominence);

  for (const candidate of sorted) {
    if (picked.length >= maxCuts) break;
    if (candidate.prominence < minProminence) break; // 已排序，后面只会更低
    if (picked.some((p) => Math.abs(p.bin - candidate.bin) < minSeparation)) continue;
    picked.push(candidate);
  }

  picked.sort((a, b) => a.bin - b.bin);
  return picked;
}

/** 等质量切分：按像素数把深度均分成 count 段，找不到显著谷底时的兜底 */
function equalMassCuts(hist: Float32Array, count: number): number[] {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i] ?? 0;
  if (total === 0) return [];

  const cuts: number[] = [];
  const last = hist.length - 1;
  let acc = 0;
  let target = 1;
  for (let i = 0; i < hist.length && cuts.length < count; i++) {
    acc += hist[i] ?? 0;
    if (acc >= (total * target) / (count + 1)) {
      cuts.push(i / last);
      target++;
    }
  }
  return cuts;
}

/** 分析深度图，算出该切几层、切在哪 */
export function analyzeDepth(depth: DepthMap, options: Partial<SliceOptions> = {}): SliceResult {
  const opts: SliceOptions = { ...DEFAULT_SLICE_OPTIONS, ...options };

  const raw = buildHistogram(depth.data, opts.bins);
  const histogram = smoothHistogram(raw, opts.smoothSigma);
  const last = opts.bins - 1;

  const valleys = findValleys(histogram);
  const picked = pickCuts(
    valleys,
    opts.maxLayers - 1,
    opts.minSeparationBins,
    opts.minValleyProminence,
  );

  // 一个显著谷底都没有，说明深度分布很连续（比如一片斜坡地面）。
  // 这种图按语义切不出东西，退化成等质量切分。
  if (picked.length < opts.minLayers - 1) {
    const need = opts.minLayers - 1;
    return {
      cuts: equalMassCuts(histogram, need),
      histogram,
      prominences: new Array<number>(need).fill(0),
    };
  }

  return {
    cuts: picked.map((v) => v.bin / last),
    histogram,
    prominences: picked.map((v) => v.prominence),
  };
}
