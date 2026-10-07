/**
 * 发、查、吊销对外接口（/v1）的 key
 *
 * 登录用户可以在个人中心自己申请（每个账号每天 20 张，见 server/index.ts 的 handleMyKeys）；
 * 要更高额度的，由站长在服务器上用这个脚本发。库里只存 SHA-256，
 * key 本身只在 create 时打印这一次，丢了就吊销重发。list 能看到所有 key，包括自己申请的，revoke 也都能吊销。
 * 生成和哈希的规则和 server/apikeys.ts 一致，两处要一起改。
 *
 * 用法：
 *   node scripts/apikey.mjs create <名字> [每天上限，默认 50]   发一个新 key，打印出来
 *   node scripts/apikey.mjs list                                 所有 key：名字、上限、24 小时内用了几张、是否吊销
 *   node scripts/apikey.mjs revoke <id>                          吊销，立即生效
 *
 * 数据库位置取 HOLOCARD_DB，默认 /srv/holocard-data/holocard.db。线上：
 *   cd /opt/holocard && node22/bin/node apikey.mjs list
 * 表由服务启动时建（server/db.ts）。还没升级到带对外接口的版本时，这里会提示先发版。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.HOLOCARD_DB ?? '/srv/holocard-data/holocard.db';
const [command = '', ...args] = process.argv.slice(2);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000;');
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'").get()) {
  console.error('库里还没有 api_keys 表：先发版，新版本的服务启动时会建表');
  process.exit(1);
}

const time = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '');

if (command === 'create') {
  const name = args[0];
  const limit = Number(args[1] ?? 50);
  if (!name || !Number.isInteger(limit) || limit <= 0) {
    console.error('用法：node scripts/apikey.mjs create <名字> [每天上限]');
    process.exit(1);
  }
  const key = `hc_${randomBytes(24).toString('base64url')}`;
  const id = randomUUID().slice(0, 8);
  db.prepare('INSERT INTO api_keys (id, name, hash, created_at, revoked_at, daily_limit) VALUES (?, ?, ?, ?, NULL, ?)')
    .run(id, name, createHash('sha256').update(key).digest('hex'), Date.now(), limit);
  console.log(`已发给「${name}」，id ${id}，每 24 小时最多 ${limit} 张。key 只显示这一次：\n\n  ${key}\n`);
} else if (command === 'list') {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT k.id, k.name, k.daily_limit, k.created_at, k.revoked_at, k.user_id,
         (SELECT COUNT(*) FROM cards c WHERE c.source = 'api' AND c.api_key = k.id AND c.created_at >= ?) AS used
       FROM api_keys k ORDER BY k.created_at`,
    )
    .all(since);
  if (rows.length === 0) console.log('还没有发过 key');
  for (const r of rows) {
    console.log(
      `${r.id}  ${r.name}${r.user_id ? `（IH 账号 ${r.user_id}，自己申请）` : ''}  24h ${r.used}/${r.daily_limit}  发于 ${time(r.created_at)}${r.revoked_at ? `  已吊销 ${time(r.revoked_at)}` : ''}`,
    );
  }
} else if (command === 'revoke') {
  const id = args[0];
  const result = db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id ?? '');
  if (Number(result.changes) === 0) {
    console.error(`没有找到没吊销的 key：${id ?? ''}`);
    process.exit(1);
  }
  console.log(`已吊销 ${id}，立即生效`);
} else {
  console.error('用法：node scripts/apikey.mjs create <名字> [每天上限] | list | revoke <id>');
  process.exit(1);
}
