/**
 * 站长下架 / 恢复一张卡。软删除：文件不删，挪进产物目录下的 .removed/<id>，库里状态改成 removed。
 *   - 对外和上传者自己删的一样：分享链接打不开、层文件 404（.removed 不是合法的卡片 id，没有路由能取到它）
 *   - 误判了能原样恢复；要复核、要留证也有东西可看
 *   - 过期清理只看 done / error 的卡，下架的不会被自动清掉
 * 上传者自己点删除仍然是真删（页面上承诺了），连隔离区里那份也会一起删。
 *
 * 用法（在服务器上，和 db.mjs 同一个目录，以服务的用户身份跑）：
 *   node takedown.mjs <卡片 id>            下架
 *   node takedown.mjs restore <卡片 id>    恢复成 done
 * 产物目录取 HOLOCARD_OUT_DIR（默认 /srv/holocard-layers），数据库取 HOLOCARD_DB（默认 /srv/holocard-data/holocard.db）。
 *
 * 注意：层文件和原图在 Cloudflare 边缘最多缓存 4 小时。要立刻失效，去 Cloudflare 后台按 URL 前缀清缓存：
 *   holocard.longsizhuo.com/api/layers/<id>/
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

const [first, second] = process.argv.slice(2);
const restore = first === 'restore';
const id = restore ? second : first;
if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
  console.error('用法：node takedown.mjs <卡片 id>  |  node takedown.mjs restore <卡片 id>');
  process.exit(1);
}
const OUT_DIR = process.env.HOLOCARD_OUT_DIR ?? '/srv/holocard-layers';
const DB_PATH = process.env.HOLOCARD_DB ?? '/srv/holocard-data/holocard.db';
const live = join(OUT_DIR, id);
const quarantine = join(OUT_DIR, '.removed', id);

const db = new DatabaseSync(DB_PATH);
// 服务在跑、同时在写库（访问计数每分钟落一次）。WAL 模式下读写不互斥，写和写撞上时等一会儿而不是直接报错
db.exec('PRAGMA busy_timeout = 5000');
const card = db.prepare('SELECT status FROM cards WHERE id = ?').get(id);
if (!card) {
  console.error('没有这张卡');
  process.exit(1);
}

if (restore) {
  if (card.status !== 'removed') {
    console.error(`这张卡现在是 ${card.status}，不是下架状态，不用恢复`);
    process.exit(1);
  }
  if (!existsSync(quarantine)) {
    console.error(`隔离区里没有它的文件（${quarantine}），恢复不了`);
    process.exit(1);
  }
  await rename(quarantine, live);
  /*
   * 下架时本来就没做出来的卡（error，没有 manifest）恢复回 error，不能变成 done：
   * 不然 /api/jobs 报「完成」，前端去拿 manifest 拿到 404，分享、导出也会接下它。
   * 保留期从现在重新算：过期清理按 created_at（没分享过的）或 last_hit_at（分享过的）算到期，
   * 下架期间链接打不开、没人访问，不重置的话刚恢复就可能被下一轮清理删掉
   */
  const status = existsSync(join(live, 'manifest.json')) ? 'done' : 'error';
  const now = Date.now();
  db.prepare('UPDATE cards SET status = ?, updated_at = ?, created_at = ?, last_hit_at = ? WHERE id = ?').run(status, now, now, now, id);
  console.log(`已恢复 ${id}（${status}），保留期从现在重新算`);
} else {
  if (card.status !== 'done' && card.status !== 'error') {
    console.error(`这张卡现在是 ${card.status}，没有可下架的东西`);
    process.exit(1);
  }
  // 先挪文件（挪完立刻 404），再改状态。同一个文件系统里 rename 是原子的
  await mkdir(join(OUT_DIR, '.removed'), { recursive: true, mode: 0o700 });
  if (existsSync(live)) await rename(live, quarantine);
  db.prepare('UPDATE cards SET status = ?, updated_at = ? WHERE id = ?').run('removed', Date.now(), id);
  console.log(`已下架 ${id}，文件在 ${quarantine}`);
}
db.close();
