/**
 * 线稿提取任务：收一张插画，出白底黑线的线稿灰度图和主体遮罩，深浅、只留主体、线条颜色都在前端调（src/lineart/main.ts）。
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

/** 显卡机冷启动要加载 SAM3（约 40 秒）和线稿模型，再加上传图 */
const GPU_TIMEOUT_MS = 120_000;

/** 问显卡机要线稿和主体（两张灰度 PNG）。不通、出错都回 null，交给本机做 */
async function lineartOnGpu(png: Buffer): Promise<{ line: Buffer; subject: Buffer | null } | null> {
  if (!LINEART_URL) return null;
  try {
    const health = await fetch(`${LINEART_URL}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!health.ok || !((await health.json()) as { lineart?: boolean }).lineart) return null;
    // 发 JPEG：到家里的上行只有约 150KB/s，PNG 要多传好几倍
    const body = await sharp(png).jpeg({ quality: 92 }).toBuffer();
    const res = await fetch(`${LINEART_URL}/lineart`, {
      method: 'POST',
      body: new Uint8Array(body),
      headers: { 'content-type': 'image/jpeg' },
      signal: AbortSignal.timeout(GPU_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reply = (await res.json()) as { line: string; subject: string | null };
    return { line: Buffer.from(reply.line, 'base64'), subject: reply.subject ? Buffer.from(reply.subject, 'base64') : null };
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
  const png = await sharp(image)
    .resize({ width: SKETCH_MAX_SIDE, height: SKETCH_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  await writeFile(join(dir, 'image.png'), png);
  jobs.set(id, { state: 'queued', createdAt: Date.now() });
  void run(id, dir, png);
  return id;
}

async function run(id: string, dir: string, png: Buffer): Promise<void> {
  const createdAt = jobs.get(id)?.createdAt ?? Date.now();
  try {
    const gpu = await lineartOnGpu(png);
    if (gpu) {
      const { width = 0, height = 0 } = await sharp(png).metadata();
      await writeFile(join(dir, 'line.png'), gpu.line);
      if (gpu.subject) await writeFile(join(dir, 'subject.png'), gpu.subject);
      const result: LineartResult = { width, height, subject: gpu.subject !== null };
      await writeFile(join(dir, 'lineart.json'), JSON.stringify(result));
      jobs.set(id, { state: 'done', createdAt, ...result });
      return;
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
