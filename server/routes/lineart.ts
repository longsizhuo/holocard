/**
 * 线稿提取的接口（任务本身见 server/pipeline/lineart.ts）：
 *   POST /api/lineart                       请求体是图片字节 → 202 { id }
 *   GET  /api/lineart/<id>                  → { state, error?, width, height, subject, files }
 *   GET  /api/lineart/<id>/<名字>.png        image（缩过的原图）、line（灰度线稿）、subject（主体遮罩）
 * 不要登录、不进数据库；地址是随机 UUID，不公开，24 小时后删。成品（上色、透明底）由前端合成下载
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RATE_LIMIT, RATE_WINDOW_MS } from '../config';
import { fail, json, makeLimiter, methodNotAllowed } from '../http';
import {
  LINEART_DIR,
  LINEART_FILES,
  MAX_LINEART_QUEUE,
  lineartAvailable,
  lineartInFlight,
  lineartStatus,
  startLineart,
} from '../pipeline/lineart';
import { acceptImage } from './image-upload';

/** 和上传分层、卡面遮罩分开计数，限额相同 */
const lineartLimited = makeLimiter(RATE_LIMIT, RATE_WINDOW_MS);

export async function handleLineart(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === '/api/lineart') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST');
      return;
    }
    if (!lineartAvailable()) {
      fail(res, 503, 'lineart_unavailable', '这台服务没有装线稿模型');
      return;
    }
    const image = await acceptImage(req, res, lineartLimited, lineartInFlight(), MAX_LINEART_QUEUE);
    if (!image) return;
    try {
      json(res, 202, { id: await startLineart(image) });
    } catch (error) {
      console.error('[lineart] 保存失败', error);
      fail(res, 500, 'store_failed', '保存图片失败，稍后再试');
    }
    return;
  }

  const match = /^\/api\/lineart\/([0-9a-f-]{36})(?:\/([a-z]+)\.png)?$/.exec(url.pathname);
  if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) {
    fail(res, 404, 'not_found', '没有这个地址');
    return;
  }
  const [, id = '', file] = match;
  const status = await lineartStatus(id);
  if (!status) {
    fail(res, 404, 'lineart_not_found', '这张线稿不存在或已过期');
    return;
  }

  if (file === undefined) {
    const base = `/api/lineart/${id}`;
    const files = status.state === 'done' ? LINEART_FILES.filter((name) => name !== 'subject' || status.subject) : [];
    json(res, 200, { ...status, ...(files.length ? { files: Object.fromEntries(files.map((name) => [name, `${base}/${name}.png`])) } : {}) });
    return;
  }

  if (!(LINEART_FILES as readonly string[]).includes(file) || (file !== 'image' && status.state !== 'done')) {
    fail(res, 404, 'file_not_found', '文件不存在');
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(join(LINEART_DIR, id, `${file}.png`));
  } catch {
    fail(res, 404, 'file_not_found', '文件不存在');
    return;
  }
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': body.byteLength,
    // 别人传的图，只给上传者自己看；不进搜索
    'cache-control': 'private, max-age=3600',
    'x-robots-tag': 'noindex',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}
