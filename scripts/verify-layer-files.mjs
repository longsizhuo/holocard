/**
 * 端到端验证分层文件导出：分层 PSD（server/render/psd.ts）和 3D 模型 GLB（server/render/glb.ts），
 * 接口 POST /api/cards/<id>/export/<psd|glb>
 *
 * 用临时目录起一个服务端，特效识别换成假的（同 verify-effects：合成图回魔法阵和火焰两类），做一张卡，导出 PSD 和 GLB，
 * 用这里自带的小解析器读回来。PSD 核对：
 *   - 文件头：RGB 8 位，画布和层图一样大；下载头是 .psd 附件
 *   - 图层：最底下是隐藏的原图，往上按 manifest 的顺序一层一个，名字写着远近或特效类型和箔面
 *   - 像素：每层四个通道解压后和层图逐像素相同，裁掉的部分全透明
 *   - 合成图：和各层叠起来一致
 *   - 没有原图的老卡（迁移来的）：照样导出，只是少了原图层
 * GLB 核对：
 *   - 文件头、JSON 块、二进制块，下载头是 .glb 附件
 *   - 每层一个节点，挂在同一个父节点下，名字和 PSD 的图层名相同，extras 带箔面、深度、视差、特效类型
 *   - 平面整张卡大小、中心都在卡面中心（引擎按物体中心排半透明物体的先后），按视差前后排（视差大的更近），
 *     贴图解出来和层图逐像素相同，材质不受光照、半透明
 *   - 页面：卡片页面板上点「下载分层 PSD」「下载 3D 模型（GLB）」，浏览器各拿到一个下载，页面不报错
 *
 * 用法（要 Node 22）：先 pnpm build && pnpm build:server，再
 *   HOLOCARD_MODEL_DIR=/srv/holocard-models node scripts/verify-layer-files.mjs
 * 模型目录里要有深度和抠图权重
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL_DIR = process.env.HOLOCARD_MODEL_DIR ?? '/srv/holocard-models';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 合成图：暗底、一个大圆当主体、几道亮弧线 */
async function syntheticCard() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="800">
    <rect width="1400" height="800" fill="#13204a"/>
    <circle cx="700" cy="420" r="220" fill="#d98a4a"/>
    <path d="M 60 180 Q 300 60 560 170" stroke="#fff3c8" stroke-width="3" fill="none"/>
    <path d="M 820 120 Q 1100 40 1340 200" stroke="#fff3c8" stroke-width="3" fill="none"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

// 假识别服务：左边一个圆环当魔法阵、右上一块当火焰
const fake = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return res.end('{"ok":true}');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const { width, height } = await sharp(Buffer.concat(chunks)).metadata();
    const mask = async (shape) =>
      (await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#000"/>${shape}</svg>`)).greyscale().png().toBuffer()).toString('base64');
    const effects = [
      { type: 'circle', score: 0.9, mask: await mask('<circle cx="18" cy="30" r="12" stroke="#fff" stroke-width="4" fill="none"/>') },
      { type: 'fire', score: 0.8, mask: await mask('<rect x="75" y="5" width="20" height="15" fill="#fff"/>') },
    ];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ width, height, effects }));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));

const work = mkdtempSync(join(tmpdir(), 'holocard-psd-'));
let log = '';
const server = spawn(process.execPath, [join(ROOT, 'dist-server', 'holocard-server.mjs')], {
  env: {
    ...process.env,
    HOLOCARD_PORT: String(PORT),
    HOLOCARD_PUBLIC_ORIGIN: BASE,
    HOLOCARD_WEB_DIR: join(ROOT, 'dist'),
    HOLOCARD_OUT_DIR: join(work, 'layers'),
    HOLOCARD_DB: join(work, 'holocard.db'),
    HOLOCARD_MODEL_DIR: MODEL_DIR,
    HOLOCARD_MIN_FREE_GB: '0',
    HOLOCARD_RATE_LIMIT: '1000',
    HOLOCARD_EFFECTS_URLS: `http://127.0.0.1:${fake.address().port}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
process.on('exit', () => {
  server.kill();
  rmSync(work, { recursive: true, force: true });
});
for (let i = 0; !(await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)); i++) {
  if (i > 60) throw new Error(`服务端没起来：\n${log}`);
  await sleep(1000);
}

// ---------- 做卡、导出 ----------
const job = await (await fetch(`${BASE}/api/jobs`, { method: 'POST', body: await syntheticCard(), headers: { 'content-type': 'image/jpeg' } })).json();
for (let i = 0; ; i++) {
  const s = await (await fetch(`${BASE}/api/jobs/${job.id}`)).json();
  if (s.state === 'done') break;
  if (s.state === 'error' || i > 300) throw new Error(`没做出来：${JSON.stringify(s)}\n${log.slice(-2000)}`);
  await sleep(1000);
}
const manifest = await (await fetch(`${BASE}/api/layers/${job.id}/manifest.json`)).json();
assert.ok(manifest.layers.some((l) => l.role === 'effects'), '合成图应当有特效层');

/** 提交导出、等到生成好，返回文件和下载响应 */
async function exportFile(format) {
  let status;
  for (let i = 0; ; i++) {
    status = await (await fetch(`${BASE}/api/cards/${job.id}/export/${format}`, { method: i ? 'GET' : 'POST' })).json();
    if (status.state === 'done' || status.state === 'error' || i > 60) break;
    await sleep(1000);
  }
  assert.equal(status.state, 'done', `${format} 导出应当完成：${JSON.stringify(status)}\n${log.slice(-2000)}`);
  const [file] = status.files;
  return { file, res: await fetch(new URL(file.url, BASE)) };
}

const { file, res } = await exportFile('psd');
assert.match(file.name, /^HoloCard_\w{8}\.psd$/);
assert.equal(res.headers.get('content-type'), 'image/vnd.adobe.photoshop');
assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="HoloCard_\w{8}\.psd"/);
const psd = parsePsd(Buffer.from(await res.arrayBuffer()));

// ---------- 读回来核对 ----------
const first = await sharp(Buffer.from(await (await fetch(`${BASE}/api/layers/${job.id}/${manifest.layers[0].file}`)).arrayBuffer())).metadata();
assert.deepEqual([psd.width, psd.height, psd.depth, psd.mode], [first.width, first.height, 8, 3], '画布和层图一样大，RGB 8 位');
assert.equal(psd.layers.length, manifest.layers.length + 1, '原图加上每层一个');
assert.equal(psd.layers[0].name, 'Original');
assert.ok(psd.layers[0].hidden, '原图层默认隐藏');
const names = psd.layers.slice(1).map((l) => l.name);
for (const [i, entry] of manifest.layers.entries()) {
  if (entry.role === 'effects') assert.match(names[i], new RegExp(`^Effect: ${entry.effect} \\(glow foil 100%\\)$`), `特效层名：${names[i]}`);
  else assert.match(names[i], /^(Whole|Far|Near|Middle( \d+)?) \((no foil|\w+ foil \d+%)\)$/, `景深层名：${names[i]}`);
}

const W = psd.width;
const H = psd.height;
for (const [i, entry] of manifest.layers.entries()) {
  const layer = psd.layers[i + 1];
  const src = await sharp(Buffer.from(await (await fetch(`${BASE}/api/layers/${job.id}/${entry.file}`)).arrayBuffer())).ensureAlpha().raw().toBuffer();
  let outside = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4;
      const inside = x >= layer.left && x < layer.right && y >= layer.top && y < layer.bottom;
      if (!inside) {
        outside += src[s + 3];
        continue;
      }
      const p = ((y - layer.top) * (layer.right - layer.left) + (x - layer.left)) * 4;
      for (let c = 0; c < 4; c++) assert.equal(layer.rgba[p + c], src[s + c], `${entry.file} (${x},${y}) 通道 ${c} 对不上`);
    }
  }
  assert.equal(outside, 0, `${entry.file} 裁掉的部分应当全透明`);
}

const flat = await sharp({ create: { width: W, height: H, channels: 4, background: '#ffffff' } })
  .composite(await Promise.all(manifest.layers.map(async (l) => ({ input: Buffer.from(await (await fetch(`${BASE}/api/layers/${job.id}/${l.file}`)).arrayBuffer()) }))))
  .removeAlpha()
  .raw()
  .toBuffer();
assert.ok(flat.equals(psd.merged), '合成图和各层叠起来一致');

// ---------- 没有原图的老卡 ----------
// 删掉原图和刚导出的文件，再导出一次
const cardDir = join(work, 'layers', job.id);
for (const name of readdirSync(cardDir)) if (/^(original\.|layers-v)/.test(name)) rmSync(join(cardDir, name));
const legacy = parsePsd(Buffer.from(await (await exportFile('psd')).res.arrayBuffer()));
assert.deepEqual(legacy.layers.map((l) => l.name), names, '没有原图时只少了原图层');

// ---------- GLB ----------
const glbExport = await exportFile('glb');
assert.match(glbExport.file.name, /^HoloCard_\w{8}\.glb$/);
assert.equal(glbExport.res.headers.get('content-type'), 'model/gltf-binary');
assert.match(glbExport.res.headers.get('content-disposition') ?? '', /attachment; filename="HoloCard_\w{8}\.glb"/);
const glb = parseGlb(Buffer.from(await glbExport.res.arrayBuffer()));
const gltf = glb.json;
assert.equal(gltf.asset.version, '2.0');
assert.deepEqual(gltf.extensionsUsed, ['KHR_materials_unlit']);
const root = gltf.nodes[gltf.scenes[gltf.scene].nodes[0]];
assert.equal(root.children.length, manifest.layers.length, '每层一个节点，挂在同一个父节点下');
assert.deepEqual(root.extras.effects, manifest.effects, '父节点带整卡的炫光、高光参数');
let lastZ = -Infinity;
let lastParallax = -Infinity;
for (const [i, entry] of manifest.layers.entries()) {
  const node = gltf.nodes[root.children[i]];
  assert.equal(node.name, psd.layers[i + 1].name, '节点名和 PSD 图层名相同');
  assert.deepEqual(node.extras.foil, entry.foil);
  assert.equal(node.extras.parallax, entry.parallax);
  assert.equal(node.extras.effect, entry.role === 'effects' ? entry.effect : undefined);
  const prim = gltf.meshes[node.mesh].primitives[0];
  const material = gltf.materials[prim.material];
  assert.equal(material.alphaMode, 'BLEND');
  assert.ok(material.extensions.KHR_materials_unlit, '材质不受光照，颜色和原图一样');
  // manifest 由远到近，视差不减：平面一层比一层靠前（视差相同的也错开一点）
  const pos = gltf.accessors[prim.attributes.POSITION];
  assert.deepEqual([pos.min[0] + pos.max[0], pos.min[1] + pos.max[1], pos.min[2], pos.max[2]], [0, 0, 0, 0], '平面中心在卡面中心，前后位置放在节点上');
  assert.equal(node.translation[0] + node.translation[1], 0);
  const z = node.translation[2];
  assert.ok(entry.parallax >= lastParallax, 'manifest 应当由远到近');
  assert.ok(z > lastZ, `第 ${i} 层应当在前一层前面`);
  lastZ = z;
  lastParallax = entry.parallax;
  // 贴图就是整张层图：PSD 里裁出的那块贴回画布上原来的位置
  const image = gltf.images[gltf.textures[material.pbrMetallicRoughness.baseColorTexture.index].source];
  const view = gltf.bufferViews[image.bufferView];
  const tex = await sharp(glb.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const layer = psd.layers[i + 1];
  assert.deepEqual([tex.info.width, tex.info.height], [W, H], '贴图是整张卡大小');
  const full = Buffer.alloc(W * H * 4);
  const w = layer.right - layer.left;
  for (let y = layer.top; y < layer.bottom; y++) layer.rgba.copy(full, (y * W + layer.left) * 4, (y - layer.top) * w * 4, (y - layer.top + 1) * w * 4);
  // 全透明像素的颜色没有意义（PSD 裁掉的部分记作 0），只比透明度
  for (const px of [tex.data, full]) for (let p = 0; p < px.length; p += 4) if (!px[p + 3]) px.fill(0, p, p + 3);
  assert.ok(tex.data.equals(full), `第 ${i} 层的贴图和层图对不上`);
}

// ---------- 页面上的按钮 ----------
const channel = process.env.HOLOCARD_BROWSER_CHANNEL ?? '';
const browser = await chromium.launch({ ...(channel ? { channel } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
// 这台设备「开过包」，直接进卡片
await context.addInitScript((id) => localStorage.setItem('holocard:seen', JSON.stringify([id])), job.id);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${BASE}/c/${job.id}?lang=zh`);
await page.waitForSelector('#export-psd:visible', { timeout: 30_000 });
for (const [selector, label, ext] of [['#export-psd', '下载分层 PSD', 'psd'], ['#export-glb', '下载 3D 模型（GLB）', 'glb']]) {
  assert.equal((await page.textContent(selector))?.trim(), label);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click(selector)]);
  assert.match(dl.suggestedFilename(), new RegExp(`^HoloCard_\\w{8}\\.${ext}$`), `下载的文件名：${dl.suggestedFilename()}`);
}
assert.deepEqual(errors, [], '页面不报错');
await browser.close();

console.log(`layer files ok：PSD ${psd.layers.length} 个图层 ${(res.headers.get('content-length') / 1e6).toFixed(1)}MB，GLB ${root.children.length} 个平面 ${(glbExport.res.headers.get('content-length') / 1e6).toFixed(1)}MB`);
process.exit(0);

// ---------- GLB 读取：拆出 JSON 块和二进制块 ----------
function parseGlb(buf) {
  assert.equal(buf.readUInt32LE(0), 0x46546c67, 'GLB 魔数');
  assert.equal(buf.readUInt32LE(4), 2);
  assert.equal(buf.readUInt32LE(8), buf.length, '文件头记的长度和实际一致');
  const jsonLen = buf.readUInt32LE(12);
  assert.equal(buf.readUInt32LE(16), 0x4e4f534a, '第一块是 JSON');
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binAt = 20 + jsonLen;
  assert.equal(buf.readUInt32LE(binAt + 4), 0x004e4942, '第二块是 BIN');
  return { json, bin: buf.subarray(binAt + 8, binAt + 8 + buf.readUInt32LE(binAt)) };
}

// ---------- 最小的 PSD 读取：只认 psd.ts 写的那种（RGB 8 位、PackBits） ----------
function parsePsd(buf) {
  let o = 0;
  const u8 = () => buf.readUInt8(o++);
  const u16 = () => ((o += 2), buf.readUInt16BE(o - 2));
  const i16 = () => ((o += 2), buf.readInt16BE(o - 2));
  const u32 = () => ((o += 4), buf.readUInt32BE(o - 4));
  const i32 = () => ((o += 4), buf.readInt32BE(o - 4));
  const ascii = (n) => ((o += n), buf.toString('latin1', o - n, o));
  /** 跳过一段带 4 字节长度前缀的数据（不能写成 o += u32()：右边改了 o，左边用的还是旧值） */
  const skip = () => {
    const n = u32();
    o += n;
  };
  /** n 行 PackBits，每行解出 w 个字节 */
  const unpack = (counts, w) => {
    const out = Buffer.alloc(counts.length * w);
    let q = 0;
    for (const count of counts) {
      const end = o + count;
      while (o < end) {
        const n = buf.readInt8(o++);
        if (n >= 0) {
          buf.copy(out, q, o, o + n + 1);
          o += n + 1;
          q += n + 1;
        } else if (n !== -128) {
          out.fill(buf[o++], q, q + 1 - n);
          q += 1 - n;
        }
      }
    }
    return out;
  };

  assert.equal(ascii(4), '8BPS');
  assert.equal(u16(), 1);
  o += 6;
  const channels = u16();
  const height = u32();
  const width = u32();
  const depth = u16();
  const mode = u16();
  skip(); // 颜色模式数据
  skip(); // 图像资源
  const layerAndMaskEnd = u32() + o;
  u32(); // 图层信息长度
  const count = Math.abs(i16());
  const layers = [];
  for (let i = 0; i < count; i++) {
    const [top, left, bottom, right] = [i32(), i32(), i32(), i32()];
    const chans = Array.from({ length: u16() }, () => ({ id: i16(), length: u32() }));
    assert.equal(ascii(8), '8BIMnorm');
    o += 2;
    const flags = u8();
    o += 1;
    const extraEnd = u32() + o;
    skip(); // 图层蒙版
    skip(); // 混合范围
    const nameLen = u8();
    let name = ascii(nameLen);
    o += (4 - ((nameLen + 1) % 4)) % 4;
    while (o < extraEnd) {
      assert.equal(ascii(4), '8BIM');
      const key = ascii(4);
      const len = u32();
      if (key === 'luni') {
        const n = buf.readUInt32BE(o);
        name = Buffer.from(buf.subarray(o + 4, o + 4 + n * 2)).swap16().toString('utf16le');
      }
      o += len;
    }
    layers.push({ top, left, bottom, right, chans, name, hidden: Boolean(flags & 2) });
  }
  for (const layer of layers) {
    const w = layer.right - layer.left;
    const h = layer.bottom - layer.top;
    layer.rgba = Buffer.alloc(w * h * 4);
    for (const c of layer.chans) {
      const end = o + c.length;
      assert.equal(u16(), 1, '图层通道用 PackBits');
      const plane = unpack(Array.from({ length: h }, () => u16()), w);
      const offset = c.id === -1 ? 3 : c.id;
      for (let p = 0; p < w * h; p++) layer.rgba[p * 4 + offset] = plane[p];
      assert.equal(o, end, '通道长度和记录的一致');
    }
  }
  o = layerAndMaskEnd;
  assert.equal(u16(), 1, '合成图用 PackBits');
  const counts = Array.from({ length: channels * height }, () => u16());
  const planes = [0, 1, 2].map((c) => unpack(counts.slice(c * height, (c + 1) * height), width));
  const merged = Buffer.alloc(width * height * 3);
  for (let p = 0; p < width * height; p++) for (let c = 0; c < 3; c++) merged[p * 3 + c] = planes[c][p];
  return { width, height, depth, mode, layers, merged };
}
