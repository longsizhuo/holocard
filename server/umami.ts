/**
 * 对外接口的活动也记进 umami，和网页同一个站点：站长在一个地方看全，不用翻库。
 *
 * 网页的事件由浏览器里的统计脚本发（src/demo/track.ts）；调接口不经过浏览器，只能服务端发。
 *
 * 用户维度：每个事件带 umami 的访客标识（payload.id）。umami 见到它就按「站点 + 标识」认访客，
 * 不看 IP 和 UA——同一个账号换了 key、隔了几天，统计里还是同一个访客，也不会每个事件多出一个访客、
 * 把网页的访客数刷上去。自己申请的 key 标识是 IH 账号（ih:<id>），站长发的 key 没有账号，用 key 编号。
 * 事件数据里带 user（名字），在「事件」里按它分组就是每个人用了多少；第一次见到某个人时再登记一次
 * 访客属性（名字、账号、key 怎么来的），会话详情里看得到。
 * UA 得像浏览器：umami 会把 node、curl 这类当爬虫直接丢掉（它用 isbot 判断）。
 *
 * 站点 id、umami 地址和前端一样，构建时从 .env.production 的 VITE_UMAMI_ID、VITE_UMAMI_URL 注入，没配 id 就不发。
 * 本机地址（开发、自检脚本）不发，规则和前端 track.ts 一样，免得测试数据进线上统计。
 * 发不出去就算了：统计不能影响接口本身。
 */

import type { ApiKeyRow } from './store/db';
import { PUBLIC_ORIGIN } from './config';

const ENDPOINT = `${import.meta.env.VITE_UMAMI_URL ?? 'https://umami.involutionhell.com'}/api/send`;
const WEBSITE_ID: string = import.meta.env.VITE_UMAMI_ID ?? '';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) HoloCardAPI';

type EventData = Record<string, string | number>;
type KeyInfo = Pick<ApiKeyRow, 'id' | 'name' | 'user_id'>;

export function apiTracker(origin: string): (key: KeyInfo, name: string, data?: EventData) => void {
  const hostname = new URL(origin).hostname;
  const local = hostname === 'localhost' || hostname.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(hostname);
  if (!WEBSITE_ID || local) return () => undefined;

  const send = (type: 'event' | 'identify', payload: Record<string, unknown>): void => {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ type, payload: { website: WEBSITE_ID, hostname, url: '/v1/cards', ...payload } }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  };
  /** 这个进程里登记过属性的访客。重启后再登记一次也无妨（同名属性是覆盖） */
  const identified = new Set<string>();

  return (key, name, data = {}) => {
    const id = key.user_id ? `ih:${key.user_id}` : `key:${key.id}`;
    if (!identified.has(id)) {
      identified.add(id);
      send('identify', { id, data: { name: key.name, account: key.user_id ?? '', via: key.user_id ? 'self-serve' : 'issued' } });
    }
    send('event', { id, name, data: { key: key.id, user: key.name, ...data } });
  };
}

/** 对外接口的活动记进 umami */
export const trackApi = apiTracker(PUBLIC_ORIGIN);
