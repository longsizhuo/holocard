/** 演示页：加载素材、接分层流水线、挂调参面板 */

import './style.css';
import { HoloCard } from '../renderer/card';
import { loadLayerSet } from '../format/io';
import { FOIL_TYPES, type FoilType, type LayerSet } from '../format/types';
import { segmentOnServer, ServerUnavailableError, rememberOwned, ownedToken, deleteCard } from './api';
import { initTracking, pageView, track } from './track';
import { parseRoute, shareUrl } from './route';

/** 取元素并断言存在，省掉一堆空判断 */
function need<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`页面上找不到 ${selector}`);
  return el;
}

const FOIL_LABEL: Record<FoilType, string> = {
  none: '哑光（不上箔）',
  holo: '经典闪卡 holo',
  sunpillar: '日柱 sunpillar',
  rainbow: '彩虹闪粉 rainbow',
};

const stage = need<HTMLDivElement>('#stage');
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

const shareBox = need<HTMLDivElement>('#share');
const shareBtn = need<HTMLButtonElement>('#share-btn');
const shareResult = need<HTMLDivElement>('#share-result');
const ownerBox = need<HTMLDivElement>('#owner');
const deleteBtn = need<HTMLButtonElement>('#delete-btn');
const deleteHint = need<HTMLElement>('#delete-hint');
const shareUrlInput = need<HTMLInputElement>('#share-url');
const shareCopy = need<HTMLButtonElement>('#share-copy');
const shareHint = need<HTMLElement>('#share-hint');

const route = parseRoute();
const card = new HoloCard(stage, { amplitude: Number(ctlAmp.value) / 100 });

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

/** 层的称呼：由远及近 */
function layerName(index: number, count: number): string {
  if (count === 1) return '整张';
  if (index === 0) return '最远层（背景）';
  if (index === count - 1) return '最近层（主体）';
  return count === 3 ? '中间层' : `中间层 ${index}`;
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
      option.textContent = FOIL_LABEL[type];
      select.append(option);
    }
    select.value = layer.foil.type;

    const strength = document.createElement('input');
    strength.type = 'range';
    strength.min = '0';
    strength.max = '1';
    strength.step = '0.05';
    strength.value = String(layer.foil.intensity);
    strength.title = '这一层的箔面强度';

    const apply = (): void => {
      layer.foil = { type: select.value as FoilType, intensity: Number(strength.value) };
      strength.disabled = layer.foil.type === 'none';
      card.setLayerFoil(index, layer.foil);
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
  // 只有服务端产出的卡才能分享；换卡时把上一张的链接收起来
  shareBox.hidden = id === null || route.mode !== 'demo';
  shareResult.hidden = true;
  shareBtn.disabled = false;
  shareBtn.textContent = '生成分享链接';
  // 只有手上有这张卡口令的人才看得到删除入口
  ownerBox.hidden = id === null || ownedToken(id) === null;
  deleteBtn.disabled = false;
  deleteBtn.textContent = '删除这张卡';

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

/** 把渲染器算出来的炫光强度显示出来，纯读数 */
function pollHalo(): void {
  const root = card.element;
  if (root) {
    const value = Number(root.style.getPropertyValue('--hc-halo')) || 0;
    outHalo.value = value.toFixed(2);
    haloFill.style.width = `${Math.round(value * 100)}%`;
  }
  requestAnimationFrame(pollHalo);
}

function showProgress(text: string, ratio?: number): void {
  progress.hidden = false;
  progressText.textContent = text;
  // 拿不到确切比例时用一个固定的低值占位，避免进度条看起来是卡死的
  progressFill.style.width = `${Math.round((ratio ?? 0.05) * 100)}%`;
}

/**
 * 分层：优先让服务端做，浏览器一个字节的模型都不用下。
 * 服务端没部署或忙不过来时回退到浏览器端流水线——自托管的纯静态部署走的就是这条路。
 */
async function processImage(file: File): Promise<void> {
  if (busy) return;
  busy = true;
  drop.classList.remove('is-over');
  showProgress('准备中');
  status.textContent = `正在处理 ${file.name}`;
  // 只报体积档位，不报文件名和具体大小
  track('upload', { sizeMb: Math.round(file.size / 1024 / 1024) });

  try {
    let set: LayerSet;
    let serverId: string | null = null;
    try {
      const result = await segmentOnServer(file, (p) => showProgress(p.detail, p.ratio));
      set = await loadLayerSet(result.layers);
      serverId = result.id;
      // 删除口令服务端只给这一次，立刻存下来，否则这张卡就没法删了
      rememberOwned(result.id, result.deleteToken);
      track('segment-ok', { where: 'server', layers: set.manifest.layers.length });
      status.textContent = `已切成 ${set.manifest.layers.length} 层 · ${set.manifest.generator ?? ''}`;
    } catch (serverError) {
      if (!(serverError instanceof ServerUnavailableError)) throw serverError;

      // 回退：在浏览器里跑。首次要下约 50MB 权重，所以只在服务端指望不上时才走
      console.info('[holocard] 服务端不可用，回退到浏览器端：', serverError.message);
      showProgress('服务端不可用，改在本机处理');
      const { segmentToLayerSet } = await import('../segmenter');
      set = await segmentToLayerSet(file, {
        onProgress: (p) => showProgress(p.detail, p.ratio),
      });
      track('segment-ok', { where: 'browser', layers: set.manifest.layers.length });
      status.textContent = `已在本机切成 ${set.manifest.layers.length} 层 · ${set.manifest.generator ?? ''}`;
    }

    show(set, serverId);
    progress.hidden = true;
  } catch (error) {
    progress.hidden = true;
    const message = error instanceof Error ? error.message : String(error);
    // 只报错误信息，不报文件名——那是用户的东西
    track('segment-fail', { message: message.slice(0, 120) });
    status.textContent = `处理失败：${message}`;
  } finally {
    busy = false;
  }
}

ctlAmp.addEventListener('input', () => {
  const pct = Number(ctlAmp.value);
  outAmp.value = `${pct}%`;
  card.setOptions({ amplitude: pct / 100 });
});

ctlIntensity.addEventListener('input', () => {
  outIntensity.value = Number(ctlIntensity.value).toFixed(2);
  applyHalo();
});

ctlSharp.addEventListener('input', () => {
  outSharp.value = ctlSharp.value;
  applyHalo();
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
    status.textContent = '只接受图片文件';
  }
});

/** 把这张卡转为永久保留，并拿到分享链接 */
async function doShare(): Promise<void> {
  if (!currentId) return;
  shareBtn.disabled = true;
  shareBtn.textContent = '正在生成…';

  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/cards/${currentId}/share`, {
      method: 'POST',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    shareUrlInput.value = shareUrl(currentId);
    shareResult.hidden = false;
    shareBtn.textContent = '已生成';
    track('share');
    shareHint.textContent =
      '链接在微信、Twitter 里会显示卡片预览图。每被打开一次保留期就续一次，没人看了才开始倒计时';
    shareUrlInput.select();
  } catch (error) {
    shareBtn.disabled = false;
    shareBtn.textContent = '生成分享链接';
    shareHint.textContent = `生成失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * 删掉自己的卡。
 *
 * 二次确认是必须的：这个操作不可撤销，而且已经分享出去的链接会立刻失效。
 */
async function doDelete(): Promise<void> {
  if (!currentId) return;
  if (!confirm('删除后无法恢复，已经分享出去的链接也会立刻失效。确定要删除吗？')) return;

  deleteBtn.disabled = true;
  deleteBtn.textContent = '正在删除…';
  try {
    await deleteCard(currentId);
    track('delete');
    ownerBox.hidden = true;
    shareBox.hidden = true;
    status.textContent = '这张卡已删除。服务端上的层文件和预览图都已清掉';
  } catch (error) {
    deleteBtn.disabled = false;
    deleteBtn.textContent = '删除这张卡';
    deleteHint.textContent = `删除失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

shareBtn.addEventListener('click', () => void doShare());
deleteBtn.addEventListener('click', () => void doDelete());
shareCopy.addEventListener('click', () => {
  shareUrlInput.select();
  // clipboard API 在非安全上下文下不可用，退回老办法
  navigator.clipboard?.writeText(shareUrlInput.value).catch(() => document.execCommand('copy'));
  shareCopy.textContent = '已复制';
  setTimeout(() => (shareCopy.textContent = '复制'), 1500);
});

/**
 * 给 OG 图补上背景和右侧文案。
 *
 * 1200×630 的横图配竖卡片，直接居中会剩两大片空白，所以排成左卡片右文案。
 * 背景用这张卡自己的画面糊开当色调（具体叠法见 style.css 里 .render-bg 的注释），
 * 复用已经加载好的层图片，不额外发请求。
 */
function buildRenderBackdrop(): void {
  // 底色复用已经加载好的层图片，不额外发请求
  const bg = document.createElement('div');
  bg.className = 'render-bg';
  for (const img of document.querySelectorAll<HTMLImageElement>('.hc__art')) {
    const clone = document.createElement('img');
    clone.src = img.src;
    clone.alt = '';
    bg.append(clone);
  }
  document.body.append(bg);

  const copy = document.createElement('div');
  copy.className = 'render-copy';
  copy.innerHTML =
    '<h2>会发光的<br />分层闪卡</h2>' +
    '<p>前中后景自动分层，每层各上各的箔面。<br />转动它，箔面会跟着角度变。</p>' +
    '<span class="render-url">holocard.longsizhuo.com</span>';
  document.querySelector('.page__body')?.append(copy);
}

/** 按路由决定首屏加载什么 */
async function boot(): Promise<void> {
  if (route.mode === 'render') {
    // 给服务端截 OG 图用：只留卡片，固定在炫光峰值姿态，不带任何 UI
    document.body.classList.add('is-render');
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
    if (route.mode === 'card' && route.id) track('card-view', { card: route.id });
  }

  if (route.id) {
    try {
      const set = await loadLayerSet(`${import.meta.env.BASE_URL}api/layers/${route.id}`);
      show(set, route.id);
      status.textContent = `${set.manifest.layers.length} 层`;

      if (route.mode === 'render') {
        buildRenderBackdrop();
        // 等所有层真正解码完再摆姿态，否则截图可能截到半成品
        await Promise.all(
          [...document.querySelectorAll('img.hc__art')].map((img) =>
            (img as HTMLImageElement).decode().catch(() => undefined),
          ),
        );
        card.setPose({ x: 78, y: 22 });
        // 给截图脚本一个明确的信号，别靠猜时间
        document.body.dataset['ready'] = '1';
      }
      return;
    } catch (error) {
      status.textContent = `这张卡打不开了：${error instanceof Error ? error.message : String(error)}`;
      if (route.mode === 'render') document.body.dataset['ready'] = 'error';
      return;
    }
  }

  try {
    const sample = await loadLayerSet(`${import.meta.env.BASE_URL}samples/forest`);
    show(sample);
    status.textContent = `已加载 ${sample.manifest.layers.length} 层手工素材 samples/forest`;
  } catch (error) {
    status.textContent = `素材加载失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

await boot();
pollHalo();
