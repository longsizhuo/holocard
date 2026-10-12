/**
 * 服务自己的两个接口：
 *   GET  /api/health  队列和线程的状况，发版脚本和监控看它（分层线程坏了回 503）
 *   POST /api/perf    性能埋点，一次页面访问最多一条（字段校验见 server/store/perf.ts）
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { CONCURRENCY, RATE_WINDOW_MS } from '../config';
import { clientIp, json, makeLimiter, methodNotAllowed, readBody } from '../http';
import { queue, running, segmenterBroken } from '../pipeline/jobs';
import { exportQueue, exporting } from '../render/exports';
import { db } from '../store';
import { parsePerf } from '../store/perf';

/** 性能埋点的限流：正常一次页面访问一条，这个数只挡刷的 */
const perfLimited = makeLimiter(30, RATE_WINDOW_MS);
/**
 * 性能埋点的总量上限，不分来源。换着地址刷能绕过按 IP 的限流，而表只留最新 20 万行，
 * 灌满的话真实数据全被挤掉。正常流量离这个数远得很
 */
const perfFlooded = makeLimiter(120, 60 * 1000);

export async function handleHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    methodNotAllowed(res, 'GET, HEAD');
    return;
  }
  json(res, segmenterBroken ? 503 : 200, {
    ok: !segmenterBroken,
    running,
    queued: queue.length,
    concurrency: CONCURRENCY,
    exporting: exporting ? 1 : 0,
    exportQueued: exportQueue.length,
  });
}

export async function handlePerf(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST');
    return;
  }
  /*
   * 只收本站前端发的：它发的是 application/json 的 Blob。别的网站想借访客的浏览器灌假数据，
   * 要么只能发 text/plain（这里拒收），要么带 application/json 触发预检（这个服务不答 OPTIONS）
   */
  const site = req.headers['sec-fetch-site'];
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json') || (site && site !== 'same-origin')) {
    res.writeHead(400).end();
    return;
  }
  if (perfLimited(clientIp(req)) || perfFlooded('all')) {
    res.writeHead(429).end();
    return;
  }
  let sample;
  try {
    sample = parsePerf(JSON.parse((await readBody(req, 4096)).toString('utf8')), req);
  } catch {
    sample = null;
  }
  if (!sample) {
    res.writeHead(400).end();
    return;
  }
  // 埋点写不进去（磁盘满、库被锁）不能把服务带崩：写库失败只记日志
  try {
    db.insertPerf(sample);
  } catch (error) {
    console.error('[perf] 写库失败', error);
  }
  res.writeHead(204).end();
}
