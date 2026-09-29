/**
 * 走一遍卡带和开包：上传 → 最右边出现（WebGL）卡包 → 按「<」回去玩上一张 → 做好后「>」亮小点 →
 * 回到卡包划开撕 → 新卡转一圈摆上来；再传一张点一下炸开；「减少动态效果」下按回车立刻开出来。
 * 动效本身逐帧看用 scripts/film-pack.mjs。
 * 每一步断言，关键时刻截图到 --out 给人看。改了 deck.ts / pack.ts / 相关样式之后跑一遍。
 *
 * 不需要分层服务：/api 的请求全部在浏览器里拦下来，假装服务端做好了，结果是 public/samples/demo 那张卡。
 * 用法：先把站点跑起来（后端指到一个不存在的地址，拦漏了也不会碰到线上）
 *   HOLOCARD_API=http://127.0.0.1:9 pnpm dev
 *   node scripts/verify-pack.mjs [--url http://127.0.0.1:5273/] [--out /tmp/verify-pack]
 */

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const url = arg('url', 'http://127.0.0.1:5273/');
const out = arg('out', '/tmp/verify-pack');
mkdirSync(out, { recursive: true });
const image = fileURLToPath(new URL('../public/apple-touch-icon.png', import.meta.url));
const sample = fileURLToPath(new URL('../public/samples/demo', import.meta.url));

let failures = 0;
function check(ok, message) {
  console.log(`${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures++;
}

/** 假的分层服务：每个任务前 3 次轮询在做，之后做好 */
async function fakeBackend(page) {
  let jobs = 0;
  const polls = new Map();
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (method === 'POST' && pathname.endsWith('/api/jobs')) {
      jobs++;
      const id = `00000000-0000-4000-8000-${String(jobs).padStart(12, '0')}`;
      return route.fulfill({ status: 201, json: { id, deleteToken: 'test-token' } });
    }
    const job = /\/api\/jobs\/([0-9a-f-]{36})$/.exec(pathname);
    if (job) {
      const n = (polls.get(job[1]) ?? 0) + 1;
      polls.set(job[1], n);
      return route.fulfill({
        json:
          n <= 8
            ? { state: 'running', stage: 'finding-subject', position: 0, eta: 9 - n }
            : { state: 'done', stage: null, position: 0, layers: '/samples/demo', layerCount: 2 },
      });
    }
    // 刷新后按会话恢复的卡：层文件就用示例卡那一套
    const layers = /\/api\/layers\/[0-9a-f-]{36}\/(.+)$/.exec(pathname);
    if (layers) return route.fulfill({ path: join(sample, layers[1]) });
    // 分享、性能埋点这些一律当成功
    return route.fulfill({ status: 200, json: {} });
  });
}

async function upload(page) {
  await page.setInputFiles('#file', image);
  await page.waitForSelector('.deck__pack:not([hidden]) .pack__gl', { timeout: 10_000 });
}

/**
 * WebGL 卡包顶部封口那一条在页面上的位置。和 pack-gl.ts 的相机一样算：
 * 视角 32°，相机退到竖着放得下 1.95、横着放得下 1.3；卡包宽 1、高 1.62，撕开线在 0.648 高处
 */
async function tearLine(page) {
  const box = await page.locator('.deck__pack:not([hidden]) .pack__gl').boundingBox();
  const tan = Math.tan((16 * Math.PI) / 180);
  const camZ = Math.max(1.95 / (2 * tan), 1.3 / (2 * tan * (box.width / box.height)));
  const ppu = box.height / 2 / (camZ * tan);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  return { y: cy - 0.73 * ppu, left: cx - 0.5 * ppu, right: cx + 0.5 * ppu, box };
}

const visible = (page, selector) => page.locator(selector).isVisible();
const waitReady = (page) => page.waitForSelector('.pack.is-ready', { timeout: 15_000 });

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--in-process-gpu'],
});

// ---------- 划开撕、点一下炸开 ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: 'no-preference' });
  await fakeBackend(page);
  await page.goto(url);
  await page.waitForSelector('.deck__card .hc');
  check(!(await visible(page, '.deck__nav--prev')) && !(await visible(page, '.deck__nav--next')), '只有示例卡时左右按钮都藏着');

  await upload(page);
  await page.screenshot({ path: `${out}/1-pack-working.png` });
  check(await visible(page, '.deck__nav--prev'), '上传后出现卡包，左按钮可以回去');
  check(await visible(page, '.pack.is-working'), '卡包在做');

  await page.click('.deck__nav--prev');
  check(await visible(page, '.deck__card'), '按「<」回到示例卡');
  check(await visible(page, '.deck__nav--next'), '右按钮出现');
  await page.waitForSelector('.deck__nav--next.has-new', { timeout: 15_000 });
  await page.screenshot({ path: `${out}/2-back-with-dot.png` });
  check(true, '做好后右按钮亮小点');

  await page.click('.deck__nav--next');
  await waitReady(page);
  check(!(await page.locator('.deck__nav--next').isVisible()), '回到卡包，右边没有了');
  await page.screenshot({ path: `${out}/3-pack-ready.png` });

  check(await visible(page, '.deck__sfx'), '有卡包时出现音效开关');

  // 沿顶部封口从左划到右
  const line = await tearLine(page);
  await page.mouse.move(line.left + 6, line.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(line.left + 6 + ((line.right - line.left) * 0.8 * i) / 12, line.y);
  await page.screenshot({ path: `${out}/4-tearing.png` });
  await page.mouse.up();
  await page.waitForSelector('.deck__card.is-spinning', { timeout: 5000 });
  await page.screenshot({ path: `${out}/4b-spinning.png` });
  check(true, '卡出袋口后转圈亮相');
  await page.waitForFunction(() => !document.querySelector('.deck__pack'), null, { timeout: 8000 });
  check(!(await page.locator('.deck__card').evaluate((el) => el.classList.contains('is-spinning'))), '转完收干净');
  check(await visible(page, '.deck__card .hc'), '划开后新卡摆上来，卡包拆掉');
  check(/\/c\/00000000-/.test(page.url()), '地址栏换成了新卡的链接');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/5-revealed.png` });

  await upload(page);
  await waitReady(page);
  const pack = await page.locator('.deck__pack:not([hidden]) .pack__gl').boundingBox();
  await page.mouse.click(pack.x + pack.width / 2, pack.y + pack.height * 0.6);
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${out}/6-burst.png` });
  await page.waitForFunction(() => !document.querySelector('.deck__pack'), null, { timeout: 8000 });
  check(await visible(page, '.deck__card .hc'), '点一下炸开，新卡摆上来');
  check((await page.locator('.deck__nav--prev').isVisible()) && !(await page.locator('.deck__nav--next').isVisible()), '最新的在最右边');
  check(!(await visible(page, '.deck__sfx')), '卡包都开完了，音效开关收起来');

  // 键盘左右切
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  check(!(await page.locator('.deck__nav--prev').isVisible()), '按两次 ← 回到最左边的示例卡');

  // 刷新：地址栏是最新那张卡，卡带按这个标签页里做过的卡排回来，停在它上面
  await page.reload();
  await page.waitForSelector('.deck__card .hc');
  check(
    (await page.locator('.deck__nav--prev').isVisible()) && !(await page.locator('.deck__nav--next').isVisible()),
    '刷新后卡带恢复，停在最新那张上',
  );
  await page.click('.deck__nav--prev');
  await page.waitForTimeout(800);
  check(await visible(page, '.deck__card .hc'), '恢复出来的上一张点到时才加载，加载得出来');
  await page.close();
}

// ---------- 减少动态效果：按回车立刻开出来 ----------
{
  const page = await browser.newPage({ viewport: { width: 400, height: 860 }, reducedMotion: 'reduce' });
  await fakeBackend(page);
  await page.goto(url);
  await page.waitForSelector('.deck__card .hc');
  await upload(page);
  await waitReady(page);
  await page.screenshot({ path: `${out}/7-phone-ready.png`, fullPage: true });
  await page.focus('.deck__pack');
  const started = Date.now();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.deck__pack'), null, { timeout: 5000 });
  check(Date.now() - started < 1000, `减少动态效果下回车立刻开出来（${Date.now() - started}ms）`);
  await page.close();
}

await browser.close();
console.log(failures ? `\n${failures} 项没过，截图在 ${out}` : `\n全部通过，截图在 ${out}`);
process.exit(failures ? 1 : 0);
