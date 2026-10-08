import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lang } from '../../src/i18n/core';
import { OUT_DIR, PORT } from '../config';
import { db } from '../store';
import { renderPreview } from './preview';

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

export function previewFile(lang: Lang): string {
  return lang === 'zh' ? 'preview.jpg' : `preview-${lang}.jpg`;
}

export function queuePreview(id: string, lang: Lang): void {
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

/*
 * 分享过、却没有分享图的卡补渲染一遍（中文那张；别的语言有人打开时再补）。
 * 以前渲染失败就算了，上线头一天 32 张分享过的卡里有 23 张没图。
 * 排在队列里一张张来，不耽误启动；要等服务开始监听之后再调——渲染页是从本服务取的。
 */
export async function backfillPreviews(): Promise<void> {
  let missing = 0;
  for (const card of db.byStatus('done')) {
    if (!card.shared) continue;
    if (await stat(join(OUT_DIR, card.id, previewFile('zh'))).catch(() => null)) continue;
    queuePreview(card.id, 'zh');
    missing++;
  }
  if (missing > 0) console.log(`[preview] ${missing} 张分享过的卡缺分享图，排队补渲染`);
}
