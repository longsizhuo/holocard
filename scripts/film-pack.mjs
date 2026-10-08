/**
 * 开包动效逐帧定格：撕开（封条翘起 → 甩出 → 卡升出 → 袋子掉落 → 闪卡接手转一圈）、点开（抖 → 炸 → 弹出转圈），
 * 按时间点各截一张，再拼成胶片。改了 pack-gl.ts / deck.ts 的动效之后跑一遍，从头到尾看完再交。
 *
 * 用 Playwright 的虚拟时钟（page.clock）推时间、开包前停住：无头浏览器的真实帧率只有几帧，
 * 靠真实时间截图抓不到中间过程。卡带淡出这类 CSS / Web Animations 动画不归它管，照真实时间走。服务端和 verify-pack.mjs 一样在浏览器里拦下来，第一次轮询就做好。
 * 用法：先起站点（HOLOCARD_API=http://127.0.0.1:9 pnpm dev）
 *   node scripts/film-pack.mjs [--url http://localhost:5273/] [--out /tmp/film-pack]
 * 拼胶片要 ImageMagick 的 montage，没有就只留单帧。
 */

import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const url = arg('url', 'http://localhost:5273/');
const out = arg('out', '/tmp/film-pack');
mkdirSync(out, { recursive: true });
const image = fileURLToPath(new URL('../public/apple-touch-icon.png', import.meta.url));
const sample = fileURLToPath(new URL('../public/samples/demo', import.meta.url));

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--in-process-gpu'],
});

/** 开一页、传一张、等卡包做好。返回卡包画布的位置 */
async function readyPack() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, reducedMotion: 'no-preference' });
  await page.clock.install();
  let jobs = 0;
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (route.request().method() === 'POST' && pathname.endsWith('/api/jobs')) {
      jobs++;
      return route.fulfill({ status: 201, json: { id: `00000000-0000-4000-8000-${String(jobs).padStart(12, '0')}`, deleteToken: 't' } });
    }
    if (/\/api\/jobs\/[0-9a-f-]{36}$/.test(pathname)) {
      return route.fulfill({ json: { state: 'done', stage: null, position: 0, layers: '/samples/demo', layerCount: 2 } });
    }
    const layers = /\/api\/layers\/[0-9a-f-]{36}\/(.+)$/.exec(pathname);
    if (layers) return route.fulfill({ path: join(sample, layers[1]) });
    return route.fulfill({ status: 200, json: {} });
  });
  await page.goto(url);
  await page.clock.runFor(500);
  await page.waitForSelector('.deck__card .hc');
  await page.setInputFiles('#file', image);
  for (let i = 0; i < 40 && !(await page.locator('.pack.is-ready').count()); i++) {
    await page.clock.runFor(500);
    await page.waitForTimeout(100);
  }
  // 卡带滑入的动画、袋子里那张卡的贴图
  await page.clock.runFor(800);
  await page.waitForTimeout(300);
  // 从这里起时间不再自己走，只由 runFor 推：截一张图要一两秒，不停住的话动画在截图时就播完了
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 5000);
  return page;
}

/** 推到 at 毫秒（从 t0 算起）截一张 */
async function shootAt(page, name, frames) {
  let now = 0;
  for (const at of frames) {
    await page.clock.runFor(at - now);
    now = at;
    await page.waitForTimeout(120);
    await page.locator('.stage').screenshot({ path: join(out, `${name}-${String(at).padStart(4, '0')}.png`) });
  }
}

// ---------- 撕开 ----------
{
  const page = await readyPack();
  const box = await page.locator('.deck__pack:not([hidden]) .pack__gl').boundingBox();
  // 和 pack-gl.ts 的相机一样算撕开线的位置（见 verify-pack.mjs 的 tearLine）
  const tan = Math.tan((16 * Math.PI) / 180);
  const camZ = Math.max(1.95 / (2 * tan), 1.3 / (2 * tan * (box.width / box.height)));
  const ppu = box.height / 2 / (camZ * tan);
  const y = box.y + box.height / 2 - 0.73 * ppu;
  const left = box.x + box.width / 2 - 0.5 * ppu;
  await page.mouse.move(left + 6, y);
  await page.mouse.down();
  for (const [i, p] of [0.2, 0.4, 0.7].entries()) {
    for (let k = 1; k <= 4; k++) await page.mouse.move(left + 6 + ppu * (p - 0.1 + (0.1 * k) / 4), y);
    await page.clock.runFor(100);
    await page.waitForTimeout(120);
    await page.locator('.stage').screenshot({ path: join(out, `tear-a${i}.png`) });
  }
  await page.mouse.up();
  await shootAt(page, 'tear-b', [100, 300, 600, 900, 1150, 1300, 1450, 1650, 1850, 2050, 2300, 2700]);
  await page.close();
}

// ---------- 点开 ----------
{
  const page = await readyPack();
  const box = await page.locator('.deck__pack:not([hidden]) .pack__gl').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6);
  await shootAt(page, 'burst', [150, 400, 520, 620, 750, 900, 1100, 1350, 1800]);
  await page.close();
}

await browser.close();
try {
  for (const [name, tile] of [['tear-a', '3x1'], ['tear-b', '6x2'], ['burst', '9x1']]) {
    execFileSync('sh', ['-c', `montage ${out}/${name}*.png -tile ${tile} -geometry 330x250+3+3 ${out}/sheet-${name}.jpg`]);
  }
  console.log(`胶片在 ${out}/sheet-*.jpg`);
} catch {
  console.log(`单帧在 ${out}（没有 montage，没拼胶片）`);
}
