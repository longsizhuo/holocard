/**
 * 用某个配置把一批原图各出一张卡：起一个临时分层服务，逐张提交，等全部做完，记下每张图对应哪张卡。
 *
 * 用法：
 *   node scripts/blind/run-variant.mjs --in 原图目录 --out 输出目录 [--port 8781] [--server dist-server/holocard-server.mjs]
 * 要比的那个配置用环境变量传给服务，比如抠图换 512 版：
 *   HOLOCARD_MATTE_MODEL=onnx-community/BiRefNet_512x512-ONNX HOLOCARD_MATTE_SIZE=512 HOLOCARD_MATTE_DTYPE=q8 node scripts/blind/run-variant.mjs ...
 *
 * 输出目录里：layers/<卡片 id>/（和线上同样的层文件）、data/（临时库）、ids.tsv（原图名 → 卡片 id）、timing.json。
 * 服务以最低优先级跑（nice 19），和线上同机也不抢 CPU；两个配置要先后跑，同时跑内存会叠加。
 * 原图多半是用户的照片：输出目录别放进仓库，用完删掉。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const input = arg('in');
const out = arg('out');
if (!input || !out) {
  console.error('用法：node scripts/blind/run-variant.mjs --in 原图目录 --out 输出目录 [--port 8781] [--server dist-server/holocard-server.mjs]');
  process.exit(1);
}
const port = Number(arg('port', '8781'));
const server = resolve(arg('server', 'dist-server/holocard-server.mjs'));
const base = `http://127.0.0.1:${port}`;
mkdirSync(join(out, 'layers'), { recursive: true });
mkdirSync(join(out, 'data'), { recursive: true });

const child = spawn('nice', ['-n', '19', process.execPath, server], {
  env: {
    ...process.env,
    HOLOCARD_PORT: String(port),
    HOLOCARD_OUT_DIR: resolve(out, 'layers'),
    HOLOCARD_DB: resolve(out, 'data', 'holocard.db'),
    // 本机逐张提交，不受线上那套限流和队列上限管
    HOLOCARD_RATE_LIMIT: '100000',
    HOLOCARD_MAX_QUEUE: '100000',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const stop = () => child.kill('SIGTERM');
process.on('SIGINT', () => {
  stop();
  process.exit(130);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async () => {
  try {
    const res = await fetch(`${base}/api/health`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

try {
  // 等服务起来、模型预加载完（分层线程启动就加载），免得第一张的耗时里带着加载
  for (let i = 0; !(await health()); i++) {
    if (i > 60) throw new Error('临时服务 60 秒内没起来');
    await sleep(1000);
  }
  await sleep(20000);

  const files = readdirSync(input).filter((f) => /\.(jpe?g|png|webp|avif|heic)$/i.test(f)).sort();
  const ids = [];
  const t0 = Date.now();
  for (const f of files) {
    const res = await fetch(`${base}/api/jobs`, { method: 'POST', body: readFileSync(join(input, f)) });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.id) ids.push([basename(f), body.id]);
    else console.warn(`[run-variant] ${f} 提交失败：HTTP ${res.status} ${body.message ?? ''}`);
  }
  for (;;) {
    const h = await health();
    if (h && h.running + h.queued === 0) break;
    await sleep(5000);
  }
  const seconds = (Date.now() - t0) / 1000;
  writeFileSync(join(out, 'ids.tsv'), ids.map((row) => row.join('\t')).join('\n') + '\n');
  const timing = { images: ids.length, seconds: Math.round(seconds), perImage: Math.round((seconds / Math.max(1, ids.length)) * 10) / 10, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('HOLOCARD_MATTE'))) };
  writeFileSync(join(out, 'timing.json'), JSON.stringify(timing, null, 1));
  console.log(`[run-variant] ${ids.length} 张，共 ${timing.seconds} 秒，平均每张 ${timing.perImage} 秒 → ${out}`);
} finally {
  stop();
}
