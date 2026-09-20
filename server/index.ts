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
 *   POST /api/jobs        请求体是图片字节 → 202 {id}
 *   GET  /api/jobs/{id}   → {state, stage, position, layers?, error?}
 *   层文件本身由 Caddy 直接当静态文件发，不经过 Node。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { env } from '@huggingface/transformers';
import { segmentToLayerSet, type SegmentStage } from '../src/segmenter';
import { sharpImages } from './images';

const PORT = Number(process.env.HOLOCARD_PORT ?? 8791);
const OUT_DIR = process.env.HOLOCARD_OUT_DIR ?? '/srv/holocard-layers';
const MODEL_DIR = process.env.HOLOCARD_MODEL_DIR ?? '/srv/holocard-models';
/** 上传体积上限。手机直出的照片通常 3~8MB */
const MAX_UPLOAD = Number(process.env.HOLOCARD_MAX_UPLOAD ?? 16 * 1024 * 1024);
/** 同时处理几张。这台机器 4 核且已有其他负载，多了只会互相拖慢并吃满内存 */
const CONCURRENCY = Number(process.env.HOLOCARD_CONCURRENCY ?? 1);
/** 队列排到这么长就直接拒绝，让用户立刻知道，而不是排十分钟 */
const MAX_QUEUE = Number(process.env.HOLOCARD_MAX_QUEUE ?? 12);
/** 产物保留多久（毫秒），到期清理 */
const TTL_MS = Number(process.env.HOLOCARD_TTL_MS ?? 6 * 60 * 60 * 1000);

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
      if (info && now - info.mtimeMs > TTL_MS) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
      }
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

    /*
     * 层文件。本来想交给 Caddy 直接发静态文件，但那样开发环境（没有 Caddy）就跑不通，
     * 而且服务自己能发才算自包含——别人拿去单跑一个 Node 进程就够了。
     * 路径两段都严格匹配，不给目录穿越留口子。
     */
    const fileMatch = /^\/api\/layers\/([0-9a-f-]{36})\/(manifest\.json|layer-\d{1,2}\.png)$/.exec(
      url.pathname,
    );
    if (req.method === 'GET' && fileMatch) {
      const [, id, name] = fileMatch;
      try {
        const body = await readFile(join(OUT_DIR, id ?? '', name ?? ''));
        res.writeHead(200, {
          'content-type': name?.endsWith('.png') ? 'image/png' : 'application/json; charset=utf-8',
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
  console.log(`  并发 ${CONCURRENCY}，队列上限 ${MAX_QUEUE}，产物保留 ${Math.round(TTL_MS / 3600000)} 小时`);
});
