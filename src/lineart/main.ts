/**
 * 线稿提取页（lineart.html）：上传插画 → 服务端出白底黑线的灰度线稿和主体遮罩（server/pipeline/lineart.ts）→
 * 在这里调深浅、线条颜色、只要主体，合成透明底的 PNG 下载。
 *
 * 线稿模型的输出常常偏淡，而且每张图淡的程度不一样，先按这张图自己的亮度定色阶：最暗的 1% 算全黑，中位数（背景）算全白。
 * 深浅滑块再在这之上调伽马：中间是原样，往右线更黑更粗，往左只留最明显的线
 */

import '../demo/style.css';
import '../demo/pearl-drift.css';
import '../masks/masks.css';
import './lineart.css';
import { t } from '../i18n';
import { BASE, failure, need, pixels, setupLang, submitAndWait } from '../tools/page';

/** 低于这个不透明度的当噪点去掉：背景里淡淡的纹理不该变成一层薄雾 */
const NOISE = 0.05;

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
    if (useSubject) alpha *= (subject[p * 4] ?? 0) / 255;
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
    const { id, job } = await submitAndWait<{ state: string; error?: string; subject?: boolean }>('lineart', file);
    const base = `${BASE}api/lineart/${id}`;
    const line = await pixels(`${base}/line.png`);
    const subject = job.subject ? (await pixels(`${base}/subject.png`)).data : null;
    current = { id, width: line.width, height: line.height, line: line.data, subject, black: percentile(line.data, 0.01), white: percentile(line.data, 0.5) };
    subjectBox.hidden = subject === null;
    result.hidden = false;
    render();
    status.textContent = '';
  } catch (error) {
    status.textContent = t('masks.failed', { message: failure(error) });
  } finally {
    fileInput.disabled = false;
    fileInput.value = '';
  }
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
