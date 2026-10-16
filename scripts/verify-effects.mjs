/**
 * 端到端验证特效层（server/pipeline/effects.ts、src/segmenter/index.ts、renderer 的光效 glow、面板上的特效动效开关）
 *
 * 不用真的识别模型：自己起一个假的识别服务（接口同 deploy/sam3/serve.py），合成图回两类固定遮罩
 * （左边一个圆环当魔法阵、右上一块当火焰），别的图回「没有特效」。服务端的地址表里先放一个不通的端口，
 * 顺带核对「前一个不通问下一个」。再用临时目录起一个服务端，核对：
 *   - 合成图分出特效层：role 为 effects、effect 是魔法阵和火焰、箔面是光效，深度和视差与它所在的那层相同、
 *     紧跟在那层后面，层图只在遮罩处不透明（遮罩比原图小，按比例放大）
 *   - 识别服务说没有特效的图（scripts/fixtures/og-test.jpg）不出特效层
 *   - 卡片页：逐层箔面里不列特效层；特效动效开关在外面、默认开；动效元素按类型标好、遮罩算好；
 *     关掉开关特效层箔面变成 none；拖强度后生效；没有特效的卡不显示开关；全程没有页面报错
 *
 * 用法（要 Node 22）：先 pnpm build && pnpm build:server，再
 *   HOLOCARD_MODEL_DIR=/srv/holocard-models /opt/holocard/node22/bin/node scripts/verify-effects.mjs
 * 模型目录里要有深度和抠图权重。浏览器同 verify-pack：Playwright 自带的 Chromium，HOLOCARD_BROWSER_CHANNEL 可换
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PHOTO = readFileSync(join(ROOT, 'scripts', 'fixtures', 'og-test.jpg'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL_DIR = process.env.HOLOCARD_MODEL_DIR ?? '/srv/holocard-models';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 合成图：1400×800，暗蓝渐变夜空，几道弯的亮弧线（合计远超半个图宽），中间一个大圆 */
async function syntheticCard() {
  const arcs = [
    'M 60 180 Q 300 60 560 170',
    'M 820 120 Q 1100 40 1340 200',
    'M 80 620 Q 360 520 600 640',
    'M 860 600 Q 1120 700 1360 560',
    'M 150 380 Q 260 300 420 360',
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="800">
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1030"/><stop offset="1" stop-color="#1c2a5a"/></linearGradient></defs>
    <rect width="1400" height="800" fill="url(#sky)"/>
    <circle cx="700" cy="420" r="220" fill="#d98a4a"/>
    <circle cx="640" cy="380" r="40" fill="#f3d2b0"/>
    ${arcs.map((d) => `<path d="${d}" stroke="#fff3c8" stroke-width="3" fill="none"/>`).join('')}
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

/** 假识别服务的遮罩：100×60（比发过去的图小，服务端要按比例放大），左边一个圆环、右上一块 */
async function fakeMask(kind) {
  const shape =
    kind === 'circle'
      ? '<circle cx="18" cy="30" r="12" stroke="#fff" stroke-width="4" fill="none"/>'
      : '<rect x="75" y="5" width="20" height="15" fill="#fff"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#000"/>${shape}</svg>`;
  return (await sharp(Buffer.from(svg)).greyscale().png().toBuffer()).toString('base64');
}

// 合成图是 1400×800，服务端缩到 1008 宽再发；按宽高比认出它，别的图都说没有特效
const fake = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return res.end('{"ok":true}');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const { width, height } = await sharp(Buffer.concat(chunks)).metadata();
    const effects = Math.abs(width / height - 1400 / 800) < 0.01
      ? [{ type: 'circle', score: 0.9, mask: await fakeMask('circle') }, { type: 'fire', score: 0.8, mask: await fakeMask('fire') }]
      : [];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ width, height, effects }));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

const work = mkdtempSync(join(tmpdir(), 'holocard-effects-'));
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
    // 第一个地址没人听，要退到第二个
    HOLOCARD_EFFECTS_URLS: `http://127.0.0.1:${PORT + 1},${FAKE}`,
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

/** 上传一张图，等分层做完，返回 id 和 manifest */
async function layer(image, type) {
  const res = await fetch(`${BASE}/api/jobs`, { method: 'POST', body: image, headers: { 'content-type': type } });
  assert.equal(res.status, 202, `提交应当 202：${await res.clone().text()}`);
  const { id } = await res.json();
  for (let i = 0; ; i++) {
    const job = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
    if (job.state === 'done') break;
    if (job.state === 'error' || i > 300) throw new Error(`没做出来：${JSON.stringify(job)}\n${log.slice(-2000)}`);
    await sleep(1000);
  }
  const manifest = await (await fetch(`${BASE}/api/layers/${id}/manifest.json`)).json();
  return { id, manifest };
}

// ---------- 合成图：要有特效层 ----------
const synthetic = await layer(await syntheticCard(), 'image/jpeg');
const layers = synthetic.manifest.layers;
const effects = layers.map((l, i) => [l, i]).filter(([l]) => l.role === 'effects');
assert.deepEqual(effects.map(([l]) => l.effect).sort(), ['circle', 'fire'], `合成图应当分出魔法阵和火焰两个特效层：${JSON.stringify(layers.map((l) => l.effect ?? l.role ?? 'depth'))}`);
for (const [fx, i] of effects) {
  const parent = layers.slice(0, i).reverse().find((l) => l.role !== 'effects');
  assert.deepEqual(fx.foil, { type: 'glow', intensity: 1 }, '特效层默认上光效');
  assert.equal(fx.depth, parent.depth, '特效层深度和所在的层相同');
  assert.equal(fx.parallax, parent.parallax, '特效层视差和所在的层相同');
}
assert.match(synthetic.manifest.generator, /\+effects=2/, 'generator 记下特效层数');
const [circle] = effects.find(([l]) => l.effect === 'circle');
const alpha = await sharp(Buffer.from(await (await fetch(`${BASE}/api/layers/${synthetic.id}/${circle.file}`)).arrayBuffer()))
  .ensureAlpha()
  .extractChannel(3)
  .raw()
  .toBuffer({ resolveWithObject: true });
const at = (x, y) => alpha.data[Math.floor(y * alpha.info.height) * alpha.info.width + Math.floor(x * alpha.info.width)];
assert.ok(at(0.06, 0.5) > 128, '圆环上不透明（遮罩按比例放大到原图）');
assert.ok(at(0.18, 0.5) < 16, '圆环中间透明');
assert.ok(at(0.85, 0.2) < 16, '火焰那块不在魔法阵层里');

// ---------- 识别服务说没有特效：不出特效层 ----------
const photo = await layer(PHOTO, 'image/jpeg');
assert.ok(!photo.manifest.layers.some((l) => l.role === 'effects'), '没有特效的图不该有特效层');
assert.match(log, /不可用/, '第一个地址不通时记一笔，再问下一个');

// ---------- 卡片页上的特效动效开关 ----------
const channel = process.env.HOLOCARD_BROWSER_CHANNEL ?? '';
const browser = await chromium.launch({ ...(channel ? { channel } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// 这台设备「开过包」，直接进卡片，不出卡包
await context.addInitScript((id) => localStorage.setItem('holocard:seen', JSON.stringify([id])), synthetic.id);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${BASE}/c/${synthetic.id}?lang=zh`);
await page.waitForSelector('.foil-row', { timeout: 60_000 });
await page.waitForFunction(() => document.querySelectorAll('.hc__flow[data-ready]').length === 2, null, { timeout: 30_000 });
assert.equal(await page.locator('.foil-row').count(), layers.length - effects.length, '逐层箔面不列特效层');
assert.equal(await page.locator('#fx-box').isVisible(), true, '有特效的卡在外面显示特效动效开关');
assert.equal(await page.locator('#ctl-fx').isChecked(), true, '特效默认开');
const flows = await page.evaluate(() =>
  [...document.querySelectorAll('.hc__flow[data-ready]')].map((e) => ({ effect: e.dataset.effect, x: e.style.getPropertyValue('--hc-fx-x') })),
);
assert.deepEqual(flows.map((f) => f.effect).sort(), ['circle', 'fire'], '动效元素按类型标好');
const circleX = parseFloat(flows.find((f) => f.effect === 'circle').x);
assert.ok(circleX > 10 && circleX < 30, `魔法阵绕着圆环中心转：中心 x ${circleX}%`);
const foils = () => page.evaluate((idx) => idx.map((i) => document.querySelectorAll('.hc__shine')[i].dataset.foil), effects.map(([, i]) => i));
await page.click('#fx-box');
assert.deepEqual(await foils(), ['none', 'none'], '关掉开关，特效层都不上光效');
await page.click('#fx-box');
await page.click('.more__head');
await page.fill('#ctl-fx-strength', '0.4');
await page.dispatchEvent('#ctl-fx-strength', 'input');
assert.deepEqual(await foils(), ['glow', 'glow'], '再打开恢复光效');
assert.equal(
  await page.evaluate((i) => document.querySelectorAll('.hc__flow')[i].style.getPropertyValue('--hc-foil-intensity'), effects[0][1]),
  '0.4',
  '拖强度生效',
);
assert.deepEqual(errors, [], '页面没有报错');

// 没有特效的卡不显示开关
await context.addInitScript((id) => localStorage.setItem('holocard:seen', JSON.stringify([id])), photo.id);
await page.goto(`${BASE}/c/${photo.id}?lang=zh`);
await page.waitForSelector('.foil-row', { timeout: 60_000 });
assert.equal(await page.locator('#fx-box').isHidden(), true, '没有特效的卡不显示特效动效开关');
await browser.close();
fake.close();

console.log('effects ok');
process.exit(0);
