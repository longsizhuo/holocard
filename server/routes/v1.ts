import { readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, join } from 'node:path';
import type { LayerManifest } from '../../src/format/types';
import { bearerKey, hashApiKey } from '../account/apikeys';
import {
  API_DAILY_LIMIT,
  API_KEY_IN_FLIGHT,
  DAY_MS,
  KEEP_DOUBLINGS_CAP,
  MATTE_READY,
  MAX_API_QUEUE,
  OUT_DIR,
  PUBLIC_ORIGIN,
  RATE_WINDOW_MS,
  TTL_MS,
} from '../config';
import { fail, json, makeLimiter, methodNotAllowed, unauthorized } from '../http';
import { queuedEta, runningEta } from '../pipeline/eta';
import { acceptUpload, apiJobs, dequeue, originalFile, queue } from '../pipeline/jobs';
import { db } from '../store';
import { expiresAt } from '../store/cards';
import type { ApiKeyRow, CardRow } from '../store/db';
import { trackApi } from '../umami';

/*
 * 对外接口 /v1：给白名单里的少数调用方（key 由站长用 scripts/apikey.mjs 发）。用法见 docs-site/api/index.md。
 *
 * 和网页的区别：
 *   - 鉴权：Authorization: Bearer <key>，每张卡只有提交它的 key 能看、能下、能删
 *   - 私有：不能分享、不能导出，公开路由（/c、/api/layers、/api/jobs）上当作不存在
 *   - 保留：提交后 24 小时清掉（cards.ts 的 API_TTL_MS），调用方自己把结果存走
 *   - 审核：裸露识别做完才交付，分数高的直接拒绝（screenApiCard）
 *   - 排队：插在网页任务后面，额度按 key 和全站各算（见 config.ts 的 API_* 常量）
 */

/**
 * 对外接口按 key 数提交次数（不管成没成）。额度只数成功插库的卡，
 * 一直发解不开的图（魔数对、内容坏）就能白耗规范化的 CPU 而不扣额度，这个兜住
 */
const apiAttemptLimited = makeLimiter(30, RATE_WINDOW_MS);

/** 这些文件可以经 /v1 下载：清单、层图、去掉 EXIF 的原图 */
const V1_FILE = /^(?:manifest\.json|layer-\d{1,2}\.(?:png|webp)|original\.(?:jpg|png|webp))$/;

/** 对外不暴露内部的错误信息，只给错误码 */
const V1_ERRORS = new Set(['nsfw_rejected', 'moderation_unavailable']);

function apiKeyOf(req: IncomingMessage): ApiKeyRow | null {
  const key = bearerKey(req.headers['authorization']);
  return key ? db.apiKeyByHash(hashApiKey(key)) : null;
}

/**
 * 正在上传（读请求体、规范化、写盘）的 /v1 请求数，按 key 和全站各记一份。
 * 库里的「在途」只数已经插库的卡，上传中的请求不算的话，一个 key 并发发一百个 16MB 请求，
 * 一百份请求体都进内存、一百次全图解码，要到入队前那次检查才被拒掉
 */
const v1Uploading = new Map<string, number>();
let v1UploadingAll = 0;
/** 全站同时最多几个 /v1 上传在读体、规范化 */
const V1_MAX_UPLOADING = 4;

export async function handleV1(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const key = apiKeyOf(req);
  if (!key) {
    unauthorized(res);
    return;
  }
  // HEAD 按 GET 处理，Node 会自己去掉响应体
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  if (url.pathname === '/v1/cards') {
    if (method !== 'POST') {
      methodNotAllowed(res, 'POST');
      return;
    }
    /** 被拒（限流、额度、排满）也记一笔：看得出有没有人被卡住 */
    const reject = (status: number, code: string, message: string, params?: Record<string, string | number>): void => {
      fail(res, status, code, message, params);
      trackApi(key, 'api-reject', { code });
    };
    if (apiAttemptLimited(key.id)) {
      reject(429, 'rate_limited', '提交太频繁了，过几分钟再试');
      return;
    }
    /** 这个请求自己是不是已经算进 v1Uploading 了：第二次检查时要减掉自己 */
    let counted = 0;
    const admit = (): boolean => {
      // 吊销立即生效：上传途中被吊销的，入队前在这里拦下
      if (!db.apiKeyActive(key.id)) {
        unauthorized(res);
        return false;
      }
      const busy = db.apiInFlight(key.id) + (v1Uploading.get(key.id) ?? 0) - counted;
      const since = Date.now() - DAY_MS;
      // 管理员只免额度（账号的、全站每天的），同时在处理几张、排队上限照旧：那是保护机器的
      const unlimited = db.isAdmin(key.user_id);
      if (!unlimited && db.apiUsedSince(since, key) >= key.daily_limit) {
        reject(429, 'quota_exceeded', `24 小时内最多提交 ${key.daily_limit} 张`, { limit: key.daily_limit });
        return false;
      }
      if (busy >= API_KEY_IN_FLIGHT) {
        reject(429, 'too_many_in_flight', `同一个 key 同时最多 ${API_KEY_IN_FLIGHT} 张在上传或处理`, { limit: API_KEY_IN_FLIGHT });
        return false;
      }
      if (!unlimited && db.apiSubmittedSince(since) >= API_DAILY_LIMIT) {
        reject(503, 'api_daily_limit', '对外接口今天的总量用完了，明天再试');
        return false;
      }
      if (apiJobs.size >= MAX_API_QUEUE) {
        reject(503, 'queue_full', `排队的太多（${apiJobs.size} 个在等），稍后再试`, { queued: apiJobs.size });
        return false;
      }
      return true;
    };
    if (!admit()) return;
    if (v1UploadingAll >= V1_MAX_UPLOADING) {
      reject(503, 'busy', '同时上传的太多，稍后再试');
      return;
    }
    v1Uploading.set(key.id, (v1Uploading.get(key.id) ?? 0) + 1);
    v1UploadingAll++;
    counted = 1;
    let card: CardRow | null;
    try {
      card = await acceptUpload(req, res, 'api', key, admit);
    } finally {
      const left = (v1Uploading.get(key.id) ?? 1) - 1;
      if (left > 0) v1Uploading.set(key.id, left);
      else v1Uploading.delete(key.id);
      v1UploadingAll--;
    }
    if (!card) return;
    trackApi(key, 'api-submit', { via: key.user_id ? 'self-serve' : 'issued' });
    json(res, 202, {
      id: card.id,
      status: 'queued',
      position: queue.indexOf(card.id) + 1,
      url: `${PUBLIC_ORIGIN}/v1/cards/${card.id}`,
    });
    return;
  }

  const match = /^\/v1\/cards\/([0-9a-f-]{36})(?:\/files\/([\w.-]+))?$/.exec(url.pathname);
  if (!match) {
    fail(res, 404, 'not_found', '没有这个接口');
    return;
  }
  const fileName = match[2];
  if (fileName === undefined ? method !== 'GET' && method !== 'DELETE' : method !== 'GET') {
    methodNotAllowed(res, fileName === undefined ? 'GET, HEAD, DELETE' : 'GET, HEAD');
    return;
  }
  const card = db.get(match[1] ?? '');
  /*
   * 别的 key 的卡、删掉的、过期的，一律当作不存在。过期直接按时间判断，不等清理任务：
   * 清理每 15 分钟一次，承诺的是提交后 24 小时就拿不到
   */
  if (
    !card ||
    card.api_key !== key.id ||
    ['deleted', 'expired', 'removed'].includes(card.status) ||
    Date.now() >= expiresAt(card, TTL_MS, KEEP_DOUBLINGS_CAP)
  ) {
    fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
    return;
  }
  const dir = join(OUT_DIR, card.id);

  if (method === 'GET' && fileName === undefined) {
    const base = `${PUBLIC_ORIGIN}/v1/cards/${card.id}`;
    const position = card.status === 'queued' ? queue.indexOf(card.id) + 1 : 0;
    const eta =
      card.status === 'running' ? runningEta(card.id) : card.status === 'queued' ? queuedEta(position, MATTE_READY) : null;
    const body: Record<string, unknown> = {
      id: card.id,
      status: card.status === 'error' ? 'failed' : card.status,
      stage: card.stage,
      position,
      ...(eta === null ? {} : { eta: Math.round(eta) }),
      expiresAt: new Date(expiresAt(card, TTL_MS, KEEP_DOUBLINGS_CAP)).toISOString(),
    };
    if (card.status === 'error') {
      body['error'] = { code: card.error && V1_ERRORS.has(card.error) ? card.error : 'processing_failed' };
    }
    if (card.status === 'done') {
      try {
        const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as LayerManifest;
        const original = originalFile(card);
        const names = ['manifest.json', ...manifest.layers.map((layer) => layer.file), ...(original ? [basename(original)] : [])];
        body['manifest'] = manifest;
        body['files'] = Object.fromEntries(names.map((name) => [name, `${base}/files/${name}`]));
      } catch {
        fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
        return;
      }
    }
    json(res, 200, body);
    return;
  }

  if (method === 'GET' && fileName !== undefined) {
    if (!V1_FILE.test(fileName) || card.status !== 'done') {
      fail(res, 404, 'file_not_found', '文件不存在');
      return;
    }
    let data: Buffer;
    try {
      data = await readFile(join(dir, fileName));
    } catch {
      fail(res, 404, 'file_not_found', '文件不存在');
      return;
    }
    const ext = extname(fileName);
    res.writeHead(200, {
      'content-type':
        ext === '.json'
          ? 'application/json; charset=utf-8'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.png'
              ? 'image/png'
              : 'image/jpeg',
      'content-length': data.byteLength,
      // 私有的东西，CDN 和浏览器都不要缓存
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex',
    });
    res.end(data);
    // 结果有没有被取走：每张卡都有第一层，下它就算一次（HEAD 不算）
    if (req.method === 'GET' && fileName.startsWith('layer-0.')) trackApi(key, 'api-fetch');
    return;
  }

  if (method === 'DELETE' && fileName === undefined) {
    // 先改状态再删文件，理由同网页的删卡
    dequeue(card.id);
    db.update(card.id, { status: 'deleted', stage: null });
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    console.log(`[v1] ${card.id} 已被 key ${key.id} 删除`);
    json(res, 200, { deleted: true });
    return;
  }
}
