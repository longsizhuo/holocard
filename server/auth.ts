/**
 * 用 involutionhell（IH）账号登录：IH 通行证
 *
 * 协议是授权码 + PKCE（S256）：/auth/login 跳到 IH 的授权页，用户在那边确认，
 * IH 带着一次性的授权码跳回 /auth/callback，服务端再拿授权码、client secret、PKCE verifier
 * 直接找同机的 IH 后端（127.0.0.1:8080）换用户信息。之后发这个站自己的会话，IH 的登录态（satoken）从不经过这里。
 *
 * 两个 cookie 都用 __Host- 前缀（必须 Secure、Path=/、不带 Domain）：
 * holocard-staging（跑着没合并的代码）、invite 这些兄弟子域能写 .longsizhuo.com 的 cookie，
 * 没有这个前缀，它们就能盖掉 state 把访客登进别人的账号，或者塞一个会话进来
 */

import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = '__Host-hc_session';
export const STATE_COOKIE = '__Host-hc_state';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 在 IH 那边确认、登录（可能还要走一遍 GitHub）给 10 分钟 */
export const STATE_TTL_S = 600;

/** 32 字节随机数，base64url（43 个字符）。会话口令、state、PKCE verifier 都用它 */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 库里只存会话口令的哈希：库文件泄露了，拿到的也不是能用的会话 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    // 同名的以第一个为准：浏览器把更具体（Path 更长）的排在前面
    if (name && !(name in cookies)) cookies[name] = part.slice(at + 1).trim();
  }
  return cookies;
}

export function cookie(name: string, value: string, maxAgeS: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`;
}

/** 登录前停在哪，登录完回哪。只认本站路径：//evil.com、/\evil.com 看着像相对路径，其实会跳到外站 */
export function safeNext(next: string | null, origin: string): string {
  if (!next?.startsWith('/')) return '/';
  try {
    const url = new URL(next, origin);
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}

export interface LoginState {
  state: string;
  verifier: string;
  next: string;
}

export function encodeState(value: LoginState): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeState(raw: string | undefined): LoginState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<LoginState>;
    return typeof value.state === 'string' && typeof value.verifier === 'string' && typeof value.next === 'string'
      ? { state: value.state, verifier: value.verifier, next: value.next }
      : null;
  } catch {
    return null;
  }
}

export interface IhUser {
  /** IH 的 user_accounts.id */
  id: string;
  name: string;
  avatar: string | null;
}

/**
 * 拿授权码换用户。IH 后端返回 ApiResponse：{ success, message, data: { sub, username, displayName, avatarUrl } }。
 * 换不到（码过期、用过了、secret 不对、IH 挂了）一律返回 null
 */
export async function exchangeCode(o: {
  tokenUrl: string;
  clientId: string;
  secret: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<IhUser | null> {
  try {
    const res = await fetch(o.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: o.clientId,
        clientSecret: o.secret,
        code: o.code,
        codeVerifier: o.verifier,
        redirectUri: o.redirectUri,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      data?: { sub?: unknown; username?: unknown; displayName?: unknown; avatarUrl?: unknown };
    } | null;
    const data = body?.success ? body.data : undefined;
    if (!res.ok || !data || typeof data.sub !== 'string' || !/^\d{1,19}$/.test(data.sub)) return null;
    const name = [data.displayName, data.username].find((v): v is string => typeof v === 'string' && v.trim() !== '');
    const avatar = typeof data.avatarUrl === 'string' && data.avatarUrl.startsWith('https://') ? data.avatarUrl : null;
    return { id: data.sub, name: (name ?? `#${data.sub}`).slice(0, 80), avatar };
  } catch {
    return null;
  }
}
