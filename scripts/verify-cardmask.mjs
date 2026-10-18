/**
 * 端到端验证卡面遮罩（server/pipeline/cardmask.ts、server/routes/cardmask.ts、masks.html）
 *
 * 自己用临时目录起一个服务端，核对：
 *   - 接口：方法不对 405、不是图片 415、不存在的 id / 文件 404；上传 → 202 → 轮询到 done
 *   - 产物：card、六张遮罩（border / frame / text / character / effects / background）、labels 尺寸一致；遮罩是灰度 + alpha 两个通道，
 *     六张互不重叠、每个像素加起来正好 255；labels 是 RGB；masks.json 带版式和每行字的角色；?download=1 按附件发；
 *     放在产物目录的 .cardmasks/<id>/ 下
 *   - 特效遮罩的来源：自己起一个假的识别服务（接口同 deploy/sam3/serve.py），它说不在时按规则出（effectsSource 为 rules）；
 *     回「没有特效」时仍算模型的结果；回左右两半两类、尺寸不同的遮罩时并起来，两半都成了特效，文字不被特效占掉
 *   - 页面：/masks 发 masks.html，?lang=en 时标题是英文；浏览器里上传一张图 → 出预览卡片、六张遮罩和分区总览，
 *     勾选「主角」后预览重新渲染，全程没有页面报错
 *
 * 用法（要 Node 22）：先 pnpm build && pnpm build:server，再
 *   HOLOCARD_MODEL_DIR=/srv/holocard-models /opt/holocard/node22/bin/node scripts/verify-cardmask.mjs
 * 模型目录里要有抠图权重（onnx-community/BiRefNet_lite-ONNX）和文字检测权重（RapidOCR/ch_PP-OCRv4_det_infer.onnx）。
 * 浏览器同 verify-pack：Playwright 自带的 Chromium，HOLOCARD_BROWSER_CHANNEL 可换
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = readFileSync(join(ROOT, 'scripts', 'fixtures', 'og-test.jpg'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL_DIR = process.env.HOLOCARD_MODEL_DIR ?? '/srv/holocard-models';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假识别服务这次怎么回：down 说不在，none 回没有特效，halves 回左半边魔法阵（64×64）和右半边火焰（32×32） */
let fakeMode = 'down';
const halfMask = async (size, left) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#000"/><rect x="${left ? 0 : size / 2}" width="${size / 2}" height="${size}" fill="#fff"/></svg>`;
  return (await sharp(Buffer.from(svg)).greyscale().png().toBuffer()).toString('base64');
};
const fake = createServer((req, res) => {
  if (req.url === '/health') {
    res.statusCode = fakeMode === 'down' ? 503 : 200;
    return res.end('{"ok":true}');
  }
  req.resume();
  req.on('end', async () => {
    const effects = fakeMode === 'halves'
      ? [{ type: 'circle', score: 0.9, mask: await halfMask(64, true) }, { type: 'fire', score: 0.8, mask: await halfMask(32, false) }]
      : [];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ effects }));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));

const work = mkdtempSync(join(tmpdir(), 'holocard-cardmask-'));
const outDir = join(work, 'layers');
let log = '';
const server = spawn(process.execPath, [join(ROOT, 'dist-server', 'holocard-server.mjs')], {
  env: {
    ...process.env,
    HOLOCARD_PORT: String(PORT),
    HOLOCARD_PUBLIC_ORIGIN: BASE,
    HOLOCARD_WEB_DIR: join(ROOT, 'dist'),
    HOLOCARD_OUT_DIR: outDir,
    HOLOCARD_DB: join(work, 'holocard.db'),
    HOLOCARD_MODEL_DIR: MODEL_DIR,
    HOLOCARD_MIN_FREE_GB: '0',
    HOLOCARD_RATE_LIMIT: '1000',
    // 只连假识别服务，结果不依赖家里的显卡机开没开
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

// ---------- 接口 ----------
const code = async (res) => (await res.json()).code;
assert.equal((await fetch(`${BASE}/api/cardmask`)).status, 405, 'GET 提交地址是 405');
const notImage = await fetch(`${BASE}/api/cardmask`, { method: 'POST', body: 'hello' });
assert.equal(notImage.status, 415);
assert.equal(await code(notImage), 'unsupported_image');
const missing = await fetch(`${BASE}/api/cardmask/00000000-0000-0000-0000-000000000000`);
assert.equal(missing.status, 404);
assert.equal(await code(missing), 'cardmask_not_found');

/** 上传测试图，等做完，返回 id 和状态 */
async function submit() {
  const accepted = await fetch(`${BASE}/api/cardmask`, { method: 'POST', body: IMAGE, headers: { 'content-type': 'image/jpeg' } });
  assert.equal(accepted.status, 202, `提交应当 202：${await accepted.clone().text()}`);
  const { id } = await accepted.json();
  assert.match(id, /^[0-9a-f-]{36}$/);
  for (let i = 0; ; i++) {
    const job = await (await fetch(`${BASE}/api/cardmask/${id}`)).json();
    if (job.state === 'done') return { id, job };
    if (job.state === 'error' || i > 240) throw new Error(`没做出来：${JSON.stringify(job)}\n${log.slice(-2000)}`);
    await sleep(1000);
  }
}
/** 一张遮罩的灰度通道 */
const plane = async (url) => (await sharp(Buffer.from(await (await fetch(`${BASE}${url}`)).arrayBuffer())).extractChannel(0).raw().toBuffer());
const { id, job } = await submit();
assert.ok(job.width > 0 && job.height > 0);
assert.deepEqual(Object.keys(job.files).sort(), ['background', 'border', 'card', 'character', 'effects', 'frame', 'labels', 'text']);
assert.ok('panel' in job && Array.isArray(job.lines), '带版式和每行字');
assert.equal(job.effectsSource, 'rules', '识别服务不在时特效遮罩按规则出');
for (const line of job.lines) assert.ok(['name', 'hp', 'body', 'footer', 'art'].includes(line.role), `字的角色 ${line.role}`);
const MASKS = ['border', 'frame', 'text', 'character', 'effects', 'background'];
const sum = new Uint16Array(job.width * job.height);
for (const [name, url] of Object.entries(job.files)) {
  const res = await fetch(`${BASE}${url}`);
  assert.equal(res.status, 200, name);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  assert.equal(meta.width, job.width, `${name} 宽`);
  assert.equal(meta.height, job.height, `${name} 高`);
  if (MASKS.includes(name)) {
    assert.equal(meta.channels, 2, `${name} 是灰度 + alpha`);
    const data = await plane(url);
    for (let i = 0; i < sum.length; i++) sum[i] += data[i];
  }
  if (name === 'labels') assert.equal(meta.channels, 3, 'labels 是 RGB');
}
assert.ok(sum.every((v) => v === 255), '六张遮罩互不重叠，每个像素加起来正好 255');
assert.ok(existsSync(join(outDir, '.cardmasks', id, 'masks.json')), '结果放在 .cardmasks/<id>/');
const download = await fetch(`${BASE}/api/cardmask/${id}/frame.png?download=1`);
assert.match(download.headers.get('content-disposition') ?? '', /attachment; filename="holocard-[0-9a-f]{8}-frame\.png"/);
assert.equal((await fetch(`${BASE}/api/cardmask/${id}/nope.png`)).status, 404, '不认识的文件名 404');

// ---------- 特效遮罩走模型 ----------
/** 左、右两半各有多少特效像素，和文字遮罩的像素数 */
async function effectsSplit(job) {
  const [fx, text] = await Promise.all([plane(job.files.effects), plane(job.files.text)]);
  let left = 0;
  let right = 0;
  for (let i = 0; i < fx.length; i++) if (fx[i]) (i % job.width < job.width / 2 ? left++ : right++);
  return { left, right, text: text.filter(Boolean).length };
}
fakeMode = 'none';
const none = (await submit()).job;
assert.equal(none.effectsSource, 'model', '识别服务回「没有特效」也算模型的结果，不退回规则');
fakeMode = 'halves';
const halves = (await submit()).job;
assert.equal(halves.effectsSource, 'model');
const [empty, both] = await Promise.all([effectsSplit(none), effectsSplit(halves)]);
const half = (job.width * job.height) / 2;
assert.ok(both.left - empty.left > half * 0.2 && both.right - empty.right > half * 0.2, `两类尺寸不同的遮罩并起来，左右两半都成了特效：${JSON.stringify({ empty, both })}`);
assert.equal(both.text, empty.text, '文字不被特效占掉');

// ---------- 页面 ----------
const page404 = await fetch(`${BASE}/masks`);
assert.equal(page404.status, 200, '/masks 发 masks.html');
assert.match(await page404.text(), /<title data-i18n="masks.title">卡面遮罩/);
assert.match(await (await fetch(`${BASE}/masks?lang=en`)).text(), /<title data-i18n="masks.title">Card masks/);

const channel = process.env.HOLOCARD_BROWSER_CHANNEL ?? '';
const browser = await chromium.launch({ ...(channel ? { channel } : {}), args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${BASE}/masks`);
await page.setInputFiles('#masks-file', join(ROOT, 'scripts', 'fixtures', 'og-test.jpg'));
await page.waitForSelector('#masks-result:not([hidden]) .hc', { timeout: 300_000 });
assert.equal(await page.locator('#masks-grid figure').count(), 7, '六张遮罩和分区总览');
await page.check('input[name="region"][value="character"]');
await sleep(500);
assert.ok(await page.locator('#masks-card .hc').isVisible(), '预览卡片还在');
assert.deepEqual(errors, [], '页面没有报错');
await browser.close();
fake.close();

console.log('cardmask ok');
process.exit(0);
