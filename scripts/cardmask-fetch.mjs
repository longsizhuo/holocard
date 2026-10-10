/**
 * 下载卡面遮罩的评测集到 .cardmask/data/（不进仓库：卡图和遮罩的版权归各家，只在本地评测用）
 *
 * 三个来源，各自带一种「标准答案」：
 *   pokemon  pokemon-cards-css 的卡单（public/data/cards.json）：卡图来自 pokemontcg.io，
 *            官方箔面遮罩来自作者的 CDN（poke-holo.b-cdn.net），地址规则照抄他的 CardProxy.svelte。
 *            遮罩是「这种稀有度哪里闪」：普通闪卡（swholo）= 画框减主角，反闪（reverse）= 画框以外
 *   mtg      Scryfall：全卡 png 和单独的画（art_crop），画在全卡里的位置就是画框
 *   ygo      YGOPRODeck：全卡和裁好的画（image_url_cropped），同上
 *
 * 用法：node scripts/cardmask-fetch.mjs [--per-source 20] [--split dev|holdout]
 *   --split holdout  另下一批没用来调参数的卡（宝可梦取卡单后面的、游戏王换一段、万智牌照旧随机），
 *                    评测时单独报分，检查规则是不是只适合调参的那批
 * 已经下过的文件跳过，可以反复跑。写 .cardmask/data/index.json，评测脚本（cardmask-eval.ts）读它
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, '.cardmask', 'data');
const argv = process.argv.slice(2);
const PER_SOURCE = Number(argv[argv.indexOf('--per-source') + 1] || 20);
const SPLIT = argv.includes('--split') ? argv[argv.indexOf('--split') + 1] : 'dev';
const HOLDOUT = SPLIT === 'holdout';
const UA = 'HoloCard-cardmask-eval/0.1 (+https://github.com/longsizhuo/holocard)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(DATA, { recursive: true });

async function download(url, file) {
  if (existsSync(file)) return true;
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' } });
  if (!res.ok) return false;
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return true;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

/** 照抄 pokemon-cards-css 的 foilMaskImage：按稀有度定遮罩文件名。闪图、异画、促销卡另有规则，这里直接不收 */
function pokemonMaskUrl(card) {
  const rarity = card.rarity.toLowerCase();
  let etch = 'holo';
  let style = 'reverse';
  if (rarity === 'rare holo') style = 'swholo';
  if (rarity === 'rare holo cosmos') style = 'cosmos';
  if (rarity === 'radiant rare') [etch, style] = ['etched', 'radiantholo'];
  if (['rare holo v', 'rare holo vunion', 'basic v'].includes(rarity)) [etch, style] = ['holo', 'sunpillar'];
  if (['rare holo vmax', 'rare ultra', 'rare holo vstar'].includes(rarity)) [etch, style] = ['etched', 'sunpillar'];
  if (['amazing rare', 'rare rainbow', 'rare secret'].includes(rarity)) [etch, style] = ['etched', 'swsecret'];
  const number = card.number.toLowerCase().replace('swsh', '').padStart(3, '0');
  const set = card.set.toLowerCase().replace(/(tg|gg|sv)/, '');
  return { url: `https://poke-holo.b-cdn.net/foils/${set}/masks/upscaled/${number}_foil_${etch}_${style}_2x.webp`, style };
}

const indexFile = join(DATA, 'index.json');
const previous = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : [];
const existing = new Set(previous.map((e) => e.id));
const index = [];

// ---------- 宝可梦 ----------
{
  const cards = await getJson('https://raw.githubusercontent.com/simeydotme/pokemon-cards-css/main/public/data/cards.json');
  let taken = 0;
  for (const card of cards) {
    if (taken >= PER_SOURCE) break;
    // 闪图（rare shiny）、训练家画廊（tg/gg）、编号带 sv 的走别的遮罩规则
    if (/shiny/i.test(card.rarity) || /(tg|gg)/i.test(card.set) || /^sv/i.test(card.number)) continue;
    // 留出集跳过调参用过的卡
    if (HOLDOUT && existing.has(`pokemon-${card.id}`)) continue;
    const { url, style } = pokemonMaskUrl(card);
    const id = `pokemon-${card.id}`;
    const cardFile = join(DATA, `${id}-card.png`);
    const maskFile = join(DATA, `${id}-mask.webp`);
    if (!(await download(url, maskFile))) continue;
    if (!(await download(card.images.large, cardFile))) continue;
    index.push({ id, source: 'pokemon', name: card.name, rarity: card.rarity, style, card: `${id}-card.png`, mask: `${id}-mask.webp` });
    taken++;
  }
  console.log(`宝可梦 ${taken} 张`);
}

// ---------- 万智牌 ----------
{
  // 几种常见的边框都要有：老框、现代框、新框
  const queries = ['frame:1997 is:hires', 'frame:2003 is:hires', 'frame:2015 is:hires -is:fullart -is:borderless'];
  let taken = 0;
  for (let i = 0; taken < PER_SOURCE && i < PER_SOURCE * 3; i++) {
    const card = await getJson(`https://api.scryfall.com/cards/random?q=${encodeURIComponent(queries[i % queries.length])}`);
    await sleep(120); // Scryfall 要求每秒不超过 10 个请求
    const uris = card.image_uris;
    if (!uris?.png || !uris?.art_crop) continue; // 双面卡的图在 card_faces 里，跳过
    const id = `mtg-${card.id.slice(0, 8)}`;
    if (index.some((e) => e.id === id) || (HOLDOUT && existing.has(id))) continue;
    if (!(await download(uris.png, join(DATA, `${id}-card.png`)))) continue;
    if (!(await download(uris.art_crop, join(DATA, `${id}-art.jpg`)))) continue;
    await sleep(120);
    index.push({ id, source: 'mtg', name: card.name, frame: card.frame, card: `${id}-card.png`, art: `${id}-art.jpg` });
    taken++;
  }
  console.log(`万智牌 ${taken} 张`);
}

// ---------- 游戏王 ----------
{
  const types = ['Normal Monster', 'Effect Monster', 'Spell Card', 'Trap Card', 'Fusion Monster', 'Synchro Monster'];
  let taken = 0;
  for (const type of types) {
    const { data } = await getJson(
      `https://db.ygoprodeck.com/api/v7/cardinfo.php?type=${encodeURIComponent(type)}&num=${Math.ceil(PER_SOURCE / types.length)}&offset=${HOLDOUT ? 200 : 40}`,
    );
    for (const card of data) {
      if (taken >= PER_SOURCE) break;
      const image = card.card_images?.[0];
      if (!image) continue;
      const id = `ygo-${card.id}`;
      if (HOLDOUT && existing.has(id)) continue;
      if (!(await download(image.image_url, join(DATA, `${id}-card.jpg`)))) continue;
      if (!(await download(image.image_url_cropped, join(DATA, `${id}-art.jpg`)))) continue;
      await sleep(100); // YGOPRODeck 限每秒 20 个
      index.push({ id, source: 'ygo', name: card.name, type, card: `${id}-card.jpg`, art: `${id}-art.jpg` });
      taken++;
    }
  }
  console.log(`游戏王 ${taken} 张`);
}

// 合并旧的 index：之前下过、这次随机没抽到的也留着
for (const entry of index) entry.split = previous.find((e) => e.id === entry.id)?.split ?? SPLIT;
const merged = [...previous.filter((e) => !index.some((n) => n.id === e.id)), ...index];
writeFileSync(indexFile, JSON.stringify(merged, null, 2));
console.log(`共 ${merged.length} 张，写在 ${indexFile}`);
