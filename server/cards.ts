/**
 * 卡片的保留策略、访问计数，以及从旧格式迁移
 *
 * 状态都存在数据库里（见 db.ts），这里只放围绕它的业务规则。
 *
 * 保留窗口的形状见 keepMs()：没分享过的到点就删，分享过的按访问量分档，
 * 且窗口从**最后一次访问**开始算，所以一直有人看的卡会不断续期。
 */

import { readFile, stat, rm, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CardDb, CardRow } from './db';

/**
 * 这张卡应该从「最后一次访问」起再留多久。
 *
 * 没分享过：不续期，就是基础窗口。
 * 分享过：每翻一番访问量多留一档，封顶 cap 档。
 *   hits 1 → 1 档，2-3 → 2 档，4-7 → 3 档……
 */
export function keepMs(card: CardRow, baseMs: number, doublingsCap: number): number {
  if (!card.shared) return baseMs;
  const doublings = Math.min(doublingsCap, Math.floor(Math.log2(Math.max(1, card.hits))) + 1);
  return baseMs * Math.pow(2, doublings - 1);
}

/** 到期时间。没分享过的从产出算起，分享过的从最后一次访问算起 */
export function expiresAt(card: CardRow, baseMs: number, doublingsCap: number): number {
  const from = card.shared ? (card.last_hit_at ?? card.created_at) : card.created_at;
  return from + keepMs(card, baseMs, doublingsCap);
}

/*
 * 访问计数先在内存里攒，定时合并写库。
 * 写 SQLite 本身很便宜，攒一下主要是为了下面的去重窗口能和写入解耦。
 */
const pending = new Map<string, { hits: number; lastHitAt: number }>();

/** 同一 IP 对同一张卡的去重窗口。自己反复刷不该把保留期刷上去 */
const DEDUPE_MS = 60 * 60 * 1000;
const seen = new Map<string, number>();

/** 记一次访问。返回 false 表示被去重窗口挡下了 */
export function recordHit(id: string, ip: string, now = Date.now()): boolean {
  const key = `${id}|${ip}`;
  const last = seen.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return false;
  seen.set(key, now);

  // 顺手清掉过期条目，别让这个 Map 无限长
  if (seen.size > 20000) {
    for (const [k, t] of seen) {
      if (now - t >= DEDUPE_MS) seen.delete(k);
    }
  }

  const entry = pending.get(id);
  if (entry) {
    entry.hits += 1;
    entry.lastHitAt = now;
  } else {
    pending.set(id, { hits: 1, lastHitAt: now });
  }
  return true;
}

/** 把攒下的访问量合并进数据库 */
export function flushHits(db: CardDb): void {
  if (pending.size === 0) return;
  const batch = [...pending];
  pending.clear();
  for (const [id, delta] of batch) db.addHits(id, delta.hits, delta.lastHitAt);
}

/**
 * 清理过期产物：删目录，数据库里那一行留着、状态改成 expired。
 * 返回清理了几张。
 */
export async function sweepCards(
  db: CardDb,
  outDir: string,
  baseMs: number,
  doublingsCap: number,
): Promise<number> {
  const now = Date.now();
  let removed = 0;
  for (const card of db.live()) {
    if (now < expiresAt(card, baseMs, doublingsCap)) continue;
    await rm(join(outDir, card.id), { recursive: true, force: true }).catch(() => undefined);
    db.update(card.id, { status: 'expired', stage: null });
    removed++;
  }
  return removed;
}

/**
 * 把数据库之前的存量卡导进来。
 *
 * 老格式是每个目录一份 meta.json（再往前是一个空的 .shared 标记文件）。
 * 删除口令必须原样导入——那些卡的上传者浏览器里还存着它，换掉就删不了了。
 * 老卡没存原图，original_url 只能留空。
 */
export async function importLegacy(
  db: CardDb,
  outDir: string,
  publicOrigin: string,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(outDir);
  } catch {
    return 0;
  }

  let imported = 0;
  for (const id of names) {
    if (db.has(id)) continue;
    const dir = join(outDir, id);
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) continue;

    // 没有 manifest 说明这个目录不是一张完整的卡（残留的半截产物），不导
    const manifest = await readJson(join(dir, 'manifest.json'));
    if (!manifest) continue;

    const meta = await readJson(join(dir, 'meta.json'));
    const legacyShared = Boolean(await stat(join(dir, '.shared')).catch(() => null));
    const createdAt = num(meta?.['createdAt']) ?? Math.floor(info.mtimeMs);
    const shared = meta ? Boolean(meta['shared']) : legacyShared;
    const source = (manifest['source'] ?? {}) as Record<string, unknown>;
    const layers = Array.isArray(manifest['layers']) ? manifest['layers'] : [];
    const token = meta?.['deleteToken'];

    db.insert({
      id,
      status: 'done',
      stage: 'done',
      error: null,
      created_at: createdAt,
      updated_at: Date.now(),
      original_url: null,
      original_type: null,
      original_bytes: null,
      source_width: num(source['width']),
      source_height: num(source['height']),
      result_url: `${publicOrigin}/c/${id}`,
      layer_count: layers.length,
      shared: shared ? 1 : 0,
      shared_at: shared ? (num(meta?.['sharedAt']) ?? createdAt) : null,
      hits: num(meta?.['hits']) ?? (shared ? 1 : 0),
      // 迁移时按「刚被访问过」起算，别让存量卡一上线就被清掉
      last_hit_at: num(meta?.['lastHitAt']) ?? Date.now(),
      delete_token: typeof token === 'string' ? token : randomUUID(),
    });
    imported++;
  }
  return imported;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
