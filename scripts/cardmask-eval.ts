/**
 * 卡面遮罩的评测：拿 cardmask-fetch.mjs 下好的评测集，量画框检测和主角抠图做得准不准。
 *
 * 标准答案从哪来：
 *   画框  宝可梦普通闪卡（swholo / cosmos）的官方遮罩 = 画框减主角，取白色区域的外接框；
 *         （反闪的遮罩中间也有洞，但比画框多一条资料栏，不拿来评）；万智牌、游戏王用单独的画在全卡里找位置（多尺度模板匹配）
 *   主角  宝可梦普通闪卡：画框里官方遮罩没盖到的部分就是主角
 * 指标都是 IoU。全图卡（V、VMAX 这类）没有画框，这一步不评。
 *
 * 用法：
 *   pnpm cardmask:eval [--matte] [--only <id 前缀>] [--debug] [--train]
 *   --train  训练 frame.ts 里小块「是插画」的逻辑回归，打印 ART_MODEL
 *   --masks  出六张遮罩，按稀有度组合后和宝可梦官方遮罩比（要抠图权重和 .models/RapidOCR 下的文字检测模型）
 *   --model <名字>  配合 --masks，换主角的抠图模型来比：lite（默认）、birefnet、hrsod、toonout、matting，
 *                   后四个的 ONNX 放在 .models/cmp/（下载地址见 scripts/cardmask-matte.py 的 MODELS，做法见 docs-site/develop/index.md「抠图模型对比」）
 *   --matte  连主角一起评（BiRefNet，一张二十几秒，峰值 7GB 内存）；模型目录取 HOLOCARD_MODEL_DIR，默认 .models
 * 每张卡画一张对照图到 .cardmask/out/（绿框是标准答案，红框是检测结果），汇总写 .cardmask/out/report.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { env } from '@huggingface/transformers';
import { FEATURES, artWindowCandidates, blockFeatures, findArtWindow, findLayout, workImage, type Box } from '../src/cardmask/frame';
import { estimateMatte } from '../src/segmenter/matte';
import { cardMasks, type CardMasks, type MaskClass, type Plane } from '../src/cardmask/masks';
import { textProbability } from '../server/pipeline/textdet';
import * as ort from 'onnxruntime-node';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DATA = join(ROOT, '.cardmask', 'data');
const OUT = join(ROOT, '.cardmask', 'out');
const argv = process.argv.slice(2);
const withMatte = argv.includes('--matte');
const only = argv.includes('--only') ? (argv[argv.indexOf('--only') + 1] ?? '') : '';
/** 打印每张卡的候选矩形（按和答案的 IoU 排），调画框检测用 */
const debug = argv.includes('--debug');
/**
 * --model：主角用哪个抠图模型（只对 --masks 起作用），比较不同模型用。lite 是线上在用的 BiRefNet_lite，走 estimateMatte；
 * 其余的是 .models/cmp/ 下的原始 ONNX，用 onnxruntime 直接跑，预处理和 lite 一样（拉伸到 1024、ImageNet 均值方差）
 */
const MODEL = argv.includes('--model') ? (argv[argv.indexOf('--model') + 1] ?? 'lite') : 'lite';
const RAW_MODELS: Record<string, { file: string; input: string; logits: boolean }> = {
  birefnet: { file: 'birefnet.onnx', input: 'input_image', logits: true },
  hrsod: { file: 'hrsod.onnx', input: 'input_image', logits: true },
  toonout: { file: 'toonout.onnx', input: 'image', logits: false },
  matting: { file: 'matting.onnx', input: 'input_image', logits: true },
};
// 只在别的机器上算过的模型（.cardmask/out/remote/<名字>/ 有结果）也认
if (MODEL !== 'lite' && !RAW_MODELS[MODEL] && !existsSync(join(OUT, 'remote', MODEL))) throw new Error(`不认识的模型 ${MODEL}，可选 lite、${Object.keys(RAW_MODELS).join('、')}`);

interface Entry {
  id: string;
  source: 'pokemon' | 'mtg' | 'ygo';
  style?: string;
  card: string;
  mask?: string;
  art?: string;
  /** dev 是调参用的，holdout 是留出来检验的（见 cardmask-fetch.mjs 的 --split） */
  split?: 'dev' | 'holdout';
  rarity?: string;
}

interface Gray {
  data: Uint8Array;
  width: number;
  height: number;
}

async function rgba(file: string): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function gray(input: string | Buffer, width?: number, height?: number): Promise<Gray> {
  let pipeline = sharp(input).flatten({ background: '#fff' }).greyscale();
  if (width && height) pipeline = pipeline.resize(width, height, { fit: 'fill' });
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** 官方遮罩的 alpha，缩到卡图大小 */
async function maskAlpha(file: string, width: number, height: number): Promise<Gray> {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .extractChannel('alpha')
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** 白色区域的外接框 */
function whiteBox(mask: Gray): Box | null {
  let x0 = mask.width;
  let y0 = mask.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if ((mask.data[y * mask.width + x] ?? 0) < 128) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? null : { x: x0 / mask.width, y: y0 / mask.height, w: (x1 - x0 + 1) / mask.width, h: (y1 - y0 + 1) / mask.height };
}

/** 去均值的平方差，越小越像 */
function ssd(card: Gray, tpl: Gray, ox: number, oy: number, tplMean: number): number {
  let cardSum = 0;
  for (let y = 0; y < tpl.height; y++) {
    const row = (oy + y) * card.width + ox;
    for (let x = 0; x < tpl.width; x++) cardSum += card.data[row + x] ?? 0;
  }
  const cardMean = cardSum / (tpl.width * tpl.height);
  let sum = 0;
  for (let y = 0; y < tpl.height; y++) {
    const row = (oy + y) * card.width + ox;
    for (let x = 0; x < tpl.width; x++) {
      const d = (card.data[row + x] ?? 0) - cardMean - ((tpl.data[y * tpl.width + x] ?? 0) - tplMean);
      sum += d * d;
    }
  }
  return sum / (tpl.width * tpl.height);
}

/** 单独的画在全卡里的位置：先在 1/8 尺度上扫尺度和位置，再在 1/2 尺度上就近细调 */
async function locateArt(cardFile: string, artFile: string): Promise<{ box: Box; cost: number }> {
  const full = await sharp(cardFile).metadata();
  const art = await sharp(artFile).metadata();
  const search = async (factor: number, scales: number[], around: { x: number; y: number } | null, radius: number) => {
    const cw = Math.round((full.width ?? 1) * factor);
    const ch = Math.round((full.height ?? 1) * factor);
    const card = await gray(cardFile, cw, ch);
    let best = { cost: Infinity, x: 0, y: 0, s: 1, tw: 0, th: 0 };
    for (const s of scales) {
      const tw = Math.round((art.width ?? 1) * factor * s);
      const th = Math.round((art.height ?? 1) * factor * s);
      if (tw >= cw || th >= ch) continue;
      const tpl = await gray(artFile, tw, th);
      let mean = 0;
      for (const v of tpl.data) mean += v;
      mean /= tpl.data.length;
      const xs = around ? [Math.max(0, Math.round(around.x * cw) - radius), Math.min(cw - tw, Math.round(around.x * cw) + radius)] : [0, cw - tw];
      const ys = around ? [Math.max(0, Math.round(around.y * ch) - radius), Math.min(ch - th, Math.round(around.y * ch) + radius)] : [0, ch - th];
      for (let y = ys[0]!; y <= ys[1]!; y++) {
        for (let x = xs[0]!; x <= xs[1]!; x++) {
          const cost = ssd(card, tpl, x, y, mean);
          if (cost < best.cost) best = { cost, x, y, s, tw, th };
        }
      }
    }
    return { box: { x: best.x / cw, y: best.y / ch, w: best.tw / cw, h: best.th / ch }, s: best.s, cost: best.cost };
  };
  const scales: number[] = [];
  for (let s = 0.8; s <= 1.3; s += 0.01) scales.push(s);
  const coarse = await search(1 / 8, scales, null, 0);
  const fine: number[] = [];
  for (let s = coarse.s - 0.012; s <= coarse.s + 0.012; s += 0.004) fine.push(s);
  const result = await search(1 / 2, fine, coarse.box, 6);
  return { box: result.box, cost: result.cost };
}

/** 模板匹配的平均平方差（0..255²）超过这个，就当没找到 */
const MAX_MATCH_COST = 600;

let matteReady = false;
/** 在预测的画框里抠主角，返回卡图尺寸的 0/1 掩码 */
async function character(file: string, width: number, height: number, box: Box | null): Promise<Uint8Array>;
async function character(file: string, width: number, height: number, box: Box | null, soft: true): Promise<Float32Array>;
async function character(file: string, width: number, height: number, box: Box | null, soft = false): Promise<Uint8Array | Float32Array> {
  if (!matteReady) {
    env.localModelPath = process.env.HOLOCARD_MODEL_DIR ?? join(ROOT, '.models');
    env.allowRemoteModels = false;
    matteReady = true;
  }
  const region = box ?? { x: 0, y: 0, w: 1, h: 1 };
  const left = Math.round(region.x * width);
  const top = Math.round(region.y * height);
  const w = Math.round(region.w * width);
  const h = Math.round(region.h * height);
  const crop = await sharp(file).extract({ left, top, width: w, height: h }).png().toBuffer();
  const matte = await estimateMatte(new Blob([new Uint8Array(crop)], { type: 'image/png' }));
  const out = soft ? new Float32Array(width * height) : new Uint8Array(width * height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mx = Math.min(matte.width - 1, Math.floor((x / w) * matte.width));
      const my = Math.min(matte.height - 1, Math.floor((y / h) * matte.height));
      const a = matte.data[my * matte.width + mx] ?? 0;
      out[(top + y) * width + left + x] = soft ? a : a > 0.5 ? 1 : 0;
    }
  }
  return out;
}

function maskIou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) union++;
  }
  return union ? inter / union : 1;
}

/** 对照图：卡图上画绿框（标准答案）、红框（检测结果）；有主角的话右边并排两张掩码（左答案右预测） */
async function sheet(entry: Entry, width: number, height: number, gt: Box | null, pred: Box | null, chars: [Uint8Array, Uint8Array] | null): Promise<void> {
  const rect = (b: Box | null, color: string): string =>
    b ? `<rect x="${b.x * width}" y="${b.y * height}" width="${b.w * width}" height="${b.h * height}" fill="none" stroke="${color}" stroke-width="${Math.max(3, width / 150)}"/>` : '';
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rect(gt, '#0c0')}${rect(pred, '#e00')}</svg>`);
  const panels = [await sharp(join(DATA, entry.card)).flatten({ background: '#fff' }).composite([{ input: svg }]).png().toBuffer()];
  for (const m of chars ?? []) {
    panels.push(await sharp(Buffer.from(m.map((v) => v * 255)), { raw: { width, height, channels: 1 } }).png().toBuffer());
  }
  const H = 520;
  const W = Math.round((width / height) * H);
  const composite = await Promise.all(panels.map(async (p, i) => ({ input: await sharp(p).resize(W, H).png().toBuffer(), left: i * (W + 10), top: 0 })));
  await sharp({ create: { width: panels.length * (W + 10), height: H, channels: 3, background: '#fff' } })
    .composite(composite)
    .jpeg({ quality: 80 })
    .toFile(join(OUT, `${entry.id}.jpg`));
}

/** 卡上模板匹配出来的画框位置，按卡缓存：一张要一两秒，调参时反复跑不用重算 */
const GT_CACHE = join(OUT, 'gt-cache.json');
const gtCache: Record<string, { box: Box; cost: number }> = existsSync(GT_CACHE) ? JSON.parse(readFileSync(GT_CACHE, 'utf8')) : {};

/** 这张卡的标准答案：画框，和（宝可梦普通闪卡才有的）主角掩码 */
async function groundTruth(entry: Entry, image: { width: number; height: number }): Promise<{ box: Box | null; char: Uint8Array | null }> {
  const cardFile = join(DATA, entry.card);
  let gt: Box | null = null;
  let gtChar: Uint8Array | null = null;
  if (entry.source === 'pokemon' && entry.mask) {
    const mask = await maskAlpha(join(DATA, entry.mask), image.width, image.height);
    if (entry.style === 'swholo' || entry.style === 'cosmos') {
      gt = whiteBox(mask);
      if (gt) {
        // 画框里遮罩没盖到的就是主角
        gtChar = new Uint8Array(image.width * image.height);
        const box = gt;
        for (let y = Math.round(box.y * image.height); y < Math.round((box.y + box.h) * image.height); y++) {
          for (let x = Math.round(box.x * image.width); x < Math.round((box.x + box.w) * image.width); x++) {
            if ((mask.data[y * image.width + x] ?? 0) < 128) gtChar[y * image.width + x] = 1;
          }
        }
      }
    }
    // 反闪（reverse）的遮罩中间也有个洞，但洞比画框多出画下面的资料栏，当不了画框的答案，不评
  } else if (entry.art) {
    const located = (gtCache[entry.id] ??= await locateArt(cardFile, join(DATA, entry.art)));
    // 匹配得不好（单独的画和卡上的不是同一版，比如日版卡压了水印）就没有可信的答案，不评
    // 缓存是 JSON，找不到时的 Infinity 存成了 null，所以用 isFinite 判
    if (Number.isFinite(located.cost) && located.cost <= MAX_MATCH_COST) gt = located.box;
    else console.log(`${entry.id}：画在卡上找不到（匹配代价 ${Number(located.cost).toFixed(0)}），不评画框`);
  }

  return { box: gt, char: gtChar };
}

mkdirSync(OUT, { recursive: true });
if (!existsSync(join(DATA, 'index.json'))) throw new Error('先跑 node scripts/cardmask-fetch.mjs 下载评测集');
const entries = (JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as Entry[]).filter((e) => e.id.startsWith(only));

/*
 * --train：训练小块「是插画」的逻辑回归（frame.ts 的 ART_MODEL）。
 * 标签来自标准答案的画框：完全在画框里（再往里让一块）的块算插画，完全在外面（往外让一块）的算卡面装饰，压边的不用。
 * 只拿 dev 那一半训练，两半分别报准确率；打印出来的 ART_MODEL 贴回 frame.ts
 */
if (argv.includes('--train')) {
  const sets: Record<string, { x: number[][]; y: number[] }> = { dev: { x: [], y: [] }, holdout: { x: [], y: [] } };
  for (const entry of entries) {
    const image = await rgba(join(DATA, entry.card));
    const { box } = await groundTruth(entry, image);
    if (!box) continue;
    const features = blockFeatures(workImage(image.data, image.width, image.height));
    const set = sets[entry.split ?? 'dev']!;
    const cw = features.bw;
    const ch = features.bh;
    const bx0 = box.x * cw, bx1 = (box.x + box.w) * cw, by0 = box.y * ch, by1 = (box.y + box.h) * ch;
    for (let by = 0; by < ch; by++) {
      for (let bx = 0; bx < cw; bx++) {
        const inside = bx >= bx0 + 1 && bx + 1 <= bx1 - 1 && by >= by0 + 1 && by + 1 <= by1 - 1;
        const outside = bx + 1 <= bx0 - 1 || bx >= bx1 + 1 || by + 1 <= by0 - 1 || by >= by1 + 1;
        if (!inside && !outside) continue;
        set.x.push(Array.from(features.data.subarray((by * cw + bx) * FEATURES, (by * cw + bx + 1) * FEATURES)));
        set.y.push(inside ? 1 : 0);
      }
    }
  }
  const { x, y } = sets['dev']!;
  const mean = Array.from({ length: FEATURES }, (_, k) => x.reduce((a, r) => a + (r[k] ?? 0), 0) / x.length);
  const std = Array.from({ length: FEATURES }, (_, k) => Math.sqrt(x.reduce((a, r) => a + ((r[k] ?? 0) - (mean[k] ?? 0)) ** 2, 0) / x.length) || 1);
  const norm = (r: number[]): number[] => r.map((v, k) => (v - (mean[k] ?? 0)) / (std[k] ?? 1));
  const xs = x.map(norm);
  // 两类样本数差得多（卡面装饰的块更多），按类别加权，免得模型偷懒全判成一类
  const positives = y.filter((v) => v === 1).length;
  const classWeight = [y.length / (2 * (y.length - positives)), y.length / (2 * positives)];
  const weights = new Array<number>(FEATURES).fill(0);
  let bias = 0;
  for (let step = 0; step < 3000; step++) {
    const grad = new Array<number>(FEATURES).fill(0);
    let gradBias = 0;
    for (let i = 0; i < xs.length; i++) {
      const r = xs[i]!;
      const z = bias + r.reduce((a, v, k) => a + v * (weights[k] ?? 0), 0);
      const err = (1 / (1 + Math.exp(-z)) - (y[i] ?? 0)) * (classWeight[y[i] ?? 0] ?? 1);
      for (let k = 0; k < FEATURES; k++) grad[k]! += err * (r[k] ?? 0);
      gradBias += err;
    }
    for (let k = 0; k < FEATURES; k++) weights[k]! -= 0.5 * (grad[k]! / xs.length + 1e-3 * (weights[k] ?? 0));
    bias -= 0.5 * (gradBias / xs.length);
  }
  for (const [name, set] of Object.entries(sets)) {
    let hit = [0, 0];
    const total = [0, 0];
    set.x.forEach((r, i) => {
      const z = bias + norm(r).reduce((a, v, k) => a + v * (weights[k] ?? 0), 0);
      const label = set.y[i] ?? 0;
      total[label]!++;
      if ((z > 0 ? 1 : 0) === label) hit[label]!++;
    });
    console.log(`${name}：插画块 ${total[1]} 个判对 ${((hit[1]! / total[1]!) * 100).toFixed(1)}%，装饰块 ${total[0]} 个判对 ${((hit[0]! / total[0]!) * 100).toFixed(1)}%`);
  }
  const round = (v: number): number => Number(v.toFixed(4));
  console.log(`export const ART_MODEL = ${JSON.stringify({ mean: mean.map(round), std: std.map(round), weights: weights.map(round), bias: round(bias) })};`);
  writeFileSync(GT_CACHE, JSON.stringify(gtCache));
  process.exit(0);
}

/*
 * --masks：三张遮罩按稀有度组合成「哪里闪」，和宝可梦的官方遮罩比（白色 = 闪）。组合照官方遮罩的样子定：
 *   swholo、cosmos   画框 − 主角 − 特效
 *   reverse          画框以外（说明文字区也是闪的，不扣字）
 *   sunpillar（V、VMAX、VSTAR）   整张 − 主角 − 特效 − 文字，或者主角也闪：整张 − 文字
 *       同一种稀有度，主角闪不闪是按每张卡的设计定的（百变怪 VMAX 闪、喷火龙 VSTAR 不闪），稀有度推不出来。
 *       实际用的时候怎么组合由做卡的人选，所以这里两种都算、取好的那个：量的是三张遮罩本身准不准
 *   swsecret         整张 − 主角 − 文字
 *   radiantholo      画框以外 + 主角（画框里的背景不闪）
 * 抠图、文字检测的结果缓存在 .cardmask/out/cache/，调规则时不用重跑模型
 */
const CACHE = join(OUT, 'cache');

async function cachedPlane(file: string, make: () => Promise<Plane>): Promise<Plane> {
  if (existsSync(file)) {
    const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
    return { data: Float32Array.from(data, (v) => v / 255), width: info.width, height: info.height };
  }
  const plane = await make();
  const bytes = Buffer.from(plane.data.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)));
  await sharp(bytes, { raw: { width: plane.width, height: plane.height, channels: 1 } }).png().toFile(file);
  return plane;
}

/** 抠图结果，卡图尺寸；只在 box 里抠（全图卡是整张） */
async function matteOf(entry: Entry, file: string, width: number, height: number, box: Box | null): Promise<Plane> {
  // 只在 box 里抠，所以缓存要按 box 区分：画框检测改了，旧的抠图结果就不能用。lite 以外的模型文件名里带模型名
  const key = box ? [box.x, box.y, box.w, box.h].map((v) => v.toFixed(3)).join('_') : 'full';
  const name = MODEL === 'lite' ? `${entry.id}-matte-${key}.png` : `${entry.id}-matte-${MODEL}-${key}.png`;
  // 在别的机器上算好、传回来的（见 --crops 和 scripts/cardmask-matte.py）
  const remote = join(OUT, 'remote', MODEL, `${entry.id}__${key}.png`);
  return cachedPlane(join(CACHE, name), async () => {
    const started = Date.now();
    const mask = existsSync(remote)
      ? await fromRemote(remote, width, height, box)
      : MODEL === 'lite'
        ? await character(file, width, height, box, true)
        : await rawMatte(file, width, height, box);
    timings.push(Date.now() - started);
    return { data: Float32Array.from(mask), width, height };
  });
}

/** 每张卡抠图花了多少毫秒（只记这次真算的，读缓存的不算） */
const timings: number[] = [];
let rawSession: ort.InferenceSession | null = null;

/** 别的机器算好的遮罩（1024×1024 灰度，对应 box 里那块），铺回卡图尺寸 */
async function fromRemote(file: string, width: number, height: number, box: Box | null): Promise<Float32Array> {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  const region = box ?? { x: 0, y: 0, w: 1, h: 1 };
  const left = Math.round(region.x * width);
  const top = Math.round(region.y * height);
  const w = Math.round(region.w * width);
  const h = Math.round(region.h * height);
  const out = new Float32Array(width * height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[Math.min(info.height - 1, Math.floor((y / h) * info.height)) * info.width + Math.min(info.width - 1, Math.floor((x / w) * info.width))] ?? 0;
      out[(top + y) * width + left + x] = v / 255;
    }
  }
  return out;
}

/** 用原始 ONNX 抠 box 里的主角，返回卡图尺寸的 0..1 概率 */
async function rawMatte(file: string, width: number, height: number, box: Box | null): Promise<Float32Array> {
  const spec = RAW_MODELS[MODEL]!;
  rawSession ??= await ort.InferenceSession.create(join(ROOT, '.models', 'cmp', spec.file), {
    executionProviders: ['cpu'],
    // 同 matte.ts：不关内存池的话推理完的峰值不还给系统
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
  const region = box ?? { x: 0, y: 0, w: 1, h: 1 };
  const left = Math.round(region.x * width);
  const top = Math.round(region.y * height);
  const w = Math.round(region.w * width);
  const h = Math.round(region.h * height);
  const SIZE = 1024;
  const rgb = await sharp(file)
    .extract({ left, top, width: w, height: h })
    .removeAlpha()
    .resize(SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];
  const plane = SIZE * SIZE;
  const input = new Float32Array(plane * 3);
  for (let p = 0; p < plane; p++) {
    for (let c = 0; c < 3; c++) input[c * plane + p] = ((rgb[p * 3 + c] ?? 0) / 255 - MEAN[c]!) / STD[c]!;
  }
  const output = await rawSession.run({ [spec.input]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
  const data = output[rawSession.outputNames[0] ?? '']!.data as Float32Array;
  const out = new Float32Array(width * height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[Math.min(SIZE - 1, Math.floor((y / h) * SIZE)) * SIZE + Math.min(SIZE - 1, Math.floor((x / w) * SIZE))] ?? 0;
      out[(top + y) * width + left + x] = spec.logits ? 1 / (1 + Math.exp(-v)) : v;
    }
  }
  return out;
}

async function textOf(entry: Entry, image: { data: Uint8Array; width: number; height: number }): Promise<Plane> {
  return cachedPlane(join(CACHE, `${entry.id}-text.png`), () =>
    textProbability(image.data, image.width, image.height, join(ROOT, '.models', 'RapidOCR', 'ch_PP-OCRv4_det_infer.onnx')),
  );
}

/**
 * 各稀有度的箔面由哪几张遮罩相加。五张互不重叠，相加就是并集。有几种组合的都算、取和官方遮罩最像的那个：
 * 同一种稀有度，主角闪不闪、卡边闪不闪是按每张卡的设计定的（百变怪 VMAX 主角闪、喷火龙 VSTAR 不闪；V、VMAX 卡边闪、VSTAR 只有内板闪；
 * 画里的火焰、光效有的闪有的不闪），
 * 稀有度推不出来。实际用的时候怎么组合由做卡的人选，这里量的是遮罩本身准不准
 */
const RECIPES: Record<string, MaskClass[][]> = {
  swholo: [['background'], ['background', 'effects']],
  cosmos: [['background'], ['background', 'effects']],
  reverse: [['frame', 'text'], ['border', 'frame', 'text']],
  sunpillar: ([['background'], ['frame', 'background'], ['border', 'frame', 'background']] as MaskClass[][]).flatMap((r) => [r, [...r, 'character', 'effects']]),
  swsecret: [['frame', 'background', 'effects'], ['border', 'frame', 'background', 'effects']],
  radiantholo: [['frame', 'text', 'character', 'effects'], ['border', 'frame', 'text', 'character', 'effects']],
};

function foilOf(recipe: MaskClass[], m: CardMasks): Uint8Array {
  const out = new Uint8Array(m.width * m.height);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (const layer of recipe) sum += m[layer][i] ?? 0;
    out[i] = sum > 127 ? 1 : 0;
  }
  return out;
}

/** labels 上色，顺序同 CLASSES：背景绿、框架蓝、文字橙、主角红、特效紫、卡边灰 */
const LABEL_COLORS = [[34, 197, 94], [59, 130, 246], [245, 158, 11], [239, 68, 68], [168, 85, 247], [148, 163, 184]] as const;

/*
 * --crops：把每张宝可梦卡要抠主角的那块（画框，全图卡是整张）裁出来，放到 .cardmask/out/crops/。
 * 拿去显卡机器上用 scripts/cardmask-matte.py 抠，结果放回 .cardmask/out/remote/<模型>/，--masks --model 会直接用。
 * 这台 4 核 ARM 上大模型一张要一分钟、峰值七八 GB 内存，显卡上一张不到一秒
 */
if (argv.includes('--crops')) {
  mkdirSync(join(OUT, 'crops'), { recursive: true });
  let n = 0;
  for (const entry of entries.filter((e) => e.source === 'pokemon' && e.mask && e.style)) {
    const cardFile = join(DATA, entry.card);
    const image = await rgba(cardFile);
    const box = findArtWindow(image.data, image.width, image.height);
    const key = box ? [box.x, box.y, box.w, box.h].map((v) => v.toFixed(3)).join('_') : 'full';
    const region = box ?? { x: 0, y: 0, w: 1, h: 1 };
    await sharp(cardFile)
      .extract({
        left: Math.round(region.x * image.width),
        top: Math.round(region.y * image.height),
        width: Math.round(region.w * image.width),
        height: Math.round(region.h * image.height),
      })
      .png()
      .toFile(join(OUT, 'crops', `${entry.id}__${key}.png`));
    n++;
  }
  console.log(`裁了 ${n} 张到 ${join(OUT, 'crops')}`);
  process.exit(0);
}

if (argv.includes('--masks')) {
  mkdirSync(CACHE, { recursive: true });
  const results: Record<string, unknown>[] = [];
  for (const entry of entries.filter((e) => e.source === 'pokemon' && e.mask && e.style)) {
    const cardFile = join(DATA, entry.card);
    const image = await rgba(cardFile);
    const layout = findLayout(image.data, image.width, image.height);
    const region = layout.window ?? layout.panel;
    const masks = cardMasks(
      image.data,
      image.width,
      image.height,
      layout,
      await matteOf(entry, cardFile, image.width, image.height, region),
      await textOf(entry, image),
    );
    const recipes = RECIPES[entry.style!];
    if (!recipes) continue;
    // 蚀刻类（etched）的官方遮罩是一层细密纹理，逐像素切黑白全是噪点。先模糊到看覆盖范围，有纹理的整片算闪
    const { data: blurred } = await sharp(join(DATA, entry.mask!))
      .ensureAlpha()
      .extractChannel('alpha')
      .resize(image.width, image.height, { fit: 'fill' })
      .blur(Math.max(1, image.width / 200))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const truth = Uint8Array.from(blurred, (v) => (v >= 64 ? 1 : 0));
    const scored = recipes
      .map((recipe) => {
        const foil = foilOf(recipe, masks);
        return { recipe, foil, iou: maskIou(truth, foil) };
      })
      .sort((a, b) => b.iou - a.iou);
    const foil = scored[0]!.foil;
    const row = {
      id: entry.id,
      split: entry.split ?? 'dev',
      style: entry.style,
      layout: layout.window ? 'window' : layout.panel ? 'panel' : 'none',
      recipe: scored[0]!.recipe.join('+'),
      foilIou: Number(scored[0]!.iou.toFixed(3)),
    };
    results.push(row);
    console.log(JSON.stringify(row));
    // 对照图：卡图、官方遮罩、我们组合出来的、上色的 labels
    const H = 420;
    const W = Math.round((image.width / image.height) * H);
    const gray = async (plane: Uint8Array): Promise<Buffer> =>
      sharp(Buffer.from(plane.map((v) => v * 255)), { raw: { width: image.width, height: image.height, channels: 1 } }).resize(W, H).png().toBuffer();
    const colored = Buffer.alloc(masks.labels.length * 3);
    masks.labels.forEach((k, i) => colored.set(LABEL_COLORS[k] ?? [0, 0, 0], i * 3));
    const panels = [
      await sharp(cardFile).flatten({ background: '#fff' }).resize(W, H).png().toBuffer(),
      await gray(truth),
      await gray(foil),
      await sharp(colored, { raw: { width: image.width, height: image.height, channels: 3 } }).resize(W, H).png().toBuffer(),
    ];
    await sharp({ create: { width: panels.length * (W + 8), height: H, channels: 3, background: '#fff' } })
      .composite(panels.map((input, i) => ({ input, left: i * (W + 8), top: 0 })))
      .jpeg({ quality: 80 })
      .toFile(join(OUT, MODEL === 'lite' ? `${entry.id}-masks.jpg` : `${entry.id}-masks-${MODEL}.jpg`));
  }
  const mean = (v: number[]): number => Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(3));
  const group = (key: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const value of [...new Set(results.map((r) => r[key] as string))]) {
      const v = results.filter((r) => r[key] === value).map((r) => r['foilIou'] as number);
      out[value] = { cards: v.length, foilIou: mean(v) };
    }
    return out;
  };
  const all = results.map((r) => r['foilIou'] as number);
  const summary = { bySplit: group('split'), byStyle: group('style'), byLayout: group('layout'), all: mean(all), cards: all.length };
  const msPerCard = timings.length ? Math.round(timings.reduce((a, b) => a + b, 0) / timings.length) : null;
  writeFileSync(
    join(OUT, MODEL === 'lite' ? 'masks-report.json' : `masks-report-${MODEL}.json`),
    JSON.stringify({ model: MODEL, msPerCard, summary, rows: results }, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const rows: Record<string, unknown>[] = [];
for (const entry of entries) {
  const cardFile = join(DATA, entry.card);
  const image = await rgba(cardFile);
  const pred = findArtWindow(image.data, image.width, image.height);

  const { box: gt, char: gtChar } = await groundTruth(entry, image);

  if (debug && gt) {
    // 全部候选和它们的特征，连同和答案的 IoU，写成一行 JSON，离线比较挑选规则
    const box = gt;
    const list = artWindowCandidates(image.data, image.width, image.height).map((c) => ({ ...c, iou: iou(box, c) }));
    writeFileSync(join(OUT, `${entry.id}.candidates.json`), JSON.stringify(list));
  }
  const row: Record<string, unknown> = {
    id: entry.id,
    source: entry.source,
    split: entry.split ?? 'dev',
    style: entry.style ?? null,
    found: pred !== null,
    score: pred ? Number(pred.score.toFixed(3)) : null,
    boxIou: gt && pred ? Number(iou(gt, pred).toFixed(3)) : gt ? 0 : null,
  };
  let chars: [Uint8Array, Uint8Array] | null = null;
  if (withMatte && gtChar) {
    const predChar = await character(cardFile, image.width, image.height, pred);
    row['charIou'] = Number(maskIou(gtChar, predChar).toFixed(3));
    chars = [gtChar, predChar];
  }
  await sheet(entry, image.width, image.height, gt, pred, chars);
  rows.push(row);
  console.log(JSON.stringify(row));
}

const mean = (values: number[]): number | null => (values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)) : null);
const summary: Record<string, unknown> = {};
for (const key of ['pokemon', 'mtg', 'ygo'].flatMap((source) => ['dev', 'holdout'].map((split) => `${source}/${split}`))) {
  const [source, split] = key.split('/');
  const subset = rows.filter((r) => r['source'] === source && r['split'] === split);
  if (!subset.length) continue;
  const box = subset.map((r) => r['boxIou']).filter((v): v is number => typeof v === 'number');
  const char = subset.map((r) => r['charIou']).filter((v): v is number => typeof v === 'number');
  summary[key] = {
    cards: subset.length,
    windowEvaluated: box.length,
    boxIou: mean(box),
    boxIouOver90: box.filter((v) => v >= 0.9).length,
    ...(char.length ? { charIou: mean(char), charEvaluated: char.length } : {}),
  };
}
writeFileSync(GT_CACHE, JSON.stringify(gtCache));
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
