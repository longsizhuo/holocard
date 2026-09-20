/** 演示页：加载素材、接分层流水线、挂调参面板 */

import './style.css';
import { HoloCard } from '../renderer/card';
import { loadLayerSet } from '../format/io';
import { FOIL_TYPES, type FoilType, type LayerSet } from '../format/types';
import { segmentOnServer, ServerUnavailableError } from './api';

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

const card = new HoloCard(stage, { amplitude: Number(ctlAmp.value) / 100 });

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
function show(set: LayerSet): void {
  current = set;
  set.manifest.effects.halo.intensity = Number(ctlIntensity.value);
  set.manifest.effects.halo.light = {
    ...set.manifest.effects.halo.light,
    sharpness: Number(ctlSharp.value),
  };
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

  try {
    let set: LayerSet;
    try {
      const layersUrl = await segmentOnServer(file, (p) => showProgress(p.detail, p.ratio));
      set = await loadLayerSet(layersUrl);
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
      status.textContent = `已在本机切成 ${set.manifest.layers.length} 层 · ${set.manifest.generator ?? ''}`;
    }

    show(set);
    progress.hidden = true;
  } catch (error) {
    progress.hidden = true;
    status.textContent = `处理失败：${error instanceof Error ? error.message : String(error)}`;
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

try {
  const sample = await loadLayerSet(`${import.meta.env.BASE_URL}samples/forest`);
  show(sample);
  status.textContent = `已加载 ${sample.manifest.layers.length} 层手工素材 samples/forest`;
} catch (error) {
  status.textContent = `素材加载失败：${error instanceof Error ? error.message : String(error)}`;
}

pollHalo();
