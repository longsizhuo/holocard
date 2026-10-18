/**
 * 工具页（卡面遮罩 /masks、线稿提取 /lineart）共用的几样：取元素、语言切换按钮、服务端错误的翻译、读图片像素
 */

import { applyTranslations, lang, onLangChange, setLang, t, type Lang, type MessageKey } from '../../src/i18n';

export const BASE = import.meta.env.BASE_URL;

export function need<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`页面上缺少 ${selector}`);
  return el;
}

/** 翻译页面、接上页头的语言按钮和文档链接；换语言时再调 onChange */
export function setupLang(onChange: (l: Lang) => void = () => undefined): void {
  const docsLink = need<HTMLAnchorElement>('#docs-link');
  const sync = (l: Lang): void => {
    docsLink.href = `${BASE}docs/${l === 'zh' ? '' : `${l}/`}`;
    for (const button of document.querySelectorAll<HTMLButtonElement>('.lang [data-lang]')) {
      button.setAttribute('aria-pressed', String(button.dataset['lang'] === l));
    }
  };
  applyTranslations();
  sync(lang());
  for (const button of document.querySelectorAll<HTMLButtonElement>('.lang [data-lang]')) {
    button.addEventListener('click', () => {
      const next = button.dataset['lang'];
      if (next === 'zh' || next === 'en' || next === 'ja') setLang(next);
    });
  }
  onLangChange((l) => {
    sync(l);
    onChange(l);
  });
}

/** 服务端的错误按 code 翻译；不认识的照原文 */
export async function describe(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; params?: Record<string, string | number> };
  const key = `error.${body.code ?? ''}` as MessageKey;
  const translated = t(key, body.params);
  return translated !== key ? translated : (body.error ?? `HTTP ${res.status}`);
}

/** 失败时给人看的一句：断网翻译成「网络断了」，别的照错误信息 */
export function failure(error: unknown): string {
  return error instanceof TypeError ? t('error.network') : error instanceof Error ? error.message : String(error);
}

export async function pixels(url: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await describe(res));
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.drawImage(bitmap, 0, 0);
  return { data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data, width: bitmap.width, height: bitmap.height };
}

/** 提交一张图到工具接口，轮询到做完，返回任务 id 和最后一次的状态 */
export async function submitAndWait<T extends { state: string; error?: string }>(endpoint: string, file: File): Promise<{ id: string; job: T }> {
  const res = await fetch(`${BASE}api/${endpoint}`, { method: 'POST', body: file, headers: { 'x-holocard-lang': lang() } });
  if (!res.ok) throw new Error(await describe(res));
  const { id } = (await res.json()) as { id: string };
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await fetch(`${BASE}api/${endpoint}/${id}`);
    if (!poll.ok) throw new Error(await describe(poll));
    const job = (await poll.json()) as T;
    if (job.state === 'error') throw new Error(job.error ?? '');
    if (job.state === 'done') return { id, job };
  }
}
