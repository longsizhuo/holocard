/**
 * 验证 npm 包 @holocard/player 的 <holo-card>（packages/player）：先 pnpm build:player。
 *
 * 起一个静态服务器发 packages/player（示例页 + dist），demo/sample 指到 public/samples/demo，
 * 用无头浏览器打开示例页，核对：
 *   - 目录地址、manifest.json 地址两种写法都能加载，层数和清单一致，触发 load
 *   - 地址不对时触发 error，不抛到页面上
 *   - 宿主页面的 CSS 碰不到卡片内部（示例页故意写了 .hc { display: none }），组件也不往宿主页面加样式
 *   - 指针划过时卡片会转
 *
 * 用法：node scripts/verify-player.mjs [截图输出目录]
 * 发版后核对 CDN 上的那份：PLAYER_URL=https://cdn.jsdelivr.net/npm/@holocard/player@<版本>/dist/holocard.js node scripts/verify-player.mjs
 */

import assert from 'node:assert/strict';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'packages', 'player');
const SAMPLE = join(ROOT, 'public', 'samples', 'demo');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png' };
assert.ok(existsSync(join(PKG, 'dist', 'holocard.js')), '先跑 pnpm build:player');

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.startsWith('/demo/sample/') ? join(SAMPLE, path.slice('/demo/sample/'.length)) : join(PKG, path);
  if (!file.startsWith(PKG) && !file.startsWith(SAMPLE)) return res.writeHead(403).end();
  if (!existsSync(file) || statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
// 示例页引用的是本地 dist；给了 PLAYER_URL 就换成那份（发版后核对 CDN）
if (process.env.PLAYER_URL) {
  await page.route('**/dist/holocard.js', async (route) => route.fulfill({ response: await route.fetch({ url: process.env.PLAYER_URL }) }));
}
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// 在组件脚本跑之前就挂好监听，不漏掉 load / error
await page.addInitScript(() => {
  window.__events = [];
  for (const type of ['load', 'error']) {
    document.addEventListener(type, (e) => e.target?.id && window.__events.push(`${e.target.id}:${type}`), true);
  }
});
const sheetsBefore = await page.goto(`${BASE}/demo/index.html`).then(() => page.evaluate(() => document.styleSheets.length));
await page.waitForFunction(() => window.__events.length >= 3, null, { timeout: 15000 });
const events = await page.evaluate(() => window.__events.sort());
assert.deepEqual(events, ['broken:error', 'dir:load', 'manifest:load']);

const manifest = await (await fetch(`${BASE}/demo/sample/manifest.json`)).json();
for (const id of ['dir', 'manifest']) {
  const info = await page.evaluate((id) => {
    const card = document.getElementById(id).shadowRoot.querySelector('.hc');
    return card && { layers: card.querySelectorAll('img').length, display: getComputedStyle(card).display, width: card.getBoundingClientRect().width };
  }, id);
  assert.ok(info, `${id} 应当挂上卡片`);
  assert.ok(info.layers >= manifest.layers.length, `${id} 层数不对：${info.layers}`);
  assert.notEqual(info.display, 'none', '宿主页面的 .hc 规则不该碰到卡片内部');
  assert.ok(info.width > 100, `${id} 宽度不对：${info.width}`);
}
assert.equal(await page.evaluate(() => document.styleSheets.length), sheetsBefore, '组件不该往宿主页面加样式');

const box = await page.locator('#dir').boundingBox();
const rotate = () => page.evaluate(() => getComputedStyle(document.getElementById('dir').shadowRoot.querySelector('.hc')).getPropertyValue('--rotate-x'));
const before = await rotate();
await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.2, { steps: 8 });
await page.waitForTimeout(600);
assert.notEqual(await rotate(), before, '指针划过时卡片应当转');
if (process.argv[2]) await page.screenshot({ path: join(process.argv[2], 'player-demo.png') });
assert.deepEqual(errors, []);

await browser.close();
server.close();
console.log('player ok');
