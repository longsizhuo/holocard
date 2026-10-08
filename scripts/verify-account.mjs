/**
 * 页头和个人中心的界面（src/demo/account-ui.ts）：
 *   - 页头「文档」跟着界面语言指到 /docs/、/docs/en/、/docs/ja/，切语言跟着变
 *   - 没登录：个人中心有登录入口和本机卡册
 *   - 登录后（假登录）：额度一行、申请两个 key（新 key 只显示一次、列表两行）、吊销一个剩一行
 * 接口本身（额度、吊销生效、管理员）在 verify-auth 里测，这里只看界面。没开登录时按钮直接开卡册，verify-pack 走的就是那条。
 *
 * 用法（要 Node 22）：先 pnpm build && pnpm build:server，再
 *   /opt/holocard/node22/bin/node scripts/verify-account.mjs
 * 浏览器同 verify-pack：HOLOCARD_BROWSER_CHANNEL，或 Playwright 自带的 Chromium（PLAYWRIGHT_BROWSERS_PATH）
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), 'holocard-account-'));
const server = spawn(process.execPath, [join(ROOT, 'dist-server', 'holocard-server.mjs')], {
  env: {
    ...process.env,
    HOLOCARD_PORT: String(PORT),
    HOLOCARD_PUBLIC_ORIGIN: BASE,
    HOLOCARD_WEB_DIR: join(ROOT, 'dist'),
    HOLOCARD_OUT_DIR: join(work, 'layers'),
    HOLOCARD_DB: join(work, 'holocard.db'),
    HOLOCARD_MODEL_DIR: join(work, 'models'),
    HOLOCARD_AUTH_FAKE: '1',
  },
  stdio: 'ignore',
});
process.on('exit', () => {
  server.kill();
  rmSync(work, { recursive: true, force: true });
});
for (let i = 0; !(await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)); i++) {
  if (i > 60) throw new Error('服务端没起来');
  await sleep(1000);
}

const channel = process.env.HOLOCARD_BROWSER_CHANNEL ?? '';
const browser = await chromium.launch({ ...(channel ? { channel } : {}), args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 400, height: 820 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => void d.accept()); // 吊销要确认
const panel = () => page.locator('#account .albums__body').innerText();

// ---------- 页头的文档入口跟着语言 ----------
await page.goto(`${BASE}/?lang=en`);
const docs = page.locator('#docs-link');
await page.waitForFunction(() => document.querySelector('#docs-link')?.getAttribute('href') === '/docs/en/');
for (const [lang, href] of [['ja', '/docs/ja/'], ['zh', '/docs/'], ['en', '/docs/en/']]) {
  await page.click(`[data-lang="${lang}"]`);
  assert.equal(await docs.getAttribute('href'), href, `切到 ${lang}`);
}

// ---------- 没登录 ----------
await page.waitForSelector('#account-open:not([hidden])');
await page.click('#account-open');
await page.waitForSelector('#account[open]');
const out = await panel();
assert.match(out, /Sign in with involutionhell/, '有登录入口');
assert.match(out, /0 cards on this device/, '有本机卡册');
await page.click('#account .albums__close');

// ---------- 登录后：申请两个、吊销一个 ----------
await page.goto(`${BASE}/auth/login?next=${encodeURIComponent('/?lang=zh#account')}`);
await page.waitForSelector('#account[open] .api__button--primary');
assert.match(await panel(), /24 小时内用了 0\/20 张（所有 key 共用）/);
const rows = page.locator('#account .api .api__row:has(.api__info)');
assert.equal(await rows.count(), 0);
for (let n = 1; n <= 2; n++) {
  await page.click('#account .api__button--primary');
  await page.waitForFunction((n) => document.querySelectorAll('#account .api .api__row .api__info').length === n, n);
  assert.match(await page.locator('#account .api__key').inputValue(), /^hc_/, '新 key 显示出来');
}
assert.equal(await page.locator('#account .api__key').count(), 1, '只显示最新的那个 key');
await rows.last().locator('button').click();
await page.waitForFunction(() => document.querySelectorAll('#account .api .api__row .api__info').length === 1);
assert.equal(await page.locator('#account .api__key').count(), 1, '吊销旧的，新 key 还在');
assert.match(await panel(), /接口文档/);
assert.deepEqual(errors, []);

await browser.close();
console.log('account ui ok');
process.exit(0);
