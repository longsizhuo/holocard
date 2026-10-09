/**
 * 分层任务：收上传、排队、在工作线程里分层（segment-worker.ts）、裸露识别、做缩略图；
 * 启动时把上次没做完的接着排上。网页（routes/cards.ts）和对外接口（routes/v1.ts）共用
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { LayerManifest } from '../../src/format/types';
import {
  CONCURRENCY,
  MATTE_MODEL,
  MATTE_READY,
  MAX_UPLOAD,
  MIN_FREE_BYTES,
  MODEL_DIR,
  OUT_DIR,
  PUBLIC_ORIGIN,
} from '../config';
import { fail, readBody } from '../http';
import { db } from '../store';
import type { ApiKeyRow, CardRow, CardSource } from '../store/db';
import { trackApi } from '../umami';
import { enterStage, finishJob, startJob } from './eta';
import { ImageError, layerToWebp, makeThumb, normalizeOriginal } from './images';
import { detectNudity } from './moderation';
import type { ProbabilityPlane, SegmentReply, SegmentRequest, SegmenterConfig } from './segment-worker';

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
export let segmenterBroken = false;

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
export const CPU_SHARE = cpuShare();

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

type FinalReply = Extract<SegmentReply, { type: 'done' | 'cardmask' }>;

/**
 * 交给分层线程做一件事，等它的最终回复。分层和卡面遮罩排同一个队（segmentTail）：
 * 线程一次只做一件，同一时刻最多一个大模型在推理，两件叠在一起内存就不够了
 */
function runInWorker(request: SegmentRequest, onStage: (stage: string) => void = () => undefined): Promise<FinalReply> {
  const run = segmentTail.then(
    () =>
      new Promise<FinalReply>((resolve, reject) => {
        // 这段打包进 holocard-server.mjs，和 segment-worker.mjs 在同一个目录，见 vite.server.config.ts
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
          if (reply.type === 'error') reject(new Error(reply.message));
          else resolve(reply);
        };
        // 线程自己崩了（未捕获的异常）：这张算失败，下一张重新起一个
        const onExit = (code: number): void => {
          finish();
          segmenter = null;
          reject(new Error(`分层线程意外退出（${code}）`));
        };
        worker.on('message', onMessage);
        worker.on('exit', onExit);
        worker.postMessage(request, [request.bytes.buffer as ArrayBuffer]);
      }),
  );
  segmentTail = run.catch(() => null);
  return run;
}

async function segmentInWorker(
  bytes: Uint8Array<ArrayBuffer>,
  matte: boolean,
  onStage: (stage: string) => void,
): Promise<{ manifest: LayerManifest; images: Uint8Array[] }> {
  const reply = await runInWorker({ type: 'segment', bytes, matte }, onStage);
  if (reply.type !== 'done') throw new Error('分层线程回错了消息');
  return reply;
}

/** 卡面遮罩要的模型输出（见 server/pipeline/cardmask.ts） */
export async function cardmaskInWorker(
  bytes: Uint8Array<ArrayBuffer>,
  region: { x: number; y: number; w: number; h: number },
  textModel: string,
): Promise<{ matte: ProbabilityPlane | null; text: ProbabilityPlane }> {
  const reply = await runInWorker({ type: 'cardmask', bytes, region, textModel });
  if (reply.type !== 'cardmask') throw new Error('分层线程回错了消息');
  return reply;
}

/**
 * 待处理的卡片 id。原图已经在磁盘上，队列里不用再攥着字节——
 * 以前最多 12 张 × 16MB 堆在内存里，而且服务一重启（每次发版都会）排队的任务就全丢了。
 */
export const queue: string[] = [];
/** 队列里哪些是对外接口的任务。网页任务插到它们前面，满不满也分开数 */
export const apiJobs = new Set<string>();
export let running = 0;

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
export function dequeue(id: string): void {
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

export function ensureThumb(id: string): Promise<void> {
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
export function originalFile(card: Pick<CardRow, 'id' | 'original_type'>): string | null {
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

/**
 * 认图片的魔数而不是信 Content-Type。
 * 前端是我们自己写的，但这个接口在公网上，谁都能 POST。
 */
export function sniffImage(bytes: Buffer): string | null {
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
export async function backfillNsfw(): Promise<void> {
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
export async function acceptUpload(
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
 * 上次退出时还没处理完的任务：原图在磁盘上的就接着排队，
 * 发版重启不再把正在排队的人的图弄丢。原图都没有的只能标失败。
 */
export async function resumeUnfinished(): Promise<void> {
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

/** 分层线程启动就起好：模块加载失败能在健康检查里暴露出来（见 segmenterBroken），第一张图也不用等它加载 */
export function startSegmenter(): void {
  segmenter ??= spawnSegmenter();
}
