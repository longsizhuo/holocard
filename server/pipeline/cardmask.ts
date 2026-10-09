/**
 * 卡面遮罩任务：收一张做好的平面卡图，出边框文字、主角、特效、文字四张遮罩（规则见 src/cardmask/masks.ts）。
 *
 * 模型部分（抠主角、找文字）在分层线程里做，和分层排同一个队（jobs.ts 的 cardmaskInWorker）；
 * 找画框、拼遮罩是纯计算，在主线程做。
 *
 * 结果放在产物目录的 .cardmasks/<id>/ 下：card.png（规范化后的卡图）、frame / character / effects / text.png（灰度 + alpha）、
 * masks.json（尺寸和画框）。不进数据库：没有分享、没有卡册，地址是随机 UUID，24 小时后连目录一起删。
 * 任务状态在内存里，重启后丢了的话，做完的照 masks.json 认，没做完的就是没了，前端提示重试
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { findArtWindow, type Box } from '../../src/cardmask/frame';
import { cardMasks } from '../../src/cardmask/masks';
import { MATTE_READY, MODEL_DIR, OUT_DIR } from '../config';
import { cardmaskInWorker } from './jobs';

export const CARDMASK_DIR = join(OUT_DIR, '.cardmasks');
/** 文字检测的权重（下载见 server/pipeline/textdet.ts） */
const TEXT_MODEL = join(MODEL_DIR, 'RapidOCR', 'ch_PP-OCRv4_det_infer.onnx');
/** 卡图长边缩到这么多以内：遮罩用不着更细，规则里的距离变换按像素算，图大了慢 */
const MAX_SIDE = 1400;
/** 同时排着和在做的卡面遮罩最多几个。一张要二三十秒（主要是抠图），和分层共用一个线程 */
export const MAX_CARDMASK_QUEUE = 4;
/** 结果留多久 */
const TTL_MS = 24 * 60 * 60 * 1000;

/** 产出的文件，和给前端看的名字 */
export const CARDMASK_FILES = ['card', 'frame', 'character', 'effects', 'text'] as const;
export type CardmaskFile = (typeof CARDMASK_FILES)[number];

export interface CardmaskResult {
  width: number;
  height: number;
  /** 找到的画框，按宽高归一化；全图卡为 null */
  window: Box | null;
}

type JobState = { state: 'queued' | 'running' } | { state: 'error'; error: string } | ({ state: 'done' } & CardmaskResult);

const jobs = new Map<string, JobState & { createdAt: number }>();

/** 这台服务能不能做卡面遮罩：抠图和文字检测的权重都要在 */
export function cardmaskAvailable(): boolean {
  return MATTE_READY && existsSync(TEXT_MODEL);
}

export function cardmaskInFlight(): number {
  let n = 0;
  for (const job of jobs.values()) if (job.state === 'queued' || job.state === 'running') n++;
  return n;
}

/** 收下一张卡图（已经规范化过：摆正方向、去掉 EXIF），排队出遮罩，返回任务 id */
export async function startCardmask(image: Buffer): Promise<string> {
  const id = randomUUID();
  const dir = join(CARDMASK_DIR, id);
  await mkdir(dir, { recursive: true });
  const card = await sharp(image)
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  await writeFile(join(dir, 'card.png'), card);
  jobs.set(id, { state: 'queued', createdAt: Date.now() });
  void run(id, dir, card);
  return id;
}

async function run(id: string, dir: string, card: Buffer): Promise<void> {
  const createdAt = jobs.get(id)?.createdAt ?? Date.now();
  try {
    const { data, info } = await sharp(card).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const window = findArtWindow(data, info.width, info.height);
    jobs.set(id, { state: 'running', createdAt });
    const { matte, text } = await cardmaskInWorker(new Uint8Array(card), window ?? { x: 0, y: 0, w: 1, h: 1 }, TEXT_MODEL);
    // 抠图的结果只覆盖 region，铺回整张卡的尺寸；认不出主角就是全空
    const character = new Float32Array(info.width * info.height);
    if (matte) {
      const region = window ?? { x: 0, y: 0, w: 1, h: 1 };
      const left = Math.round(region.x * info.width);
      const top = Math.round(region.y * info.height);
      const w = Math.round(region.w * info.width);
      const h = Math.round(region.h * info.height);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const mx = Math.min(matte.width - 1, Math.floor((x / w) * matte.width));
          const my = Math.min(matte.height - 1, Math.floor((y / h) * matte.height));
          character[(top + y) * info.width + left + x] = matte.data[my * matte.width + mx] ?? 0;
        }
      }
    }
    const masks = cardMasks(data, info.width, info.height, window, { data: character, width: info.width, height: info.height }, text);
    /*
     * 灰度 + alpha 两个通道，都等于遮罩值。CSS 的 mask-image 默认按 alpha 用（pokemon-cards-css 的遮罩就是带 alpha 的），
     * 按亮度用（mask-mode: luminance）、在看图软件里看也对
     */
    const png = (plane: Uint8Array): Promise<Buffer> => {
      const ga = Buffer.alloc(plane.length * 2);
      for (let i = 0; i < plane.length; i++) ga[i * 2] = ga[i * 2 + 1] = plane[i] ?? 0;
      // 不指定色彩空间的话 sharp 会把两通道当彩色存成 RGBA，文件大一倍
      return sharp(ga, { raw: { width: info.width, height: info.height, channels: 2 } }).toColourspace('b-w').png().toBuffer();
    };
    await Promise.all([
      writeFile(join(dir, 'frame.png'), await png(masks.frame)),
      writeFile(join(dir, 'character.png'), await png(masks.character)),
      writeFile(join(dir, 'effects.png'), await png(masks.effects)),
      writeFile(join(dir, 'text.png'), await png(masks.text)),
    ]);
    const result: CardmaskResult = { width: info.width, height: info.height, window };
    await writeFile(join(dir, 'masks.json'), JSON.stringify(result));
    jobs.set(id, { state: 'done', createdAt, ...result });
  } catch (error) {
    console.error(`[cardmask] ${id} 失败`, error);
    jobs.set(id, { state: 'error', error: error instanceof Error ? error.message : String(error), createdAt });
  }
}

/** 任务现在怎么样了。内存里没有（重启过）就看磁盘上做完了没有；都没有是 null */
export async function cardmaskStatus(id: string): Promise<JobState | null> {
  const job = jobs.get(id);
  if (job) return job;
  try {
    const result = JSON.parse(await readFile(join(CARDMASK_DIR, id, 'masks.json'), 'utf8')) as CardmaskResult;
    return { state: 'done', ...result };
  } catch {
    return null;
  }
}

/** 删掉 24 小时前的结果。和卡片清理一起定时跑 */
export async function sweepCardmasks(): Promise<number> {
  const now = Date.now();
  let removed = 0;
  for (const [id, job] of jobs) if (now - job.createdAt > TTL_MS) jobs.delete(id);
  for (const name of await readdir(CARDMASK_DIR).catch(() => [] as string[])) {
    const info = await stat(join(CARDMASK_DIR, name)).catch(() => null);
    if (info && now - info.mtimeMs > TTL_MS && !jobs.has(name)) {
      await rm(join(CARDMASK_DIR, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
