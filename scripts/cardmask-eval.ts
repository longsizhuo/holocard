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
 *   pnpm cardmask:eval [--matte] [--only <id 前缀>]
 *   --matte  连主角一起评（BiRefNet，一张二十几秒，峰值 7GB 内存）；模型目录取 HOLOCARD_MODEL_DIR，默认 .models
 * 每张卡画一张对照图到 .cardmask/out/（绿框是标准答案，红框是检测结果），汇总写 .cardmask/out/report.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { env } from '@huggingface/transformers';
import { artWindowCandidates, findArtWindow, type Box } from '../src/cardmask/frame';
import { estimateMatte } from '../src/segmenter/matte';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DATA = join(ROOT, '.cardmask', 'data');
const OUT = join(ROOT, '.cardmask', 'out');
const argv = process.argv.slice(2);
const withMatte = argv.includes('--matte');
const only = argv.includes('--only') ? (argv[argv.indexOf('--only') + 1] ?? '') : '';
/** 打印每张卡的候选矩形（按和答案的 IoU 排），调画框检测用 */
const debug = argv.includes('--debug');

interface Entry {
  id: string;
  source: 'pokemon' | 'mtg' | 'ygo';
  style?: string;
  card: string;
  mask?: string;
  art?: string;
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
async function character(file: string, width: number, height: number, box: Box | null): Promise<Uint8Array> {
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
  const out = new Uint8Array(width * height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mx = Math.min(matte.width - 1, Math.floor((x / w) * matte.width));
      const my = Math.min(matte.height - 1, Math.floor((y / h) * matte.height));
      if ((matte.data[my * matte.width + mx] ?? 0) > 0.5) out[(top + y) * width + left + x] = 1;
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

mkdirSync(OUT, { recursive: true });
if (!existsSync(join(DATA, 'index.json'))) throw new Error('先跑 node scripts/cardmask-fetch.mjs 下载评测集');
const entries = (JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as Entry[]).filter((e) => e.id.startsWith(only));

const rows: Record<string, unknown>[] = [];
for (const entry of entries) {
  const cardFile = join(DATA, entry.card);
  const image = await rgba(cardFile);
  const pred = findArtWindow(image.data, image.width, image.height);

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
    const located = await locateArt(cardFile, join(DATA, entry.art));
    // 匹配得不好（单独的画和卡上的不是同一版，比如日版卡压了水印）就没有可信的答案，不评
    if (located.cost <= MAX_MATCH_COST) gt = located.box;
    else console.log(`${entry.id}：画在卡上找不到（匹配代价 ${located.cost.toFixed(0)}），不评画框`);
  }

  if (debug && gt) {
    // 全部候选和它们的特征，连同和答案的 IoU，写成一行 JSON，离线比较挑选规则
    const box = gt;
    const list = artWindowCandidates(image.data, image.width, image.height).map((c) => ({ ...c, iou: iou(box, c) }));
    writeFileSync(join(OUT, `${entry.id}.candidates.json`), JSON.stringify(list));
  }
  const row: Record<string, unknown> = {
    id: entry.id,
    source: entry.source,
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
for (const source of ['pokemon', 'mtg', 'ygo']) {
  const subset = rows.filter((r) => r['source'] === source);
  const box = subset.map((r) => r['boxIou']).filter((v): v is number => typeof v === 'number');
  const char = subset.map((r) => r['charIou']).filter((v): v is number => typeof v === 'number');
  summary[source] = {
    cards: subset.length,
    windowEvaluated: box.length,
    boxIou: mean(box),
    boxIouOver90: box.filter((v) => v >= 0.9).length,
    ...(char.length ? { charIou: mean(char), charEvaluated: char.length } : {}),
  };
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
