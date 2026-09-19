/**
 * 单目深度估计 —— Depth Anything V2 Small (Apache 2.0)
 *
 * 选它的理由：24.8M 参数、fp16 ONNX 约 50MB、transformers.js 原生支持、
 * 许可证干净。V3 质量更好但官方还没有 ONNX 导出，而且 Large/Giant 是
 * CC-BY-NC，开源项目用不了。
 */

import { env, pipeline, RawImage } from '@huggingface/transformers';
import type { DepthMap } from './slice';

const MODEL_ID = 'onnx-community/depth-anything-v2-small';

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
function configureModelSource(): void {
  const host = import.meta.env.VITE_MODEL_HOST;
  if (host) env.remoteHost = host;

  const template = import.meta.env.VITE_MODEL_PATH_TEMPLATE;
  if (template) env.remotePathTemplate = template;
}

/** 模型加载进度，透传给 UI 做进度条 */
export interface LoadProgress {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

type DepthEstimator = Awaited<ReturnType<typeof pipeline<'depth-estimation'>>>;

/** 模型只加载一次，后续调用复用。浏览器 Cache API 会缓存权重，二次打开是秒开 */
let estimatorPromise: Promise<DepthEstimator> | null = null;

/** 探测 WebGPU 是否可用。不可用就退回 WASM，慢很多但至少能跑 */
async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return 'wasm';
  try {
    const adapter = await gpu.requestAdapter();
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    // 有些环境有 navigator.gpu 但握手会抛，一律退回 WASM
    return 'wasm';
  }
}

export async function loadDepthModel(
  onProgress?: (p: LoadProgress) => void,
): Promise<DepthEstimator> {
  if (estimatorPromise) return estimatorPromise;

  estimatorPromise = (async () => {
    configureModelSource();
    const device = await pickDevice();

    // WebGPU 下用 fp16，约 50MB；WASM 上 fp16 没有加速，不如 q8。
    // 想进一步压下载量可以在构建期强制 q8，代价是深度图细节略糊。
    const dtype = import.meta.env.VITE_MODEL_DTYPE ?? (device === 'webgpu' ? 'fp16' : 'q8');

    return pipeline('depth-estimation', MODEL_ID, {
      device,
      dtype,
      ...(onProgress ? { progress_callback: (p: unknown) => onProgress(p as LoadProgress) } : {}),
    });
  })();

  try {
    return await estimatorPromise;
  } catch (error) {
    // 加载失败要清掉缓存的 promise，否则后续重试会一直拿到同一个失败结果
    estimatorPromise = null;
    throw error;
  }
}

/**
 * 估计深度并归一化到 0..1。
 *
 * Depth Anything 输出的是视差（disparity）而不是真实距离：值越大越近。
 * 这正好对上我们「1 = 最近」的约定，不需要翻转。
 */
export async function estimateDepth(
  image: Blob,
  onProgress?: (p: LoadProgress) => void,
): Promise<DepthMap> {
  const estimator = await loadDepthModel(onProgress);
  const input = await RawImage.fromBlob(image);

  const result = await estimator(input);
  // 单张输入时 pipeline 返回单个对象，这里收窄掉数组分支
  const output = Array.isArray(result) ? result[0] : result;
  if (!output) throw new Error('深度估计没有返回结果');

  const tensor = output.predicted_depth;
  const data = tensor.data as Float32Array;

  // dims 可能是 [H, W] 也可能带 batch 维 [1, H, W]，取最后两维
  const dims = tensor.dims;
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];
  if (typeof width !== 'number' || typeof height !== 'number') {
    throw new Error(`深度图尺寸异常：dims = ${JSON.stringify(dims)}`);
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const span = max - min;
  const normalized = new Float32Array(data.length);
  if (span > 0) {
    for (let i = 0; i < data.length; i++) {
      normalized[i] = ((data[i] ?? 0) - min) / span;
    }
  }
  // span 为 0 说明整图深度一致（纯色图之类），全 0 即可，后续会走等质量兜底

  return { data: normalized, width, height };
}
