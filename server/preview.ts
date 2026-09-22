/**
 * 服务端渲染：OG 预览图，以及导出动图时的逐帧画面
 *
 * 分享链接在微信、Twitter 里有没有大图预览，直接决定点击率——这是裂变的命门。
 * 所以预览图用无头 Chromium 真渲染：打开 /render/<id>，等卡片摆好姿态，截一张。
 * 这样预览图里的箔面、炫光、分层视差和用户实际看到的是同一套渲染，不是另画一张近似图。
 * 导出动图（export.ts）走的也是这个页面，只是逐帧换姿态、截很多张。
 *
 * 浏览器常驻复用：冷启动约 300ms，每张卡省下来的就是这些。
 * 空闲一段时间后关掉，别让它白占内存——这台机器还跑着别的东西。
 */

import { chromium, type Browser, type Page } from 'playwright-core';

/** OG 图的标准尺寸，微信、Twitter、Telegram 都按这个比例裁 */
export const PREVIEW_WIDTH = 1200;
export const PREVIEW_HEIGHT = 630;

/** 空闲这么久就把浏览器关掉 */
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
/** 打开渲染页、等卡片就绪的超时。正常一两秒，超过这个多半是卡死了 */
const RENDER_TIMEOUT_MS = 45_000;

/**
 * 用哪个浏览器。留空则用 Playwright 自带的 Chromium（服务器上就是这样）；
 * 本地开发机上没装那份 Chromium，可以设成 msedge 之类复用系统浏览器。
 *
 * 用到时才读，不在模块加载时定死：scripts/og-preview.ts 要在 import 之后才按平台补默认值。
 */
function browserChannel(): string {
  return process.env.HOLOCARD_BROWSER_CHANNEL ?? '';
}

let browser: Browser | null = null;
let idleTimer: NodeJS.Timeout | null = null;
/** 正在用浏览器的任务数。导出一张动图要好几十秒，不能让空闲计时器在半路把浏览器关了 */
let active = 0;

/**
 * 正在进行的那次启动。导出时两个页面几乎同时要浏览器，不共用这一次启动的话，
 * 两边都看到「还没有」、各起一个，先起的那个没人管，一直挂在后台（实测踩到过）。
 */
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  const channel = browserChannel();
  launching ??= chromium
    .launch({
      headless: true,
      ...(channel ? { channel } : {}),
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        /*
         * 这台是没有显卡的 ARM 服务器。不加这三个，headless shell 截图会直接报
         * 「Unable to capture screenshot」——箔面用到的 mix-blend-mode 和 filter
         * 需要一个能用的合成器，swiftshader 软件渲染正好顶上。
         */
        '--disable-gpu',
        '--use-gl=swiftshader',
        '--in-process-gpu',
      ],
    })
    .then((launched) => {
      browser = launched;
      return launched;
    })
    .finally(() => {
      launching = null;
    });
  return launching;
}

function scheduleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (active > 0) {
      scheduleShutdown();
      return;
    }
    void browser?.close().catch(() => undefined);
    browser = null;
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref();
}

export interface RenderPageOptions {
  /** 视口尺寸（CSS 像素） */
  width: number;
  height: number;
  /** 像素密度。截出来的图尺寸 = 视口 × 它 */
  scale: number;
  /** 渲染页地址上的查询参数，比如 { pose: '78,22' }、{ export: 'phone' } */
  query?: Record<string, string>;
}

/**
 * 打开一张卡的渲染页，等所有层解码完、姿态摆好，再交给 work 去截图。
 * baseUrl 指向本服务自己（127.0.0.1:端口），渲染页走的是和用户完全一样的前端代码。
 */
export async function withRenderPage<T>(
  baseUrl: string,
  id: string,
  options: RenderPageOptions,
  work: (page: Page) => Promise<T>,
): Promise<T> {
  active++;
  if (idleTimer) clearTimeout(idleTimer);
  let page: Page | null = null;
  try {
    page = await (await getBrowser()).newPage({
      viewport: { width: options.width, height: options.height },
      deviceScaleFactor: options.scale,
    });
    const query = new URLSearchParams(options.query ?? {}).toString();
    await page.goto(`${baseUrl}/render/${id}${query ? `?${query}` : ''}`, {
      waitUntil: 'domcontentloaded',
      timeout: RENDER_TIMEOUT_MS,
    });

    // 前端在所有层解码完、姿态摆好之后才置这个标记，不靠猜时间
    await page.waitForFunction(() => document.body.dataset['ready'] !== undefined, undefined, {
      timeout: RENDER_TIMEOUT_MS,
    });
    if ((await page.evaluate(() => document.body.dataset['ready'])) === 'error') {
      throw new Error('渲染页加载卡片失败');
    }
    return await work(page);
  } finally {
    await page?.close().catch(() => undefined);
    active--;
    scheduleShutdown();
  }
}

export interface PreviewOptions {
  /** 画布尺寸。默认是 OG 标准的 1200×630；GitHub 仓库的社交预览图要 1280×640 */
  width?: number;
  height?: number;
  format?: 'jpeg' | 'png';
  /**
   * 卡片姿态：指针落在卡面上的百分比位置。不给就用渲染页的默认姿态（和线上分享图一致）。
   * 调分享图时用来看不同角度下箔面和炫光的样子。
   */
  pose?: { x: number; y: number };
}

/** 渲染一张卡的预览图 */
export async function renderPreview(
  baseUrl: string,
  id: string,
  options: PreviewOptions = {},
): Promise<Buffer> {
  return withRenderPage(
    baseUrl,
    id,
    {
      width: options.width ?? PREVIEW_WIDTH,
      height: options.height ?? PREVIEW_HEIGHT,
      // 截出来的图会被放大显示，2 倍像素密度看着才不糊
      scale: 2,
      query: options.pose ? { pose: `${options.pose.x},${options.pose.y}` } : {},
    },
    async (page) => {
      // 姿态是 setPose 直接写的（不走动画），但样式重算和合成还需要一两帧
      await page.waitForTimeout(250);
      return options.format === 'png'
        ? await page.screenshot({ type: 'png' })
        : await page.screenshot({ type: 'jpeg', quality: 88 });
    },
  );
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  await browser?.close().catch(() => undefined);
  browser = null;
}
