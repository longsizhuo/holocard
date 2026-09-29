/**
 * 我的卡册：这台设备上做过的卡，打开就是网格，最新的在前。
 *
 * 这个站没有账号，数据就是删除口令那份记录（api.ts 的 holocard:owned），只在这台设备的浏览器里。
 * 以前还能自己建卡册、把卡加进去，现在用的人还不多，先只留这一本自动记的。
 * 用原生 dialog：遮罩、Esc 关闭、焦点圈在窗口里，这些浏览器都管了。
 */

import { ownedCards } from './api';
import { onLangChange, t } from '../i18n';

const BASE = import.meta.env.BASE_URL;
/** dialog 的 aria-labelledby 指向它，读屏软件打开窗口时能念出名字 */
const TITLE_ID = 'albums-title';

let dialog: HTMLDialogElement | null = null;
let body: HTMLElement | null = null;

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

function render(): void {
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
  body.replaceChildren(
    el('h2', { id: TITLE_ID, textContent: t('albums.title') }),
    el('p', { className: 'albums__intro', textContent: t(cards.length ? 'albums.mineHint' : 'albums.mineEmpty') }),
    ...(cards.length ? [el('div', { className: 'albums__grid' }, ...cards)] : []),
  );
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
  onLangChange(() => {
    if (dialogEl.open) render();
  });
}

export function openAlbums(): void {
  render();
  dialog?.showModal();
  body?.scrollTo(0, 0);
}
