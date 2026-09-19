/**
 * 边缘精修 —— 引导滤波（guided filter）
 *
 * 深度图给出的层边界是糊的，还常常和物体真实边缘差几个像素。
 * 这里用一张「向导图」把粗遮罩的边缘吸附到向导图的边缘上。
 *
 * 原理：在每个局部窗口里，假设精修后的 alpha 是向导图的线性函数 q = a·I + b，
 * 用粗遮罩去最小二乘拟合 a、b。向导图里有边缘的地方，q 就会沿着那条边缘跳变；
 * 向导图平坦的地方 a 趋于 0，q 退化成粗遮罩的局部均值。
 * （He, Sun, Tang. Guided Image Filtering. ECCV 2010）
 *
 * 向导是可替换的：
 *   原图 RGB          零成本，对任何图都能用。当前的默认
 *   抠图模型的 alpha  边缘更准，发丝级细节。见 matte.ts，目前在浏览器里跑不起来
 * 两者也可以拼成四通道一起用。算法对通道数不挑。
 *
 * 在标准引导滤波之上加了两道保险，因为我们不是在做通用的边缘保持平滑，
 * 而是只想修正「层边界」这一条线：
 *   1. 只在层边界两侧的不确定带里生效，带外原样保留
 *   2. 用局部拟合优度 R² 当置信度。线性模型解释不了这条边界，说明向导图在这里没有对应的边
 *      （比如近处地面和中景地面的交界，原图里本来就没有边），那就不动它
 */

import { dilateMask } from './morph';

/** 向导图：逐通道平面存放，取值 0..1 */
export interface Guide {
  channels: Float32Array[];
  width: number;
  height: number;
}

export interface RefineOptions {
  /** 内部计算用的目标宽度。引导滤波在缩小的图上算系数、回到原尺寸再套用，又快又省内存 */
  workingWidth: number;
  /** 局部窗口半径，相对图宽 */
  windowRadius: number;
  /** 正则项。越小越贴着向导图的边缘走，但也越容易被纹理噪声带偏 */
  epsilon: number;
  /** 不确定带的半宽，相对图宽。要盖得住深度边界和真实边缘之间的最大出入 */
  bandRadius: number;
  /** R² 低于 low 完全不动，高于 high 完全采信，中间平滑过渡 */
  confidenceLow: number;
  confidenceHigh: number;
}

export const DEFAULT_REFINE_OPTIONS: RefineOptions = {
  workingWidth: 520,
  windowRadius: 0.016,
  epsilon: 2e-3,
  bandRadius: 0.016,
  confidenceLow: 0.35,
  confidenceHigh: 0.75,
};

export interface RefineResult {
  alpha: Float32Array;
  /** 每个像素上精修结果的采信程度 0..1，带外为 0。上层用它判断哪些地方有真实的物体边缘 */
  confidence: Float32Array;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 从 RGBA 像素构造三通道向导 */
export function guideFromImage(rgba: Uint8ClampedArray, width: number, height: number): Guide {
  const count = width * height;
  const channels = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  for (let p = 0; p < count; p++) {
    for (let c = 0; c < 3; c++) {
      const plane = channels[c];
      if (plane) plane[p] = (rgba[p * 4 + c] ?? 0) / 255;
    }
  }
  return { channels, width, height };
}

/** 方窗均值，用积分图实现，复杂度与窗口大小无关 */
function boxMean(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const iw = width + 1;
  const integral = new Float64Array(iw * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += src[y * width + x] ?? 0;
      integral[(y + 1) * iw + x + 1] = (integral[y * iw + x + 1] ?? 0) + row;
    }
  }

  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const sum =
        (integral[(y1 + 1) * iw + x1 + 1] ?? 0) -
        (integral[y0 * iw + x1 + 1] ?? 0) -
        (integral[(y1 + 1) * iw + x0] ?? 0) +
        (integral[y0 * iw + x0] ?? 0);
      // 靠边的窗口被裁掉了一部分，要按实际面积归一化
      out[y * width + x] = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return out;
}

/** 按 scale×scale 的块取平均，缩小到工作分辨率 */
function shrink(
  src: Float32Array,
  width: number,
  height: number,
  scale: number,
): { data: Float32Array; width: number; height: number } {
  if (scale <= 1) return { data: src, width, height };
  const w = Math.ceil(width / scale);
  const h = Math.ceil(height / scale);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy1 = Math.min(height, (y + 1) * scale);
    for (let x = 0; x < w; x++) {
      const sx1 = Math.min(width, (x + 1) * scale);
      let sum = 0;
      let n = 0;
      for (let sy = y * scale; sy < sy1; sy++) {
        for (let sx = x * scale; sx < sx1; sx++) {
          sum += src[sy * width + sx] ?? 0;
          n++;
        }
      }
      data[y * w + x] = n > 0 ? sum / n : 0;
    }
  }
  return { data, width: w, height: h };
}

/** 在工作分辨率的平面上做双线性采样，坐标是原图像素 */
function sampleAt(
  plane: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
  scale: number,
): number {
  const fx = Math.min(w - 1, Math.max(0, (x + 0.5) / scale - 0.5));
  const fy = Math.min(h - 1, Math.max(0, (y + 0.5) / scale - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = plane[y0 * w + x0] ?? 0;
  const b = plane[y0 * w + x1] ?? 0;
  const c = plane[y1 * w + x0] ?? 0;
  const d = plane[y1 * w + x1] ?? 0;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * 就地求 n×n 对称正定矩阵的逆（高斯-约当消元）。n 最多是向导的通道数，3 或 4。
 * 矩阵加过 epsilon 正则，不会奇异，所以不做主元选择。
 */
function invertInPlace(m: Float64Array, inv: Float64Array, n: number): void {
  inv.fill(0);
  for (let i = 0; i < n; i++) inv[i * n + i] = 1;

  for (let col = 0; col < n; col++) {
    const pivot = m[col * n + col] ?? 1;
    const scale = 1 / (Math.abs(pivot) < 1e-12 ? 1e-12 : pivot);
    for (let j = 0; j < n; j++) {
      m[col * n + j] = (m[col * n + j] ?? 0) * scale;
      inv[col * n + j] = (inv[col * n + j] ?? 0) * scale;
    }
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row * n + col] ?? 0;
      if (factor === 0) continue;
      for (let j = 0; j < n; j++) {
        m[row * n + j] = (m[row * n + j] ?? 0) - factor * (m[col * n + j] ?? 0);
        inv[row * n + j] = (inv[row * n + j] ?? 0) - factor * (inv[col * n + j] ?? 0);
      }
    }
  }
}

export interface Refiner {
  /** 精修一张遮罩（原图分辨率，取值 0..1） */
  refine(mask: Float32Array): RefineResult;
}

/**
 * 建一个精修器。和向导图有关、和遮罩无关的量在这里一次算完：
 * 各通道的局部均值，以及每个像素上局部协方差矩阵的逆。
 * 一张图有好几条层边界要修，这部分不用重复算。
 */
export function createRefiner(guide: Guide, options: Partial<RefineOptions> = {}): Refiner {
  const opts: RefineOptions = { ...DEFAULT_REFINE_OPTIONS, ...options };
  const { width, height } = guide;
  const n = guide.channels.length;

  const scale = Math.max(1, Math.round(width / opts.workingWidth));
  const small = guide.channels.map((plane) => shrink(plane, width, height, scale));
  const first = small[0];
  if (!first) throw new Error('向导图至少要有一个通道');
  const w = first.width;
  const h = first.height;
  const count = w * h;

  const radius = Math.max(1, Math.round((width * opts.windowRadius) / scale));
  const bandRadius = Math.max(1, Math.round((width * opts.bandRadius) / scale));

  const planes = small.map((s) => s.data);
  const meanI = planes.map((plane) => boxMean(plane, w, h, radius));

  // 局部协方差矩阵 Σ 的每一项：cov(Ic, Id) = mean(Ic·Id) − mean(Ic)·mean(Id)
  const product = new Float32Array(count);
  const covariance: Float32Array[] = [];
  for (let c = 0; c < n; c++) {
    for (let d = c; d < n; d++) {
      const pc = planes[c];
      const pd = planes[d];
      const mc = meanI[c];
      const md = meanI[d];
      if (!pc || !pd || !mc || !md) continue;
      for (let p = 0; p < count; p++) product[p] = (pc[p] ?? 0) * (pd[p] ?? 0);
      const mean = boxMean(product, w, h, radius);
      for (let p = 0; p < count; p++) mean[p] = (mean[p] ?? 0) - (mc[p] ?? 0) * (md[p] ?? 0);
      covariance.push(mean);
    }
  }

  // 逐像素求 (Σ + εI) 的逆，按行优先存成 n×n 个平面
  const inverse: Float32Array[] = Array.from({ length: n * n }, () => new Float32Array(count));
  const matrix = new Float64Array(n * n);
  const inverted = new Float64Array(n * n);
  for (let p = 0; p < count; p++) {
    let k = 0;
    for (let c = 0; c < n; c++) {
      for (let d = c; d < n; d++) {
        const v = covariance[k++]?.[p] ?? 0;
        matrix[c * n + d] = v;
        matrix[d * n + c] = v;
      }
      matrix[c * n + c] = (matrix[c * n + c] ?? 0) + opts.epsilon;
    }
    invertInPlace(matrix, inverted, n);
    for (let i = 0; i < n * n; i++) {
      const plane = inverse[i];
      if (plane) plane[p] = inverted[i] ?? 0;
    }
  }

  const refine = (mask: Float32Array): RefineResult => {
    const smallMask = shrink(mask, width, height, scale).data;

    const meanP = boxMean(smallMask, w, h, radius);

    // cov(Ic, p)
    const covIp: Float32Array[] = [];
    for (let c = 0; c < n; c++) {
      const pc = planes[c];
      const mc = meanI[c];
      if (!pc || !mc) continue;
      for (let p = 0; p < count; p++) product[p] = (pc[p] ?? 0) * (smallMask[p] ?? 0);
      const mean = boxMean(product, w, h, radius);
      for (let p = 0; p < count; p++) mean[p] = (mean[p] ?? 0) - (mc[p] ?? 0) * (meanP[p] ?? 0);
      covIp.push(mean);
    }

    // var(p)，算 R² 要用
    for (let p = 0; p < count; p++) product[p] = (smallMask[p] ?? 0) * (smallMask[p] ?? 0);
    const varP = boxMean(product, w, h, radius);
    for (let p = 0; p < count; p++) varP[p] = (varP[p] ?? 0) - (meanP[p] ?? 0) * (meanP[p] ?? 0);

    // 线性系数 a = (Σ+εI)⁻¹·cov(I,p)，b = mean(p) − a·mean(I)，以及拟合优度 R²
    const a: Float32Array[] = Array.from({ length: n }, () => new Float32Array(count));
    const b = new Float32Array(count);
    const r2 = new Float32Array(count);
    for (let p = 0; p < count; p++) {
      let offset = meanP[p] ?? 0;
      let explained = 0;
      for (let c = 0; c < n; c++) {
        let coefficient = 0;
        for (let d = 0; d < n; d++) {
          coefficient += (inverse[c * n + d]?.[p] ?? 0) * (covIp[d]?.[p] ?? 0);
        }
        const plane = a[c];
        if (plane) plane[p] = coefficient;
        offset -= coefficient * (meanI[c]?.[p] ?? 0);
        explained += coefficient * (covIp[c]?.[p] ?? 0);
      }
      b[p] = offset;
      // 窗口里遮罩几乎是常数时方差趋于 0，R² 没有意义，记 0
      const variance = varP[p] ?? 0;
      r2[p] = variance > 1e-4 ? Math.min(1, Math.max(0, explained / variance)) : 0;
    }

    // 一个像素被很多窗口覆盖，取这些窗口给出的系数的均值
    const meanA = a.map((plane) => boxMean(plane, w, h, radius));
    const meanB = boxMean(b, w, h, radius);
    const meanR2 = boxMean(r2, w, h, radius);

    // 不确定带：层边界向两侧各扩 bandRadius
    const inside = new Uint8Array(count);
    const outside = new Uint8Array(count);
    for (let p = 0; p < count; p++) {
      const on = (smallMask[p] ?? 0) >= 0.5;
      inside[p] = on ? 1 : 0;
      outside[p] = on ? 0 : 1;
    }
    const grown = dilateMask(inside, w, h, bandRadius);
    const shrunkComplement = dilateMask(outside, w, h, bandRadius);
    const band = new Float32Array(count);
    for (let p = 0; p < count; p++) band[p] = grown[p] && shrunkComplement[p] ? 1 : 0;
    // 带的边缘渐出，避免带内带外接缝处出现硬跳变
    const softBand = boxMean(band, w, h, Math.max(1, Math.round(bandRadius / 4)));

    const alpha = new Float32Array(mask);
    const confidence = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const weight = sampleAt(softBand, w, h, x, y, scale);
        if (weight <= 0.001) continue;

        const trust =
          weight *
          smoothstep(opts.confidenceLow, opts.confidenceHigh, sampleAt(meanR2, w, h, x, y, scale));
        if (trust <= 0.001) continue;

        const p = y * width + x;
        let q = sampleAt(meanB, w, h, x, y, scale);
        for (let c = 0; c < n; c++) {
          const plane = meanA[c];
          if (plane) q += sampleAt(plane, w, h, x, y, scale) * (guide.channels[c]?.[p] ?? 0);
        }
        q = Math.min(1, Math.max(0, q));

        const original = mask[p] ?? 0;
        alpha[p] = original + (q - original) * trust;
        confidence[p] = trust;
      }
    }
    return { alpha, confidence };
  };

  return { refine };
}
