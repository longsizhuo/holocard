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
 *   POST /api/perf             性能埋点，一次页面访问最多一条（见 perf.ts）
 *   GET  其余路径               前端静态文件（HOLOCARD_WEB_DIR）
 *
 * 静态文件也由这个服务自己发，所以它是自包含的：上游只要一条反代就够，
 * 别人拿去单跑一个 Node 进程就是完整的站点。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { mkdir, rename, rm, writeFile, readFile, readdir, stat, statfs } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { env } from '@huggingface/transformers';
import { Worker } from 'node:worker_threads';
import type { LayerManifest } from '../src/format/types';
import { applyConfig, parseConfig } from '../src/format/config';
import { MATTE_MODEL_ID, matteWeightsFile, type MatteModelConfig } from '../src/segmenter/matte';
import { normalizeOriginal, layerToWebp, makeThumb, ImageError } from './images';
import type { SegmentReply, SegmentRequest, SegmenterConfig } from './segment-worker';
import { enterStage, finishJob, queuedEta, runningEta, startJob } from './eta';
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
import { CardDb, type ApiKeyRow, type CardRow, type CardSource, type SessionRow } from './db';
import { bearerKey, hashApiKey, newApiKey } from './apikeys';
import {
  SECRET_PATTERN,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  STATE_COOKIE,
  STATE_TTL_S,
  cookie,
  decodeState,
  encodeState,
  exchangeCode,
  newSecret,
  parseCookies,
  pkceChallenge,
  safeNext,
  sha256Hex,
  type IhUser,
} from './auth';
import { parsePerf } from './perf';
import { apiTracker } from './umami';
import { detectNudity } from './moderation';
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
/** 队列排到这么长就直接拒绝，让用户立刻知道，而不是排十分钟。只数网页的，对外接口另算（MAX_API_QUEUE） */
const MAX_QUEUE = Number(process.env.HOLOCARD_MAX_QUEUE ?? 12);
/**
 * 对外接口（/v1）在队列里最多同时有几张。网页任务总是插在接口任务前面（见 enqueue），
 * 再加这个上限，接口怎么刷都挤不掉网页用户
 */
const MAX_API_QUEUE = Number(process.env.HOLOCARD_MAX_API_QUEUE ?? 6);
/** 一个 key 同时最多几张在排队或处理中 */
const API_KEY_IN_FLIGHT = 3;
/**
 * 所有 key 加起来每 24 小时最多几张。单机一张半分钟到一分钟，一天安全能做一千出头，
 * 网页实际只用掉百分之一左右；这个上限保证接口最多占两成
 */
const API_DAILY_LIMIT = Number(process.env.HOLOCARD_API_DAILY_LIMIT ?? 500);
/** 登录用户在个人中心自己申请的 key，每个账号 24 小时最多几张。要更多的找站长用 scripts/apikey.mjs 发 */
const SELF_SERVE_DAILY_LIMIT = Number(process.env.HOLOCARD_SELF_SERVE_DAILY_LIMIT ?? 20);
/**
 * 产物目录所在的盘剩下不到这么多就不收上传。和 Postgres 等别的服务共用根分区，
 * 有人持续上传把盘写满，挂的不只是这个服务
 */
const MIN_FREE_BYTES = Number(process.env.HOLOCARD_MIN_FREE_GB ?? 5) * 1024 ** 3;
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
 * 用 IH 账号登录（见 auth.ts）。secret 是 IH 后端给 holocard 这个 client 发的，没配就不开登录。
 * 换码直连同机的 IH 后端，不走公网
 */
const SSO_SECRET = process.env.HOLOCARD_SSO_SECRET ?? '';
/** 在 IH 登记的 client。staging 单独一个（holocard-staging），secret 和回跳地址都和线上分开 */
const SSO_CLIENT_ID = process.env.HOLOCARD_SSO_CLIENT_ID ?? 'holocard';
const SSO_AUTHORIZE_URL = process.env.HOLOCARD_SSO_AUTHORIZE_URL ?? 'https://involutionhell.com/sso/authorize';
const SSO_TOKEN_URL = process.env.HOLOCARD_SSO_TOKEN_URL ?? 'http://127.0.0.1:8080/internal/sso/token';
/**
 * 假登录：/auth/login 直接登进一个测试账号，不经过 IH。只给 staging 用：要能在手机上试登录后的界面，
 * 而 staging 的 IH client 密钥得由站长配（见 deploy/README.md「登录」）。staging 的地址上没配密钥时自动打开，
 * 别处要显式设 HOLOCARD_AUTH_FAKE=1（本地开发）。正式站开着它谁都能登进同一个账号，所以正式地址下拒绝启动
 */
const AUTH_FAKE =
  process.env.HOLOCARD_AUTH_FAKE === '1' ||
  (PUBLIC_ORIGIN === 'https://holocard.staging.longsizhuo.com' && SSO_SECRET === '');
if (AUTH_FAKE && PUBLIC_ORIGIN === 'https://holocard.longsizhuo.com') {
  throw new Error('HOLOCARD_AUTH_FAKE 只能在 staging 用，正式站不能开');
}
const LOGIN_ENABLED = AUTH_FAKE || SSO_SECRET !== '';
/** 对外接口的活动记进 umami（见 umami.ts） */
const trackApi = apiTracker(PUBLIC_ORIGIN);
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
 * 抠主体的权重（BiRefNet_lite，214MB，下载见 deploy/README.md）。
 * 没放就不抠，照旧只按深度切层：开发机、没下权重的环境照样能跑。
 *
 * 还要看这个进程的内存上限（systemd 的 MemoryMax）。抠一张峰值约 7GB，上限不够的话一抠就被 cgroup 杀掉，
 * 重启后续跑同一张又被杀，整个服务反复崩。权重在共享目录里、代码随 PR 自动上 staging、unit 文件要另外装，
 * 三样不是同一步到位的，所以在这里自己挡住：上限不够就当没有权重。
 */
const MATTE_MIN_MEMORY = 8 * 2 ** 30;
/**
 * 抠图模型，默认 lite。换型号、做盲评对比时用环境变量指定，不用改代码（流程见 scripts/blind/README.md）：
 *   HOLOCARD_MATTE_MODEL  模型名，比如 onnx-community/BiRefNet_512x512-ONNX
 *   HOLOCARD_MATTE_SIZE   输入边长，要和这份 ONNX 导出时的尺寸一致
 *   HOLOCARD_MATTE_DTYPE  fp32 / fp16 / q8
 */
const MATTE_MODEL: MatteModelConfig = {
  id: process.env.HOLOCARD_MATTE_MODEL ?? MATTE_MODEL_ID,
  size: Number(process.env.HOLOCARD_MATTE_SIZE ?? 1024),
  dtype: (process.env.HOLOCARD_MATTE_DTYPE ?? 'fp32') as MatteModelConfig['dtype'],
};
const MATTE_WEIGHTS = existsSync(join(MODEL_DIR, matteWeightsFile(MATTE_MODEL)));
// 没有限制时是 0（或者一个天文数字）
const MEMORY_CAP = process.constrainedMemory();
const MATTE_READY = MATTE_WEIGHTS && (MEMORY_CAP === 0 || MEMORY_CAP >= MATTE_MIN_MEMORY);

/**
 * 启动时还是 running 的卡：上个进程正在处理它的时候没了。可能是发版重启，也可能就是它把进程弄崩的，
 * 分不清，一律不抠主体续跑——少一个主体层，总比整个服务每半分钟崩一次强。
 * ponytail: SIGTERM 时把正在跑的卡改回 queued 就能区分两种情况，发版重启恰好撞上的概率低，先不做
 */
const crashedJobs = new Set<string>();

/**
 * 分层在工作线程里做（为什么见 segment-worker.ts），线程常驻、一次一张。
 * 一次一张也顺带保证了同一时刻最多抠一张：两次推理叠在一起就是 14GB
 */
let segmenter: Worker | null = null;
let segmentTail: Promise<unknown> = Promise.resolve();
/**
 * 最近一次起的分层线程还没报「就绪」就退出了：它要用的模块加载失败（依赖缺了、chunks/ 少文件、
 * 原生模块在线程里起不来）。健康检查据此报 503，发版脚本才拦得住——这类错误只在线程里才会暴露，
 * 不然要等第一个人上传时才发现
 */
let segmenterBroken = false;

/**
 * 这个服务分到几个核：systemd 的 CPUQuota 写在自己 cgroup 的 cpu.max 里，「200000 100000」就是 2 核。
 * onnxruntime 默认按机器的物理核数开推理线程，多开的线程只会互相抢额度，见 src/segmenter/runtime.ts 的 setCpuThreads。
 * 没有限额（开发机、cpu.max 是 max）或者读不到时，就按机器的核数
 */
function cpuShare(): number {
  try {
    const group = /^0::(.*)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1] ?? '';
    const [quota, period] = readFileSync(`/sys/fs/cgroup${group}/cpu.max`, 'utf8').trim().split(' ');
    if (quota && period && quota !== 'max') return Math.max(1, Math.floor(Number(quota) / Number(period)));
  } catch {
    // 不是 cgroup v2，或者读不到
  }
  return availableParallelism();
}
const CPU_SHARE = cpuShare();

function spawnSegmenter(): Worker {
  const config: SegmenterConfig = { modelDir: MODEL_DIR, matte: MATTE_READY, threads: CPU_SHARE, matteModel: MATTE_MODEL };
  const worker = new Worker(new URL('./segment-worker.mjs', import.meta.url), { workerData: config });
  let ready = false;
  worker.on('message', (reply: SegmentReply) => {
    if (reply.type !== 'ready') return;
    ready = true;
    segmenterBroken = false;
  });
  /*
   * 线程里未捕获的异常会在 Worker 对象上发 error 事件，没人接的话直接在主线程抛出，整个服务就崩了。
   * 接住它只记日志：随后必然还有一个 exit，当时正在做的那张在各自的 onExit 里判失败
   */
  worker.on('error', (error) => console.error('[segment] 分层线程出错', error));
  // 空闲时死掉的线程也要清掉，不然下一张发过去永远等不到回复，后面整个队列卡死
  worker.once('exit', () => {
    if (segmenter === worker) segmenter = null;
    if (!ready) segmenterBroken = true;
  });
  return worker;
}

function segmentInWorker(
  bytes: Uint8Array<ArrayBuffer>,
  matte: boolean,
  onStage: (stage: string) => void,
): Promise<{ manifest: LayerManifest; images: Uint8Array[] }> {
  const run = segmentTail.then(
    () =>
      new Promise<{ manifest: LayerManifest; images: Uint8Array[] }>((resolve, reject) => {
        // 和本文件打包在同一个目录里，见 vite.server.config.ts
        const worker = (segmenter ??= spawnSegmenter());
        const finish = (): void => {
          worker.off('message', onMessage);
          worker.off('exit', onExit);
        };
        const onMessage = (reply: SegmentReply): void => {
          if (reply.type === 'ready') return;
          if (reply.type === 'stage') {
            onStage(reply.stage);
            return;
          }
          finish();
          if (reply.type === 'done') resolve({ manifest: reply.manifest, images: reply.images });
          else reject(new Error(reply.message));
        };
        // 线程自己崩了（未捕获的异常）：这张算失败，下一张重新起一个
        const onExit = (code: number): void => {
          finish();
          segmenter = null;
          reject(new Error(`分层线程意外退出（${code}）`));
        };
        worker.on('message', onMessage);
        worker.on('exit', onExit);
        const request: SegmentRequest = { bytes, matte };
        worker.postMessage(request, [bytes.buffer as ArrayBuffer]);
      }),
  );
  segmentTail = run.catch(() => null);
  return run;
}

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

/**
 * 限流按什么记。IPv6 按 /64 记：一个用户手上通常是一整段 /64，逐个地址记的话每个请求换个地址就绕过去了。
 * IPv4（含 ::ffff:1.2.3.4 这种映射写法）照旧按地址
 */
function limitKey(ip: string): string {
  if (!ip.includes(':') || ip.includes('.')) return ip;
  const [head = '', tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = tail === undefined ? h : [...h, ...new Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${full.slice(0, 4).join(':')}::/64`;
}

/** 简单的滑动窗口限流。单进程、内存态，够用；真被大规模刷再上 Cloudflare 的规则 */
function makeLimiter(limit: number, windowMs: number): (ip: string) => boolean {
  const hits = new Map<string, number[]>();
  let sweptAt = 0;
  return (ip) => {
    const key = limitKey(ip);
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    // 已经超限的不再记账：不然一个 IP 狂刷时数组越来越长，被挡掉的请求也越来越费 CPU
    if (recent.length >= limit) {
      hits.set(key, recent);
      return true;
    }
    recent.push(now);
    hits.set(key, recent);
    // 过期条目每个窗口清一次。以前是超过 5000 条就每个请求全表扫一遍，被刷时正好最慢
    if (now - sweptAt >= windowMs) {
      sweptAt = now;
      for (const [k, times] of hits) {
        if (times.every((t) => now - t >= windowMs)) hits.delete(k);
      }
    }
    return false;
  };
}

/** 上传分层的限流 */
const rateLimited = makeLimiter(RATE_LIMIT, RATE_WINDOW_MS);
/** 导出动图的限流，和上传分开计数 */
const exportLimited = makeLimiter(EXPORT_RATE_LIMIT, RATE_WINDOW_MS);
/** 性能埋点的限流：正常一次页面访问一条，这个数只挡刷的 */
const perfLimited = makeLimiter(30, RATE_WINDOW_MS);
/**
 * 对外接口按 key 数提交次数（不管成没成）。额度只数成功插库的卡，
 * 一直发解不开的图（魔数对、内容坏）就能白耗规范化的 CPU 而不扣额度，这个兜住
 */
const apiAttemptLimited = makeLimiter(30, RATE_WINDOW_MS);
/**
 * 性能埋点的总量上限，不分来源。换着地址刷能绕过按 IP 的限流，而表只留最新 20 万行，
 * 灌满的话真实数据全被挤掉。正常流量离这个数远得很
 */
const perfFlooded = makeLimiter(120, 60 * 1000);

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

/** 带着有效会话 cookie 的，是哪个账号 */
function sessionOf(req: IncomingMessage): SessionRow | null {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return token && SECRET_PATTERN.test(token) ? db.session(sha256Hex(token), Date.now()) : null;
}

/**
 * 认会话来改东西的请求，只收本站页面发的。
 * holocard-staging、invite 这些兄弟子域和这里同站（same-site），它们发来的请求照样带着会话 cookie，
 * SameSite=Lax 拦不住；浏览器给每个请求标的 Sec-Fetch-Site 能分出来
 */
function sameOrigin(req: IncomingMessage): boolean {
  return req.headers['sec-fetch-site'] === 'same-origin';
}

/**
 * 是不是这张卡的主人：手上有口令的人；卡归到账号下以后，是登录着这个账号、从本站页面发请求的人。
 * 归到账号下的卡口令已经换掉、不给任何人，所以那时只剩会话这一条路
 */
function owns(req: IncomingMessage, card: CardRow): boolean {
  const header = req.headers['x-holocard-token'];
  if (typeof header === 'string' && header !== '' && timingSafeEqualStr(header, card.delete_token)) return true;
  return card.user_id !== null && sameOrigin(req) && sessionOf(req)?.user_id === card.user_id;
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
  const manifest = join(OUT_DIR, job.id, 'manifest.json');
  const manifestTime = async (): Promise<number> => (await stat(manifest).catch(() => null))?.mtimeMs ?? 0;
  void manifestTime()
    .then(async (before) => {
      const buf = await renderPreview(`http://127.0.0.1:${PORT}`, job.id, { lang: job.lang });
      // 渲染途中主人存了新配置：这张是旧样子，不能落盘（预览图只在「没有」时才补，落了就一直是旧的）。
      // 存配置时那次重排被「同一张正在渲染」去重吞掉了，所以在这里重排，不算失败次数
      if ((await manifestTime()) !== before) {
        console.log(`[preview] ${job.id} ${job.lang} 渲染途中配置变了，丢掉重渲`);
        previewQueue.push(job);
        return;
      }
      await writeFile(join(OUT_DIR, job.id, previewFile(job.lang)), buf);
    })
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
/** 队列里哪些是对外接口的任务。网页任务插到它们前面，满不满也分开数 */
const apiJobs = new Set<string>();
let running = 0;

/**
 * 入队。网页任务插在第一个接口任务前面：接口排在后面，网页用户最多多等正在跑的那一张。
 * 不抢占正在跑的，那张做到一半扔掉太浪费
 */
function enqueue(id: string, source: CardSource): void {
  if (source === 'api') {
    apiJobs.add(id);
    queue.push(id);
    return;
  }
  const at = queue.findIndex((queued) => apiJobs.has(queued));
  if (at < 0) queue.push(id);
  else queue.splice(at, 0, id);
}

/** 从队列里拿掉（删卡时） */
function dequeue(id: string): void {
  const at = queue.indexOf(id);
  if (at >= 0) queue.splice(at, 1);
  apiJobs.delete(id);
}

/*
 * 卡册缩略图（图怎么做见 images.ts 的 makeThumb）。
 * 新卡在分层完成时顺手做好；早期的卡（没存原图的，线上有一百多张）第一次有人要时再做。
 * 这是公开接口，所以同一张卡同时来多个请求只做一次，所有卡排成一队、一次只做一张，
 * 不让一堆首次请求同时把这台小机器的 CPU 吃满。每张卡做完就存盘，至多做一次，排队的总量有上界。
 */
const thumbJobs = new Map<string, Promise<void>>();
let thumbChain: Promise<void> = Promise.resolve();

function ensureThumb(id: string): Promise<void> {
  const pending = thumbJobs.get(id);
  if (pending) return pending;
  const job = thumbChain
    .then(async () => {
      const target = join(OUT_DIR, id, 'thumb.jpg');
      if (await stat(target).catch(() => null)) return;
      const card = db.get(id);
      if (card?.status !== 'done') return;
      const sources = await thumbSources(card);
      if (sources.length > 0) await makeThumb(sources, target);
    })
    .catch((error: unknown) => {
      console.warn(`[thumb] ${id} 生成失败：`, error instanceof Error ? error.message : error);
    })
    .finally(() => thumbJobs.delete(id));
  thumbJobs.set(id, job);
  thumbChain = job;
  return job;
}

/** 做缩略图用哪几张图：有原图用原图；没有就用各层，由远及近 */
async function thumbSources(card: CardRow): Promise<string[]> {
  const original = originalFile(card);
  if (original && (await stat(original).catch(() => null))) return [original];
  const dir = join(OUT_DIR, card.id);
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
    layers?: { file?: unknown }[];
  };
  // manifest 是自己写的，文件名仍按层文件的格式核一遍再拼路径，不给目录穿越留口子
  return (manifest.layers ?? []).flatMap((layer) =>
    typeof layer.file === 'string' && /^layer-\d{1,2}\.(?:png|webp)$/.test(layer.file) ? [join(dir, layer.file)] : [],
  );
}

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
  // 限流、排满、盘满这几种拒绝记一行：不记的话，被刷的时候日志里什么都看不出来
  if (status === 429 || status === 503 || status === 507) console.warn(`[reject] ${status} ${code}`);
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
/**
 * 读完请求体。超过 limit 就拒绝。
 * 给了 res：超了不立刻断开，等调用方回完错误（413）再断——先断开的话对方只看到连接被重置，
 * 隔着 Caddy 就成了 502，分不清是传太大还是服务挂了。没给（埋点、存配置这些几 KB 的）就照旧立刻断开
 */
function readBody(req: IncomingMessage, limit: number, res?: ServerResponse): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`超过上限 ${Math.round(limit / 1024 / 1024)}MB`));
        if (res) {
          req.removeAllListeners('data');
          req.pause();
          res.setHeader('connection', 'close');
          res.once('finish', () => req.destroy());
        } else {
          req.destroy();
        }
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
  const dir = join(OUT_DIR, id);

  // 排队期间 key 被吊销了：吊销要立即生效，这张不做了，原图也不留
  if (card.source === 'api' && !(card.api_key && db.apiKeyActive(card.api_key))) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    const key = card.api_key ? db.apiKey(card.api_key) : null;
    if (db.update(id, { status: 'error', stage: null, error: 'key_revoked' }, 'queued') && key) {
      trackApi(key, 'api-fail', { reason: 'key_revoked' });
    }
    return;
  }
  // 只从 queued 转到 running：排队期间被删了（deleted）就不做
  if (!db.update(id, { status: 'running', stage: null }, 'queued')) return;
  const startedAt = Date.now();
  /** 接口卡的结果记进 umami；网页卡的由浏览器自己报（segment-ok / segment-fail） */
  const report = (name: string, data: Record<string, string | number>): void => {
    const key = card.source === 'api' && card.api_key ? db.apiKey(card.api_key) : null;
    if (key) trackApi(key, name, data);
  };

  // 上次就是在处理它的时候崩的（多半是抠图吃爆了内存），这次不抠，免得反复崩
  const matte = MATTE_READY && !crashedJobs.has(id);
  let timing = false;
  try {
    // 拷一份到独立的 ArrayBuffer：Node 的 Buffer 可能落在共享池上，没法整块转给工作线程
    const bytes = new Uint8Array(await readFile(file));
    const set = await segmentInWorker(bytes, matte, (stage) => {
      db.update(id, { stage });
      // 从工作线程真正接手（报第一个阶段）才开始计时：并发调大时前面可能还在等线程，那段不该算进「加载模型」
      if (!timing) {
        timing = true;
        startJob(id, matte);
      }
      enterStage(id, stage);
    });

    // 流水线出的是 PNG，存盘前转成 WebP（画面有损、alpha 无损），体积只剩一成左右，见 layerToWebp
    await Promise.all(
      set.manifest.layers.map(async (layer, i) => {
        const png = set.images[i];
        if (!png) return;
        const webp = await layerToWebp(Buffer.from(png.buffer, png.byteOffset, png.byteLength));
        layer.file = layer.file.replace(/\.png$/, '.webp');
        await writeFile(join(dir, layer.file), webp);
      }),
    );
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(set.manifest));

    // 对外接口处理的是别人的照片：裸露识别做完才交付，分数高的直接拒绝、文件全删（网页只记录不拦）
    if (card.source === 'api') {
      const rejection = await screenApiCard(id, file);
      if (rejection) {
        finishJob(id, false);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        if (db.update(id, { status: 'error', stage: null, error: rejection }, 'running')) {
          report('api-fail', { reason: rejection });
        }
        return;
      }
    }

    /*
     * 只在还是 running 时写 done。处理（加上接口卡的识别）要几十秒，这期间卡可能被删了：
     * 删卡先把状态改成 deleted 再清文件，这里写不进去，就把刚写下的产物清掉，不让删掉的卡又活过来
     */
    const delivered = db.update(
      id,
      {
        status: 'done',
        stage: 'done',
        error: null,
        layer_count: set.manifest.layers.length,
        result_url: `${PUBLIC_ORIGIN}/c/${id}`,
      },
      'running',
    );
    if (!delivered) {
      finishJob(id, false);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    finishJob(id, true);
    report('api-done', { layers: set.manifest.layers.length, seconds: Math.round((Date.now() - startedAt) / 1000) });
    // 接口的卡不进卡册、识别也已经做过了
    if (card.source === 'api') return;
    // 缩略图顺手做掉，卡册里第一次打开时就不用现做了。不等它，也不让它的失败影响这张卡
    void ensureThumb(id);
    // 裸露识别（只记录不拦，见 moderation.ts）。卡已经是 done 了，用户不用等它；
    // 放在这里串行跑，是为了不和下一张的分层抢 CPU
    await recordNsfw(id, file);
  } catch (error) {
    finishJob(id, false);
    // 只在还是 running 时写 error：处理途中被删了（删卡会把目录删掉，写文件当然失败）就保持 deleted
    const recorded = db.update(id, { status: 'error', error: error instanceof Error ? error.message : String(error) }, 'running');
    if (!recorded) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    report('api-fail', { reason: 'error' });
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

/**
 * 给一张卡做裸露识别并记下，分数高的打一行日志，方便从 journalctl 里直接看到（见 moderation.ts）。
 * 绝不抛错：runJob 里它在 try 块中，抛出去会被当成分层失败，把做好的卡删掉
 */
async function recordNsfw(id: string, file: string): Promise<void> {
  const result = await detectNudity(file, MODEL_DIR);
  if (!result) return;
  try {
    db.update(id, { nsfw: Math.round(result.score * 1000) / 1000, nsfw_part: result.part });
  } catch (error) {
    console.error(`[nsfw] ${id} 结果写库失败`, error);
    return;
  }
  if (result.score >= NSFW_LOG_THRESHOLD) {
    console.log(`[nsfw] ${id} 疑似裸露：${result.part}（${result.score.toFixed(3)}），查看：db.mjs nsfw`);
  }
}

/**
 * 对外接口的卡交付前的裸露识别。返回拒绝的原因（错误码），放行就是 null。
 * 识别不了（模型缺失、读图失败）也拒绝：替第三方处理照片，宁可不做也不盲放
 */
async function screenApiCard(id: string, file: string): Promise<string | null> {
  const result = await detectNudity(file, MODEL_DIR);
  if (!result) return 'moderation_unavailable';
  db.update(id, { nsfw: Math.round(result.score * 1000) / 1000, nsfw_part: result.part });
  if (result.score < NSFW_LOG_THRESHOLD) return null;
  console.log(`[nsfw] ${id} 对外接口的卡疑似裸露，已拒绝：${result.part}（${result.score.toFixed(3)}）`);
  return 'nsfw_rejected';
}

/**
 * 分数到这个值就在日志里提一句，只是提示，不做任何拦截。对外接口的卡到这个值直接拒绝（screenApiCard）。
 * 依据：上线前线上 93 张正常原图离线跑过，这几个部位的最高分是 0.21；明确露出时一般在 0.5 以上
 */
const NSFW_LOG_THRESHOLD = 0.4;

/**
 * 启动时把还没识别过的卡补上（上线这个功能之前的存量卡，以及上次识别前服务就重启了的）。
 * 一张张串行来，不耽误启动；只看还留着原图的卡，删掉的、过期的没有文件可看
 */
async function backfillNsfw(): Promise<void> {
  let scored = 0;
  for (const card of db.live()) {
    if (card.nsfw !== null) continue;
    const file = originalFile(card);
    if (!file || !(await stat(file).catch(() => null))) continue;
    await recordNsfw(card.id, file);
    scored++;
  }
  if (scored > 0) console.log(`[nsfw] 给 ${scored} 张存量卡补做了裸露识别`);
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const id = queue.shift();
    if (!id) break;
    apiJobs.delete(id);
    running++;
    void runJob(id).finally(() => {
      running--;
      pump();
    });
  }
}

/** 产物目录所在的盘还剩多少字节。查不了就是 null，不因为这个拒收 */
async function freeBytes(dir: string): Promise<number | null> {
  const info = await statfs(dir).catch(() => null);
  return info ? info.bavail * info.bsize : null;
}

/**
 * 收一张上传：读请求体、认格式、规范化原图、查磁盘、落盘，最后插库入队。网页（/api/jobs）和对外接口（/v1/cards）共用。
 * 失败时已经回过错误，返回 null。
 *
 * admit 是这次提交的额度和排队检查，不过就自己回错误、返回 false。调用方先查一遍好快速拒绝；
 * 这里在插库入队之前再**同步**查一遍：读体、规范化、写盘都要 await，并发提交时 N 个请求能一起过了第一遍。
 * 第二遍和插库、入队之间没有 await，node:sqlite 又是同步的，这一段是原子的
 */
async function acceptUpload(
  req: IncomingMessage,
  res: ServerResponse,
  source: CardSource,
  apiKey: ApiKeyRow | null,
  admit: () => boolean,
  userId: string | null = null,
): Promise<CardRow | null> {
  // 盘快满了就先拒：放在读请求体之前，不白收一张图、白做一遍规范化
  const free = await freeBytes(OUT_DIR);
  if (free !== null && free < MIN_FREE_BYTES) {
    fail(res, 507, 'disk_full', '服务器空间不足，稍后再试');
    return null;
  }

  const limitMb = Math.round(MAX_UPLOAD / 1024 / 1024);
  const tooLarge = (): null => {
    res.setHeader('connection', 'close');
    fail(res, 413, 'too_large', `图片超过 ${limitMb}MB 上限`, { limitMb });
    return null;
  };
  // 声明的大小已经超了，就不读请求体
  if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD) return tooLarge();
  let bytes: Buffer;
  try {
    bytes = await readBody(req, MAX_UPLOAD, res);
  } catch {
    return tooLarge();
  }

  const kind = sniffImage(bytes);
  if (!kind) {
    fail(res, 415, 'unsupported_image', '不是可识别的图片（支持 JPEG / PNG / WebP / AVIF / HEIC）');
    return null;
  }

  // 先把原图规范化（摆正方向、去掉 EXIF）存下来，再入队。
  // 解不开的图在这里就挡掉，不用排到队里才失败
  let original;
  try {
    original = await normalizeOriginal(bytes);
  } catch (error) {
    if (error instanceof ImageError) {
      fail(res, 415, error.code, error.message, error.params);
    } else {
      // 图片库的原始报错（libvips、libheif 的内部信息）只进日志，不回给调用方
      console.warn('[upload] 解不开的图片', error instanceof Error ? error.message.split('\n')[0] : error);
      fail(res, 415, 'unsupported_image', '无法识别的图片');
    }
    return null;
  }

  // 写盘出错（权限、盘满）要在这里接住：这个处理函数外面没有兜底的 catch，抛出去整个服务就挂了
  const id = randomUUID();
  const dir = join(OUT_DIR, id);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `original.${original.ext}`), original.data);
  } catch (error) {
    console.error(`[upload] ${id} 写原图失败`, error);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    fail(res, 500, 'store_failed', '保存图片失败，稍后再试');
    return null;
  }

  if (!admit()) {
    void rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
  const now = Date.now();
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
    nsfw: null,
    nsfw_part: null,
    source,
    api_key: apiKey?.id ?? null,
    user_id: userId,
  };
  db.insert(card);
  enqueue(id, source);
  pump();
  return card;
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
  // 对外接口做的卡是私有的：卡片页对外当作不存在——和不存在的 id 一样回前端页面（200），
  // 但不注入分享标签、不计访问。回 404 的话反而能拿状态码试探出「这是一张活着的接口卡」
  const privateCard = Boolean(cardPath?.[1] && db.get(cardPath[1])?.source === 'api');

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
  // /docs/ 是 VitePress 生成的文档，自带三种语言的页面，不套首页的标题、描述
  if (isHtml && !pathname.startsWith('/docs/')) body = Buffer.from(localizeHtml(body.toString('utf8'), lang), 'utf8');

  // 404 只是个兜底页：不注入分享标签、不计访问
  if (status === 200 && cardPath?.[1] && isHtml && !privateCard) {
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
/** 清理过期卡。定时器和启动时各调一次，外面没有兜底，失败只记日志 */
function sweepSafely(): void {
  void sweep().catch((error: unknown) => console.error('[sweep] 清理失败', error));
}

async function sweep(): Promise<void> {
  // 先把内存里攒的访问量落库，否则刚被看过的卡可能按旧的 last_hit_at 判成过期
  flushHits(db);
  const removed = await sweepCards(db, OUT_DIR, TTL_MS, KEEP_DOUBLINGS_CAP);
  if (removed > 0) console.log(`[sweep] 清理了 ${removed} 张过期卡片`);
  try {
    db.prunePerf(90, 200_000);
    db.pruneSessions(Date.now());
  } catch (error) {
    console.error('[sweep] 清理埋点、过期会话失败', error);
  }
}

/*
 * 对外接口 /v1：给白名单里的少数调用方（key 由站长用 scripts/apikey.mjs 发）。用法见 README 的「对外接口」。
 *
 * 和网页的区别：
 *   - 鉴权：Authorization: Bearer <key>，每张卡只有提交它的 key 能看、能下、能删
 *   - 私有：不能分享、不能导出，公开路由（/c、/api/layers、/api/jobs）上当作不存在
 *   - 保留：提交后 24 小时清掉（cards.ts 的 API_TTL_MS），调用方自己把结果存走
 *   - 审核：裸露识别做完才交付，分数高的直接拒绝（screenApiCard）
 *   - 排队：插在网页任务后面，额度按 key 和全站各算（见上面的 API_* 常量）
 */

/** 这些文件可以经 /v1 下载：清单、层图、去掉 EXIF 的原图 */
const V1_FILE = /^(?:manifest\.json|layer-\d{1,2}\.(?:png|webp)|original\.(?:jpg|png|webp))$/;

const DAY_MS = 24 * 60 * 60 * 1000;

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

function unauthorized(res: ServerResponse): void {
  res.setHeader('www-authenticate', 'Bearer');
  fail(res, 401, 'unauthorized', '缺少 API key，或者 key 无效、已吊销');
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('allow', allow);
  fail(res, 405, 'method_not_allowed', '不支持的请求方法');
}

async function handleV1(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
      if (db.apiUsedSince(since, key) >= key.daily_limit) {
        reject(429, 'quota_exceeded', `这个 key 24 小时内最多提交 ${key.daily_limit} 张`, { limit: key.daily_limit });
        return false;
      }
      if (busy >= API_KEY_IN_FLIGHT) {
        reject(429, 'too_many_in_flight', `同一个 key 同时最多 ${API_KEY_IN_FLIGHT} 张在上传或处理`, { limit: API_KEY_IN_FLIGHT });
        return false;
      }
      if (db.apiSubmittedSince(since) >= API_DAILY_LIMIT) {
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

/*
 * 用 IH 账号登录（协议见 auth.ts）。登录永远是可选的，不登录照常做卡。
 *   GET  /auth/login?next=   跳到 IH 的授权页
 *   GET  /auth/callback      IH 带着授权码跳回来：换用户、发会话、回到 next
 *   POST /auth/logout        退出
 */
async function handleAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const redirectUri = `${PUBLIC_ORIGIN}/auth/callback`;

  if (req.method === 'GET' && url.pathname === '/auth/login') {
    const next = safeNext(url.searchParams.get('next'), PUBLIC_ORIGIN);
    if (AUTH_FAKE) {
      startSession(res, { id: 'staging', name: 'Staging', avatar: null }, next);
      return;
    }
    if (!SSO_SECRET) {
      loginFailed(req, res, url, next);
      return;
    }
    const state = newSecret();
    const verifier = newSecret();
    const target = new URL(SSO_AUTHORIZE_URL);
    target.search = new URLSearchParams({
      client_id: SSO_CLIENT_ID,
      redirect_uri: redirectUri,
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString();
    res.writeHead(302, {
      location: target.toString(),
      'cache-control': 'no-store',
      'set-cookie': cookie(STATE_COOKIE, encodeState({ state, verifier, next }), STATE_TTL_S),
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/auth/callback') {
    const saved = decodeState(parseCookies(req.headers.cookie)[STATE_COOKIE]);
    const code = url.searchParams.get('code') ?? '';
    // state 对不上：不是这个浏览器发起的登录（登录 CSRF），或者在 IH 那边待太久、cookie 过期了
    const user =
      saved && SSO_SECRET && timingSafeEqualStr(url.searchParams.get('state') ?? '', saved.state) && /^[\w-]{20,200}$/.test(code)
        ? await exchangeCode({
            tokenUrl: SSO_TOKEN_URL,
            clientId: SSO_CLIENT_ID,
            secret: SSO_SECRET,
            code,
            verifier: saved.verifier,
            redirectUri,
          })
        : null;
    if (!user) {
      loginFailed(req, res, url, saved?.next ?? '/');
      return;
    }
    console.log(`[auth] 账号 ${user.id} 登录`);
    startSession(res, user, saved?.next ?? '/');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    if (!sameOrigin(req)) {
      fail(res, 403, 'forbidden', '只能从本站页面退出');
      return;
    }
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) db.deleteSession(sha256Hex(token));
    res.writeHead(204, { 'cache-control': 'no-store', 'set-cookie': cookie(SESSION_COOKIE, '', 0) });
    res.end();
    return;
  }

  fail(res, 404, 'not_found', '没有这个地址');
}

function startSession(res: ServerResponse, user: IhUser, next: string): void {
  const token = newSecret();
  const now = Date.now();
  db.insertSession({
    hash: sha256Hex(token),
    user_id: user.id,
    name: user.name,
    avatar: user.avatar,
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
  });
  res.writeHead(302, {
    location: next,
    'cache-control': 'no-store',
    // 授权码在回调地址上，别让它跟着 Referer 出去
    'referrer-policy': 'no-referrer',
    'set-cookie': [cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000), cookie(STATE_COOKIE, '', 0)],
  });
  res.end();
}

/** 登录没成：一个只有一句话和返回链接的页面。用户点「返回」回到原来的地方再点一次登录就行 */
function loginFailed(req: IncomingMessage, res: ServerResponse, url: URL, next: string): void {
  const lang = requestLang(req, url);
  const body = `<!doctype html><html lang="${LANG_TAG[lang]}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>HoloCard</title><p>${escapeAttr(translate(lang, 'login.failed'))}</p><p><a href="${escapeAttr(next)}">${escapeAttr(translate(lang, 'login.back'))}</a></p></html>`;
  res.writeHead(400, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'set-cookie': cookie(STATE_COOKIE, '', 0),
  });
  res.end(body);
}

/*
 * 当前登录的账号，和它名下的卡（卡册用）。
 *   GET  /api/me         { login: 开没开登录, user: 账号或 null, cards: 名下还在的卡，最新的在前 }
 *   POST /api/me/claim   { cards: [{ id, token }] } 把这台设备上的卡（凭口令）认领到账号下，返回认领成功的 id
 */
async function handleMe(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const session = sessionOf(req);
  if (req.method === 'GET' && url.pathname === '/api/me') {
    json(res, 200, {
      login: LOGIN_ENABLED,
      user: session ? { id: session.user_id, name: session.name, avatar: session.avatar } : null,
      cards: session ? db.userCards(session.user_id) : [],
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/me/claim') {
    if (!session || !sameOrigin(req)) {
      fail(res, 401, 'login_required', '要先登录');
      return;
    }
    let entries: unknown;
    try {
      entries = (JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) as { cards?: unknown }).cards;
    } catch {
      entries = null;
    }
    if (!Array.isArray(entries) || entries.length > 500) {
      fail(res, 400, 'bad_request', '请求不合法');
      return;
    }
    const claimed: string[] = [];
    for (const entry of entries) {
      const { id, token } = (entry ?? {}) as { id?: unknown; token?: unknown };
      if (typeof id !== 'string' || typeof token !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) continue;
      const card = db.get(id);
      // 只认还没有主人账号、口令对得上的网页卡；删掉、过期、下架的不认
      if (!card || card.user_id !== null || card.source !== 'web' || !CLAIMABLE.has(card.status)) continue;
      if (!timingSafeEqualStr(token, card.delete_token)) continue;
      if (db.claim(id, session.user_id, card.delete_token, randomUUID())) claimed.push(id);
    }
    console.log(`[claim] 账号 ${session.user_id} 认领了 ${claimed.length} 张`);
    json(res, 200, { claimed });
    return;
  }
  if (url.pathname === '/api/me/keys' || url.pathname.startsWith('/api/me/keys/')) {
    await handleMyKeys(req, res, url, session);
    return;
  }
  if (url.pathname === '/api/me' || url.pathname === '/api/me/claim') {
    methodNotAllowed(res, url.pathname === '/api/me' ? 'GET' : 'POST');
    return;
  }
  fail(res, 404, 'not_found', '没有这个地址');
}

/*
 * 个人中心里的对外接口 key（用法见 README「对外接口」）。登录了就能自己申请，不用找站长：
 *   GET    /api/me/keys       申请过的 key（不含 key 本身，只有编号）和 24 小时内用了几张
 *   POST   /api/me/keys       申请一个。同时只能有一个没吊销的；key 只在这个响应里出现一次
 *   DELETE /api/me/keys/<id>  吊销自己的 key，立即生效
 * 额度按账号算：吊销了再申请，24 小时内用过的照样算数
 */
async function handleMyKeys(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  session: SessionRow | null,
): Promise<void> {
  if (!session || (req.method !== 'GET' && !sameOrigin(req))) {
    fail(res, 401, 'login_required', '要先登录');
    return;
  }
  const since = Date.now() - DAY_MS;

  if (req.method === 'GET' && url.pathname === '/api/me/keys') {
    const keys = db.userApiKeys(session.user_id);
    const used = keys[0] ? db.apiUsedSince(since, keys[0]) : 0;
    json(res, 200, {
      keys: keys.map((key) => ({
        id: key.id,
        createdAt: new Date(key.created_at).toISOString(),
        revokedAt: key.revoked_at ? new Date(key.revoked_at).toISOString() : null,
        dailyLimit: key.daily_limit,
      })),
      used,
      dailyLimit: SELF_SERVE_DAILY_LIMIT,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/me/keys') {
    if (db.userApiKeys(session.user_id).some((key) => key.revoked_at === null)) {
      fail(res, 409, 'key_exists', '已经有一个能用的 key 了，要换先吊销旧的');
      return;
    }
    const key = newApiKey();
    const row = {
      id: randomUUID().slice(0, 8),
      name: session.name,
      hash: hashApiKey(key),
      created_at: Date.now(),
      revoked_at: null,
      daily_limit: SELF_SERVE_DAILY_LIMIT,
      user_id: session.user_id,
    };
    db.insertApiKey(row);
    console.log(`[keys] 账号 ${session.user_id} 申请了 key ${row.id}`);
    json(res, 201, { id: row.id, key, dailyLimit: row.daily_limit });
    return;
  }

  const revokeMatch = /^\/api\/me\/keys\/([0-9a-f]{8})$/.exec(url.pathname);
  if (req.method === 'DELETE' && revokeMatch) {
    if (!db.revokeUserApiKey(revokeMatch[1] ?? '', session.user_id)) {
      fail(res, 404, 'not_found', '没有这个 key，或者已经吊销了');
      return;
    }
    console.log(`[keys] 账号 ${session.user_id} 吊销了 key ${revokeMatch[1]}`);
    json(res, 200, { revoked: true });
    return;
  }
  fail(res, 404, 'not_found', '没有这个地址');
}

const CLAIMABLE = new Set<CardRow['status']>(['queued', 'running', 'done', 'error']);

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

    // 对外接口。要在下面「GET 非 /api 路径一律当静态文件」之前接住
    if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
      await handleV1(req, res, url);
      return;
    }

    // 登录、退出。也要在「GET 非 /api 路径一律当静态文件」之前接住
    if (url.pathname.startsWith('/auth/')) {
      await handleAuth(req, res, url);
      return;
    }
    if (url.pathname === '/api/me' || url.pathname.startsWith('/api/me/')) {
      await handleMe(req, res, url);
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/health') {
      json(res, segmenterBroken ? 503 : 200, {
        ok: !segmenterBroken,
        running,
        queued: queue.length,
        concurrency: CONCURRENCY,
        exporting: exporting ? 1 : 0,
        exportQueued: exportQueue.length,
      });
      return;
    }

    // 这两个要写完整域名，所以按 PUBLIC_ORIGIN 现生成，不放静态文件——别人自托管时地址自然就对
    // 文档在 /docs/ 下（VitePress 生成的静态页）；手打 /docs 时补上斜杠
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/docs') {
      res.writeHead(301, { location: `/docs/${url.search}` }).end();
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/robots.txt') {
      text(res, 'text/plain; charset=utf-8', robotsTxt(), req.method);
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/sitemap.xml') {
      text(res, 'application/xml; charset=utf-8', await sitemapXml(), req.method);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/perf') {
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
      // 埋点写不进去（磁盘满、库被锁）不能把服务带崩：这个处理函数外面没有兜底的 catch
      try {
        db.insertPerf(sample);
      } catch (error) {
        console.error('[perf] 写库失败', error);
      }
      res.writeHead(204).end();
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
      // 只数网页任务：对外接口的任务排在后面，另有自己的上限
      const admit = (): boolean => {
        const waiting = queue.length - apiJobs.size;
        if (waiting < MAX_QUEUE) return true;
        fail(res, 503, 'queue_full', `排队的人太多（${waiting} 个在等），稍后再试`, { queued: waiting });
        return false;
      };
      if (!admit()) return;
      // 登录着做的卡直接归到账号下。只认本站页面发的：兄弟子域借访客的会话传图，会塞进人家的卡册
      const account = sameOrigin(req) ? sessionOf(req) : null;
      const card = await acceptUpload(req, res, 'web', null, admit, account?.user_id ?? null);
      if (!card) return;

      /*
       * 删除口令只在这里给一次。
       *
       * 不放在 GET /api/jobs/{id} 里：那个接口任何知道 id 的人都能打，
       * 而卡一旦分享出去，id 就是公开的——口令跟着泄漏，删除入口就等于没有。
       * 提交请求的响应只有上传者自己看得到。
       */
      // 归到账号下的卡不给口令：主人认的是会话，口令留在设备上反而会落到下一个用这台设备的人手里
      json(res, 202, {
        id: card.id,
        position: queue.indexOf(card.id) + 1,
        deleteToken: card.user_id ? null : card.delete_token,
      });
      return;
    }

    // 转永久保留，并在后台渲染一张 OG 预览图
    const shareMatch = /^\/api\/cards\/([0-9a-f-]{36})\/share$/.exec(url.pathname);
    if (req.method === 'POST' && shareMatch) {
      const id = shareMatch[1] ?? '';
      const dir = join(OUT_DIR, id);
      const card = db.get(id);
      if (!card || card.status !== 'done' || card.source === 'api') {
        fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
        return;
      }
      // 只有卡的主人能分享：分享会把卡转成长期保留、公开卡片页、起浏览器渲染预览图。
      // 以前不鉴权，任何拿到 id 的人都能替别人的卡续命
      if (!owns(req, card)) {
        fail(res, 403, 'share_forbidden', '只有生成这张卡的人能分享它');
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
      // 对外接口的卡是私有的，不给导出（导出是最重的操作，接口也不提供）
      if (!card || card.status !== 'done' || card.source === 'api') {
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
     * 卡的主人存作者配置（箔面、炫光、视差，见 src/format/config.ts）。
     * 分享页、OG 预览图、导出的动图都读磁盘上的 manifest，存进去之后它们才按作者调的样子来。
     * 鉴权和删除一样用口令；口令走自定义头，跨站请求会触发预检，这个服务不答 OPTIONS，所以借不了访客的浏览器
     */
    const configMatch = /^\/api\/cards\/([0-9a-f-]{36})\/config$/.exec(url.pathname);
    if (req.method === 'PUT' && configMatch) {
      const id = configMatch[1] ?? '';
      const dir = join(OUT_DIR, id);

      const card = db.get(id);
      if (!card || card.status !== 'done' || card.source === 'api') {
        fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
        return;
      }
      if (!owns(req, card)) {
        fail(res, 403, 'wrong_token', '口令不对，只有生成这张卡的人能改它');
        return;
      }

      // 这个处理函数外面没有兜底的 catch，读写盘、解析出错都得在这里接住，不然整个服务挂掉
      let manifest: LayerManifest;
      try {
        manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as LayerManifest;
      } catch {
        fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
        return;
      }
      let config;
      try {
        config = parseConfig(JSON.parse((await readBody(req, 8192)).toString('utf8')), manifest.layers.length);
      } catch {
        config = null;
      }
      if (!config) {
        fail(res, 400, 'bad_config', '配置不合法');
        return;
      }
      applyConfig(manifest, config);
      try {
        // 先写临时文件再改名：同一时刻可能有人正在读这份 manifest（分享页、导出），不能让他读到写了一半的
        const tmp = join(dir, `manifest.json.${randomUUID()}.tmp`);
        await writeFile(tmp, JSON.stringify(manifest));
        await rename(tmp, join(dir, 'manifest.json'));
      } catch (error) {
        console.error(`[config] ${id} 写 manifest 失败`, error);
        fail(res, 500, 'save_failed', '保存失败');
        return;
      }

      // 导出的动图自己会拿修改时间和 manifest 比，旧的自动作废（见 exportReady）。
      // 预览图只在「还没有」时才生成，得删掉旧的、按原来有的语言重新排队；
      // 新图修改时间变了，og:image 地址上的 ?v= 跟着变，抓取方会重新拿。
      // 正在渲染的那张由 pumpPreviews 自己发现 manifest 变了、重排，这里不用管
      for (const lang of LANGS) {
        const file = join(dir, previewFile(lang));
        if (!(await stat(file).catch(() => null))) continue;
        try {
          await rm(file, { force: true });
        } catch (error) {
          // 删不掉（权限、磁盘出错）不影响配置本身已经存上，只是分享图暂时还是旧的
          console.error(`[config] ${id} 删旧预览图失败`, error);
          continue;
        }
        queuePreview(id, lang);
      }
      json(res, 200, { saved: true });
      return;
    }

    /*
     * 删除自己的卡。
     *
     * 口令是产出时随 202 响应给上传者的，只有他们手上有（前端存在 localStorage）。
     * 不登录时，一张卡的「所有者」就是「拿着口令的人」；归到账号下的卡认会话（见 owns）。
     * 比较用定长循环而不是 ===，避免把口令的正确前缀长度泄漏出去。
     */
    const deleteMatch = /^\/api\/cards\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === 'DELETE' && deleteMatch) {
      const id = deleteMatch[1] ?? '';
      const dir = join(OUT_DIR, id);

      const card = db.get(id);
      // 对外接口的卡走 /v1 删，这里当作不存在（不然错口令回 403、没有的卡回 404，能用来试探 id）
      if (!card || card.status === 'deleted' || card.status === 'expired' || card.source === 'api') {
        fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
        return;
      }
      if (!owns(req, card)) {
        fail(res, 403, 'wrong_token', '口令不对，只有生成这张卡的人能删除它');
        return;
      }

      // 还在排队的也能删：从队列里拿掉，免得删完又被处理出来。排着的导出同理
      dequeue(id);
      for (let i = exportQueue.length - 1; i >= 0; i--) {
        if (exportQueue[i]?.id === id) exportQueue.splice(i, 1);
      }

      /*
       * 先改状态再删文件。正在处理的卡，处理那边还在往目录里写层图：
       * 状态先成了 deleted，处理完写回 done 就不生效、会自己把产物清掉（见 runJob）；
       * rm 撞上正在写的文件可能失败（ENOTEMPTY），接住，残留由处理那边收尾
       */
      db.update(id, { status: 'deleted', stage: null });
      // 文件（含原图）全删；数据库那一行留着，只改状态，统计时还能数到。
      // 被站长下架过的卡，隔离区里那份也一起删：上传者要删，页面上承诺的是服务端的文件都清掉
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await rm(join(OUT_DIR, '.removed', id), { recursive: true, force: true }).catch(() => undefined);
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
      // 对外接口的卡走 /v1/cards/<id>/files（要 key），公开路由上当作不存在
      if (db.get(id ?? '')?.source === 'api') {
        json(res, 404, { error: '层文件不存在或已过期' });
        return;
      }
      // 卡册缩略图还没有就先做（见 ensureThumb）。卡已经过期、被删的做不出来，照常落到下面的 404
      if (name === 'thumb.jpg') await ensureThumb(id ?? '');
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
      // 删掉的、过期的对前端来说都是「没有了」，不暴露内部状态。对外接口的卡查 /v1/cards/<id>
      if (!card || card.status === 'deleted' || card.status === 'expired' || card.status === 'removed' || card.source === 'api') {
        fail(res, 404, 'job_not_found', '任务不存在或已过期');
        return;
      }
      // 对外仍然叫 state，前端不用改
      const position = card.status === 'queued' ? queue.indexOf(card.id) + 1 : 0;
      // 还要多少秒，给前端的倒计时（见 eta.ts）
      const eta =
        card.status === 'running' ? runningEta(card.id) : card.status === 'queued' ? queuedEta(position, MATTE_READY) : null;
      json(res, 200, {
        state: card.status,
        stage: card.stage,
        position,
        ...(eta === null ? {} : { eta: Math.round(eta) }),
        ...(card.status === 'done'
          ? { layers: `/api/layers/${card.id}`, layerCount: card.layer_count }
          : {}),
        ...(card.error ? { error: card.error } : {}),
      });
      return;
    }

    json(res, 404, { error: 'not found' });
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
  for (const card of db.byStatus('running')) crashedJobs.add(card.id);
  for (const card of unfinished) {
    const file = originalFile(card);
    if (file && (await stat(file).catch(() => null))) {
      db.update(card.id, { status: 'queued', stage: null });
      enqueue(card.id, card.source);
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

// 分层线程启动就起好：模块加载失败能在健康检查里暴露出来（见 segmenterBroken），第一张图也不用等它加载
segmenter ??= spawnSegmenter();

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
