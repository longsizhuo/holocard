/**
 * 卡面遮罩的接口（任务本身见 server/pipeline/cardmask.ts）：
 *   POST /api/cardmask                 请求体是卡图字节 → 202 { id }
 *   GET  /api/cardmask/<id>            → { state, error?, width, height, window, files }
 *   GET  /api/cardmask/<id>/<名字>.png  遮罩和规范化后的卡图；?download=1 时按附件发
 * 不要登录、不进数据库；地址是随机 UUID，不公开，24 小时后删
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_UPLOAD, RATE_LIMIT, RATE_WINDOW_MS } from '../config';
import { clientIp, fail, json, makeLimiter, methodNotAllowed, readBody } from '../http';
import {
  CARDMASK_DIR,
  CARDMASK_FILES,
  MAX_CARDMASK_QUEUE,
  cardmaskAvailable,
  cardmaskInFlight,
  cardmaskStatus,
  startCardmask,
} from '../pipeline/cardmask';
import { sniffImage } from '../pipeline/jobs';
import { ImageError, normalizeOriginal } from '../pipeline/images';

/** 和上传分层分开计数，限额相同 */
const cardmaskLimited = makeLimiter(RATE_LIMIT, RATE_WINDOW_MS);

export async function handleCardmask(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === '/api/cardmask') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST');
      return;
    }
    if (!cardmaskAvailable()) {
      fail(res, 503, 'cardmask_unavailable', '这台服务没有装卡面遮罩要用的模型');
      return;
    }
    if (cardmaskLimited(clientIp(req))) {
      const minutes = Math.round(RATE_WINDOW_MS / 60000);
      fail(res, 429, 'rate_limited', `提交太频繁了，${minutes} 分钟内最多 ${RATE_LIMIT} 次`, { minutes, limit: RATE_LIMIT });
      return;
    }
    if (cardmaskInFlight() >= MAX_CARDMASK_QUEUE) {
      fail(res, 503, 'queue_full', '排队的太多，稍后再试', { queued: cardmaskInFlight() });
      return;
    }
    const limitMb = Math.round(MAX_UPLOAD / 1024 / 1024);
    let bytes: Buffer;
    try {
      if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD) throw new Error('too large');
      bytes = await readBody(req, MAX_UPLOAD, res);
    } catch {
      res.setHeader('connection', 'close');
      fail(res, 413, 'too_large', `图片超过 ${limitMb}MB 上限`, { limitMb });
      return;
    }
    if (!sniffImage(bytes)) {
      fail(res, 415, 'unsupported_image', '不是可识别的图片（支持 JPEG / PNG / WebP / AVIF / HEIC）');
      return;
    }
    let image: Buffer;
    try {
      image = (await normalizeOriginal(bytes)).data;
    } catch (error) {
      if (error instanceof ImageError) fail(res, 415, error.code, error.message, error.params);
      else fail(res, 415, 'unsupported_image', '无法识别的图片');
      return;
    }
    // 写盘出错要在这里接住：外面虽有兜底，但那样回的是 500 而不是能翻译的错误码
    try {
      json(res, 202, { id: await startCardmask(image) });
    } catch (error) {
      console.error('[cardmask] 保存失败', error);
      fail(res, 500, 'store_failed', '保存图片失败，稍后再试');
    }
    return;
  }

  const match = /^\/api\/cardmask\/([0-9a-f-]{36})(?:\/([a-z]+)\.png)?$/.exec(url.pathname);
  if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) {
    fail(res, 404, 'not_found', '没有这个地址');
    return;
  }
  const [, id = '', file] = match;
  const status = await cardmaskStatus(id);
  if (!status) {
    fail(res, 404, 'cardmask_not_found', '这组遮罩不存在或已过期');
    return;
  }

  if (file === undefined) {
    const base = `/api/cardmask/${id}`;
    json(res, 200, {
      ...status,
      ...(status.state === 'done' ? { files: Object.fromEntries(CARDMASK_FILES.map((name) => [name, `${base}/${name}.png`])) } : {}),
    });
    return;
  }

  if (!(CARDMASK_FILES as readonly string[]).includes(file) || (file !== 'card' && status.state !== 'done')) {
    fail(res, 404, 'file_not_found', '文件不存在');
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(join(CARDMASK_DIR, id, `${file}.png`));
  } catch {
    fail(res, 404, 'file_not_found', '文件不存在');
    return;
  }
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': body.byteLength,
    // 别人的卡图，只给上传者自己看；不进搜索
    'cache-control': 'private, max-age=3600',
    'x-robots-tag': 'noindex',
    ...(url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="holocard-${id.slice(0, 8)}-${file}.png"` } : {}),
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}
