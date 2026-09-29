/**
 * 我的卡册：这台设备上做过的卡，网格排列，最新的在前。
 *
 * 这个站没有账号，数据就是删除口令那份记录（api.ts 的 holocard:owned），只在这台设备的浏览器里。
 * 以前还能自己建卡册、把卡加进去，现在用的人还不多，先只留这一本自动记的。
 * 用原生 dialog：遮罩、Esc 关闭、焦点圈在窗口里，这些浏览器都管了。
 *
 * 每次打开都先开一包：网格的位置上放一个卡包，撕开或点开之后卡一张张从卡包那里飞出、落进网格（发牌）。
 * 每张间隔约 80 毫秒，整个发完封顶 2 秒，卡多就加快；发牌时点一下全部直接落位。
 * 一张卡都没有、或者开着「减少动态效果」时不出卡包，直接是网格。
 */

import { ownedCards } from './api';
import { onLangChange, t } from '../i18n';
import { reducedMotion, type PackView } from './pack';
import { createPack } from './pack-gl';
import { sfx } from './sfx';

const BASE = import.meta.env.BASE_URL;
/** dialog 的 aria-labelledby 指向它，读屏软件打开窗口时能念出名字 */
const TITLE_ID = 'albums-title';

let dialog: HTMLDialogElement | null = null;
let body: HTMLElement | null = null;
/** 正在等人开的卡包 */
let pack: PackView | null = null;
/** 正在发的牌：点一下要能全部停到位 */
let dealing: { animations: Animation[]; timers: number[] } | null = null;

/** 一张牌从卡包飞到位要多久；整个发完最多多久；两张之间最多隔多久 */
const FLIGHT_MS = 520;
const DEAL_MAX_MS = 2000;
const DEAL_GAP_MS = 80;

type Child = Node | string | null | false | undefined;

/** 建一个元素：属性直接赋到元素上，子节点里的空值跳过 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child) node.append(child);
  return node;
}

/** 卡片缩略图。卡过期或被删了，服务端回 404，就换成「已过期」 */
function thumb(cardId: string): HTMLElement {
  const box = el('div', { className: 'athumb' });
  const img = el('img', { src: `${BASE}api/layers/${cardId}/thumb.jpg`, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => {
    img.remove();
    box.classList.add('is-gone');
    box.append(el('span', { textContent: t('albums.cardGone') }));
  });
  box.append(img);
  return box;
}

/** 发牌到一半、卡包没开，统统收掉：关窗口、换语言重画时用 */
function settle(): void {
  pack?.destroy();
  pack = null;
  if (dealing) {
    for (const animation of dealing.animations) animation.finish();
    for (const timer of dealing.timers) window.clearTimeout(timer);
    dealing = null;
  }
}

/** 网格的位置上放一个卡包，开了就发牌 */
function showPack(stage: HTMLElement, grid: HTMLElement): void {
  const p = createPack(stage, () => undefined);
  p.setState('ready');
  p.onOpen((method) => {
    void p.playOpen(method, 1);
    // 封条飞走、光最亮的时候开始发
    window.setTimeout(() => deal(stage, grid), method === 'swipe' ? 380 : 620);
  });
  pack = p;
}

/** 卡一张张从卡包那里飞出来、落进网格 */
function deal(stage: HTMLElement, grid: HTMLElement): void {
  if (!stage.isConnected || !dialog) return;
  const box = stage.getBoundingClientRect();
  const from = { x: box.left + box.width / 2, y: box.top + box.height * 0.45 };
  // 卡包拆掉（连同它占的位置），网格露出来
  pack?.destroy();
  pack = null;
  grid.hidden = false;

  const cards = [...grid.children] as HTMLElement[];
  const gap = cards.length > 1 ? Math.min(DEAL_GAP_MS, (DEAL_MAX_MS - FLIGHT_MS) / (cards.length - 1)) : 0;
  const animations = cards.map((card, i) => {
    const r = card.getBoundingClientRect();
    const dx = from.x - (r.left + r.width / 2), dy = from.y - (r.top + r.height / 2);
    // 每张带一点随手的歪斜，落下时摆正
    const tilt = (i % 2 ? 1 : -1) * (6 + ((i * 7) % 9));
    return card.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(0.4) rotate(${tilt}deg)`, opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: FLIGHT_MS, delay: i * gap, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' },
    );
  });
  // 每张落下时「嗒」一声
  const timers = cards.map((_, i) => window.setTimeout(sfx.deal, i * gap + FLIGHT_MS * 0.75));
  dealing = { animations, timers };

  // 点一下全部直接落位
  const skip = (): void => settle();
  dialog.addEventListener('pointerdown', skip, { once: true });
  void Promise.all(animations.map((animation) => animation.finished))
    .then(() => {
      dealing = null;
      dialog?.removeEventListener('pointerdown', skip);
    })
    .catch(() => undefined);
}

function render(withPack: boolean): void {
  if (!body) return;
  const cards = ownedCards().map((cardId, index) =>
    el(
      'div',
      { className: 'acard' },
      // 点进去就是这张卡的页面，分享、导出、删除都在那里。
      // 链接里只有一张装饰性的缩略图，要给个名字，读屏软件才念得出这是什么
      el('a', { href: `${BASE}c/${cardId}`, ariaLabel: t('albums.cardN', { n: index + 1 }) }, thumb(cardId)),
    ),
  );
  const grid = cards.length ? el('div', { className: 'albums__grid' }, ...cards) : null;
  const stage = withPack && grid && !reducedMotion() ? el('div', { className: 'albums__pack' }) : null;
  if (grid && stage) grid.hidden = true;
  body.replaceChildren(
    el('h2', { id: TITLE_ID, textContent: t('albums.title') }),
    el('p', { className: 'albums__intro', textContent: t(cards.length ? 'albums.mineHint' : 'albums.mineEmpty') }),
    ...(stage ? [stage] : []),
    ...(grid ? [grid] : []),
  );
  if (grid && stage) showPack(stage, grid);
}

/** 挂到页面上已有的 <dialog> */
export function initAlbums(dialogEl: HTMLDialogElement): void {
  dialog = dialogEl;
  body = dialogEl.querySelector<HTMLElement>('.albums__body');
  dialogEl.querySelector('.albums__close')?.addEventListener('click', () => dialogEl.close());
  // 点遮罩关闭：遮罩上的点击，事件目标是 dialog 自己
  dialogEl.addEventListener('click', (event) => {
    if (event.target === dialogEl) dialogEl.close();
  });
  dialogEl.addEventListener('close', settle);
  // 换语言时直接给网格，不再出一次卡包
  onLangChange(() => {
    if (!dialogEl.open) return;
    settle();
    render(false);
  });
}

export function openAlbums(): void {
  settle();
  render(true);
  dialog?.showModal();
  body?.scrollTo(0, 0);
}
