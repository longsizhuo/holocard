/**
 * 找卡面上的画框：卡图中间放插画的那个矩形。画框以外（边框、名字栏、说明文字区）就是「边框」那张遮罩的主体。
 *
 * 不用模型：各家卡的画框都是一圈笔直的边线，横线贯穿大半个卡宽、竖线贯穿画框的高度，
 * 插画内部虽然也有很多边，但很少长成一整条直线。所以先找「长直边」，再在候选里挑四条边都站得住的矩形。
 *
 *   1. 缩到宽 360，取亮度；算每个像素上下、左右相邻的亮度差
 *   2. 每一行找最长的一段「同号、够强」的横向边，长过卡宽 35% 的行作为上下边的候选；竖边同理
 *   3. 枚举候选组成的矩形，看四条边沿线有多少比例确实是边（前缀和，O(1) 查一条边）
 *   4. 边站得住的矩形往往不止一个：画框外面套着卡框，下面的招式说明区也是个框，同一条边还有内外两道线。
 *      先把互相重叠（IoU ≥ 0.5）的候选归成一组，一组就是「一个框」；在边的得分接近最好的几组之间，
 *      选「像插画的小块」占比最高的那组。把图分成 8×8 的小块，每块算十个简单的统计量（明暗层次、离散程度、
 *      饱和度、色相分布、颜色种数、边的密度、黑白两极化程度……），用逻辑回归给出「是插画」的概率。
 *      卡框、名字栏是平的，文字是底色加字、两极化，插画是连续的明暗和颜色。
 *      权重是拿评测集里调参那一半训练的（scripts/cardmask-eval.ts --train），留出的一半检验，见 ART_MODEL。
 *      组内先取边最强的那个
 *   5. 往里收：选中的框里如果还嵌着一个边也够强、面积不少于一半、紧贴边内侧一圈更像插画的框，就换成它，
 *      直到收不动。卡框套画框、画框连着标题栏时，外面那个的边往往更强，但内侧一圈是名字栏、标题，不是画
 *   6. 最好的也不够好（全图卡、无框卡）就返回 null，调用方当整张都是画
 *
 * 前提：画框在卡的上半部分（框的中心在卡高 55% 以上），高度不超过卡高的 62%。宝可梦、万智牌、游戏王都是上图下文；
 * 不加这两条的话，底纹花哨的说明框（光辉宝可梦）、插画连说明框的大框会被当成画框
 *
 * 坐标都按卡图宽高归一化到 0..1。
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 缩小后的工作宽度。画框的边线在这个尺度下仍有一两个像素宽，够用，也快 */
const WORK_WIDTH = 360;
/** 相邻像素亮度差超过这个（0..255）才算边 */
const EDGE = 16;
/** 一行最长的连续横边要占卡宽的这个比例，才当作画框上下边的候选 */
const MIN_ROW_RUN = 0.35;
/** 竖边要占卡高的这个比例 */
const MIN_COL_RUN = 0.15;
/** 四条边的平均支持率低于这个，就认为没有画框 */
const MIN_SCORE = 0.55;
/** 边的得分比最好的低不超过这么多，才拿来比内容 */
const SCORE_SLACK = 0.15;
/** 小块的边长（工作尺寸下的像素） */
export const BLOCK = 8;
/** 两个候选重叠到这个程度（IoU），算同一个框 */
const SAME_FRAME = 0.5;
/** 往里收时，里面那个框的边至少要这么强、面积至少是外面的这个比例、内侧一圈像插画的占比至少高这么多 */
const NEST_SCORE = 0.9;
const NEST_AREA = 0.5;
const NEST_GAIN = 0.03;
/** 画框中心最低到卡高的这个位置 */
const MAX_CENTER_Y = 0.55;
/**
 * 画框最高占卡高的这个比例。已知的卡里画框最高的是游戏王，约 54%；插画连同下面说明框的大框、
 * 全图卡外圈的卡框都在 70% 以上，靠这条挡掉
 */
const MAX_HEIGHT = 0.62;

/** 缩到工作尺寸的图：RGB 和亮度。最近邻就够，要的是边的位置和块的统计量，不要画质 */
export interface WorkImage {
  rgb: Uint8Array;
  luma: Float32Array;
  w: number;
  h: number;
}

export function workImage(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): WorkImage {
  const scale = Math.min(1, WORK_WIDTH / width);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const rgb = new Uint8Array(w * h * 3);
  const luma = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const i = (sy * width + sx) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      rgb.set([r, g, b], (y * w + x) * 3);
      luma[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  return { rgb, luma, w, h };
}

/** 小块的特征个数，顺序见 blockFeatures */
export const FEATURES = 10;

/**
 * 每个 8×8 小块的统计量，按块的行优先排，每块 FEATURES 个：
 *   0 平均亮度  1 亮度标准差  2 亮度层次（16 级里出现几级）  3 平均饱和度  4 饱和度标准差
 *   5 色相熵（按饱和度加权，12 档）  6 颜色种数（RGB 各 4 档）  7 边的密度  8 两极化（靠近块内最暗、最亮的像素占比）
 *   9 平均梯度
 * 都缩到 0..1 附近，逻辑回归再做标准化
 */
export function blockFeatures(img: WorkImage): { bw: number; bh: number; data: Float32Array } {
  const { rgb, luma: L, w } = img;
  const bw = Math.floor(img.w / BLOCK);
  const bh = Math.floor(img.h / BLOCK);
  const data = new Float32Array(bw * bh * FEATURES);
  const hue = new Float32Array(12);
  const colors = new Uint8Array(64);
  const levels = new Uint8Array(16);
  const n = BLOCK * BLOCK;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hue.fill(0);
      colors.fill(0);
      levels.fill(0);
      let sumL = 0, sumL2 = 0, sumS = 0, sumS2 = 0, hueWeight = 0, colorCount = 0, levelCount = 0, edges = 0, grad = 0;
      let lo = 255, hi = 0;
      for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) {
        for (let x = bx * BLOCK; x < (bx + 1) * BLOCK; x++) {
          const p = y * w + x;
          const l = L[p] ?? 0;
          const r = rgb[p * 3] ?? 0, g = rgb[p * 3 + 1] ?? 0, b = rgb[p * 3 + 2] ?? 0;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          sumL += l; sumL2 += l * l; sumS += sat; sumS2 += sat * sat;
          lo = Math.min(lo, l); hi = Math.max(hi, l);
          if (max > min) {
            let hDeg = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
            if (hDeg < 0) hDeg += 6;
            hue[Math.min(11, Math.floor(hDeg * 2))]! += sat;
            hueWeight += sat;
          }
          const c = (r >> 6) * 16 + (g >> 6) * 4 + (b >> 6);
          if (!colors[c]) { colors[c] = 1; colorCount++; }
          const lv = Math.min(15, Math.floor(l / 16));
          if (!levels[lv]) { levels[lv] = 1; levelCount++; }
          const dx = x + 1 < img.w ? (L[p + 1] ?? 0) - l : 0;
          const dy = y + 1 < img.h ? (L[p + w] ?? 0) - l : 0;
          if (Math.abs(dx) > EDGE || Math.abs(dy) > EDGE) edges++;
          grad += Math.abs(dx) + Math.abs(dy);
        }
      }
      let entropy = 0;
      if (hueWeight > 0) for (const v of hue) if (v > 0) entropy -= (v / hueWeight) * Math.log(v / hueWeight);
      let polar = 0;
      for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) {
        for (let x = bx * BLOCK; x < (bx + 1) * BLOCK; x++) {
          const l = L[y * w + x] ?? 0;
          if (hi - lo > 24 && (l - lo < 12 || hi - l < 12)) polar++;
        }
      }
      const meanL = sumL / n;
      const meanS = sumS / n;
      const f = (by * bw + bx) * FEATURES;
      data[f] = meanL / 255;
      data[f + 1] = Math.sqrt(Math.max(0, sumL2 / n - meanL * meanL)) / 64;
      data[f + 2] = levelCount / 16;
      data[f + 3] = meanS;
      data[f + 4] = Math.sqrt(Math.max(0, sumS2 / n - meanS * meanS));
      data[f + 5] = entropy / Math.log(12);
      data[f + 6] = colorCount / n;
      data[f + 7] = edges / n;
      data[f + 8] = polar / n;
      data[f + 9] = grad / n / 64;
    }
  }
  return { bw, bh, data };
}

/**
 * 小块「是插画」的逻辑回归：先按 mean / std 标准化，再 sigmoid(weights·x + bias)。
 * 由 scripts/cardmask-eval.ts --train 训练、打印，贴到这里
 */
export const ART_MODEL = {
  mean: [0.5126, 0.4491, 0.3669, 0.3955, 0.1086, 0.2562, 0.0759, 0.327, 0.3001, 0.492],
  std: [0.257, 0.4004, 0.2244, 0.2459, 0.0914, 0.2387, 0.0504, 0.271, 0.2826, 0.4788],
  weights: [-0.3515, -2.3411, 2.1329, 0.017, 0.2178, 0.1876, 0.3538, 0.3936, 0.2058, -0.8915],
  bias: -0.4605,
};

/** 每个小块是插画的概率 */
export function artProbabilities(features: { bw: number; bh: number; data: Float32Array }): Float32Array {
  const out = new Float32Array(features.bw * features.bh);
  for (let i = 0; i < out.length; i++) {
    let z = ART_MODEL.bias;
    for (let k = 0; k < FEATURES; k++) {
      z += (ART_MODEL.weights[k] ?? 0) * (((features.data[i * FEATURES + k] ?? 0) - (ART_MODEL.mean[k] ?? 0)) / (ART_MODEL.std[k] ?? 1));
    }
    out[i] = 1 / (1 + Math.exp(-z));
  }
  return out;
}

/** 一串带符号的差值里，最长的一段同号且够强的长度。允许中间断 gap 个像素（边线被文字、图标压住一小段） */
function longestRun(values: ArrayLike<number>, gap = 2): number {
  let best = 0;
  let run = 0;
  let sign = 0;
  let miss = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    const s = v > EDGE ? 1 : v < -EDGE ? -1 : 0;
    if (s !== 0 && (s === sign || run === 0)) {
      sign = s;
      run += 1 + miss;
      miss = 0;
    } else if (run > 0 && miss < gap) {
      miss++;
    } else {
      run = s === 0 ? 0 : 1;
      sign = s;
      miss = 0;
    }
    if (run > best) best = run;
  }
  return best;
}

/** 候选矩形和它们的特征。findArtWindow 从里面挑；单独导出给评测脚本看排序 */
export interface Candidate extends Box {
  /** 四条边的支持率 */
  score: number;
  /** 像插画的小块占比 */
  art: number;
  /** 紧贴框边内侧一圈（两块深）像插画的占比，四条边取平均 */
  innerArt: number;
}

export function findArtWindow(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): (Box & { score: number }) | null {
  return pickWindow(artWindowCandidates(rgba, width, height));
}

export function artWindowCandidates(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Candidate[] {
  const img = workImage(rgba, width, height);
  const { luma: L, w, h } = img;

  // 横边：row y 上的值是 L(y) - L(y-1)；竖边：column x 上的值是 L(x) - L(x-1)
  const hEdge = new Uint8Array(w * h);
  const vEdge = new Uint8Array(w * h);
  const rowDiff = new Float32Array(w);
  const rowRuns = new Float32Array(h);
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = (L[y * w + x] ?? 0) - (L[(y - 1) * w + x] ?? 0);
      rowDiff[x] = d;
      if (Math.abs(d) > EDGE) hEdge[y * w + x] = 1;
    }
    rowRuns[y] = longestRun(rowDiff) / w;
  }
  const colDiff = new Float32Array(h);
  const colRuns = new Float32Array(w);
  for (let x = 1; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const d = (L[y * w + x] ?? 0) - (L[y * w + x - 1] ?? 0);
      colDiff[y] = d;
      if (Math.abs(d) > EDGE) vEdge[y * w + x] = 1;
    }
    colRuns[x] = longestRun(colDiff) / h;
  }

  // 边线有一两个像素的抗锯齿过渡，查支持率时上下（左右）各放宽一个像素
  const hPrefix = new Float32Array(h * (w + 1));
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      const hit = hEdge[y * w + x] || (y > 0 && hEdge[(y - 1) * w + x]) || (y + 1 < h && hEdge[(y + 1) * w + x]);
      sum += hit ? 1 : 0;
      hPrefix[y * (w + 1) + x + 1] = sum;
    }
  }
  const vPrefix = new Float32Array(w * (h + 1));
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y < h; y++) {
      const hit = vEdge[y * w + x] || (x > 0 && vEdge[y * w + x - 1]) || (x + 1 < w && vEdge[y * w + x + 1]);
      sum += hit ? 1 : 0;
      vPrefix[x * (h + 1) + y + 1] = sum;
    }
  }
  // 每个小块是插画的概率，做二维前缀和，O(1) 查任意矩形里的平均
  const features = blockFeatures(img);
  const bw0 = features.bw;
  const bh0 = features.bh;
  const prob = artProbabilities(features);
  const artPrefix = new Float32Array((bw0 + 1) * (bh0 + 1));
  for (let by = 0; by < bh0; by++) {
    let row = 0;
    for (let bx = 0; bx < bw0; bx++) {
      row += prob[by * bw0 + bx] ?? 0;
      artPrefix[(by + 1) * (bw0 + 1) + bx + 1] = (artPrefix[by * (bw0 + 1) + bx + 1] ?? 0) + row;
    }
  }
  /** 矩形（工作尺寸的像素坐标）里小块是插画的平均概率。只数完整落在里面的块 */
  const artShare = (x0: number, y0: number, x1: number, y1: number): number => {
    const bx0 = Math.ceil(x0 / BLOCK);
    const by0 = Math.ceil(y0 / BLOCK);
    const bx1 = Math.floor(x1 / BLOCK);
    const by1 = Math.floor(y1 / BLOCK);
    if (bx1 <= bx0 || by1 <= by0) return 0;
    const at = (bx: number, by: number): number => artPrefix[by * (bw0 + 1) + bx] ?? 0;
    return (at(bx1, by1) - at(bx0, by1) - at(bx1, by0) + at(bx0, by0)) / ((bx1 - bx0) * (by1 - by0));
  };
  const rowSupport = (y: number, x0: number, x1: number): number =>
    ((hPrefix[y * (w + 1) + x1] ?? 0) - (hPrefix[y * (w + 1) + x0] ?? 0)) / Math.max(1, x1 - x0);
  const colSupport = (x: number, y0: number, y1: number): number =>
    ((vPrefix[x * (h + 1) + y1] ?? 0) - (vPrefix[x * (h + 1) + y0] ?? 0)) / Math.max(1, y1 - y0);

  // 候选：局部最大的长边（相邻几行常常是同一条线的两侧，只留最强的一行）
  const peaks = (runs: Float32Array, min: number, from: number, to: number): number[] => {
    const out: number[] = [];
    for (let i = Math.max(1, from); i < Math.min(runs.length - 1, to); i++) {
      const v = runs[i] ?? 0;
      if (v >= min && v >= (runs[i - 1] ?? 0) && v >= (runs[i + 1] ?? 0)) out.push(i);
    }
    return out;
  };
  const tops = peaks(rowRuns, MIN_ROW_RUN, Math.round(h * 0.03), Math.round(h * 0.5));
  const bottoms = peaks(rowRuns, MIN_ROW_RUN, Math.round(h * 0.3), Math.round(h * 0.9));
  const lefts = peaks(colRuns, MIN_COL_RUN, Math.round(w * 0.02), Math.round(w * 0.3));
  const rights = peaks(colRuns, MIN_COL_RUN, Math.round(w * 0.7), Math.round(w * 0.98));

  /** 紧贴四条边内侧一圈的「像插画」占比，四条边平均 */
  const RING_DEPTH = 2 * BLOCK;
  const innerRingArt = (x0: number, y0: number, x1: number, y1: number): number => {
    const d = RING_DEPTH;
    return (
      (artShare(x0, y0, x1, y0 + d) + artShare(x0, y1 - d, x1, y1) + artShare(x0, y0, x0 + d, y1) + artShare(x1 - d, y0, x1, y1)) / 4
    );
  };
  const candidates: Candidate[] = [];
  for (const top of tops) {
    for (const bottom of bottoms) {
      const bh = bottom - top;
      if (bh < h * 0.2 || bh > h * MAX_HEIGHT) continue;
      for (const left of lefts) {
        for (const right of rights) {
          const bw = right - left;
          if (bw < w * 0.55) continue;
          const sides = [
            rowSupport(top, left, right),
            rowSupport(bottom, left, right),
            colSupport(left, top, bottom),
            colSupport(right, top, bottom),
          ];
          const mean = (sides[0]! + sides[1]! + sides[2]! + sides[3]!) / 4;
          // 最弱的一条边也得站得住，不然是三条真边配一条凑数的
          const score = Math.min(mean, Math.min(...sides) * 1.4);
          if (score < MIN_SCORE || (top + bottom) / 2 > h * MAX_CENTER_Y) continue;
          candidates.push({
            x: left / w,
            y: top / h,
            w: bw / w,
            h: bh / h,
            score,
            art: artShare(left, top, right, bottom),
            innerArt: innerRingArt(left, top, right, bottom),
          });
        }
      }
    }
  }
  return candidates;
}

function overlap(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function pickWindow(candidates: Candidate[]): (Box & { score: number }) | null {
  // 按边的得分从高到低，每组留得分最高的那个当代表（就是组内取边最强的）
  const leaders: Candidate[] = [];
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    if (leaders.every((l) => overlap(c, l) < SAME_FRAME)) leaders.push(c);
  }
  const top = leaders[0]?.score ?? 0;
  let best: Candidate | null = null;
  for (const l of leaders) {
    if (l.score >= top - SCORE_SLACK && (!best || l.art > best.art)) best = l;
  }
  // 往里收（见文件头第 5 步）。每次面积都严格变小，不会来回跳
  for (let outer = best; outer; ) {
    const area = outer.w * outer.h;
    let next: Candidate | null = null;
    for (const c of candidates) {
      if (c.w * c.h >= area * 0.995 || c.w * c.h < area * NEST_AREA || c.score < NEST_SCORE) continue;
      if (!contains(outer, c) || c.innerArt < outer.innerArt + NEST_GAIN) continue;
      if (!next || c.innerArt > next.innerArt || (c.innerArt === next.innerArt && c.score > next.score)) next = c;
    }
    if (next) best = next;
    outer = next;
  }
  return best ? { x: best.x, y: best.y, w: best.w, h: best.h, score: best.score } : null;
}

/** inner 是否落在 outer 里（容差约一个工作像素） */
function contains(outer: Box, inner: Box): boolean {
  const tol = 0.004;
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    inner.x + inner.w <= outer.x + outer.w + tol &&
    inner.y + inner.h <= outer.y + outer.h + tol
  );
}
