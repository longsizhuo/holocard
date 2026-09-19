/**
 * 线上冒烟测试
 *
 * 用无头 Edge 打开线上地址，走一遍真实的上传 → 分层流程，并记录：
 *   - 页面是否处于跨源隔离状态（多线程 WASM 的前提）
 *   - 分层时实际拉了哪些大文件、从哪拉的、多大
 *   - 最终切了几层
 *
 * 用法：node scripts/verify-live.mjs --image 照片路径 [--url https://holocard.longsizhuo.com/]
 *
 * 注意这里用的是全新的浏览器配置目录，不带任何缓存——
 * 看到的就是一个新访客第一次使用时的真实开销。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const url = arg('url', 'https://holocard.longsizhuo.com/');
const imageArg = arg('image', null);
if (!imageArg) {
  console.error('需要 --image 照片路径');
  process.exit(1);
}
const imagePath = resolve(imageArg);

const profileDir = mkdtempSync(join(tmpdir(), 'holocard-verify-'));
const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: true,
  viewport: { width: 1180, height: 1000 },
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});

/** 只关心体积够大的响应：wasm 和模型权重 */
const bigResponses = [];
let failed = 0;

try {
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (error) => console.error('[页面报错]', error.message));
  page.on('requestfailed', (request) => {
    failed++;
    console.error('[请求失败]', request.url().slice(0, 120), request.failure()?.errorText);
  });
  page.on('response', async (response) => {
    const length = Number(response.headers()['content-length'] ?? 0);
    const target = response.url();
    if (length > 1_000_000 || /\.(wasm|onnx)(\?|$)/.test(target)) {
      bigResponses.push({
        host: new URL(target).host,
        file: target.split('/').pop()?.split('?')[0]?.slice(0, 60),
        status: response.status(),
        传输MB: (length / 1024 / 1024).toFixed(1),
        编码: response.headers()['content-encoding'] ?? '-',
        类型: response.headers()['content-type'] ?? '-',
      });
    }
  });

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.hc');

  const env = await page.evaluate(async () => ({
    跨源隔离: self.crossOriginIsolated,
    SharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    WebGPU: 'gpu' in navigator ? Boolean(await navigator.gpu.requestAdapter().catch(() => null)) : false,
    首屏状态: document.querySelector('#status')?.textContent,
  }));
  console.log('环境:', env);

  await page.setInputFiles('#file', imagePath);
  await page.waitForFunction(
    () => {
      const text = document.querySelector('#status')?.textContent ?? '';
      return text.startsWith('已切成') || text.startsWith('处理失败');
    },
    undefined,
    { timeout: 10 * 60 * 1000 },
  );

  console.log('结果:', await page.textContent('#status'));
  console.log(`总耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s（无缓存的新访客）`);
  console.log('大文件:');
  console.table(bigResponses);
  if (failed > 0) process.exitCode = 1;
} finally {
  await context.close();
  rmSync(profileDir, { recursive: true, force: true });
}
