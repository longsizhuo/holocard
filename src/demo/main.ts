/** 演示页：加载素材、接分层流水线、挂调参面板 */

import './style.css';
import { HoloCard } from '../renderer/card';
import { loadLayerSet } from '../format/io';
import type { FoilType, LayerSet } from '../format/types';

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
const ctlFoil = need<HTMLSelectElement>('#ctl-foil');
const ctlFoilSubject = need<HTMLInputElement>('#ctl-foil-subject');
const outTilt = need<HTMLOutputElement>('#out-tilt');
const outAmp = need<HTMLOutputElement>('#out-amp');

const drop = need<HTMLDivElement>('#drop');
const filePicker = need<HTMLInputElement>('#file');
const progress = need<HTMLDivElement>('#progress');
const progressFill = need<HTMLElement>('#progress-fill');
const progressText = need<HTMLSpanElement>('#progress-text');

const card = new HoloCard(stage, {
  tilt: Number(ctlTilt.value),
  amplitude: Number(ctlAmp.value) / 100,
});

/** 当前这组层的原始数据，改光泽配置时要基于它重建 */
let current: LayerSet | null = null;
/** 分层中，防止重复提交 */
let busy = false;

/**
 * 光泽配置写在 manifest 里，改配置就得重建 DOM。
 * 层数很少、图片已在内存，重建开销可以忽略。
 */
function applyFoilSettings(): void {
  if (!current) return;

  const type = ctlFoil.value as FoilType;
  // 勾上时只作用于最近的那一层（主体），取消勾选则退化成整卡统一光泽
  const targets = ctlFoilSubject.checked ? [current.manifest.layers.length - 1] : [];

  card.setLayerSet({
    ...current,
    manifest: {
      ...current.manifest,
      effects: {
        ...current.manifest.effects,
        foil: { ...current.manifest.effects.foil, type, layers: targets },
      },
    },
  });
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
    applyFoilSettings();
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

ctlFoil.addEventListener('change', applyFoilSettings);
ctlFoilSubject.addEventListener('change', applyFoilSettings);

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
  applyFoilSettings();
  status.textContent = `已加载 ${current.manifest.layers.length} 层手工素材 samples/forest`;
} catch (error) {
  status.textContent = `素材加载失败：${error instanceof Error ? error.message : String(error)}`;
}
