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

/**
 * onnxruntime 的执行后端。
 *   webgpu  浏览器里有可用显卡时
 *   wasm    浏览器里没有显卡时
 *   cpu     Node（onnxruntime-node 不认 wasm，只有 cpu / dml / webgpu）
 */
export type Device = 'webgpu' | 'wasm' | 'cpu';

/** 当前是不是跑在 Node 里 */
function isNode(): boolean {
  return typeof process !== 'undefined' && process.versions?.node !== undefined;
}

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

/**
 * 浏览器端退回处理时，优先从本站的 /models/ 取权重（服务端把自己在用的 q8 权重原样发出来）。
 *
 * 默认的 Hugging Face 官方 CDN 在国内基本连不上。埋点里查到过：服务端一抖、前端退回本机处理，
 * 模型下不来，用户看到的就是一句「Load failed」。本站能打开，权重就能下。
 * 纯静态自托管（没有后端、也就没有 /models/）或者构建时指定了 VITE_MODEL_HOST 的，照旧。
 *
 * 返回是不是用上了本站：本站只有 q8 一种精度，调用方据此选精度和设备。
 */
export async function useOwnModelHost(modelId: string): Promise<boolean> {
  configureModelSource();
  if (isNode() || import.meta.env.VITE_MODEL_HOST) return false;

  const base = `${location.origin}${import.meta.env.BASE_URL}models/`;
  try {
    const res = await fetch(`${base}${modelId}/config.json`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  env.remoteHost = base;
  env.remotePathTemplate = '{model}/';
  return true;
}

let devicePromise: Promise<Device> | null = null;

/** 探测 WebGPU 是否可用。不可用就退回 WASM，慢很多但至少能跑 */
export function pickDevice(): Promise<Device> {
  devicePromise ??= (async () => {
    // Node 侧没有 WebGPU，也不支持 wasm 后端，直接用 cpu
    if (isNode()) return 'cpu';

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
