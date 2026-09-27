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
 *   node scripts/db.mjs perf [天数]        性能埋点：最近 30 条 + 按屏幕、显卡、浏览器分组（默认看 7 天）
 *   node scripts/db.mjs nsfw [阈值]        疑似完全裸露的卡（分数 ≥ 阈值，默认 0.4）。只列 id、部位和状态，不打开图片；
 *                                         要删用 scripts/delete-card.mjs
 *
 * 数据库位置取 HOLOCARD_DB，默认 /srv/holocard-data/holocard.db。线上：
 *   ssh oracle 'cd /opt/holocard && node22/bin/node db.mjs'
 */

import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.HOLOCARD_DB ?? '/srv/holocard-data/holocard.db';
const arg = process.argv[2] ?? '';

const db = new DatabaseSync(DB_PATH, { readOnly: true });

const time = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '');

/** UA 缩成「系统 浏览器」，够分组用就行。App 内置浏览器（微信、QQ）单独认出来：它们的内核版本常常很老 */
function shortUa(ua) {
  if (!ua) return '';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '?';
  const app = /MicroMessenger/.test(ua) ? '微信' : /\bQQ\//.test(ua) ? 'QQ' : /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '?';
  return `${os} ${app}`;
}

const median = (values) => {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

if (arg === 'nsfw') {
  // 默认阈值和服务端打日志的一样（server/index.ts 的 NSFW_LOG_THRESHOLD）
  const threshold = Number(process.argv[3] ?? 0.4);
  const rows = db
    .prepare(
      `SELECT id, status, nsfw, nsfw_part AS part, shared, hits, created_at, last_hit_at FROM cards
       WHERE nsfw >= ? AND status IN ('done', 'error') ORDER BY nsfw DESC`,
    )
    .all(threshold);
  // 早期迁移来的卡没存原图，永远打不了分，不算在「待补」里
  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM cards WHERE nsfw IS NULL AND original_url IS NOT NULL AND status IN ('done', 'error')`)
    .get();
  console.log(`疑似完全裸露（分数 ≥ ${threshold}）的卡 ${rows.length} 张（有原图还没识别的 ${pending.n} 张，服务启动时会补）：`);
  // 分享过、有人看过的排查优先级最高：那些是真的传出去了
  console.table(rows.map((r) => ({ ...r, created_at: time(r.created_at), last_hit_at: time(r.last_hit_at) })));
} else if (arg === 'perf') {
  const days = Number(process.argv[3] ?? 7);
  const rows = db.prepare('SELECT * FROM perf WHERE created_at > ? ORDER BY created_at DESC').all(Date.now() - days * 86400000);
  /*
   * 要画的物理像素 = 窗口的 CSS 像素 × dpr，卡不卡和它、和刷新率关系最大。
   * 不用 screen × dpr：Chrome 的 dpr 会乘上页面缩放而 screen 不会，2560 的屏开 150% 缩放会被算成 4K
   */
  const physical = (r) => `${Math.round(r.view_w * r.dpr)}x${Math.round(r.view_h * r.dpr)}@${r.hz}Hz`;
  const flags = (r) => [r.parallax ? '视差' : '', r.busy ? '处理中' : '', r.interacted ? '有操作' : '', r.reduced_motion ? '减动效' : ''].filter(Boolean).join(' ');
  console.log(`最近 ${days} 天共 ${rows.length} 条。最近 30 条：`);
  console.table(
    rows.slice(0, 30).map((r) => ({
      time: time(r.created_at),
      mode: r.mode,
      fps: r.fps,
      p95: r.p95,
      max: r.max_ms,
      dropped: `${Math.round(r.dropped * 100)}%`,
      screen: physical(r),
      gpu: (r.gpu ?? '').replace(/^ANGLE \((.*)\)$/, '$1').slice(0, 48),
      ua: shortUa(r.ua),
      country: r.country ?? '',
      flags: flags(r),
    })),
  );
  /*
   * 分组时只看真正静置的：处理照片、导出时掉帧是正常的；有操作（鼠标在卡上动）时箔面在重画，
   * 桌面端样本大多带操作、手机大多不带，混在一起两类设备就没法比了
   */
  const groups = new Map();
  for (const r of rows.filter((r) => !r.busy && !r.interacted)) {
    const key = `${physical(r)} | ${shortUa(r.ua)} | ${(r.gpu ?? '').slice(0, 60)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  console.log('按窗口物理像素、浏览器、显卡分组（只算静置、没操作的），掉帧多的在前：');
  console.table(
    [...groups]
      .map(([key, list]) => ({
        group: key,
        n: list.length,
        fps: median(list.map((r) => r.fps)),
        p95: median(list.map((r) => r.p95)),
        dropped: median(list.map((r) => r.dropped)),
      }))
      .sort((a, b) => b.dropped - a.dropped)
      .map((g) => ({ ...g, dropped: `${Math.round(g.dropped * 100)}%` })),
  );
} else if (/^[0-9a-f-]{36}$/.test(arg)) {
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
