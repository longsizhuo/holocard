/**
 * 线稿提取页（lineart.html）：上传插画 → 服务端出白底黑线的灰度线稿和主体遮罩（server/pipeline/lineart.ts）→
 * 在这里调深浅、线条颜色、只要主体，合成透明底的 PNG 下载。
 * 线稿几秒就有，先画出来；主体遮罩要再抠二十秒上下，抠好之前「只要主体」是灰的，抠好了再按它重画
 *
 * 线稿模型的输出常常偏淡，而且每张图淡的程度不一样，先按这张图自己的亮度定色阶：最暗的 1% 算全黑，中位数（背景）算全白。
 * 深浅滑块再在这之上调伽马：中间是原样，往右线更黑更粗，往左只留最明显的线
 */

import '../demo/style.css';
import '../demo/pearl-drift.css';
import '../masks/masks.css';
import './lineart.css';
import { t } from '../i18n';
import { BASE, describe, failure, need, pixels, setupLang, submitAndWait } from '../tools/page';

/** 低于这个不透明度的当噪点去掉：背景里淡淡的纹理不该变成一层薄雾 */
const NOISE = 0.05;
/**
 * 主体遮罩按这一段收边（smoothstep）：本机兜底的抠图边缘有一大圈半透明，直接乘上去，主体外面会留一团团淡淡的残影。
 * 显卡机那条（SAM3）出的是实心遮罩，不受影响
 */
const SUBJECT_FROM = 0.35;
const SUBJECT_FULL = 0.65;

const fileInput = need<HTMLInputElement>('#lineart-file');
const status = need<HTMLParagraphElement>('#lineart-status');
const result = need<HTMLElement>('#lineart-result');
const canvas = need<HTMLCanvasElement>('#lineart-canvas');
const strength = need<HTMLInputElement>('#lineart-strength');
const color = need<HTMLInputElement>('#lineart-color');
const subjectBox = need<HTMLLabelElement>('#lineart-subject-box');
const subjectOnly = need<HTMLInputElement>('#lineart-subject');
const download = need<HTMLButtonElement>('#lineart-download');

/** 当前这张：线稿灰度、主体遮罩（没有为 null），和按这张图定的色阶 */
let current: { id: string; width: number; height: number; line: Uint8ClampedArray; subject: Uint8ClampedArray | null; black: number; white: number } | null = null;

setupLang();

/** 灰度图第 p 百分位的值 */
function percentile(gray: Uint8ClampedArray, p: number): number {
  const counts = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 4) counts[gray[i] ?? 0]!++;
  const target = (gray.length / 4) * p;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += counts[v] ?? 0;
    if (seen >= target) return v;
  }
  return 255;
}

function render(): void {
  if (!current) return;
  const { width, height, line, subject, black, white } = current;
  // 滑块 0..100，中间 50 是原样；伽马 4（只留浓的线）到 0.25（淡线也拉黑）
  const gamma = 2 ** ((50 - Number(strength.value)) / 25);
  const hex = color.value;
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const span = Math.max(1, white - black);
  const useSubject = subject !== null && subjectOnly.checked;
  const out = new ImageData(width, height);
  for (let p = 0; p < width * height; p++) {
    const ink = Math.min(1, Math.max(0, (white - (line[p * 4] ?? 255)) / span));
    let alpha = ink ** gamma;
    if (alpha < NOISE) alpha = 0;
    if (useSubject) {
      const s = Math.min(1, Math.max(0, ((subject[p * 4] ?? 0) / 255 - SUBJECT_FROM) / (SUBJECT_FULL - SUBJECT_FROM)));
      alpha *= s * s * (3 - 2 * s);
    }
    out.data[p * 4] = rgb[0] ?? 0;
    out.data[p * 4 + 1] = rgb[1] ?? 0;
    out.data[p * 4 + 2] = rgb[2] ?? 0;
    out.data[p * 4 + 3] = Math.round(alpha * 255);
  }
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.putImageData(out, 0, 0);
}

async function upload(file: File): Promise<void> {
  fileInput.disabled = true;
  result.hidden = true;
  status.textContent = t('lineart.working');
  try {
    const { id, job } = await submitAndWait<Job>('lineart', file);
    const line = await pixels(`${BASE}api/lineart/${id}/line.png`);
    current = { id, width: line.width, height: line.height, line: line.data, subject: null, black: percentile(line.data, 0.01), white: percentile(line.data, 0.5) };
    result.hidden = false;
    render();
    await loadSubject(id, job);
  } catch (error) {
    status.textContent = t('masks.failed', { message: failure(error) });
  } finally {
    fileInput.disabled = false;
    fileInput.value = '';
  }
}

type Job = { state: string; error?: string; subject?: boolean | 'pending' };

/** 等主体遮罩：抠好了取回来按它重画；没有就把「只要主体」藏起来。期间又传了新图就不管这张了 */
async function loadSubject(id: string, job: Job): Promise<void> {
  subjectBox.hidden = job.subject === false;
  subjectOnly.disabled = true;
  status.textContent = job.subject === 'pending' ? t('lineart.matting') : '';
  while (job.subject === 'pending') {
    await new Promise((r) => setTimeout(r, 1500));
    if (current?.id !== id) return;
    const res = await fetch(`${BASE}api/lineart/${id}`);
    if (!res.ok) throw new Error(await describe(res));
    job = (await res.json()) as Job;
  }
  if (current?.id !== id) return;
  if (job.subject === true) {
    current.subject = (await pixels(`${BASE}api/lineart/${id}/subject.png`)).data;
    subjectOnly.disabled = false;
    render();
  }
  subjectBox.hidden = job.subject !== true;
  status.textContent = '';
}

function save(): void {
  if (!current) return;
  const id = current.id;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: `holocard-lineart-${id.slice(0, 8)}.png` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, 'image/png');
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void upload(file);
});
strength.addEventListener('input', render);
color.addEventListener('input', render);
subjectOnly.addEventListener('change', render);
download.addEventListener('click', save);
