/**
 * 走一遍面板上跟卡有关的部分（web/site 的 tuning.ts、actions.ts、upload.ts、render-page.ts）：
 * 示例卡只出箔面面板、不给分享删除导出；关视差滑块变灰、偏好记到本机；切英文状态栏和层名跟着换；
 * 做一张卡、开包后地址栏换成卡片链接，点分享拿到链接，切语言链接跟着换；改箔面停手后存回服务端；
 * 导出动图排队后下载、失败时提示服务端给的原因；删卡后操作收起、地址退回首页；渲染页就绪、带分享图文案、导出钩子在；
 * 全程页面不报错。
 *
 * 不需要分层服务：/api 的请求全部在浏览器里拦下来，假装服务端做好了，结果是 web/public/samples/demo 那张卡。
 * 用法：先把站点跑起来（后端指到一个不存在的地址，拦漏了也不会碰到线上）
 *   HOLOCARD_API=http://127.0.0.1:9 pnpm dev
 *   node scripts/verify-panel.mjs [--url http://localhost:5273/]
 * 浏览器的选法同 scripts/verify-pack.mjs（HOLOCARD_BROWSER_CHANNEL）
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const i = argv.indexOf('--url');
const url = i >= 0 && argv[i + 1] ? argv[i + 1] : 'http://localhost:5273/';
const image = fileURLToPath(new URL('../web/public/apple-touch-icon.png', import.meta.url));
const sample = fileURLToPath(new URL('../web/public/samples/demo', import.meta.url));
const ID = '00000000-0000-4000-8000-000000000001';

let failures = 0;
function check(ok, message) {
  console.log(`${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures++;
}

/** 假的分层服务：任务轮询两次后做好；导出先排队再按 exportResult 回；记下页面发出的每个 /api 请求 */
const requests = [];
let exportResult;
async function fakeBackend(page) {
  let polls = 0;
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    requests.push(`${method} ${pathname}`);
    if (method === 'POST' && pathname.endsWith('/api/jobs')) return route.fulfill({ status: 201, json: { id: ID, deleteToken: 'test-token' } });
    if (/\/api\/jobs\/[0-9a-f-]{36}$/.test(pathname)) {
      return route.fulfill({
        json: ++polls < 3
          ? { state: 'running', stage: 'finding-subject', position: 0, eta: 3 }
          : { state: 'done', stage: null, position: 0, layers: '/samples/demo', layerCount: 2 },
      });
    }
    if (/\/api\/cards\/[0-9a-f-]{36}\/export\/\w+$/.test(pathname)) {
      return route.fulfill({ status: method === 'POST' ? 202 : 200, json: method === 'POST' ? { state: 'queued', position: 1 } : exportResult });
    }
    const layers = /\/api\/layers\/[0-9a-f-]{36}\/(.+)$/.exec(pathname);
    if (layers) {
      const file = join(sample, layers[1]);
      return existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
    }
    // 分享、存配置、删卡、性能埋点一律当成功
    return route.fulfill({ status: 200, json: {} });
  });
}

const channel =
  process.env.HOLOCARD_BROWSER_CHANNEL ??
  (process.platform === 'darwin' ? 'chrome' : process.platform === 'win32' ? 'msedge' : '');
const browser = await chromium.launch({
  ...(channel ? { channel } : {}),
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', ...(channel ? [] : ['--in-process-gpu'])],
});
const errors = [];

// ---------- 示例卡上的调参面板、语言切换 ----------
// 「减少动态效果」：开包按回车立刻开出来，不用等动画；中文环境：首屏是中文，切英文才看得出变化
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', locale: 'zh-CN' });
page.on('pageerror', (error) => errors.push(error.message));
await fakeBackend(page);
await page.goto(url);
await page.waitForSelector('.deck__card .hc');
check((await page.locator('#foil-list .foil-row').count()) === 2, '示例卡：箔面面板按层数出两行');
check(
  (await page.locator('#share').isHidden()) && (await page.locator('#owner').isHidden()) && (await page.locator('#export').isHidden()),
  '示例卡：分享、删除、导出都藏着',
);
await page.locator('.more summary').click();
await page.uncheck('#ctl-parallax');
check(
  (await page.locator('#ctl-amp').isDisabled()) && (await page.evaluate(() => localStorage.getItem('holocard:parallax'))) === 'off',
  '关视差：振幅滑块变灰，偏好记到本机',
);
await page.check('#ctl-parallax');
const zh = await page.locator('#status').textContent();
await page.click('.lang [data-lang="en"]');
const en = await page.locator('#status').textContent();
const layerName = await page.locator('#foil-list .foil-row__name').first().textContent();
check(en !== zh && /^[\x20-\x7e]+$/.test(`${en}${layerName}`), `切英文：状态栏、箔面层名跟着换（${en} / ${layerName}）`);
await page.click('.lang [data-lang="zh"]');

// ---------- 做一张卡：分享、存配置、删除 ----------
await page.setInputFiles('#file', image);
await page.waitForSelector('.pack.is-ready', { timeout: 15_000 });
await page.focus('.deck__pack');
await page.keyboard.press('Enter');
await page.waitForFunction(() => !document.querySelector('.deck__pack'), null, { timeout: 5000 });
check(requests.includes(`POST /api/cards/${ID}/share`), '做完卡不等开包，后台自动转成分享状态');
check(new URL(page.url()).pathname === `/c/${ID}`, '开包后地址栏换成卡片链接');
check((await page.locator('#owner').isVisible()) && (await page.locator('#export').isVisible()), '自己的卡：删除、导出都出来');
await page.click('#share-btn');
await page.waitForFunction(() => document.querySelector('#share-url')?.value.includes('/c/'), null, { timeout: 5000 }).catch(() => {});
check((await page.inputValue('#share-url')).endsWith(`/c/${ID}`), '点分享，链接填好');
await page.click('.lang [data-lang="en"]');
check((await page.inputValue('#share-url')).endsWith(`/c/${ID}?lang=en`), '切英文后分享链接带上语言');
await page.click('.lang [data-lang="zh"]');

const before = requests.length;
await page.selectOption('#foil-list .foil-row select >> nth=0', 'rainbow');
// 停手 800ms 才存
await page.waitForTimeout(1200);
check(requests.slice(before).includes(`PUT /api/cards/${ID}/config`), '改箔面：停手后存回服务端');

// 电脑上导出的是 APNG，做好直接下载
exportResult = { state: 'done', files: [{ url: '/samples/demo/manifest.json', name: 'holocard.apng', type: 'image/apng' }] };
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }).catch(() => null), page.click('#export-btn')]);
check(download?.suggestedFilename() === 'holocard.apng' && !(await page.locator('#export-hint').textContent()), '导出：排队、做好后下载，没有报错提示');
exportResult = { state: 'error', error: '测试用的失败原因' };
await page.click('#export-btn');
await page.waitForFunction(() => document.querySelector('#export-hint')?.textContent, null, { timeout: 10_000 }).catch(() => {});
check((await page.locator('#export-hint').textContent()).includes('测试用的失败原因'), '导出失败：提示服务端给的原因');

page.once('dialog', (dialog) => dialog.accept());
await page.click('#delete-btn');
await page.waitForFunction(() => document.querySelector('#owner')?.hidden, null, { timeout: 5000 }).catch(() => {});
check(requests.includes(`DELETE /api/cards/${ID}`), '确认后发出删卡请求');
check(
  (await page.locator('#owner').isHidden()) && (await page.locator('#share').isHidden()) && new URL(page.url()).pathname === '/',
  '删卡后操作收起、地址栏退回首页',
);
await page.close();

// ---------- 渲染页 ----------
const render = await browser.newPage({ viewport: { width: 1200, height: 630 } });
render.on('pageerror', (error) => errors.push(error.message));
await fakeBackend(render);
await render.goto(new URL('render/00000000-0000-4000-8000-000000000002', url).href);
await render.waitForFunction(() => document.body.dataset['ready'], null, { timeout: 15_000 });
check(
  (await render.evaluate(() => document.body.dataset['ready'])) === '1' &&
    (await render.locator('.render-copy').count()) === 1 &&
    (await render.evaluate(() => typeof window.__hcExportPose)) === 'function',
  '渲染页：就绪、带分享图文案、导出钩子在',
);
check(errors.length === 0, `页面没有报错${errors.length ? `：${errors.join(' | ')}` : ''}`);

await browser.close();
console.log(failures ? `\n${failures} 项没过` : '\n全部通过');
process.exit(failures ? 1 : 0);
