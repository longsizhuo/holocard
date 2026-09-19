/**
 * 深度图 + 层分界 → 每层的 PNG
 *
 * 两个关键处理：
 * 1. 羽化：层边界用 smoothstep 过渡而不是硬阈值。深度图在物体边缘本来就是糊的，
 *    硬切会留下锯齿，而且一做视差位移那圈脏边就跟着飘，非常刺眼。
 * 2. 补洞：最底层做 push-pull 金字塔填充。前景一移开，后面露出的如果是原图，
 *    那就是前景自己的像素，会看到「重影」；填充成周围背景的延伸才对。
 */

import type { BBox } from '../format/types';
import type { DepthMap } from './slice';

export interface ExtractOptions {
  /** 羽化半宽，深度值单位。越大过渡越软，但层与层的界限也越模糊 */
  feather: number;
  /** 输出最大边长，超过就等比缩小。卡片尺寸下 1400 足够，再大只是浪费 */
  maxDimension: number;
  /** 判定「这个像素属于更近的层」的 alpha 阈值，用于决定底层哪些地方要补洞 */
  occlusionThreshold: number;
}

export const DEFAULT_EXTRACT_OPTIONS: ExtractOptions = {
  feather: 0.035,
  maxDimension: 1400,
  occlusionThreshold: 0.5,
};

export interface LayerStat {
  /** 该层 alpha 覆盖区域内的深度中位数 */
  depth: number;
  bbox: BBox;
}

export interface ExtractResult {
  images: Blob[];
  stats: LayerStat[];
  width: number;
  height: number;
}

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
 * 对视差露出的细条空洞效果很好，而且不需要任何模型。
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

  // 先把每个像素的深度采样出来，后面多处复用
  const sampled = new Float32Array(pixelCount);
  for (let y = 0; y < height; y++) {
    const v = height > 1 ? y / (height - 1) : 0;
    for (let x = 0; x < width; x++) {
      const u = width > 1 ? x / (width - 1) : 0;
      sampled[y * width + x] = sampleDepth(depth, u, v);
    }
  }

  // 每层的 alpha：落在本层深度带内为 1，跨越分界时 smoothstep 过渡
  const alphas: Float32Array[] = [];
  for (let i = 0; i < layerCount; i++) {
    const lo = i === 0 ? Number.NEGATIVE_INFINITY : (cuts[i - 1] ?? 0);
    const hi = i === layerCount - 1 ? Number.POSITIVE_INFINITY : (cuts[i] ?? 1);
    const a = new Float32Array(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      const d = sampled[p] ?? 0;
      const lower = Number.isFinite(lo) ? smoothstep(lo - f, lo + f, d) : 1;
      const upper = Number.isFinite(hi) ? 1 - smoothstep(hi - f, hi + f, d) : 1;
      a[p] = lower * upper;
    }
    alphas.push(a);
  }

  const images: Blob[] = [];
  const stats: LayerStat[] = [];

  for (let i = 0; i < layerCount; i++) {
    const alpha = alphas[i];
    if (!alpha) continue;

    const out = new Uint8ClampedArray(pixelCount * 4);
    out.set(src);

    if (i === 0) {
      /*
       * 最底层铺满整张卡，alpha 恒为 1——这样前景移开时不会露出透明空洞。
       * 但底层在前景位置上的像素本来就是前景自己，直接用会看到重影，
       * 所以先把被更近层遮住的区域标成未知，再 push-pull 填充成背景的延伸。
       */
      const known = new Float32Array(pixelCount);
      for (let p = 0; p < pixelCount; p++) {
        let occluded = 0;
        for (let j = 1; j < layerCount; j++) {
          occluded = Math.max(occluded, alphas[j]?.[p] ?? 0);
        }
        known[p] = occluded >= opts.occlusionThreshold ? 0 : 1;
      }
      pushPullFill(out, known, width, height);
      for (let p = 0; p < pixelCount; p++) {
        out[p * 4 + 3] = 255;
      }
    } else {
      for (let p = 0; p < pixelCount; p++) {
        out[p * 4 + 3] = Math.round((alpha[p] ?? 0) * 255);
      }
    }

    // 统计该层的深度中位数和包围盒
    const samplesInLayer: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if ((alpha[p] ?? 0) < 0.5) continue;
        samplesInLayer.push(sampled[p] ?? 0);
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
      maxX < 0 ? [0, 0, width, height] : [minX, minY, maxX - minX + 1, maxY - minY + 1];

    images.push(await encodePng(new ImageData(out, width, height), width, height));
    stats.push({ depth: median, bbox });
  }

  return { images, stats, width, height };
}
