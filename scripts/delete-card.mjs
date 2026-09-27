/**
 * 站长删卡：效果和上传者自己点「删除」一样（文件全删、库里那一行标成 deleted），走的也是同一个接口。
 * 用在 `db.mjs nsfw` 查出来、确认要下架的卡上。
 *
 * 用法（在服务器上，和 db.mjs 同一个目录）：
 *   node delete-card.mjs <卡片 id>
 * 删除口令从库里读出来直接带进请求，不打印。数据库位置取 HOLOCARD_DB，服务地址取 HOLOCARD_URL（默认本机 8791）。
 *
 * 注意：层文件和原图在 Cloudflare 边缘最多缓存 4 小时（max-age=14400），删完之后有人拿着链接
 * 仍可能在缓存过期前看到。要立刻失效，去 Cloudflare 后台按 URL 前缀清缓存：
 *   holocard.longsizhuo.com/api/layers/<id>/
 */

import { DatabaseSync } from 'node:sqlite';

const id = process.argv[2] ?? '';
if (!/^[0-9a-f-]{36}$/.test(id)) {
  console.error('用法：node delete-card.mjs <卡片 id>');
  process.exit(1);
}
const DB_PATH = process.env.HOLOCARD_DB ?? '/srv/holocard-data/holocard.db';
const URL_BASE = process.env.HOLOCARD_URL ?? 'http://127.0.0.1:8791';

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const card = db.prepare('SELECT status, delete_token FROM cards WHERE id = ?').get(id);
db.close();
if (!card) {
  console.error('没有这张卡');
  process.exit(1);
}
if (card.status === 'deleted' || card.status === 'expired') {
  console.log(`这张卡已经是 ${card.status}，不用再删`);
  process.exit(0);
}

const res = await fetch(`${URL_BASE}/api/cards/${id}`, {
  method: 'DELETE',
  headers: { 'x-holocard-token': card.delete_token },
});
console.log(res.ok ? `已删除 ${id}` : `删除失败：${res.status} ${await res.text()}`);
process.exit(res.ok ? 0 : 1);
