/**
 * 图片解码与编码的后端抽象
 *
 * 分层流水线里除了这一层，其余全是纯 typed-array 运算，浏览器和 Node 通用。
 * 把「把 Blob 解成 RGBA」和「把 RGBA 编成 PNG」这两件事抽出来之后，
 * 同一份 slice / morph / refine / extract 代码就能两边跑：
 *   浏览器  OffscreenCanvas（见下方 browserImages）
 *   Node    sharp（见 server/images.mjs，由服务端注入）
 */

/** 一块 RGBA 像素。与 ImageData 的内存布局一致，但不依赖 DOM 类型 */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface ImageBackend {
  /** 解码并按 maxDimension 等比缩小（只缩不放） */
  decodeScaled(source: Blob, maxDimension: number): Promise<RgbaImage>;
  /** 编码成 PNG */
  encodePng(image: RgbaImage): Promise<Blob>;
}

/** 按 maxDimension 算出目标尺寸，只缩不放 */
export function fitWithin(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * 浏览器实现。
 * 注意这个对象在 Node 里也会被打包进来，但只要不调用就不会碰到 OffscreenCanvas，
 * 服务端始终注入自己的后端。
 */
export const browserImages: ImageBackend = {
  async decodeScaled(source, maxDimension) {
    const bitmap = await createImageBitmap(source);
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxDimension);

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('拿不到 2D 上下文');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const pixels = ctx.getImageData(0, 0, width, height);
    return { data: pixels.data, width, height };
  },

  async encodePng(image) {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('拿不到 2D 上下文');
    // 先建空的再 set，避免把 data 的底层缓冲类型（可能是 SharedArrayBuffer）带进 ImageData
    const pixels = ctx.createImageData(image.width, image.height);
    pixels.data.set(image.data);
    ctx.putImageData(pixels, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  },
};
