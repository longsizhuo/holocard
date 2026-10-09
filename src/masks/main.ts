/**
 * 卡面遮罩页（masks.html）：上传做好的平面卡图 → 服务端出边框、主角、特效、文字四张遮罩（server/pipeline/cardmask.ts）
 * → 在这里勾选哪些区域上箔，用渲染器实时预览，遮罩可以单独下载，也可以下载当前组合。
 *
 * 预览是两层的 LayerSet：底层是整张卡（不上箔），上层是同一张卡、alpha 取勾选区域的并集、上选中的箔面。
 * 视差关掉：实体卡是平的，这里要看的是箔面落在哪
 */

import '../demo/style.css';
import '../demo/pearl-drift.css';
import './masks.css';
import { HoloCard } from '../renderer/card';
import { defaultHalo, type FoilType, type LayerSet } from '../format/types';
import { applyTranslations, lang, onLangChange, setLang, t, type Lang, type MessageKey } from '../i18n';

const BASE = import.meta.env.BASE_URL;
const POLL_MS = 1500;

/** 预览里能勾选的区域。frame 不含文字，文字单独一项 */
const REGIONS = ['frame', 'text', 'background', 'character', 'effects'] as const;
type Region = (typeof REGIONS)[number];
/** 服务端给的文件 */
const FILES = ['frame', 'character', 'effects', 'text'] as const;
type MaskFile = (typeof FILES)[number];

function need<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`页面上缺少 ${selector}`);
  return el;
}

const fileInput = need<HTMLInputElement>('#masks-file');
const status = need<HTMLParagraphElement>('#masks-status');
const result = need<HTMLElement>('#masks-result');
const grid = need<HTMLDivElement>('#masks-grid');
const foilSelect = need<HTMLSelectElement>('#masks-foil');
const comboButton = need<HTMLButtonElement>('#masks-combo');
const regionInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="region"]')];
const docsLink = need<HTMLAnchorElement>('#docs-link');

let card: HoloCard | null = null;
/** 当前这组的像素：卡图 RGBA，和各遮罩的灰度 */
let current: { id: string; width: number; height: number; rgba: Uint8ClampedArray; masks: Record<MaskFile, Uint8ClampedArray> } | null = null;

// ---------- 语言 ----------

function syncDocsLink(l: Lang): void {
  docsLink.href = `${BASE}docs/${l === 'zh' ? '' : `${l}/`}`;
}
applyTranslations();
syncDocsLink(lang());
for (const button of document.querySelectorAll<HTMLButtonElement>('.lang [data-lang]')) {
  button.setAttribute('aria-pressed', String(button.dataset['lang'] === lang()));
  button.addEventListener('click', () => {
    const next = button.dataset['lang'];
    if (next === 'zh' || next === 'en' || next === 'ja') setLang(next);
  });
}
onLangChange((l) => {
  syncDocsLink(l);
  for (const button of document.querySelectorAll<HTMLButtonElement>('.lang [data-lang]')) {
    button.setAttribute('aria-pressed', String(button.dataset['lang'] === l));
  }
  if (current) renderGrid(current.id);
});

// ---------- 和服务端说话 ----------

/** 服务端的错误按 code 翻译；不认识的照原文 */
async function describe(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; params?: Record<string, string | number> };
  const key = `error.${body.code ?? ''}` as MessageKey;
  const translated = t(key, body.params);
  return translated !== key ? translated : (body.error ?? `HTTP ${res.status}`);
}

function setStatus(text: string): void {
  status.textContent = text;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function upload(file: File): Promise<void> {
  fileInput.disabled = true;
  result.hidden = true;
  setStatus(t('masks.working'));
  try {
    const res = await fetch(`${BASE}api/cardmask`, { method: 'POST', body: file, headers: { 'x-holocard-lang': lang() } });
    if (!res.ok) throw new Error(await describe(res));
    const { id } = (await res.json()) as { id: string };
    for (;;) {
      await sleep(POLL_MS);
      const poll = await fetch(`${BASE}api/cardmask/${id}`);
      if (!poll.ok) throw new Error(await describe(poll));
      const job = (await poll.json()) as { state: string; error?: string; width?: number; height?: number };
      if (job.state === 'error') throw new Error(job.error ?? '');
      if (job.state === 'done') {
        await show(id);
        setStatus('');
        return;
      }
    }
  } catch (error) {
    const message = error instanceof TypeError ? t('error.network') : error instanceof Error ? error.message : String(error);
    setStatus(t('masks.failed', { message }));
  } finally {
    fileInput.disabled = false;
    fileInput.value = '';
  }
}

async function pixels(url: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await describe(res));
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.drawImage(bitmap, 0, 0);
  return { data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data, width: bitmap.width, height: bitmap.height };
}

async function show(id: string): Promise<void> {
  const base = `${BASE}api/cardmask/${id}`;
  const cardPixels = await pixels(`${base}/card.png`);
  const masks = {} as Record<MaskFile, Uint8ClampedArray>;
  for (const name of FILES) masks[name] = (await pixels(`${base}/${name}.png`)).data;
  current = { id, width: cardPixels.width, height: cardPixels.height, rgba: cardPixels.data, masks };
  result.hidden = false;
  renderGrid(id);
  await renderPreview();
}

// ---------- 遮罩列表 ----------

function renderGrid(id: string): void {
  const base = `${BASE}api/cardmask/${id}`;
  const caption: Record<MaskFile, MessageKey> = {
    frame: 'masks.file.frame',
    character: 'masks.region.character',
    effects: 'masks.region.effects',
    text: 'masks.region.text',
  };
  grid.replaceChildren(
    ...FILES.map((name) => {
      const figure = document.createElement('figure');
      const img = Object.assign(document.createElement('img'), { src: `${base}/${name}.png`, alt: t(caption[name]), loading: 'lazy' });
      const label = Object.assign(document.createElement('figcaption'), { textContent: t(caption[name]) });
      const link = Object.assign(document.createElement('a'), {
        href: `${base}/${name}.png?download=1`,
        textContent: t('masks.download'),
        className: 'masks__button',
      });
      figure.append(img, label, link);
      return figure;
    }),
  );
}

// ---------- 预览 ----------

/** 每个像素属于哪几个区域：文字优先于边框；主角、特效哪儿都可能有；剩下的是背景 */
function combined(selected: Set<Region>): Uint8ClampedArray {
  const { masks, width, height } = current!;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    const text = (masks.text[p] ?? 0) > 127;
    const frame = (masks.frame[p] ?? 0) > 127 && !text;
    const character = (masks.character[p] ?? 0) > 127;
    const effects = (masks.effects[p] ?? 0) > 127 && !character;
    const background = !text && !frame && !character && !effects;
    const on =
      (text && selected.has('text')) ||
      (frame && selected.has('frame')) ||
      (character && !text && selected.has('character')) ||
      (effects && !text && selected.has('effects')) ||
      (background && selected.has('background'));
    out[i] = on ? 255 : 0;
  }
  return out;
}

function selectedRegions(): Set<Region> {
  return new Set(regionInputs.filter((input) => input.checked).map((input) => input.value as Region));
}

async function toPng(rgba: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function renderPreview(): Promise<void> {
  if (!current) return;
  const { width, height, rgba } = current;
  const alpha = combined(selectedRegions());
  const top = new Uint8ClampedArray(rgba);
  for (let i = 0; i < alpha.length; i++) top[i * 4 + 3] = alpha[i] ?? 0;
  const foil = foilSelect.value as FoilType;
  const layer = (file: string, type: FoilType) => ({
    file,
    depth: 0,
    parallax: 0,
    bbox: [0, 0, width, height] as const,
    inpainted: true,
    foil: { type, intensity: 1 },
  });
  const set: LayerSet = {
    manifest: {
      version: 1,
      source: { width, height },
      layers: [layer('layer-0.png', 'none'), layer('layer-1.png', foil)],
      effects: { halo: defaultHalo(), glare: true, parallax: { enabled: false, amplitude: 0 } },
      generator: 'holocard-masks',
    },
    images: [await toPng(rgba, width, height), await toPng(top, width, height)],
  };
  card ??= new HoloCard(need<HTMLDivElement>('#masks-card'), { amplitude: 0 });
  card.setLayerSet(set);
}

async function downloadCombo(): Promise<void> {
  if (!current) return;
  const { width, height, id } = current;
  const alpha = combined(selectedRegions());
  const gray = new Uint8ClampedArray(width * height * 4);
  // 和服务端出的遮罩一样：亮度和 alpha 都是遮罩值，CSS 的 mask-image 按哪种用都对
  for (let i = 0; i < alpha.length; i++) gray.set([alpha[i]!, alpha[i]!, alpha[i]!, alpha[i]!], i * 4);
  const url = URL.createObjectURL(await toPng(gray, width, height));
  const link = Object.assign(document.createElement('a'), { href: url, download: `holocard-${id.slice(0, 8)}-mask.png` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void upload(file);
});
for (const input of regionInputs) input.addEventListener('change', () => void renderPreview());
foilSelect.addEventListener('change', () => void renderPreview());
comboButton.addEventListener('click', () => void downloadCombo());
