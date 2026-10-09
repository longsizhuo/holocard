/**
 * 把一张做好的平面卡拆成三张箔面遮罩（pokemon-cards-css 的 --mask 用的那种：白色是箔面露出来的地方）：
 *
 *   frame      边框与文字：画框以外的卡面，加上检测到的文字（画框里压的字也算）
 *   character  主角：抠图模型在画框里（全图卡就是整张）抠出来的主体
 *   effects    特效：贴着主角的火焰、光弹这类又亮又艳的东西，加上主角轮廓内侧一圈（头发、身体的边）
 *
 * 实体卡不同稀有度就是这三张的不同组合，比如普通闪卡是「画框 − 主角 − 特效」，V 卡是「整张 − 主角 − 特效 − 文字」，
 * 所以只出这三张，组合交给用的人。
 *
 * 这里只做组合和规则，不跑模型：画框来自 frame.ts，主角和文字的概率图由调用方给（服务端各自跑模型）。
 * 输入输出都是卡图原尺寸，取值 0..255
 */

import type { Box } from './frame';

export interface Plane {
  data: Float32Array;
  width: number;
  height: number;
}

export interface CardMasks {
  width: number;
  height: number;
  frame: Uint8Array;
  character: Uint8Array;
  effects: Uint8Array;
  /** 文字单独一张：frame 已经包含它，组合「− 文字」时要用 */
  text: Uint8Array;
}

/** 文字概率超过这个算字。DB 检测器默认 0.3 */
const TEXT_THRESHOLD = 0.3;
/** 文字往外扩多少（占卡宽），把字的描边、抗锯齿都盖住 */
const TEXT_PAD = 0.004;
/** 主角轮廓内侧算作「边」的那一圈有多宽（占卡宽） */
const RIM = 0.012;
/** 特效：饱和度和亮度（HSV 的 S、V）都超过这些才算「又亮又艳」 */
const VIVID_SAT = 0.5;
const VIVID_VAL = 0.8;
/** 特效要贴着主角：从离主角这么近（占卡宽）的亮艳像素出发泛洪 */
const EFFECT_REACH = 0.03;
/** 泛洪最远到离主角这么远（占卡宽）。背景本身就亮艳（火焰、霓虹）时不至于把整个画框收进来 */
const EFFECT_LIMIT = 0.08;

/** 概率图双线性放大到 width × height */
export function resample(plane: Plane, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(plane.height - 1, Math.max(0, ((y + 0.5) * plane.height) / height - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(plane.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(plane.width - 1, Math.max(0, ((x + 0.5) * plane.width) / width - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(plane.width - 1, x0 + 1);
      const tx = fx - x0;
      const a = plane.data[y0 * plane.width + x0] ?? 0;
      const b = plane.data[y0 * plane.width + x1] ?? 0;
      const c = plane.data[y1 * plane.width + x0] ?? 0;
      const d = plane.data[y1 * plane.width + x1] ?? 0;
      out[y * width + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/**
 * 到最近的「是」像素的距离（棋盘距离，两遍扫描）。拿来做膨胀、量离主角多远
 */
function distanceTo(mask: Uint8Array, width: number, height: number): Float32Array {
  const INF = width + height;
  const d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + 1);
      if (y > 0) v = Math.min(v, d[i - width]! + 1);
      if (x > 0 && y > 0) v = Math.min(v, d[i - width - 1]! + 1);
      if (x + 1 < width && y > 0) v = Math.min(v, d[i - width + 1]! + 1);
      d[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let v = d[i]!;
      if (x + 1 < width) v = Math.min(v, d[i + 1]! + 1);
      if (y + 1 < height) v = Math.min(v, d[i + width]! + 1);
      if (x + 1 < width && y + 1 < height) v = Math.min(v, d[i + width + 1]! + 1);
      if (x > 0 && y + 1 < height) v = Math.min(v, d[i + width - 1]! + 1);
      d[i] = v;
    }
  }
  return d;
}

/**
 * 从「种子」出发，在 allowed 里泛洪：贴着主角的亮艳区域整片收进来（火焰翅膀从身上一直延伸出去），
 * 不贴着的（背景里的亮色）不要
 */
function grow(seed: Uint8Array, allowed: Uint8Array, width: number): Uint8Array {
  const out = new Uint8Array(seed.length);
  const stack: number[] = [];
  for (let i = 0; i < seed.length; i++) {
    if (seed[i] && allowed[i]) {
      out[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % width;
    for (const q of [p - 1, p + 1, p - width, p + width]) {
      if (q < 0 || q >= out.length || out[q] || !allowed[q]) continue;
      if (Math.abs((q % width) - x) > 1) continue;
      out[q] = 1;
      stack.push(q);
    }
  }
  return out;
}

export function cardMasks(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  window: Box | null,
  character: Plane,
  text: Plane,
): CardMasks {
  const n = width * height;
  const region = window ?? { x: 0, y: 0, w: 1, h: 1 };
  const rx0 = Math.round(region.x * width);
  const ry0 = Math.round(region.y * height);
  const rx1 = Math.round((region.x + region.w) * width);
  const ry1 = Math.round((region.y + region.h) * height);
  const inRegion = (i: number): boolean => {
    const x = i % width;
    const y = (i - x) / width;
    return x >= rx0 && x < rx1 && y >= ry0 && y < ry1;
  };

  // 文字：阈值后往外扩一点
  const textProb = resample(text, width, height);
  const textHit = new Uint8Array(n);
  for (let i = 0; i < n; i++) textHit[i] = (textProb[i] ?? 0) > TEXT_THRESHOLD ? 1 : 0;
  const textDist = distanceTo(textHit, width, height);
  const textPad = TEXT_PAD * width;
  const textMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) textMask[i] = (textDist[i] ?? Infinity) <= textPad ? 255 : 0;

  // 边框：画框以外，加文字。全图卡没有画框，只剩文字
  const frame = new Uint8Array(n);
  for (let i = 0; i < n; i++) frame[i] = (window && !inRegion(i)) || textMask[i] ? 255 : 0;

  // 主角：抠图的 alpha，只认画框里的（抠图模型偶尔把画框外的标志也当主体）
  const alpha = resample(character, width, height);
  const characterMask = new Uint8Array(n);
  const body = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = inRegion(i) ? Math.max(0, Math.min(1, alpha[i] ?? 0)) : 0;
    characterMask[i] = Math.round(a * 255);
    body[i] = a > 0.5 ? 1 : 0;
  }

  // 特效之一：主角轮廓内侧一圈
  const notBody = new Uint8Array(n);
  for (let i = 0; i < n; i++) notBody[i] = body[i] ? 0 : 1;
  const toOutside = distanceTo(notBody, width, height);
  const rim = RIM * width;

  // 特效之二：贴着主角的亮艳区域。先找画框里所有亮艳的像素，再从主角附近往外泛洪
  const vivid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!inRegion(i) || body[i] || textMask[i]) continue;
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    vivid[i] = sat >= VIVID_SAT && max / 255 >= VIVID_VAL ? 1 : 0;
  }
  const toBody = distanceTo(body, width, height);
  const reach = EFFECT_REACH * width;
  const limit = EFFECT_LIMIT * width;
  const near = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    near[i] = (toBody[i] ?? Infinity) <= reach ? 1 : 0;
    if ((toBody[i] ?? Infinity) > limit) vivid[i] = 0;
  }
  const attached = grow(near, vivid, width);

  const effects = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const onRim = body[i] && (toOutside[i] ?? 0) <= rim;
    effects[i] = onRim || attached[i] ? 255 : 0;
  }

  return { width, height, frame, character: characterMask, effects, text: textMask };
}
