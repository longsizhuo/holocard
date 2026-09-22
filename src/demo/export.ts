/**
 * 导出动图：看用户在什么设备上，给能直接进相册的格式
 *   iPhone / iPad  实况照片：一张 JPEG + 一段 MOV，交给系统分享面板「存储」，
 *                  「照片」按两个文件里相同的标识把它们合成一张实况照片
 *   安卓            动态照片：一个 JPEG（末尾接着视频），直接下载
 *   电脑            APNG，后缀 .png，直接下载
 * 文件都在服务端生成（server/export.ts），这里只负责提交、等待、交到用户手上。
 */

export type ExportFormat = 'live' | 'motion' | 'apng';

export type Platform = 'ios' | 'android' | 'desktop';

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS 13 起默认把自己报成 Mac，只能靠触点数认出来
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

export const FORMAT_FOR: Record<Platform, ExportFormat> = {
  ios: 'live',
  android: 'motion',
  desktop: 'apng',
};

/**
 * 在不让下载的内置浏览器里：返回 App 的名字，否则 null。
 * 微信、QQ 的内置浏览器既拦下载，也不支持系统分享面板，只能请用户换到浏览器里打开。
 * QQ 要排除 QQ 浏览器（UA 里是 MQQBrowser），那是正经浏览器。
 */
export function blockingInAppBrowser(): string | null {
  const ua = navigator.userAgent;
  if (/MicroMessenger/i.test(ua)) return '微信';
  if (/\sQQ\//.test(ua)) return 'QQ';
  return null;
}

export interface ExportedFile {
  url: string;
  /** 下载时的文件名 */
  name: string;
  type: string;
}

interface ExportStatus {
  state: 'none' | 'queued' | 'running' | 'done' | 'error';
  position?: number;
  files?: ExportedFile[];
  error?: string;
}

/** 轮询间隔。生成要十几到几十秒，一秒半问一次足够 */
const POLL_INTERVAL_MS = 1500;
/** 总超时，和服务端的导出超时对齐再多留一点排队的余量 */
const TIMEOUT_MS = 6 * 60 * 1000;

async function call(url: string, method: 'GET' | 'POST'): Promise<ExportStatus> {
  const res = await fetch(url, { method });
  const body = (await res.json().catch(() => ({}))) as ExportStatus & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** 提交导出并等到生成好，返回文件列表。onWait 在排队 / 生成中时回调，给界面更新文字用 */
export async function requestExport(
  id: string,
  format: ExportFormat,
  onWait?: (state: 'queued' | 'running') => void,
): Promise<ExportedFile[]> {
  const url = `${import.meta.env.BASE_URL}api/cards/${id}/export/${format}`;
  const deadline = Date.now() + TIMEOUT_MS;
  let status = await call(url, 'POST');
  while (status.state === 'queued' || status.state === 'running') {
    onWait?.(status.state);
    if (Date.now() > deadline) throw new Error('等太久了，稍后再试');
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    status = await call(url, 'GET');
  }
  if (status.state === 'done' && status.files?.length) return status.files;
  // none：服务重启把排着的请求丢了
  throw new Error(status.error ?? '服务刚重启过，再点一次');
}

/** 下载一个文件。同源地址配 download 属性，浏览器直接存，不跳页面 */
export function download(file: ExportedFile): void {
  const a = document.createElement('a');
  a.href = file.url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

/** 把文件取成 File 对象，交给系统分享面板 */
export async function fetchFiles(files: ExportedFile[]): Promise<File[]> {
  return Promise.all(
    files.map(async (file) => {
      const res = await fetch(file.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new File([await res.blob()], file.name, { type: file.type });
    }),
  );
}
