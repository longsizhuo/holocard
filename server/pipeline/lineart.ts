/**
 * 线稿提取任务：收一张插画，出白底黑线的线稿灰度图和主体遮罩，深浅、只留主体、线条颜色都在前端调（src/lineart/main.ts）。
 *
 * 模型部分（线稿、抠主体）在分层线程里做，和分层排同一个队（jobs.ts 的 lineartInWorker）。
 * 结果放在产物目录的 .lineart/<id>/ 下：image.png（缩到线稿尺寸的原图）、line.png（灰度线稿）、subject.png（主体遮罩，抠不了时没有）、
 * lineart.json（尺寸、有没有主体）。不进数据库，地址是随机 UUID，24 小时后删。任务状态在内存里，重启后做完的照 lineart.json 认
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { MATTE_READY, MODEL_DIR, OUT_DIR } from '../config';
import { lineartInWorker } from './jobs';
import { SKETCH_MAX_SIDE } from './sketch';

export const LINEART_DIR = join(OUT_DIR, '.lineart');
/** 线稿模型（导出见 deploy/lineart/export_onnx.py） */
const SKETCH_MODEL = join(MODEL_DIR, 'anime2sketch', 'anime2sketch-improved.onnx');
/** 同时排着和在做的最多几个：一张约半分钟（主要是抠主体），和分层共用一个线程 */
export const MAX_LINEART_QUEUE = 4;
const TTL_MS = 24 * 60 * 60 * 1000;

export const LINEART_FILES = ['image', 'line', 'subject'] as const;

export interface LineartResult {
  width: number;
  height: number;
  /** 有没有主体遮罩：这台服务不抠图、或者认不出主体时没有，前端藏起「只要主体」 */
  subject: boolean;
}

type JobState = { state: 'queued' } | { state: 'error'; error: string } | ({ state: 'done' } & LineartResult);

const jobs = new Map<string, JobState & { createdAt: number }>();

/** 这台服务能不能提线稿：线稿模型要在；抠图权重没有也能做，只是没有「只要主体」 */
export function lineartAvailable(): boolean {
  return existsSync(SKETCH_MODEL);
}

export function lineartInFlight(): number {
  let n = 0;
  for (const job of jobs.values()) if (job.state === 'queued') n++;
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
    const { line, subject, width, height } = await lineartInWorker(new Uint8Array(png), SKETCH_MODEL, MATTE_READY);
    // 不指定色彩空间的话 sharp 把单通道当彩色存成 RGB，文件大两倍
    const gray = (plane: Uint8Array): Promise<Buffer> =>
      sharp(plane, { raw: { width, height, channels: 1 } }).toColourspace('b-w').png().toBuffer();
    await writeFile(join(dir, 'line.png'), await gray(line));
    if (subject) await writeFile(join(dir, 'subject.png'), await gray(subject));
    const result: LineartResult = { width, height, subject: subject !== null };
    await writeFile(join(dir, 'lineart.json'), JSON.stringify(result));
    jobs.set(id, { state: 'done', createdAt, ...result });
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
