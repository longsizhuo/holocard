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
import { PERF_COLUMNS, PERF_SCHEMA, type PerfSample } from './perf';

/**
 * 一张卡的生命周期：
 *   queued   已收到，排队中
 *   running  正在分层
 *   done     分层完成，可以看、可以分享
 *   error    分层失败（原图留着，方便复现）
 *   deleted  上传者自己删了
 *   expired  过了保留期被清理
 *   removed  站长下架（scripts/takedown.mjs）：对外和 deleted 一样看不到了，
 *            但文件没删，挪进了产物目录下的 .removed/<id>——误判能恢复，复核、留证也有东西可看
 * deleted、expired 只删文件、不删这一行，留着做统计。
 * 上传者自己删的是真删：页面上写明了「删除后无法恢复、服务端上的层文件都已清掉」，不能口头说删了其实留着。
 */
export type CardStatus = 'queued' | 'running' | 'done' | 'error' | 'deleted' | 'expired' | 'removed';

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
  /** 原图的裸露分 0..1（见 moderation.ts），只记录不拦。还没识别过、或者模型不可用时是 null */
  nsfw: number | null;
  /** 分数来自哪个部位（NudeNet 的类名，比如 FEMALE_BREAST_EXPOSED）。翻记录时不用打开图片也知道是什么 */
  nsfw_part: string | null;
  /** 从哪来：web 是网页上传，api 是对外接口（/v1，见 api.ts） */
  source: CardSource;
  /** api 卡是哪个 key 提交的（api_keys.id）。只有这个 key 能看、能下、能删 */
  api_key: string | null;
  /**
   * 归到哪个 IH 账号下（IH 的 user_accounts.id，见 auth.ts）。登录着做的卡、或者手动认领过的卡才有。
   * 有了它，这张卡只认这个账号的会话：口令不再返回给任何人，认领时也换掉了
   */
  user_id: string | null;
}

export type CardSource = 'web' | 'api';

/** 登录会话。浏览器拿着随机口令，库里只存它的哈希 */
export interface SessionRow {
  hash: string;
  user_id: string;
  name: string;
  avatar: string | null;
  created_at: number;
  expires_at: number;
}

/**
 * 对外接口的 key。两个来源：登录用户在个人中心自己申请（user_id 是申请人的账号），
 * 或者站长用 scripts/apikey.mjs 发（user_id 为空）。
 * 库里只存哈希：库文件泄露了，拿到的也不是能用的 key
 */
export interface ApiKeyRow {
  id: string;
  name: string;
  hash: string;
  created_at: number;
  revoked_at: number | null;
  /** 每 24 小时最多提交几张。账号自己申请的 key 按账号算（吊销了再申请不重新计数） */
  daily_limit: number;
  /** 申请人的 IH 账号（user_accounts.id）。站长发的为空 */
  user_id: string | null;
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
  delete_token   TEXT NOT NULL,
  nsfw           REAL,
  nsfw_part      TEXT
);
CREATE INDEX IF NOT EXISTS cards_status  ON cards(status);
CREATE INDEX IF NOT EXISTS cards_created ON cards(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  hash       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  avatar     TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  hash        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  daily_limit INTEGER NOT NULL
);
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
  'nsfw',
  'nsfw_part',
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
    /*
     * 写和写撞上时等一会儿，而不是立刻抛 database is locked。
     * 站长的 takedown.mjs 会在服务运行时写库；服务里不少写库的地方外面没有 catch（访问计数的定时落库、
     * 分享、删除），撞上一次整个进程就退出了
     */
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    // 早于裸露识别建的库补上这两列。CREATE TABLE IF NOT EXISTS 不会给已有的表加列
    const columns = new Set((this.#db.prepare('PRAGMA table_info(cards)').all() as { name: string }[]).map((c) => c.name));
    if (!columns.has('nsfw')) this.#db.exec('ALTER TABLE cards ADD COLUMN nsfw REAL');
    if (!columns.has('nsfw_part')) this.#db.exec('ALTER TABLE cards ADD COLUMN nsfw_part TEXT');
    // 对外接口之前建的库：存量卡都是网页传的
    if (!columns.has('source')) this.#db.exec("ALTER TABLE cards ADD COLUMN source TEXT NOT NULL DEFAULT 'web'");
    if (!columns.has('api_key')) this.#db.exec('ALTER TABLE cards ADD COLUMN api_key TEXT');
    this.#db.exec('CREATE INDEX IF NOT EXISTS cards_api_key ON cards(api_key, created_at)');
    // 账号之前建的库：存量卡都没有主人账号，存量 key 都是站长发的
    if (!columns.has('user_id')) this.#db.exec('ALTER TABLE cards ADD COLUMN user_id TEXT');
    const keyColumns = new Set((this.#db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[]).map((c) => c.name));
    if (!keyColumns.has('user_id')) this.#db.exec('ALTER TABLE api_keys ADD COLUMN user_id TEXT');
    this.#db.exec('CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys(user_id)');
    this.#db.exec('CREATE INDEX IF NOT EXISTS cards_user ON cards(user_id, created_at)');
    // 性能埋点（见 perf.ts）也放这个库里：同一个进程写，同一个脚本（scripts/db.mjs）查
    this.#db.exec(PERF_SCHEMA);
  }

  insert(row: CardRow): void {
    this.#db
      .prepare(
        `INSERT INTO cards (id, status, stage, error, created_at, updated_at,
           original_url, original_type, original_bytes, source_width, source_height,
           result_url, layer_count, shared, shared_at, hits, last_hit_at, delete_token, nsfw, nsfw_part,
           source, api_key, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.nsfw,
        row.nsfw_part,
        row.source,
        row.api_key,
        row.user_id,
      );
  }

  get(id: string): CardRow | null {
    const row = this.#db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
    return (row as CardRow | undefined) ?? null;
  }

  has(id: string): boolean {
    return this.#db.prepare('SELECT 1 FROM cards WHERE id = ?').get(id) !== undefined;
  }

  /**
   * 只改给出的字段，顺带刷新 updated_at。返回有没有改到。
   * 给了 onlyIf 就只在当前状态是它时才改：处理完写回 done/error 用它，
   * 处理途中卡被删了（状态已经是 deleted），写回就不生效，不会把删掉的卡又写活
   */
  update(id: string, patch: CardPatch, onlyIf?: CardStatus): boolean {
    const keys = (Object.keys(patch) as Updatable[]).filter((k) => UPDATABLE.includes(k));
    if (keys.length === 0) return false;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => patch[k] ?? null);
    const result = onlyIf
      ? this.#db.prepare(`UPDATE cards SET ${sets}, updated_at = ? WHERE id = ? AND status = ?`).run(...values, Date.now(), id, onlyIf)
      : this.#db.prepare(`UPDATE cards SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);
    return Number(result.changes) > 0;
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

  /** 这个 key 还能用吗（存在、没吊销）。吊销要立即生效：入队前、开始处理前都再查一次 */
  apiKeyActive(id: string): boolean {
    return this.#db.prepare('SELECT 1 FROM api_keys WHERE id = ? AND revoked_at IS NULL').get(id) !== undefined;
  }

  /** 被站长下架的对外接口卡。它们的文件在 .removed/ 下，也要按 24 小时清掉（见 cards.ts 的 sweepCards） */
  removedApi(): CardRow[] {
    return this.#db.prepare("SELECT * FROM cards WHERE status = 'removed' AND source = 'api'").all() as unknown as CardRow[];
  }

  /** 按哈希找一个没吊销的 key */
  apiKeyByHash(hash: string): ApiKeyRow | null {
    const row = this.#db.prepare('SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL').get(hash);
    return (row as ApiKeyRow | undefined) ?? null;
  }

  /**
   * 某个 key（不给就是所有 key）从 since 起提交了几张，删掉、过期的也算：额度按提交算，不按留存算。
   * 额度直接数库，不另建计数表：服务每次发版都重启，内存里的计数会清零
   */
  apiSubmittedSince(since: number, key?: string): number {
    const row = key
      ? this.#db.prepare("SELECT COUNT(*) AS n FROM cards WHERE source = 'api' AND api_key = ? AND created_at >= ?").get(key, since)
      : this.#db.prepare("SELECT COUNT(*) AS n FROM cards WHERE source = 'api' AND created_at >= ?").get(since);
    return Number((row as { n: number }).n);
  }

  /**
   * 这个 key 的额度用了多少：账号申请的 key 数这个账号所有 key 的，免得吊销了再申请一个重新计数；
   * 站长发的 key 只数它自己
   */
  apiUsedSince(since: number, key: ApiKeyRow): number {
    const row = key.user_id
      ? this.#db
          .prepare(
            "SELECT COUNT(*) AS n FROM cards WHERE source = 'api' AND created_at >= ? AND api_key IN (SELECT id FROM api_keys WHERE user_id = ?)",
          )
          .get(since, key.user_id)
      : this.#db.prepare("SELECT COUNT(*) AS n FROM cards WHERE source = 'api' AND api_key = ? AND created_at >= ?").get(key.id, since);
    return Number((row as { n: number }).n);
  }

  /** 这个账号申请过的 key（含吊销的），最新的在前 */
  userApiKeys(userId: string): ApiKeyRow[] {
    return this.#db
      .prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(userId) as unknown as ApiKeyRow[];
  }

  insertApiKey(row: ApiKeyRow): void {
    this.#db
      .prepare('INSERT INTO api_keys (id, name, hash, created_at, revoked_at, daily_limit, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.name, row.hash, row.created_at, row.revoked_at, row.daily_limit, row.user_id);
  }

  /** 账号吊销自己的 key。别人的、已经吊销的改不到 */
  revokeUserApiKey(id: string, userId: string): boolean {
    const result = this.#db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(Date.now(), id, userId);
    return Number(result.changes) > 0;
  }

  /** 某个 key 现在排着队、正在处理的有几张 */
  apiInFlight(key: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM cards WHERE api_key = ? AND status IN ('queued', 'running')")
      .get(key);
    return Number((row as { n: number }).n);
  }

  /** 这个账号名下还在的卡，最新的在前 */
  userCards(userId: string): string[] {
    const rows = this.#db
      .prepare(
        "SELECT id FROM cards WHERE user_id = ? AND source = 'web' AND status IN ('queued', 'running', 'done') ORDER BY created_at DESC LIMIT 1000",
      )
      .all(userId) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /**
   * 把一张没有主人账号的卡归到这个账号下，同时换掉口令（新口令不给任何人）：
   * 认领之后，别的设备上、公用电脑上留着的旧口令都不再管用。
   * 带着旧口令做条件：两个人拿同一个口令同时认领，只有一个改得到
   */
  claim(id: string, userId: string, oldToken: string, newToken: string): boolean {
    const result = this.#db
      .prepare(
        "UPDATE cards SET user_id = ?, delete_token = ?, updated_at = ? WHERE id = ? AND user_id IS NULL AND delete_token = ? AND source = 'web'",
      )
      .run(userId, newToken, Date.now(), id, oldToken);
    return Number(result.changes) > 0;
  }

  insertSession(row: SessionRow): void {
    this.#db
      .prepare('INSERT INTO sessions (hash, user_id, name, avatar, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.hash, row.user_id, row.name, row.avatar, row.created_at, row.expires_at);
  }

  session(hash: string, now: number): SessionRow | null {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE hash = ? AND expires_at > ?').get(hash, now);
    return (row as SessionRow | undefined) ?? null;
  }

  deleteSession(hash: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash);
  }

  pruneSessions(now: number): number {
    return Number(this.#db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes);
  }

  /** 记一条性能埋点，字段已经在 perf.ts 里校验过 */
  insertPerf(sample: PerfSample): void {
    this.#db
      .prepare(`INSERT INTO perf (${PERF_COLUMNS.join(', ')}) VALUES (${PERF_COLUMNS.map(() => '?').join(', ')})`)
      .run(...PERF_COLUMNS.map((key) => sample[key] ?? null));
  }

  /**
   * 性能埋点只留最近 keepDays 天、最多 maxRows 条。
   * 接口是公开的，按 IP 限流挡不住换着 IP 刷，这个上限保证库不会被撑大
   */
  prunePerf(keepDays: number, maxRows: number): number {
    const old = this.#db.prepare('DELETE FROM perf WHERE created_at < ?').run(Date.now() - keepDays * 86400000);
    const extra = this.#db
      .prepare('DELETE FROM perf WHERE rowid IN (SELECT rowid FROM perf ORDER BY created_at DESC LIMIT -1 OFFSET ?)')
      .run(maxRows);
    return Number(old.changes) + Number(extra.changes);
  }

  close(): void {
    this.#db.close();
  }
}
