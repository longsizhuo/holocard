/** 深度模型和抠图模型共用的运行时配置：权重从哪来、在什么设备上跑 */

import { env } from '@huggingface/transformers';

/** 模型加载进度，透传给 UI 做进度条 */
export interface LoadProgress {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

export type Device = 'webgpu' | 'wasm';

let configured = false;

/**
 * 配置权重来源。
 *
 * 默认走 Hugging Face 官方 CDN——模型本来就公开托管在那里，
 * 我们一台服务器都不用出，也没有带宽账单。
 *
 * 但 huggingface.co 在中国大陆访问困难，所以留了构建期覆盖：
 *   VITE_MODEL_HOST=https://hf-mirror.com/
 * 也可以指向自己的 R2 / OSS / jsDelivr 镜像，见 README 的部署一节。
 */
export function configureModelSource(): void {
  if (configured) return;
  configured = true;

  const host = import.meta.env.VITE_MODEL_HOST;
  if (host) env.remoteHost = host;

  const template = import.meta.env.VITE_MODEL_PATH_TEMPLATE;
  if (template) env.remotePathTemplate = template;
}

let devicePromise: Promise<Device> | null = null;

/** 探测 WebGPU 是否可用。不可用就退回 WASM，慢很多但至少能跑 */
export function pickDevice(): Promise<Device> {
  devicePromise ??= (async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return 'wasm';
    try {
      const adapter = await gpu.requestAdapter();
      return adapter ? 'webgpu' : 'wasm';
    } catch {
      // 有些环境有 navigator.gpu 但握手会抛，一律退回 WASM
      return 'wasm';
    }
  })();
  return devicePromise;
}
