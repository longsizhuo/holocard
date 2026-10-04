/** 演示页：加载素材、接分层流水线、挂调参面板 */

import './style.css';
// 珠光底的漂移动画，由 scripts/pearl-keyframes.mjs 生成
import './pearl-drift.css';
import { HoloCard } from '../renderer/card';
import { ensureTextures } from '../renderer/textures';
import { LayerFormatError, loadLayerSet } from '../format/io';
import { FOIL_TYPES, type FoilType, type LayerSet, type ParallaxEffect } from '../format/types';
import {
  ApiError,
  apiError,
  apiHeaders,
  deleteCard,
  NoBackendError,
  ownedToken,
  rememberOwned,
  saveConfig,
  segmentOnServer,
} from './api';
import { configOf, type CardConfig } from '../format/config';
import { initAlbums, openAlbums } from './albums-ui';
import { Deck, forgetSession } from './deck';
import { reducedMotion } from './pack';
import { initTracking, pageView, track } from './track';
import { measurePerf } from './perf';
import { parseRoute, shareUrl } from './route';
import {
  blockingInAppBrowser,
  detectPlatform,
  download,
  fetchFiles,
  FORMAT_FOR,
  requestExport,
  type Platform,
} from './export';
import {
  applyTranslations,
  lang,
  LANGS,
  onLangChange,
  setLang,
  t,
  type Lang,
  type MessageKey,
} from '../i18n';

/** 取元素并断言存在，省掉一堆空判断 */
function need<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`页面上找不到 ${selector}`);
  return el;
}

const FOIL_LABEL: Record<FoilType, MessageKey> = {
  none: 'foil.none',
  holo: 'foil.holo',
  sunpillar: 'foil.sunpillar',
  rainbow: 'foil.rainbow',
};

const status = need<HTMLParagraphElement>('#status');
const foilList = need<HTMLDivElement>('#foil-list');


const ctlAmp = need<HTMLInputElement>('#ctl-amp');
const ctlIntensity = need<HTMLInputElement>('#ctl-intensity');
const ctlSharp = need<HTMLInputElement>('#ctl-sharp');

const outAmp = need<HTMLOutputElement>('#out-amp');
const outIntensity = need<HTMLOutputElement>('#out-intensity');
const outSharp = need<HTMLOutputElement>('#out-sharp');
const outHalo = need<HTMLOutputElement>('#out-halo');
const haloFill = need<HTMLElement>('#halo-fill');

const drop = need<HTMLDivElement>('#drop');
const filePicker = need<HTMLInputElement>('#file');
const progress = need<HTMLDivElement>('#progress');
const progressFill = need<HTMLElement>('#progress-fill');
const progressText = need<HTMLSpanElement>('#progress-text');
const progressEta = need<HTMLSpanElement>('#progress-eta');

const shareBox = need<HTMLDivElement>('#share');
const shareBtn = need<HTMLButtonElement>('#share-btn');
const shareResult = need<HTMLDivElement>('#share-result');
const ownerBox = need<HTMLDivElement>('#owner');
const deleteBtn = need<HTMLButtonElement>('#delete-btn');
const deleteHint = need<HTMLElement>('#delete-hint');
const shareUrlInput = need<HTMLInputElement>('#share-url');
const shareCopy = need<HTMLButtonElement>('#share-copy');
const shareHint = need<HTMLElement>('#share-hint');
const exportBox = need<HTMLDivElement>('#export');
const exportBtn = need<HTMLButtonElement>('#export-btn');
const exportHint = need<HTMLElement>('#export-hint');
const langButtons = [...document.querySelectorAll<HTMLButtonElement>('.lang [data-lang]')];

const route = parseRoute();
const ctlParallax = need<HTMLInputElement>('#ctl-parallax');

/** 立体视差开关记在本机。隐私模式下读写 localStorage 会抛，当作没记过 */
const PARALLAX_KEY = 'holocard:parallax';
try {
  ctlParallax.checked = localStorage.getItem(PARALLAX_KEY) !== 'off';
} catch {
  // 同上
}

/** 当前该用的视差振幅：开关关着就是 0（平面卡），开着按滑块 */
function amplitude(): number {
  return ctlParallax.checked ? Number(ctlAmp.value) / 100 : 0;
}
ctlAmp.disabled = !ctlParallax.checked;

const card = new HoloCard(need<HTMLDivElement>('.deck__card'), { amplitude: amplitude() });
const panel = need<HTMLElement>('.panel');

/*
 * 卡带：这次访问做的卡左右切换，上传时最右边先放一个卡包（见 deck.ts）。
 * 卡片格用上面这个 HoloCard，面板跟着当前这张卡走；切到卡包格时面板上跟卡有关的先收起来
 */
const deck = new Deck(need<HTMLElement>('.deck'), {
  showCard: (set, id) => show(set, id),
  showPack: showPackPanel,
  revealed: (set, id, method) => {
    show(set, id);
    track('pack-open', { how: method });
    if (id && ownedToken(id) === null) markSeen(id);
    // 地址栏换成这张卡的链接：用浏览器菜单分享、复制地址、刷新，拿到的都是这张卡而不是首页。
    // replaceState 只改地址，不刷新页面，也不多一条后退记录
    if (id) history.replaceState(history.state, '', shareUrl(id, lang()));
  },
  load: (id) => loadLayerSet(`${import.meta.env.BASE_URL}api/layers/${id}`),
  loadFailed: (error) => setText(status, 'status.cardFailed', { message: describeError(error) }),
});

/** 当前这张卡在服务端的 id。只有服务端产出的卡才有，手工素材没有 */
let currentId: string | null = null;

// 开发环境下把实例挂到 window 上，方便在控制台里 __holocard.setPose({x:25,y:25}) 摆姿态看效果
if (import.meta.env.DEV) {
  (window as Window & { __holocard?: HoloCard }).__holocard = card;
}

/** 当前这组层。面板上的改动会同步写回这里，导出时拿到的就是调好的配置 */
let current: LayerSet | null = null;
/** 分层中，防止重复提交 */
let busy = false;

// ---------- 会变的文字 ----------

/**
 * 页面上随状态变的文字（按钮当前状态、进度、状态栏、提示）都经过这里：
 * 记住每个元素当前显示的是哪句文案、带什么参数，切换语言时原地按新语言重写一遍。
 * 不刷新页面——刷新会丢掉刚做好、还没分享的卡。
 */
const liveTexts = new Map<HTMLElement, { key: MessageKey; params?: Record<string, string | number> }>();

function setText(el: HTMLElement, key: MessageKey, params?: Record<string, string | number>): void {
  liveTexts.set(el, params ? { key, params } : { key });
  el.textContent = t(key, params);
}

function clearText(el: HTMLElement): void {
  liveTexts.delete(el);
  el.textContent = '';
}

/**
 * 把错误变成给人看的一句话。
 * 服务端的错误按 code 翻译；浏览器自己的网络错误（Load failed、Failed to fetch…）
 * 原文对用户毫无意义，统一换成「网络断了」；其余照原文。
 */
function describeError(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `error.${error.code}` as MessageKey;
    const translated = t(key, error.params);
    if (translated !== key) return translated;
  }
  // 卡过期、被删之后再打开分享链接，取 manifest 是 404
  if (error instanceof LayerFormatError && error.status === 404) return t('error.card_not_found');
  if (error instanceof TypeError && /fetch|load failed|network/i.test(error.message)) {
    return t('error.network');
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------- 导出按钮 ----------

/** 导出按钮按设备说人话：安卓叫动态照片（相册里的叫法），iPhone 存的是 GIF 动图 */
const platform = detectPlatform();
const EXPORT_LABEL: Record<Platform, MessageKey> = {
  ios: 'export.gif',
  android: 'export.motion',
  desktop: 'export.apng',
};
/** 导出进行中，防止重复点 */
let exporting = false;
/**
 * iPhone 上文件取好之后，等用户再点一次按钮才唤起分享面板：
 * Safari 只认用户点击直接唤起的 share()，等了几十秒生成之后再调会被拒绝。
 */
let pendingShare: File[] | null = null;

function resetExport(): void {
  pendingShare = null;
  exportBtn.disabled = false;
  setText(exportBtn, EXPORT_LABEL[platform]);
  clearText(exportHint);
}

// ---------- 箔面面板 ----------

/** 层的称呼：由远及近 */
function layerName(index: number, count: number): string {
  if (count === 1) return t('layer.whole');
  if (index === 0) return t('layer.far');
  if (index === count - 1) return t('layer.near');
  return count === 3 ? t('layer.middle') : t('layer.middleN', { n: index });
}

/** 按当前层数重建「各层箔面」面板。层数是算出来的，不能写死在 HTML 里 */
function buildFoilControls(set: LayerSet): void {
  foilList.replaceChildren();
  const count = set.manifest.layers.length;

  // 面板从近到远排，和肉眼看卡的顺序一致：先看到主体，再看到背景
  for (let index = count - 1; index >= 0; index--) {
    const layer = set.manifest.layers[index];
    if (!layer) continue;

    const row = document.createElement('div');
    row.className = 'foil-row';

    const name = document.createElement('span');
    name.className = 'foil-row__name';
    name.textContent = layerName(index, count);

    const select = document.createElement('select');
    for (const type of FOIL_TYPES) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = t(FOIL_LABEL[type]);
      select.append(option);
    }
    select.value = layer.foil.type;

    const strength = document.createElement('input');
    strength.type = 'range';
    strength.min = '0';
    strength.max = '1';
    strength.step = '0.05';
    strength.value = String(layer.foil.intensity);
    strength.title = t('panel.foilStrength');

    const apply = (): void => {
      layer.foil = { type: select.value as FoilType, intensity: Number(strength.value) };
      strength.disabled = layer.foil.type === 'none';
      card.setLayerFoil(index, layer.foil);
      // 静止的卡片上箔面是透明的，转过去才看得见调了什么
      card.preview();
      scheduleSave();
    };
    select.addEventListener('change', apply);
    strength.addEventListener('input', apply);
    strength.disabled = layer.foil.type === 'none';

    row.append(name, select, strength);
    foilList.append(row);
  }
}

/** 换一组层：渲染 + 重建面板 + 让面板上的全局参数继续生效 */
function show(set: LayerSet, id: string | null = null): void {
  panel.classList.remove('is-pack');
  current = set;
  currentId = id;
  // 只有服务端产出的卡才能分享；换卡时把上一张的链接收起来。
  // 卡片页（/c/<id>）上只给卡的主人：做完卡地址栏就换成了卡片链接，主人刷新后落在这里
  shareBox.hidden =
    id === null || route.mode === 'render' || (route.mode === 'card' && ownedToken(id) === null);
  shareResult.hidden = true;
  shareBtn.disabled = false;
  setText(shareBtn, 'share.create');
  // 导出不限于卡的主人：别人分享过来的卡也能存成动图
  exportBox.hidden = id === null || route.mode === 'render';
  if (!exporting) resetExport();
  // 只有手上有这张卡口令的人才看得到删除入口
  ownerBox.hidden = id === null || ownedToken(id) === null;
  deleteBtn.disabled = false;
  setText(deleteBtn, 'delete.button');

  // 方向是 manifest → 面板，和下面 buildFoilControls 处理逐层箔面的方向一致。
  // 反过来写（拿滑杆当前值去覆盖 manifest）的话，任何自带炫光参数的卡
  // ——别人分享过来的、或本地导入的 .layers——一加载就被滑杆默认值悄悄改掉了。
  const halo = set.manifest.effects.halo;
  ctlIntensity.value = String(halo.intensity);
  ctlSharp.value = String(halo.light.sharpness);
  // 视差同理：作者存过就按作者的；没存过（旧卡、刚做出来的卡）按看的人本机的偏好
  applyParallax(set.manifest.effects.parallax ?? localParallax());

  card.setLayerSet(set);
  buildFoilControls(set);
  // 刚做出来的卡还没存过视差：把主人此刻的设置记下来，分享出去别人看到的才和主人一样
  if (!set.manifest.effects.parallax) scheduleSave();
}

/** 卡带停在卡包上：还没有卡可调、可分享，面板上跟卡有关的先收起来 */
function showPackPanel(): void {
  panel.classList.add('is-pack');
  current = null;
  currentId = null;
  shareBox.hidden = true;
  exportBox.hidden = true;
  ownerBox.hidden = true;
  foilList.replaceChildren();
  setText(status, 'pack.panelNote');
}

function applyHalo(): void {
  if (!current) return;
  const halo = current.manifest.effects.halo;
  halo.intensity = Number(ctlIntensity.value);
  halo.light = { ...halo.light, sharpness: Number(ctlSharp.value) };
  card.setHalo(halo);
  scheduleSave();
}

// ---------- 作者配置存回服务端 ----------

/** 面板上视差开关和滑块此刻的状态 */
function panelParallax(): ParallaxEffect {
  return { enabled: ctlParallax.checked, amplitude: Number(ctlAmp.value) / 100 };
}

/** 没存过视差的卡用这个：开关按本机记的偏好，幅度用滑块的默认值 */
function localParallax(): ParallaxEffect {
  let enabled = true;
  try {
    enabled = localStorage.getItem(PARALLAX_KEY) !== 'off';
  } catch {
    // 同上
  }
  return { enabled, amplitude: Number(ctlAmp.defaultValue) / 100 };
}

function applyParallax(parallax: ParallaxEffect): void {
  ctlParallax.checked = parallax.enabled;
  ctlAmp.value = String(Math.round(parallax.amplitude * 1000) / 10);
  ctlAmp.disabled = !parallax.enabled;
  outAmp.value = `${ctlAmp.value}%`;
  card.setOptions({ amplitude: amplitude() });
}

/** 拖滑块时别每一下都发：停手这么久再存 */
const SAVE_DELAY_MS = 800;
let pendingSave: { id: string; config: CardConfig } | null = null;
let saveTimer = 0;

/** 主人调了东西：记下这张卡此刻的配置，停手一会儿再存。别人的卡在本机随便调，不存 */
function scheduleSave(): void {
  if (!current || !currentId || route.mode === 'render' || ownedToken(currentId) === null) return;
  const parallax = panelParallax();
  current.manifest.effects.parallax = parallax;
  // 等着存的是另一张卡（停手不到一秒就换了卡），那张先发出去
  if (pendingSave && pendingSave.id !== currentId) void flushSave();
  pendingSave = { id: currentId, config: configOf(current.manifest, parallax) };
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushSave(), SAVE_DELAY_MS);
}

/**
 * 存的请求排成一条链：一次一次按顺序发，后调的不会被先调的覆盖；
 * 分享、导出等的也是这条链，这样已经发出去还没回来的那次也算在内
 */
let saving: Promise<void> = Promise.resolve();

/** 立刻把等着的那次存掉。分享、导出之前要先等它，否则拿到的是服务端上旧的配置 */
function flushSave(): Promise<void> {
  window.clearTimeout(saveTimer);
  const job = pendingSave;
  pendingSave = null;
  if (job) {
    saving = saving.then(async () => {
      try {
        await saveConfig(job.id, job.config);
      } catch (error) {
        // 本机的效果不受影响，只是分享出去的还是旧的，告诉主人一声
        if (job.id === currentId) setText(status, 'status.saveFailed', { message: describeError(error) });
      }
    });
  }
  return saving;
}

// 调完马上关页面：还没到点的那次也发出去（saveConfig 带 keepalive）。
// 不排进 saving 链：链上要是还有一发在路上，排在它后面的这一发得等它回来才发，那时页面已经没了。
// 服务端是整份覆盖，和在路上那发乱序到达的话，后到的赢——两发只差几百毫秒，接受这点概率
window.addEventListener('pagehide', () => {
  window.clearTimeout(saveTimer);
  const job = pendingSave;
  pendingSave = null;
  if (job) void saveConfig(job.id, job.config).catch(() => undefined);
});

/**
 * 把此刻炫光实际有多亮显示出来，纯读数：角度决定的那部分（渲染器算的 --hc-halo）× 炫光强度。
 * 乘上强度，拖强度滑块时读数条才会跟着动。
 *
 * 只在「景深与炫光」展开时每帧读：读数就在那个默认折叠的面板里，折着时看不见。
 * 以前是无条件每帧跑，每秒按屏幕刷新率（60～240 次）多跑一轮主线程、提交一帧。
 * （页面上的扫光、标题渐变这些 CSS 动画照样每帧出图，所以页面并不会因此完全闲下来，省的只是这一份）
 */
const moreBox = need<HTMLDetailsElement>('details.more');
let haloRaf = 0;
function pollHalo(): void {
  haloRaf = 0;
  if (!moreBox.open) return;
  const root = card.element;
  if (root) {
    const value = (Number(root.style.getPropertyValue('--hc-halo')) || 0) * Number(ctlIntensity.value);
    outHalo.value = value.toFixed(2);
    haloFill.style.width = `${Math.round(value * 100)}%`;
  }
  haloRaf = requestAnimationFrame(pollHalo);
}
moreBox.addEventListener('toggle', () => {
  if (moreBox.open && !haloRaf) pollHalo();
});

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
  'stage.extracting': [0.86, 0.93, 3],
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
 * 服务端给的剩余秒数（见 server/eta.ts）和收到它的时刻，倒计时在两次轮询之间自己往下走。
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

function showProgress(
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

function hideProgress(): void {
  progress.hidden = true;
  progressEta.hidden = true;
  etaSeconds = null;
  etaShown = -1;
  window.clearInterval(progressTimer);
  progressTimer = 0;
  progressKey = null;
  setProgressBar(0);
}

// ---------- 上传与分层 ----------

/** 服务端的上传上限是 16MB，留一点余量 */
const UPLOAD_LIMIT_BYTES = 15 * 1024 * 1024;
/** 超过上限时缩到的最长边。分层本来就只用到 1400，原图留 4096 以后重跑也够 */
const SHRINK_TO = 4096;

/**
 * 太大的图先在浏览器里缩小再传。
 *
 * 埋点里有人传过 25MB、32MB 的图：服务端直接拒了，页面退回浏览器端又跑不动，
 * 人就走了。浏览器解不开的格式（比如 Chrome 里的 HEIC）原样上传，由服务端判断。
 * 顺带把 EXIF（含 GPS）也去掉了——画到 canvas 上再导出，只剩像素。
 */
async function shrinkIfHuge(file: File): Promise<Blob> {
  if (file.size <= UPLOAD_LIMIT_BYTES || typeof OffscreenCanvas === 'undefined') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  showProgress('progress.shrinking');
  try {
    for (const [side, quality] of [[SHRINK_TO, 0.92], [3072, 0.85]] as const) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      if (blob.size <= UPLOAD_LIMIT_BYTES) return blob;
    }
    return file;
  } finally {
    bitmap.close();
  }
}

/**
 * 分层：交给服务端做，浏览器一个字节的模型都不用下。
 * 只有部署里压根没有分层服务时才回退到浏览器端流水线——自托管的纯静态部署走的就是这条路。
 * 服务端临时不行就报错让人稍后再试，不回退，原因见 api.ts 开头。
 *
 * stage 记着走到了哪一步，失败时随埋点一起报上去：只看错误原文分不清是上传断了、
 * 服务端失败，还是结果下载到一半断了（之前排查时只能拿服务端数据库一条条对）。
 */
async function processImage(file: File): Promise<void> {
  if (busy) return;
  busy = true;
  drop.classList.remove('is-over');
  // 卡带最右边先放一个卡包，做好了等人来开；等的时候可以回去玩之前的卡
  const pack = deck.startPack();
  showProgress('progress.preparing');
  setText(status, 'status.processing', { name: file.name });
  // 只报体积档位，不报文件名和具体大小
  track('upload', { sizeMb: Math.round(file.size / 1024 / 1024) });

  let stage: 'upload' | 'server' | 'download' | 'browser' = 'upload';
  try {
    let set: LayerSet;
    let serverId: string | null = null;
    try {
      const upload = await shrinkIfHuge(file);
      const result = await segmentOnServer(upload, (p) => {
        if (p.key !== 'progress.uploading') stage = 'server';
        showProgress(p.key, p.params, p.ratio, p.eta);
      });
      stage = 'download';
      set = await loadLayerSet(result.layers);
      serverId = result.id;
      // 删除口令服务端只给这一次，立刻存下来，否则这张卡就没法删了
      rememberOwned(result.id, result.deleteToken);
      track('segment-ok', { where: 'server', layers: set.manifest.layers.length });
      setText(status, 'status.done', { n: set.manifest.layers.length, generator: set.manifest.generator ?? '' });
    } catch (serverError) {
      if (!(serverError instanceof NoBackendError)) throw serverError;

      // 回退：在浏览器里跑。首次要下约 50MB 权重，所以只在根本没有服务端时才走
      console.info('[holocard] 服务端不可用，回退到浏览器端：', serverError.message);
      stage = 'browser';
      showProgress('progress.fallback');
      const { segmentToLayerSet } = await import('../segmenter');
      set = await segmentToLayerSet(file, {
        onProgress: (p) =>
          p.file
            ? showProgress('stage.downloading', { file: p.file }, p.ratio)
            : showProgress(`stage.${p.stage}`, undefined, p.ratio),
      });
      track('segment-ok', { where: 'browser', layers: set.manifest.layers.length });
      setText(status, 'status.doneLocal', {
        n: set.manifest.layers.length,
        generator: set.manifest.generator ?? '',
      });
    }

    pack.done(set, serverId);
    hideProgress();
    // 做好就转成分享状态，不等开包：保留期按访问量延长，预览图提前渲染好，没开包就刷新了卡也还在
    if (serverId) void doShare(true, serverId);
  } catch (error) {
    hideProgress();
    pack.fail(describeError(error));
    const message = error instanceof Error ? error.message : String(error);
    // 只报错误信息和走到哪一步，不报文件名——那是用户的东西
    track('segment-fail', { stage, message: message.slice(0, 120) });
    setText(status, 'status.failed', { message: describeError(error) });
  } finally {
    busy = false;
  }
}

/*
 * 这三个滑块拖动时都让卡片转到炫光最亮的角度（card.preview）。
 * 手指在滑块上时卡片是静止的，而视差要歪过去才看得出、炫光要转到那个角度才出来，
 * 不转的话拖滑块画面上什么都不变（issue #3 第 3、4 条说的「感知不明显」就是这个）。
 */
ctlAmp.addEventListener('input', () => {
  outAmp.value = `${ctlAmp.value}%`;
  card.setOptions({ amplitude: amplitude() });
  card.preview();
  scheduleSave();
});

// 关掉视差：振幅归零，放大补偿也跟着变成 1，照片完整显示、不再被裁掉一圈
ctlParallax.addEventListener('change', () => {
  ctlAmp.disabled = !ctlParallax.checked;
  card.setOptions({ amplitude: amplitude() });
  card.preview();
  scheduleSave();
  try {
    localStorage.setItem(PARALLAX_KEY, ctlParallax.checked ? 'on' : 'off');
  } catch {
    // 存不下就只管这一次
  }
  track('parallax', { on: ctlParallax.checked ? 1 : 0 });
});

ctlIntensity.addEventListener('input', () => {
  outIntensity.value = Number(ctlIntensity.value).toFixed(2);
  applyHalo();
  card.preview();
});

ctlSharp.addEventListener('input', () => {
  outSharp.value = ctlSharp.value;
  applyHalo();
  card.preview();
});

drop.addEventListener('click', () => filePicker.click());
filePicker.addEventListener('change', () => {
  const file = filePicker.files?.[0];
  if (file) void processImage(file);
  // 清空才能连续选同一个文件
  filePicker.value = '';
});

drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  drop.classList.add('is-over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('is-over');
  const file = event.dataTransfer?.files?.[0];
  if (file?.type.startsWith('image/')) {
    void processImage(file);
  } else if (file) {
    setText(status, 'status.imagesOnly');
  }
});

// ---------- 分享与删除 ----------

/**
 * 把这张卡转为永久保留，并拿到分享链接。
 * 请求头带着当前语言：服务端按它渲染这个语言的分享图，链接上也带上语言，
 * 发到群里别人点开看到的标题、描述、分享图都是分享人的语言。
 *
 * auto：做完卡时自动调的。不算用户的分享动作，不选中输入框（手机上会弹出选择手柄、把页面滚过去），
 * 失败也不提示——按钮还在，用户自己点一下就行。
 */
async function doShare(auto = false, id: string | null = currentId): Promise<void> {
  if (!id) return;
  // 给还没开包的卡在后台转分享状态时，面板上显示的不是它，按钮别跟着变
  if (id === currentId) {
    shareBtn.disabled = true;
    setText(shareBtn, 'share.creating');
  }

  try {
    // 预览图按服务端上的配置渲染，刚调的那一下得先存上
    await flushSave();
    // 分享只有卡的主人能做（服务端认删除口令）：分享会让卡长期保留、公开卡片页
    const res = await fetch(`${import.meta.env.BASE_URL}api/cards/${id}/share`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'x-holocard-token': ownedToken(id) ?? '' },
    });
    if (!res.ok) throw await apiError(res, `HTTP ${res.status}`);
    // 等待期间换了卡，这个结果就不是当前这张的了
    if (id !== currentId) return;
    shareUrlInput.value = shareUrl(id, lang());
    shareResult.hidden = false;
    setText(shareBtn, 'share.created');
    // 成功不用多说，链接出现在输入框里本身就是反馈
    clearText(shareHint);
    if (!auto) {
      track('share');
      shareUrlInput.select();
    }
  } catch (error) {
    if (id !== currentId) return;
    shareBtn.disabled = false;
    setText(shareBtn, 'share.create');
    if (!auto) setText(shareHint, 'share.failed', { message: describeError(error) });
  }
}

/**
 * 删掉自己的卡。
 *
 * 二次确认是必须的：这个操作不可撤销，而且已经分享出去的链接会立刻失效。
 */
initAlbums(need<HTMLDialogElement>('#albums'));
need<HTMLButtonElement>('#albums-open').addEventListener('click', openAlbums);

async function doDelete(): Promise<void> {
  if (!currentId) return;
  if (!confirm(t('delete.confirm'))) return;

  deleteBtn.disabled = true;
  setText(deleteBtn, 'delete.deleting');
  try {
    await deleteCard(currentId);
    forgetSession(currentId);
    track('delete');
    // 卡没了，地址栏退回首页，别留着一个打开就是 404 的链接
    history.replaceState(history.state, '', `${import.meta.env.BASE_URL}${location.search}`);
    ownerBox.hidden = true;
    shareBox.hidden = true;
    exportBox.hidden = true;
    setText(status, 'delete.done');
  } catch (error) {
    deleteBtn.disabled = false;
    setText(deleteBtn, 'delete.button');
    setText(deleteHint, 'delete.failed', { message: describeError(error) });
  }
}

// ---------- 导出动图 ----------

/**
 * 导出动图，格式按设备定（见 export.ts）。
 *
 * iPhone 分两步：第一次点生成并把文件取到手上，按钮变成「保存到相册」；
 * 第二次点直接唤起系统分享面板，在里面「存储图像」进相册。
 * 安卓和电脑生成好就直接下载。
 */
async function doExport(): Promise<void> {
  if (pendingShare) {
    // 第二步：这次点击直接唤起分享面板，中间不能有任何 await，否则 Safari 不认这是用户操作
    const files = pendingShare;
    try {
      await navigator.share({ files });
      // 只知道面板里选了某个操作，不知道是不是「存储」
      track('export-share', { format: FORMAT_FOR[platform] });
      resetExport();
    } catch (error) {
      // 用户在面板里点了关闭，不算错，按钮保持「保存到相册」可以再点
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setText(exportHint, 'export.saveFailed', { message: describeError(error) });
    }
    return;
  }

  const id = currentId;
  if (!id || exporting) return;

  const app = blockingInAppBrowser();
  if (app) {
    setText(exportHint, 'export.inApp', { app: t(app) });
    return;
  }

  const format = FORMAT_FOR[platform];
  exporting = true;
  exportBtn.disabled = true;
  setText(exportBtn, 'export.working');
  clearText(exportHint);
  track('export', { format });

  try {
    // 动图按服务端上的配置渲染，刚调的那一下得先存上
    await flushSave();
    const files = await requestExport(id, format, (state) => {
      setText(exportBtn, state === 'queued' ? 'export.queued' : 'export.working');
    });
    // 等的功夫换了一张卡，这份结果就不用了
    if (currentId !== id) {
      resetExport();
      return;
    }

    if (platform === 'ios') {
      const shareFiles = await fetchFiles(files);
      if (navigator.canShare?.({ files: shareFiles })) {
        pendingShare = shareFiles;
        exportBtn.disabled = false;
        setText(exportBtn, 'export.save');
        return;
      }
      // 不支持分享文件的老系统：下载到「文件」App，让用户从那里存进相册
      files.forEach(download);
      resetExport();
      setText(exportHint, 'export.downloaded');
      return;
    }

    const [file] = files;
    if (file) download(file);
    resetExport();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    track('export-fail', { format, message: message.slice(0, 120) });
    resetExport();
    setText(exportHint, 'export.failed', { message: describeError(error) });
  } finally {
    exporting = false;
  }
}

shareBtn.addEventListener('click', () => void doShare());
exportBtn.addEventListener('click', () => void doExport());
deleteBtn.addEventListener('click', () => void doDelete());
shareCopy.addEventListener('click', () => {
  shareUrlInput.select();
  // clipboard API 在非安全上下文下不可用，退回老办法
  navigator.clipboard?.writeText(shareUrlInput.value).catch(() => document.execCommand('copy'));
  // 链接现在做完卡就自动生成，「分享」按钮基本没人点了，复制才是用户真的想发出去
  track('share-copy');
  setText(shareCopy, 'share.copied');
  setTimeout(() => setText(shareCopy, 'share.copy'), 1500);
});

// ---------- 语言切换 ----------

function markLangButtons(active: Lang): void {
  for (const button of langButtons) {
    button.setAttribute('aria-pressed', String(button.dataset['lang'] === active));
  }
}

for (const button of langButtons) {
  button.addEventListener('click', () => {
    const next = LANGS.find((l) => l === button.dataset['lang']);
    if (next) setLang(next);
  });
}

onLangChange((next) => {
  markLangButtons(next);
  for (const [el, { key, params }] of liveTexts) el.textContent = t(key, params);
  if (current) buildFoilControls(current);
  // 已经生成的分享链接也换成新语言的地址
  if (currentId && !shareResult.hidden) shareUrlInput.value = shareUrl(currentId, next);
  track('lang', { lang: next });
});

// ---------- 渲染页（服务端截分享图、导出动图） ----------

/**
 * 渲染页的深色底。背景用这张卡自己的画面糊开当色调（具体叠法见 style.css 里 .render-bg 的注释），
 * 复用已经加载好的层图片，不额外发请求。分享图和导出的竖屏动图共用。
 */
function buildRenderBackground(): void {
  const bg = document.createElement('div');
  bg.className = 'render-bg';
  for (const img of document.querySelectorAll<HTMLImageElement>('.hc__art')) {
    const clone = document.createElement('img');
    clone.src = img.src;
    clone.alt = '';
    bg.append(clone);
  }
  document.body.append(bg);
}

/**
 * 给 OG 图补上右侧文案，按渲染页地址上的 ?lang 出对应语言。
 *
 * 1200×630 的横图配竖卡片，直接居中会剩两大片空白，所以排成左卡片右文案。
 */
function buildRenderCopy(): void {
  const copy = document.createElement('div');
  copy.className = 'render-copy';

  const headline = document.createElement('h2');
  headline.innerHTML = t('og.headlineHtml');

  /*
   * 「前中后」三个字本身摆成三层：前最大最近，依次往右后方退，
   * 每一个都被前一个盖住左边三分之一。一眼就能看懂「分层」，不用读说明。
   * 三个字的质感也对应默认的上箔方式：最近层哑光（白），中间 holo，最远 sunpillar。
   * 英文是三个单词，宽度不是方块字那样一个字号见方，改用行内排版、互相压一角（见 style.css）。
   */
  const depth = document.createElement('div');
  depth.className = lang() === 'en' ? 'depth depth--words' : 'depth';
  depth.setAttribute('role', 'img');
  depth.setAttribute('aria-label', t('og.depthLabel'));
  const glyph = (which: 'front' | 'mid' | 'back'): HTMLSpanElement => {
    const span = document.createElement('span');
    span.className = `depth__g depth__g--${which}`;
    span.textContent = t(`og.${which}`);
    return span;
  };
  // 方块字按绝对定位摆，DOM 顺序无所谓；单词走行内排版，得按从前到后的顺序排
  depth.append(
    ...(lang() === 'en'
      ? [glyph('front'), glyph('mid'), glyph('back')]
      : [glyph('back'), glyph('mid'), glyph('front')]),
  );

  const body = document.createElement('p');
  body.textContent = t('og.body');

  const url = document.createElement('span');
  url.className = 'render-url';
  url.textContent = 'holocard.longsizhuo.com';

  copy.append(headline, depth, body, url);
  document.querySelector('.page__body')?.append(copy);
}

/**
 * 分享图里卡片摆的姿态：指针落在卡面上的百分比位置。
 * 默认 (78, 22) 是贴着炫光峰值挑的角度，箔面和炫光都亮；
 * 调试时可以用 ?pose=x,y 换一个角度看（scripts/og-preview.ts 的 --pose 就是走这个）。
 */
function renderPose(): { x: number; y: number } {
  const m = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(
    new URLSearchParams(location.search).get('pose') ?? '',
  );
  const clamp = (v: number): number => Math.min(100, Math.max(0, v));
  return m ? { x: clamp(Number(m[1])), y: clamp(Number(m[2])) } : { x: 78, y: 22 };
}

/**
 * 导出动图时渲染页的版式（服务端 export.ts 用）：
 *   phone    手机竖屏、深色底，给动态照片和 GIF
 *   sticker  只有卡片、透明底，给电脑上下载的 APNG
 * 不带这个参数就是分享图的版式。
 */
type ExportLayout = 'phone' | 'sticker';

function renderExportLayout(): ExportLayout | null {
  const value = new URLSearchParams(location.search).get('export');
  return value === 'phone' || value === 'sticker' ? value : null;
}

/**
 * 箔面纹理是现算的，还要等它解码。截图前不等的话，头几帧的箔面没有颗粒和闪粉。
 * 以前截分享图靠固定等 250ms 碰运气，导出动图第一帧就是封面，不能碰运气。
 */
async function preloadTextures(): Promise<void> {
  try {
    const { grain, glitter } = await ensureTextures();
    await Promise.all(
      [grain, glitter].map((src) => {
        const img = new Image();
        img.src = src;
        return img.decode().catch(() => undefined);
      }),
    );
  } catch {
    // 生成不了纹理的环境里箔面退化成纯渐变，照样能截
  }
}

/**
 * 给服务端逐帧导出用的两个钩子（server/export.ts）：
 *   __hcExportPose   摆一个姿态
 *   __hcExportLayer  竖屏导出分两遍截——背景是静的只截一次，卡片每帧截、透明底，
 *                    最后由 ffmpeg 叠起来。服务器没有显卡，模糊过的背景每帧重画太贵
 * 都只改状态、不等浏览器画出来：服务端截图时会先刷新样式再按需要的倍率现画。
 */
function exposeExportHooks(): void {
  const hooks = window as Window & {
    __hcExportPose?: (x: number, y: number) => void;
    __hcExportLayer?: (layer: 'background' | 'card') => void;
  };
  hooks.__hcExportPose = (x, y) => card.setPose({ x, y });
  hooks.__hcExportLayer = (layer) => {
    document.body.classList.toggle('is-export-bg', layer === 'background');
    document.body.classList.toggle('is-export-card', layer === 'card');
  };
}

/**
 * 手机上卡片跟着倾斜。iOS 13+ 要在用户手势里申请权限，所以等第一次点卡带再问
 * （挂在整个卡带上而不是卡面上：分享链接打开先是卡包，第一下点的是卡包）；
 * 别的平台直接开。render 模式不开：无头截图要的是固定姿态
 */
function initGyro(): void {
  if (!('DeviceOrientationEvent' in window)) return;
  const request = (
    DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }
  ).requestPermission;
  if (typeof request !== 'function') {
    card.enableGyro();
    return;
  }
  need<HTMLDivElement>('.deck').addEventListener(
    'click',
    () => {
      void request
        .call(DeviceOrientationEvent)
        .then((state) => {
          if (state === 'granted') card.enableGyro();
        })
        .catch(() => {
          // 拒绝了就只能用手指拨，不算错误
        });
    },
    { once: true },
  );
}

// ---------- 启动 ----------

/** 这台设备上开过包的、别人分享的卡。存最近的几百张就够了 */
const SEEN_KEY = 'holocard:seen';
const SEEN_MAX = 300;

function seenCards(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // 隐私模式下可能直接抛：那就每次都出卡包
    return [];
  }
}

function markSeen(id: string): void {
  try {
    const ids = seenCards().filter((other) => other !== id);
    localStorage.setItem(SEEN_KEY, JSON.stringify([...ids, id].slice(-SEEN_MAX)));
  } catch {
    // 同上
  }
}

/**
 * 分享链接要不要先出卡包：别人分享的卡、在这台设备上第一次打开才出。
 * 自己做的卡、开过包的卡直接看；截图和导出用的 render 页面、「减少动态效果」下也不出
 */
function sharedPackDue(id: string): boolean {
  return route.mode === 'card' && ownedToken(id) === null && !reducedMotion() && !seenCards().includes(id);
}

/** 按路由决定首屏加载什么 */
async function boot(): Promise<void> {
  // 服务端发页面时已经按语言换好了文字；这里再过一遍，本地开发（vite 直接发页面）时也对
  applyTranslations();
  markLangButtons(lang());

  const exportLayout = route.mode === 'render' ? renderExportLayout() : null;
  if (route.mode === 'render') {
    // 给服务端截 OG 图、导出动图用：只留卡片，固定在炫光峰值姿态，不带任何 UI
    document.body.classList.add('is-render');
    if (exportLayout) document.body.classList.add(`is-export-${exportLayout}`);
  } else {
    /*
     * 统计只在真人访问的页面上加载，render 模式（无头浏览器截 OG 图）跳过——
     * 否则每生成一张预览图就多一条假访问，而且刚好都落在分享这个动作上，
     * 会把「分享后有多少人真的点开」这个最关心的数字打歪。
     */
    initTracking();
    initGyro();
    // /c/<uuid> 归一成 /c，否则页面列表会被几千个 uuid 撑爆
    pageView(route.mode === 'card' ? '/c' : '/');
    // 哪张卡带来的流量另走一个事件——pageview 的 payload 塞不下自定义字段
    // 主人自己刷新不算：做完卡地址栏就是卡片链接，刷一下不该算成「分享出去有人点开」
    if (route.mode === 'card' && route.id && ownedToken(route.id) === null) {
      track('card-view', { card: route.id });
    }
  }

  if (route.id) {
    try {
      const set = await loadLayerSet(`${import.meta.env.BASE_URL}api/layers/${route.id}`);
      if (sharedPackDue(route.id)) {
        // 卡包格：面板那句「开包之后就能……」由卡带写，这里不覆盖
        deck.addPack(set, route.id);
        return;
      }
      deck.addCard(set, route.id);
      if (route.mode !== 'render') deck.restore();
      setText(status, 'status.layers', { n: set.manifest.layers.length });

      if (route.mode === 'render') {
        // 透明底的贴纸只要卡片本身；竖屏动图要深色底但不要分享图右边那段字
        if (exportLayout !== 'sticker') buildRenderBackground();
        if (exportLayout === null) buildRenderCopy();
        // 等所有层真正解码完再摆姿态，否则截图可能截到半成品
        await Promise.all(
          [...document.querySelectorAll('img.hc__art')].map((img) =>
            (img as HTMLImageElement).decode().catch(() => undefined),
          ),
        );
        await preloadTextures();
        await card.ready;
        card.setPose(renderPose());
        exposeExportHooks();
        // 给截图脚本一个明确的信号，别靠猜时间
        document.body.dataset['ready'] = '1';
      }
      return;
    } catch (error) {
      setText(status, 'status.cardFailed', { message: describeError(error) });
      if (route.mode === 'render') document.body.dataset['ready'] = 'error';
      return;
    }
  }

  try {
    // 首页默认摆的就是分享图（og.jpg）上那张卡，进来第一眼和分享出去的样子一致
    const sample = await loadLayerSet(`${import.meta.env.BASE_URL}samples/demo`);
    deck.addCard(sample, null);
    deck.restore();
    setText(status, 'status.layers', { n: sample.manifest.layers.length });
  } catch (error) {
    setText(status, 'status.sampleFailed', { message: describeError(error) });
  }
}

await boot();
pollHalo();
// 性能埋点，staging 和线上都有。render 模式是服务端的无头浏览器，不是真人的设备；
// 卡片没加载出来（分享链接过期 404）的空页面也不量，不然会把 card 模式的帧率拉高
if (route.mode !== 'render' && current) {
  measurePerf(route.mode, () => ({ parallax: ctlParallax.checked, busy: busy || exporting }));
}
