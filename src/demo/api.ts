/**
 * 分层服务的客户端
 *
 * 服务端跑完整条流水线，浏览器一个字节的模型都不用下。
 * 接口是「提交 + 轮询」：处理要几秒到几十秒，长连接容易被中间层掐断。
 *
 * 服务不可用时抛 ServerUnavailableError，调用方据此回退到浏览器端流水线
 * （自托管、纯静态部署的场景下本来就没有后端）。
 *
 * 这里不产出任何给人看的文字：进度给的是文案的键，错误带服务端的 code，
 * 由界面按当前语言翻译（见 src/i18n）。
 */

import { lang, type MessageKey } from '../i18n';

/** 服务端不可用——没部署、掉线、或者忙不过来。调用方应当回退，而不是报错 */
export class ServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerUnavailableError';
  }
}

/**
 * 服务端返回的错误。code 是稳定的错误类型（rate_limited、card_not_found…），
 * 界面按它翻译；认不出的 code 就显示服务端给的原文。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 从错误响应里取出 code 和参数 */
export async function apiError(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    params?: Record<string, string | number>;
  };
  return new ApiError(body.error ?? fallback, body.code, body.params);
}

/** 所有接口请求都带上当前语言，服务端据此决定分享图、导出之类用哪种语言 */
export function apiHeaders(): Record<string, string> {
  return { 'x-holocard-lang': lang() };
}

export interface ServerProgress {
  /** 界面文字的键 */
  key: MessageKey;
  params?: Record<string, string | number>;
  /** 0..1，拿不到确切进度时为 undefined */
  ratio?: number;
}

interface JobStatus {
  state: 'queued' | 'running' | 'done' | 'error';
  stage: string | null;
  position: number;
  layers?: string;
  layerCount?: number;
  error?: string;
}

const STAGE_KEYS: Record<string, MessageKey> = {
  'loading-model': 'stage.loading-model',
  'estimating-depth': 'stage.estimating-depth',
  analyzing: 'stage.analyzing',
  extracting: 'stage.extracting',
  done: 'stage.done',
};

/** 轮询间隔。处理通常几秒，一秒一次既不浪费也不显迟钝 */
const POLL_INTERVAL_MS = 1000;
/** 总超时。超过就认为服务端卡死了 */
const TIMEOUT_MS = 5 * 60 * 1000;
/** 轮询连续失败多久才放弃，见 segmentOnServer 里的说明 */
const POLL_GIVE_UP_MS = 60 * 1000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('已取消', 'AbortError'));
      },
      { once: true },
    );
  });
}

export interface SegmentResult {
  /** .layers 目录的 URL，可直接喂给 loadLayerSet */
  layers: string;
  /** 这张卡的 id */
  id: string;
  /** 删除口令。服务端只在提交响应里给这一次，丢了就再也拿不到 */
  deleteToken: string;
}

/**
 * 把图片交给服务端分层。
 */
export async function segmentOnServer(
  file: Blob,
  onProgress?: (p: ServerProgress) => void,
  signal?: AbortSignal,
): Promise<SegmentResult> {
  const base = import.meta.env.BASE_URL;

  onProgress?.({ key: 'progress.uploading' });

  let created: Response;
  try {
    created = await fetch(`${base}api/jobs`, {
      method: 'POST',
      body: file,
      headers: apiHeaders(),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // 网络层就失败了：没部署后端，或者离线
    throw new ServerUnavailableError(
      `连不上分层服务：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (created.status === 404 || created.status === 502 || created.status === 503) {
    const error = await apiError(created, `分层服务不可用（HTTP ${created.status}）`);
    // 排队满了是服务端明确说「忙」，照样回退；但带上原因，回退也失败时能显示出来
    throw new ServerUnavailableError(error.message);
  }
  if (!created.ok) {
    // 4xx 是这张图本身的问题（太大、格式不认），回退到浏览器端也一样会失败
    throw await apiError(created, `上传失败（HTTP ${created.status}）`);
  }

  const { id, deleteToken } = (await created.json()) as { id: string; deleteToken: string };
  const deadline = Date.now() + TIMEOUT_MS;
  /*
   * 连续失败从什么时候开始算。
   *
   * 任务已经交出去了，服务端在处理——轮询偶尔失败一次（网络抖一下、发版重启那几秒、
   * Cloudflare 回源超时）不代表服务端没了。以前一次失败就退回浏览器端，
   * 用户白下 50MB 模型，服务端做好的卡也扔了（埋点里查到过好几次）。
   * 现在连续失败超过 POLL_GIVE_UP_MS 才放弃；任务在服务端是持久化的，重启后会接着做。
   */
  let failingSince: number | null = null;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS, signal);

    let res: Response | null = null;
    let failure = '';
    try {
      res = await fetch(`${base}api/jobs/${id}`, signal ? { signal } : {});
      if (!res.ok) failure = `HTTP ${res.status}`;
    } catch (error) {
      if (signal?.aborted) throw error;
      failure = error instanceof Error ? error.message : String(error);
    }
    // 404 是真的没有这个任务了（被删或过期），重试也不会好
    if (res?.status === 404) {
      throw await apiError(res, '任务不存在或已过期');
    }
    if (failure || !res) {
      failingSince ??= Date.now();
      if (Date.now() - failingSince > POLL_GIVE_UP_MS) {
        throw new ServerUnavailableError(`轮询中断：${failure}`);
      }
      onProgress?.({ key: 'progress.reconnecting' });
      continue;
    }
    failingSince = null;

    const status = (await res.json()) as JobStatus;

    if (status.state === 'queued') {
      onProgress?.({ key: 'progress.queued', params: { n: Math.max(0, status.position - 1) } });
    } else if (status.state === 'running') {
      onProgress?.({ key: STAGE_KEYS[status.stage ?? ''] ?? 'progress.serverWorking' });
    } else if (status.state === 'done' && status.layers) {
      onProgress?.({ key: 'progress.fetching', ratio: 0.95 });
      // 服务端返回的是绝对路径，base 已经包含在里面
      return { layers: status.layers, id, deleteToken };
    } else if (status.state === 'error') {
      throw new Error(status.error ?? '服务端处理失败');
    }
  }

  throw new ServerUnavailableError('服务端处理超时');
}

/*
 * 删除口令存在 localStorage 里。
 *
 * 这个站没有账号，一张卡的「所有者」就是「手上有口令的人」。口令由服务端在
 * 提交响应里给一次，别处再也拿不到，所以这里必须存下来——否则用户想删自己
 * 上传的东西时无从下手。清了浏览器数据就等于放弃了删除权，这一点在页面上写明。
 */
const OWNED_KEY = 'holocard:owned';

type OwnedMap = Record<string, string>;

function readOwned(): OwnedMap {
  try {
    const raw = localStorage.getItem(OWNED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === 'object' && parsed !== null ? (parsed as OwnedMap) : {};
  } catch {
    // 隐私模式下 localStorage 可能直接抛
    return {};
  }
}

export function rememberOwned(id: string, token: string): void {
  try {
    const owned = readOwned();
    owned[id] = token;
    localStorage.setItem(OWNED_KEY, JSON.stringify(owned));
  } catch {
    // 存不下就算了，只是这台设备上没有删除入口
  }
}

export function ownedToken(id: string): string | null {
  return readOwned()[id] ?? null;
}

export function forgetOwned(id: string): void {
  try {
    const owned = readOwned();
    delete owned[id];
    localStorage.setItem(OWNED_KEY, JSON.stringify(owned));
  } catch {
    // 同上
  }
}

/** 删除一张自己的卡。口令不对或卡不存在时抛错 */
export async function deleteCard(id: string): Promise<void> {
  const token = ownedToken(id);
  if (!token) throw new ApiError('这台设备上没有这张卡的删除口令', 'no_token');

  const res = await fetch(`${import.meta.env.BASE_URL}api/cards/${id}`, {
    method: 'DELETE',
    headers: { ...apiHeaders(), 'x-holocard-token': token },
  });
  if (!res.ok && res.status !== 404) {
    throw await apiError(res, `删除失败（HTTP ${res.status}）`);
  }
  // 404 说明已经被清理过了，对用户来说结果一样
  forgetOwned(id);
}
