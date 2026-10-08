/**
 * 分层服务的客户端
 *
 * 服务端跑完整条流水线，浏览器一个字节的模型都不用下。
 * 接口是「提交 + 轮询」：处理要几秒到几十秒，长连接容易被中间层掐断。
 *
 * 只有部署里压根没有分层服务（纯静态自托管）时才抛 NoBackendError，调用方据此回退到浏览器端流水线。
 * 服务端临时不行（发版重启、排队满、网络抖动）一律报错让人稍后再试，不回退：
 * 回退要下约 50MB 模型，用户大多在手机上，流量和内存都吃不消，而服务端过一会儿就好了。
 *
 * 这里不产出任何给人看的文字：进度给的是文案的键，错误带服务端的 code，
 * 由界面按当前语言翻译（见 src/i18n）。
 */

import { lang, type MessageKey } from '../i18n';
import type { CardConfig } from '../format/config';

/** 这个部署没有分层服务。只有这种情况调用方才回退到浏览器端 */
export class NoBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoBackendError';
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
  /** 服务端估计还要多少秒（排队 + 处理），倒计时用；老版本服务端不给 */
  eta?: number;
}

interface JobStatus {
  state: 'queued' | 'running' | 'done' | 'error';
  stage: string | null;
  position: number;
  eta?: number;
  layers?: string;
  layerCount?: number;
  error?: string;
}

const STAGE_KEYS: Record<string, MessageKey> = {
  'loading-model': 'stage.loading-model',
  'estimating-depth': 'stage.estimating-depth',
  analyzing: 'stage.analyzing',
  'finding-subject': 'stage.finding-subject',
  extracting: 'stage.extracting',
  done: 'stage.done',
};

/** 轮询间隔。处理要几十秒，一秒一次既不浪费也不显迟钝 */
const POLL_INTERVAL_MS = 1000;
/**
 * 总超时。超过就认为服务端卡死了。
 * 排队的时间不算：服务端一张要半分钟以上（抠主体占大头），队列满 12 张时排在最后的要等七八分钟，
 * 那是在正常排队，不是卡死。只要轮询还能拿到「排队中」，就从头计时
 */
const TIMEOUT_MS = 5 * 60 * 1000;
/** 轮询连续失败多久才放弃，见 segmentOnServer 里的说明 */
const POLL_GIVE_UP_MS = 60 * 1000;
/** 提交遇到网络断开或 5xx 时的重试间隔。发版重启一两秒就好，合计约 10 秒够了 */
const SUBMIT_RETRY_MS = [1000, 3000, 6000];

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
  /**
   * 删除口令。服务端只在提交响应里给这一次，丢了就再也拿不到。
   * 登录着做的卡没有口令（null）：它直接归到账号下，主人认的是登录状态
   */
  deleteToken: string | null;
}

/**
 * 提交图片。网络断开、5xx 这类一会儿就好的失败自动重试几次，还不行就抛错。
 * 排队满不重试：每次重试都要把整张照片重传一遍（Cloudflare 先收完请求体才回源），
 * 手机上几次下来的流量和下模型差不多了，不如直接告诉人稍后再试。
 */
async function submitJob(
  file: Blob,
  onProgress?: (p: ServerProgress) => void,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let failure: unknown;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/jobs`, {
        method: 'POST',
        body: file,
        headers: apiHeaders(),
        ...(signal ? { signal } : {}),
      });
      // 纯静态托管对 POST 回 404/405；开发时没起 pnpm dev:server，Vite 的代理回 502
      if (res.status === 404 || res.status === 405 || (import.meta.env.DEV && res.status === 502)) {
        throw new NoBackendError(`没有分层服务（HTTP ${res.status}）`);
      }
      if (res.status < 502) return res;
      const error = await apiError(res, `分层服务暂时不可用（HTTP ${res.status}）`);
      // Caddy / Cloudflare 回的 502、52x 没有 code，补一个，界面才翻译得了
      failure = error.code ? error : new ApiError(error.message, 'server_unavailable');
    } catch (error) {
      if (error instanceof NoBackendError || signal?.aborted) throw error;
      // 网络层失败：离线，或者手机信号抖了一下
      failure = error;
    }

    const wait = SUBMIT_RETRY_MS[attempt];
    // 排队满、盘满都不重试：每次重试都要把整张照片重传一遍，等几秒也好不了
    if (wait === undefined || (failure instanceof ApiError && (failure.code === 'queue_full' || failure.code === 'disk_full'))) {
      throw failure;
    }
    onProgress?.({ key: 'progress.reconnecting' });
    await sleep(wait, signal);
  }
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
  const created = await submitJob(file, onProgress, signal);
  if (!created.ok) {
    // 剩下的是这张图本身的问题（太大、格式不认）或提交太频繁，重试也没用
    throw await apiError(created, `上传失败（HTTP ${created.status}）`);
  }

  const { id, deleteToken } = (await created.json()) as { id: string; deleteToken: string | null };
  let deadline = Date.now() + TIMEOUT_MS;
  /*
   * 连续失败从什么时候开始算。
   *
   * 任务已经交出去了，服务端在处理——轮询偶尔失败一次（网络抖一下、发版重启那几秒、
   * Cloudflare 回源超时）不代表服务端没了。以前一次失败就退回浏览器端，
   * 用户白下 50MB 模型，服务端做好的卡也扔了（埋点里查到过好几次）。
   * 现在连续失败超过 POLL_GIVE_UP_MS 才报错（也不再回退）；任务在服务端是持久化的，重启后会接着做。
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
        throw new ApiError(`轮询中断：${failure}`, 'server_unavailable');
      }
      onProgress?.({ key: 'progress.reconnecting' });
      continue;
    }
    failingSince = null;

    const status = (await res.json()) as JobStatus;

    if (status.state === 'queued') {
      deadline = Date.now() + TIMEOUT_MS;
      onProgress?.({
        key: 'progress.queued',
        params: { n: Math.max(0, status.position - 1) },
        ...(status.eta === undefined ? {} : { eta: status.eta }),
      });
    } else if (status.state === 'running') {
      onProgress?.({
        key: STAGE_KEYS[status.stage ?? ''] ?? 'progress.serverWorking',
        ...(status.eta === undefined ? {} : { eta: status.eta }),
      });
    } else if (status.state === 'done' && status.layers) {
      onProgress?.({ key: 'progress.fetching' });
      // 服务端返回的是绝对路径，base 已经包含在里面
      return { layers: status.layers, id, deleteToken };
    } else if (status.state === 'error') {
      throw new Error(status.error ?? '服务端处理失败');
    }
  }

  throw new ApiError('服务端处理超时', 'server_unavailable');
}

/*
 * 删除口令存在 localStorage 里。
 *
 * 不登录时，一张卡的「所有者」就是「手上有口令的人」（登录以后见文件末尾）。口令由服务端在
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

/**
 * 口令在内存里也存一份。浏览器存不了站点数据（隐私模式、屏蔽了 Cookie、有的 App 内置浏览器）时
 * localStorage 写不进去，以前只是「这台设备上没有删除入口」；现在分享也认口令，
 * 没有这一份的话，做完卡连自动分享都会被拒
 */
const ownedInMemory = new Map<string, string>();

export function rememberOwned(id: string, token: string): void {
  ownedInMemory.set(id, token);
  try {
    const owned = readOwned();
    owned[id] = token;
    localStorage.setItem(OWNED_KEY, JSON.stringify(owned));
  } catch {
    // 存不下就算了，只是这台设备上没有删除入口
  }
}

/** 这台设备上有口令的卡，最新的在前。存的顺序就是做好的先后（对象的字符串键按插入顺序遍历） */
function localCards(): string[] {
  return Object.keys(readOwned()).reverse();
}

/** 卡册里的卡：账号名下的在前（服务端按做好的先后排），再是这台设备上还没放进账号的 */
export function ownedCards(): string[] {
  return [...accountCards, ...unclaimedCards()];
}

/** 这台设备上有口令、还没放进账号的卡 */
export function unclaimedCards(): string[] {
  return localCards().filter((id) => !accountCards.includes(id));
}

/** 这张卡是不是我的：这台设备上有它的口令，或者它在登录着的账号名下 */
export function isMine(id: string): boolean {
  return ownedToken(id) !== null || accountCards.includes(id);
}

/** 带上口令（有的话）。没有口令的是账号名下的卡，会话 cookie 浏览器自己会带 */
function ownerHeaders(id: string): Record<string, string> {
  const token = ownedToken(id);
  return token ? { ...apiHeaders(), 'x-holocard-token': token } : apiHeaders();
}

export function ownedToken(id: string): string | null {
  return ownedInMemory.get(id) ?? readOwned()[id] ?? null;
}

export function forgetOwned(id: string): void {
  ownedInMemory.delete(id);
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
  if (!isMine(id)) throw new ApiError('这台设备上没有这张卡的删除口令', 'no_token');

  const res = await fetch(`${import.meta.env.BASE_URL}api/cards/${id}`, {
    method: 'DELETE',
    headers: ownerHeaders(id),
  });
  if (!res.ok && res.status !== 404) {
    throw await apiError(res, `删除失败（HTTP ${res.status}）`);
  }
  // 404 说明已经被清理过了，对用户来说结果一样
  forgetOwned(id);
  accountCards = accountCards.filter((card) => card !== id);
}

/**
 * 存作者配置（箔面、炫光、视差）。分享页、预览图、导出的动图都按存进去的来。
 * keepalive：页面关掉时还在路上的那次也要送到，不然最后一下调整就丢了
 */
export async function saveConfig(id: string, config: CardConfig): Promise<void> {
  if (!isMine(id)) return;
  const res = await fetch(`${import.meta.env.BASE_URL}api/cards/${id}/config`, {
    method: 'PUT',
    headers: { ...ownerHeaders(id), 'content-type': 'application/json' },
    body: JSON.stringify(config),
    keepalive: true,
  });
  if (!res.ok) throw await apiError(res, `保存失败（HTTP ${res.status}）`);
}

/** 分享一张自己的卡：转成长期保留、公开卡片页（服务端认口令或登录状态） */
export async function shareCard(id: string): Promise<void> {
  const res = await fetch(`${import.meta.env.BASE_URL}api/cards/${id}/share`, { method: 'POST', headers: ownerHeaders(id) });
  if (!res.ok) throw await apiError(res, `HTTP ${res.status}`);
}

/*
 * 用 involutionhell 账号登录（见 server/account/auth.ts）。登录是可选的，不登录照常用。
 * 登录着做的卡直接归到账号下（服务端不再给口令），换设备登录也能看到、管理；
 * 这台设备上以前做的卡，要用户自己勾选认领进来——公用电脑上留着别人的卡，不能一登录就收走。
 */
export interface Account {
  id: string;
  name: string;
  avatar: string | null;
}

/** 这个部署开没开登录、现在是谁 */
let me: { login: boolean; user: Account | null } = { login: false, user: null };
/** 账号名下还在的卡，最新的在前 */
let accountCards: string[] = [];

export function account(): { login: boolean; user: Account | null } {
  return me;
}

/** 问一下服务端现在是谁。慢了不等：首屏不能被它卡住，超时就先按没登录算 */
export async function loadMe(timeoutMs = 2000): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/me`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return;
    const body = (await res.json()) as { login?: unknown; user?: Account | null; cards?: unknown };
    me = { login: body.login === true, user: body.user ?? null };
    accountCards = Array.isArray(body.cards) ? body.cards.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // 没有服务端（纯静态托管）、网络慢：按没登录算
  }
}

/** 登录入口。登录完回到 next（只能是本站路径，服务端会再查一遍） */
export function loginHref(next: string): string {
  return `${import.meta.env.BASE_URL}auth/login?next=${encodeURIComponent(next)}`;
}

export async function logout(): Promise<void> {
  await fetch(`${import.meta.env.BASE_URL}auth/logout`, { method: 'POST', headers: apiHeaders() }).catch(() => undefined);
  me = { ...me, user: null };
  accountCards = [];
}

/** 登录着刚做好的卡：服务端已经把它归到账号下了，卡册里马上要有 */
export function rememberAccountCard(id: string): void {
  if (!accountCards.includes(id)) accountCards.unshift(id);
}

/** 把这台设备上的卡认领到账号下。认领成功的，服务端换了口令，本机这份旧口令删掉 */
export async function claimCards(ids: string[]): Promise<string[]> {
  const cards = ids.flatMap((id) => {
    const token = ownedToken(id);
    return token ? [{ id, token }] : [];
  });
  const res = await fetch(`${import.meta.env.BASE_URL}api/me/claim`, {
    method: 'POST',
    headers: { ...apiHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ cards }),
  });
  if (!res.ok) throw await apiError(res, `HTTP ${res.status}`);
  const { claimed } = (await res.json()) as { claimed: string[] };
  for (const id of claimed) forgetOwned(id);
  // 顺序以服务端为准（按做好的先后），重新拉一次
  await loadMe();
  return claimed;
}

/** 个人中心里的对外接口 key（服务端见 handleMyKeys）。key 本身只在申请那一次的响应里有 */
export interface MyKey {
  id: string;
  createdAt: string;
}

/** 还能用的 key 和账号的额度：几个 key 共用，dailyLimit 为 null 是不限（管理员） */
export interface MyKeys {
  keys: MyKey[];
  used: number;
  dailyLimit: number | null;
}

export async function myKeys(): Promise<MyKeys> {
  const res = await fetch(`${import.meta.env.BASE_URL}api/me/keys`, { headers: apiHeaders() });
  if (!res.ok) throw await apiError(res, `HTTP ${res.status}`);
  return (await res.json()) as MyKeys;
}

export async function requestKey(): Promise<{ id: string; key: string }> {
  const res = await fetch(`${import.meta.env.BASE_URL}api/me/keys`, { method: 'POST', headers: apiHeaders() });
  if (!res.ok) throw await apiError(res, `HTTP ${res.status}`);
  return (await res.json()) as { id: string; key: string };
}

export async function revokeKey(id: string): Promise<void> {
  const res = await fetch(`${import.meta.env.BASE_URL}api/me/keys/${id}`, { method: 'DELETE', headers: apiHeaders() });
  if (!res.ok) throw await apiError(res, `HTTP ${res.status}`);
}
