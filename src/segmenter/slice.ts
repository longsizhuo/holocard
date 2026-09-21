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
  /**
   * 每个切点是不是「刚性边界」：画面上看得见，但深度上没有遮挡台阶。
   *
   * 这种边界两侧多半是同一个物体（一张脸的上下半、一件外套和领口）。
   * 分层本身没问题——每层还能各上各的箔——但两层**不能相对滑动**，
   * 一滑物体就自己断成两截。渲染端据此把两层的视差取成同一个值。
   */
  rigid: boolean[];
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

/**
 * 切点的「视觉证据」：原图的亮度梯度。
 *
 * 用来回答一个问题——我们打算切的这条线，人眼在原图上看得见吗？
 * 尺寸可以小于目标画布，按比例采样即可。
 */
export interface CutEvidence {
  gradient: Float32Array;
  width: number;
  height: number;
  /** 全图平均梯度。判据全部相对它来定，插画和照片的绝对梯度差一个量级 */
  mean: number;
}

/** 从一张 RGBA 图算出梯度证据 */
export function buildCutEvidence(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): CutEvidence {
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    lum[i] = 0.299 * (rgba[i * 4] ?? 0) + 0.587 * (rgba[i * 4 + 1] ?? 0) + 0.114 * (rgba[i * 4 + 2] ?? 0);
  }
  const gradient = new Float32Array(width * height);
  let sum = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const gx = (lum[p + 1] ?? 0) - (lum[p - 1] ?? 0);
      const gy = (lum[p + width] ?? 0) - (lum[p - width] ?? 0);
      const g = Math.hypot(gx, gy);
      gradient[p] = g;
      sum += g;
    }
  }
  return { gradient, width, height, mean: sum / (width * height) };
}

/** 认为「这里确实有一条边」的梯度倍数，相对全图平均 */
const EDGE_MULTIPLE = 2;
/**
 * 过渡带里有多大比例的像素真的落在边上，才认这条切点。
 *
 * 实测：一张纯色背景的插画，模型会在那片没有任何纹理的背景上凭空给出一道平滑的
 * 深度渐变（相当于自己脑补了一个渐晕）。直方图在这道渐变里找出来的「谷底」纯属噪声，
 * 于是画面被沿着一条等深度线劈成两层——两层各上各的箔，接缝处就是一道明显的裂纹，
 * 而原图那里根本什么都没有。
 *
 * 实测数据：那条坏切点的过渡带只有 1.5% 的像素在边上，而正常照片和这张图上真实的
 * 主体边界分别是 13.9% / 5.1% / 11.3%。3% 卡在中间，两边都留了一倍以上的余量。
 */
const MIN_EDGE_SUPPORT = 0.03;
/**
 * 统计过渡带时往切点两侧各取多宽（深度值单位）。
 * 取值和 extract 的 feather 默认值一致——统计的正是那条将要被羽化的带子。
 * 这里只是取样窗口，不需要和 extract 严格同步，所以不做成参数。
 */
const BAND_HALF_WIDTH = 0.035;

/**
 * 认为「这里有一道遮挡台阶」的深度落差。
 *
 * 和 extract 的 snapThreshold 是同一个量纲：邻域内深度落差超过它才算遮挡边界，
 * 低于它是物体自身的起伏（一张脸、一片地面）。这里取得比 snap 更严，
 * 因为判错的代价不一样：snap 判错只是边缘糊一点，这里判错会把一个完整的人切成两半。
 */
const STEP_DEPTH = 0.2;
/** 邻域半径，相对图宽 */
const STEP_RADIUS = 0.01;
/**
 * 过渡带里有多大比例的像素真的骑在遮挡台阶上，才认这条切点。
 *
 * 层的存在理由是**遮挡**：近处的东西挡住远处的东西，所以它们可以相对滑动。
 * 一个物体内部的深度起伏不是遮挡——沿着它切开，滑动时物体就会自己断成两截。
 * 用户报过一张翻拍的人像小卡：模型认出人脸、画了个人形的深度团，但人和背景之间
 * 根本没有台阶（整张是平的印刷品），直方图的谷底于是落在了人的身体中间，
 * 渲染出来头和肩膀各走各的，像分尸。
 *
 * 12 个切点的实测（带内像素落差 > 0.2 的占比）：
 *   平面海报/卡通/简笔画  0.0 ~ 4.6%
 *   那条把人切两半的       6.7%
 *   ——— 这里有一道近 3 倍的空档，中间没有任何样本 ———
 *   真实照片、干净的图底分离 18.7 ~ 40.7%
 * 阈值取 12%，落在空档正中。
 */
const MIN_STEP_SUPPORT = 0.12;

/** 这条切点是不是骑在一道真实的遮挡台阶上 */
function hasDepthStep(cut: number, depth: DepthMap): boolean {
  const { data, width, height } = depth;
  const r = Math.max(2, Math.round(width * STEP_RADIUS));
  let band = 0;
  let onStep = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = data[y * width + x] ?? 0;
      if (Math.abs(d - cut) > BAND_HALF_WIDTH) continue;
      band++;
      // 邻域取九个点就够：要的是「这里有没有台阶」，不是精确的落差值
      let lo = 1;
      let hi = 0;
      for (let dy = -r; dy <= r; dy += r) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -r; dx <= r; dx += r) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const v = data[ny * width + nx] ?? 0;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (hi - lo > STEP_DEPTH) onStep++;
    }
  }
  if (band === 0) return false;
  return onStep / band >= MIN_STEP_SUPPORT;
}

/** 这条切点在原图上有没有对应的可见边界 */
function hasVisibleEdge(cut: number, depth: DepthMap, ev: CutEvidence): boolean {
  if (ev.mean <= 0) return false;
  const threshold = ev.mean * EDGE_MULTIPLE;
  let inBand = 0;
  let onEdge = 0;
  for (let y = 1; y < ev.height - 1; y++) {
    // 深度图和证据图分辨率通常不同，按比例最近邻取样就够，这里只要统计量
    const dv = Math.min(depth.height - 1, Math.round((y / ev.height) * depth.height));
    for (let x = 1; x < ev.width - 1; x++) {
      const du = Math.min(depth.width - 1, Math.round((x / ev.width) * depth.width));
      const d = depth.data[dv * depth.width + du] ?? 0;
      if (Math.abs(d - cut) > BAND_HALF_WIDTH) continue;
      inBand++;
      if ((ev.gradient[y * ev.width + x] ?? 0) > threshold) onEdge++;
    }
  }
  if (inBand === 0) return false;
  return onEdge / inBand >= MIN_EDGE_SUPPORT;
}

/**
 * 深度分布的「有效跨度」：去掉两端各 1% 质量之后还剩多宽。
 * 用分位数而不是 min/max，是因为单个离群像素就能把 max-min 撑满。
 */
function effectiveSpread(hist: Float32Array): number {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i] ?? 0;
  if (total === 0) return 0;

  const last = hist.length - 1;
  const quantile = (q: number): number => {
    let acc = 0;
    for (let i = 0; i < hist.length; i++) {
      acc += hist[i] ?? 0;
      if (acc >= total * q) return i / last;
    }
    return 1;
  };
  return quantile(0.99) - quantile(0.01);
}

/**
 * 深度跨度小于这个值就不切层了。
 *
 * 纯色图、正对着的一堵墙之类，模型给出的深度几乎处处相同。硬切的后果很具体：
 * 等质量兜底会把切点落在极低的桶上（cut ≈ 0.01），而 extract 用
 * smoothstep(cut ± 0.035) 取遮罩，于是整幅图都落在过渡带里拿到约 0.3 的 alpha
 * ——渲染出来是一整张半透明的照片副本压在原图上来回滑，也就是整幅重影。
 * 这种图本来就没有层次，老老实实出一层。
 */
const MIN_DEPTH_SPREAD = 0.06;

/** 分析深度图，算出该切几层、切在哪 */
export function analyzeDepth(
  depth: DepthMap,
  options: Partial<SliceOptions> = {},
  /**
   * 原图的梯度证据。给了就会逐条核对切点在画面上是否真的有边界，
   * 没有对应边界的切点一律丢掉。不给则完全按深度分布切（旧行为）。
   */
  evidence: CutEvidence | null = null,
): SliceResult {
  const opts: SliceOptions = { ...DEFAULT_SLICE_OPTIONS, ...options };

  /*
   * 核对必须放在最后、对所有来源的切点一视同仁——包括等质量兜底切出来的。
   * 兜底本来是给「一片有纹理的斜坡地面」这种没有明显谷底的图用的，
   * 但它同样会在纯色背景上硬切，那正是要挡的情况。
   */
  const verify = (cuts: number[], proms: number[]): SliceResult => {
    if (!evidence) {
      return { cuts, histogram, prominences: proms, rigid: cuts.map(() => false) };
    }
    const keptCuts: number[] = [];
    const keptProms: number[] = [];
    const rigid: boolean[] = [];
    cuts.forEach((c, i) => {
      /*
       * 两条判据，处理方式不同：
       *
       * 画面上根本看不见（纯色背景里的假边）→ 直接丢掉。留着就是一道裂纹：
       * 两侧各上各的箔，接缝处箔面突变，而原图那里什么都没有。
       *
       * 看得见、但深度上没有遮挡台阶 → 保留，标成刚性。两侧多半是同一个物体，
       * 分层给箔面用没问题，但不能让它们相对滑动。
       */
      if (!hasVisibleEdge(c, depth, evidence)) return;
      keptCuts.push(c);
      keptProms.push(proms[i] ?? 0);
      rigid.push(!hasDepthStep(c, depth));
    });
    return { cuts: keptCuts, histogram, prominences: keptProms, rigid };
  };

  const raw = buildHistogram(depth.data, opts.bins);
  const histogram = smoothHistogram(raw, opts.smoothSigma);
  const last = opts.bins - 1;

  // 深度几乎是平的，切不出层次，也不能硬切——见 MIN_DEPTH_SPREAD
  if (effectiveSpread(histogram) < MIN_DEPTH_SPREAD) {
    return { cuts: [], histogram, prominences: [], rigid: [] };
  }

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
    return verify(equalMassCuts(histogram, need), new Array<number>(need).fill(0));
  }

  return verify(
    picked.map((v) => v.bin / last),
    picked.map((v) => v.prominence),
  );
}
