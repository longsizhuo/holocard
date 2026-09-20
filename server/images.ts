/**
 * 服务端的图片解码/编码后端，基于 sharp（libvips）。
 *
 * sharp 是 transformers.js 自带的依赖，不用额外装。
 * 它比 canvas 那条路快得多，而且不需要任何原生图形栈。
 */

import sharp from 'sharp';
import { fitWithin, type ImageBackend, type RgbaImage } from '../src/segmenter/image-io';

/** 超过这个像素数就拒绝，挡住解压炸弹（一张小 PNG 可以解出几十亿像素） */
const MAX_SOURCE_PIXELS = 60_000_000;

export const sharpImages: ImageBackend = {
  async decodeScaled(source: Blob, maxDimension: number): Promise<RgbaImage> {
    const input = Buffer.from(await source.arrayBuffer());
    const meta = await sharp(input).metadata();
    if (!meta.width || !meta.height) {
      throw new Error('无法识别的图片');
    }
    if (meta.width * meta.height > MAX_SOURCE_PIXELS) {
      throw new Error(`图片过大：${meta.width}x${meta.height}`);
    }

    const { width, height } = fitWithin(meta.width, meta.height, maxDimension);
    const { data } = await sharp(input)
      // 动图只取第一帧；EXIF 方向要摆正，否则深度图和画面对不上
      .rotate()
      .resize(width, height, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return { data: new Uint8ClampedArray(data), width, height };
  },

  async encodePng(image: RgbaImage): Promise<Blob> {
    const png = await sharp(Buffer.from(image.data), {
      raw: { width: image.width, height: image.height, channels: 4 },
    })
      // compressionLevel 6 是体积和 CPU 的折中；这台机器只有 4 核，9 会明显拖慢
      .png({ compressionLevel: 6 })
      .toBuffer();
    return new Blob([new Uint8Array(png)], { type: 'image/png' });
  },
};
