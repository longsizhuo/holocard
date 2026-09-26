/** 演示页：加载素材、接分层流水线、挂调参面板 */

import './style.css';
import { HoloCard } from '../renderer/card';
import { ensureTextures } from '../renderer/textures';
import { LayerFormatError, loadLayerSet } from '../format/io';
import { FOIL_TYPES, type FoilType, type LayerSet } from '../format/types';
import {
  ApiError,
  apiError,
  apiHeaders,
  deleteCard,
  NoBackendError,
  ownedToken,
  rememberOwned,
  segmentOnServer,
} from './api';
import { albumCountFor, initAlbums, openAlbums, openPicker } from './albums-ui';
import { initTracking, pageView, track } from './track';
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

const stage = need<HTMLDivElement>('#stage');
const status = need<HTMLParagraphElement>('#status');
const foilList = need<HTMLDivElement>('#foil-list');

const collectBox = need<HTMLDivElement>('#collect');
const collectHint = need<HTMLElement>('#collect-hint');

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

const card = new HoloCard(stage, { amplitude: amplitude() });

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
  // 卡册收的是服务端的卡：自己做的、别人分享来的都行，手工素材没有 id 收不了
  collectBox.hidden = id === null || route.mode === 'render';
  updateCollectHint();
  deleteBtn.disabled = false;
  setText(deleteBtn, 'delete.button');

  // 方向是 manifest → 面板，和下面 buildFoilControls 处理逐层箔面的方向一致。
  // 反过来写（拿滑杆当前值去覆盖 manifest）的话，任何自带炫光参数的卡
  // ——别人分享过来的、或本地导入的 .layers——一加载就被滑杆默认值悄悄改掉了。
  const halo = set.manifest.effects.halo;
  ctlIntensity.value = String(halo.intensity);
  ctlSharp.value = String(halo.light.sharpness);

  card.setLayerSet(set);
  buildFoilControls(set);
}

function applyHalo(): void {
  if (!current) return;
  const halo = current.manifest.effects.halo;
  halo.intensity = Number(ctlIntensity.value);
  halo.light = { ...halo.light, sharpness: Number(ctlSharp.value) };
  card.setHalo(halo);
}

/**
 * 把此刻炫光实际有多亮显示出来，纯读数：角度决定的那部分（渲染器算的 --hc-halo）× 炫光强度。
 * 乘上强度，拖强度滑块时读数条才会跟着动
 */
function pollHalo(): void {
  const root = card.element;
  if (root) {
    const value = (Number(root.style.getPropertyValue('--hc-halo')) || 0) * Number(ctlIntensity.value);
    outHalo.value = value.toFixed(2);
    haloFill.style.width = `${Math.round(value * 100)}%`;
  }
  requestAnimationFrame(pollHalo);
}

function showProgress(key: MessageKey, params?: Record<string, string | number>, ratio?: number): void {
  progress.hidden = false;
  setText(progressText, key, params);
  // 拿不到确切比例时用一个固定的低值占位，避免进度条看起来是卡死的
  progressFill.style.width = `${Math.round((ratio ?? 0.05) * 100)}%`;
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
        showProgress(p.key, p.params, p.ratio);
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

    show(set, serverId);
    progress.hidden = true;
    if (serverId) {
      // 地址栏换成这张卡的链接：用浏览器菜单分享、复制地址、刷新，拿到的都是这张卡而不是首页。
      // replaceState 只改地址，不刷新页面，也不多一条后退记录
      history.replaceState(history.state, '', shareUrl(serverId, lang()));
      // 同时转成分享状态，地址栏里的链接发出去就是正式链接：保留期按访问量延长，预览图提前渲染好
      void doShare(true);
    }
  } catch (error) {
    progress.hidden = true;
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
});

// 关掉视差：振幅归零，放大补偿也跟着变成 1，照片完整显示、不再被裁掉一圈
ctlParallax.addEventListener('change', () => {
  ctlAmp.disabled = !ctlParallax.checked;
  card.setOptions({ amplitude: amplitude() });
  card.preview();
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
async function doShare(auto = false): Promise<void> {
  const id = currentId;
  if (!id) return;
  shareBtn.disabled = true;
  setText(shareBtn, 'share.creating');

  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/cards/${id}/share`, {
      method: 'POST',
      headers: apiHeaders(),
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
/** 「加入卡册」下面那行：这张卡已经在几个卡册里 */
function updateCollectHint(): void {
  const n = currentId ? albumCountFor(currentId) : 0;
  if (n > 0) setText(collectHint, 'albums.inAlbums', { n });
  else clearText(collectHint);
}

initAlbums(need<HTMLDialogElement>('#albums'), updateCollectHint);
need<HTMLButtonElement>('#albums-open').addEventListener('click', openAlbums);
need<HTMLButtonElement>('#collect-btn').addEventListener('click', () => {
  if (currentId) openPicker(currentId);
});

async function doDelete(): Promise<void> {
  if (!currentId) return;
  if (!confirm(t('delete.confirm'))) return;

  deleteBtn.disabled = true;
  setText(deleteBtn, 'delete.deleting');
  try {
    await deleteCard(currentId);
    track('delete');
    // 卡没了，地址栏退回首页，别留着一个打开就是 404 的链接
    history.replaceState(history.state, '', `${import.meta.env.BASE_URL}${location.search}`);
    ownerBox.hidden = true;
    shareBox.hidden = true;
    exportBox.hidden = true;
    collectBox.hidden = true;
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

// ---------- 启动 ----------

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
      show(set, route.id);
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
    show(sample);
    setText(status, 'status.layers', { n: sample.manifest.layers.length });
  } catch (error) {
    setText(status, 'status.sampleFailed', { message: describeError(error) });
  }
}

await boot();
pollHalo();
