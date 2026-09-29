/**
 * 把开包音效离线渲染成 wav：每个声音一个文件，外加一条按开包顺序排好的试听（reel.wav）。
 * 顺带检查每个声音有声、没爆音（峰值 < 1）。改了 src/demo/sfx.ts 的配方之后跑一遍，听一听。
 *
 * 配方就是页面里用的那份：从开发服务器上把 sfx.ts 动态 import 进来，用 OfflineAudioContext 渲染。
 * 用法：先起站点（pnpm dev），然后
 *   node scripts/render-sfx.mjs [--url http://127.0.0.1:5273/] [--out /tmp/sfx]
 */

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const url = arg('url', 'http://127.0.0.1:5273/');
const out = arg('out', '/tmp/sfx');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(url);

const results = await page.evaluate(async () => {
  const { recipes, tearSound, masterBus } = await import('/src/demo/sfx.ts');
  const rate = 44100;

  /** 渲染一段，返回 16 位 PCM wav（base64）和峰值、响度 */
  async function render(seconds, build) {
    const c = new OfflineAudioContext(1, Math.round(rate * seconds), rate);
    build(c, masterBus(c));
    const data = (await c.startRendering()).getChannelData(0);
    let peak = 0, sum = 0;
    for (const v of data) {
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
    }
    const wav = new DataView(new ArrayBuffer(44 + data.length * 2));
    const text = (at, s) => [...s].forEach((ch, i) => wav.setUint8(at + i, ch.charCodeAt(0)));
    text(0, 'RIFF');
    wav.setUint32(4, 36 + data.length * 2, true);
    text(8, 'WAVEfmt ');
    wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true);
    wav.setUint16(22, 1, true);
    wav.setUint32(24, rate, true);
    wav.setUint32(28, rate * 2, true);
    wav.setUint16(32, 2, true);
    wav.setUint16(34, 16, true);
    text(36, 'data');
    wav.setUint32(40, data.length * 2, true);
    data.forEach((v, i) => wav.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
    let binary = '';
    const bytes = new Uint8Array(wav.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { wav: btoa(binary), peak, rms: Math.sqrt(sum / data.length) };
  }

  /** 撕：手指 0.6 秒划过去，先慢后快 */
  function tear(c, out, t) {
    const sound = tearSound(c, out);
    for (let i = 0; i <= 36; i++) sound.move(0.8 + (i / 36) * 2, i / 36, t + i / 60);
    sound.stop(t + 0.62);
  }

  const all = { tear, ...recipes };
  const result = {};
  for (const [name, recipe] of Object.entries(all)) result[name] = await render(1.6, (c, out) => recipe(c, out, 0.02));
  // 试听：按开包的顺序排——做好了、撕、扯下来、卡滑出、转圈；再来一包点开：抖、炸、转圈；最后是没做好时点一下
  const reel = [
    ['ready', 0.1], ['tear', 1.2], ['rip', 1.82], ['slide', 1.94], ['spin', 3.05],
    ['shake', 5.2], ['burst', 5.65], ['spin', 5.8], ['nudge', 7.6],
  ];
  result.reel = await render(8.2, (c, out) => reel.forEach(([name, at]) => all[name](c, out, at)));
  return result;
});
await browser.close();

let failures = 0;
for (const [name, { wav, peak, rms }] of Object.entries(results)) {
  writeFileSync(join(out, `${name}.wav`), Buffer.from(wav, 'base64'));
  const ok = peak > 0.02 && peak < 1;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(6)} 峰值 ${peak.toFixed(3)}  响度(RMS) ${rms.toFixed(4)}`);
}
console.log(failures ? `\n${failures} 个声音不对（无声或爆音），wav 在 ${out}` : `\n都正常，wav 在 ${out}（reel.wav 是整条试听）`);
process.exit(failures ? 1 : 0);
