/**
 * 走一遍卡带和开包：上传 → 最右边出现（WebGL）卡包 → 按「<」回去玩上一张 → 做好后「>」亮小点 →
 * 回到卡包划开撕 → 新卡转一圈摆上来；再传一张点一下炸开；「减少动态效果」下按回车立刻开出来。
 * 还有：别人分享的卡第一次打开先出卡包、开过就不出；自己的卡不出；卡册打开直接是网格。
 * 状态栏：卡包在做时是处理进度，停在卡包上（切回来、分享链接首屏）是空的，出错时照常显示错误。
 * 上传区：读屏认得出是「上传照片」按钮，键盘回车、空格能打开选文件。
 * 动效本身逐帧看用 scripts/film-pack.mjs。
 * 每一步断言，关键时刻截图到 --out 给人看。改了 deck.ts / pack.ts / 相关样式之后跑一遍。
 *
 * 不需要分层服务：/api 的请求全部在浏览器里拦下来，假装服务端做好了，结果是 public/samples/demo 那张卡。
 * 用法：先把站点跑起来（后端指到一个不存在的地址，拦漏了也不会碰到线上）
 *   HOLOCARD_API=http://127.0.0.1:9 pnpm dev
 *   node scripts/verify-pack.mjs [--url http://localhost:5273/] [--out /tmp/verify-pack]
 * 浏览器：macOS 默认借用本机 Chrome、Windows 借用 Edge（和 pnpm og 一样），其他系统用 Playwright 自带的 Chromium；
 * 要换就设 HOLOCARD_BROWSER_CHANNEL（chrome / msedge，设成空的用自带的）
 */

import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const url = arg('url', 'http://localhost:5273/');
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
    if (layers) {
      // 示例卡没有缩略图，卡册里就显示「已过期」，不影响开包
      const file = join(sample, layers[1]);
      return existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
    }
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
const statusText = (page) => page.locator('#status').textContent();

// 本地一般没装 Playwright 自带的那份 Chromium，默认借用系统浏览器（和 pnpm og 一样）
const channel =
  process.env.HOLOCARD_BROWSER_CHANNEL ??
  (process.platform === 'darwin' ? 'chrome' : process.platform === 'win32' ? 'msedge' : '');
/** 卡册的入口在个人中心里：页头的账号按钮 → 「打开卡册」。没开登录时（本地连不上服务端也算）按钮直接开卡册 */
async function openAlbum(page) {
  await page.click('#account-open');
  if (await page.locator('#account[open]').count()) await page.click('#account[open] .account__section .api__button');
}

const browser = await chromium.launch({
  ...(channel ? { channel } : {}),
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--use-gl=swiftshader',
    // 自带的 headless shell 不加它截不了图（见 server/render/preview.ts）；正式版 Chrome 加了它，
    // 一画 WebGL 卡包 GPU 进程就崩（macOS 上实测），所以只给自带的
    ...(channel ? [] : ['--in-process-gpu']),
  ],
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
  // 「正在处理 {name}」：三种语言都带文件名，按文件名认
  check((await statusText(page)).includes('apple-touch-icon.png'), '卡包在做时，状态栏是处理进度');

  await page.click('.deck__nav--prev');
  check(await visible(page, '.deck__card'), '按「<」回到示例卡');
  check(await visible(page, '.deck__nav--next'), '右按钮出现');
  await page.waitForSelector('.deck__nav--next.has-new', { timeout: 15_000 });
  await page.screenshot({ path: `${out}/2-back-with-dot.png` });
  check(true, '做好后右按钮亮小点');

  await page.click('.deck__nav--next');
  await waitReady(page);
  check(!(await page.locator('.deck__nav--next').isVisible()), '回到卡包，右边没有了');
  check((await statusText(page)) === '', '切回卡包，状态栏清空（不留上一张卡的层数）');
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
  check(!(await page.locator('.deck__pack').count()), '自己做的卡打开链接不出卡包');
  await page.click('.deck__nav--prev');
  await page.waitForTimeout(800);
  check(await visible(page, '.deck__card .hc'), '恢复出来的上一张点到时才加载，加载得出来');

  // 卡册：入口在个人中心里；打开直接是网格，不出卡包、不发牌
  await openAlbum(page);
  await page.waitForSelector('.albums__grid', { timeout: 5000 });
  check(await page.locator('.albums__grid').isVisible(), '卡册打开直接是网格');
  check(!(await page.locator('#albums .pack__gl').count()), '卡册里不出卡包');
  check((await page.locator('.albums__grid .acard').count()) === 2, '两张卡都在网格里');
  await page.screenshot({ path: `${out}/8-album.png` });
  await page.keyboard.press('Escape');
  await page.close();
}

// ---------- 别人分享的卡：第一次打开先出卡包，开过就直接看卡 ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: 'no-preference' });
  await fakeBackend(page);
  const shared = new URL('c/11111111-1111-4111-8111-111111111111', url).href;
  await page.goto(shared);
  await page.waitForSelector('.deck__pack .pack__gl', { timeout: 10_000 });
  await waitReady(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/11-shared-pack.png` });
  check(true, '别人分享的卡第一次打开，先出一个做好的卡包');
  check((await statusText(page)) === '', '首屏是卡包时状态栏是空的，不停在「正在加载素材」');
  const box = await page.locator('.deck__pack .pack__gl').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6);
  await page.waitForFunction(() => !document.querySelector('.deck__pack'), null, { timeout: 8000 });
  check(await visible(page, '.deck__card .hc'), '开包后就是这张卡');
  await page.reload();
  await page.waitForSelector('.deck__card .hc');
  check(!(await page.locator('.deck__pack').count()), '开过的分享卡再打开直接看卡');
  await page.close();
}

// ---------- 上传区用键盘；停在卡包上出错，状态栏照常显示 ----------
{
  // 要核对具体文案，固定成中文
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' });
  // 一提交就说排满了：前端不重传，直接报错（和 verify-fallback.mjs 的 503 场景一样）
  await page.route('**/api/**', (route) =>
    route.request().method() === 'POST' && new URL(route.request().url()).pathname.endsWith('/api/jobs')
      ? route.fulfill({ status: 503, json: { error: '排队的人太多', code: 'queue_full', params: { queued: 12 } } })
      : route.fulfill({ status: 200, json: {} }),
  );
  await page.goto(url);
  await page.waitForSelector('.deck__card .hc');

  const drop = page.getByRole('button', { name: '上传照片' });
  check((await drop.count()) === 1, '读屏认得出上传区是「上传照片」按钮');
  check((await page.getByRole('img', { name: '上传照片' }).count()) === 0, '图标不再单独读一遍「上传照片」');

  const pick = (key) =>
    Promise.all([page.waitForEvent('filechooser', { timeout: 3000 }), page.keyboard.press(key)]).then(
      ([chooser]) => chooser,
      () => null,
    );
  await drop.focus();
  const byEnter = await pick('Enter');
  check(byEnter !== null, '键盘选中上传区，按回车弹出选文件');
  // 不选文件，把这次关掉，下面空格才弹得出新的
  await byEnter?.setFiles([]);
  const bySpace = await pick('Space');
  check(bySpace !== null, '按空格也弹出选文件');

  await bySpace?.setFiles(image);
  await page.waitForSelector('.pack.is-failed', { timeout: 10_000 });
  await page.screenshot({ path: `${out}/12-failed.png` });
  check(
    (await statusText(page)) === '处理失败：排队的人太多（12 个在等），稍后再试',
    '停在卡包上出错，状态栏照常显示错误',
  );
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
  await openAlbum(page);
  await page.waitForSelector('.albums__grid .acard');
  check(!(await page.locator('.albums__pack').count()), '减少动态效果下卡册不出卡包，直接是网格');
  await page.keyboard.press('Escape');
  await page.goto(new URL('c/22222222-2222-4222-8222-222222222222', url).href);
  await page.waitForSelector('.deck__card .hc');
  check(!(await page.locator('.deck__pack').count()), '减少动态效果下分享链接也不出卡包');
  await page.close();
}

await browser.close();
console.log(failures ? `\n${failures} 项没过，截图在 ${out}` : `\n全部通过，截图在 ${out}`);
process.exit(failures ? 1 : 0);
