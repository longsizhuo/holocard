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
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { env } from '@huggingface/transformers';
import { segmentToLayerSet } from '../src/segmenter';
import { sharpImages, normalizeOriginal, layerToWebp, makeThumb, ImageError } from './images';
import {
  LANG_TAG,
  LANGS,
  isLang,
  langFromAcceptLanguage,
  langFromCookie,
  localizeHtml,
  translate,
  type Lang,
} from '../src/i18n/core';
import { renderPreview, PREVIEW_HEIGHT, PREVIEW_WIDTH } from './preview';
import { recordHit, flushHits, sweepCards, expiresAt, importLegacy } from './cards';
import { CardDb, type CardRow } from './db';
import {
  EXPORT_FILE,
  EXPORT_FORMATS,
  exportFiles,
  exportReady,
  runExport,
  type ExportFormat,
} from './export';

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

/**
 * 导出动图：同时排队的上限，和每个 IP 在限流窗口内最多导出几次。
 * 一次导出要十几到几十秒的 CPU（无头浏览器软件渲染 + 视频编码），比分层还重。
 */
const MAX_EXPORT_QUEUE = Number(process.env.HOLOCARD_MAX_EXPORT_QUEUE ?? 6);
const EXPORT_RATE_LIMIT = Number(process.env.HOLOCARD_EXPORT_RATE_LIMIT ?? 8);

/** 简单的滑动窗口限流。单进程、内存态，够用；真被大规模刷再上 Cloudflare 的规则 */
function makeLimiter(limit: number, windowMs: number): (ip: string) => boolean {
  const hits = new Map<string, number[]>();
  return (ip) => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(ip, recent);
    // 顺手清掉早就过期的条目，别让这个 Map 无限长
    if (hits.size > 5000) {
      for (const [key, times] of hits) {
        if (times.every((t) => now - t >= windowMs)) hits.delete(key);
      }
    }
    return recent.length > limit;
  };
}

/** 上传分层的限流 */
const rateLimited = makeLimiter(RATE_LIMIT, RATE_WINDOW_MS);
/** 导出动图的限流，和上传分开计数 */
const exportLimited = makeLimiter(EXPORT_RATE_LIMIT, RATE_WINDOW_MS);

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

/*
 * 分享图（OG 预览图）的渲染队列，一次只渲染一张，失败了过一会儿重试。
 *
 * 以前是分享那一下在后台直接渲染、失败就算了。上线头一天的高峰期，渲染和分层挤在一起，
 * 截图超时 18 次，分享过的 32 张卡里有 23 张一直没有分享图——链接发到微信里没有大图。
 * 现在除了排队重试，卡片页被打开时发现缺图也会补，服务启动时把分享过却缺图的都补上。
 *
 * 每种语言一张：分享链接带着分享人的语言，分享图右边那段字也是那个语言。
 */
interface PreviewJob {
  id: string;
  lang: Lang;
  attempts: number;
}
const previewQueue: PreviewJob[] = [];
let previewing: PreviewJob | null = null;
const PREVIEW_ATTEMPTS = 3;

function previewFile(lang: Lang): string {
  return lang === 'zh' ? 'preview.jpg' : `preview-${lang}.jpg`;
}

function queuePreview(id: string, lang: Lang): void {
  const same = (job: PreviewJob): boolean => job.id === id && job.lang === lang;
  if ((previewing && same(previewing)) || previewQueue.some(same)) return;
  previewQueue.push({ id, lang, attempts: 0 });
  pumpPreviews();
}

function pumpPreviews(): void {
  if (previewing) return;
  const job = previewQueue.shift();
  if (!job) return;
  // 排着的时候被删了、过期了，就不用渲染了
  if (db.get(job.id)?.status !== 'done') {
    pumpPreviews();
    return;
  }
  previewing = job;
  void renderPreview(`http://127.0.0.1:${PORT}`, job.id, { lang: job.lang })
    .then((buf) => writeFile(join(OUT_DIR, job.id, previewFile(job.lang)), buf))
    .catch((error: unknown) => {
      job.attempts++;
      const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
      console.error(`[preview] ${job.id} ${job.lang} 渲染失败（第 ${job.attempts} 次）: ${message}`);
      // 失败多半是那一刻机器太忙，过一会儿再排到队尾
      if (job.attempts < PREVIEW_ATTEMPTS) {
        setTimeout(() => {
          previewQueue.push(job);
          pumpPreviews();
        }, 30_000 * job.attempts).unref();
      }
    })
    .finally(() => {
      previewing = null;
      pumpPreviews();
    });
}

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

/**
 * 出错响应。code 是稳定的错误类型，前端按它翻译成当前语言（src/i18n/messages.ts 里的 error.*）；
 * error 是中文原文，给日志、给没升级的旧页面看。
 */
function fail(
  res: ServerResponse,
  status: number,
  code: string,
  error: string,
  params?: Record<string, string | number>,
): void {
  json(res, status, { error, code, ...(params ? { params } : {}) });
}

/**
 * 这次请求用哪种语言：地址上的 ?lang= → 接口请求头 x-holocard-lang（前端已经定好的语言）
 * → cookie → Accept-Language → 中文。和前端 src/i18n 的规则一致，
 * 页面一出来就是对的语言，不会先闪一下中文再变。
 */
function requestLang(req: IncomingMessage, url: URL): Lang {
  const fromUrl = url.searchParams.get('lang');
  if (isLang(fromUrl)) return fromUrl;
  const fromHeader = req.headers['x-holocard-lang'];
  if (isLang(fromHeader)) return fromHeader;
  return (
    langFromCookie(req.headers.cookie) ?? langFromAcceptLanguage(req.headers['accept-language']) ?? 'zh'
  );
}

function text(res: ServerResponse, type: string, body: string, method: string): void {
  res.writeHead(200, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    // 给爬虫的文件，一小时够了；改了之后不至于太久才生效
    'cache-control': 'public, max-age=3600',
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
}

/**
 * robots.txt。欢迎所有爬虫，包括 AI 的——站点就是想被找到、被引用。
 * 只挡两类：服务端截分享图用的内部页面，和接口。
 * /api/layers/ 故意不挡：分享图在那下面，挡了 Twitter 取不到图；
 * 用户的图不进搜索结果靠的是那边的 x-robots-tag: noindex 响应头。
 */
function robotsTxt(): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /render/',
    'Disallow: /api/jobs',
    'Disallow: /api/cards',
    // 模型权重给浏览器端退回处理用，27MB，爬虫抓了没意义
    'Disallow: /models/',
    '',
    `Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`,
    '',
  ].join('\n');
}

/**
 * sitemap.xml。只有首页的三个语言版本：用户的卡片页是 noindex 的，不该出现在这里。
 * 每一条都列出所有语言版本（xhtml:link），搜索引擎据此把它们认成同一页的不同语言。
 * lastmod 取 index.html 的修改时间，也就是最近一次发版。
 */
async function sitemapXml(): Promise<string> {
  const index = WEB_DIR ? await stat(join(WEB_DIR, 'index.html')).catch(() => null) : null;
  const lastmod = index ? new Date(index.mtimeMs).toISOString().slice(0, 10) : null;
  const url = (lang: Lang): string => `${PUBLIC_ORIGIN}/${lang === 'zh' ? '' : `?lang=${lang}`}`;
  const alternates = [
    ...LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${LANG_TAG[l]}" href="${url(l)}" />`),
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${PUBLIC_ORIGIN}/" />`,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...LANGS.flatMap((lang) => [
      '  <url>',
      `    <loc>${url(lang)}</loc>`,
      ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
      ...alternates,
      '  </url>',
    ]),
    '</urlset>',
    '',
  ].join('\n');
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

    // 流水线出的是 PNG，存盘前转成 WebP（画面有损、alpha 无损），体积只剩一成左右，见 layerToWebp
    await Promise.all(
      set.manifest.layers.map(async (layer, i) => {
        const blob = set.images[i];
        if (!blob) return;
        const webp = await layerToWebp(Buffer.from(await blob.arrayBuffer()));
        layer.file = layer.file.replace(/\.png$/, '.webp');
        await writeFile(join(dir, layer.file), webp);
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

/*
 * 导出动图的队列，和分层队列分开：一次只做一张。
 * 状态不进数据库——导出好的文件就在卡片目录里，有没有、新不新看文件本身（exportReady），
 * 服务重启丢的只是排队中的请求，前端轮询拿到 none 会提示重试。
 */
interface ExportJob {
  id: string;
  format: ExportFormat;
}
const exportQueue: ExportJob[] = [];
let exporting: ExportJob | null = null;
/** 失败原因留一会儿，给轮询的人看；过了这段时间再点就是重新生成 */
const exportErrors = new Map<string, { error: string; at: number }>();
const EXPORT_ERROR_TTL_MS = 10 * 60 * 1000;

const exportKey = (job: ExportJob): string => `${job.id}:${job.format}`;

function pumpExports(): void {
  if (exporting) return;
  const job = exportQueue.shift();
  if (!job) return;
  exporting = job;
  const started = Date.now();
  void runExport(`http://127.0.0.1:${PORT}`, job.id, join(OUT_DIR, job.id), job.format)
    .then(() => {
      exportErrors.delete(exportKey(job));
      console.log(`[export] ${job.id} ${job.format} 用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      exportErrors.set(exportKey(job), { error: message, at: Date.now() });
      console.error(`[export] ${job.id} ${job.format} 失败:`, message);
    })
    .finally(() => {
      exporting = null;
      pumpExports();
    });
}

type ExportStatus =
  | { state: 'none' }
  | { state: 'queued'; position: number }
  | { state: 'running' }
  | { state: 'error'; error: string }
  | { state: 'done'; files: Array<{ url: string; name: string; type: string }> };

/** 某张卡某种格式的导出现在到哪一步了 */
async function exportStatus(job: ExportJob): Promise<ExportStatus> {
  const version = await exportReady(join(OUT_DIR, job.id), job.format, job.id);
  if (version !== null) {
    return {
      state: 'done',
      // 地址带文件时间当版本号：卡片参数改过、重新生成之后，CDN 上的旧文件不会被拿到
      files: exportFiles(job.format, job.id).map((f) => ({
        url: `/api/layers/${job.id}/${f.file}?v=${version}`,
        name: f.download,
        type: f.type,
      })),
    };
  }
  if (exporting && exportKey(exporting) === exportKey(job)) return { state: 'running' };
  const index = exportQueue.findIndex((j) => exportKey(j) === exportKey(job));
  if (index >= 0) return { state: 'queued', position: index + 1 };
  const failed = exportErrors.get(exportKey(job));
  if (failed && Date.now() - failed.at < EXPORT_ERROR_TTL_MS) return { state: 'error', error: failed.error };
  return { state: 'none' };
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
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * 前端路由。这些路径落不到文件上，由 index.html 接手，状态码 200。
 *
 * 其他落不到文件的路径同样回 index.html——人打错地址还能看到站点——但状态码是 404。
 * 以前一律回 200，/abc、/wp-admin 在搜索引擎眼里全是和首页一模一样的页面（软 404），
 * 重复内容多了会拉低整站的评价。
 */
const SPA_ROUTES = [
  /^\/$/,
  /^\/index\.html$/,
  /^\/c\/[0-9a-f-]{36}\/?$/,
  /^\/render\/[0-9a-f-]{36}\/?$/,
];

/**
 * 卡片目录里对外发的文件：清单、层图（新卡是 WebP，老卡是 PNG）、各语言的分享图、原图。
 * 导出的动图另见 export.ts 的 EXPORT_FILE
 */
const LAYER_FILE =
  /^(?:manifest\.json|layer-\d{1,2}\.(?:png|webp)|preview(?:-(?:en|ja))?\.jpg|thumb\.jpg|original\.(?:jpg|png|webp))$/;

/** HTML 属性转义。卡片 id 是我们自己生成的 UUID，但注入前仍然一律转义 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 各语言版本的地址：中文就是本来的地址，别的语言带 ?lang= */
function langUrl(path: string, lang: Lang): string {
  return `${PUBLIC_ORIGIN}${path}${lang === 'zh' ? '' : `?lang=${lang}`}`;
}

const OG_LOCALE: Record<Lang, string> = { zh: 'zh_CN', en: 'en_US', ja: 'ja_JP' };

/** OG 和 Twitter card 标签，首页和分享页共用 */
function socialTags(o: {
  url: string;
  title: string;
  description: string;
  image: string | null;
  lang: Lang;
}): string[] {
  return [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escapeAttr(o.url)}" />`,
    `<meta property="og:title" content="${escapeAttr(o.title)}" />`,
    `<meta property="og:description" content="${escapeAttr(o.description)}" />`,
    `<meta property="og:locale" content="${OG_LOCALE[o.lang]}" />`,
    ...LANGS.filter((l) => l !== o.lang).map(
      (l) => `<meta property="og:locale:alternate" content="${OG_LOCALE[l]}" />`,
    ),
    // 预览图还没渲染好时不给 og:image，免得抓取方缓存一个 404
    ...(o.image
      ? [
          `<meta property="og:image" content="${escapeAttr(o.image)}" />`,
          `<meta property="og:image:width" content="${PREVIEW_WIDTH}" />`,
          `<meta property="og:image:height" content="${PREVIEW_HEIGHT}" />`,
          `<meta name="twitter:card" content="summary_large_image" />`,
          `<meta name="twitter:image" content="${escapeAttr(o.image)}" />`,
        ]
      : [`<meta name="twitter:card" content="summary" />`]),
    `<meta name="twitter:title" content="${escapeAttr(o.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(o.description)}" />`,
  ];
}

/**
 * 给 /c/<id> 注入 OG / Twitter card 标签。
 *
 * 这是分享能不能扩散的关键：链接在微信、Twitter 里有没有大图预览，
 * 直接决定别人点不点。标签里的 URL 必须是绝对地址。
 *
 * 标题、描述按分享链接上的语言出（分享人的语言）。分享图优先用同一语言的那张；
 * 那张还没渲染出来时先用中文那张顶上——有图总比没图强，卡片本身才是主角。
 * 图的地址带文件 mtime 当版本号：预览图在 CDN 上按 immutable 缓存，
 * 重新出图之后不换 URL 的话抓取方和边缘都还拿着旧图。
 */
function injectShareMeta(
  html: string,
  id: string,
  lang: Lang,
  preview: { lang: Lang; version: number } | null,
): string {
  const image = preview
    ? `${PUBLIC_ORIGIN}/api/layers/${id}/${previewFile(preview.lang)}?v=${preview.version}`
    : null;
  const tags = [
    ...socialTags({
      url: langUrl(`/c/${id}`, lang),
      title: translate(lang, 'share.ogTitle'),
      description: translate(lang, 'share.ogDescription'),
      image,
      lang,
    }),
    // 用户上传的内容，不进搜索引擎
    `<meta name="robots" content="noindex, nofollow" />`,
  ].join('\n    ');

  return html.replace('</head>', `  ${tags}\n  </head>`);
}

/**
 * 给首页注入 OG / Twitter card 标签、规范地址和各语言版本的地址。
 *
 * 分享图是 public/og.jpg（英文、日文是 og-en.jpg、og-ja.jpg）——用 `pnpm og` 从一张挑好的卡
 * 渲染出来的静态文件，不直接引用某张用户卡：用户的卡会过期、会被删，首页的门面不能跟着没了。
 * 某个语言的图还没做出来时用中文那张。
 *
 * 放在服务端注入而不是写死在 index.html 里，是为了拿 PUBLIC_ORIGIN 拼绝对地址——
 * 别人自托管时地址自然就对。
 */
function injectHomeMeta(html: string, lang: Lang, image: { file: string; version: number } | null): string {
  const tags = [
    ...socialTags({
      url: langUrl('/', lang),
      title: translate(lang, 'home.ogTitle'),
      description: translate(lang, 'home.ogDescription'),
      image: image ? `${PUBLIC_ORIGIN}/${image.file}?v=${image.version}` : null,
      lang,
    }),
    // 每种语言一个规范地址；带别的参数（?utm=…、?pose=…）的都算同一页
    `<link rel="canonical" href="${escapeAttr(langUrl('/', lang))}" />`,
    // 各语言版本在哪；x-default 是不带参数、按浏览器语言自动选的那个入口
    ...LANGS.map(
      (l) => `<link rel="alternate" hreflang="${LANG_TAG[l]}" href="${escapeAttr(langUrl('/', l))}" />`,
    ),
    `<link rel="alternate" hreflang="x-default" href="${escapeAttr(`${PUBLIC_ORIGIN}/`)}" />`,
    `<script type="application/ld+json">${structuredData(html, lang)}</script>`,
  ].join('\n    ');

  return html.replace('</head>', `  ${tags}\n  </head>`);
}

/**
 * 首页的结构化数据（JSON-LD）。
 *
 * 搜索引擎和 AI 靠它确认「这是个免费、开源的网页工具，谁做的，源码在哪」，
 * 不用从一堆按钮文字里猜。描述直接取页面上（已经换成当前语言的）meta description，
 * 不在这里另写一份——改页面描述时这里自动跟着变。
 */
function structuredData(html: string, lang: Lang): string {
  const description =
    /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
  const repo = 'https://github.com/longsizhuo/holocard';
  const license = 'https://www.gnu.org/licenses/gpl-3.0.html';
  const author = { '@type': 'Person', name: 'longsizhuo', url: 'https://github.com/longsizhuo' };

  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        '@id': `${PUBLIC_ORIGIN}/#app`,
        name: 'HoloCard',
        url: langUrl('/', lang),
        description,
        image: `${PUBLIC_ORIGIN}/og.jpg`,
        inLanguage: LANG_TAG[lang],
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Any',
        browserRequirements: 'Requires JavaScript',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY' },
        license,
        author,
        sameAs: [repo],
      },
      {
        '@type': 'SoftwareSourceCode',
        name: 'HoloCard',
        codeRepository: repo,
        programmingLanguage: 'TypeScript',
        license,
        author,
        targetProduct: { '@id': `${PUBLIC_ORIGIN}/#app` },
      },
    ],
  };
  // 放进 <script> 里，「</script>」这类序列得转义掉，否则会提前结束标签
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** 某个文件的 mtime（毫秒取整），不存在返回 null。拿来当 URL 上的版本号 */
async function fileVersion(path: string): Promise<number | null> {
  const s = await stat(path).catch(() => null);
  return s ? Math.floor(s.mtimeMs) : null;
}

/**
 * 发前端静态文件。找不到就回 index.html，交给前端路由。
 *
 * HEAD 和 GET 走同一条路径，只是不写 body——健康检查、链接预览抓取工具、
 * 各种监控都会先发 HEAD，之前只认 GET，它们一律拿到 404。
 *
 * 页面按这次请求的语言发（见 requestLang）：静态文字、标题、分享标签都换成那个语言，
 * 页面一出来就是对的，不用等脚本跑完再变。
 */
async function serveStatic(
  pathname: string,
  res: ServerResponse,
  method: string,
  ip: string,
  lang: Lang,
): Promise<void> {
  // /c/<id> 要带上这张卡自己的 OG 标签
  const cardPath = /^\/c\/([0-9a-f-]{36})\/?$/.exec(pathname);
  const isHome = pathname === '/' || pathname === '/index.html';
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

  // 先找真实文件；落不到文件的回 index.html，不是前端路由的话状态码给 404
  let candidate = target;
  let status = 200;
  if (!safe || !(await stat(target).then((s) => s.isFile()).catch(() => false))) {
    candidate = join(root, 'index.html');
    if (!SPA_ROUTES.some((route) => route.test(pathname))) status = 404;
  }

  let body: Buffer;
  try {
    body = await readFile(candidate);
  } catch {
    // index.html 都读不到，只能是部署出了问题
    json(res, 404, { error: 'not found' });
    return;
  }
  const ext = extname(candidate);
  const isHashed = candidate.includes(`${sep}assets${sep}`);
  /*
   * 首页示例卡（samples/ 下）每个访客都要下两百多 KB。按 no-cache 发的话，
   * Cloudflare 每次都判过期、整个回源重拉（实测 EXPIRED，出图慢两三秒）。
   * 这些文件不跟着发版变——要换示例卡就换个目录名，旧地址自然没人引用——所以缓存一天没问题。
   *
   * 首页分享图 og*.jpg 同理：抓取方（GitHub 的图片代理、各家的链接预览）从 Cloudflare 回源拉图，
   * 源站那一段慢，拉不完就超时。页面里引用时带 ?v=修改时间，换图会换地址，缓存一天也不会拿到旧图。
   */
  const isStable =
    candidate.startsWith(join(root, 'samples') + sep) ||
    (dirname(candidate) === root && /^og(?:-[a-z]{2})?\.jpg$/.test(basename(candidate)));
  const isHtml = ext === '.html';
  if (isHtml) body = Buffer.from(localizeHtml(body.toString('utf8'), lang), 'utf8');

  // 404 只是个兜底页：不注入分享标签、不计访问
  if (status === 200 && cardPath?.[1] && isHtml) {
    const id = cardPath[1];
    const dir = join(OUT_DIR, id);
    const own = await fileVersion(join(dir, previewFile(lang)));
    const fallback = own === null && lang !== 'zh' ? await fileVersion(join(dir, previewFile('zh'))) : null;
    const preview =
      own !== null ? { lang, version: own } : fallback !== null ? { lang: 'zh' as Lang, version: fallback } : null;
    body = Buffer.from(injectShareMeta(body.toString('utf8'), id, lang, preview), 'utf8');

    // 这个语言的分享图还没有（渲染失败过、或者是新语言），趁有人打开时补一张
    if (own === null && db.get(id)?.status === 'done') queuePreview(id, lang);

    /*
     * 一次页面访问给这张卡的保留窗口续期。
     *
     * 只在 GET 上计：HEAD 多半是抓取工具和监控，不是真的有人在看。
     * 计数在 cards.ts 里按 IP 做一小时去重，自己反复刷不会把保留期刷上去。
     * 这条路径不会被 CDN 挡掉——/c/<id> 的 cache-control 是 no-cache，每次都回源。
     */
    if (method === 'GET') recordHit(id, ip);
  } else if (status === 200 && isHome && isHtml) {
    const langImage = lang === 'zh' ? null : `og-${lang}.jpg`;
    const langVersion = langImage ? await fileVersion(join(root, langImage)) : null;
    const zhVersion = langVersion === null ? await fileVersion(join(root, 'og.jpg')) : null;
    const image =
      langImage && langVersion !== null
        ? { file: langImage, version: langVersion }
        : zhVersion !== null
          ? { file: 'og.jpg', version: zhVersion }
          : null;
    body = Buffer.from(injectHomeMeta(body.toString('utf8'), lang, image), 'utf8');
  }

  res.writeHead(status, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': body.byteLength,
    // assets 下的文件名带内容 hash，可以永久缓存；示例卡和首页分享图缓存一天（见上）；其余不缓存，保证发版即时生效
    'cache-control': isHashed
      ? 'public, max-age=31536000, immutable'
      : isStable
        ? 'public, max-age=86400'
        : 'no-cache',
    'x-content-type-options': 'nosniff',
    // 同一个地址按语言发不同的页面，任何中间缓存都得把这两个头算进缓存键
    ...(isHtml ? { vary: 'Accept-Language, Cookie', 'content-language': LANG_TAG[lang] } : {}),
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
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
      json(res, 200, {
        ok: true,
        running,
        queued: queue.length,
        concurrency: CONCURRENCY,
        exporting: exporting ? 1 : 0,
        exportQueued: exportQueue.length,
      });
      return;
    }

    // 这两个要写完整域名，所以按 PUBLIC_ORIGIN 现生成，不放静态文件——别人自托管时地址自然就对
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/robots.txt') {
      text(res, 'text/plain; charset=utf-8', robotsTxt(), req.method);
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/sitemap.xml') {
      text(res, 'application/xml; charset=utf-8', await sitemapXml(), req.method);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      if (rateLimited(clientIp(req))) {
        const minutes = Math.round(RATE_WINDOW_MS / 60000);
        fail(res, 429, 'rate_limited', `提交太频繁了，${minutes} 分钟内最多 ${RATE_LIMIT} 次`, {
          minutes,
          limit: RATE_LIMIT,
        });
        return;
      }
      if (queue.length >= MAX_QUEUE) {
        fail(res, 503, 'queue_full', `排队的人太多（${queue.length} 个在等），稍后再试`, {
          queued: queue.length,
        });
        return;
      }

      const limitMb = Math.round(MAX_UPLOAD / 1024 / 1024);
      let bytes: Buffer;
      try {
        bytes = await readBody(req, MAX_UPLOAD);
      } catch {
        fail(res, 413, 'too_large', `图片超过 ${limitMb}MB 上限`, { limitMb });
        return;
      }

      const kind = sniffImage(bytes);
      if (!kind) {
        fail(res, 415, 'unsupported_image', '不是可识别的图片（支持 JPEG / PNG / WebP / AVIF / HEIC）');
        return;
      }

      // 先把原图规范化（摆正方向、去掉 EXIF）存下来，再入队。
      // 解不开的图在这里就挡掉，不用排到队里才失败
      let original;
      try {
        original = await normalizeOriginal(bytes);
      } catch (error) {
        if (error instanceof ImageError) fail(res, 415, error.code, error.message, error.params);
        else fail(res, 415, 'unsupported_image', error instanceof Error ? error.message : '无法识别的图片');
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
        fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
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

      // 预览图慢（要起浏览器渲染），不让用户等；排队渲染分享人那个语言的，失败也不影响分享本身
      const lang = requestLang(req, url);
      if (!(await stat(join(dir, previewFile(lang))).catch(() => null))) queuePreview(id, lang);
      return;
    }

    /*
     * 导出动图（格式由前端按设备决定，见 src/demo/export.ts）。
     *   POST  没有现成的就排队生成，返回当前状态
     *   GET   只查状态，给前端轮询
     * 生成好的文件就放在卡片目录里，和卡片同生共死：过期、被删时一起清掉。
     */
    const exportMatch = /^\/api\/cards\/([0-9a-f-]{36})\/export\/(gif|motion|apng)$/.exec(url.pathname);
    if ((req.method === 'POST' || req.method === 'GET') && exportMatch) {
      const job: ExportJob = { id: exportMatch[1] ?? '', format: (exportMatch[2] ?? 'apng') as ExportFormat };
      const card = db.get(job.id);
      if (!card || card.status !== 'done') {
        fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
        return;
      }
      const current = await exportStatus(job);
      if (req.method === 'GET' || (current.state !== 'none' && current.state !== 'error')) {
        json(res, 200, current);
        return;
      }

      if (exportLimited(clientIp(req))) {
        fail(res, 429, 'export_rate_limited', '导出太频繁了，过几分钟再试');
        return;
      }
      if (exportQueue.length >= MAX_EXPORT_QUEUE) {
        fail(res, 503, 'export_busy', '现在导出的人太多，稍后再试');
        return;
      }
      exportErrors.delete(exportKey(job));
      exportQueue.push(job);
      pumpExports();
      json(res, 202, await exportStatus(job));
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
        fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
        return;
      }
      if (!timingSafeEqualStr(token, card.delete_token)) {
        fail(res, 403, 'wrong_token', '口令不对，只有生成这张卡的人能删除它');
        return;
      }

      // 还在排队的也能删：从队列里拿掉，免得删完又被处理出来。排着的导出同理
      const queued = queue.indexOf(id);
      if (queued >= 0) queue.splice(queued, 1);
      for (let i = exportQueue.length - 1; i >= 0; i--) {
        if (exportQueue[i]?.id === id) exportQueue.splice(i, 1);
      }

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
    const fileMatch = /^\/api\/layers\/([0-9a-f-]{36})\/([\w.-]+)$/.exec(url.pathname);
    const fileName = fileMatch?.[2] ?? '';
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      fileMatch &&
      (LAYER_FILE.test(fileName) || EXPORT_FILE.test(fileName))
    ) {
      const [, id, name] = fileMatch;
      // 卡册缩略图第一次有人要的时候现做（见 makeThumb）。卡已经过期、被删的，原图也没了，照常落到下面的 404
      if (name === 'thumb.jpg') {
        const target = join(OUT_DIR, id ?? '', name);
        const card = db.get(id ?? '');
        const source = card?.status === 'done' ? originalFile(card) : null;
        if (source && !(await stat(target).catch(() => null))) {
          await makeThumb(source, target).catch((error: unknown) => {
            console.warn(`[thumb] ${id} 生成失败：`, error instanceof Error ? error.message : error);
          });
        }
      }
      // 导出的动图按下载处理，文件名用给用户看的那个（HoloCard_xxxx.jpg 之类）
      const exported = EXPORT_FORMATS
        .flatMap((format) => exportFiles(format, id ?? ''))
        .find((f) => f.file === name);
      try {
        const body = await readFile(join(OUT_DIR, id ?? '', name ?? ''));
        res.writeHead(200, {
          'content-type': name?.endsWith('.png')
            ? 'image/png'
            : name?.endsWith('.jpg')
              ? 'image/jpeg'
              : name?.endsWith('.webp')
                ? 'image/webp'
                : name?.endsWith('.gif')
                  ? 'image/gif'
                  : 'application/json; charset=utf-8',
          ...(exported ? { 'content-disposition': `attachment; filename="${exported.download}"` } : {}),
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
          /*
           * 用户的照片不进搜索结果（包括图片搜索）。
           * 用响应头而不是在 robots.txt 里挡：分享图也在这个路径下，Twitter 的爬虫遵守 robots.txt，
           * 挡了的话分享卡片就取不到图了。noindex 只管「别收录」，不影响抓取。
           */
          'x-robots-tag': 'noindex',
        });
        if (req.method === 'HEAD') res.end();
        else res.end(body);
      } catch {
        json(res, 404, { error: '层文件不存在或已过期' });
      }
      return;
    }

    /*
     * 深度模型的权重，给浏览器端退回处理用（见 src/segmenter/runtime.ts 的 useOwnModelHost）。
     * 国内连不上 huggingface.co，本站能打开，权重就能下。只发服务端自己在用的那三个文件。
     * 27MB 的文件用流发，不整个读进内存。
     */
    const modelMatch =
      /^\/models\/(onnx-community\/depth-anything-v2-small\/(?:config\.json|preprocessor_config\.json|onnx\/model_quantized\.onnx))$/.exec(
        url.pathname,
      );
    if ((req.method === 'GET' || req.method === 'HEAD') && modelMatch) {
      const file = join(MODEL_DIR, modelMatch[1] ?? '');
      const info = await stat(file).catch(() => null);
      if (!info) {
        json(res, 404, { error: 'not found' });
        return;
      }
      res.writeHead(200, {
        'content-type': file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream',
        'content-length': info.size,
        // 同一个版本的权重不会变；换模型时路径里的文件名也会跟着变
        'cache-control': 'public, max-age=604800',
        'access-control-allow-origin': '*',
      });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file).pipe(res);
      return;
    }

    const jobMatch = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      !jobMatch &&
      !url.pathname.startsWith('/api/')
    ) {
      await serveStatic(url.pathname, res, req.method, clientIp(req), requestLang(req, url));
      return;
    }

    if (req.method === 'GET' && jobMatch) {
      const card = db.get(jobMatch[1] ?? '');
      // 删掉的、过期的对前端来说都是「没有了」，不暴露内部状态
      if (!card || card.status === 'deleted' || card.status === 'expired') {
        fail(res, 404, 'job_not_found', '任务不存在或已过期');
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

/*
 * 分享过、却没有分享图的卡补渲染一遍（中文那张；别的语言有人打开时再补）。
 * 以前渲染失败就算了，上线头一天 32 张分享过的卡里有 23 张没图。
 * 排在队列里一张张来，不耽误启动；要等服务开始监听之后再调——渲染页是从本服务取的。
 */
async function backfillPreviews(): Promise<void> {
  let missing = 0;
  for (const card of db.byStatus('done')) {
    if (!card.shared) continue;
    if (await stat(join(OUT_DIR, card.id, previewFile('zh'))).catch(() => null)) continue;
    queuePreview(card.id, 'zh');
    missing++;
  }
  if (missing > 0) console.log(`[preview] ${missing} 张分享过的卡缺分享图，排队补渲染`);
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
  void backfillPreviews();
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
