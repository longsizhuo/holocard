/** 做卡时的进度条和剩余时间 */

import type { MessageKey } from '../../src/i18n';
import { need, setText } from './text';

const progress = need<HTMLDivElement>('#progress');
const progressFill = need<HTMLElement>('#progress-fill');
const progressText = need<HTMLSpanElement>('#progress-text');
const progressEta = need<HTMLSpanElement>('#progress-eta');

/**
 * 进度条按阶段走，阶段内按预计耗时自己往前挪：[起点, 终点, 预计秒数]。
 *
 * 服务端只告诉我们「现在在哪一步」，给不出百分比——抠主体、估深度都是整张图一次交给模型，
 * 中途没有进度可报。以前整个处理过程进度条都停在 5%，抠主体那一步二十几秒一动不动，像卡死了。
 * 进入一个阶段时跳到它的起点，然后按 1 − e^(−2t/预计) 往终点靠：到预计时间走完约八成六，
 * 超时了也还在慢慢动，但不越过终点、也不倒退。
 * 区间宽窄和秒数是线上（2 核）实测的一张图的耗时分布，流水线变了要跟着改；没列出来的（重连）原地不动。
 * 服务端给了剩余时间（见 etaSeconds）就按剩余时间走，这张表只管上传前后、老版本服务端和浏览器端处理
 */
const PROGRESS_SPANS: Partial<Record<MessageKey, readonly [number, number, number]>> = {
  'progress.preparing': [0, 0.02, 1],
  'progress.shrinking': [0.01, 0.04, 2],
  'progress.uploading': [0.03, 0.1, 3],
  'progress.queued': [0.1, 0.12, 30],
  'progress.serverWorking': [0.12, 0.93, 40],
  'stage.loading-model': [0.12, 0.2, 8],
  'stage.estimating-depth': [0.2, 0.3, 5],
  'stage.analyzing': [0.3, 0.32, 1],
  'stage.finding-subject': [0.32, 0.86, 28],
  'stage.extracting': [0.86, 0.91, 3],
  'stage.finding-effects': [0.91, 0.93, 2],
  'stage.done': [0.93, 0.95, 1],
  'progress.fetching': [0.95, 0.99, 2],
};
let progressKey: MessageKey | null = null;
/** 这个阶段从什么时候、从进度条的哪里开始走 */
let progressSince = 0;
let progressBase = 0;
let progressAt = 0;
let progressTimer = 0;
/**
 * 服务端给的剩余秒数（见 server/pipeline/eta.ts）和收到它的时刻，倒计时在两次轮询之间自己往下走。
 * 有它的时候进度条也跟着它走：「已用 / (已用 + 剩余)」，和倒计时说的是同一件事
 */
let etaSeconds: number | null = null;
let etaAt = 0;
let etaStart = 0;
let etaBase = 0;
let etaShown = -1;

function setProgressBar(ratio: number): void {
  progressAt = ratio;
  progressFill.style.width = `${(ratio * 100).toFixed(1)}%`;
}

function tickProgress(): void {
  if (etaSeconds !== null) {
    const now = performance.now();
    const left = Math.max(0, etaSeconds - (now - etaAt) / 1000);
    const spent = (now - etaStart) / 1000;
    // 剩余至少按 1 秒算：估计的时间用完了、结果还没到，进度条慢慢逼近 95%，而不是一下子顶满
    setProgressBar(Math.max(progressAt, etaBase + (0.95 - etaBase) * (spent / (spent + Math.max(1, left)))));
    /*
     * 最后几秒不数了。估计本来就没那么准，而且抠主体超时时服务端的剩余时间会停在
     * 「后面几步的时间」上（约 5 秒）不再减少——停在一个具体数字上最难等，不如说「马上就好」
     */
    let shown = left > 5 ? Math.ceil(left) : 0;
    /*
     * 数字只往下走。当前阶段比平均慢时服务端的估计会停住，前端两次轮询之间自己减 1、下次轮询又被拉回，
     * 就成了 40→39→40、6→马上就好→6 来回跳。明显上调（排队的人变多了）才跟着改
     */
    if (etaShown >= 0 && shown > etaShown && shown - etaShown < 10) shown = etaShown;
    if (shown !== etaShown) {
      etaShown = shown;
      if (shown > 0) setText(progressEta, 'progress.eta', { s: shown });
      else setText(progressEta, 'progress.almost');
    }
    return;
  }
  const span = progressKey ? PROGRESS_SPANS[progressKey] : undefined;
  if (!span) return;
  const [, to, seconds] = span;
  const t = (performance.now() - progressSince) / 1000;
  setProgressBar(Math.max(progressAt, progressBase + (to - progressBase) * (1 - Math.exp((-2 * t) / seconds))));
}

export function showProgress(
  key: MessageKey,
  params?: Record<string, string | number>,
  ratio?: number,
  eta?: number,
): void {
  progress.hidden = false;
  setText(progressText, key, params);
  if (eta !== undefined) {
    const now = performance.now();
    if (etaSeconds === null) {
      etaStart = now;
      etaBase = progressAt;
    }
    etaSeconds = eta;
    etaAt = now;
    progressEta.hidden = false;
  } else {
    etaSeconds = null;
    etaShown = -1;
    progressEta.hidden = true;
  }
  if (ratio !== undefined) {
    // 有确切比例的只有浏览器端下载模型：它只占「加载模型」那一段，直接用的话下完就是 100%，
    // 后面几十秒的推理进度条一直顶满。只进不退：汇总进度和单个文件的进度是交替报上来的
    progressKey = null;
    const [from, to] = PROGRESS_SPANS['stage.loading-model'] ?? [0, 1];
    setProgressBar(Math.max(progressAt, from + (to - from) * ratio));
    return;
  }
  // 轮询每秒都会报一次同一个阶段，只在换阶段时重新计时
  if (key !== progressKey) {
    progressKey = key;
    progressSince = performance.now();
    // 跳到新阶段的起点；已经走过起点了就从当前位置接着走，不倒退
    progressBase = Math.max(PROGRESS_SPANS[key]?.[0] ?? 0, progressAt);
  }
  progressTimer ||= window.setInterval(tickProgress, 250);
  tickProgress();
}

export function hideProgress(): void {
  progress.hidden = true;
  progressEta.hidden = true;
  etaSeconds = null;
  etaShown = -1;
  window.clearInterval(progressTimer);
  progressTimer = 0;
  progressKey = null;
  setProgressBar(0);
}
