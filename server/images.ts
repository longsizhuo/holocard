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

export interface StoredOriginal {
  data: Buffer;
  /** 存盘用的扩展名，也决定了对外的 URL */
  ext: 'jpg' | 'png' | 'webp';
  type: string;
  width: number;
  height: number;
}

/**
 * 把用户上传的原图规范化成要存下来的那一份。
 *
 * 做三件事：
 *   1. 按 EXIF 摆正方向，然后**丢掉所有元数据**。原图地址是公开的，
 *      手机照片的 EXIF 里常带拍摄地的 GPS 坐标，原样存等于把用户家在哪挂到网上。
 *      sharp 默认输出就不带元数据，这里不调 keepMetadata 就行。
 *   2. 格式尽量保持：JPEG 还是 JPEG、PNG 还是 PNG、WebP 还是 WebP。
 *      AVIF / HEIC 转成 JPEG——浏览器对它们的支持参差不齐，存下来要能直接打开看。
 *      带透明通道的一律存 PNG，转 JPEG 会把透明区域糊成黑底。
 *   3. 尺寸不动。这是「原图」，以后算法改进了要拿它重跑，缩了就回不去了。
 *
 * 有损格式会重新编码一次（q92），这是去元数据的代价；
 * 对深度估计和切层来说这点差别看不出来，而本来分层时也会缩到 1400 边长。
 */
export async function normalizeOriginal(input: Buffer): Promise<StoredOriginal> {
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) throw new Error('无法识别的图片');
  if (meta.width * meta.height > MAX_SOURCE_PIXELS) {
    throw new Error(`图片过大：${meta.width}x${meta.height}`);
  }

  const pipeline = sharp(input).rotate();
  const hasAlpha = Boolean(meta.hasAlpha);

  let ext: StoredOriginal['ext'];
  let out: Buffer;
  if (meta.format === 'png' || (hasAlpha && meta.format !== 'webp')) {
    ext = 'png';
    out = await pipeline.png({ compressionLevel: 6 }).toBuffer();
  } else if (meta.format === 'webp') {
    ext = 'webp';
    out = await pipeline.webp({ quality: 92 }).toBuffer();
  } else {
    ext = 'jpg';
    out = await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  }

  // 摆正方向之后宽高可能互换（竖拍的照片 EXIF 方向是 6/8），以输出为准
  const outMeta = await sharp(out).metadata();
  return {
    data: out,
    ext,
    type: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`,
    width: outMeta.width ?? meta.width,
    height: outMeta.height ?? meta.height,
  };
}
