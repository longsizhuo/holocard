/**
 * 验证「什么时候回退到浏览器端」
 *
 * 回退要下约 50MB 模型，用户大多在手机上，所以只有部署里压根没有分层服务时才允许。
 * 这里起一个假的分层服务，按场景回 404 / 502 / 排队满 / 直接断开，
 * 用无头浏览器上传一张图，核对前端的反应：
 *   - 404（纯静态托管，没有后端）       → 回退到浏览器端
 *   - 502（发版重启）、连接断开          → 自动重试 3 次，然后报错，不下载模型
 *   - 503 排队满                          → 直接报错，不重传照片
 *
 * 用法：pnpm build && node scripts/verify-fallback.mjs
 * 浏览器默认用 Playwright 自带的 Chromium；用本机 Edge 的话加 HOLOCARD_BROWSER_CHANNEL=msedge
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const IMAGE = join(ROOT, 'scripts', 'fixtures', 'og-test.jpg');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/** 每个场景：假服务端怎么回提交请求，以及期望前端提交几次、最后停在哪 */
const SCENARIOS = [
  { name: '404 没有后端', reply: (res) => res.writeHead(404).end(), posts: 1, expect: 'fallback' },
  { name: '502 发版重启', reply: (res) => res.writeHead(502).end('Bad Gateway'), posts: 4, expect: '服务器暂时处理不了' },
  { name: '连接断开', reply: (res) => res.socket.destroy(), posts: 4, expect: '网络连接断了' },
  {
    name: '503 排队满',
    reply: (res) =>
      res
        .writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: '排队的人太多', code: 'queue_full', params: { queued: 12 } })),
    posts: 1,
    expect: '排队的人太多',
  },
];

let scenario = SCENARIOS[0];

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (req.method === 'POST' && path === '/api/jobs') {
    // 先把请求体收完再回，和真实服务端一样
    req.resume();
    req.on('end', () => scenario.reply(res));
    return;
  }
  try {
    const file = join(DIST, path === '/' ? 'index.html' : path);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/`;

const channel = process.env.HOLOCARD_BROWSER_CHANNEL;
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
let failures = 0;

try {
  for (const s of SCENARIOS) {
    scenario = s;
    const context = await browser.newContext({ locale: 'zh-CN' });
    const page = await context.newPage();

    // 在浏览器这边数前端发了几次提交。服务端那边数不准：连接被掐断时 Chromium 会自己悄悄重发一次
    let posts = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/jobs')) posts++;
    });

    // 模型和推理运行时一律拦下并计数：除了回退场景，一个字节都不该请求
    let modelRequests = 0;
    await page.route(/\.onnx|\.wasm|huggingface\.co|hf-mirror\.com|\/models\//, (route) => {
      modelRequests++;
      return route.abort();
    });

    // 回退时前端会打这条日志；进度文字一闪而过，靠它判断更稳
    let fellBack = false;
    page.on('console', (message) => {
      if (message.text().includes('回退到浏览器端')) fellBack = true;
    });

    await page.goto(url);
    await page.setInputFiles('#file', IMAGE);
    let result = '超时';
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
      await page.waitForTimeout(200);
      if (fellBack) {
        result = 'fallback';
        break;
      }
      const status = (await page.textContent('#status')) ?? '';
      if (status.startsWith('处理失败')) {
        result = status;
        break;
      }
    }

    const ok =
      result.includes(s.expect) && posts === s.posts && (s.expect === 'fallback' || modelRequests === 0);
    if (!ok) failures++;
    console.log(`${ok ? '✓' : '✗'} ${s.name}：提交 ${posts} 次，模型请求 ${modelRequests} 次，结果「${result}」`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (failures > 0) {
  console.error(`${failures} 个场景不符合预期`);
  process.exit(1);
}
