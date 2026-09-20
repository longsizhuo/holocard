/**
 * 分层服务的客户端
 *
 * 服务端跑完整条流水线，浏览器一个字节的模型都不用下。
 * 接口是「提交 + 轮询」：处理要几秒到几十秒，长连接容易被中间层掐断。
 *
 * 服务不可用时抛 ServerUnavailableError，调用方据此回退到浏览器端流水线
 * （自托管、纯静态部署的场景下本来就没有后端）。
 */

/** 服务端不可用——没部署、掉线、或者忙不过来。调用方应当回退，而不是报错 */
export class ServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerUnavailableError';
  }
}

export interface ServerProgress {
  detail: string;
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

const STAGE_TEXT: Record<string, string> = {
  'loading-model': '服务端正在加载模型',
  'estimating-depth': '服务端正在估计深度',
  analyzing: '正在分析深度分布',
  extracting: '正在切层与补洞',
  done: '完成',
};

/** 轮询间隔。处理通常几秒，一秒一次既不浪费也不显迟钝 */
const POLL_INTERVAL_MS = 1000;
/** 总超时。超过就认为服务端卡死了 */
const TIMEOUT_MS = 5 * 60 * 1000;

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

  onProgress?.({ detail: '正在上传' });

  let created: Response;
  try {
    created = await fetch(`${base}api/jobs`, {
      method: 'POST',
      body: file,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // 网络层就失败了：没部署后端，或者离线
    throw new ServerUnavailableError(
      `连不上分层服务：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (created.status === 404 || created.status === 502 || created.status === 503) {
    const body = await created.json().catch(() => ({}) as { error?: string });
    throw new ServerUnavailableError(body.error ?? `分层服务不可用（HTTP ${created.status}）`);
  }
  if (!created.ok) {
    // 4xx 是这张图本身的问题（太大、格式不认），回退到浏览器端也一样会失败
    const body = await created.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error ?? `上传失败（HTTP ${created.status}）`);
  }

  const { id, deleteToken } = (await created.json()) as { id: string; deleteToken: string };
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS, signal);

    let res: Response;
    try {
      res = await fetch(`${base}api/jobs/${id}`, signal ? { signal } : {});
    } catch (error) {
      throw new ServerUnavailableError(
        `轮询中断：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!res.ok) {
      throw new ServerUnavailableError(`查询任务失败（HTTP ${res.status}）`);
    }

    const status = (await res.json()) as JobStatus;

    if (status.state === 'queued') {
      onProgress?.({ detail: `排队中（前面还有 ${Math.max(0, status.position - 1)} 个）` });
    } else if (status.state === 'running') {
      onProgress?.({ detail: STAGE_TEXT[status.stage ?? ''] ?? '服务端处理中' });
    } else if (status.state === 'done' && status.layers) {
      onProgress?.({ detail: '正在取回分层结果', ratio: 0.95 });
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
  if (!token) throw new Error('这台设备上没有这张卡的删除口令');

  const res = await fetch(`${import.meta.env.BASE_URL}api/cards/${id}`, {
    method: 'DELETE',
    headers: { 'x-holocard-token': token },
  });
  if (!res.ok && res.status !== 404) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `删除失败（HTTP ${res.status}）`);
  }
  // 404 说明已经被清理过了，对用户来说结果一样
  forgetOwned(id);
}
