/**
 * 个人中心：登录的账号、退出、卡册入口，和对外接口的 key（申请、看用量、吊销）。
 *
 * 页头右上角一个按钮：没登录是「登录」，登录了是头像 + 名字，点开这个窗口。只在开了登录的部署上出现。
 * key 只在申请那一次的响应里有，这里也只显示那一次（关窗口就没了）；之后只看得到编号和用量。
 * 退出直接刷新页面：卡算不算「我的」、卡册、页头都跟着登录状态变，重来一遍最不容易漏。
 */

import { account, loginHref, logout, myKeys, ownedCards, requestKey, revokeKey, unclaimedCards, type MyKey } from './api';
import { lang, onLangChange, t } from '../i18n';
import { openAlbums } from './albums-ui';
import { track } from './track';

const TITLE_ID = 'account-title';

let dialog: HTMLDialogElement | null = null;
let body: HTMLElement | null = null;
let button: HTMLButtonElement | null = null;
let describe: (error: unknown) => string = String;
/** 刚申请到的 key：只显示这一次 */
let fresh: { id: string; key: string } | null = null;

type Child = Node | string | null | false | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child) node.append(child);
  return node;
}

/** 接口文档在站内（docs-site/，VitePress），按当前语言进对应的那份 */
function docsUrl(): string {
  return `${import.meta.env.BASE_URL}docs/${lang() === 'zh' ? '' : `${lang()}/`}api/`;
}

/** 页头按钮跟着登录状态变。loadMe 回来之后调一次 */
export function refreshAccountButton(): void {
  if (!button) return;
  const { login, user } = account();
  button.hidden = !login;
  if (!user) {
    button.replaceChildren(t('account.signIn'));
    button.removeAttribute('aria-label');
    return;
  }
  button.replaceChildren(
    user.avatar ? el('img', { className: 'account-open__avatar', src: user.avatar, alt: '', referrerPolicy: 'no-referrer' }) : '',
    el('span', { className: 'account-open__name', textContent: user.name }),
  );
  button.setAttribute('aria-label', t('account.title'));
}

function keyBox(state: { keys: MyKey[]; used: number; dailyLimit: number }): HTMLElement {
  const box = el('div', { className: 'api' });
  const note = el('p', { className: 'api__note', role: 'status' });
  const active = state.keys.find((key) => key.revokedAt === null);

  if (fresh && active?.id === fresh.id) {
    const field = el('input', { className: 'api__key', readOnly: true, value: fresh.key, spellcheck: false });
    const copy = el('button', { type: 'button', className: 'api__button', textContent: t('api.copy') });
    copy.addEventListener('click', () => {
      field.select();
      void navigator.clipboard?.writeText(field.value).then(() => (copy.textContent = t('api.copied')), () => undefined);
    });
    const auth = `-H "Authorization: Bearer ${fresh.key}"`;
    const curl = [
      `# ${t('api.curlSubmit')}`,
      `curl -X POST ${location.origin}/v1/cards \\`,
      `  ${auth} \\`,
      `  -H "Content-Type: image/jpeg" --data-binary @photo.jpg`,
      '',
      `# ${t('api.curlPoll')}`,
      `curl ${location.origin}/v1/cards/<id> ${auth}`,
    ].join('\n');
    box.append(
      el('p', { className: 'api__fresh', textContent: t('api.fresh') }),
      el('div', { className: 'api__row' }, field, copy),
      el('p', { className: 'api__hint', textContent: t('api.example') }),
      el('pre', { className: 'api__curl', textContent: curl }),
    );
  }

  if (active) {
    const revoke = el('button', { type: 'button', className: 'api__button', textContent: t('api.revoke') });
    revoke.addEventListener('click', () => {
      if (!confirm(t('api.revokeConfirm'))) return;
      revoke.disabled = true;
      revokeKey(active.id).then(
        () => {
          track('api-key-revoke');
          fresh = null;
          void render();
        },
        (error: unknown) => {
          revoke.disabled = false;
          note.textContent = t('api.failed', { message: describe(error) });
        },
      );
    });
    box.append(
      el(
        'div',
        { className: 'api__row' },
        el('span', {
          className: 'api__info',
          textContent: t('api.keyInfo', {
            id: active.id,
            date: new Date(active.createdAt).toLocaleDateString(document.documentElement.lang || undefined),
            used: state.used,
            limit: active.dailyLimit,
          }),
        }),
        revoke,
      ),
    );
  } else {
    const ask = el('button', { type: 'button', className: 'api__button api__button--primary', textContent: t('api.request') });
    ask.addEventListener('click', () => {
      ask.disabled = true;
      ask.textContent = t('api.requesting');
      requestKey().then(
        (created) => {
          track('api-key');
          fresh = { id: created.id, key: created.key };
          void render();
        },
        (error: unknown) => {
          ask.disabled = false;
          ask.textContent = t('api.request');
          note.textContent = t('api.failed', { message: describe(error) });
        },
      );
    });
    box.append(ask);
  }
  box.append(note);
  return box;
}

async function render(): Promise<void> {
  if (!body) return;
  const { user } = account();
  if (!user) {
    body.replaceChildren(
      el('h2', { id: TITLE_ID, textContent: t('account.title') }),
      el('a', { className: 'account__login', href: loginHref(`${location.pathname}${location.search}#account`), textContent: t('account.login') }),
    );
    return;
  }

  const out = el('button', { type: 'button', className: 'account__logout', textContent: t('account.logout') });
  out.addEventListener('click', () => {
    out.disabled = true;
    void logout().then(() => location.reload());
  });
  const albums = el('button', { type: 'button', className: 'api__button', textContent: t('account.openAlbums') });
  albums.addEventListener('click', () => {
    dialog?.close();
    openAlbums();
  });
  const unclaimed = unclaimedCards().length;
  // 额度、key 的状态要现问，先占个位
  const apiBody = el('div', {}, el('p', { className: 'account__hint', textContent: t('api.loading') }));
  body.replaceChildren(
    el('h2', { id: TITLE_ID, textContent: t('account.title') }),
    el(
      'div',
      { className: 'account__me' },
      user.avatar && el('img', { className: 'account__avatar', src: user.avatar, alt: '', referrerPolicy: 'no-referrer' }),
      el('span', { textContent: user.name }),
      out,
    ),
    el(
      'section',
      { className: 'account__section' },
      el('h3', { textContent: t('albums.title') }),
      el(
        'div',
        { className: 'api__row' },
        el('span', {
          className: 'api__info',
          textContent: t(unclaimed ? 'account.cardsUnclaimed' : 'account.cards', {
            n: ownedCards().length - unclaimed,
            m: unclaimed,
          }),
        }),
        albums,
      ),
    ),
    el('section', { className: 'account__section' }, el('h3', { textContent: t('api.title') }), apiBody),
  );

  try {
    const state = await myKeys();
    apiBody.replaceChildren(
      el(
        'p',
        { className: 'account__hint' },
        t('api.intro', { limit: state.dailyLimit }),
        ' ',
        el('a', { href: docsUrl(), target: '_blank', rel: 'noreferrer', textContent: t('api.docs') }),
      ),
      // 四步：拿 key → 交图 → 取文件 → 放进网页。只给 curl 不说流程，第一次用的人卡在「photo.jpg 是什么」
      el(
        'ol',
        { className: 'api__steps' },
        el('li', { textContent: t('api.step1') }),
        el('li', { textContent: t('api.step2') }),
        el('li', { textContent: t('api.step3') }),
        el(
          'li',
          {},
          t('api.step4'),
          ' ',
          el('a', { href: 'https://www.npmjs.com/package/@holocard/player', target: '_blank', rel: 'noreferrer', textContent: '@holocard/player' }),
        ),
      ),
      keyBox(state),
    );
  } catch (error) {
    apiBody.replaceChildren(el('p', { className: 'account__hint', textContent: t('api.failed', { message: describe(error) }) }));
  }
}

/** 挂到页面上已有的 <dialog> 和页头按钮 */
export function initAccount(
  dialogEl: HTMLDialogElement,
  openButton: HTMLButtonElement,
  describeError: (error: unknown) => string,
): void {
  dialog = dialogEl;
  body = dialogEl.querySelector<HTMLElement>('.albums__body');
  button = openButton;
  describe = describeError;
  // 只有右上角 × 能关：点遮罩关闭在复制 key、选中文字时太容易误触，刚申请的 key 关了就再也看不到
  dialogEl.querySelector('.albums__close')?.addEventListener('click', () => dialogEl.close());
  // Esc 同理：key 还显示着的时候不让它关
  dialogEl.addEventListener('cancel', (event) => {
    if (fresh) event.preventDefault();
  });
  // 刚申请的 key 只显示这一次：关了窗口就忘掉
  dialogEl.addEventListener('close', () => (fresh = null));
  openButton.addEventListener('click', () => {
    if (account().user) openAccount();
    else location.href = loginHref(`${location.pathname}${location.search}#account`);
  });
  onLangChange(() => {
    refreshAccountButton();
    if (dialogEl.open) void render();
  });
}

export function openAccount(): void {
  void render();
  dialog?.showModal();
}
