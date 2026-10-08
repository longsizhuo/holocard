/**
 * 把早期的卡（层图还是 PNG）转成 WebP。
 *
 * 2026-09 下旬以前做的卡，每层是 PNG，四层加起来十来 MB，手机上卡片页要白屏很久才出来；
 * 后来的卡存盘时就转成了 WebP（画面有损、alpha 无损，体积约一成，见 server/images.ts 的 layerToWebp），这里用同样的参数补转。
 *
 * 用法（以 ubuntu 跑，产物目录默认 /srv/holocard-layers）：
 *   node scripts/webp-layers.mjs              只列出要转的卡，不动文件
 *   node scripts/webp-layers.mjs --apply      转：写 layer-N.webp，再原子替换 manifest.json；PNG 先留着
 *   node scripts/webp-layers.mjs --cleanup    删掉 manifest 已经不引用的 layer-N.png。
 *                                            manifest 在 Cloudflare 只缓存 60 秒，--apply 之后过几分钟再跑
 */

import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const OUT_DIR = process.env.HOLOCARD_OUT_DIR ?? '/srv/holocard-layers';
const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--cleanup') ? 'cleanup' : 'list';
const UUID = /^[0-9a-f-]{36}$/;

let cards = 0;
let before = 0;
let after = 0;
for (const id of (await readdir(OUT_DIR)).filter((name) => UUID.test(name))) {
  const dir = join(OUT_DIR, id);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    continue; // 还没做完、做失败的卡没有清单
  }

  if (mode === 'cleanup') {
    const used = new Set(manifest.layers.map((layer) => layer.file));
    for (const name of await readdir(dir)) {
      if (/^layer-\d+\.png$/.test(name) && !used.has(name)) {
        before += (await stat(join(dir, name))).size;
        await rm(join(dir, name));
        console.log(`删 ${id}/${name}`);
      }
    }
    continue;
  }

  const png = manifest.layers.filter((layer) => layer.file.endsWith('.png'));
  if (!png.length) continue;
  cards++;
  for (const layer of png) {
    const size = (await stat(join(dir, layer.file))).size;
    before += size;
    if (mode === 'list') continue;
    const webpName = layer.file.replace(/\.png$/, '.webp');
    const webp = await sharp(await readFile(join(dir, layer.file))).webp({ quality: 88, alphaQuality: 100, effort: 4 }).toBuffer();
    // 先写临时文件再改名：页面可能正在读
    await writeFile(join(dir, `${webpName}.tmp`), webp);
    await rename(join(dir, `${webpName}.tmp`), join(dir, webpName));
    after += webp.length;
    layer.file = webpName;
  }
  if (mode === 'apply') {
    const tmp = join(dir, 'manifest.json.webp-layers.tmp');
    await writeFile(tmp, JSON.stringify(manifest));
    await rename(tmp, join(dir, 'manifest.json'));
  }
  console.log(`${mode === 'apply' ? '转了' : '要转'} ${id}：${png.length} 层`);
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
if (mode === 'list') console.log(`共 ${cards} 张卡要转，PNG ${mb(before)}。加 --apply 才动文件`);
if (mode === 'apply') console.log(`转了 ${cards} 张：${mb(before)} → ${mb(after)}。过几分钟再跑 --cleanup 删 PNG`);
if (mode === 'cleanup') console.log(`删了 ${mb(before)} 的旧 PNG`);
