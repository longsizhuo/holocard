/**
 * 生成珠光底漂移的关键帧（贴进 src/demo/style.css 里 pearl-drift-a / pearl-drift-b 那两段）
 *
 * 为什么要生成：珠光底是两层铺满屏幕、带 60px 模糊的渐变，漂移靠 background-position，
 * 每变一次就要整层重新光栅化。原来按屏幕刷新率每帧都变（60～240 次/秒），而漂移一圈要 34/47 秒，
 * 相邻两帧的画面差不到 1/255，全浪费了——4K 高刷屏上能把 RTX 4080 的风扇跑起来。
 * 现在改成每秒只变 HZ 次，运动轨迹和快慢曲线（ease-in-out）保持不变：
 *   把 ease-in-out 按时间采样成 SEGMENTS 段，每段内部用 steps() 以 HZ 的频率推进。
 * 直接写 steps() 不行：它会替掉 ease-in-out，变成匀速。
 *
 * 用法：node scripts/pearl-keyframes.mjs，把输出贴回 style.css。
 */

/** 每秒刷新几次。每步的画面变化最多 3～4/255，和每帧本来就有的渐变抖动噪声同一量级 */
const HZ = 12;

const ANIMATIONS = [
  {
    name: 'pearl-drift-a',
    seconds: 34,
    // 三层渐变各自的起止位置（x, y，单位 %），和原来的 from / to 一致
    from: [[0, 0], [100, 0], [50, 100]],
    to: [[100, 60], [0, 80], [0, 0]],
  },
  {
    name: 'pearl-drift-b',
    seconds: 47,
    from: [[100, 100], [0, 0]],
    to: [[20, 0], [80, 100]],
  },
];

/** ease-in-out = cubic-bezier(0.42, 0, 0.58, 1)：给定时间比例 x，求进度 y */
function easeInOut(x) {
  const [x1, y1, x2, y2] = [0.42, 0, 0.58, 1];
  const bez = (t, a, b) => 3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  // x 关于 t 单调，二分求 t
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bez(mid, x1, x2) < x) lo = mid;
    else hi = mid;
  }
  return bez((lo + hi) / 2, y1, y2);
}

/** 把曲线切成 segments 段折线时，和真曲线的最大偏差（进度的比例） */
function maxError(segments) {
  let worst = 0;
  for (let i = 0; i < segments; i++) {
    const a = i / segments;
    const b = (i + 1) / segments;
    const ya = easeInOut(a);
    const yb = easeInOut(b);
    for (let k = 1; k < 20; k++) {
      const x = a + ((b - a) * k) / 20;
      worst = Math.max(worst, Math.abs(easeInOut(x) - (ya + ((yb - ya) * (x - a)) / (b - a))));
    }
  }
  return worst;
}

/** 折线偏差控制在全程位移的 0.2% 以内：珠光一层位移约 1.5 个屏宽，4K 下是 10 个像素上下，又糊了 60px，看不出来 */
const TOLERANCE = 0.002;

const round = (v) => Math.round(v * 100) / 100;
const lines = [];
for (const anim of ANIMATIONS) {
  let segments = 2;
  while (maxError(segments) > TOLERANCE) segments++;
  const steps = Math.round((anim.seconds / segments) * HZ);
  lines.push(
    `/* ${anim.seconds}s，${segments} 段，每段 steps(${steps}) ≈ 每秒 ${HZ} 次；由 scripts/pearl-keyframes.mjs 生成，折线和 ease-in-out 最大偏差 ${(maxError(segments) * 100).toFixed(2)}% */`,
    `@keyframes ${anim.name} {`,
  );
  for (let i = 0; i <= segments; i++) {
    const p = easeInOut(i / segments);
    const pos = anim.from
      .map(([fx, fy], j) => {
        const [tx, ty] = anim.to[j] ?? [fx, fy];
        return `${round(fx + (tx - fx) * p)}% ${round(fy + (ty - fy) * p)}%`;
      })
      .join(', ');
    const timing = i < segments ? ` animation-timing-function: steps(${steps});` : '';
    lines.push(`  ${round((i / segments) * 100)}% { background-position: ${pos};${timing} }`);
  }
  lines.push('}');
}
console.log(lines.join('\n'));
