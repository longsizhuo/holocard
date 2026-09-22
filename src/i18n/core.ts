/**
 * 多语言的公共部分：前端和服务端都用
 *
 * 语言怎么定（先到先得）：
 *   1. 地址上的 ?lang=      分享链接会带上分享人的语言，搜索引擎也靠它收录各语言版本
 *   2. cookie hc_lang       用户在页头手动切过一次就记住。用 cookie 而不是 localStorage，
 *                           服务端发页面时才读得到，页面一出来就是对的语言，不会先闪一下中文
 *   3. Accept-Language / navigator.languages
 *   4. 中文
 */

import { en, ja, zh, type MessageKey, type Messages } from './messages';

export type Lang = 'zh' | 'en' | 'ja';

export const LANGS: readonly Lang[] = ['zh', 'en', 'ja'];

export const LANG_COOKIE = 'hc_lang';

const TABLES: Record<Lang, Messages> = { zh, en, ja };

/** <html lang> 和 hreflang 用的标签 */
export const LANG_TAG: Record<Lang, string> = { zh: 'zh-CN', en: 'en', ja: 'ja' };

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

/** 浏览器语言标签（zh-TW、en-US、ja-JP…）归到我们支持的三种之一，都不沾边返回 null */
export function langFromTag(tag: string): Lang | null {
  const base = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return isLang(base) ? base : null;
}

/** 按 Accept-Language 的权重挑第一个支持的语言 */
export function langFromAcceptLanguage(header: string | undefined): Lang | null {
  if (!header) return null;
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => /^q=([\d.]+)$/.exec(p.trim())).find(Boolean);
      return { tag, q: q ? Number(q[1]) : 1 };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const lang = langFromTag(tag);
    if (lang) return lang;
  }
  return null;
}

/** 从 Cookie 头里取语言偏好 */
export function langFromCookie(cookie: string | undefined): Lang | null {
  const match = cookie ? new RegExp(`(?:^|;\\s*)${LANG_COOKIE}=([a-z]+)`).exec(cookie) : null;
  return match && isLang(match[1]) ? match[1] : null;
}

/** 把 {name} 换成参数 */
export function format(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) =>
    name in params ? String(params[name]) : all,
  );
}

export function translate(
  lang: Lang,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  // 查不到的键原样返回（调用方拿它判断「这个错误码有没有翻译」），不抛错
  const template: string | undefined = TABLES[lang][key] ?? zh[key];
  return template === undefined ? key : format(template, params);
}

/** 页脚里两个链接：翻译文本里用 {upstream}、{github} 占位 */
export const FOOT_LINKS: Record<string, string> = {
  upstream:
    '<a href="https://github.com/simeydotme/pokemon-cards-css" target="_blank" rel="noreferrer">pokemon-cards-css</a>',
  github: '<a href="https://github.com/longsizhuo/holocard" target="_blank" rel="noreferrer">GitHub</a>',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 服务端发页面时按语言换掉静态文字（index.html 里标了 data-i18n 的元素）。
 *
 * 约定（index.html 里只这么用）：
 *   data-i18n="键"        元素里只有纯文本，整段换掉
 *   data-i18n-html="键"   元素里是一段可信 HTML（页脚），整段换掉
 *   data-i18n-title="键"  换掉同一个开始标签上的 title 属性
 *   data-i18n-aria="键"   换掉同一个开始标签上的 aria-label 属性
 * 前端的 applyTranslations 按同样的约定处理 DOM，两边结果一致。
 * 中文就是 index.html 本来的样子，不用换。
 */
export function localizeHtml(html: string, lang: Lang): string {
  if (lang === 'zh') return html;
  const t = (key: string, params?: Record<string, string | number>): string =>
    key in zh ? translate(lang, key as MessageKey, params) : key;

  return html
    .replace(/<html lang="[^"]*"/, `<html lang="${LANG_TAG[lang]}"`)
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(t('meta.title'))}</title>`)
    .replace(
      /<meta name="description" content="[^"]*"/,
      `<meta name="description" content="${escapeHtml(t('meta.description'))}"`,
    )
    .replace(
      /<([a-z][a-z0-9]*)\b([^>]*?)\sdata-i18n="([\w.-]+)"([^>]*)>([^<]*)<\/\1>/g,
      (_all, tag: string, before: string, key: string, after: string) =>
        `<${tag}${before} data-i18n="${key}"${after}>${escapeHtml(t(key))}</${tag}>`,
    )
    .replace(
      /<([a-z][a-z0-9]*)\b([^>]*?)\sdata-i18n-html="([\w.-]+)"([^>]*)>([\s\S]*?)<\/\1>/g,
      (_all, tag: string, before: string, key: string, after: string) =>
        `<${tag}${before} data-i18n-html="${key}"${after}>${t(key, FOOT_LINKS)}</${tag}>`,
    )
    .replace(/<[a-z][^>]*\sdata-i18n-(title|aria)="([\w.-]+)"[^>]*>/g, (tagText, which: string, key: string) => {
      const attr = which === 'title' ? 'title' : 'aria-label';
      return tagText.replace(new RegExp(`\\s${attr}="[^"]*"`), ` ${attr}="${escapeHtml(t(key))}"`);
    });
}
