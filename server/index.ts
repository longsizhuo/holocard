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
 *   GET  /api/jobs/{id}        → {state, stage, position, layers?, error?}
 *   GET  /api/layers/{id}/...  产出的层文件与 manifest
 *   GET  其余路径               前端静态文件（HOLOCARD_WEB_DIR）
 *
 * 静态文件也由这个服务自己发，所以它是自包含的：上游只要一条反代就够，
 * 别人拿去单跑一个 Node 进程就是完整的站点。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { env } from '@huggingface/transformers';
import { segmentToLayerSet } from '../src/segmenter';
import { sharpImages, normalizeOriginal } from './images';
import { renderPreview, PREVIEW_HEIGHT, PREVIEW_WIDTH } from './preview';
import { recordHit, flushHits, sweepCards, expiresAt, importLegacy } from './cards';
import { CardDb, type CardRow } from './db';

const PORT = Number(process.env.HOLOCARD_PORT ?? 8791);
const OUT_DIR = process.env.HOLOCARD_OUT_DIR ?? '/srv/holocard-layers';
const MODEL_DIR = process.env.HOLOCARD_MODEL_DIR ?? '/srv/holocard-models';
/** 卡片数据库。默认放在产物目录的旁边，线上就是 /srv/holocard-data/holocard.db */
const DB_PATH =
  process.env.HOLOCARD_DB ?? join(dirname(resolve(OUT_DIR)), 'holocard-data', 'holocard.db');
/** 上传体积上限。手机直出的照片通常 3~8MB */
const MAX_UPLOAD = Number(process.env.HOLOCARD_MAX_UPLOAD ?? 16 * 1024 * 1024);
/** 同时处理几张。这台机器 4 核且已有其他负载，多了只会互相拖慢并吃满内存 */
const CONCURRENCY = Number(process.env.HOLOCARD_CONCURRENCY ?? 1);
/** 队列排到这么长就直接拒绝，让用户立刻知道，而不是排十分钟 */
const MAX_QUEUE = Number(process.env.HOLOCARD_MAX_QUEUE ?? 12);
/**
 * 保留策略。
 *
 * 没分享过的：从生成算起 7 天，到点就删——多半是试一下就走了。
 * 分享过的：从**最后一次被访问**算起，窗口长度随访问量翻倍地涨。
 *   访问 1 次   → 7 天      （第一次分享出去、有人点开，就再留 7 天）
 *   访问 2-3 次 → 14 天
 *   访问 4-7 次 → 28 天
 *   ……每翻一番加一档，封顶 112 天（7 × 2^4，KEEP_DOUBLINGS_CAP = 5 档）
 *
 * 「从最后一次访问算起」是关键：一直有人看的卡窗口不断续期，等于永久保留；
 * 彻底没人看了才开始倒计时。这样热门内容留得久、冷内容自然退场，
 * 磁盘占用有上界，不需要人工清理。
 */
const TTL_MS = Number(process.env.HOLOCARD_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);
/** 分享过的卡每翻一番访问量多留一档，最多翻几番 */
const KEEP_DOUBLINGS_CAP = 5;
/** 每个 IP 在窗口内最多提交几次，挡住把这里当图床刷的人 */
const RATE_LIMIT = Number(process.env.HOLOCARD_RATE_LIMIT ?? 10);
const RATE_WINDOW_MS = Number(process.env.HOLOCARD_RATE_WINDOW_MS ?? 10 * 60 * 1000);
/** 站点对外的地址，用来拼分享链接里的绝对 URL（OG 标签必须是绝对地址） */
const PUBLIC_ORIGIN = process.env.HOLOCARD_PUBLIC_ORIGIN ?? 'https://holocard.longsizhuo.com';
/**
 * 前端静态文件目录。留空则不发静态文件（开发时由 vite dev 发）。
 *
 * 由这个服务自己发而不是交给上游的 Caddy，有两个原因：
 * 一是那台机器的 Caddy 跑在容器里，加一个目录挂载要重建容器、会让同机的其他站点瞬断；
 * 二是自己能发才算自包含，别人拿去单跑一个 Node 进程就是完整的站点。
 */
const WEB_DIR = process.env.HOLOCARD_WEB_DIR ?? '';

// 权重随服务一起部署，不在运行时去 Hugging Face 拉——这台机器未必连得上，
// 而且首个用户不该为下载权重等着
env.localModelPath = MODEL_DIR;
env.allowRemoteModels = false;

/**
 * 所有卡片状态的唯一来源。以前是内存里的任务表 + 每个目录一份 meta.json，
 * 服务一重启进度就没了，也没法回答「最近传了什么、失败了几个」。
 */
const db = new CardDb(DB_PATH);

/** 简单的滑动窗口限流。单进程、内存态，够用；真被大规模刷再上 Cloudflare 的规则 */
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  // 顺手清掉早就过期的条目，别让这个 Map 无限长
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  return recent.length > RATE_LIMIT;
}

/**
 * 定长字符串比较。长度不同时先比一个等长的占位串，让耗时与输入无关，
 * 不给「试出口令有多长」留侧信道。
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** 取真实来源 IP。前面隔着 Cloudflare 和 Caddy，socket 地址永远是 127.0.0.1 */
function clientIp(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0]?.trim() ?? 'unknown';
  return req.socket.remoteAddress ?? 'unknown';
}

/** 正在渲染预览图的卡片，避免同一张重复排队 */
const previewJobs = new Set<string>();

/**
 * 待处理的卡片 id。原图已经在磁盘上，队列里不用再攥着字节——
 * 以前最多 12 张 × 16MB 堆在内存里，而且服务一重启（每次发版都会）排队的任务就全丢了。
 */
const queue: string[] = [];
let running = 0;

/** 原图在磁盘上的位置。扩展名由存盘时的格式决定 */
function originalFile(card: Pick<CardRow, 'id' | 'original_type'>): string | null {
  const ext =
    card.original_type === 'image/png'
      ? 'png'
      : card.original_type === 'image/webp'
        ? 'webp'
        : card.original_type === 'image/jpeg'
          ? 'jpg'
          : null;
  return ext ? join(OUT_DIR, card.id, `original.${ext}`) : null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** 读请求体，超过上限立刻断开，不把整个大文件读进内存 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`超过上限 ${Math.round(limit / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 认图片的魔数而不是信 Content-Type。
 * 前端是我们自己写的，但这个接口在公网上，谁都能 POST。
 */
function sniffImage(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  // AVIF / HEIC 都是 ISO-BMFF，ftyp 在第 4 字节起
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'image/avif';
  return null;
}

async function runJob(id: string): Promise<void> {
  const card = db.get(id);
  const file = card ? originalFile(card) : null;
  if (!card || !file) return;

  db.update(id, { status: 'running', stage: null });
  const dir = join(OUT_DIR, id);

  try {
    const bytes = await readFile(file);
    // 拷一份到独立的 ArrayBuffer：Node 的 Buffer 可能落在共享池上，Blob 不接受那种视图
    const set = await segmentToLayerSet(new Blob([new Uint8Array(bytes)]), {
      extract: { images: sharpImages },
      onProgress: (p) => db.update(id, { stage: p.stage }),
    });

    await Promise.all(
      set.manifest.layers.map(async (layer, i) => {
        const blob = set.images[i];
        if (!blob) return;
        await writeFile(join(dir, layer.file), Buffer.from(await blob.arrayBuffer()));
      }),
    );
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(set.manifest));

    db.update(id, {
      status: 'done',
      stage: 'done',
      error: null,
      layer_count: set.manifest.layers.length,
      result_url: `${PUBLIC_ORIGIN}/c/${id}`,
    });
  } catch (error) {
    db.update(id, {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    /*
     * 删掉半截产物，但**留着原图**：失败的那张图正是排查时最需要的东西。
     * 它和其他卡一样受保留期约束，7 天后随目录一起清掉。
     */
    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((name) => !name.startsWith('original.'))
        .map((name) => rm(join(dir, name), { force: true }).catch(() => undefined)),
    );
  }
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const id = queue.shift();
    if (!id) break;
    running++;
    void runJob(id).finally(() => {
      running--;
      pump();
    });
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.map': 'application/json; charset=utf-8',
};

/** HTML 属性转义。卡片 id 是我们自己生成的 UUID，但注入前仍然一律转义 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 给 /c/<id> 注入 OG / Twitter card 标签。
 *
 * 这是分享能不能扩散的关键：链接在微信、Twitter 里有没有大图预览，
 * 直接决定别人点不点。标签里的 URL 必须是绝对地址。
 *
 * previewVersion 是预览图文件的 mtime，null 表示还没渲染出来。
 * 带上它是因为预览图在 CDN 上按 immutable 缓存了 4 小时，
 * 改了渲染逻辑重新出图之后，不换 URL 的话抓取方和边缘都还拿着旧图。
 */
function injectShareMeta(html: string, id: string, previewVersion: number | null): string {
  const pageUrl = escapeAttr(`${PUBLIC_ORIGIN}/c/${id}`);
  const image = escapeAttr(`${PUBLIC_ORIGIN}/api/layers/${id}/preview.jpg?v=${previewVersion ?? 0}`);
  const title = 'HoloCard — 一张会发光的分层闪卡';
  const desc = '前中后景自动分层，每层各上各的箔面。上传你自己的照片试试。';

  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${pageUrl}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${desc}" />`,
    // 预览图还没渲染好时不给 og:image，免得抓取方缓存一个 404
    ...(previewVersion !== null
      ? [
          `<meta property="og:image" content="${image}" />`,
          `<meta property="og:image:width" content="${PREVIEW_WIDTH}" />`,
          `<meta property="og:image:height" content="${PREVIEW_HEIGHT}" />`,
          `<meta name="twitter:card" content="summary_large_image" />`,
          `<meta name="twitter:image" content="${image}" />`,
        ]
      : [`<meta name="twitter:card" content="summary" />`]),
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${desc}" />`,
    // 用户上传的内容，不进搜索引擎
    `<meta name="robots" content="noindex, nofollow" />`,
  ].join('\n    ');

  return html.replace('</head>', `  ${tags}\n  </head>`);
}

/**
 * 发前端静态文件。找不到就回 index.html，交给前端路由。
 *
 * HEAD 和 GET 走同一条路径，只是不写 body——健康检查、链接预览抓取工具、
 * 各种监控都会先发 HEAD，之前只认 GET，它们一律拿到 404。
 */
async function serveStatic(
  pathname: string,
  res: ServerResponse,
  method: string,
  ip: string,
): Promise<void> {
  // /c/<id> 要带上这张卡自己的 OG 标签
  const cardPath = /^\/c\/([0-9a-f-]{36})\/?$/.exec(pathname);
  if (!WEB_DIR) {
    json(res, 404, { error: 'not found' });
    return;
  }

  // 路径可能是畸形的百分号编码，decodeURIComponent 会抛；含 NUL 的路径直接拒绝
  let clean: string;
  try {
    clean = decodeURIComponent(pathname);
  } catch {
    json(res, 400, { error: '非法路径' });
    return;
  }
  if (clean.includes(String.fromCharCode(0))) {
    json(res, 400, { error: '非法路径' });
    return;
  }
  // 规范化之后必须仍在 WEB_DIR 之内，挡住 ../ 之类
  const target = resolve(WEB_DIR, '.' + (clean.endsWith('/') ? clean + 'index.html' : clean));
  const root = resolve(WEB_DIR);
  const safe = target === root || target.startsWith(root + sep);

  for (const candidate of safe ? [target, join(root, 'index.html')] : [join(root, 'index.html')]) {
    try {
      let body = await readFile(candidate);
      const ext = extname(candidate);
      const isHashed = candidate.includes(`${sep}assets${sep}`);

      if (cardPath?.[1] && ext === '.html') {
        const id = cardPath[1];
        const previewStat = await stat(join(OUT_DIR, id, 'preview.jpg')).catch(() => null);
        const previewVersion = previewStat ? Math.floor(previewStat.mtimeMs) : null;
        body = Buffer.from(injectShareMeta(body.toString('utf8'), id, previewVersion), 'utf8');

        /*
         * 一次页面访问给这张卡的保留窗口续期。
         *
         * 只在 GET 上计：HEAD 多半是抓取工具和监控，不是真的有人在看。
         * 计数在 cards.ts 里按 IP 做一小时去重，自己反复刷不会把保留期刷上去。
         * 这条路径不会被 CDN 挡掉——/c/<id> 的 cache-control 是 no-cache，每次都回源。
         */
        if (method === 'GET') recordHit(id, ip);
      }

      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': body.byteLength,
        // assets 下的文件名带内容 hash，可以永久缓存；其余不缓存，保证发版即时生效
        'cache-control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      if (method === 'HEAD') res.end();
      else res.end(body);
      return;
    } catch {
      // 试下一个候选
    }
  }
  json(res, 404, { error: 'not found' });
}

/** 定期清理过期产物 */
async function sweep(): Promise<void> {
  // 先把内存里攒的访问量落库，否则刚被看过的卡可能按旧的 last_hit_at 判成过期
  flushHits(db);
  const removed = await sweepCards(db, OUT_DIR, TTL_MS, KEEP_DOUBLINGS_CAP);
  if (removed > 0) console.log(`[sweep] 清理了 ${removed} 张过期卡片`);
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/health') {
      json(res, 200, { ok: true, running, queued: queue.length, concurrency: CONCURRENCY });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      if (rateLimited(clientIp(req))) {
        json(res, 429, {
          error: `提交太频繁了，${Math.round(RATE_WINDOW_MS / 60000)} 分钟内最多 ${RATE_LIMIT} 次`,
        });
        return;
      }
      if (queue.length >= MAX_QUEUE) {
        json(res, 503, { error: `排队的人太多（${queue.length} 个在等），稍后再试` });
        return;
      }

      let bytes: Buffer;
      try {
        bytes = await readBody(req, MAX_UPLOAD);
      } catch (error) {
        json(res, 413, { error: error instanceof Error ? error.message : '请求体过大' });
        return;
      }

      const kind = sniffImage(bytes);
      if (!kind) {
        json(res, 415, { error: '不是可识别的图片（支持 JPEG / PNG / WebP / AVIF）' });
        return;
      }

      // 先把原图规范化（摆正方向、去掉 EXIF）存下来，再入队。
      // 解不开的图在这里就挡掉，不用排到队里才失败
      let original;
      try {
        original = await normalizeOriginal(bytes);
      } catch (error) {
        json(res, 415, { error: error instanceof Error ? error.message : '无法识别的图片' });
        return;
      }

      const id = randomUUID();
      const now = Date.now();
      await mkdir(join(OUT_DIR, id), { recursive: true });
      await writeFile(join(OUT_DIR, id, `original.${original.ext}`), original.data);

      const card: CardRow = {
        id,
        status: 'queued',
        stage: null,
        error: null,
        created_at: now,
        updated_at: now,
        original_url: `${PUBLIC_ORIGIN}/api/layers/${id}/original.${original.ext}`,
        original_type: original.type,
        original_bytes: original.data.byteLength,
        source_width: original.width,
        source_height: original.height,
        result_url: null,
        layer_count: null,
        shared: 0,
        shared_at: null,
        hits: 0,
        last_hit_at: null,
        delete_token: randomUUID(),
      };
      db.insert(card);
      queue.push(id);
      pump();

      /*
       * 删除口令只在这里给一次。
       *
       * 不放在 GET /api/jobs/{id} 里：那个接口任何知道 id 的人都能打，
       * 而卡一旦分享出去，id 就是公开的——口令跟着泄漏，删除入口就等于没有。
       * 提交请求的响应只有上传者自己看得到。
       */
      json(res, 202, { id, position: queue.length, deleteToken: card.delete_token });
      return;
    }

    // 转永久保留，并在后台渲染一张 OG 预览图
    const shareMatch = /^\/api\/cards\/([0-9a-f-]{36})\/share$/.exec(url.pathname);
    if (req.method === 'POST' && shareMatch) {
      const id = shareMatch[1] ?? '';
      const dir = join(OUT_DIR, id);
      const card = db.get(id);
      if (!card || card.status !== 'done') {
        json(res, 404, { error: '这张卡不存在或已过期' });
        return;
      }
      const now = Date.now();
      // 分享动作本身按一次访问算，保留窗口从此刻起算
      db.update(id, {
        shared: 1,
        shared_at: card.shared_at ?? now,
        last_hit_at: now,
      });
      const updated = db.get(id) ?? card;

      json(res, 200, {
        url: `${PUBLIC_ORIGIN}/c/${id}`,
        expiresAt: expiresAt(updated, TTL_MS, KEEP_DOUBLINGS_CAP),
      });

      // 预览图慢（要起浏览器渲染），不让用户等；失败也不影响分享本身
      if (!previewJobs.has(id)) {
        previewJobs.add(id);
        void renderPreview(`http://127.0.0.1:${PORT}`, id)
          .then((buf) => writeFile(join(dir, 'preview.jpg'), buf))
          .catch((error) => console.error(`[preview] ${id} 渲染失败:`, error.message))
          .finally(() => previewJobs.delete(id));
      }
      return;
    }

    /*
     * 删除自己的卡。
     *
     * 口令是产出时随 202 响应给上传者的，只有他们手上有（前端存在 localStorage）。
     * 不做账号体系：这个站没有登录，一张卡的「所有者」就是「拿着口令的人」。
     * 比较用定长循环而不是 ===，避免把口令的正确前缀长度泄漏出去。
     */
    const deleteMatch = /^\/api\/cards\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === 'DELETE' && deleteMatch) {
      const id = deleteMatch[1] ?? '';
      const dir = join(OUT_DIR, id);
      const header = req.headers['x-holocard-token'];
      const token = typeof header === 'string' ? header : '';

      const card = db.get(id);
      if (!card || card.status === 'deleted' || card.status === 'expired') {
        json(res, 404, { error: '这张卡不存在或已过期' });
        return;
      }
      if (!timingSafeEqualStr(token, card.delete_token)) {
        json(res, 403, { error: '口令不对，只有生成这张卡的人能删除它' });
        return;
      }

      // 还在排队的也能删：从队列里拿掉，免得删完又被处理出来
      const queued = queue.indexOf(id);
      if (queued >= 0) queue.splice(queued, 1);

      // 文件（含原图）全删；数据库那一行留着，只改状态，统计时还能数到
      await rm(dir, { recursive: true, force: true });
      db.update(id, { status: 'deleted', stage: null });
      console.log(`[delete] ${id} 已被创建者删除`);
      json(res, 200, { deleted: true });
      return;
    }

    /*
     * 层文件。本来想交给 Caddy 直接发静态文件，但那样开发环境（没有 Caddy）就跑不通，
     * 而且服务自己能发才算自包含——别人拿去单跑一个 Node 进程就够了。
     * 路径两段都严格匹配，不给目录穿越留口子。
     */
    const fileMatch = /^\/api\/layers\/([0-9a-f-]{36})\/(manifest\.json|layer-\d{1,2}\.png|preview\.jpg|original\.(?:jpg|png|webp))$/.exec(
      url.pathname,
    );
    if ((req.method === 'GET' || req.method === 'HEAD') && fileMatch) {
      const [, id, name] = fileMatch;
      try {
        const body = await readFile(join(OUT_DIR, id ?? '', name ?? ''));
        res.writeHead(200, {
          'content-type': name?.endsWith('.png')
            ? 'image/png'
            : name?.endsWith('.jpg')
              ? 'image/jpeg'
              : name?.endsWith('.webp')
                ? 'image/webp'
                : 'application/json; charset=utf-8',
          'content-length': body.byteLength,
          /*
           * 层图和预览图按 id 是真的不变，可以 immutable。
           * manifest.json 不是：里面的视差、箔面这些参数是会被改的
           * （修过一次分层判据之后，存量卡片的视差就地打过补丁）。
           * 标成 immutable 的话边缘会攥着旧参数不放，改了也不生效。
           */
          'cache-control':
            name === 'manifest.json'
              ? 'public, max-age=60'
              : 'public, max-age=3600, immutable',
        });
        if (req.method === 'HEAD') res.end();
        else res.end(body);
      } catch {
        json(res, 404, { error: '层文件不存在或已过期' });
      }
      return;
    }

    const jobMatch = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      !jobMatch &&
      !url.pathname.startsWith('/api/')
    ) {
      await serveStatic(url.pathname, res, req.method, clientIp(req));
      return;
    }

    if (req.method === 'GET' && jobMatch) {
      const card = db.get(jobMatch[1] ?? '');
      // 删掉的、过期的对前端来说都是「没有了」，不暴露内部状态
      if (!card || card.status === 'deleted' || card.status === 'expired') {
        json(res, 404, { error: '任务不存在或已过期' });
        return;
      }
      // 对外仍然叫 state，前端不用改
      json(res, 200, {
        state: card.status,
        stage: card.stage,
        position: card.status === 'queued' ? queue.indexOf(card.id) + 1 : 0,
        ...(card.status === 'done'
          ? { layers: `/api/layers/${card.id}`, layerCount: card.layer_count }
          : {}),
        ...(card.error ? { error: card.error } : {}),
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  })();
});

await mkdir(OUT_DIR, { recursive: true });

// 数据库之前的存量卡（每个目录一份 meta.json）导进来，删除口令原样保留
const imported = await importLegacy(db, OUT_DIR, PUBLIC_ORIGIN);
if (imported > 0) console.log(`[db] 从旧格式导入了 ${imported} 张卡`);

/*
 * 上次退出时还没处理完的任务：原图在磁盘上的就接着排队，
 * 发版重启不再把正在排队的人的图弄丢。原图都没有的只能标失败。
 */
{
  let resumed = 0;
  let abandoned = 0;
  /*
   * 两批必须先一次性取出来再处理。边查边改的话，running 的那张被改回 queued 之后，
   * 下一轮查 queued 又会把它取出来一次——同一张卡入队两次、被处理两遍（实测踩到过）。
   * running 排在前面：它是更早提交的，续跑时应该先轮到它。
   */
  const unfinished = [...db.byStatus('running'), ...db.byStatus('queued')];
  for (const card of unfinished) {
    const file = originalFile(card);
    if (file && (await stat(file).catch(() => null))) {
      db.update(card.id, { status: 'queued', stage: null });
      queue.push(card.id);
      resumed++;
    } else {
      db.update(card.id, { status: 'error', error: '服务重启，原图丢失' });
      abandoned++;
    }
  }
  if (resumed + abandoned > 0) {
    console.log(`[db] 续跑 ${resumed} 个中断的任务，${abandoned} 个无法恢复`);
  }
  pump();
}

setInterval(() => void sweep(), 15 * 60 * 1000).unref();
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`holocard 分层服务已启动 127.0.0.1:${PORT}`);
  console.log(`  产物目录 ${OUT_DIR}`);
  console.log(`  模型目录 ${MODEL_DIR}`);
  console.log(`  数据库   ${DB_PATH}`);
  console.log(`  静态目录 ${WEB_DIR || '(未配置，由前端开发服务器负责)'}`);
  const days = Math.round(TTL_MS / 86400000);
  console.log(`  并发 ${CONCURRENCY}，队列上限 ${MAX_QUEUE}`);
  console.log(
    `  保留：未分享 ${days} 天；分享过的从最后一次访问起 ${days} 天，` +
      `访问量每翻一番延一档，最长 ${days * Math.pow(2, KEEP_DOUBLINGS_CAP - 1)} 天`,
  );
});
