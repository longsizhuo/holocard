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
 *      选「像插画的小块」占比最高的那组——把图分成 6×6 的小块，数块里有几级明暗：
 *      卡框、名字栏是平的（一两级），文字是底色加字（三四级），插画是连续的明暗（多得多）。
 *      组内取边最强的那个（内外两道线差不了几个像素）
 *   5. 最好的也不够好（全图卡、无框卡）就返回 null，调用方当整张都是画
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
const BLOCK = 6;
/** 亮度分 16 级，一个小块里出现这么多级以上才算「像插画」 */
const ART_LEVELS = 6;
/** 两个候选重叠到这个程度（IoU），算同一个框 */
const SAME_FRAME = 0.5;

/** RGBA 缩小到工作尺寸的亮度图（最近邻足够：只要边的位置，不要画质） */
function luma(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): { data: Float32Array; w: number; h: number } {
  const scale = Math.min(1, WORK_WIDTH / width);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const i = (sy * width + sx) * 4;
      data[y * w + x] = 0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0);
    }
  }
  return { data, w, h };
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
  /** 像插画的小块，框里有几块、整张卡有几块 */
  artIn: number;
  artTotal: number;
  /** 框边上各四个像素宽的内外两条带，平均亮度差（插画和卡框颜色不同，内外差得多） */
  contrast: number;
}

export function findArtWindow(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): (Box & { score: number }) | null {
  return pickWindow(artWindowCandidates(rgba, width, height));
}

export function artWindowCandidates(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Candidate[] {
  const { data: L, w, h } = luma(rgba, width, height);

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
  // 每个小块像不像插画，再做二维前缀和，O(1) 查任意矩形里的占比
  const bw0 = Math.floor(w / BLOCK);
  const bh0 = Math.floor(h / BLOCK);
  const artPrefix = new Float32Array((bw0 + 1) * (bh0 + 1));
  const levels = new Uint8Array(16);
  for (let by = 0; by < bh0; by++) {
    let row = 0;
    for (let bx = 0; bx < bw0; bx++) {
      levels.fill(0);
      let count = 0;
      for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) {
        for (let x = bx * BLOCK; x < (bx + 1) * BLOCK; x++) {
          const level = Math.min(15, Math.floor((L[y * w + x] ?? 0) / 16));
          if (!levels[level]) count++;
          levels[level] = 1;
        }
      }
      row += count >= ART_LEVELS ? 1 : 0;
      artPrefix[(by + 1) * (bw0 + 1) + bx + 1] = (artPrefix[by * (bw0 + 1) + bx + 1] ?? 0) + row;
    }
  }
  /** 矩形（工作尺寸的像素坐标）里像插画的小块占多少。只数完整落在里面的块 */
  const artTotal = artPrefix[bh0 * (bw0 + 1) + bw0] ?? 0;
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

  // 亮度的二维前缀和，量框边内外两条带的平均亮度
  const lumPrefix = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += L[y * w + x] ?? 0;
      lumPrefix[(y + 1) * (w + 1) + x + 1] = (lumPrefix[y * (w + 1) + x + 1] ?? 0) + row;
    }
  }
  const meanLum = (x0: number, y0: number, x1: number, y1: number): number => {
    x0 = Math.max(0, Math.min(w, x0));
    x1 = Math.max(0, Math.min(w, x1));
    y0 = Math.max(0, Math.min(h, y0));
    y1 = Math.max(0, Math.min(h, y1));
    const area = (x1 - x0) * (y1 - y0);
    if (area <= 0) return 0;
    const at = (x: number, y: number): number => lumPrefix[y * (w + 1) + x] ?? 0;
    return (at(x1, y1) - at(x0, y1) - at(x1, y0) + at(x0, y0)) / area;
  };
  const RING = 4;
  const ringContrast = (x0: number, y0: number, x1: number, y1: number): number => {
    const pairs = [
      [meanLum(x0, y0 - RING - 1, x1, y0 - 1), meanLum(x0, y0 + 1, x1, y0 + RING + 1)],
      [meanLum(x0, y1 + 1, x1, y1 + RING + 1), meanLum(x0, y1 - RING - 1, x1, y1 - 1)],
      [meanLum(x0 - RING - 1, y0, x0 - 1, y1), meanLum(x0 + 1, y0, x0 + RING + 1, y1)],
      [meanLum(x1 + 1, y0, x1 + RING + 1, y1), meanLum(x1 - RING - 1, y0, x1 - 1, y1)],
    ];
    return pairs.reduce((sum, [a, b]) => sum + Math.abs((a ?? 0) - (b ?? 0)), 0) / 4 / 255;
  };
  const candidates: Candidate[] = [];
  for (const top of tops) {
    for (const bottom of bottoms) {
      const bh = bottom - top;
      if (bh < h * 0.2 || bh > h * 0.8) continue;
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
          if (score < MIN_SCORE) continue;
          const share = artShare(left, top, right, bottom);
          const blocks = Math.max(0, Math.floor(right / BLOCK) - Math.ceil(left / BLOCK)) * Math.max(0, Math.floor(bottom / BLOCK) - Math.ceil(top / BLOCK));
          candidates.push({
            x: left / w,
            y: top / h,
            w: bw / w,
            h: bh / h,
            score,
            art: share,
            artIn: share * blocks,
            artTotal,
            contrast: ringContrast(left, top, right, bottom),
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
  return best ? { x: best.x, y: best.y, w: best.w, h: best.h, score: best.score } : null;
}
