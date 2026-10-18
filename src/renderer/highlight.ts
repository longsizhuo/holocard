/**
 * 高光保护：箔面、炫光、高光的遮罩按画面亮度打折。
 *
 * 箔面大多是 color-dodge 混合，算法是「底色 ÷ (1 − 箔色)」——底色越亮越容易顶到纯白；
 * 整卡高光是 overlay，亮部同样被往白里推。白衣服、白毛、白纸上只要叠一点，
 * 0.8～0.95 之间的明暗层次就全被推到 1，纹理和轮廓一起没了（issue #3 第 1 条，附件里的白猫）。
 *
 * 所以遮罩不再是「有画面的地方全开」，而是再乘一个保护系数：
 * 亮度低于 KNEE 的地方原样，往上平滑减弱，到纯白处只剩 FLOOR。
 * 暗部、中间调的效果强度完全不变，闪卡质感不丢；只有快要顶白的地方收着点。
 */

/** 亮度从这里开始削弱效果 */
const KNEE = 0.6;
/** 纯白处保留的效果比例。不归零：亮部仍然带一点闪，否则白色区域看起来像没上箔 */
const FLOOR = 0.2;
/** 遮罩最长边。分层产出的层图是 1400 宽，这个上限只防万一有人喂了特别大的图 */
const MAX_SIDE = 2048;

/** 保护系数：亮度 0..1 → 效果保留比例 FLOOR..1 */
export function protection(luminance: number): number {
  const t = Math.min(1, Math.max(0, (luminance - KNEE) / (1 - KNEE)));
  // smoothstep，过渡处不出现可见的分界线
  return 1 - (1 - FLOOR) * t * t * (3 - 2 * t);
}

/**
 * 亮部遮罩（brightMask）的门槛按这一层自己的亮度定：这一层有内容的像素里，亮度中位数以下为 0，
 * 比中位数亮 BRIGHT_SPAN 就全开。特效层的内容大半是光带旁边那圈软边里的暗处，中位数就是「周围的亮度」，
 * 比它亮的才是光带。光带本身亮不亮因图而异（这张狐狸卡只有 0.3～0.5），写死门槛会把暗一点的光带整条筛掉；
 * 全开点也不能取最亮的那几个反光点，那样普通亮度的光带只剩两成
 */
const BRIGHT_SPAN = 0.12;
/**
 * 亮部遮罩再往外晕开这么多（占宽度，1400 宽的层约 3 像素）。光带只有两三个像素宽，白光只打在线上，
 * 缩到手机屏幕上几乎看不见；留一点点余量，脉冲经过的那一小段才像一颗光点。没有脉冲的地方白光是零，不会平白套一层
 */
const BRIGHT_BLOOM = 0.002;

/** 只取亮部：from 以下为 0，到 full 全开，中间 smoothstep。和 protection 正好反过来 */
export function brightness(luminance: number, from: number, full: number): number {
  const t = Math.min(1, Math.max(0, (luminance - from) / Math.max(1e-3, full - from)));
  return t * t * (3 - 2 * t);
}

/**
 * 把几张图按顺序叠到一张画布上，按叠好的画面亮度算遮罩，返回 object URL（调用方负责 revoke）。
 * 遮罩再乘上画面自己的 alpha：箔面、炫光都只该出现在这一层（组）有内容的地方。
 * 遮罩只看 alpha 通道，颜色通道原样留着没关系。weight 把亮度换成保留比例，默认是高光保护
 */
async function maskFrom(
  images: Blob[],
  makeWeight: (luminances: number[]) => (luminance: number) => number = () => protection,
  bloom = 0,
  inspect?: (alpha: Uint8ClampedArray, width: number, height: number) => void,
): Promise<string> {
  const bitmaps = await Promise.all(images.map((image) => createImageBitmap(image)));
  const first = bitmaps[0];
  if (!first) throw new Error('没有图');
  const scale = Math.min(1, MAX_SIDE / Math.max(first.width, first.height));
  // 用页面里的 canvas 而不是 OffscreenCanvas：iOS 16.4 以前没有后者，而这块手机用户最多
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(first.width * scale);
  canvas.height = Math.round(first.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('拿不到 2D 上下文');
  for (const bitmap of bitmaps) {
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
  }

  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = pixels.data;
  // Rec.709 亮度，直接在 sRGB 值上算：要的是「看起来多亮」，不需要先转线性
  const luminanceAt = (i: number): number => (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
  const sample: number[] = [];
  for (let i = 0; i < d.length; i += 4) if ((d[i + 3] ?? 0) > 0) sample.push(luminanceAt(i));
  const weight = makeWeight(sample);
  for (let i = 0; i < d.length; i += 4) {
    const alpha = d[i + 3] ?? 0;
    if (alpha === 0) continue;
    d[i + 3] = Math.round(alpha * weight(luminanceAt(i)));
  }
  if (bloom > 0) spread(d, canvas.width, canvas.height, Math.max(1, Math.round(bloom * canvas.width)));
  inspect?.(d, canvas.width, canvas.height);
  ctx.putImageData(pixels, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('遮罩导出失败');
  return URL.createObjectURL(blob);
}

/**
 * alpha 往外晕开 radius 像素：两遍可分离的方框模糊（近似高斯），再和原值取大，原来实的地方不变淡。
 * 晕开的部分只有原来的 BLOOM_GAIN 倍高，边缘是渐隐的
 */
const BLOOM_GAIN = 0.7;
function spread(d: Uint8ClampedArray, width: number, height: number, radius: number): void {
  const src = new Float32Array(width * height);
  for (let p = 0; p < src.length; p++) src[p] = d[p * 4 + 3] ?? 0;
  let a = src;
  for (let pass = 0; pass < 2; pass++) {
    const h = new Float32Array(a.length);
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let x = -radius; x <= radius; x++) sum += a[y * width + Math.min(width - 1, Math.max(0, x))] ?? 0;
      for (let x = 0; x < width; x++) {
        h[y * width + x] = sum / (2 * radius + 1);
        sum += (a[y * width + Math.min(width - 1, x + radius + 1)] ?? 0) - (a[y * width + Math.max(0, x - radius)] ?? 0);
      }
    }
    const v = new Float32Array(a.length);
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += h[Math.min(height - 1, Math.max(0, y)) * width + x] ?? 0;
      for (let y = 0; y < height; y++) {
        v[y * width + x] = sum / (2 * radius + 1);
        sum += (h[Math.min(height - 1, y + radius + 1) * width + x] ?? 0) - (h[Math.max(0, y - radius) * width + x] ?? 0);
      }
    }
    a = v;
  }
  for (let p = 0; p < src.length; p++) d[p * 4 + 3] = Math.max(src[p] ?? 0, Math.min(255, (a[p] ?? 0) * 2 * radius * BLOOM_GAIN));
}

/** 某一层箔面的遮罩：这一层的 alpha × 高光保护 */
export function layerMask(layer: Blob): Promise<string> {
  return maskFrom([layer]);
}

/** 亮部的形状：中心（占宽高的比例）和长轴方向（弧度，x 向右、y 向下），光效按它定转动中心和流动方向 */
export interface MaskShape {
  cx: number;
  cy: number;
  angle: number;
}

/** 按 alpha 加权的中心和长轴（二阶矩的主方向）。全透明时为 null */
function shapeOf(d: Uint8ClampedArray, width: number, height: number): MaskShape | null {
  let sum = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let p = 0; p < width * height; p++) {
    const a = d[p * 4 + 3] ?? 0;
    if (a === 0) continue;
    const x = (p % width) / width;
    const y = Math.floor(p / width) / height;
    sum += a;
    sx += a * x;
    sy += a * y;
    sxx += a * x * x;
    syy += a * y * y;
    sxy += a * x * y;
  }
  if (sum === 0) return null;
  const cx = sx / sum;
  const cy = sy / sum;
  // 二阶矩按像素算（乘回宽高），不然竖长的卡上方向会被压扁
  const mxx = (sxx / sum - cx * cx) * width * width;
  const myy = (syy / sum - cy * cy) * height * height;
  const mxy = (sxy / sum - cx * cy) * width * height;
  return { cx, cy, angle: 0.5 * Math.atan2(2 * mxy, mxx - myy) };
}

/**
 * 光效层流动白光的遮罩：这一层的 alpha × 只取亮部（brightness）。
 * 特效层的 alpha 带一圈软边，软边里是光带旁边的暗天空；白光是 color-dodge，打上去会把天空也提亮，
 * 像在光带外面套了一层。只取亮部，白光就只落在光带本身那几个像素上。onShape 拿到亮部的中心和长轴
 */
export function brightMask(layer: Blob, onShape?: (shape: MaskShape) => void): Promise<string> {
  return maskFrom(
    [layer],
    (sample) => {
    if (sample.length === 0) return () => 0;
    sample.sort((a, b) => a - b);
    const from = sample[Math.floor(sample.length / 2)] ?? 0;
    return (luminance) => brightness(luminance, from, from + BRIGHT_SPAN);
    },
    BRIGHT_BLOOM,
    (d, width, height) => {
      const shape = onShape && shapeOf(d, width, height);
      if (shape) onShape(shape);
    },
  );
}

/**
 * 一组视差相同的层上面那份炫光、高光的遮罩：这一组由远及近叠出来的画面 × 它的 alpha。
 * 这一组没画到的地方透明，露的是下面那一组自己的炫光（见 card.ts 的分组）
 */
export function groupMask(layers: Blob[]): Promise<string> {
  return maskFrom(layers);
}
