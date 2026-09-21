/**
 * 卡片数据库
 *
 * 用 Node 内置的 node:sqlite，不引入任何原生依赖——那台 ARM 机器上编译原生模块是折腾，
 * 而这个服务是单进程、单并发，SQLite 刚好够用。
 *
 * 一张卡一行，是这张卡所有状态的唯一来源：处理进度、原图在哪、结果在哪、
 * 保留期怎么算、删除口令。之前这些散在内存里的任务表和每个目录的 meta.json 里，
 * 服务一重启进度就没了，想查「最近谁传了什么、失败了几个」也无从下手。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 一张卡的生命周期：
 *   queued   已收到，排队中
 *   running  正在分层
 *   done     分层完成，可以看、可以分享
 *   error    分层失败（原图留着，方便复现）
 *   deleted  上传者自己删了
 *   expired  过了保留期被清理
 * 后两种只删文件、不删这一行，留着做统计。
 */
export type CardStatus = 'queued' | 'running' | 'done' | 'error' | 'deleted' | 'expired';

export interface CardRow {
  id: string;
  status: CardStatus;
  /** 处理中所在的阶段（估计深度、切层……），给前端轮询用 */
  stage: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;

  /** 原图地址（经 CDN），去掉了 EXIF 等元数据 */
  original_url: string | null;
  original_type: string | null;
  original_bytes: number | null;
  source_width: number | null;
  source_height: number | null;

  /** 结果页，也就是分享出去的那个地址 */
  result_url: string | null;
  layer_count: number | null;

  shared: number;
  shared_at: number | null;
  hits: number;
  last_hit_at: number | null;
  /** 删除口令。只在提交时返回给上传者一次 */
  delete_token: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id             TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  stage          TEXT,
  error          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,

  original_url   TEXT,
  original_type  TEXT,
  original_bytes INTEGER,
  source_width   INTEGER,
  source_height  INTEGER,

  result_url     TEXT,
  layer_count    INTEGER,

  shared         INTEGER NOT NULL DEFAULT 0,
  shared_at      INTEGER,
  hits           INTEGER NOT NULL DEFAULT 0,
  last_hit_at    INTEGER,
  delete_token   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_status  ON cards(status);
CREATE INDEX IF NOT EXISTS cards_created ON cards(created_at);
`;

/** 可以被更新的列。白名单，避免把任意键名拼进 SQL */
const UPDATABLE = [
  'status',
  'stage',
  'error',
  'original_url',
  'original_type',
  'original_bytes',
  'source_width',
  'source_height',
  'result_url',
  'layer_count',
  'shared',
  'shared_at',
  'hits',
  'last_hit_at',
] as const;
type Updatable = (typeof UPDATABLE)[number];
export type CardPatch = Partial<Pick<CardRow, Updatable>>;

export class CardDb {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    // WAL：读写互不阻塞。轮询接口一秒一次在读，处理线程同时在写进度
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA synchronous = NORMAL;');
    this.#db.exec(SCHEMA);
  }

  insert(row: CardRow): void {
    this.#db
      .prepare(
        `INSERT INTO cards (id, status, stage, error, created_at, updated_at,
           original_url, original_type, original_bytes, source_width, source_height,
           result_url, layer_count, shared, shared_at, hits, last_hit_at, delete_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.status,
        row.stage,
        row.error,
        row.created_at,
        row.updated_at,
        row.original_url,
        row.original_type,
        row.original_bytes,
        row.source_width,
        row.source_height,
        row.result_url,
        row.layer_count,
        row.shared,
        row.shared_at,
        row.hits,
        row.last_hit_at,
        row.delete_token,
      );
  }

  get(id: string): CardRow | null {
    const row = this.#db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
    return (row as CardRow | undefined) ?? null;
  }

  has(id: string): boolean {
    return this.#db.prepare('SELECT 1 FROM cards WHERE id = ?').get(id) !== undefined;
  }

  /** 只改给出的字段，顺带刷新 updated_at */
  update(id: string, patch: CardPatch): void {
    const keys = (Object.keys(patch) as Updatable[]).filter((k) => UPDATABLE.includes(k));
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => patch[k] ?? null);
    this.#db
      .prepare(`UPDATE cards SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...values, Date.now(), id);
  }

  /** 合并一批访问计数。同一张卡的多次访问在内存里已经攒成一条了 */
  addHits(id: string, hits: number, lastHitAt: number): void {
    this.#db
      .prepare(
        `UPDATE cards SET hits = hits + ?, last_hit_at = MAX(COALESCE(last_hit_at, 0), ?),
           updated_at = ? WHERE id = ?`,
      )
      .run(hits, lastHitAt, Date.now(), id);
  }

  /** 还占着磁盘的卡（清理时逐个判断是否过期） */
  live(): CardRow[] {
    return this.#db
      .prepare(`SELECT * FROM cards WHERE status IN ('done', 'error')`)
      .all() as unknown as CardRow[];
  }

  /** 某个状态下的所有卡，按提交顺序。服务启动时用来续跑中断的任务 */
  byStatus(status: CardStatus): CardRow[] {
    return this.#db
      .prepare('SELECT * FROM cards WHERE status = ? ORDER BY created_at')
      .all(status) as unknown as CardRow[];
  }

  close(): void {
    this.#db.close();
  }
}
