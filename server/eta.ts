/**
 * 剩余时间估计，给前端的倒计时用（GET /api/jobs/{id} 的 eta 字段）。
 *
 * 分层流水线里最久的两步（估深度、抠主体）是整张图一次交给模型，中途报不了进度，
 * 所以只能按阶段估：每个阶段用这台服务器最近几张图的实际耗时做指数平均，
 * 当前阶段还剩「平均 − 已用」，再加上后面各阶段的平均。
 * 按服务器自己的实测走，而不是写死：staging 只有 1 核、比线上慢一倍，机器忙的时候也会慢，都能自己跟上。
 * 计时用单调时钟（performance.now）：系统校时一跳，墙钟算出来的耗时会是负的或者几千秒，把平均带偏十几张图
 */

/** 流水线的阶段顺序。saving 是工作线程报完 done 之后、主线程转 WebP 写盘那一段 */
const STAGES = ['loading-model', 'estimating-depth', 'analyzing', 'finding-subject', 'extracting', 'saving'] as const;
type Stage = (typeof STAGES)[number];

/**
 * 初值：线上条件（2 核）实测的一张图各阶段耗时，秒，模型已经加载好的情况。
 * 加载模型只有重启后第一张慢（七八秒），平时一瞬间
 */
const average: Record<Stage, number> = {
  'loading-model': 1,
  'estimating-depth': 6,
  analyzing: 0.5,
  'finding-subject': 28,
  extracting: 3,
  saving: 1,
};
/** 新样本的权重。三五张图就能跟上机器的变化，又不至于被一张特别大的图带偏 */
const WEIGHT = 0.3;

interface Clock {
  matte: boolean;
  stage: Stage;
  since: number;
  spent: Partial<Record<Stage, number>>;
}
const clocks = new Map<string, Clock>();

function toStage(stage: string): Stage | null {
  // 工作线程报 done 时分层算完了，主线程还要转 WebP、写盘
  if (stage === 'done') return 'saving';
  return (STAGES as readonly string[]).includes(stage) ? (stage as Stage) : null;
}

/** 一张图开始处理 */
export function startJob(id: string, matte: boolean, now = performance.now()): void {
  clocks.set(id, { matte, stage: 'loading-model', since: now, spent: {} });
}

/** 进入下一个阶段，顺手记下上一个阶段用了多久 */
export function enterStage(id: string, stage: string, now = performance.now()): void {
  const clock = clocks.get(id);
  const next = toStage(stage);
  if (!clock || !next || next === clock.stage) return;
  clock.spent[clock.stage] = (now - clock.since) / 1000;
  clock.stage = next;
  clock.since = now;
}

/** 做完了：各阶段的实际耗时计入平均。失败的不计，免得半截的数把平均拉低 */
export function finishJob(id: string, ok: boolean, now = performance.now()): void {
  const clock = clocks.get(id);
  clocks.delete(id);
  if (!clock || !ok) return;
  clock.spent[clock.stage] = (now - clock.since) / 1000;
  for (const stage of STAGES) {
    const seconds = clock.spent[stage];
    if (seconds !== undefined) average[stage] = average[stage] * (1 - WEIGHT) + Math.max(0, seconds) * WEIGHT;
  }
}

/** 一整张图预计多少秒（排队时算前面每一张用） */
function jobSeconds(matte: boolean): number {
  return STAGES.reduce((sum, stage) => (stage === 'finding-subject' && !matte ? sum : sum + average[stage]), 0);
}

/** 正在处理的这张还要多少秒。当前阶段超时了按 1 秒算：倒计时停在后面几步的时间上，不会变成负数 */
export function runningEta(id: string, now = performance.now()): number | null {
  const clock = clocks.get(id);
  if (!clock) return null;
  const at = STAGES.indexOf(clock.stage);
  let rest = Math.max(1, average[clock.stage] - (now - clock.since) / 1000);
  for (const stage of STAGES.slice(at + 1)) {
    if (stage === 'finding-subject' && !clock.matte) continue;
    rest += average[stage];
  }
  return rest;
}

/**
 * 排队的这张还要多少秒：正在处理的那张剩下的，加上前面排着的，加上自己。
 * ponytail: 按一次只处理一张算（线上 HOLOCARD_CONCURRENCY=1，分层工作线程本来也是一次一张）
 */
export function queuedEta(position: number, matte: boolean, now = performance.now()): number {
  let current = 0;
  for (const id of clocks.keys()) current = Math.max(current, runningEta(id, now) ?? 0);
  return current + position * jobSeconds(matte);
}
