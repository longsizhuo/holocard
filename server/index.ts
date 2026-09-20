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
import { randomUUID } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { env } from '@huggingface/transformers';
import { segmentToLayerSet, type SegmentStage } from '../src/segmenter';
import { sharpImages } from './images';
import { renderPreview, PREVIEW_HEIGHT, PREVIEW_WIDTH } from './preview';

const PORT = Number(process.env.HOLOCARD_PORT ?? 8791);
const OUT_DIR = process.env.HOLOCARD_OUT_DIR ?? '/srv/holocard-layers';
const MODEL_DIR = process.env.HOLOCARD_MODEL_DIR ?? '/srv/holocard-models';
/** 上传体积上限。手机直出的照片通常 3~8MB */
const MAX_UPLOAD = Number(process.env.HOLOCARD_MAX_UPLOAD ?? 16 * 1024 * 1024);
/** 同时处理几张。这台机器 4 核且已有其他负载，多了只会互相拖慢并吃满内存 */
const CONCURRENCY = Number(process.env.HOLOCARD_CONCURRENCY ?? 1);
/** 队列排到这么长就直接拒绝，让用户立刻知道，而不是排十分钟 */
const MAX_QUEUE = Number(process.env.HOLOCARD_MAX_QUEUE ?? 12);
/** 没被分享的产物保留多久（毫秒）。分享过的永久保留 */
const TTL_MS = Number(process.env.HOLOCARD_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);
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

type JobState = 'queued' | 'running' | 'done' | 'error';

interface Job {
  id: string;
  state: JobState;
  stage: SegmentStage | null;
  createdAt: number;
  error?: string;
  layerCount?: number;
}

/** 分享过的卡片在目录里放一个空标记文件，清理时据此跳过 */
const SHARED_MARKER = '.shared';

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

const jobs = new Map<string, Job>();
const queue: Array<{ job: Job; bytes: Buffer }> = [];
let running = 0;

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

async function runJob(job: Job, bytes: Buffer): Promise<void> {
  job.state = 'running';
  const dir = join(OUT_DIR, job.id);

  try {
    // 拷一份到独立的 ArrayBuffer：Node 的 Buffer 可能落在共享池上，Blob 不接受那种视图
    const set = await segmentToLayerSet(new Blob([new Uint8Array(bytes)]), {
      extract: { images: sharpImages },
      onProgress: (p) => {
        job.stage = p.stage;
      },
    });

    await mkdir(dir, { recursive: true });
    await Promise.all(
      set.manifest.layers.map(async (layer, i) => {
        const blob = set.images[i];
        if (!blob) return;
        await writeFile(join(dir, layer.file), Buffer.from(await blob.arrayBuffer()));
      }),
    );
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(set.manifest));

    job.layerCount = set.manifest.layers.length;
    job.state = 'done';
    job.stage = 'done';
  } catch (error) {
    job.state = 'error';
    job.error = error instanceof Error ? error.message : String(error);
    // 失败时别把半截产物留在磁盘上
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    running++;
    void runJob(next.job, next.bytes).finally(() => {
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
 */
function injectShareMeta(html: string, id: string, hasPreview: boolean): string {
  const pageUrl = escapeAttr(`${PUBLIC_ORIGIN}/c/${id}`);
  const image = escapeAttr(`${PUBLIC_ORIGIN}/api/layers/${id}/preview.jpg`);
  const title = 'HoloCard — 一张会发光的分层闪卡';
  const desc = '前中后景自动分层，每层各上各的箔面。上传你自己的照片试试。';

  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${pageUrl}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${desc}" />`,
    // 预览图还没渲染好时不给 og:image，免得抓取方缓存一个 404
    ...(hasPreview
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

/** 发前端静态文件。找不到就回 index.html，交给前端路由 */
async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
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
        const hasPreview = Boolean(await stat(join(OUT_DIR, id, 'preview.jpg')).catch(() => null));
        body = Buffer.from(injectShareMeta(body.toString('utf8'), id, hasPreview), 'utf8');
      }

      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': body.byteLength,
        // assets 下的文件名带内容 hash，可以永久缓存；其余不缓存，保证发版即时生效
        'cache-control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
      return;
    } catch {
      // 试下一个候选
    }
  }
  json(res, 404, { error: 'not found' });
}

/** 定期清理过期产物和任务记录 */
async function sweep(): Promise<void> {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > TTL_MS) jobs.delete(id);
  }
  try {
    for (const name of await readdir(OUT_DIR)) {
      const path = join(OUT_DIR, name);
      const info = await stat(path).catch(() => null);
      if (!info || now - info.mtimeMs <= TTL_MS) continue;
      // 分享过的永久保留
      if (await stat(join(path, SHARED_MARKER)).catch(() => null)) continue;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    // 目录还不存在，忽略
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/health') {
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

      const job: Job = {
        id: randomUUID(),
        state: 'queued',
        stage: null,
        createdAt: Date.now(),
      };
      jobs.set(job.id, job);
      queue.push({ job, bytes });
      pump();

      json(res, 202, { id: job.id, position: queue.length });
      return;
    }

    // 转永久保留，并在后台渲染一张 OG 预览图
    const shareMatch = /^\/api\/cards\/([0-9a-f-]{36})\/share$/.exec(url.pathname);
    if (req.method === 'POST' && shareMatch) {
      const id = shareMatch[1] ?? '';
      const dir = join(OUT_DIR, id);
      if (!(await stat(join(dir, 'manifest.json')).catch(() => null))) {
        json(res, 404, { error: '这张卡不存在或已过期' });
        return;
      }
      await writeFile(join(dir, SHARED_MARKER), '');
      json(res, 200, { url: `${PUBLIC_ORIGIN}/c/${id}` });

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
     * 层文件。本来想交给 Caddy 直接发静态文件，但那样开发环境（没有 Caddy）就跑不通，
     * 而且服务自己能发才算自包含——别人拿去单跑一个 Node 进程就够了。
     * 路径两段都严格匹配，不给目录穿越留口子。
     */
    const fileMatch = /^\/api\/layers\/([0-9a-f-]{36})\/(manifest\.json|layer-\d{1,2}\.png|preview\.jpg)$/.exec(
      url.pathname,
    );
    if (req.method === 'GET' && fileMatch) {
      const [, id, name] = fileMatch;
      try {
        const body = await readFile(join(OUT_DIR, id ?? '', name ?? ''));
        res.writeHead(200, {
          'content-type': name?.endsWith('.png')
            ? 'image/png'
            : name?.endsWith('.jpg')
              ? 'image/jpeg'
              : 'application/json; charset=utf-8',
          'content-length': body.byteLength,
          // id 是一次性的 UUID，内容永不改变
          'cache-control': 'public, max-age=3600, immutable',
        });
        res.end(body);
      } catch {
        json(res, 404, { error: '层文件不存在或已过期' });
      }
      return;
    }

    const jobMatch = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && !jobMatch && !url.pathname.startsWith('/api/')) {
      await serveStatic(url.pathname, res);
      return;
    }

    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1] ?? '');
      if (!job) {
        json(res, 404, { error: '任务不存在或已过期' });
        return;
      }
      json(res, 200, {
        state: job.state,
        stage: job.stage,
        position: job.state === 'queued' ? queue.findIndex((q) => q.job.id === job.id) + 1 : 0,
        ...(job.state === 'done' ? { layers: `/api/layers/${job.id}`, layerCount: job.layerCount } : {}),
        ...(job.error ? { error: job.error } : {}),
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  })();
});

await mkdir(OUT_DIR, { recursive: true });
setInterval(() => void sweep(), 15 * 60 * 1000).unref();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`holocard 分层服务已启动 127.0.0.1:${PORT}`);
  console.log(`  产物目录 ${OUT_DIR}`);
  console.log(`  模型目录 ${MODEL_DIR}`);
  console.log(`  静态目录 ${WEB_DIR || '(未配置，由前端开发服务器负责)'}`);
  console.log(`  并发 ${CONCURRENCY}，队列上限 ${MAX_QUEUE}，产物保留 ${Math.round(TTL_MS / 3600000)} 小时`);
});
