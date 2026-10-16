/**
 * 卡面遮罩的接口（任务本身见 server/pipeline/cardmask.ts）：
 *   POST /api/cardmask                 请求体是卡图字节 → 202 { id }
 *   GET  /api/cardmask/<id>            → { state, error?, width, height, window, panel, lines, files }
 *   GET  /api/cardmask/<id>/<名字>.png  遮罩和规范化后的卡图；?download=1 时按附件发
 * 不要登录、不进数据库；地址是随机 UUID，不公开，24 小时后删
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RATE_LIMIT, RATE_WINDOW_MS } from '../config';
import { fail, json, makeLimiter, methodNotAllowed } from '../http';
import {
  CARDMASK_DIR,
  CARDMASK_FILES,
  MAX_CARDMASK_QUEUE,
  cardmaskAvailable,
  cardmaskInFlight,
  cardmaskStatus,
  startCardmask,
} from '../pipeline/cardmask';
import { acceptImage } from './image-upload';

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
    const image = await acceptImage(req, res, cardmaskLimited, cardmaskInFlight(), MAX_CARDMASK_QUEUE);
    if (!image) return;
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
