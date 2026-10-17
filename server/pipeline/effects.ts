/**
 * 特效识别：把图发给 SAM3-Card 识别服务（deploy/sam3/serve.py），拿回每类特效的遮罩，交给分层流水线做特效层。
 *
 * 按顺序问几个地址（server/config.ts 的 EFFECTS_URLS）：先显卡机（经 ssh 隧道，一张约 0.5 秒加传输），
 * 不通再问本机的 CPU 兜底（一张约一分半，模型闲置卸掉后再加载还要一分钟）。都不通就当没有特效，卡照做。
 * 在分层工作线程里跑，和估深度、抠主体同时进行
 */

import sharp from 'sharp';
import { EFFECT_KINDS, type EffectKind } from '../../src/format/types';
import type { EffectMask } from '../../src/segmenter';

/** 发过去的图缩到这么大：模型输入就是 1008，再大也是白传（Oracle 到家里的上行只有约 150KB/s） */
const SEND_SIZE = 1008;
/** 先问一声在不在。隧道还连着但显卡机已经关机时，请求会一直挂着，不先问就要等到下面的总超时 */
const HEALTH_TIMEOUT_MS = 5_000;
/** CPU 兜底最慢：冷启动加载一分钟 + 识别一分半，机器忙时更久 */
const DETECT_TIMEOUT_MS = 5 * 60_000;

interface Reply {
  effects: { type: string; score: number; mask: string }[];
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function detectEffects(image: Blob, urls: readonly string[]): Promise<EffectMask[] | null> {
  if (urls.length === 0) return null;
  const body = await sharp(Buffer.from(await image.arrayBuffer()))
    .rotate()
    .resize(SEND_SIZE, SEND_SIZE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  for (const url of urls) {
    let reply: Reply;
    try {
      const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (!health.ok) throw new Error(`health HTTP ${health.status}`);
      const res = await fetch(`${url}/effects`, {
        method: 'POST',
        body: new Uint8Array(body),
        headers: { 'content-type': 'image/jpeg' },
        signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      reply = (await res.json()) as Reply;
    } catch (error) {
      console.warn(`[effects] ${url} 不可用：${message(error)}`);
      continue;
    }
    const known = reply.effects.filter((e) => EFFECT_KINDS.includes(e.type as EffectKind));
    console.log(`[effects] ${url}：${known.map((e) => `${e.type}@${e.score}`).join(' ') || '没有特效'}`);
    return Promise.all(
      known.map(async (e) => {
        const { data, info } = await sharp(Buffer.from(e.mask, 'base64')).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
        return { kind: e.type as EffectKind, data: Float32Array.from(data, (v) => v / 255), width: info.width, height: info.height };
      }),
    );
  }
  return null;
}
