/**
 * 我的卡册：这台设备上做过的卡，登录了再加上账号名下的卡，网格排列，最新的在前。
 *
 * 不登录时，数据就是删除口令那份记录（api.ts 的 holocard:owned），只在这台设备的浏览器里。
 * 登录（用 involutionhell 账号，可选）以后账号名下的卡也在这里；这台设备上还没放进账号的，上面有个勾选认领的框。
 * 以前还能自己建卡册、把卡加进去，现在用的人还不多，先只留这一本自动记的。
 * 用原生 dialog：遮罩、Esc 关闭、焦点圈在窗口里，这些浏览器都管了。
 *
 * 打开就是网格。以前每次先出一个卡包、点开才发牌（带音效），有用户没点开，以为卡全没了，在工位上还被音效吓到，去掉了。
 */

import { account, claimCards, loginHref, logout, ownedCards, unclaimedCards } from './api';
import { onLangChange, t } from '../i18n';
import { track } from './track';

const BASE = import.meta.env.BASE_URL;
/** dialog 的 aria-labelledby 指向它，读屏软件打开窗口时能念出名字 */
const TITLE_ID = 'albums-title';

let dialog: HTMLDialogElement | null = null;
/** 把错误翻成给人看的一句话（main.ts 的 describeError） */
let describe: (error: unknown) => string = String;
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

/** 登录入口；登录了就是「已登录：名字」、退出按钮，和认领框 */
function accountBox(): HTMLElement | null {
  const { login, user } = account();
  if (!login) return null;
  if (!user) {
    return el(
      'div',
      { className: 'account' },
      el('p', { className: 'account__hint', textContent: t('account.loginHint') }),
      // 登录完回到这一页并接着打开卡册（main.ts 认 #albums）
      el('a', {
        className: 'account__login',
        href: loginHref(`${location.pathname}${location.search}#albums`),
        textContent: t('account.login'),
      }),
    );
  }
  const out = el('button', { type: 'button', className: 'account__logout', textContent: t('account.logout') });
  out.addEventListener('click', () => {
    out.disabled = true;
    // 刷新页面：页头、卡算不算「我的」都跟着变，和个人中心里的退出一样
    void logout().then(() => location.reload());
  });
  return el(
    'div',
    { className: 'account' },
    el(
      'div',
      { className: 'account__me' },
      user.avatar && el('img', { className: 'account__avatar', src: user.avatar, alt: '', referrerPolicy: 'no-referrer' }),
      el('span', { textContent: t('account.signedIn', { name: user.name }) }),
      out,
    ),
    claimBox(),
  );
}

/**
 * 这台设备上还没放进账号的卡，勾选了认领。默认全勾：多数时候这就是自己的手机；
 * 在公用电脑上能把别人留下的取消掉，所以不做成登录时自动认领
 */
function claimBox(): HTMLElement | null {
  const ids = unclaimedCards();
  if (!ids.length) return null;
  const checks = ids.map((id) => el('input', { type: 'checkbox', checked: true, value: id }));
  const button = el('button', { type: 'button', className: 'claim__button', textContent: t('account.claim') });
  const note = el('p', { className: 'claim__note', role: 'status' });
  button.addEventListener('click', () => {
    const chosen = checks.filter((check) => check.checked).map((check) => check.value);
    if (!chosen.length) return;
    button.disabled = true;
    button.textContent = t('account.claiming');
    claimCards(chosen).then(
      (claimed) => {
        track('claim', { n: claimed.length });
        render();
      },
      (error: unknown) => {
        button.disabled = false;
        button.textContent = t('account.claim');
        note.textContent = t('account.claimFailed', { message: describe(error) });
      },
    );
  });
  return el(
    'div',
    { className: 'claim' },
    el('p', { className: 'claim__title', textContent: t('account.claimTitle', { n: ids.length }) }),
    el('p', { className: 'claim__hint', textContent: t('account.claimHint') }),
    el(
      'div',
      { className: 'claim__grid' },
      ...ids.map((id, i) => el('label', { className: 'claim__card' }, checks[i], thumb(id))),
    ),
    button,
    note,
  );
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
  const grid = cards.length ? el('div', { className: 'albums__grid' }, ...cards) : null;
  // 登录了就是「在线卡册」，名字本身说明了卡在账号里，不再另配一句说明；空的时候才提示怎么放进来
  const signedIn = account().user !== null;
  const intro = signedIn
    ? cards.length ? null : 'albums.accountEmpty'
    : cards.length ? 'albums.mineHint' : 'albums.mineEmpty';
  body.replaceChildren(
    el('h2', { id: TITLE_ID, textContent: t(signedIn ? 'albums.titleOnline' : 'albums.title') }),
    accountBox() ?? '',
    intro ? el('p', { className: 'albums__intro', textContent: t(intro) }) : '',
    ...(grid ? [grid] : []),
  );
}

/** 挂到页面上已有的 <dialog> */
export function initAlbums(dialogEl: HTMLDialogElement, describeError: (error: unknown) => string): void {
  dialog = dialogEl;
  describe = describeError;
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
