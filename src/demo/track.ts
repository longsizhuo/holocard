/**
 * 埋点
 *
 * 用自建的 umami（umami.involutionhell.com），不是第三方 SaaS——数据留在自己机器上，
 * 也不用给用户塞第三方 cookie。umami 本身不用 cookie、不存 IP，所以不需要同意横幅。
 *
 * 脚本是按需注入的，不写死在 index.html 里：
 *   - 没配 VITE_UMAMI_ID 时一个字节都不加载，别人自托管这个项目不会被动连到我们的统计
 *   - /render/<id>（服务端截 OG 图的无头页面）也不加载，那不是真人访问，会把数据打歪
 *
 * 统计脚本连不上时静默失败：它不该影响这个页面的任何功能。
 */

const SCRIPT_URL = 'https://umami.involutionhell.com/script.js';

/** umami 的站点 id，构建时注入。留空表示不启用统计 */
const WEBSITE_ID = import.meta.env.VITE_UMAMI_ID ?? '';

/** umami 的 track()：可以传事件名，也可以传一个改写默认属性的函数 */
type TrackPayload = Record<string, unknown>;
type TrackFn = {
  (event: string, data?: TrackPayload): void;
  (update: (props: TrackPayload) => TrackPayload): void;
};

declare global {
  interface Window {
    umami?: { track: TrackFn };
  }
}

/*
 * 脚本是 async 注入的，而首屏的页面浏览紧接着就要上报——那一刻 window.umami
 * 还不存在，直接调用会被静默丢掉（第一版就是这么丢的：线上只收到了用户手动触发
 * 的事件，一条 pageview 都没有）。所以先排队，脚本 load 之后再回放。
 */
type Queued = () => void;
let queue: Queued[] | null = [];

function run(fn: Queued): void {
  if (queue) queue.push(fn);
  else fn();
}

/**
 * 本机和局域网地址上不上报。
 *
 * 本地用生产配置构建（pnpm build 会读 .env.production）时站点 id 也在，
 * 以前在 127.0.0.1 上测试的访问和事件全进了线上统计（查埋点时翻出过 27 条）。
 * 不写死线上域名：别人自托管到自己的域名上，统计照样要能用。
 */
function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname === '[::1]' ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)
  );
}

/** 注入统计脚本。render 模式下不要调用 */
export function initTracking(): void {
  if (!WEBSITE_ID || isLocalHost(location.hostname)) return;

  const script = document.createElement('script');
  script.async = true;
  script.defer = true;
  script.src = SCRIPT_URL;
  script.dataset['websiteId'] = WEBSITE_ID;
  /*
   * 关掉自动追踪：这个站只有 /、/c/<id> 两种页面，而每张卡的 id 都不一样，
   * 让 umami 把它们当成几千个独立页面没有意义，反而把页面列表冲垮。
   * 页面浏览由下面的 pageView() 手动上报，把 /c/<uuid> 归一成 /c。
   */
  script.dataset['autoTrack'] = 'false';

  script.addEventListener('load', () => {
    const pendingCalls = queue ?? [];
    queue = null;
    for (const fn of pendingCalls) fn();
  });
  script.addEventListener('error', () => {
    // 连不上就把队列丢掉，别让它一直攒着
    queue = null;
  });

  document.head.append(script);
}

/**
 * 上报一次页面浏览，把地址栏里的路径改写成 path。
 *
 * 必须用这个「改写默认属性」的函数形式：track('/c') 会被当成一个**名叫 /c 的事件**，
 * 而 url_path 仍然记成浏览器地址栏里那个带 uuid 的原始路径，两头都不对。
 *
 * 这里只改 url，不塞别的字段——pageview 的 payload 只认固定的那几个键，
 * 多出来的会被服务端静默丢掉（试过塞卡片 id，落库之后是空的）。
 * 要带数据就走下面的 track()。
 */
export function pageView(path: string): void {
  run(() => {
    window.umami?.track((props) => ({ ...props, url: path }));
  });
}

/** 上报一个自定义事件 */
export function track(event: string, data?: TrackPayload): void {
  run(() => {
    window.umami?.track(event, data);
  });
}
