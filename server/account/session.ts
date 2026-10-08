/**
 * 会话：请求带着的是哪个账号，是不是这张卡的主人。登录流程本身见 auth.ts 和 routes/account.ts
 */

import type { IncomingMessage } from 'node:http';
import { sameOrigin, timingSafeEqualStr } from '../http';
import { db } from '../store';
import type { CardRow, SessionRow } from '../store/db';
import { SECRET_PATTERN, SESSION_COOKIE, parseCookies, sha256Hex } from './auth';

/** 带着有效会话 cookie 的，是哪个账号 */
export function sessionOf(req: IncomingMessage): SessionRow | null {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return token && SECRET_PATTERN.test(token) ? db.session(sha256Hex(token), Date.now()) : null;
}

/**
 * 是不是这张卡的主人：手上有口令的人；卡归到账号下以后，是登录着这个账号、从本站页面发请求的人。
 * 归到账号下的卡口令已经换掉、不给任何人，所以那时只剩会话这一条路
 */
export function owns(req: IncomingMessage, card: CardRow): boolean {
  const header = req.headers['x-holocard-token'];
  if (typeof header === 'string' && header !== '' && timingSafeEqualStr(header, card.delete_token)) return true;
  return card.user_id !== null && sameOrigin(req) && sessionOf(req)?.user_id === card.user_id;
}
