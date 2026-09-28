/**
 * 性能埋点：页面打开、静置下来之后量一次帧率，发给自己的服务端（POST /api/perf，见 server/perf.ts）。
 *
 * 为什么要有：有人反馈 4K 屏 + RTX 4080 打开风扇狂转、卡顿，手机上却完全正常——
 * 问题只出在某些屏幕、显卡的组合上，光靠口头反馈没法知道修好了没有、还有谁在卡。
 *
 * 怎么量：用 requestAnimationFrame 记 10 秒里每一帧的间隔。
 * 合成、光栅跟不上的时候，Chromium 会连主线程的帧一起降下来，所以 rAF 的间隔反映的是
 * 整条渲染流水线跑得动跑不动，不只是 JS。页面中途切到后台（rAF 会停）这一轮就作废，回来再重量。
 *
 * 不收什么：不带任何 id、服务端不存 IP，一次页面访问最多发一条。
 * 不走 umami：staging 不接 umami，而且 umami 的事件只适合计数，算不了分位数。
 */

/** 量多久。珠光底每秒变 12 次、扫光几秒一轮，10 秒能把它们都覆盖到 */
const WINDOW_MS = 10_000;
/** 首屏的一次性工作（解码图层、生成纹理）做完再量，别把加载的卡顿算进来 */
const SETTLE_MS = 3_000;

/** 量的时候页面处于什么状态：数据要按这些分开看 */
export interface PerfState {
  /** 立体视差开着没有 */
  parallax: boolean;
  /** 正在处理用户传的照片（上传、分层、导出），这时候掉帧是正常的 */
  busy: boolean;
}

/** 一轮测量：量完发出去；页面切到后台就作废，回到前台再从头来 */
function measure(mode: string, state: () => PerfState, restart: () => void): void {
  // 等的这 3 秒里切走了：rAF 不会跑，也就收不到下面的 visibilitychange，回来要重新等页面静下来
  if (document.hidden) {
    restart();
    return;
  }
  const times: number[] = [];
  let hidden = false;
  let interacted = false;
  let busy = state().busy;

  const onVisibility = (): void => {
    if (document.hidden) hidden = true;
  };
  const onInput = (): void => {
    interacted = true;
  };
  const inputs = ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const;
  document.addEventListener('visibilitychange', onVisibility);
  for (const type of inputs) addEventListener(type, onInput, { passive: true, capture: true });
  const cleanup = (): void => {
    document.removeEventListener('visibilitychange', onVisibility);
    for (const type of inputs) removeEventListener(type, onInput, { capture: true });
  };

  const frame = (now: number): void => {
    if (hidden) {
      cleanup();
      restart();
      return;
    }
    times.push(now);
    busy ||= state().busy;
    if (now - (times[0] ?? now) < WINDOW_MS) {
      requestAnimationFrame(frame);
      return;
    }
    cleanup();
    send(mode, times, { parallax: state().parallax, busy }, interacted);
  };
  requestAnimationFrame(frame);
}

/** 汇总成一条发出去 */
function send(mode: string, times: number[], state: PerfState, interacted: boolean): void {
  const gaps = times
    .slice(1)
    .map((t, i) => t - (times[i] ?? t))
    .sort((a, b) => a - b);
  if (gaps.length < 2) return;
  const at = (p: number): number => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] ?? 0;

  /*
   * 屏幕刷新间隔：最快那一成帧附近的间隔取平均。整页都卡的时候这个估计会偏大，要和 fps 一起看。
   * 不能直接拿第 10 百分位：Safari 的 rAF 时间戳只精确到 1ms，60Hz 的间隔在 16 和 17 之间来回跳，
   * 取到 16 就报成 63Hz（120Hz 报成 125）。取平均就还原回来了
   */
  const fast = gaps.filter((g) => g <= at(0.1) * 1.5);
  const vsync = Math.max(fast.reduce((a, b) => a + b, 0) / Math.max(1, fast.length), 1);
  // 每个间隔里本该出几帧：间隔是刷新间隔的 3 倍，就是掉了 2 帧
  let dropped = 0;
  for (const gap of gaps) dropped += Math.max(0, Math.round(gap / vsync) - 1);
  const seconds = ((times.at(-1) ?? 0) - (times[0] ?? 0)) / 1000;

  const nav = navigator as Navigator & { deviceMemory?: number };
  const sample = {
    mode,
    fps: gaps.length / seconds,
    p50: at(0.5),
    p95: at(0.95),
    max_ms: gaps.at(-1) ?? 0,
    hz: Math.round(1000 / vsync),
    dropped: dropped / (dropped + gaps.length),
    frames: gaps.length,
    screen_w: screen.width,
    screen_h: screen.height,
    view_w: innerWidth,
    view_h: innerHeight,
    dpr: devicePixelRatio,
    cores: nav.hardwareConcurrency ?? null,
    memory: nav.deviceMemory ?? null,
    gpu: gpuName(),
    parallax: state.parallax,
    busy: state.busy,
    interacted,
    reduced_motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
  navigator.sendBeacon(
    `${import.meta.env.BASE_URL}api/perf`,
    new Blob([JSON.stringify(sample)], { type: 'application/json' }),
  );
}

/**
 * 显卡型号，卡不卡很大程度上看它。量完之后才取：要临时建一个 WebGL 上下文，别让它干扰测量。
 * 要 low-power：双显卡的 Mac 上默认的上下文可能把独显叫醒，而页面本身用的是核显。
 * Safari 只会说 Apple GPU，Firefox 给的是归并过的大类，都没关系
 */
function gpuName(): string | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl', { powerPreference: 'low-power' });
    if (!gl) return null;
    // Chromium、Safari 的 RENDERER 是屏蔽过的「WebKit WebGL」，真名要走调试扩展；
    // Firefox 的 RENDERER 本来就是真名，而且去拿那个扩展会在控制台报弃用警告，所以先看 RENDERER
    let name = String(gl.getParameter(gl.RENDERER));
    if (name === 'WebKit WebGL') {
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      if (debug) name = String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL));
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return null;
  }
}

/** 页面在前台、静置 SETTLE_MS 之后开始量，量完一次就不再量。render 模式（无头截图）不要调 */
export function measurePerf(mode: string, state: () => PerfState): void {
  if (typeof navigator.sendBeacon !== 'function') return;
  const start = (): void => {
    if (document.hidden) {
      document.addEventListener('visibilitychange', start, { once: true });
      return;
    }
    setTimeout(() => measure(mode, state, start), SETTLE_MS);
  };
  start();
}
