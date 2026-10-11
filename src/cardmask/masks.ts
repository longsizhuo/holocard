/**
 * 把一张做好的平面卡拆成六张互不重叠的遮罩（pokemon-cards-css 的 --mask 用的那种：白色是箔面露出来的地方），
 * 每个像素六张加起来正好 255，所以任意几张直接相加就是它们的并集，边上不留缝、不重复：
 *
 *   text        文字：检测到的字，画里压的字也算
 *   effects     特效：贴着主角的火焰、光弹这类又亮又艳的东西，加上主角轮廓内侧一圈（头发、身体的边）
 *   character   主角：抠图模型在画框里（全图卡是内板里，再没有就是整张）抠出来的主体，减去上面两样
 *   border      卡边：最外圈和卡边颜色一样的那一条（宝可梦的黄边、银边）
 *   frame       框架：画框（或内板）以外、卡边以内的卡面：名字栏、说明区、底栏
 *   background  背景：剩下的，就是画里主角、特效以外的部分
 *
 * 重叠的地方按 text > effects > character > border > frame 的顺序归前面的。另出一张 labels：每个像素归哪一类（取值最大的那张），
 * 给人看、给下游程序读都方便。
 *
 * 实体卡不同稀有度就是这几张的不同组合，比如普通闪卡是「背景」，反闪是「框架 + 文字」（卡边不闪），
 * V 卡是「卡边 + 框架 + 背景」，VSTAR 只有内板里的「背景」，所以只出这几张，组合交给用的人。
 *
 * 版式先验（layout.ts）用在两处：文字按位置分成名字、HP、招式说明、底栏；全图卡上主角不往招式说明区里伸。
 * 这里只做组合和规则，不跑模型：画框、内板来自 frame.ts，主角和文字的概率图由调用方给（服务端各自跑模型）。
 * 输入输出都是卡图原尺寸，取值 0..255
 */

import type { Layout } from './frame';
import { bodyTop, textLines, type TextLine } from './layout';

export interface Plane {
  data: Float32Array;
  width: number;
  height: number;
}

/** 五类，labels 里的取值就是这里的下标 */
export const CLASSES = ['background', 'frame', 'text', 'character', 'effects', 'border'] as const;
export type MaskClass = (typeof CLASSES)[number];

export interface CardMasks {
  width: number;
  height: number;
  frame: Uint8Array;
  text: Uint8Array;
  character: Uint8Array;
  effects: Uint8Array;
  border: Uint8Array;
  background: Uint8Array;
  /** 每个像素属于哪一类，CLASSES 的下标 */
  labels: Uint8Array;
  /** 检测到的每行字和它的角色 */
  lines: TextLine[];
}

/** 卡边：从图片四边往里，颜色和卡边一致的部分，最深到这么多（占卡宽） */
const BORDER_DEPTH = 0.06;
/** 和卡边颜色差多少以内算同一种颜色（RGB 欧氏距离） */
const BORDER_TOLERANCE = 48;

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
/**
 * 全图卡上，主角从招式说明区的上沿往下这么远（占卡高）渐渐淡出到零。
 * 抠图模型常把下半截的招式框、能量球当成主体，而实体卡的主角很少伸进说明区
 */
const BODY_FADE = 0.04;

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

/**
 * 最外圈的卡边（宝可梦的黄边、全图卡的黑边）：取图片一圈像素颜色的中位数当卡边色，
 * 从四边往里泛洪，颜色接近、离边不太远的都算
 */
function cardBorder(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const n = width * height;
  const perimeter: number[] = [];
  for (let x = 0; x < width; x++) perimeter.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y++) perimeter.push(y * width, y * width + width - 1);
  const median = [0, 1, 2].map((c) => {
    const values = perimeter.map((p) => rgba[p * 4 + c] ?? 0).sort((a, b) => a - b);
    return values[values.length >> 1] ?? 0;
  });
  const near = (p: number): boolean =>
    Math.hypot((rgba[p * 4] ?? 0) - median[0]!, (rgba[p * 4 + 1] ?? 0) - median[1]!, (rgba[p * 4 + 2] ?? 0) - median[2]!) <= BORDER_TOLERANCE;
  const depth = BORDER_DEPTH * width;
  const inBand = (p: number): boolean => {
    const x = p % width;
    const y = (p - x) / width;
    return Math.min(x, y, width - 1 - x, height - 1 - y) <= depth;
  };
  const allowed = new Uint8Array(n);
  for (let p = 0; p < n; p++) allowed[p] = inBand(p) && near(p) ? 1 : 0;
  const seed = new Uint8Array(n);
  for (const p of perimeter) seed[p] = 1;
  return grow(seed, allowed, width);
}

export function cardMasks(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  layout: Layout,
  character: Plane,
  text: Plane,
): CardMasks {
  const n = width * height;
  const { window, panel } = layout;
  // 画在哪：画框，全图卡是内板，都没有就是整张
  const region = window ?? panel ?? { x: 0, y: 0, w: 1, h: 1 };
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
  const lines = textLines(textMask, width, height, layout);

  // 卡边，和画框（内板）以外的框架。都没找到的卡（全图卡）只有卡边，其余都算画
  const border = cardBorder(rgba, width, height);
  const frameHit = new Uint8Array(n);
  if (window || panel) for (let i = 0; i < n; i++) frameHit[i] = inRegion(i) ? 0 : 1;

  // 主角：抠图的 alpha，只认画里的（抠图模型偶尔把画框外的标志也当主体）；全图卡上到招式说明区淡出
  const top = window ? null : bodyTop(lines);
  const fadeFrom = top === null ? Infinity : top * height;
  const fadeLength = BODY_FADE * height;
  const alpha = resample(character, width, height);
  const soft = new Float32Array(n);
  const body = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const y = Math.floor(i / width);
    const fade = Math.max(0, Math.min(1, 1 - (y - fadeFrom) / fadeLength));
    const a = inRegion(i) ? Math.max(0, Math.min(1, alpha[i] ?? 0)) * fade : 0;
    soft[i] = a;
    body[i] = a > 0.5 ? 1 : 0;
  }

  // 特效之一：主角轮廓内侧一圈
  const notBody = new Uint8Array(n);
  for (let i = 0; i < n; i++) notBody[i] = body[i] ? 0 : 1;
  const toOutside = distanceTo(notBody, width, height);
  const rim = RIM * width;

  // 特效之二：贴着主角的亮艳区域。先找画里所有亮艳的像素，再从主角附近往外泛洪
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

  // 分到六张里：按 text > effects > character > border > frame 的顺序，每张只拿前面剩下的，背景兜底，加起来正好 255
  const out = {
    text: new Uint8Array(n),
    effects: new Uint8Array(n),
    character: new Uint8Array(n),
    border: new Uint8Array(n),
    frame: new Uint8Array(n),
    background: new Uint8Array(n),
  };
  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let left = 255;
    const take = (value: number): number => {
      const v = Math.min(left, value);
      left -= v;
      return v;
    };
    const onRim = body[i] && (toOutside[i] ?? 0) <= rim;
    const t = (out.text[i] = take(textMask[i] ?? 0));
    const e = (out.effects[i] = take(onRim || attached[i] ? 255 : 0));
    const c = (out.character[i] = take(Math.round((soft[i] ?? 0) * 255)));
    const d = (out.border[i] = take(border[i] ? 255 : 0));
    const f = (out.frame[i] = take(frameHit[i] ? 255 : 0));
    const b = (out.background[i] = left);
    // CLASSES 的顺序：background、frame、text、character、effects、border
    const values = [b, f, t, c, e, d];
    let best = 0;
    for (let k = 1; k < values.length; k++) if ((values[k] ?? 0) > (values[best] ?? 0)) best = k;
    labels[i] = best;
  }

  return { width, height, ...out, labels, lines };
}
