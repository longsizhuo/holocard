/**
 * 工具页（卡面遮罩、线稿提取）收图：限流、排队上限、大小、格式，再规范化（摆正方向、去掉 EXIF）。
 * 哪一关没过就直接回能翻译的错误码，返回 null。
 * 卡面遮罩要在读完请求体之后、规范化之前占排队位置（见 routes/cardmask.ts），所以几关也分开导出
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_UPLOAD, RATE_LIMIT, RATE_WINDOW_MS } from '../config';
import { clientIp, fail, readBody } from '../http';
import { ImageError, normalizeOriginal } from '../pipeline/images';
import { sniffImage } from '../pipeline/jobs';

export async function acceptImage(
  req: IncomingMessage,
  res: ServerResponse,
  limited: (ip: string) => boolean,
  inFlight: number,
  maxQueue: number,
): Promise<Buffer | null> {
  if (tooFrequent(req, res, limited)) return null;
  if (inFlight >= maxQueue) {
    fail(res, 503, 'queue_full', '排队的太多，稍后再试', { queued: inFlight });
    return null;
  }
  const bytes = await readImage(req, res);
  return bytes && (await normalizeImage(res, bytes));
}

/** 这个 IP 提交太频繁就回 429，返回 true */
export function tooFrequent(req: IncomingMessage, res: ServerResponse, limited: (ip: string) => boolean): boolean {
  if (!limited(clientIp(req))) return false;
  const minutes = Math.round(RATE_WINDOW_MS / 60000);
  fail(res, 429, 'rate_limited', `提交太频繁了，${minutes} 分钟内最多 ${RATE_LIMIT} 次`, { minutes, limit: RATE_LIMIT });
  return true;
}

/** 读请求体，查大小和格式 */
export async function readImage(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  const limitMb = Math.round(MAX_UPLOAD / 1024 / 1024);
  let bytes: Buffer;
  try {
    if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD) throw new Error('too large');
    bytes = await readBody(req, MAX_UPLOAD, res);
  } catch {
    res.setHeader('connection', 'close');
    fail(res, 413, 'too_large', `图片超过 ${limitMb}MB 上限`, { limitMb });
    return null;
  }
  if (!sniffImage(bytes)) {
    fail(res, 415, 'unsupported_image', '不是可识别的图片（支持 JPEG / PNG / WebP / AVIF / HEIC）');
    return null;
  }
  return bytes;
}

/** 摆正方向、去掉 EXIF */
export async function normalizeImage(res: ServerResponse, bytes: Buffer): Promise<Buffer | null> {
  try {
    return (await normalizeOriginal(bytes)).data;
  } catch (error) {
    if (error instanceof ImageError) fail(res, 415, error.code, error.message, error.params);
    else fail(res, 415, 'unsupported_image', '无法识别的图片');
    return null;
  }
}
