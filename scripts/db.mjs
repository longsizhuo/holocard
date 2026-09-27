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

if (arg === 'perf') {
  const days = Number(process.argv[3] ?? 7);
  const rows = db.prepare('SELECT * FROM perf WHERE created_at > ? ORDER BY created_at DESC').all(Date.now() - days * 86400000);
  // 物理像素 = CSS 像素 × dpr。卡不卡和它、和刷新率关系最大
  const physical = (r) => `${Math.round(r.screen_w * r.dpr)}x${Math.round(r.screen_h * r.dpr)}@${r.hz}Hz`;
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
  // 分组时去掉「处理中」的：上传、导出的时候掉帧是正常的，混进来会把静置时的数拉低
  const groups = new Map();
  for (const r of rows.filter((r) => !r.busy)) {
    const key = `${physical(r)} | ${shortUa(r.ua)} | ${(r.gpu ?? '').slice(0, 60)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  console.log('按屏幕、浏览器、显卡分组（不含处理照片时的），掉帧多的在前：');
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
