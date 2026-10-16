/**
 * 端到端验证线稿提取（server/pipeline/lineart.ts、server/pipeline/sketch.ts、server/routes/lineart.ts、lineart.html）
 *
 * 自己用临时目录起一个服务端，核对：
 *   - 接口：方法不对 405、不是图片 415、不存在的 id / 文件 404；上传 → 202 → 轮询到 done
 *   - 产物：image、line、subject 三张尺寸一致、长边不超过 1024；line 是灰度、大半是白底、有黑线；放在产物目录的 .lineart/<id>/ 下
 *   - 页面：/lineart 发 lineart.html，?lang=en 时标题是英文；浏览器里上传一张图 → 预览画出线稿，
 *     换线条颜色后线变成那个颜色，关掉「只要主体」后不透明的像素变多，拖深浅滑块后不透明的像素变化，
 *     点下载得到一张透明底的 PNG；全程没有页面报错。截图在 --out（默认临时目录）
 *
 * 用法（要 Node 22）：先 pnpm build && pnpm build:server，再
 *   HOLOCARD_MODEL_DIR=/srv/holocard-models /opt/holocard/node22/bin/node scripts/verify-lineart.mjs [--out 截图目录]
 * 模型目录里要有线稿模型（anime2sketch/anime2sketch-improved.onnx，导出见 deploy/lineart/export_onnx.py）和抠图权重。
 * 浏览器同 verify-pack：Playwright 自带的 Chromium，HOLOCARD_BROWSER_CHANNEL 可换
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const work = mkdtempSync(join(tmpdir(), 'holocard-lineart-'));
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
assert.equal((await fetch(`${BASE}/api/lineart`)).status, 405, 'GET 提交地址应当 405');
const bad = await fetch(`${BASE}/api/lineart`, { method: 'POST', body: 'not an image' });
assert.equal(bad.status, 415, '不是图片应当 415');
assert.equal((await bad.json()).code, 'unsupported_image');
assert.equal((await fetch(`${BASE}/api/lineart/00000000-0000-0000-0000-000000000000`)).status, 404, '不存在的 id 应当 404');

const res = await fetch(`${BASE}/api/lineart`, { method: 'POST', body: IMAGE });
assert.equal(res.status, 202, `上传应当 202：${await res.clone().text()}`);
const { id } = await res.json();
let job;
for (let i = 0; ; i++) {
  job = await (await fetch(`${BASE}/api/lineart/${id}`)).json();
  if (job.state === 'done') break;
  if (job.state === 'error' || i > 180) throw new Error(`没做出来：${JSON.stringify(job)}\n${log.slice(-2000)}`);
  await sleep(1000);
}
assert.equal(job.subject, true, '有抠图权重时应当有主体遮罩');
assert.deepEqual(Object.keys(job.files).sort(), ['image', 'line', 'subject']);
assert.ok(Math.max(job.width, job.height) <= 1024, `长边不超过 1024：${job.width}×${job.height}`);
const metas = {};
for (const name of ['image', 'line', 'subject']) {
  const file = await fetch(`${BASE}${job.files[name]}`);
  assert.equal(file.status, 200, `${name}.png 应当 200`);
  const buffer = Buffer.from(await file.arrayBuffer());
  metas[name] = { meta: await sharp(buffer).metadata(), buffer };
  assert.equal(metas[name].meta.width, job.width, `${name} 宽度一致`);
  assert.equal(metas[name].meta.height, job.height, `${name} 高度一致`);
}
assert.equal(metas.line.meta.channels, 1, '线稿是单通道灰度');
const gray = await sharp(metas.line.buffer).raw().toBuffer();
const white = gray.filter((v) => v > 230).length / gray.length;
const dark = gray.filter((v) => v < 128).length / gray.length;
assert.ok(white > 0.5, `线稿大半是白底：${(white * 100).toFixed(1)}%`);
assert.ok(dark > 0.002, `线稿上有黑线：${(dark * 100).toFixed(2)}%`);
assert.ok(existsSync(join(outDir, '.lineart', id, 'lineart.json')), '结果放在 .lineart/<id>/ 下');
assert.equal((await fetch(`${BASE}/api/lineart/${id}/nope.png`)).status, 404, '不存在的文件应当 404');

// ---------- 页面 ----------
const page404 = await fetch(`${BASE}/lineart?lang=en`);
assert.equal(page404.status, 200);
assert.match(await page404.text(), /<title data-i18n="lineart.title">Line art — HoloCard<\/title>/, "英文页面的标题");

const outArg = process.argv.indexOf('--out');
const shots = outArg > 0 ? process.argv[outArg + 1] : join(work, 'shots');
mkdirSync(shots, { recursive: true });
const channel = process.env.HOLOCARD_BROWSER_CHANNEL ?? '';
const browser = await chromium.launch({ ...(channel ? { channel } : {}), args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${BASE}/lineart?lang=zh`);
await page.setInputFiles('#lineart-file', { name: 'test.jpg', mimeType: 'image/jpeg', buffer: IMAGE });
await page.waitForSelector('#lineart-result:not([hidden])', { timeout: 180_000 });
/** 预览画布上不透明像素的比例，和不透明像素里颜色最多的那种 */
const inspect = () =>
  page.evaluate(() => {
    const c = document.querySelector('#lineart-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let opaque = 0;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      opaque++;
      if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) red++;
    }
    return { opaque: opaque / (d.length / 4), red: red / Math.max(1, opaque) };
  });
const first = await inspect();
assert.ok(first.opaque > 0.001 && first.opaque < 0.6, `预览画出线稿：不透明 ${(first.opaque * 100).toFixed(2)}%`);
await page.screenshot({ path: join(shots, 'lineart-black.png') });
await page.locator('#lineart-color').evaluate((el) => {
  el.value = '#ff0000';
  el.dispatchEvent(new Event('input'));
});
assert.ok((await inspect()).red > 0.95, '换成红色后线是红的');
await page.screenshot({ path: join(shots, 'lineart-red.png') });
await page.click('#lineart-subject-box');
const whole = await inspect();
assert.ok(whole.opaque > first.opaque, `关掉「只要主体」后线更多：${(first.opaque * 100).toFixed(2)}% → ${(whole.opaque * 100).toFixed(2)}%`);
await page.locator('#lineart-strength').evaluate((el) => {
  el.value = '100';
  el.dispatchEvent(new Event('input'));
});
const darker = await inspect();
assert.ok(darker.opaque > whole.opaque, `深浅拉到最深，线更多：${(whole.opaque * 100).toFixed(2)}% → ${(darker.opaque * 100).toFixed(2)}%`);
await page.screenshot({ path: join(shots, 'lineart-whole-dark.png') });
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#lineart-download')]);
const saved = join(shots, download.suggestedFilename());
await download.saveAs(saved);
const png = await sharp(saved).metadata();
assert.equal(png.format, 'png');
assert.equal(png.hasAlpha, true, '下载的是透明底 PNG');
assert.deepEqual([png.width, png.height], [job.width, job.height], '下载的尺寸和线稿一致');
assert.deepEqual(errors, [], '页面没有报错');
await browser.close();

console.log(`lineart ok，截图在 ${shots}`);
process.exit(0);
