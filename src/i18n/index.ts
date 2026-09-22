/**
 * 前端的多语言：当前语言、t()、把页面上的静态文字换成当前语言
 *
 * 服务端发页面时已经按同样的规则换好了（见 core.ts 的 localizeHtml），
 * 这里负责：页头手动切换语言时就地换掉，不刷新页面（刷新会丢掉刚做好、还没分享的卡）；
 * 以及本地开发（vite 直接发的 index.html 没经过服务端）时补上。
 */

import {
  FOOT_LINKS,
  LANG_COOKIE,
  LANG_TAG,
  LANGS,
  isLang,
  langFromCookie,
  langFromTag,
  translate,
  type Lang,
} from './core';
import type { MessageKey } from './messages';

export { LANGS, type Lang };
export type { MessageKey };

function detect(): Lang {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (isLang(fromUrl)) return fromUrl;
  const fromCookie = langFromCookie(document.cookie);
  if (fromCookie) return fromCookie;
  for (const tag of navigator.languages ?? [navigator.language]) {
    const lang = langFromTag(tag);
    if (lang) return lang;
  }
  return 'zh';
}

let current: Lang = detect();
const listeners = new Set<(lang: Lang) => void>();

export function lang(): Lang {
  return current;
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(current, key, params);
}

/** 语言变了之后要重画的动态文字（按钮当前状态、层列表之类）在这里登记 */
export function onLangChange(listener: (lang: Lang) => void): void {
  listeners.add(listener);
}

/** 按 data-i18n 系列标记把静态文字换成当前语言。约定见 core.ts 的 localizeHtml */
export function applyTranslations(root: ParentNode = document): void {
  document.documentElement.lang = LANG_TAG[current];
  document.title = t('meta.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'));

  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset['i18n'] as MessageKey);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-html]')) {
    // 只会是 messages.ts 里我们自己写的 HTML，参数也是写死的两个链接
    el.innerHTML = t(el.dataset['i18nHtml'] as MessageKey, FOOT_LINKS);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    el.title = t(el.dataset['i18nTitle'] as MessageKey);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset['i18nAria'] as MessageKey));
  }
}

/**
 * 用户在页头切换语言。
 * 记进 cookie（服务端下次发页面时就用它），地址栏的 ?lang 也跟着改——
 * 分享链接、收藏夹里存下来的都是当前语言。中文是默认，不带参数。
 */
export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  const url = new URL(location.href);
  if (next === 'zh') url.searchParams.delete('lang');
  else url.searchParams.set('lang', next);
  history.replaceState(history.state, '', url);
  applyTranslations();
  for (const listener of listeners) listener(next);
}
