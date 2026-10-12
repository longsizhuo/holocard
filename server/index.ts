/**
 * HoloCard 分层服务
 *
 * 用户上传照片 → 服务端跑完整条分层流水线 → 产出一组 .layers → 前端只负责渲染。
 * 这样浏览器端一个字节的模型都不用下（之前是 52MB），首次使用从「等二十秒下载」变成「等几秒处理」。
 *
 * 跑的是和浏览器端**同一份**流水线代码（src/segmenter），只把图片解码/编码换成 sharp，
 * 见 src/segmenter/image-io.ts 的后端抽象。
 *
 * 接口是「提交 + 轮询」而不是一个长请求：处理要几秒到几十秒，
 * 长连接容易被中间的 Caddy / Cloudflare 掐断，排队时更是如此。
 *   POST /api/jobs             请求体是图片字节 → 202 {id}
 *   GET  /api/jobs/{id}        → {state, stage, position, eta?, layers?, error?}
 *   GET  /api/layers/{id}/...  产出的层文件与 manifest
 *   POST /api/perf             性能埋点，一次页面访问最多一条（见 routes/service.ts）
 *   GET  其余路径               前端静态文件（HOLOCARD_WEB_DIR）
 *
 * 静态文件也由这个服务自己发，所以它是自包含的：上游只要一条反代就够，
 * 别人拿去单跑一个 Node 进程就是完整的站点。
 */

import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  CONCURRENCY,
  DB_PATH,
  KEEP_DOUBLINGS_CAP,
  MATTE_MODEL,
  MATTE_READY,
  MATTE_WEIGHTS,
  MAX_QUEUE,
  MEMORY_CAP,
  MODEL_DIR,
  OUT_DIR,
  PORT,
  PUBLIC_ORIGIN,
  TTL_MS,
  WEB_DIR,
} from './config';
import { json } from './http';
import { CPU_SHARE, backfillNsfw, resumeUnfinished, startSegmenter } from './pipeline/jobs';
import { backfillPreviews } from './render/previews';
import { handleAuth, handleMe } from './routes/account';
import { handleCards } from './routes/cards';
import { handleCardmask } from './routes/cardmask';
import { sweepCardmasks } from './pipeline/cardmask';
import { handleHealth, handlePerf } from './routes/service';
import { handleSite } from './routes/static';
import { handleV1 } from './routes/v1';
import { db } from './store';
import { flushHits, importLegacy, sweepCards } from './store/cards';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

const under = (prefix: string) => (path: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * 路径 → 处理函数，从上往下第一个对得上的接手，各自再分方法和子路径。
 * 最后一条是网站本身（GET 的都当前端页面发），所以 /v1、/auth 这些不在 /api 下的接口要排在它前面
 */
const ROUTES: [match: (path: string) => boolean, handle: Handler][] = [
  [under('/v1'), handleV1],
  [(path) => path.startsWith('/auth/'), handleAuth],
  [under('/api/me'), handleMe],
  [(path) => path === '/api/health', handleHealth],
  [(path) => path === '/api/perf', handlePerf],
  [under('/api/cardmask'), handleCardmask],
  // 分层任务、层文件、卡片的分享 / 配置 / 删除 / 导出
  [
    (path) => path.startsWith('/api/'),
    async (req, res, url) => {
      if (!(await handleCards(req, res, url))) json(res, 404, { error: 'not found' });
    },
  ],
  [() => true, handleSite],
];

/** 清理过期卡。定时器和启动时各调一次，外面没有兜底，失败只记日志 */
function sweepSafely(): void {
  void sweep().catch((error: unknown) => console.error('[sweep] 清理失败', error));
}

async function sweep(): Promise<void> {
  // 先把内存里攒的访问量落库，否则刚被看过的卡可能按旧的 last_hit_at 判成过期
  flushHits(db);
  const removed = await sweepCards(db, OUT_DIR, TTL_MS, KEEP_DOUBLINGS_CAP);
  if (removed > 0) console.log(`[sweep] 清理了 ${removed} 张过期卡片`);
  const masks = await sweepCardmasks();
  if (masks > 0) console.log(`[sweep] 清理了 ${masks} 组过期的卡面遮罩`);
  try {
    db.prunePerf(90, 200_000);
    db.pruneSessions(Date.now());
  } catch (error) {
    console.error('[sweep] 清理埋点、过期会话失败', error);
  }
}

const server = createServer((req, res) => {
  void (async () => {
    /*
     * 畸形的请求行（比如 GET //[ ）会让 URL 解析抛错。以前这里没接，一个请求就能让整个进程退出、
     * 正在处理的卡全被打断；直连源站时 Caddy 会把它原样转过来
     */
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      json(res, 400, { error: '非法请求' });
      return;
    }

    const [, handle] = ROUTES.find(([match]) => match(url.pathname)) ?? [];
    await handle?.(req, res, url);
  })().catch((error: unknown) => {
    // 兜底：哪个路由漏接了异常，回 500（或者断开），不让未处理的拒绝把整个服务带崩
    console.error('[http] 未处理的异常', req.method, req.url, error);
    if (!res.headersSent) json(res, 500, { error: '服务出错了', code: 'internal_error' });
    else res.destroy();
  });
});

await mkdir(OUT_DIR, { recursive: true });

// 数据库之前的存量卡（每个目录一份 meta.json）导进来，删除口令原样保留
const imported = await importLegacy(db, OUT_DIR, PUBLIC_ORIGIN);
if (imported > 0) console.log(`[db] 从旧格式导入了 ${imported} 张卡`);

await resumeUnfinished();

setInterval(sweepSafely, 15 * 60 * 1000).unref();
// 访问量在内存里累计，一分钟合并写一次库。丢几条只影响保留时长，不影响正确性
setInterval(() => flushHits(db), 60 * 1000).unref();

// 发版重启很频繁，退出前把攒着的访问量落库，别每次都丢掉一分钟的计数
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    flushHits(db);
    db.close();
    process.exit(0);
  });
}

startSegmenter();

server.listen(PORT, '127.0.0.1', () => {
  // 启动先清一次：定时清理每 15 分钟一次、每次重启从头计时，发版频繁时可能一直轮不到，
  // 对外接口的卡承诺了 24 小时清掉
  sweepSafely();
  void backfillPreviews();
  // 外面没有兜底的 catch，漏出来的拒绝会让进程退出
  void backfillNsfw().catch((error: unknown) => console.error('[nsfw] 补打分中断', error));
  console.log(`holocard 分层服务已启动 127.0.0.1:${PORT}`);
  console.log(`  产物目录 ${OUT_DIR}`);
  const matteNote = MATTE_READY
    ? `（抠主体用 ${MATTE_MODEL.id}，${MATTE_MODEL.size}，${MATTE_MODEL.dtype}）`
    : MATTE_WEIGHTS
      ? `（内存上限 ${(MEMORY_CAP / 2 ** 30).toFixed(1)}G 不够抠主体，只按深度切层）`
      : '（没有抠图权重，只按深度切层）';
  console.log(`  模型目录 ${MODEL_DIR}${matteNote}`);
  console.log(`  数据库   ${DB_PATH}`);
  console.log(`  静态目录 ${WEB_DIR || '(未配置，由前端开发服务器负责)'}`);
  const days = Math.round(TTL_MS / 86400000);
  console.log(`  并发 ${CONCURRENCY}，队列上限 ${MAX_QUEUE}，推理线程 ${CPU_SHARE}`);
  console.log(
    `  保留：未分享 ${days} 天；分享过的从最后一次访问起 ${days} 天，` +
      `访问量每翻一番延一档，最长 ${days * Math.pow(2, KEEP_DOUBLINGS_CAP - 1)} 天`,
  );
});
