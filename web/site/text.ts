/** 页面上取元素、随状态变的文字、给人看的错误信息：各模块共用 */

import { LayerFormatError } from '../../src/format/io';
import { t, type MessageKey } from '../../src/i18n';
import { ApiError } from './api';

/** 取元素并断言存在，省掉一堆空判断 */
export function need<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`页面上找不到 ${selector}`);
  return el;
}

/** 状态栏：做卡进度之外的一句话状态 */
export const status = need<HTMLParagraphElement>('#status');

/**
 * 页面上随状态变的文字（按钮当前状态、进度、状态栏、提示）都经过这里：
 * 记住每个元素当前显示的是哪句文案、带什么参数，切换语言时原地按新语言重写一遍。
 * 不刷新页面——刷新会丢掉刚做好、还没分享的卡。
 */
const liveTexts = new Map<HTMLElement, { key: MessageKey; params?: Record<string, string | number> }>();

export function setText(el: HTMLElement, key: MessageKey, params?: Record<string, string | number>): void {
  liveTexts.set(el, params ? { key, params } : { key });
  el.textContent = t(key, params);
}

export function clearText(el: HTMLElement): void {
  liveTexts.delete(el);
  el.textContent = '';
}

/** 切换语言后调：经 setText 写过的文字按新语言重写 */
export function rewriteTexts(): void {
  for (const [el, { key, params }] of liveTexts) el.textContent = t(key, params);
}

/**
 * 把错误变成给人看的一句话。
 * 服务端的错误按 code 翻译；浏览器自己的网络错误（Load failed、Failed to fetch…）
 * 原文对用户毫无意义，统一换成「网络断了」；其余照原文。
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `error.${error.code}` as MessageKey;
    const translated = t(key, error.params);
    if (translated !== key) return translated;
  }
  // 卡过期、被删之后再打开分享链接，取 manifest 是 404
  if (error instanceof LayerFormatError && error.status === 404) return t('error.card_not_found');
  if (error instanceof TypeError && /fetch|load failed|network/i.test(error.message)) {
    return t('error.network');
  }
  return error instanceof Error ? error.message : String(error);
}
