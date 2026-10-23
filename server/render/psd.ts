/**
 * 导出分层 PSD：给想在 Photoshop、Krita、Procreate 里接着改的人。
 *
 * 从下到上：原图（隐藏，对照用）→ 各景深层由远到近，每层后面跟着它的特效层。和渲染器的叠放顺序一致，
 * 每层的透明度就是这一层箔面的遮罩，图层名写着箔面配方（箔面本身是网页里的 CSS 效果，PSD 带不走）。
 *
 * 编码是手写的最小子集：RGB 8 位，图层四个通道（透明 + RGB），PackBits 压缩，
 * 每层只存有内容的那块（manifest 的 bbox）。规范见 Adobe「Photoshop File Formats Specification」
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { LayerEntry, LayerManifest } from '../../src/format/types';

interface PsdLayer {
  name: string;
  hidden: boolean;
  /** 在画布上的位置 */
  left: number;
  top: number;
  width: number;
  height: number;
  /** RGBA，width × height */
  rgba: Buffer;
}

/**
 * 读卡片目录，拼出 PSD。
 * ponytail: 在主线程里同步算（裁边、PackBits），层图长边最多 1400，实测一张几百毫秒；图再大或者导出多了卡住接口，再挪进工作线程
 */
export async function buildPsd(dir: string): Promise<Buffer> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as LayerManifest;
  const first = manifest.layers[0];
  if (!first) throw new Error('这张卡没有层');
  // 画布尺寸以层图为准（层图和 source 一般一样大，迁移来的老卡可能不同）
  const meta = await sharp(join(dir, first.file)).metadata();
  const W = meta.width ?? manifest.source.width;
  const H = meta.height ?? manifest.source.height;

  const layers: PsdLayer[] = [];
  const fulls: Buffer[] = [];
  // 原图按上传的格式存（original.jpg / .png / .webp…），迁移来的老卡没有
  const originalName = (await readdir(dir)).find((name) => name.startsWith('original.'));
  const original = originalName ? await readFile(join(dir, originalName)).catch(() => null) : null;
  if (original) {
    layers.push({ name: 'Original', hidden: true, left: 0, top: 0, width: W, height: H, rgba: await rgbaOf(original, W, H) });
  }
  const depthLayers = manifest.layers.filter((l) => l.role !== 'effects');
  for (const layer of manifest.layers) {
    const full = await rgbaOf(await readFile(join(dir, layer.file)), W, H);
    fulls.push(full);
    // 按实际不透明的像素裁，不用 manifest 的 bbox：它是按阈值算的，边上半透明的一圈会被裁掉
    const [x, y, w, h] = opaqueBox(full, W, H);
    layers.push({ name: layerName(layer, depthLayers), hidden: false, left: x, top: y, width: w, height: h, rgba: crop(full, W, x, y, w, h) });
  }

  // 合成图：没有它很多软件（预览、缩略图）只显示空白。用缩放到画布大小之后的各层叠，层图尺寸不一时也不出错
  const merged = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite(fulls.map((input) => ({ input, raw: { width: W, height: H, channels: 4 as const } })))
    .removeAlpha()
    .raw()
    .toBuffer();
  return encodePsd(W, H, layers, merged);
}

async function rgbaOf(input: Buffer, W: number, H: number): Promise<Buffer> {
  // 原图存盘前已经按 EXIF 摆正、去掉了元数据（见 pipeline/images.ts），rotate() 只是兜底
  return sharp(input).rotate().resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
}

/** alpha 不为 0 的像素的包围盒；整层全透明时给左上角一个像素 */
export function opaqueBox(rgba: Buffer, W: number, H: number): [number, number, number, number] {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!rgba[(y * W + x) * 4 + 3]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? [0, 0, 1, 1] : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

function crop(rgba: Buffer, W: number, x: number, y: number, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) rgba.copy(out, row * w * 4, ((y + row) * W + x) * 4, ((y + row) * W + x + w) * 4);
  return out;
}

/** 图层名：景深层按远近叫，特效层写类型；括号里是网页上配的箔面 */
export function layerName(layer: LayerEntry, depthLayers: readonly LayerEntry[]): string {
  const foil = layer.foil.type === 'none' ? 'no foil' : `${layer.foil.type} foil ${Math.round(layer.foil.intensity * 100)}%`;
  if (layer.role === 'effects') return `Effect: ${layer.effect ?? 'energy'} (${foil})`;
  const i = depthLayers.indexOf(layer);
  const n = depthLayers.length;
  const where = n === 1 ? 'Whole' : i === 0 ? 'Far' : i === n - 1 ? 'Near' : n === 3 ? 'Middle' : `Middle ${i}`;
  return `${where} (${foil})`;
}

// ---------- 编码 ----------

/** PackBits：Photoshop 的 RLE。重复 ≥3 个用一个游程，其余原样成段 */
export function packBits(row: Buffer): Buffer {
  // 最坏情况每 128 字节多一个段头
  const out = Buffer.alloc(row.length + Math.ceil(row.length / 128) + 1);
  let o = 0;
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
    if (run >= 3) {
      out[o++] = 257 - run;
      out[o++] = row[i] ?? 0;
      i += run;
      continue;
    }
    const start = i;
    while (i < row.length && i - start < 128) {
      if (i + 2 < row.length && row[i] === row[i + 1] && row[i] === row[i + 2]) break;
      i++;
    }
    out[o++] = i - start - 1;
    o += row.copy(out, o, start, i);
  }
  return out.subarray(0, o);
}

/** 一个通道按行压缩：返回每行的字节数和压缩后的数据 */
function rleChannel(rgba: Buffer, w: number, h: number, stride: number, offset: number): { counts: number[]; data: Buffer[] } {
  const counts: number[] = [];
  const data: Buffer[] = [];
  const row = Buffer.alloc(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = rgba[(y * w + x) * stride + offset] ?? 0;
    const packed = packBits(row);
    counts.push(packed.length);
    data.push(packed);
  }
  return { counts, data };
}

class Writer {
  parts: Buffer[] = [];
  u8(v: number): void { const b = Buffer.alloc(1); b.writeUInt8(v); this.parts.push(b); }
  u16(v: number): void { const b = Buffer.alloc(2); b.writeUInt16BE(v); this.parts.push(b); }
  i16(v: number): void { const b = Buffer.alloc(2); b.writeInt16BE(v); this.parts.push(b); }
  u32(v: number): void { const b = Buffer.alloc(4); b.writeUInt32BE(v); this.parts.push(b); }
  i32(v: number): void { const b = Buffer.alloc(4); b.writeInt32BE(v); this.parts.push(b); }
  ascii(s: string): void { this.parts.push(Buffer.from(s, 'latin1')); }
  bytes(b: Buffer): void { this.parts.push(b); }
  done(): Buffer { return Buffer.concat(this.parts); }
}

/** 带长度前缀（4 字节）的一段 */
function section(body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/** 图层名：旧版的 Pascal 字符串只能放 ASCII，完整名字另放在 luni 里 */
function layerExtra(name: string): Buffer {
  const w = new Writer();
  w.u32(0); // 图层蒙版：无
  w.u32(0); // 混合范围：无
  const ascii = Buffer.from(name.replace(/[^\x20-\x7e]/g, '?').slice(0, 255), 'latin1');
  const pascal = Buffer.concat([Buffer.from([ascii.length]), ascii]);
  w.bytes(Buffer.concat([pascal, Buffer.alloc((4 - (pascal.length % 4)) % 4)]));
  const uni = new Writer();
  uni.u32(name.length);
  uni.bytes(Buffer.from(name, 'utf16le').swap16());
  let luni = uni.done();
  if (luni.length % 4) luni = Buffer.concat([luni, Buffer.alloc(4 - (luni.length % 4))]);
  w.ascii('8BIMluni');
  w.bytes(section(luni));
  return w.done();
}

export function encodePsd(W: number, H: number, layers: readonly PsdLayer[], mergedRgb: Buffer): Buffer {
  const out = new Writer();
  // 文件头
  out.ascii('8BPS');
  out.u16(1);
  out.bytes(Buffer.alloc(6));
  out.u16(3); // 合成图的通道数
  out.u32(H);
  out.u32(W);
  out.u16(8);
  out.u16(3); // RGB
  out.u32(0); // 颜色模式数据
  out.u32(0); // 图像资源

  // 图层信息
  const records = new Writer();
  const pixels = new Writer();
  records.i16(layers.length);
  for (const layer of layers) {
    // 通道 -1 是透明度，0/1/2 是 RGB；RGBA 里的偏移分别是 3/0/1/2
    const channels = ([[-1, 3], [0, 0], [1, 1], [2, 2]] as const).map(([id, offset]) => {
      const { counts, data } = rleChannel(layer.rgba, layer.width, layer.height, 4, offset);
      const w = new Writer();
      w.u16(1); // PackBits
      for (const c of counts) w.u16(c);
      for (const d of data) w.bytes(d);
      return { id, body: w.done() };
    });
    records.i32(layer.top);
    records.i32(layer.left);
    records.i32(layer.top + layer.height);
    records.i32(layer.left + layer.width);
    records.u16(channels.length);
    for (const c of channels) {
      records.i16(c.id);
      records.u32(c.body.length);
    }
    records.ascii('8BIMnorm');
    records.u8(255); // 不透明度
    records.u8(0); // 剪贴
    records.u8(layer.hidden ? 0x02 : 0x00); // 第 1 位：隐藏
    records.u8(0);
    records.bytes(section(layerExtra(layer.name)));
    for (const c of channels) pixels.bytes(c.body);
  }
  let layerInfo = Buffer.concat([records.done(), pixels.done()]);
  if (layerInfo.length % 2) layerInfo = Buffer.concat([layerInfo, Buffer.alloc(1)]);
  const layerAndMask = Buffer.concat([section(layerInfo), Buffer.alloc(4)]); // 全局蒙版信息：无
  out.bytes(section(layerAndMask));

  // 合成图：三个通道依次排，先写全部行的字节数，再写数据
  out.u16(1);
  const merged = [0, 1, 2].map((offset) => rleChannel(mergedRgb, W, H, 3, offset));
  for (const m of merged) for (const c of m.counts) out.u16(c);
  for (const m of merged) for (const d of m.data) out.bytes(d);
  return out.done();
}
