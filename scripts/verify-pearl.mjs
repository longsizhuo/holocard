/**
 * 复核珠光底的视觉等价：现在的写法（每秒 12 次，Chromium 上再加 will-change，见 pearl-keyframes.mjs）
 * 对比原来的写法（每帧都变的平滑 ease-in-out、不开 will-change），冻结在同一时刻截图逐像素比较。
 * 改了珠光（style.css 里的渐变、pearl-keyframes.mjs 的配置）之后跑一遍；超过阈值就以失败退出。
 *
 * 用法：先把站点跑起来（pnpm dev，或者任何能打开首页的地址）
 *   node scripts/verify-pearl.mjs [--url http://127.0.0.1:5273/] [--browser chromium|webkit]
 * 浏览器：chromium 默认用 Playwright 自带的，用本机 Edge 加 HOLOCARD_BROWSER_CHANNEL=msedge；
 * webkit 就是 Safari 的内核，iPhone 用户最多，混合模式、合成层这些它和 Chromium 的实现不一样，要单独比。
 */

import { chromium, webkit } from 'playwright-core';
import sharp from 'sharp';
import { ANIMATIONS, positionsAt } from './pearl-keyframes.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const url = arg('url', 'http://127.0.0.1:5273/');
const engine = arg('browser', 'chromium');

/** 冻结的时刻（毫秒）。覆盖起点、加速段、最快的中段、减速段，以及往回走的那一程（> 34 秒） */
const TIMES = [0, 5000, 12300, 17000, 25000, 30000, 40000];
/**
 * 阈值：单个像素任一通道最多差几级；差超过 4 级的像素最多占多少。
 * WebKit 同一份 CSS 截两次也会不一样（某些时刻差>4 的像素近 3%），所以每个时刻先把原写法截两次量出噪声，
 * 阈值在噪声之上再放这么多。Chromium 的噪声是 0，就是这两个数本身
 */
const MAX_DIFF = 6;
const MAX_OVER4 = 0.001;

/** 原来的写法：两段平滑的 ease-in-out，不开 will-change */
const ORIGINAL = ANIMATIONS.map(
  (a) =>
    `${a.selector}{animation:${a.name}-ref ${a.seconds}s ease-in-out infinite alternate!important;will-change:auto!important}` +
    `@keyframes ${a.name}-ref{from{background-position:${positionsAt(a, 0)}}to{background-position:${positionsAt(a, 1)}}}`,
).join('');
/** 卡片的渲染和珠光无关，而且无头浏览器里时有时无，藏起来只比背景 */
const HIDE_CARD = '.stage{visibility:hidden!important}';

const channel = process.env.HOLOCARD_BROWSER_CHANNEL;
const browser =
  engine === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });

async function shot(css, ms) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: 'no-preference' });
  await page.addInitScript((c) => {
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = c;
      document.head.append(s);
    });
  }, css);
  await page.goto(url);
  await page.waitForTimeout(2500);
  await page.evaluate((t) => {
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = t;
    }
  }, ms);
  await page.waitForTimeout(400);
  const png = await page.screenshot();
  await page.close();
  return sharp(png).removeAlpha().raw().toBuffer();
}

/** 两张截图逐像素比：平均差、最大差、差>4 的像素比例 */
function compare(a, b) {
  let max = 0;
  let over4 = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(
      Math.abs((a[i] ?? 0) - (b[i] ?? 0)),
      Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)),
      Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)),
    );
    sum += d;
    if (d > max) max = d;
    if (d > 4) over4++;
  }
  const pixels = a.length / 3;
  return { mean: sum / pixels, max, over4: over4 / pixels };
}

let failed = false;
try {
  for (const t of TIMES) {
    const before = await shot(ORIGINAL + HIDE_CARD, t);
    const noise = compare(before, await shot(ORIGINAL + HIDE_CARD, t));
    const d = compare(before, await shot(HIDE_CARD, t));
    const ok = d.max <= Math.max(MAX_DIFF, noise.max) && d.over4 <= MAX_OVER4 + noise.over4 * 1.25;
    if (!ok) failed = true;
    const pct = (v) => `${(v * 100).toFixed(3)}%`;
    console.log(
      `${ok ? '✓' : '✗'} ${(t / 1000).toFixed(1).padStart(5)}s  平均差 ${d.mean.toFixed(3)}/255  最大差 ${d.max}/255  差>4 的像素 ${pct(d.over4)}` +
        (noise.max > 0 ? `（噪声：最大差 ${noise.max}/255，差>4 ${pct(noise.over4)}）` : ''),
    );
  }
} finally {
  await browser.close();
}
if (failed) {
  console.error(`有时刻超过阈值（最大差 ≤ ${MAX_DIFF}/255，差>4 的像素 ≤ ${MAX_OVER4 * 100}%）：珠光的样子变了`);
  process.exit(1);
}
