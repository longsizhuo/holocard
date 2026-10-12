/**
 * 渲染页 /render/<id>：服务端用无头浏览器打开它截分享图（server/render/preview.ts）、逐帧导出动图（server/render/export.ts）。
 * 只留卡片，固定姿态，不带任何 UI
 */

import { ensureTextures } from '../../src/renderer/textures';
import type { HoloCard } from '../../src/renderer/card';
import { lang, t } from '../../src/i18n';

/**
 * 导出动图时渲染页的版式（服务端 export.ts 用）：
 *   phone    手机竖屏、深色底，给动态照片和 GIF
 *   sticker  只有卡片、透明底，给电脑上下载的 APNG
 * 不带这个参数就是分享图的版式。
 */
export type ExportLayout = 'phone' | 'sticker';

export function renderExportLayout(): ExportLayout | null {
  const value = new URLSearchParams(location.search).get('export');
  return value === 'phone' || value === 'sticker' ? value : null;
}

/**
 * 渲染页的深色底。背景用这张卡自己的画面糊开当色调（具体叠法见 style.css 里 .render-bg 的注释），
 * 复用已经加载好的层图片，不额外发请求。分享图和导出的竖屏动图共用。
 */
function buildRenderBackground(): void {
  const bg = document.createElement('div');
  bg.className = 'render-bg';
  for (const img of document.querySelectorAll<HTMLImageElement>('.hc__art')) {
    const clone = document.createElement('img');
    clone.src = img.src;
    clone.alt = '';
    bg.append(clone);
  }
  document.body.append(bg);
}

/**
 * 给 OG 图补上右侧文案，按渲染页地址上的 ?lang 出对应语言。
 *
 * 1200×630 的横图配竖卡片，直接居中会剩两大片空白，所以排成左卡片右文案。
 */
function buildRenderCopy(): void {
  const copy = document.createElement('div');
  copy.className = 'render-copy';

  const headline = document.createElement('h2');
  headline.innerHTML = t('og.headlineHtml');

  /*
   * 「前中后」三个字本身摆成三层：前最大最近，依次往右后方退，
   * 每一个都被前一个盖住左边三分之一。一眼就能看懂「分层」，不用读说明。
   * 三个字的质感也对应默认的上箔方式：最近层哑光（白），中间 holo，最远 sunpillar。
   * 英文是三个单词，宽度不是方块字那样一个字号见方，改用行内排版、互相压一角（见 style.css）。
   */
  const depth = document.createElement('div');
  depth.className = lang() === 'en' ? 'depth depth--words' : 'depth';
  depth.setAttribute('role', 'img');
  depth.setAttribute('aria-label', t('og.depthLabel'));
  const glyph = (which: 'front' | 'mid' | 'back'): HTMLSpanElement => {
    const span = document.createElement('span');
    span.className = `depth__g depth__g--${which}`;
    span.textContent = t(`og.${which}`);
    return span;
  };
  // 方块字按绝对定位摆，DOM 顺序无所谓；单词走行内排版，得按从前到后的顺序排
  depth.append(
    ...(lang() === 'en'
      ? [glyph('front'), glyph('mid'), glyph('back')]
      : [glyph('back'), glyph('mid'), glyph('front')]),
  );

  const body = document.createElement('p');
  body.textContent = t('og.body');

  const url = document.createElement('span');
  url.className = 'render-url';
  url.textContent = 'holocard.longsizhuo.com';

  copy.append(headline, depth, body, url);
  document.querySelector('.page__body')?.append(copy);
}

/**
 * 分享图里卡片摆的姿态：指针落在卡面上的百分比位置。
 * 默认 (78, 22) 是贴着炫光峰值挑的角度，箔面和炫光都亮；
 * 调试时可以用 ?pose=x,y 换一个角度看（scripts/og-preview.ts 的 --pose 就是走这个）。
 */
function renderPose(): { x: number; y: number } {
  const m = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(
    new URLSearchParams(location.search).get('pose') ?? '',
  );
  const clamp = (v: number): number => Math.min(100, Math.max(0, v));
  return m ? { x: clamp(Number(m[1])), y: clamp(Number(m[2])) } : { x: 78, y: 22 };
}

/**
 * 箔面纹理是现算的，还要等它解码。截图前不等的话，头几帧的箔面没有颗粒和闪粉。
 * 以前截分享图靠固定等 250ms 碰运气，导出动图第一帧就是封面，不能碰运气。
 */
async function preloadTextures(): Promise<void> {
  try {
    const { grain, glitter } = await ensureTextures();
    await Promise.all(
      [grain, glitter].map((src) => {
        const img = new Image();
        img.src = src;
        return img.decode().catch(() => undefined);
      }),
    );
  } catch {
    // 生成不了纹理的环境里箔面退化成纯渐变，照样能截
  }
}

/**
 * 给服务端逐帧导出用的两个钩子（server/render/export.ts）：
 *   __hcExportPose   摆一个姿态
 *   __hcExportLayer  竖屏导出分两遍截——背景是静的只截一次，卡片每帧截、透明底，
 *                    最后由 ffmpeg 叠起来。服务器没有显卡，模糊过的背景每帧重画太贵
 * 都只改状态、不等浏览器画出来：服务端截图时会先刷新样式再按需要的倍率现画。
 */
function exposeExportHooks(card: HoloCard): void {
  const hooks = window as Window & {
    __hcExportPose?: (x: number, y: number) => void;
    __hcExportLayer?: (layer: 'background' | 'card') => void;
  };
  hooks.__hcExportPose = (x, y) => card.setPose({ x, y });
  hooks.__hcExportLayer = (layer) => {
    document.body.classList.toggle('is-export-bg', layer === 'background');
    document.body.classList.toggle('is-export-card', layer === 'card');
  };
}

/** 卡片挂上之后：按版式补背景和文案，等图片、纹理都就绪再摆姿态，最后给截图脚本发信号 */
export async function finishRender(card: HoloCard, layout: ExportLayout | null): Promise<void> {
  // 透明底的贴纸只要卡片本身；竖屏动图要深色底但不要分享图右边那段字
  if (layout !== 'sticker') buildRenderBackground();
  if (layout === null) buildRenderCopy();
  // 等所有层真正解码完再摆姿态，否则截图可能截到半成品
  await Promise.all(
    [...document.querySelectorAll('img.hc__art')].map((img) =>
      (img as HTMLImageElement).decode().catch(() => undefined),
    ),
  );
  await preloadTextures();
  await card.ready;
  card.setPose(renderPose());
  exposeExportHooks(card);
  // 给截图脚本一个明确的信号，别靠猜时间
  document.body.dataset['ready'] = '1';
}
