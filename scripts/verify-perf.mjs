/**
 * 性能埋点冒烟测试：打开页面，等它自己把那一条埋点发出去，看服务端收没收；再拿几条坏数据打接口，看挡没挡住。
 *
 * 用法：先把服务跑起来（pnpm dev + pnpm dev:server，或者任何能打开首页的地址）
 *   node scripts/verify-perf.mjs [--url http://localhost:5273/] [--browser chromium|webkit|firefox]
 * 会往那个服务的库里写一条真实的埋点，别对着线上跑。
 */

import * as playwright from 'playwright-core';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const url = arg('url', 'http://localhost:5273/');
const engine = arg('browser', 'chromium');
const endpoint = new URL('api/perf', url).href;

let failed = false;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed = true;
};

// 1. 真实页面：静置 3 秒 + 量 10 秒之后应该发一条
const browser = await playwright[engine].launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (error) => check(false, `页面报错：${error.message}`));
  // sendBeacon 发的是 Blob，Playwright 拿不到请求体，在页面里包一层把发出去的内容记下来
  await page.addInitScript(() => {
    const original = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (target, data) => {
      if (data instanceof Blob) void data.text().then((text) => (window.__perfSent = text));
      return original(target, data);
    };
  });
  const response = page.waitForResponse((r) => r.url() === endpoint, { timeout: 60_000 });
  await page.goto(url);
  const status = (await response).status();
  const sample = JSON.parse(await page.waitForFunction(() => window.__perfSent).then((h) => h.jsonValue()));
  check(status === 204, `服务端收下了（${status}）`);
  console.log('  ', JSON.stringify(sample));
  check(sample.mode === 'demo' && sample.frames > 0 && sample.fps > 0, '帧数、帧率有值');
  check(sample.p50 <= sample.p95 && sample.p95 <= sample.max_ms, '分位数有序');
  check(sample.dropped >= 0 && sample.dropped < 1, '掉帧比例在 0～1');
  check(sample.screen_w > 0 && sample.dpr > 0, '屏幕尺寸、缩放比有值');
  // 一次访问只发一条：再等一轮测量的时间，不该有第二条
  let extra = 0;
  page.on('request', (r) => {
    if (r.url() === endpoint) extra++;
  });
  await page.waitForTimeout(15_000);
  check(extra === 0, '同一次访问没有发第二条');
} finally {
  await browser.close();
}

// 2. 接口是公开的：坏数据要挡掉
const good = {
  mode: 'demo', fps: 60, p50: 16.7, p95: 18, max_ms: 40, hz: 60, dropped: 0.01, frames: 600,
  screen_w: 1920, screen_h: 1080, view_w: 1920, view_h: 960, dpr: 1, cores: 8, memory: 8,
  gpu: 'test', parallax: true, busy: false, interacted: false, reduced_motion: false,
};
const post = (body) =>
  fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => ({ status: 0 }));
const cases = [
  ['不是 JSON', 'nope', 400],
  ['数组', '[]', 400],
  ['mode 不认识', JSON.stringify({ ...good, mode: 'x' }), 400],
  ['数字是字符串', JSON.stringify({ ...good, fps: '60' }), 400],
  ['超出范围', JSON.stringify({ ...good, dropped: 2 }), 400],
  ['缺必填', JSON.stringify({ ...good, fps: undefined }), 400],
  ['开关不是布尔', JSON.stringify({ ...good, busy: 1 }), 400],
  // 超过上限时服务端直接断开连接（readBody 的做法，不把大请求体读进内存），记成 0
  ['超过 4KB', JSON.stringify({ ...good, gpu: 'x'.repeat(5000) }), 0],
  ['可选字段是 null', JSON.stringify({ ...good, memory: null, gpu: null }), 204],
];
for (const [label, body, want] of cases) {
  const got = (await post(body)).status;
  check(got === want, `${label} → ${got}${got === want ? '' : `（应为 ${want}）`}`);
}

process.exit(failed ? 1 : 0);
