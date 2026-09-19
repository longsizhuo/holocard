/**
 * 探针：单独跑抠图模型，把 alpha 存成 PNG 看一眼。
 * 用法：node scripts/probe-matte.mjs --image 照片路径 [--out out/matte.png]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const imagePath = resolve(arg('image', ''));
const outFile = resolve(ROOT, arg('out', 'out/matte.png'));
mkdirSync(dirname(outFile), { recursive: true });

const context = await chromium.launchPersistentContext(join(ROOT, '.cache', 'capture-profile'), {
  channel: 'msedge',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
try {
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (e) => console.error('[页面报错]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text().slice(0, 300)); });
  await page.goto(arg('url', 'http://localhost:5273/'), { waitUntil: 'networkidle' });

  const base64 = readFileSync(imagePath).toString('base64');
  const result = await page.evaluate(async ([b64, inputSize]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    const { estimateMatte } = await import('/src/segmenter/matte.ts');
    const { pickDevice } = await import('/src/segmenter/runtime.ts');

    const t0 = performance.now();
    let files = [];
    const matte = await estimateMatte(blob, {
      inputSize,
      onProgress: (p) => { if (p.status === 'done' && p.file) files.push(p.file); },
    });
    const seconds = (performance.now() - t0) / 1000;

    let sum = 0, mid = 0;
    for (const v of matte.data) { sum += v; if (v > 0.05 && v < 0.95) mid++; }

    const canvas = new OffscreenCanvas(matte.width, matte.height);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(matte.width, matte.height);
    for (let i = 0; i < matte.data.length; i++) {
      const g = Math.round(matte.data[i] * 255);
      img.data[i * 4] = g; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = g; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await png.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));

    return {
      device: await pickDevice(), seconds: seconds.toFixed(1),
      size: `${matte.width}x${matte.height}`,
      前景占比: (sum / matte.data.length).toFixed(3),
      半透明像素占比: (mid / matte.data.length).toFixed(4),
      files, png: btoa(bin),
    };
  }, [base64, Number(arg('size', '1024'))]);

  writeFileSync(outFile, Buffer.from(result.png, 'base64'));
  delete result.png;
  console.log(result);
  console.log('alpha 已写到', outFile);
} finally {
  await context.close();
}
