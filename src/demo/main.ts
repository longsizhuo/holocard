/** 演示页：加载素材、接分层流水线、挂调参面板 */

import './style.css';
import { HoloCard } from '../renderer/card';
import { loadLayerSet } from '../format/io';
import type { HaloType, LayerSet } from '../format/types';

/** 取元素并断言存在，省掉一堆空判断 */
function need<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`页面上找不到 ${selector}`);
  return el;
}

const stage = need<HTMLDivElement>('#stage');
const status = need<HTMLParagraphElement>('#status');

const ctlTilt = need<HTMLInputElement>('#ctl-tilt');
const ctlAmp = need<HTMLInputElement>('#ctl-amp');
const ctlHalo = need<HTMLSelectElement>('#ctl-halo');
const ctlIntensity = need<HTMLInputElement>('#ctl-intensity');
const ctlSharp = need<HTMLInputElement>('#ctl-sharp');
const ctlHaloMask = need<HTMLInputElement>('#ctl-halo-mask');

const outTilt = need<HTMLOutputElement>('#out-tilt');
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

const card = new HoloCard(stage, {
  tilt: Number(ctlTilt.value),
  amplitude: Number(ctlAmp.value) / 100,
});

/** 当前这组层的原始数据，改卡面配置时要基于它重建 */
let current: LayerSet | null = null;
/** 分层中，防止重复提交 */
let busy = false;

/**
 * 卡面配置写在 manifest 里，改配置就得重建 DOM。
 * 层数很少、图片已在内存，重建开销可以忽略。
 */
function applyHaloSettings(): void {
  if (!current) return;

  const layerCount = current.manifest.layers.length;
  card.setLayerSet({
    ...current,
    manifest: {
      ...current.manifest,
      effects: {
        ...current.manifest.effects,
        halo: {
          ...current.manifest.effects.halo,
          type: ctlHalo.value as HaloType,
          intensity: Number(ctlIntensity.value),
          // 勾上就把炫光压印成最近那一层的形状，否则铺满整张卡面
          maskLayer: ctlHaloMask.checked ? layerCount - 1 : null,
          light: {
            ...current.manifest.effects.halo.light,
            sharpness: Number(ctlSharp.value),
          },
        },
      },
    },
  });
}

/**
 * 把渲染器算出来的炫光强度显示出来。
 * 这是个纯读数：让人直观看到「只有转到某个倾角才爆」不是说辞。
 */
function pollHalo(): void {
  const root = card.element;
  if (root) {
    const value = Number(getComputedStyle(root).getPropertyValue('--hc-halo')) || 0;
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

/** 走完整条流水线：图片 → 深度 → 切层 → 补洞 → 渲染 */
async function processImage(file: File): Promise<void> {
  if (busy) return;
  busy = true;
  drop.classList.remove('is-over');
  showProgress('准备中');
  status.textContent = `正在处理 ${file.name}`;

  try {
    // 动态引入，把 transformers.js 挡在首屏之外
    const { segmentToLayerSet } = await import('../segmenter');

    const set = await segmentToLayerSet(file, {
      onProgress: (p) => showProgress(p.detail, p.ratio),
    });

    current = set;
    applyHaloSettings();
    progress.hidden = true;
    status.textContent = `已切成 ${set.manifest.layers.length} 层 · ${set.manifest.generator ?? ''}`;
  } catch (error) {
    progress.hidden = true;
    status.textContent = `处理失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    busy = false;
  }
}

ctlTilt.addEventListener('input', () => {
  const tilt = Number(ctlTilt.value);
  outTilt.value = `${tilt}°`;
  card.setOptions({ tilt });
});

ctlAmp.addEventListener('input', () => {
  const pct = Number(ctlAmp.value);
  outAmp.value = `${pct}%`;
  card.setOptions({ amplitude: pct / 100 });
});

ctlIntensity.addEventListener('input', () => {
  outIntensity.value = Number(ctlIntensity.value).toFixed(2);
  applyHaloSettings();
});

ctlSharp.addEventListener('input', () => {
  outSharp.value = ctlSharp.value;
  applyHaloSettings();
});

ctlHalo.addEventListener('change', applyHaloSettings);
ctlHaloMask.addEventListener('change', applyHaloSettings);

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
  current = await loadLayerSet(`${import.meta.env.BASE_URL}samples/forest`);
  applyHaloSettings();
  status.textContent = `已加载 ${current.manifest.layers.length} 层手工素材 samples/forest`;
} catch (error) {
  status.textContent = `素材加载失败：${error instanceof Error ? error.message : String(error)}`;
}

pollHalo();
