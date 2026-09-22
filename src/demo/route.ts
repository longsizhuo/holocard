/**
 * 页面路由
 *
 * 三种形态共用同一个 index.html：
 *   demo    /              演示页，带调参面板，可以上传
 *   card    /c/<id>        别人分享过来的卡片，只看不调
 *   render  /render/<id>   给服务端截 OG 预览图用的裸页面：只有卡片、固定姿态、无 UI
 */

import type { Lang } from '../i18n';

export type PageMode = 'demo' | 'card' | 'render';

export interface Route {
  mode: PageMode;
  /** card / render 模式下的卡片 id */
  id: string | null;
}

const CARD_PATH = /^\/c\/([0-9a-f-]{36})\/?$/;
const RENDER_PATH = /^\/render\/([0-9a-f-]{36})\/?$/;

export function parseRoute(pathname: string = location.pathname): Route {
  const card = CARD_PATH.exec(pathname);
  if (card?.[1]) return { mode: 'card', id: card[1] };

  const render = RENDER_PATH.exec(pathname);
  if (render?.[1]) return { mode: 'render', id: render[1] };

  return { mode: 'demo', id: null };
}

/**
 * 某张卡片的分享地址。
 * 带上分享人的语言（中文是默认，不带）：链接发出去之后，预览卡片的标题、描述、分享图，
 * 以及对方打开看到的界面，都是分享人的语言。
 */
export function shareUrl(id: string, lang: Lang = 'zh'): string {
  return `${location.origin}/c/${id}${lang === 'zh' ? '' : `?lang=${lang}`}`;
}
