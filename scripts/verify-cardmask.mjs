/**
 * 端到端验证卡面遮罩（server/pipeline/cardmask.ts、server/routes/cardmask.ts、masks.html）
 *
 * 自己用临时目录起一个服务端，核对：
 *   - 接口：方法不对 405、不是图片 415、不存在的 id / 文件 404；上传 → 202 → 轮询到 done
 *   - 产物：card / frame / character / effects / text 五张 PNG 尺寸一致、遮罩是灰度 + alpha 两个通道；?download=1 按附件发；
 *     放在产物目录的 .cardmasks/<id>/ 下
 *   - 页面：/masks 发 masks.html，?lang=en 时标题是英文；浏览器里上传一张图 → 出预览卡片和四张遮罩，
 *     勾选「主角」后预览重新渲染，全程没有页面报错
 *
 * 用法（要 Node 22）：先 pnpm build && pnpm build:server，再
 *   HOLOCARD_MODEL_DIR=/srv/holocard-models /opt/holocard/node22/bin/node scripts/verify-cardmask.mjs
 * 模型目录里要有抠图权重（onnx-community/BiRefNet_lite-ONNX）和文字检测权重（RapidOCR/ch_PP-OCRv4_det_infer.onnx）。
 * 浏览器同 verify-pack：Playwright 自带的 Chromium，HOLOCARD_BROWSER_CHANNEL 可换
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

const accepted = await fetch(`${BASE}/api/cardmask`, { method: 'POST', body: IMAGE, headers: { 'content-type': 'image/jpeg' } });
assert.equal(accepted.status, 202, `提交应当 202：${await accepted.clone().text()}`);
const { id } = await accepted.json();
assert.match(id, /^[0-9a-f-]{36}$/);
let job;
for (let i = 0; ; i++) {
  job = await (await fetch(`${BASE}/api/cardmask/${id}`)).json();
  if (job.state === 'done') break;
  if (job.state === 'error' || i > 240) throw new Error(`没做出来：${JSON.stringify(job)}\n${log.slice(-2000)}`);
  await sleep(1000);
}
assert.ok(job.width > 0 && job.height > 0);
assert.deepEqual(Object.keys(job.files).sort(), ['card', 'character', 'effects', 'frame', 'text']);
for (const [name, url] of Object.entries(job.files)) {
  const res = await fetch(`${BASE}${url}`);
  assert.equal(res.status, 200, name);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  assert.equal(meta.width, job.width, `${name} 宽`);
  assert.equal(meta.height, job.height, `${name} 高`);
  if (name !== 'card') assert.equal(meta.channels, 2, `${name} 是灰度 + alpha`);
}
assert.ok(existsSync(join(outDir, '.cardmasks', id, 'masks.json')), '结果放在 .cardmasks/<id>/');
const download = await fetch(`${BASE}/api/cardmask/${id}/frame.png?download=1`);
assert.match(download.headers.get('content-disposition') ?? '', /attachment; filename="holocard-[0-9a-f]{8}-frame\.png"/);
assert.equal((await fetch(`${BASE}/api/cardmask/${id}/nope.png`)).status, 404, '不认识的文件名 404');

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
assert.equal(await page.locator('#masks-grid figure').count(), 4, '四张遮罩');
await page.check('input[name="region"][value="character"]');
await sleep(500);
assert.ok(await page.locator('#masks-card .hc').isVisible(), '预览卡片还在');
assert.deepEqual(errors, [], '页面没有报错');
await browser.close();

console.log('cardmask ok');
process.exit(0);
