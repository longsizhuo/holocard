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
 * 把几张图按顺序叠到一张画布上，按叠好的画面亮度算遮罩，返回 object URL（调用方负责 revoke）。
 * 遮罩再乘上画面自己的 alpha：箔面、炫光都只该出现在这一层（组）有内容的地方。
 * 遮罩只看 alpha 通道，颜色通道原样留着没关系。
 */
async function maskFrom(images: Blob[]): Promise<string> {
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
  for (let i = 0; i < d.length; i += 4) {
    const alpha = d[i + 3] ?? 0;
    if (alpha === 0) continue;
    // Rec.709 亮度，直接在 sRGB 值上算：要的是「看起来多亮」，不需要先转线性
    const luminance = (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
    d[i + 3] = Math.round(alpha * protection(luminance));
  }
  ctx.putImageData(pixels, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('遮罩导出失败');
  return URL.createObjectURL(blob);
}

/** 某一层箔面的遮罩：这一层的 alpha × 高光保护 */
export function layerMask(layer: Blob): Promise<string> {
  return maskFrom([layer]);
}

/**
 * 一组视差相同的层上面那份炫光、高光的遮罩：这一组由远及近叠出来的画面 × 它的 alpha。
 * 这一组没画到的地方透明，露的是下面那一组自己的炫光（见 card.ts 的分组）
 */
export function groupMask(layers: Blob[]): Promise<string> {
  return maskFrom(layers);
}
