/**
 * 服务端的图片解码/编码后端，基于 sharp（libvips）。
 *
 * sharp 是 transformers.js 自带的依赖，不用额外装。
 * 它比 canvas 那条路快得多，而且不需要任何原生图形栈。
 */

import { rename } from 'node:fs/promises';
import sharp from 'sharp';
// HEIC 用现成的库解（libheif 的 WASM 版，自带 HEVC 解码器），见 normalizeOriginal
import decodeHeic from 'heic-decode';
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

/**
 * 这张图本身的问题（格式不认、太大）。code 是给前端翻译用的稳定错误类型，见 src/i18n。
 */
export class ImageError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported_image' | 'image_too_big',
    readonly params: Record<string, number> = {},
  ) {
    super(message);
    this.name = 'ImageError';
  }
}

/**
 * HEIF 容器里装的是不是 HEVC 编码的图（iPhone 和很多安卓手机相机的默认格式）。
 *
 * sharp 预编译包里的 libheif 只带了 AV1 解码器（HEVC 有专利），解这种图直接报
 * 「Support for this compression format has not been built in」。埋点里查到过：
 * 微信、安卓的内置浏览器会把相册里的 HEIC 原图直接传上来，不像 Safari 那样先转成 JPEG。
 * 同一个容器也可能装的是 AVIF（兼容品牌里有 avif），那种 sharp 自己能解，不走这里。
 */
function isHevcHeif(input: Buffer): boolean {
  if (input.length < 16 || input.toString('latin1', 4, 8) !== 'ftyp') return false;
  const boxSize = Math.min(input.readUInt32BE(0), input.length);
  const brands: string[] = [];
  for (let at = 8; at + 4 <= boxSize; at += 4) brands.push(input.toString('latin1', at, at + 4));
  if (brands.includes('avif') || brands.includes('avis')) return false;
  return brands.some((b) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].includes(b));
}

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
  if (isHevcHeif(input)) return normalizeHeic(input);

  const meta = await sharp(input)
    .metadata()
    .catch(() => null);
  if (!meta?.width || !meta.height) throw new ImageError('无法识别的图片', 'unsupported_image');
  if (meta.width * meta.height > MAX_SOURCE_PIXELS) {
    throw new ImageError(`图片过大：${meta.width}x${meta.height}`, 'image_too_big', {
      width: meta.width,
      height: meta.height,
    });
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

/**
 * HEIC 原图：用 heic-decode 解成像素，再存成 JPEG（q92，和别的有损格式一样）。
 * libheif 解码时已经按图里的旋转、镜像摆正了，不用再 rotate；元数据本来就不会带过去。
 */
async function normalizeHeic(input: Buffer): Promise<StoredOriginal> {
  let decoded: { width: number; height: number; data: Uint8ClampedArray };
  try {
    decoded = await decodeHeic({ buffer: input });
  } catch {
    throw new ImageError('无法识别的 HEIC 图片', 'unsupported_image');
  }
  const { width, height, data } = decoded;
  if (width * height > MAX_SOURCE_PIXELS) {
    throw new ImageError(`图片过大：${width}x${height}`, 'image_too_big', { width, height });
  }
  const out = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
  })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  return { data: out, ext: 'jpg', type: 'image/jpeg', width, height };
}

/**
 * 层图存成 WebP：有损画面 + 无损 alpha。
 *
 * 分层流水线出的是 PNG，箔面和视差之外，层图的 alpha 还兼任这一层箔面的遮罩，
 * 所以 alpha 必须无损；画面本身是照片，有损 q88 看不出区别。
 * 一张卡的层图从中位 3.3MB 降到几百 KB——线上查到过用户在微信里下载层图时断掉，
 * 服务端做好的卡就这么丢了，文件越小，断的机会越少。
 */
export function layerToWebp(png: Buffer): Promise<Buffer> {
  return sharp(png).webp({ quality: 88, alphaQuality: 100, effort: 4 }).toBuffer();
}

/** 卡册缩略图的最长边。手机上一行两张，480 在三倍屏上也够清楚 */
const THUMB_SIDE = 480;

/**
 * 卡册网格用的缩略图。原图动辄几 MB，分享图（preview.jpg）右半边又是一大段文案，都不适合放进网格。
 * 原图存盘前已经摆正方向、去掉了 EXIF（见 normalizeOriginal），这里只管缩。
 * 先写临时文件再改名：同一张卡的两个请求同时来，谁都不会读到写了一半的文件。
 */
export async function makeThumb(source: string, target: string): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await sharp(source)
    .resize(THUMB_SIDE, THUMB_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toFile(temp);
  await rename(temp, target);
}
