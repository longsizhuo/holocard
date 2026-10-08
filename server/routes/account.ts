/**
 * 账号相关的路由：/auth/*（登录、回调、退出）和 /api/me/*（当前账号、认领、个人中心的 API key）
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LANG_TAG, translate } from '../../src/i18n/core';
import { hashApiKey, newApiKey } from '../account/apikeys';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  STATE_COOKIE,
  STATE_TTL_S,
  cookie,
  decodeState,
  encodeState,
  exchangeCode,
  newSecret,
  parseCookies,
  pkceChallenge,
  safeNext,
  sha256Hex,
  type IhUser,
} from '../account/auth';
import { sessionOf } from '../account/session';
import {
  AUTH_FAKE,
  DAY_MS,
  LOGIN_ENABLED,
  MAX_KEYS_PER_ACCOUNT,
  PUBLIC_ORIGIN,
  SELF_SERVE_DAILY_LIMIT,
  SSO_AUTHORIZE_URL,
  SSO_CLIENT_ID,
  SSO_SECRET,
  SSO_TOKEN_URL,
} from '../config';
import {
  escapeAttr,
  fail,
  json,
  methodNotAllowed,
  readBody,
  requestLang,
  sameOrigin,
  timingSafeEqualStr,
} from '../http';
import { db } from '../store';
import type { CardRow, SessionRow } from '../store/db';

/*
 * 用 IH 账号登录（协议见 auth.ts）。登录永远是可选的，不登录照常做卡。
 *   GET  /auth/login?next=   跳到 IH 的授权页
 *   GET  /auth/callback      IH 带着授权码跳回来：换用户、发会话、回到 next
 *   POST /auth/logout        退出
 */
export async function handleAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const redirectUri = `${PUBLIC_ORIGIN}/auth/callback`;

  if (req.method === 'GET' && url.pathname === '/auth/login') {
    const next = safeNext(url.searchParams.get('next'), PUBLIC_ORIGIN);
    if (AUTH_FAKE) {
      startSession(res, { id: 'staging', name: 'Staging', avatar: null }, next);
      return;
    }
    if (!SSO_SECRET) {
      loginFailed(req, res, url, next);
      return;
    }
    const state = newSecret();
    const verifier = newSecret();
    const target = new URL(SSO_AUTHORIZE_URL);
    target.search = new URLSearchParams({
      client_id: SSO_CLIENT_ID,
      redirect_uri: redirectUri,
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString();
    res.writeHead(302, {
      location: target.toString(),
      'cache-control': 'no-store',
      'set-cookie': cookie(STATE_COOKIE, encodeState({ state, verifier, next }), STATE_TTL_S),
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/auth/callback') {
    const saved = decodeState(parseCookies(req.headers.cookie)[STATE_COOKIE]);
    const code = url.searchParams.get('code') ?? '';
    // state 对不上：不是这个浏览器发起的登录（登录 CSRF），或者在 IH 那边待太久、cookie 过期了
    const user =
      saved && SSO_SECRET && timingSafeEqualStr(url.searchParams.get('state') ?? '', saved.state) && /^[\w-]{20,200}$/.test(code)
        ? await exchangeCode({
            tokenUrl: SSO_TOKEN_URL,
            clientId: SSO_CLIENT_ID,
            secret: SSO_SECRET,
            code,
            verifier: saved.verifier,
            redirectUri,
          })
        : null;
    if (!user) {
      loginFailed(req, res, url, saved?.next ?? '/');
      return;
    }
    console.log(`[auth] 账号 ${user.id} 登录`);
    startSession(res, user, saved?.next ?? '/');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    if (!sameOrigin(req)) {
      fail(res, 403, 'forbidden', '只能从本站页面退出');
      return;
    }
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) db.deleteSession(sha256Hex(token));
    res.writeHead(204, { 'cache-control': 'no-store', 'set-cookie': cookie(SESSION_COOKIE, '', 0) });
    res.end();
    return;
  }

  fail(res, 404, 'not_found', '没有这个地址');
}

function startSession(res: ServerResponse, user: IhUser, next: string): void {
  const token = newSecret();
  const now = Date.now();
  db.insertSession({
    hash: sha256Hex(token),
    user_id: user.id,
    name: user.name,
    avatar: user.avatar,
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
  });
  res.writeHead(302, {
    location: next,
    'cache-control': 'no-store',
    // 授权码在回调地址上，别让它跟着 Referer 出去
    'referrer-policy': 'no-referrer',
    'set-cookie': [cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000), cookie(STATE_COOKIE, '', 0)],
  });
  res.end();
}

/** 登录没成：一个只有一句话和返回链接的页面。用户点「返回」回到原来的地方再点一次登录就行 */
function loginFailed(req: IncomingMessage, res: ServerResponse, url: URL, next: string): void {
  const lang = requestLang(req, url);
  const body = `<!doctype html><html lang="${LANG_TAG[lang]}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>HoloCard</title><p>${escapeAttr(translate(lang, 'login.failed'))}</p><p><a href="${escapeAttr(next)}">${escapeAttr(translate(lang, 'login.back'))}</a></p></html>`;
  res.writeHead(400, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'set-cookie': cookie(STATE_COOKIE, '', 0),
  });
  res.end(body);
}

/*
 * 当前登录的账号，和它名下的卡（卡册用）。
 *   GET  /api/me         { login: 开没开登录, user: 账号或 null, cards: 名下还在的卡，最新的在前 }
 *   POST /api/me/claim   { cards: [{ id, token }] } 把这台设备上的卡（凭口令）认领到账号下，返回认领成功的 id
 */
export async function handleMe(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const session = sessionOf(req);
  if (req.method === 'GET' && url.pathname === '/api/me') {
    json(res, 200, {
      login: LOGIN_ENABLED,
      user: session ? { id: session.user_id, name: session.name, avatar: session.avatar } : null,
      cards: session ? db.userCards(session.user_id) : [],
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/me/claim') {
    if (!session || !sameOrigin(req)) {
      fail(res, 401, 'login_required', '要先登录');
      return;
    }
    let entries: unknown;
    try {
      entries = (JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) as { cards?: unknown }).cards;
    } catch {
      entries = null;
    }
    if (!Array.isArray(entries) || entries.length > 500) {
      fail(res, 400, 'bad_request', '请求不合法');
      return;
    }
    const claimed: string[] = [];
    for (const entry of entries) {
      const { id, token } = (entry ?? {}) as { id?: unknown; token?: unknown };
      if (typeof id !== 'string' || typeof token !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) continue;
      const card = db.get(id);
      // 只认还没有主人账号、口令对得上的网页卡；删掉、过期、下架的不认
      if (!card || card.user_id !== null || card.source !== 'web' || !CLAIMABLE.has(card.status)) continue;
      if (!timingSafeEqualStr(token, card.delete_token)) continue;
      if (db.claim(id, session.user_id, card.delete_token, randomUUID())) claimed.push(id);
    }
    console.log(`[claim] 账号 ${session.user_id} 认领了 ${claimed.length} 张`);
    json(res, 200, { claimed });
    return;
  }
  if (url.pathname === '/api/me/keys' || url.pathname.startsWith('/api/me/keys/')) {
    await handleMyKeys(req, res, url, session);
    return;
  }
  if (url.pathname === '/api/me' || url.pathname === '/api/me/claim') {
    methodNotAllowed(res, url.pathname === '/api/me' ? 'GET' : 'POST');
    return;
  }
  fail(res, 404, 'not_found', '没有这个地址');
}

/*
 * 个人中心里的对外接口 key（用法见 docs-site/api/index.md）。登录了就能自己申请，不用找站长：
 *   GET    /api/me/keys       还能用的 key（不含 key 本身，只有编号）、24 小时内用了几张、额度（管理员为 null，不限）
 *   POST   /api/me/keys       再申请一个，最多同时 MAX_KEYS_PER_ACCOUNT 个；key 只在这个响应里出现一次
 *   DELETE /api/me/keys/<id>  吊销自己的 key，立即生效
 * 额度按账号算：几个 key 共用，吊销了再申请，24 小时内用过的照样算数
 */
async function handleMyKeys(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  session: SessionRow | null,
): Promise<void> {
  if (!session || (req.method !== 'GET' && !sameOrigin(req))) {
    fail(res, 401, 'login_required', '要先登录');
    return;
  }
  const since = Date.now() - DAY_MS;

  if (req.method === 'GET' && url.pathname === '/api/me/keys') {
    json(res, 200, {
      keys: db.userApiKeys(session.user_id).map((key) => ({ id: key.id, createdAt: new Date(key.created_at).toISOString() })),
      used: db.apiUsedSince(since, { id: '', user_id: session.user_id }),
      dailyLimit: db.isAdmin(session.user_id) ? null : SELF_SERVE_DAILY_LIMIT,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/me/keys') {
    if (db.userApiKeys(session.user_id).length >= MAX_KEYS_PER_ACCOUNT) {
      fail(res, 409, 'too_many_keys', `最多同时有 ${MAX_KEYS_PER_ACCOUNT} 个 key，先吊销不用的`, { limit: MAX_KEYS_PER_ACCOUNT });
      return;
    }
    const key = newApiKey();
    const row = {
      id: randomUUID().slice(0, 8),
      name: session.name,
      hash: hashApiKey(key),
      created_at: Date.now(),
      revoked_at: null,
      daily_limit: SELF_SERVE_DAILY_LIMIT,
      user_id: session.user_id,
    };
    db.insertApiKey(row);
    console.log(`[keys] 账号 ${session.user_id} 申请了 key ${row.id}`);
    json(res, 201, { id: row.id, key });
    return;
  }

  const revokeMatch = /^\/api\/me\/keys\/([0-9a-f]{8})$/.exec(url.pathname);
  if (req.method === 'DELETE' && revokeMatch) {
    if (!db.revokeUserApiKey(revokeMatch[1] ?? '', session.user_id)) {
      fail(res, 404, 'not_found', '没有这个 key，或者已经吊销了');
      return;
    }
    console.log(`[keys] 账号 ${session.user_id} 吊销了 key ${revokeMatch[1]}`);
    json(res, 200, { revoked: true });
    return;
  }
  fail(res, 404, 'not_found', '没有这个地址');
}

const CLAIMABLE = new Set<CardRow['status']>(['queued', 'running', 'done', 'error']);
