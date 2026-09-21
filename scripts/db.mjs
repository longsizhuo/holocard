/**
 * 查卡片数据库
 *
 * 服务器上没装 sqlite3 命令行，也不打算为此往生产机上装系统包——
 * Node 自带 node:sqlite，写个小脚本就够。默认只读打开，服务在跑的时候查也不会互相干扰
 * （数据库是 WAL 模式，读写不阻塞）。
 *
 * 用法：
 *   node scripts/db.mjs                   最近 20 张卡 + 各状态计数
 *   node scripts/db.mjs <id>              某一张卡的全部字段
 *   node scripts/db.mjs "SELECT ..."      任意只读 SQL
 *
 * 数据库位置取 HOLOCARD_DB，默认 /srv/holocard-data/holocard.db。线上：
 *   ssh oracle 'cd /opt/holocard && node22/bin/node db.mjs'
 */

import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.HOLOCARD_DB ?? '/srv/holocard-data/holocard.db';
const arg = process.argv[2] ?? '';

const db = new DatabaseSync(DB_PATH, { readOnly: true });

const time = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '');

if (/^[0-9a-f-]{36}$/.test(arg)) {
  const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(arg);
  if (!row) {
    console.log('没有这张卡');
  } else {
    for (const [k, v] of Object.entries(row)) {
      // 删除口令不打出来，查问题用不到它，打到终端里只会增加泄漏的机会
      const shown = k === 'delete_token' ? '(已隐藏)' : k.endsWith('_at') ? `${v}  ${time(v)}` : v;
      console.log(`${k.padEnd(15)} ${shown ?? ''}`);
    }
  }
} else if (arg) {
  console.table(db.prepare(arg).all());
} else {
  console.log('各状态：');
  console.table(db.prepare('SELECT status, COUNT(*) AS n FROM cards GROUP BY status ORDER BY n DESC').all());
  console.log('最近 20 张：');
  console.table(
    db
      .prepare(
        `SELECT substr(id, 1, 8) AS id, status, stage, layer_count AS layers,
                source_width || 'x' || source_height AS size, shared, hits,
                created_at, original_url IS NOT NULL AS has_original
         FROM cards ORDER BY created_at DESC LIMIT 20`,
      )
      .all()
      .map((r) => ({ ...r, created_at: time(r.created_at) })),
  );
}

db.close();
