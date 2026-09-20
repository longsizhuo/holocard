/**
 * 录制演示 GIF / 导出诊断图
 *
 * 用本机 Edge（无头）打开开发服务，走和用户完全一样的上传路径跑分层，
 * 然后用渲染器的 setPose 逐帧摆姿态截图，最后交给 ffmpeg 做调色板两遍编码。
 * 每一帧都是确定性的，不依赖真实鼠标，也不依赖窗口是否在前台。
 *
 * 用法（先 pnpm dev 把开发服务跑起来）：
 *   node scripts/capture.mjs --image 照片路径                 录一张 GIF 到 out/demo.gif
 *   node scripts/capture.mjs --image 照片路径 --dump          额外把每一层导出成 PNG，排查分层问题用
 *   node scripts/capture.mjs --image 照片路径 --dump --no-gif  只导出层，不录 GIF（快得多）
 *   node scripts/capture.mjs                                   不传图片则录手工素材
 *
 * 可选参数：--out 输出路径  --fps 帧率  --seconds 时长  --width GIF 宽度
 *           --url 开发服务地址  --pose x,y 诊断静帧用的姿态（配合 --dump）
 *           --no-gif 跳过录制
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 极简参数解析：--key value 或 --flag */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? 'http://localhost:5273/';
const outFile = resolve(ROOT, args.out ?? 'out/demo.gif');
const fps = Number(args.fps ?? 30);
const seconds = Number(args.seconds ?? 4);
const gifWidth = Number(args.width ?? 480);
const imagePath = typeof args.image === 'string' ? resolve(args.image) : null;

const outDir = dirname(outFile);
const framesDir = join(outDir, 'frames');
mkdirSync(outDir, { recursive: true });

// 浏览器配置目录放在项目里并长期保留：深度模型有 50MB，缓存下来第二次就不用再下
const profileDir = join(ROOT, '.cache', 'capture-profile');
mkdirSync(profileDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: true,
  viewport: { width: 1180, height: 1000 },
  // 2 倍像素密度截图，再由 ffmpeg 缩小，边缘比直接 1 倍截图干净得多
  deviceScaleFactor: 2,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});

try {
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (error) => console.error('[页面报错]', error.message));

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.hc');

  if (imagePath) {
    console.log(`上传 ${imagePath}`);
    await page.setInputFiles('#file', imagePath);
    // 首次要下模型，给足时间
    await page.waitForFunction(
      () => {
        const text = document.querySelector('#status')?.textContent ?? '';
        return text.startsWith('已切成') || text.startsWith('处理失败');
      },
      undefined,
      { timeout: 10 * 60 * 1000 },
    );
    const status = await page.textContent('#status');
    console.log(status);
    if (status?.startsWith('处理失败')) throw new Error(status);
  }

  // 等纹理生成完、所有层解码完，否则前几帧会是半成品
  await page.waitForFunction(() =>
    Boolean(document.querySelector('.hc')?.style.getPropertyValue('--grain')),
  );
  await page.evaluate(async () => {
    const images = [...document.querySelectorAll('.hc__art')];
    await Promise.all(images.map((img) => img.decode().catch(() => undefined)));
    document.querySelector('.hc')?.scrollIntoView({ block: 'center' });
  });

  // 截图范围：卡片四周留白，给 3D 倾斜后探出去的边角留位置
  const box = await page.locator('.hc').boundingBox();
  if (!box) throw new Error('找不到卡片');
  const margin = 56;
  const clip = {
    x: Math.max(0, box.x - margin),
    y: Math.max(0, box.y - margin),
    width: box.width + margin * 2,
    height: box.height + margin * 2,
  };

  if (args.dump) {
    const dumpDir = join(outDir, 'dump');
    mkdirSync(dumpDir, { recursive: true });

    // 每一层的原始位图
    const layers = await page.evaluate(async () => {
      const images = [...document.querySelectorAll('.hc__art')];
      return Promise.all(
        images.map(async (img) => {
          const blob = await (await fetch(img.src)).blob();
          const buffer = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (let i = 0; i < buffer.length; i += 0x8000) {
            binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
          }
          return { type: blob.type, base64: btoa(binary) };
        }),
      );
    });
    layers.forEach((layer, index) => {
      const ext = layer.type.includes('svg') ? 'svg' : 'png';
      writeFileSync(join(dumpDir, `layer-${index}.${ext}`), Buffer.from(layer.base64, 'base64'));
    });

    const [px, py] = String(args.pose ?? '80,45').split(',').map(Number);
    await page.evaluate(([x, y]) => window.__holocard.setPose({ x, y }), [px, py]);
    await page.screenshot({ path: join(dumpDir, 'posed.png'), clip });
    console.log(`诊断图已写到 ${dumpDir}（${layers.length} 层 + posed.png）`);
  }

  // --dump 是「额外」导层，默认仍然录 GIF；只导层不录的话显式传 --no-gif
  if (!args['no-gif']) {
    rmSync(framesDir, { recursive: true, force: true });
    mkdirSync(framesDir, { recursive: true });

    const total = Math.round(fps * seconds);
    console.log(`录制 ${total} 帧 @ ${fps}fps`);
    for (let i = 0; i < total; i++) {
      // 指针绕卡片中心转一圈，半径再叠一个二次谐波，首尾相接能无缝循环
      const t = (i / total) * Math.PI * 2;
      const radius = 34 + 8 * Math.sin(t * 2);
      const x = 50 + radius * Math.cos(t);
      const y = 50 + radius * Math.sin(t);
      await page.evaluate(([px, py]) => window.__holocard.setPose({ x: px, y: py }), [x, y]);
      await page.screenshot({
        path: join(framesDir, `frame-${String(i).padStart(4, '0')}.png`),
        clip,
      });
    }

    // 调色板两遍编码：先按整段画面统计一份 256 色调色板，再用误差扩散抖动上色。
    // 比 ffmpeg 默认的通用调色板好很多，箔面这种细腻渐变尤其明显。
    const filter = [
      `fps=${fps}`,
      `scale=${gifWidth}:-1:flags=lanczos`,
      'split[a][b]',
      '[a]palettegen=max_colors=256:stats_mode=full[p]',
      '[b][p]paletteuse=dither=sierra2_4a',
    ].join(',');
    const result = spawnSync(
      'ffmpeg',
      [
        '-y', '-loglevel', 'error',
        '-framerate', String(fps),
        '-i', join(framesDir, 'frame-%04d.png'),
        '-filter_complex', filter.replace('split[a][b],', 'split[a][b];').replace('[p],', '[p];'),
        '-loop', '0',
        outFile,
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) throw new Error('ffmpeg 编码失败');

    const sizeMb = statSync(outFile).size / 1024 / 1024;
    console.log(`GIF 已写到 ${outFile}（${sizeMb.toFixed(1)} MB）`);
  }
} finally {
  await context.close();
}
