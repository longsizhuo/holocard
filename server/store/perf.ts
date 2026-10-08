/**
 * 性能埋点的接收端：POST /api/perf，前端 src/demo/perf.ts 每次页面访问最多发一条。
 *
 * 这个接口在公网上谁都能打，所以每个字段都按下面的规则校验：数字必须有限、在范围内，
 * 字符串截断、去掉控制字符。不合规的整条丢掉，而不是截到边界值——截出来的数会混进统计里分不出来。
 * 不存 IP、不存任何能把两条记录连到同一个人的 id。
 */

import type { IncomingMessage } from 'node:http';

/** 数字字段：[最小, 最大, 保留几位小数]；required 的缺了整条不要 */
interface NumRule {
  min: number;
  max: number;
  digits: number;
  required?: boolean;
}

/** 字段名就是数据库的列名 */
const NUMBERS = {
  fps: { min: 0, max: 1000, digits: 1, required: true },
  /** 帧间隔的中位数、95 分位、最大值（毫秒） */
  p50: { min: 0, max: 60000, digits: 1, required: true },
  p95: { min: 0, max: 60000, digits: 1, required: true },
  max_ms: { min: 0, max: 60000, digits: 1, required: true },
  /** 估出来的屏幕刷新率 */
  hz: { min: 0, max: 1000, digits: 0, required: true },
  /** 掉帧比例：按刷新率本该出的帧里，有多少没出 */
  dropped: { min: 0, max: 1, digits: 3, required: true },
  frames: { min: 1, max: 100000, digits: 0, required: true },
  /** 屏幕和窗口的 CSS 像素，乘上 dpr 才是物理像素 */
  screen_w: { min: 0, max: 100000, digits: 0, required: true },
  screen_h: { min: 0, max: 100000, digits: 0, required: true },
  view_w: { min: 0, max: 100000, digits: 0, required: true },
  view_h: { min: 0, max: 100000, digits: 0, required: true },
  dpr: { min: 0, max: 16, digits: 2, required: true },
  cores: { min: 0, max: 1024, digits: 0 },
  /** navigator.deviceMemory，GB，只有 Chromium 有 */
  memory: { min: 0, max: 1024, digits: 2 },
} satisfies Record<string, NumRule>;

/** 开关类字段，存 0 / 1 */
const FLAGS = ['parallax', 'busy', 'interacted', 'reduced_motion'] as const;

/** 首页（摆的是示例卡）或 /c/<id> 卡片页，和 src/demo/route.ts 的 PageMode 同名 */
const MODES = new Set(['demo', 'card']);

export type PerfSample = Record<string, string | number | null>;

/** 去掉控制字符再截断。显卡名、UA 会原样进库，也会被打到终端里 */
function cleanText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
  return text || null;
}

/** 校验前端发来的一条，加上服务端自己知道的字段。不合规返回 null */
export function parsePerf(body: unknown, req: IncomingMessage): PerfSample | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (typeof input['mode'] !== 'string' || !MODES.has(input['mode'])) return null;

  const sample: PerfSample = { created_at: Date.now(), mode: input['mode'] };
  for (const [key, rule] of Object.entries(NUMBERS) as [string, NumRule][]) {
    const value = input[key];
    if (value === undefined || value === null) {
      if (rule.required) return null;
      sample[key] = null;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max) return null;
    const scale = 10 ** rule.digits;
    sample[key] = Math.round(value * scale) / scale;
  }
  for (const key of FLAGS) {
    const value = input[key];
    if (typeof value !== 'boolean') return null;
    sample[key] = value ? 1 : 0;
  }
  sample['gpu'] = cleanText(input['gpu'], 160);
  // UA 和国家从请求头取，不让前端自己报
  sample['ua'] = cleanText(req.headers['user-agent'], 300);
  const country = req.headers['cf-ipcountry'];
  sample['country'] = typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? country : null;
  return sample;
}

/** 列名和类型都从上面的规则来，db.ts 建表、插入用这一份，不会两边对不上 */
const COLUMN_TYPES: [string, string][] = [
  ['created_at', 'INTEGER NOT NULL'],
  ['mode', 'TEXT NOT NULL'],
  ...(Object.entries(NUMBERS) as [string, NumRule][]).map(([key, rule]): [string, string] => [
    key,
    rule.digits === 0 ? 'INTEGER' : 'REAL',
  ]),
  ...FLAGS.map((key): [string, string] => [key, 'INTEGER']),
  ['gpu', 'TEXT'],
  ['ua', 'TEXT'],
  ['country', 'TEXT'],
];

export const PERF_COLUMNS = COLUMN_TYPES.map(([key]) => key);

/**
 * ponytail: CREATE TABLE IF NOT EXISTS 不会给已有的表加列。
 * 以后加字段要么在 db.ts 里补一句 ALTER TABLE，要么（数据只是埋点）直接 DROP 掉重建
 */
export const PERF_SCHEMA = `
CREATE TABLE IF NOT EXISTS perf (
  ${COLUMN_TYPES.map(([key, type]) => `${key} ${type}`).join(',\n  ')}
);
CREATE INDEX IF NOT EXISTS perf_created ON perf(created_at);
`;
