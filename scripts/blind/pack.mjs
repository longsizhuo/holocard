/**
 * 把两个配置各自出的卡打包成一次双盲实验：对比页 + 每一对的数据 + 另存的答案。
 *
 * 用法：
 *   node scripts/blind/pack.mjs --variant 名字=run-variant 的输出目录 --variant 名字=目录 --out 实验目录
 *                               [--focus "评审时重点看什么"] [--min-iou 0.95 --calibration 6]
 *
 *   --min-iou      只挑两版主体（抠图出的那一层）重合度低于它的对，外加主体只一版有、层结构不同的；
 *                  两版几乎一样的不用人看。只对「有主体层」的实验有意义，不给就全部都评
 *   --calibration  从几乎一样的里随机混进这么多对，打成「核对」组：评审大多选「差不多」才说明筛得靠谱
 *
 * 实验目录里：
 *   page/      对比页（发布或用静态服务打开这个目录）：index.html、blind.js/css、experiment.json、pairs/NN.json
 *   key.json   每一对的 A、B 各是哪个配置、原图名、卡片 id —— 不随页面发出去，评完用 score.mjs 解码
 * 页面数据里去掉了 manifest 的 generator（里面有模型名）。原图多半是用户的照片，实验目录别放进仓库，评完删掉。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const all = (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));
const arg = (name, fallback) => all(name)[0] ?? fallback;

const variants = all('variant').map((v) => {
  const [name, dir] = [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)];
  return { name, dir: resolve(dir) };
});
const out = arg('out');
if (variants.length !== 2 || !out || variants.some((v) => !v.name || !existsSync(join(v.dir, 'ids.tsv')))) {
  console.error('用法：node scripts/blind/pack.mjs --variant 名字=目录 --variant 名字=目录 --out 实验目录 [--focus 文字] [--min-iou 0.95 --calibration 6]');
  process.exit(1);
}
const minIou = arg('min-iou') ? Number(arg('min-iou')) : null;
const calibration = Number(arg('calibration', '0'));

const readIds = (dir) =>
  new Map(readFileSync(join(dir, 'ids.tsv'), 'utf8').trim().split('\n').map((l) => l.split('\t')));
const [va, vb] = variants.map((v) => ({ ...v, ids: readIds(v.dir) }));
const manifestOf = (v, id) => {
  const p = join(v.dir, 'layers', id, 'manifest.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

/** 主体层（有主体时是最近那层）alpha > 0.5 的像素集合的重合度 */
async function subjectIou(ma, mb, ida, idb) {
  const has = (m) => /\+subject/.test(m.generator ?? '');
  if (has(ma) !== has(mb)) return { iou: 0, why: '只有一版抠出了主体' };
  const parallax = (m) => m.layers.map((l) => l.parallax.toFixed(2)).join(',');
  if (!has(ma)) return { iou: 1, why: parallax(ma) === parallax(mb) ? '' : '层结构不一样' };
  const alpha = async (v, id, m) =>
    (await sharp(join(v.dir, 'layers', id, m.layers.at(-1).file)).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true }));
  const [a, b] = await Promise.all([alpha(va, ida, ma), alpha(vb, idb, mb)]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) return { iou: 0, why: '尺寸不一样' };
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i] > 127;
    const y = b.data[i] > 127;
    if (x && y) inter++;
    if (x || y) union++;
  }
  const iou = union ? inter / union : 1;
  const why = minIou !== null && iou < minIou ? '主体不一样' : parallax(ma) === parallax(mb) ? '' : '层结构不一样';
  return { iou, why };
}

// ---------- 配对、筛选 ----------

const rows = [];
for (const [name, ida] of va.ids) {
  const idb = vb.ids.get(name);
  const ma = manifestOf(va, ida);
  const mb = idb ? manifestOf(vb, idb) : null;
  if (!ma || !mb) continue; // 有一版没出卡，没法比
  const diff = await subjectIou(ma, mb, ida, idb);
  rows.push({ name, cards: { [va.name]: ida, [vb.name]: idb }, ...diff });
}
const shuffle = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
let picked;
if (minIou === null) {
  picked = rows.map((r) => ({ ...r, group: '全部' }));
} else {
  const differ = rows.filter((r) => r.why).map((r) => ({ ...r, group: '有差别' }));
  const same = shuffle(rows.filter((r) => !r.why)).slice(0, calibration).map((r) => ({ ...r, group: '核对' }));
  picked = [...differ, ...same];
}
picked = shuffle(picked).map((r, i) => {
  const aIs = Math.random() < 0.5 ? va.name : vb.name;
  return { no: i + 1, ...r, a: aIs, b: aIs === va.name ? vb.name : va.name };
});

// ---------- 页面 ----------

const page = resolve(out, 'page');
mkdirSync(join(page, 'pairs'), { recursive: true });
await build({ configFile: join(ROOT, 'vite.lab.config.ts'), root: ROOT, logLevel: 'error', build: { outDir: page, emptyOutDir: true } });
mkdirSync(join(page, 'pairs'), { recursive: true });
copyFileSync(join(ROOT, 'lab', 'blind', 'index.html'), join(page, 'index.html'));

for (const r of picked) {
  const pair = {};
  for (const side of ['a', 'b']) {
    const v = r[side] === va.name ? va : vb;
    const id = r.cards[v.name];
    const manifest = manifestOf(v, id);
    delete manifest.generator; // 里面有模型名
    const layers = Object.fromEntries(
      manifest.layers.map((l) => [l.file, readFileSync(join(v.dir, 'layers', id, l.file)).toString('base64')]),
    );
    pair[side] = { manifest, layers };
  }
  writeFileSync(join(page, 'pairs', `${String(r.no).padStart(2, '0')}.json`), JSON.stringify(pair));
}

const experiment = { id: randomUUID().slice(0, 8), total: picked.length, focus: arg('focus', '') };
writeFileSync(join(page, 'experiment.json'), JSON.stringify(experiment));
const key = {
  experiment: experiment.id,
  created: new Date().toISOString(),
  variants: [va.name, vb.name],
  timing: Object.fromEntries(variants.map((v) => [v.name, existsSync(join(v.dir, 'timing.json')) ? JSON.parse(readFileSync(join(v.dir, 'timing.json'), 'utf8')) : null])),
  totalPairs: rows.length,
  pairs: picked.map(({ no, name, group, a, b, iou, why, cards }) => ({ no, name, group, a, b, iou: Math.round(iou * 1000) / 1000, why, cards })),
};
writeFileSync(resolve(out, 'key.json'), JSON.stringify(key, null, 1));

const groups = picked.reduce((m, r) => ({ ...m, [r.group]: (m[r.group] ?? 0) + 1 }), {});
console.log(`[pack] 实验 ${experiment.id}：共 ${rows.length} 对可比，要评 ${picked.length} 对 ${JSON.stringify(groups)}`);
console.log(`[pack] 页面 ${page}，答案 ${resolve(out, 'key.json')}（别和页面一起发出去）`);
