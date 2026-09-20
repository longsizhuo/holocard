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

declare global {
  interface Window {
    umami?: {
      track: (event: string, data?: Record<string, unknown>) => void;
    };
  }
}

let enabled = false;

/** 注入统计脚本。render 模式下不要调用 */
export function initTracking(): void {
  if (!WEBSITE_ID) return;

  const script = document.createElement('script');
  script.async = true;
  script.defer = true;
  script.src = SCRIPT_URL;
  script.dataset['websiteId'] = WEBSITE_ID;
  /*
   * 关掉自动路由追踪：这个站只有 /、/c/<id> 两种页面，而每张卡的 id 都不一样，
   * 让 umami 把它们当成几千个独立页面没有意义，反而把页面列表冲垮。
   * 页面浏览由下面的 pageView() 手动上报，把 /c/<uuid> 归一成一条。
   */
  script.dataset['autoTrack'] = 'false';
  script.addEventListener('error', () => {
    enabled = false;
  });
  document.head.append(script);
  enabled = true;
}

/**
 * 上报一次页面浏览。
 * url 传归一化之后的路径（/c/<uuid> → /c），卡片 id 作为事件数据带上，
 * 这样既能看某张卡的热度，页面列表又不会被 uuid 撑爆。
 */
export function pageView(path: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  window.umami?.track(path, data);
}

/** 上报一个自定义事件 */
export function track(event: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  window.umami?.track(event, data);
}
