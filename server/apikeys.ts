/**
 * 对外接口的 key
 *
 * 形如 hc_ 加 32 个 base64url 字符（24 字节随机数）。库里只存 SHA-256：
 * key 本身熵足够高，不需要加盐慢哈希；库文件泄露了，拿到的也不是能用的 key。
 * 只由站长用 scripts/apikey.mjs 发（那边重复了这里的生成和哈希，两处要一起改）。
 */

import { createHash, randomBytes } from 'node:crypto';

const KEY_PATTERN = /^hc_[A-Za-z0-9_-]{32}$/;

export function newApiKey(): string {
  return `hc_${randomBytes(24).toString('base64url')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** 从 Authorization 头里取 key。格式不对就是 null，不去查库 */
export function bearerKey(header: string | undefined): string | null {
  // 认证方案名不区分大小写（RFC 7235）
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  const key = match?.[1] ?? '';
  return KEY_PATTERN.test(key) ? key : null;
}
