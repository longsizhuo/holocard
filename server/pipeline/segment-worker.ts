/**
 * 分层流水线的工作线程。
 *
 * onnxruntime-node 的推理是同步跑在调用它的那个线程上的，切层补洞又是纯 JS。
 * 放在主线程里，一张图要连续占住主线程三四十秒（抠主体二十几秒、深度几秒、切层补洞十来秒），
 * 这期间整个服务不响应：网页打不开、轮询卡住、别人的上传也进不来（线上 2 核实测，一个请求等了 33 秒）。
 * 挪到这里，主线程只管收发请求。
 *
 * 常驻一个，不是每张图起一个：两个模型加载一次要七八秒。
 * ponytail: 一个线程意味着分层一次只做一张，HOLOCARD_CONCURRENCY 调大也不会并行；真要并行再做成线程池
 */

import { parentPort, workerData } from 'node:worker_threads';
import { env } from '@huggingface/transformers';
import type { LayerManifest } from '../../src/format/types';
import { segmentToLayerSet } from '../../src/segmenter';
import { loadDepthModel } from '../../src/segmenter/depth';
import {
  estimateMatte,
  loadMatteModel,
  setMatteModel,
  type MatteModelConfig,
} from '../../src/segmenter/matte';
import { setCpuThreads } from '../../src/segmenter/runtime';
import { SERVER_REFINE_OPTIONS } from '../../src/segmenter/refine';
import { sharpImages } from './images';

/** 起线程时一次性给的配置 */
export interface SegmenterConfig {
  modelDir: string;
  /** 这台服务抠不抠主体（权重在不在、内存上限够不够），决定要不要预加载抠图模型 */
  matte: boolean;
  /** onnxruntime 每次推理开几个线程，按服务分到的核数，见 src/segmenter/runtime.ts 的 setCpuThreads */
  threads: number;
  /** 抠图用哪个模型，见 server/config.ts 的 MATTE_MODEL */
  matteModel: MatteModelConfig;
}

export interface SegmentRequest {
  bytes: Uint8Array<ArrayBuffer>;
  /** 这一张抠不抠主体。除了服务本身能不能抠，还要看这张是不是上次把进程弄崩的那张，由主线程判断 */
  matte: boolean;
}

export type SegmentReply =
  | { type: 'ready' }
  | { type: 'stage'; stage: string }
  | { type: 'done'; manifest: LayerManifest; images: Uint8Array[] }
  | { type: 'error'; message: string };

const port = parentPort;
if (!port) throw new Error('segment-worker 只能当工作线程跑');

const config = workerData as SegmenterConfig;
// transformers 的 env 是每个线程各一份，主线程设的这里看不到
env.localModelPath = config.modelDir;
env.allowRemoteModels = false;
setCpuThreads(config.threads);
setMatteModel(config.matteModel);

// 能走到这里，说明这个线程要用的模块（transformers、onnxruntime-node、sharp……）都加载好了。
// 主线程据此判断健康检查过不过，见 server/pipeline/jobs.ts 的 spawnSegmenter
port.postMessage({ type: 'ready' } satisfies SegmentReply);

/*
 * 模型先加载好：两个加起来七八秒，不预加载的话都算在发版后第一个上传的人头上。
 * 反正处理过一张之后它们就一直在内存里，提前加载不多占。加载失败不要紧，处理时会再试一次
 */
void loadDepthModel().catch(() => undefined);
if (config.matte) void loadMatteModel().catch(() => undefined);

port.on('message', (request: SegmentRequest) => {
  void (async () => {
    try {
      const set = await segmentToLayerSet(new Blob([request.bytes]), {
        subjectModel: config.matteModel.id,
        extract: { images: sharpImages, refine: SERVER_REFINE_OPTIONS },
        onProgress: (p) => port.postMessage({ type: 'stage', stage: p.stage } satisfies SegmentReply),
        ...(request.matte
          ? {
              findSubject: (image: Blob) =>
                estimateMatte(image).catch((error: unknown) => {
                  // 认不出主体（几乎全是前景或全是背景）也走这里，属于正常情况
                  console.warn(`[matte] 不抠主体，只按深度切层：${error instanceof Error ? error.message : String(error)}`);
                  return null;
                }),
            }
          : {}),
      });
      const images = await Promise.all(set.images.map(async (blob) => new Uint8Array(await blob.arrayBuffer())));
      port.postMessage(
        { type: 'done', manifest: set.manifest, images } satisfies SegmentReply,
        images.map((image) => image.buffer as ArrayBuffer),
      );
    } catch (error) {
      port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies SegmentReply);
    }
  })();
});
