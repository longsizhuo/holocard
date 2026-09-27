/**
 * 生成珠光底的漂移动画：src/demo/pearl-drift.css（动画声明 + 关键帧，不要手改）
 *
 * 为什么要生成：珠光底是两层铺满屏幕、带 60px 模糊的渐变，漂移靠 background-position，
 * 每变一次就要整层重新光栅化。原来按屏幕刷新率每帧都变（60～240 次/秒），而漂移一圈要 34/47 秒，
 * 相邻两帧的画面差不到 1/255，全浪费了——4K 高刷屏上能把 RTX 4080 的风扇跑起来。
 * 现在改成每秒只变 HZ 次，运动轨迹和快慢曲线（ease-in-out）保持不变：
 *   把 ease-in-out 按时间采样成若干段，每段内部用 steps() 以 HZ 的频率推进。
 * 直接写 steps() 不行：它会替掉 ease-in-out，变成匀速。
 *
 * 用法：
 *   node scripts/pearl-keyframes.mjs          改完下面的配置后重新生成 src/demo/pearl-drift.css
 *   node scripts/pearl-keyframes.mjs --check  只核对不写：生成结果和已提交的文件是否一致、
 *                                             每层的渐变数和 style.css 是否对得上。pnpm build 会先跑它
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/demo/pearl-drift.css');
const STYLE = join(ROOT, 'src/demo/style.css');

/** 每秒刷新几次。每步的画面变化最多 4/255，和每帧本来就有的渐变抖动噪声同一量级 */
export const HZ = 12;

/**
 * 两层漂移的全部参数，时长只在这里写。
 * from / to 是每个渐变的起止位置（x, y，单位 %），个数必须和 style.css 里这一层的 radial-gradient 个数一致
 */
export const ANIMATIONS = [
  {
    name: 'pearl-drift-a',
    selector: '.pearl::before',
    seconds: 34,
    from: [[0, 0], [100, 0], [50, 100]],
    to: [[100, 60], [0, 80], [0, 0]],
  },
  {
    name: 'pearl-drift-b',
    selector: '.pearl::after',
    seconds: 47,
    from: [[100, 100], [0, 0]],
    to: [[20, 0], [80, 100]],
  },
];

/** ease-in-out = cubic-bezier(0.42, 0, 0.58, 1)：给定时间比例 x，求进度 y */
export function easeInOut(x) {
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

/** 某个进度下每个渐变的位置，写成 background-position 的值 */
export function positionsAt(anim, progress) {
  return anim.from
    .map(([fx, fy], j) => {
      const [tx, ty] = anim.to[j];
      return `${round(fx + (tx - fx) * progress)}% ${round(fy + (ty - fy) * progress)}%`;
    })
    .join(', ');
}

function generate() {
  for (const anim of ANIMATIONS) {
    // 个数对不上时宁可报错：用起点顶上的话，那个渐变就一直不动，还看不出来
    if (anim.from.length !== anim.to.length) {
      throw new Error(`${anim.name}：from 有 ${anim.from.length} 个位置，to 有 ${anim.to.length} 个`);
    }
  }

  const out = [
    '/*',
    ' * 珠光底的漂移动画。由 scripts/pearl-keyframes.mjs 生成，不要手改：',
    ' * 改那个脚本里的配置再重新生成；pnpm build 会先跑 --check，对不上就构建失败。',
    ' * 为什么是这个写法见那个脚本开头。',
    ' *',
    ' * 只在没开「减少动态效果」时生效：开了珠光就是静止的，也就不必把两层提成合成层。',
    ' */',
    '@media (prefers-reduced-motion: no-preference) {',
    ...ANIMATIONS.map((a) => `  ${a.selector} { animation: ${a.name} ${a.seconds}s linear infinite alternate; }`),
    '',
    '  /*',
    '   * will-change: filter 让模糊交给合成器对整层做一次，不再在每个光栅分块里各算一遍（分块要外扩 3 倍模糊半径），',
    '   * Chromium 上每帧的开销减半。只给 Chromium：WebKit（Safari）提成合成层后屏幕四周那圈模糊会变样（最多差 18/255），',
    '   * 而 Safari 本来就没有这个性能问题。-webkit-app-region 只有 Chromium 认，拿它来区分',
    '   */',
    '  @supports (-webkit-app-region: drag) {',
    `    ${ANIMATIONS.map((a) => a.selector).join(', ')} { will-change: filter; }`,
    '  }',
    '}',
  ];
  for (const anim of ANIMATIONS) {
    let segments = 2;
    while (maxError(segments) > TOLERANCE) segments++;
    const steps = Math.round((anim.seconds / segments) * HZ);
    out.push(
      '',
      `/* ${anim.seconds}s，${segments} 段，每段 steps(${steps}) ≈ 每秒 ${HZ} 次；折线和 ease-in-out 最大偏差 ${(maxError(segments) * 100).toFixed(2)}%。快慢曲线已经烘进关键帧，所以上面写 linear */`,
      `@keyframes ${anim.name} {`,
    );
    for (let i = 0; i <= segments; i++) {
      const timing = i < segments ? ` animation-timing-function: steps(${steps});` : '';
      out.push(`  ${round((i / segments) * 100)}% { background-position: ${positionsAt(anim, easeInOut(i / segments))};${timing} }`);
    }
    out.push('}');
  }
  return `${out.join('\n')}\n`;
}

/** 核对：生成结果和已提交的文件一致；style.css 里每层的渐变数和配置一致；style.css 里没有残留同名关键帧 */
function check(css) {
  const problems = [];
  let committed = '';
  try {
    committed = readFileSync(OUT, 'utf8');
  } catch {
    problems.push(`${OUT} 不存在`);
  }
  if (committed && committed !== css) problems.push('src/demo/pearl-drift.css 和生成结果不一致：改了配置忘了重新生成，或者有人手改了它');

  const style = readFileSync(STYLE, 'utf8');
  for (const anim of ANIMATIONS) {
    // 找这一层写了 background-image 的那条规则，数里面的 radial-gradient。
    // 同一个选择器还出现在「.pearl::before, .pearl::after { … }」这种共用规则里，那条没有渐变，跳过
    let gradients = 0;
    for (let at = style.indexOf(`${anim.selector} {`); at >= 0; at = style.indexOf(`${anim.selector} {`, at + 1)) {
      const block = style.slice(at, style.indexOf('\n}', at));
      if (block.includes('background-image')) gradients += (block.match(/radial-gradient\(/g) ?? []).length;
    }
    if (gradients !== anim.from.length) {
      problems.push(`style.css 里 ${anim.selector} 有 ${gradients} 个渐变，配置里 ${anim.name} 有 ${anim.from.length} 个位置`);
    }
    if (style.includes(`@keyframes ${anim.name}`)) {
      problems.push(`style.css 里还有一份 @keyframes ${anim.name}，会和生成的那份打架`);
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const css = generate();
  if (process.argv.includes('--check')) {
    const problems = check(css);
    if (problems.length > 0) {
      console.error(`珠光动画核对不通过：\n- ${problems.join('\n- ')}\n改完 scripts/pearl-keyframes.mjs 的配置后运行 node scripts/pearl-keyframes.mjs 重新生成`);
      process.exit(1);
    }
    console.log('珠光动画核对通过');
  } else {
    writeFileSync(OUT, css);
    console.log(`已写入 ${OUT}`);
  }
}
