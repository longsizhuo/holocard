/**
 * 卡片的保留策略与访问计数
 *
 * 每张卡的目录里放一个 meta.json 记状态，清理时只看它，不看目录 mtime——
 * mtime 会被任何一次写入（比如补渲染预览图）刷新，用它当依据等于永远不过期。
 *
 * 保留窗口的形状见 keepMs()：没分享过的到点就删，分享过的按访问量分档，
 * 且窗口从**最后一次访问**开始算，所以一直有人看的卡会不断续期。
 */

import { readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** 分享过的卡片在目录里放一个空标记文件。meta.json 之前的老格式，只用于迁移 */
const LEGACY_SHARED_MARKER = '.shared';

const META_FILE = 'meta.json';

export interface CardMeta {
  /** 产出时间 */
  createdAt: number;
  /** 是否分享过。没分享过的卡只有创建者自己知道 id */
  shared: boolean;
  sharedAt: number | null;
  /** 被打开过几次（同一 IP 一小时内只算一次） */
  hits: number;
  /** 最后一次被打开的时间。保留窗口从这里往后算 */
  lastHitAt: number;
  /** 删除口令。只在产出时返回给上传者一次，之后无法再取 */
  deleteToken: string;
}

export function newMeta(now = Date.now()): CardMeta {
  return {
    createdAt: now,
    shared: false,
    sharedAt: null,
    hits: 0,
    lastHitAt: now,
    deleteToken: randomUUID(),
  };
}

export async function readMeta(dir: string): Promise<CardMeta | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, META_FILE), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const m = parsed as Partial<CardMeta>;
    if (typeof m.createdAt !== 'number' || typeof m.deleteToken !== 'string') return null;
    return {
      createdAt: m.createdAt,
      shared: Boolean(m.shared),
      sharedAt: typeof m.sharedAt === 'number' ? m.sharedAt : null,
      hits: typeof m.hits === 'number' ? m.hits : 0,
      lastHitAt: typeof m.lastHitAt === 'number' ? m.lastHitAt : m.createdAt,
      deleteToken: m.deleteToken,
    };
  } catch {
    return null;
  }
}

export async function writeMeta(dir: string, meta: CardMeta): Promise<void> {
  await writeFile(join(dir, META_FILE), JSON.stringify(meta));
}

/**
 * 给 meta.json 之前产出的目录补一份。
 *
 * 老目录只有一个 .shared 空文件，没有访问记录也没有删除口令。
 * 迁移时按「已经被访问过一次」起算，等于从现在起再给它一个完整窗口，
 * 而不是刚上线就把存量数据清掉。
 */
async function migrate(dir: string): Promise<CardMeta | null> {
  const info = await stat(dir).catch(() => null);
  if (!info) return null;
  const shared = Boolean(await stat(join(dir, LEGACY_SHARED_MARKER)).catch(() => null));
  const meta: CardMeta = {
    createdAt: Math.floor(info.mtimeMs),
    shared,
    sharedAt: shared ? Math.floor(info.mtimeMs) : null,
    hits: shared ? 1 : 0,
    lastHitAt: Date.now(),
    // 老卡没有口令记录，补一个新的——没人拿得到，等于只能由服务端清理
    deleteToken: randomUUID(),
  };
  await writeMeta(dir, meta);
  return meta;
}

export async function ensureMeta(dir: string): Promise<CardMeta | null> {
  return (await readMeta(dir)) ?? (await migrate(dir));
}

/**
 * 这张卡应该从「最后一次访问」起再留多久。
 *
 * 没分享过：不续期，就是基础窗口。
 * 分享过：每翻一番访问量多留一档，封顶 cap 番。
 *   hits 1 → 1 档，2-3 → 2 档，4-7 → 3 档……
 */
export function keepMs(meta: CardMeta, baseMs: number, doublingsCap: number): number {
  if (!meta.shared) return baseMs;
  const doublings = Math.min(doublingsCap, Math.floor(Math.log2(Math.max(1, meta.hits))) + 1);
  return baseMs * Math.pow(2, doublings - 1);
}

/** 到期时间。没分享过的从产出算起，分享过的从最后一次访问算起 */
export function expiresAt(meta: CardMeta, baseMs: number, doublingsCap: number): number {
  const from = meta.shared ? meta.lastHitAt : meta.createdAt;
  return from + keepMs(meta, baseMs, doublingsCap);
}

/*
 * 访问计数不直接落盘。
 *
 * 一次页面访问写一次 meta.json 的话，一张卡被刷屏时磁盘会被小写打满，
 * 而这份数据丢几条也不影响正确性（只影响保留时长）。
 * 所以内存里累计，定时合并写盘。
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

/** 把累计的访问量合并进各自的 meta.json */
export async function flushHits(outDir: string): Promise<void> {
  if (pending.size === 0) return;
  const batch = [...pending];
  pending.clear();

  for (const [id, delta] of batch) {
    const dir = join(outDir, id);
    const meta = await ensureMeta(dir);
    if (!meta) continue; // 卡已经被删了，这几次访问丢掉就行
    meta.hits += delta.hits;
    meta.lastHitAt = Math.max(meta.lastHitAt, delta.lastHitAt);
    await writeMeta(dir, meta).catch(() => undefined);
  }
}

/** 清理过期产物。返回删掉几个 */
export async function sweepCards(
  outDir: string,
  baseMs: number,
  doublingsCap: number,
): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(outDir);
  } catch {
    return 0; // 目录还不存在
  }

  const now = Date.now();
  for (const name of names) {
    const dir = join(outDir, name);
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) continue;

    const meta = await ensureMeta(dir);
    // 连 meta 都建不出来（目录坏了/正在写）就先留着，下一轮再说
    if (!meta) continue;
    if (now < expiresAt(meta, baseMs, doublingsCap)) continue;

    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    removed++;
  }
  return removed;
}
