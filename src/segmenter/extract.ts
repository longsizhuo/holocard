/**
 * 深度图 + 层分界 → 每层的 PNG
 *
 * 每一层同时承担两个角色：带视差的画面，以及这一层箔面的遮罩。
 * 所以这里不只是「按深度把像素分堆」，还要保证层与层错开之后露出来的东西是对的：
 *
 * 1. 深度边缘吸附：单目深度图在物体边缘是斜坡，斜坡中段会被误分进中间层，
 *    在物体轮廓外形成一圈细环，一动起来就和物体分离成鬼影。先把陡坡压成台阶。
 * 2. 羽化：平缓的深度变化（地面这类延展面）仍然用 smoothstep 在层间平滑过渡，
 *    硬切会在没有语义边界的地方撕开。
 * 3. 逐层补全：每个非最前层都要向「遮挡它的层」身后延伸——alpha 和颜色一起补。
 *    否则前景挪开后，露出来的不是紧挨着它的那一层，而是直接透到最远层，
 *    画面和箔面都会在前景的原始轮廓处断掉。
 * 4. 镜像纹理填充：补进去的颜色用边界外的真实纹理镜像而来，而不是抹成平滑色块。
 *    箔面靠 color-dodge 点亮底图里的亮像素，平滑色块上箔面是点不亮的。
 */

import type { BBox } from '../format/types';
import { blurAlpha, dilateMask, growForeground, nearestSource, snapDepthEdges } from './morph';
import { createRefiner, guideFromImage, type Guide, type RefineOptions } from './refine';
import type { DepthMap } from './slice';

export interface ExtractOptions {
  /** 羽化半宽，深度值单位。越大过渡越软，但层与层的界限也越模糊 */
  feather: number;
  /** 输出最大边长，超过就等比缩小。卡片尺寸下 1400 足够，再大只是浪费 */
  maxDimension: number;
  /** 深度边缘吸附的窗口半径，相对图宽。要盖得住深度图边缘斜坡宽度的一半 */
  snapRadius: number;
  /** 邻域内深度落差超过它才算遮挡边界；低于它视为平缓延展面，不吸附 */
  snapThreshold: number;
  /** 前景膨胀的宽度（相对图宽）。保证物体的边缘跟着物体走，而不是留在后面的层里 */
  foregroundGrow: number;
  /**
   * 被更近层盖住的区域再向外多吃这么宽（相对图宽）。
   * 紧贴前景的那几个像素是前景和背景的混色，拿它们当填充源会把前景的颜色抹进背景。
   */
  fringe: number;
  /** 镜像纹理填充最多深入遮挡区多远（相对图宽），再往里退化成平滑填充 */
  mirrorReach: number;
  /** 是否用引导滤波把层边界吸附到真实的物体边缘上。关掉则边界完全来自深度图 */
  refineEdges: boolean;
  refine: Partial<RefineOptions>;
  /**
   * 额外的向导通道，比如抠图模型给出的前景 alpha。会和原图 RGB 拼在一起当向导用。
   * 尺寸必须和输出一致，取值 0..1。
   */
  extraGuide: Float32Array[] | null;
}

export const DEFAULT_EXTRACT_OPTIONS: ExtractOptions = {
  feather: 0.035,
  maxDimension: 1400,
  snapRadius: 0.01,
  snapThreshold: 0.12,
  foregroundGrow: 0.004,
  fringe: 0.005,
  mirrorReach: 0.12,
  refineEdges: true,
  refine: {},
  extraGuide: null,
};

export interface LayerStat {
  /** 该层「看得见的部分」的深度中位数 */
  depth: number;
  bbox: BBox;
}

export interface ExtractResult {
  images: Blob[];
  stats: LayerStat[];
  width: number;
  height: number;
}

/** 上方的层盖到这个程度，就认为下面的像素看不见，层归属判断以它为界 */
const COVERED = 0.5;
/** 盖到这个程度才认为下面像素的颜色完全不可信，需要重新填 */
const FULLY_COVERED = 0.98;
/**
 * 在确认有真实物体边缘的地方，盖到这个程度就算颜色不可信。
 * 精修后的边缘是软的（发丝、抗锯齿），半透明的那一圈像素已经混进了前景的颜色，
 * 拿它们当填充源会把前景的颜色抹进背景；而平缓过渡区里同样是半透明，颜色却是干净的。
 * 两者靠精修给出的置信度区分。
 */
const TOUCHED = 0.05;

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 双线性采样深度图。深度图分辨率和目标画布通常不一致 */
function sampleDepth(depth: DepthMap, u: number, v: number): number {
  const fx = Math.min(depth.width - 1, Math.max(0, u * (depth.width - 1)));
  const fy = Math.min(depth.height - 1, Math.max(0, v * (depth.height - 1)));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(depth.width - 1, x0 + 1);
  const y1 = Math.min(depth.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const d = depth.data;
  const w = depth.width;
  const a = d[y0 * w + x0] ?? 0;
  const b = d[y0 * w + x1] ?? 0;
  const c = d[y1 * w + x0] ?? 0;
  const e = d[y1 * w + x1] ?? 0;

  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
}

interface Pyramid {
  /** RGB 三通道，存的是「已乘权重」的颜色，取用时要除回权重 */
  color: Float32Array;
  weight: Float32Array;
  width: number;
  height: number;
}

/** 把一层金字塔降采样一半，只统计有效像素 */
function downsample(level: Pyramid): Pyramid {
  const w = Math.max(1, level.width >> 1);
  const h = Math.max(1, level.height >> 1);
  const color = new Float32Array(w * h * 3);
  const weight = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let wsum = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(level.width - 1, x * 2 + dx);
          const sy = Math.min(level.height - 1, y * 2 + dy);
          const si = sy * level.width + sx;
          const sw = level.weight[si] ?? 0;
          if (sw <= 0) continue;
          r += level.color[si * 3] ?? 0;
          g += level.color[si * 3 + 1] ?? 0;
          b += level.color[si * 3 + 2] ?? 0;
          wsum += sw;
        }
      }
      const di = y * w + x;
      color[di * 3] = r;
      color[di * 3 + 1] = g;
      color[di * 3 + 2] = b;
      weight[di] = wsum;
    }
  }
  return { color, weight, width: w, height: h };
}

/** 从粗一级双线性取色，填到细一级的空洞里 */
function upsampleInto(fine: Pyramid, coarse: Pyramid): void {
  for (let y = 0; y < fine.height; y++) {
    for (let x = 0; x < fine.width; x++) {
      const fi = y * fine.width + x;
      if ((fine.weight[fi] ?? 0) > 0) continue; // 本来就有值，不动

      const cx = Math.min(coarse.width - 1, Math.max(0, (x - 0.5) / 2));
      const cy = Math.min(coarse.height - 1, Math.max(0, (y - 0.5) / 2));
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cy);
      const x1 = Math.min(coarse.width - 1, x0 + 1);
      const y1 = Math.min(coarse.height - 1, y0 + 1);
      const tx = cx - x0;
      const ty = cy - y0;

      const corners: Array<readonly [number, number, number]> = [
        [x0, y0, (1 - tx) * (1 - ty)],
        [x1, y0, tx * (1 - ty)],
        [x0, y1, (1 - tx) * ty],
        [x1, y1, tx * ty],
      ];

      let r = 0;
      let g = 0;
      let b = 0;
      let wsum = 0;
      for (const corner of corners) {
        const [px, py, bw] = corner;
        const ci = py * coarse.width + px;
        const cw = coarse.weight[ci] ?? 0;
        if (cw <= 0) continue;
        r += ((coarse.color[ci * 3] ?? 0) / cw) * bw;
        g += ((coarse.color[ci * 3 + 1] ?? 0) / cw) * bw;
        b += ((coarse.color[ci * 3 + 2] ?? 0) / cw) * bw;
        wsum += bw;
      }
      if (wsum <= 0) continue;

      // 细一级同样按「颜色乘权重」的约定存，这里权重记为 1
      fine.color[fi * 3] = r / wsum;
      fine.color[fi * 3 + 1] = g / wsum;
      fine.color[fi * 3 + 2] = b / wsum;
      fine.weight[fi] = 1;
    }
  }
}

/**
 * push-pull 金字塔填充。
 * 先一路降采样把已知颜色「推」到粗层，再一路升采样把颜色「拉」回空洞。
 * 产出的是平滑底色，没有纹理——单独用不够，这里只拿它给镜像填充兜底。
 */
function pushPullFill(
  rgba: Uint8ClampedArray,
  known: Float32Array,
  width: number,
  height: number,
): void {
  const pixelCount = width * height;
  const base: Pyramid = {
    color: new Float32Array(pixelCount * 3),
    weight: new Float32Array(pixelCount),
    width,
    height,
  };
  for (let i = 0; i < pixelCount; i++) {
    const k = known[i] ?? 0;
    base.weight[i] = k;
    base.color[i * 3] = (rgba[i * 4] ?? 0) * k;
    base.color[i * 3 + 1] = (rgba[i * 4 + 1] ?? 0) * k;
    base.color[i * 3 + 2] = (rgba[i * 4 + 2] ?? 0) * k;
  }

  // 推：逐级降采样，把已知颜色扩散到粗层
  const levels: Pyramid[] = [base];
  let current = base;
  while (current.width > 2 && current.height > 2) {
    current = downsample(current);
    levels.push(current);
  }

  // 拉：从最粗一级往回填空洞
  for (let i = levels.length - 1; i > 0; i--) {
    const coarse = levels[i];
    const fine = levels[i - 1];
    if (!coarse || !fine) continue;
    upsampleInto(fine, coarse);
  }

  // 写回，只覆盖原本未知的像素
  for (let i = 0; i < pixelCount; i++) {
    if ((known[i] ?? 0) > 0) continue;
    const w = base.weight[i] ?? 0;
    if (w <= 0) continue;
    rgba[i * 4] = (base.color[i * 3] ?? 0) / w;
    rgba[i * 4 + 1] = (base.color[i * 3 + 1] ?? 0) / w;
    rgba[i * 4 + 2] = (base.color[i * 3 + 2] ?? 0) / w;
    rgba[i * 4 + 3] = 255;
  }
}

/**
 * 给某一层补颜色：先用 push-pull 铺一层平滑底色兜底，再在靠近边界的范围内
 * 换成镜像过来的真实纹理。只改 unknown 标出的像素，其余保持原图。
 */
function fillColors(
  out: Uint8ClampedArray,
  src: Uint8ClampedArray,
  sources: Uint8Array,
  unknown: Uint8Array,
  width: number,
  height: number,
  reach: number,
): void {
  const pixelCount = width * height;

  const smooth = new Uint8ClampedArray(src);
  const known = new Float32Array(pixelCount);
  for (let p = 0; p < pixelCount; p++) known[p] = sources[p] ? 1 : 0;
  pushPullFill(smooth, known, width, height);

  const { dx, dy } = nearestSource(sources, width, height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!unknown[p]) continue;

      const ox = dx[p] ?? 0;
      const oy = dy[p] ?? 0;
      const dist = Math.hypot(ox, oy);

      // 以最近的源像素为镜面，把边界另一侧等距处的真实像素搬过来
      const sx = x + ox * 2;
      const sy = y + oy * 2;
      let weight = 0;
      let s = 0;
      if (sx >= 0 && sy >= 0 && sx < width && sy < height) {
        s = sy * width + sx;
        if (sources[s]) weight = 1 - smoothstep(reach * 0.6, reach, dist);
      }

      for (let c = 0; c < 3; c++) {
        const base = smooth[p * 4 + c] ?? 0;
        const mirrored = src[s * 4 + c] ?? 0;
        out[p * 4 + c] = base + (mirrored - base) * weight;
      }
    }
  }
}

/** 把源图解码并按 maxDimension 等比缩放，取出像素 */
async function decodeScaled(
  image: Blob,
  maxDimension: number,
): Promise<{ pixels: ImageData; width: number; height: number }> {
  const bitmap = await createImageBitmap(image);
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('拿不到 2D 上下文');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return { pixels: ctx.getImageData(0, 0, width, height), width, height };
}

/** 把一块 RGBA 像素编码成 PNG */
async function encodePng(pixels: ImageData, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('拿不到 2D 上下文');
  ctx.putImageData(pixels, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

export async function extractLayers(
  image: Blob,
  depth: DepthMap,
  cuts: number[],
  options: Partial<ExtractOptions> = {},
): Promise<ExtractResult> {
  const opts: ExtractOptions = { ...DEFAULT_EXTRACT_OPTIONS, ...options };
  const { pixels, width, height } = await decodeScaled(image, opts.maxDimension);
  const src = pixels.data;
  const pixelCount = width * height;

  const layerCount = cuts.length + 1;
  const f = opts.feather;

  // 把每个像素的深度采样出来，再把物体边缘的斜坡吸附成台阶
  const raw = new Float32Array(pixelCount);
  for (let y = 0; y < height; y++) {
    const v = height > 1 ? y / (height - 1) : 0;
    for (let x = 0; x < width; x++) {
      const u = width > 1 ? x / (width - 1) : 0;
      raw[y * width + x] = sampleDepth(depth, u, v);
    }
  }
  const snapped = snapDepthEdges(
    raw,
    width,
    height,
    Math.max(2, Math.round(width * opts.snapRadius)),
    opts.snapThreshold,
  );
  const sampled = growForeground(
    snapped,
    width,
    height,
    Math.round(width * opts.foregroundGrow),
  );

  /*
   * 每条层分界对应一张累积遮罩 cutMasks[k]：像素比第 k 条分界更近的程度，0..1。
   * 精修是针对「分界」做的而不是针对「层」：一条分界修好了，它两侧的层同时受益，
   * 而且两侧的 alpha 天然互补，不会在边界上叠出缝隙或者重影。
   */
  const cutMasks: Float32Array[] = cuts.map((cut) => {
    const mask = new Float32Array(pixelCount);
    for (let p = 0; p < pixelCount; p++) mask[p] = smoothstep(cut - f, cut + f, sampled[p] ?? 0);
    return mask;
  });

  // 哪些地方确认有真实的物体边缘，补全时要据此判断颜色可不可信
  const edgeConfidence = new Float32Array(pixelCount);

  if (opts.refineEdges && cutMasks.length > 0) {
    const guide: Guide = guideFromImage(src, width, height);
    if (opts.extraGuide) guide.channels.push(...opts.extraGuide);
    const refiner = createRefiner(guide, opts.refine);

    cutMasks.forEach((mask, k) => {
      const { alpha, confidence } = refiner.refine(mask);
      cutMasks[k] = alpha;
      for (let p = 0; p < pixelCount; p++) {
        const c = confidence[p] ?? 0;
        if (c > (edgeConfidence[p] ?? 0)) edgeConfidence[p] = c;
      }
    });

    /*
     * 两条分界落在同一条物体边缘上时，要共用同一条精修后的边。
     *
     * 典型情况：头部（最近层）直接压在天空（最远层）上，中间层在这附近根本不存在。
     * 这时「比分界 0 近」和「比分界 1 近」是同一个集合，两张遮罩本该处处相等；
     * 但它们是各自精修的，软边的形状不会完全一致，一相减就在轮廓上剩下一圈属于中间层的细环。
     * 判据：第 k 层在附近一个不确定带的范围内都没出现过，就让它下面那条分界直接照抄上面那条。
     */
    const reach = Math.max(2, Math.round(width * (opts.refine.bandRadius ?? 0.016)));
    for (let k = cutMasks.length - 1; k >= 1; k--) {
      const upper = cutMasks[k];
      const lower = cutMasks[k - 1];
      const loCut = cuts[k - 1];
      const hiCut = cuts[k];
      if (!upper || !lower || loCut === undefined || hiCut === undefined) continue;

      // 精修之前，哪些像素的深度落在第 k 层的区间里
      const present = new Uint8Array(pixelCount);
      for (let p = 0; p < pixelCount; p++) {
        const d = sampled[p] ?? 0;
        present[p] = d >= loCut && d < hiCut ? 1 : 0;
      }
      const nearby = dilateMask(present, width, height, reach);
      for (let p = 0; p < pixelCount; p++) {
        if (!nearby[p]) lower[p] = upper[p] ?? 0;
      }
    }

    // 分界是嵌套的：比第 k 条更近，必然也比第 k-1 条更近。各自精修之后要把这个关系扳回来
    for (let k = 1; k < cutMasks.length; k++) {
      const nearer = cutMasks[k];
      const farther = cutMasks[k - 1];
      if (!nearer || !farther) continue;
      for (let p = 0; p < pixelCount; p++) {
        if ((nearer[p] ?? 0) > (farther[p] ?? 0)) nearer[p] = farther[p] ?? 0;
      }
    }
  }

  /*
   * 每层「看得见的部分」的 alpha = 比下边界近的程度 − 比上边界近的程度。
   *
   * 这里必须用减法而不是乘法。分界遮罩是嵌套的，一个被前景覆盖了 t 的边缘像素，
   * 对两条分界的取值都是 t：减法给出中间层 t − t = 0，是对的；
   * 乘法给出 t·(1 − t)，最大 0.25，会在每条软边上给中间层凭空造出一圈环。
   * 硬边上两者没有区别，所以这个错在接入精修之前一直没暴露。
   */
  const visibleAlphas: Float32Array[] = [];
  for (let i = 0; i < layerCount; i++) {
    const lower = i === 0 ? null : cutMasks[i - 1];
    const upper = i === layerCount - 1 ? null : cutMasks[i];
    const a = new Float32Array(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      const v = (lower ? (lower[p] ?? 0) : 1) - (upper ? (upper[p] ?? 0) : 0);
      a[p] = v > 0 ? v : 0;
    }
    // 吸附后的边缘是硬台阶，轻轻糊一下补回抗锯齿
    visibleAlphas.push(i === 0 ? a : blurAlpha(a, width, height));
  }

  const fringePx = Math.max(1, Math.round(width * opts.fringe));
  const reachPx = Math.max(8, width * opts.mirrorReach);

  const images: Blob[] = [];
  const stats: LayerStat[] = [];

  for (let i = 0; i < layerCount; i++) {
    const own = visibleAlphas[i];
    if (!own) continue;

    const out = new Uint8ClampedArray(src);
    let finalAlpha = own;

    if (i < layerCount - 1) {
      // 更近的层在每个像素上盖了多少
      const above = new Float32Array(pixelCount);
      for (let j = i + 1; j < layerCount; j++) {
        const other = visibleAlphas[j];
        if (!other) continue;
        for (let p = 0; p < pixelCount; p++) {
          const v = other[p] ?? 0;
          if (v > (above[p] ?? 0)) above[p] = v;
        }
      }

      // 颜色不可信的区域：被完全盖住的部分，加上真实物体边缘上那圈半透明的混色像素，
      // 再向外吃掉一圈
      const fullyCovered = new Uint8Array(pixelCount);
      for (let p = 0; p < pixelCount; p++) {
        const covered = above[p] ?? 0;
        const atRealEdge = (edgeConfidence[p] ?? 0) >= 0.5 && covered >= TOUCHED;
        fullyCovered[p] = covered >= FULLY_COVERED || atRealEdge ? 1 : 0;
      }
      const unknown = dilateMask(fullyCovered, width, height, fringePx);

      const sources = new Uint8Array(pixelCount);

      if (i === 0) {
        /*
         * 最底层铺满整张卡，alpha 恒为 1——前景移开时不会露出透明空洞。
         * 填充源是所有没被盖住的像素。
         */
        finalAlpha = new Float32Array(pixelCount).fill(1);
        for (let p = 0; p < pixelCount; p++) sources[p] = unknown[p] ? 0 : 1;
      } else {
        /*
         * 中间层要判断「被挡住的地方，后面接着的是不是我」。
         * 做法：对每个被挡住的像素，找离它最近的可见像素，那个像素属于哪一层，
         * 就认为哪一层延伸到了这里。属于本层就把 alpha 补上。
         */
        const visible = new Uint8Array(pixelCount);
        for (let p = 0; p < pixelCount; p++) visible[p] = (above[p] ?? 0) < COVERED ? 1 : 0;
        const { dx, dy } = nearestSource(visible, width, height);

        /*
         * 「原本看得见的部分」和「补进来的延伸部分」要先并成一张掩码，再统一做抗锯齿。
         * 分开各糊各的话，两边在接缝处的 alpha 都只有 0.6 左右、拼不成 1，
         * 更远的层会从这条缝里透出来，前景一挪开就是一道贴着原始轮廓的细线。
         */
        const footprint = new Float32Array(pixelCount);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (visible[p]) {
              footprint[p] = (own[p] ?? 0) >= COVERED ? 1 : 0;
              continue;
            }
            const qx = x + (dx[p] ?? 0);
            const qy = y + (dy[p] ?? 0);
            if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
            if ((own[qy * width + qx] ?? 0) >= COVERED) footprint[p] = 1;
          }
        }
        const softFootprint = blurAlpha(footprint, width, height);

        // 取 max 是为了保住平缓过渡区里原有的羽化：那里 own 是缓慢变化的，不该被掩码的硬边顶掉
        finalAlpha = new Float32Array(pixelCount);
        for (let p = 0; p < pixelCount; p++) {
          finalAlpha[p] = Math.max(own[p] ?? 0, softFootprint[p] ?? 0);
        }
        for (let p = 0; p < pixelCount; p++) {
          sources[p] = !unknown[p] && (own[p] ?? 0) >= COVERED ? 1 : 0;
        }
      }

      // 本层一个可用的源像素都没有就别填了，保持原图
      if (sources.includes(1)) {
        fillColors(out, src, sources, unknown, width, height, reachPx);
      }
    }

    for (let p = 0; p < pixelCount; p++) {
      out[p * 4 + 3] = Math.round((finalAlpha[p] ?? 0) * 255);
    }

    // 深度中位数只看「看得见的部分」；包围盒要用补全之后的范围
    const samplesInLayer: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if ((own[p] ?? 0) >= COVERED) samplesInLayer.push(sampled[p] ?? 0);
        if ((finalAlpha[p] ?? 0) < COVERED) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    samplesInLayer.sort((a, b) => a - b);
    const median = samplesInLayer.length
      ? (samplesInLayer[samplesInLayer.length >> 1] ?? 0)
      : i / Math.max(1, layerCount - 1);

    const bbox: BBox =
      i === 0 || maxX < 0
        ? [0, 0, width, height]
        : [minX, minY, maxX - minX + 1, maxY - minY + 1];

    images.push(await encodePng(new ImageData(out, width, height), width, height));
    stats.push({ depth: median, bbox });
  }

  return { images, stats, width, height };
}
