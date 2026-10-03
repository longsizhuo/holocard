/**
 * 验证作者配置的校验与合并（src/format/config.ts）
 *
 * 这份校验挡在服务端的 PUT /api/cards/:id/config 前面，客户端发什么都可能，所以核对：
 *   - 合法配置原样收下，合并进 manifest 后其余字段不动
 *   - 层数对不上、箔面类型不认识、数值越界、多带字段想改文件名，一律拒收或忽略
 *
 * 用法：node scripts/verify-config.mjs（Node 22.15+：直接吃 .ts，且要有 module.registerHooks）
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// 源码里 import 不带扩展名（给 Vite / tsc 用的写法），Node 直接跑 .ts 时补上
registerHooks({
  resolve: (specifier, context, next) =>
    /^\.\.?\/(?:.*\/)?[^./]+$/.test(specifier) && context.parentURL?.endsWith('.ts')
      ? next(`${specifier}.ts`, context)
      : next(specifier, context),
});
const { applyConfig, configOf, parseConfig } = await import('../src/format/config.ts');

const manifest = () => ({
  version: 1,
  source: { width: 100, height: 150 },
  layers: [
    { file: 'layer-0.webp', depth: 0, parallax: 0, bbox: [0, 0, 100, 150], inpainted: true, foil: { type: 'sunpillar', intensity: 1 } },
    { file: 'layer-1.webp', depth: 1, parallax: 1, bbox: [0, 0, 100, 150], inpainted: false, foil: { type: 'none', intensity: 1 } },
  ],
  effects: { halo: { intensity: 0.35, light: { peakAt: [0.7, -0.7], sharpness: 120 } }, glare: true },
});

const good = {
  foils: [{ type: 'rainbow', intensity: 0.5 }, { type: 'holo', intensity: 0 }],
  halo: { intensity: 1, sharpness: 400 },
  parallax: { enabled: false, amplitude: 0.16 },
};

// 合法的收下，合并后只动该动的
const parsed = parseConfig(good, 2);
assert.deepEqual(parsed, good);
const m = manifest();
applyConfig(m, parsed);
assert.deepEqual(m.layers.map((l) => l.foil), good.foils);
assert.equal(m.layers[0].file, 'layer-0.webp');
assert.deepEqual(m.effects.halo, { intensity: 1, light: { peakAt: [0.7, -0.7], sharpness: 400 } });
assert.deepEqual(m.effects.parallax, good.parallax);
assert.deepEqual(configOf(m, good.parallax), good);

// 存量 manifest 里有越界值时，取出来的配置也能过校验（不然主人一打开卡就存不上）
const odd = manifest();
odd.layers[0].foil.intensity = 1.5;
odd.effects.halo = { intensity: -0.2, light: { peakAt: [0.7, -0.7], sharpness: 999 } };
assert.notEqual(parseConfig(configOf(odd, { enabled: true, amplitude: 0.3 }), 2), null);

// 多带的字段不会进 manifest
const sneaky = parseConfig({ ...good, foils: good.foils.map((f) => ({ ...f, file: '../../etc/passwd' })) }, 2);
const m2 = manifest();
applyConfig(m2, sneaky);
assert.equal(m2.layers[0].file, 'layer-0.webp');
assert.equal('file' in m2.layers[0].foil, false);

// 一律拒收
const bad = [
  null,
  'x',
  { ...good, foils: good.foils.slice(1) },
  { ...good, foils: [{ type: 'gold', intensity: 1 }, good.foils[1]] },
  { ...good, foils: [{ type: 'holo', intensity: 1.1 }, good.foils[1]] },
  { ...good, foils: [{ type: 'holo', intensity: NaN }, good.foils[1]] },
  { ...good, halo: { intensity: 0.5, sharpness: 5 } },
  { ...good, halo: undefined },
  { ...good, parallax: { enabled: 'yes', amplitude: 0.1 } },
  { ...good, parallax: { enabled: true, amplitude: 0.5 } },
  { ...good, parallax: undefined },
];
for (const raw of bad) assert.equal(parseConfig(raw, 2), null, `应当拒收：${JSON.stringify(raw)}`);

console.log('config ok');
