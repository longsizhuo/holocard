/**
 * 线稿提取任务：收一张插画，出白底黑线的线稿灰度图和主体遮罩，深浅、只留主体、线条颜色都在前端调（web/lineart/main.ts）。
 *
 * 先问显卡机（LINEART_URL，deploy/sam3/serve.py 的 POST /lineart）：线用 MangaLineExtraction，主体用 SAM3 按「人物」找（几个角色都算），
 * 一次回来，热的时候四五秒。显卡机不通就在本机分层线程里做，和分层排同一个队（jobs.ts 的 lineartInWorker），分两次：
 * 先出线稿（Anime2Sketch，几秒），做完就算 done、前端先画出来；再抠主体（BiRefNet，二十秒上下），这期间 subject 是 "pending"，
 * 前端轮询到 true 才让「只要主体」生效。
 * 结果放在产物目录的 .lineart/<id>/ 下：image.png（缩到线稿尺寸的原图）、line.png（灰度线稿）、subject.png（主体遮罩，抠不了时没有）、
 * lineart.json（尺寸、有没有主体）。不进数据库，地址是随机 UUID，24 小时后删。任务状态在内存里，重启后做完的照 lineart.json 认
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { LINEART_URL, MATTE_READY, MODEL_DIR, OUT_DIR } from '../config';
import { lineartInWorker } from './jobs';
import { SKETCH_MAX_SIDE } from './sketch';

export const LINEART_DIR = join(OUT_DIR, '.lineart');
/** 线稿模型（导出见 deploy/lineart/export_onnx.py） */
const SKETCH_MODEL = join(MODEL_DIR, 'anime2sketch', 'anime2sketch-improved.onnx');
/** 同时排着和在做的最多几个：一张线稿几秒、抠主体二十秒上下，和分层共用一个线程 */
export const MAX_LINEART_QUEUE = 4;
const TTL_MS = 24 * 60 * 60 * 1000;

export const LINEART_FILES = ['image', 'line', 'subject'] as const;

export interface LineartResult {
  width: number;
  height: number;
  /** 主体遮罩：true 有，"pending" 还在抠，false 没有（这台服务不抠图、或者认不出主体），前端藏起「只要主体」 */
  subject: boolean | 'pending';
}

type JobState = { state: 'queued' } | { state: 'error'; error: string } | ({ state: 'done' } & LineartResult);

const jobs = new Map<string, JobState & { createdAt: number }>();

/** 这台服务能不能提线稿：本机的线稿模型要在（显卡机不通时兜底）；抠图权重没有也能做，只是没有「只要主体」 */
export function lineartAvailable(): boolean {
  return existsSync(SKETCH_MODEL);
}

/** 显卡机刚开机、磁盘缓存是冷的时候，加载 SAM3 和线稿模型要两分钟上下（serve.py 带 --preload 一开机就加载），再加上传图 */
const GPU_TIMEOUT_MS = 180_000;
/**
 * 显卡机按这个长边算：表情头像这类小块在 1024 下只有一百来像素，线糊成一团；2048 线细、小字认得出，显卡上约 4 秒。
 * 本机兜底还是 SKETCH_MAX_SIDE（CPU 上 2048 要四倍时间）
 */
const GPU_MAX_SIDE = 2048;
/**
 * 发给显卡机的原图长边上限和 JPEG 质量：往家里传的那个方向最慢，2026-10-17 实测 10～50KB/s，
 * 1024、质量 80 约 120KB；显卡机再放大到 2048 算，线条照样细
 */
const SEND_MAX_SIDE = 1024;
const SEND_QUALITY = 80;

/** 显卡机的线稿接口在不在 */
async function gpuReady(): Promise<boolean> {
  if (!LINEART_URL) return false;
  try {
    const health = await fetch(`${LINEART_URL}/health`, { signal: AbortSignal.timeout(5_000) });
    return health.ok && Boolean(((await health.json()) as { lineart?: boolean }).lineart);
  } catch {
    return false;
  }
}

/**
 * 问显卡机要线稿和主体，按 width × height 算，回来的线稿是 WebP、主体是 PNG，统一存成灰度 PNG。出错回 null，交给本机做。
 * 网很慢（往家里传实测 10～50KB/s、回来约 200KB/s，来回一趟 1 秒），要省传输：发过去的是原图（长边超过 SEND_MAX_SIDE 才缩），
 * 放大到 width × height 由显卡机自己做——放大后的 2048 图要传十几到四十秒，两边从同一张原图放大，结果一样
 */
async function lineartOnGpu(image: Buffer, width: number, height: number): Promise<{ line: Buffer; subject: Buffer | null } | null> {
  try {
    const body = await sharp(image)
      .resize({ width: SEND_MAX_SIDE, height: SEND_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: SEND_QUALITY })
      .toBuffer();
    const res = await fetch(`${LINEART_URL}/lineart?w=${width}&h=${height}`, {
      method: 'POST',
      body: new Uint8Array(body),
      headers: { 'content-type': 'image/jpeg' },
      signal: AbortSignal.timeout(GPU_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reply = (await res.json()) as { line: string; subject: string | null };
    const gray = (b64: string): Promise<Buffer> => sharp(Buffer.from(b64, 'base64')).toColourspace('b-w').png().toBuffer();
    return { line: await gray(reply.line), subject: reply.subject ? await gray(reply.subject) : null };
  } catch (error) {
    console.warn(`[lineart] 显卡机不可用，改在本机做：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function lineartInFlight(): number {
  let n = 0;
  // 线稿出了、主体还在抠的也算：它还要占分层线程
  for (const job of jobs.values()) if (job.state === 'queued' || (job.state === 'done' && job.subject === 'pending')) n++;
  return n;
}

/** 收下一张图（已经规范化过：摆正方向、去掉 EXIF），排队提线稿，返回任务 id */
export async function startLineart(image: Buffer): Promise<string> {
  const id = randomUUID();
  const dir = join(LINEART_DIR, id);
  await mkdir(dir, { recursive: true });
  jobs.set(id, { state: 'queued', createdAt: Date.now() });
  void run(id, dir, image);
  return id;
}

async function run(id: string, dir: string, image: Buffer): Promise<void> {
  const createdAt = jobs.get(id)?.createdAt ?? Date.now();
  try {
    // 先看显卡机在不在，再定按多大算：image.png、line.png、subject.png 三张始终一样大
    const onGpu = await gpuReady();
    // 显卡机那条连小图也放大到 2048（最多放大 2 倍）：线是按像素算的，图放大了线才细；本机不放大
    const { width: w0 = 0, height: h0 = 0 } = await sharp(image).metadata();
    const side = onGpu ? Math.min(GPU_MAX_SIDE, 2 * Math.max(w0, h0)) : SKETCH_MAX_SIDE;
    let png = await sharp(image).resize({ width: side, height: side, fit: 'inside', withoutEnlargement: !onGpu }).png().toBuffer();
    await writeFile(join(dir, 'image.png'), png);
    const { width: pw = 0, height: ph = 0 } = await sharp(png).metadata();
    const gpu = onGpu ? await lineartOnGpu(image, pw, ph) : null;
    if (gpu) {
      const [width, height] = [pw, ph];
      await writeFile(join(dir, 'line.png'), gpu.line);
      if (gpu.subject) await writeFile(join(dir, 'subject.png'), gpu.subject);
      const result: LineartResult = { width, height, subject: gpu.subject !== null };
      await writeFile(join(dir, 'lineart.json'), JSON.stringify(result));
      jobs.set(id, { state: 'done', createdAt, ...result });
      return;
    }
    // 显卡机在但这一下没成：图是按 2048 存的，本机按 1024 重做一份，三张图仍一样大
    if (onGpu) {
      png = await sharp(image).resize({ width: SKETCH_MAX_SIDE, height: SKETCH_MAX_SIDE, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      await writeFile(join(dir, 'image.png'), png);
    }
    const { line, width, height } = await lineartInWorker(new Uint8Array(png), SKETCH_MODEL, false);
    if (!line) throw new Error('分层线程没回线稿');
    // 不指定色彩空间的话 sharp 把单通道当彩色存成 RGB，文件大两倍
    const gray = (plane: Uint8Array): Promise<Buffer> =>
      sharp(plane, { raw: { width, height, channels: 1 } }).toColourspace('b-w').png().toBuffer();
    await writeFile(join(dir, 'line.png'), await gray(line));
    const finish = async (subject: LineartResult['subject']): Promise<void> => {
      const result: LineartResult = { width, height, subject };
      await writeFile(join(dir, 'lineart.json'), JSON.stringify(result));
      jobs.set(id, { state: 'done', createdAt, ...result });
    };
    await finish(MATTE_READY ? 'pending' : false);
    if (!MATTE_READY) return;
    // 抠主体失败不算整个失败：线稿已经给出去了，只是没有「只要主体」
    try {
      const { subject } = await lineartInWorker(new Uint8Array(png), null, true);
      if (subject) await writeFile(join(dir, 'subject.png'), await gray(subject));
      await finish(subject !== null);
    } catch (error) {
      console.error(`[lineart] ${id} 抠主体失败`, error);
      await finish(false);
    }
  } catch (error) {
    console.error(`[lineart] ${id} 失败`, error);
    jobs.set(id, { state: 'error', error: error instanceof Error ? error.message : String(error), createdAt });
  }
}

/** 任务现在怎么样了。内存里没有（重启过）就看磁盘上做完了没有；都没有是 null */
export async function lineartStatus(id: string): Promise<JobState | null> {
  const job = jobs.get(id);
  if (job) return job;
  try {
    return { state: 'done', ...(JSON.parse(await readFile(join(LINEART_DIR, id, 'lineart.json'), 'utf8')) as LineartResult) };
  } catch {
    return null;
  }
}

/** 删掉 24 小时前的结果。和卡片清理一起定时跑 */
export async function sweepLineart(): Promise<number> {
  const now = Date.now();
  let removed = 0;
  for (const [id, job] of jobs) if (now - job.createdAt > TTL_MS) jobs.delete(id);
  for (const name of await readdir(LINEART_DIR).catch(() => [] as string[])) {
    const info = await stat(join(LINEART_DIR, name)).catch(() => null);
    if (info && now - info.mtimeMs > TTL_MS && !jobs.has(name)) {
      await rm(join(LINEART_DIR, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
