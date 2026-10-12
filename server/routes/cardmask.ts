/**
 * 卡面遮罩的接口（任务本身见 server/pipeline/cardmask.ts）：
 *   POST /api/cardmask                 请求体是卡图字节 → 202 { id }
 *   GET  /api/cardmask/<id>            → { state, error?, width, height, window, panel, lines, files }
 *   GET  /api/cardmask/<id>/<名字>.png  遮罩和规范化后的卡图；?download=1 时按附件发
 * 不要登录、不进数据库；地址是随机 UUID，不公开，24 小时后删
 *
 * 对外接口版（handleV1Masks，v1.ts 验过 key 后转过来）：
 *   POST /v1/masks                      请求体是卡图字节 → 202 { id, status, url }
 *   GET  /v1/masks/<id>                 → { id, status, width, height, window, panel, lines, files }
 *   GET  /v1/masks/<id>/files/<名字>.png
 * 只有提交它的 key 能看，网页的 /api/cardmask 上当作不存在。用法见 docs-site/api/index.md
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { API_KEY_IN_FLIGHT, MAX_UPLOAD, PUBLIC_ORIGIN, RATE_LIMIT, RATE_WINDOW_MS } from '../config';
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
import type { ApiKeyRow } from '../store/db';
import { trackApi } from '../umami';

/** 和上传分层分开计数，限额相同 */
const cardmaskLimited = makeLimiter(RATE_LIMIT, RATE_WINDOW_MS);
/** 对外接口按 key 数提交次数，和 /v1/cards 一样宽 */
// ponytail: 没有按天的额度（遮罩不进数据库，不好数），靠这个、每个 key 的在途上限和全站队列兜住；有 key 刷量再加
const v1MasksLimited = makeLimiter(30, RATE_WINDOW_MS);

export async function handleCardmask(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === '/api/cardmask') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST');
      return;
    }
    if (cardmaskLimited(clientIp(req))) {
      const minutes = Math.round(RATE_WINDOW_MS / 60000);
      fail(res, 429, 'rate_limited', `提交太频繁了，${minutes} 分钟内最多 ${RATE_LIMIT} 次`, { minutes, limit: RATE_LIMIT });
      return;
    }
    const id = await acceptCardmask(req, res);
    if (id) json(res, 202, { id });
    return;
  }

  const match = /^\/api\/cardmask\/([0-9a-f-]{36})(?:\/([a-z]+)\.png)?$/.exec(url.pathname);
  if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) {
    fail(res, 404, 'not_found', '没有这个地址');
    return;
  }
  const [, id = '', file] = match;
  const status = await cardmaskStatus(id);
  // 对外接口提交的只给那个 key 看
  if (!status || status.owner !== undefined) {
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
  await sendFile(req, res, id, file, {
    // 别人的卡图，只给上传者自己看；不进搜索
    'cache-control': 'private, max-age=3600',
    ...(url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="holocard-${id.slice(0, 8)}-${file}.png"` } : {}),
  });
}

/** /v1/masks：key 已经在 v1.ts 验过 */
export async function handleV1Masks(req: IncomingMessage, res: ServerResponse, url: URL, key: ApiKeyRow): Promise<void> {
  if (url.pathname === '/v1/masks') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST');
      return;
    }
    if (v1MasksLimited(key.id)) {
      fail(res, 429, 'rate_limited', '提交太频繁了，过几分钟再试');
      return;
    }
    if (cardmaskInFlight(key.id) >= API_KEY_IN_FLIGHT) {
      fail(res, 429, 'too_many_in_flight', `同一个 key 同时最多 ${API_KEY_IN_FLIGHT} 张在处理`, { limit: API_KEY_IN_FLIGHT });
      return;
    }
    const id = await acceptCardmask(req, res, key.id);
    if (!id) return;
    trackApi(key, 'api-masks');
    json(res, 202, { id, status: 'queued', url: `${PUBLIC_ORIGIN}/v1/masks/${id}` });
    return;
  }

  const match = /^\/v1\/masks\/([0-9a-f-]{36})(?:\/files\/([a-z]+)\.png)?$/.exec(url.pathname);
  if (!match) {
    fail(res, 404, 'not_found', '没有这个接口');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    methodNotAllowed(res, 'GET, HEAD');
    return;
  }
  const [, id = '', file] = match;
  const status = await cardmaskStatus(id);
  // 别的 key 的、网页提交的、过期的，一律当作不存在
  if (!status || status.owner !== key.id) {
    fail(res, 404, 'masks_not_found', '这组遮罩不存在或已过期');
    return;
  }
  if (file === undefined) {
    const base = `${PUBLIC_ORIGIN}/v1/masks/${id}`;
    json(res, 200, {
      id,
      status: status.state === 'error' ? 'failed' : status.state,
      // 对外不暴露内部的错误信息
      ...(status.state === 'error' ? { error: { code: 'processing_failed' } } : {}),
      ...(status.state === 'done'
        ? {
            width: status.width,
            height: status.height,
            window: status.window,
            panel: status.panel,
            lines: status.lines,
            files: Object.fromEntries(CARDMASK_FILES.map((name) => [name, `${base}/files/${name}.png`])),
          }
        : {}),
    });
    return;
  }
  if (!(CARDMASK_FILES as readonly string[]).includes(file) || status.state !== 'done') {
    fail(res, 404, 'file_not_found', '文件不存在');
    return;
  }
  // 私有的东西，CDN 和浏览器都不要缓存
  await sendFile(req, res, id, file, { 'cache-control': 'private, no-store' });
}

/** 读卡图、规范化、排队，返回任务 id。出错时已经回了响应，返回 null */
async function acceptCardmask(req: IncomingMessage, res: ServerResponse, owner?: string): Promise<string | null> {
  if (!cardmaskAvailable()) {
    fail(res, 503, 'cardmask_unavailable', '这台服务没有装卡面遮罩要用的模型');
    return null;
  }
  if (cardmaskInFlight() >= MAX_CARDMASK_QUEUE) {
    fail(res, 503, 'queue_full', '排队的太多，稍后再试', { queued: cardmaskInFlight() });
    return null;
  }
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
  let image: Buffer;
  try {
    image = (await normalizeOriginal(bytes)).data;
  } catch (error) {
    if (error instanceof ImageError) fail(res, 415, error.code, error.message, error.params);
    else fail(res, 415, 'unsupported_image', '无法识别的图片');
    return null;
  }
  // 写盘出错要在这里接住：外面虽有兜底，但那样回的是 500 而不是能翻译的错误码
  try {
    return await startCardmask(image, owner);
  } catch (error) {
    console.error('[cardmask] 保存失败', error);
    fail(res, 500, 'store_failed', '保存图片失败，稍后再试');
    return null;
  }
}

async function sendFile(req: IncomingMessage, res: ServerResponse, id: string, file: string, headers: Record<string, string>): Promise<void> {
  let body: Buffer;
  try {
    body = await readFile(join(CARDMASK_DIR, id, `${file}.png`));
  } catch {
    fail(res, 404, 'file_not_found', '文件不存在');
    return;
  }
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.byteLength, 'x-robots-tag': 'noindex', ...headers });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}
