/**
 * 对外接口的活动也记进 umami，和网页同一个站点：站长在一个地方看全，不用翻库。
 *
 * 网页的事件由浏览器里的统计脚本发（src/demo/track.ts）；调接口不经过浏览器，只能服务端发。
 * umami 按 IP + User-Agent 认访客：每个 key 用一个固定的 UA，统计里一个 key 算一个访客，
 * 不会每发一个事件就多出一个访客、把网页的访客数刷上去。
 * UA 得像浏览器：umami 会把 node、curl 这类当爬虫直接丢掉（它用 isbot 判断）。
 *
 * 站点 id 和前端一样，构建时从 .env.production 的 VITE_UMAMI_ID 注入，没配就不发。
 * 本机地址（开发、自检脚本）不发，规则和前端 track.ts 一样，免得测试数据进线上统计。
 * 发不出去就算了：统计不能影响接口本身。
 */

const ENDPOINT = 'https://umami.involutionhell.com/api/send';
const WEBSITE_ID: string = import.meta.env.VITE_UMAMI_ID ?? '';

type EventData = Record<string, string | number>;

export function apiTracker(origin: string): (keyId: string, name: string, data?: EventData) => void {
  const hostname = new URL(origin).hostname;
  const local = hostname === 'localhost' || hostname.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(hostname);
  if (!WEBSITE_ID || local) return () => undefined;

  return (keyId, name, data = {}) => {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': `Mozilla/5.0 (X11; Linux x86_64) HoloCardAPI/${keyId}`,
      },
      body: JSON.stringify({
        type: 'event',
        payload: { website: WEBSITE_ID, hostname, url: '/v1/cards', name, data: { key: keyId, ...data } },
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  };
}
