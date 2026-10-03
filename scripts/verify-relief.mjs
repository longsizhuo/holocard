/**
 * 验证浮雕和整层视差是同一个深度场（src/renderer/relief.ts）
 *
 * 用户反馈过「要么看不出来、要么很假」，根子在层内浮雕和整层平移用的是两套单位、接不上。核对：
 *   - 连续：任意深度 d 的像素，不管落在哪一层，总位移 =（整层视差 − 焦平面）+ perDepth·(d − 本层参考深度）都一样
 *   - 刚体：各层视差全相同（整张图是一个刚体）时 perDepth 为 0，不做视差也不做浮雕
 *   - 补洞：某层深度区间外的网格顶点由邻居补，区间内的不动
 *
 * 用法：node scripts/verify-relief.mjs（Node 22.15+：直接吃 .ts，且要有 module.registerHooks）
 */

import assert from 'node:assert/strict';

const { layerGrid, reliefLayers } = await import('../src/renderer/relief.ts');

// 三层、前两层是一组刚体（视差相同），和用户那张卡的结构一样
const layers = [
  { depth: 0.07, parallax: 0 },
  { depth: 0.59, parallax: 0 },
  { depth: 0.8, parallax: 1 },
];
const r = reliefLayers(layers);
const focus = 0.5; // 视差 0 和 1 的中点
const total = (i, d) => layers[i].parallax - focus + r.perDepth * (d - r.layers[i].ref);
for (const d of [0, 0.1, 0.5, 0.9, 1]) {
  const t = layers.map((_, i) => total(i, d));
  assert.ok(t.every((v) => Math.abs(v - t[0]) < 1e-9), `深度 ${d} 在各层的总位移不一样：${t}`);
}
assert.ok(r.perDepth > 0, 'perDepth 应为正');

assert.equal(reliefLayers([{ depth: 0.2, parallax: 0 }, { depth: 0.8, parallax: 0 }]).perDepth, 0);

const w = 130;
const h = 130;
const data = new Float32Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = x < w / 2 ? 0.2 : 0.9;
const grid = layerGrid({ data, width: w, height: h }, 0, 0.5, 0.3);
assert.ok(grid.every((v) => Math.abs(v - 0.2) < 1e-6), '区间外的顶点应补成邻居的 0.2');

console.log('relief ok');
