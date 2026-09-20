/**
 * 单目深度估计 —— Depth Anything V2 Small (Apache 2.0)
 *
 * 选它的理由：24.8M 参数、fp16 ONNX 约 50MB、transformers.js 原生支持、
 * 许可证干净。V3 质量更好但官方还没有 ONNX 导出，而且 Large/Giant 是
 * CC-BY-NC，开源项目用不了。
 */

import { pipeline, RawImage } from '@huggingface/transformers';
import { configureModelSource, pickDevice, type LoadProgress } from './runtime';
import type { DepthMap } from './slice';

const MODEL_ID = 'onnx-community/depth-anything-v2-small';

type DepthEstimator = Awaited<ReturnType<typeof pipeline<'depth-estimation'>>>;

/** 模型只加载一次，后续调用复用。浏览器 Cache API 会缓存权重，二次打开是秒开 */
let estimatorPromise: Promise<DepthEstimator> | null = null;

export async function loadDepthModel(
  onProgress?: (p: LoadProgress) => void,
): Promise<DepthEstimator> {
  if (estimatorPromise) return estimatorPromise;

  estimatorPromise = (async () => {
    configureModelSource();
    const device = await pickDevice();

    /*
     * WebGPU 下用 fp16，约 50MB。CPU（Node）和 WASM 上 fp16 都没有加速，
     * 实测 q8 在服务端的 ARM CPU 上既快一倍又省三成内存，所以非 WebGPU 一律 q8。
     * 用 || 而不是 ?? ：环境变量留空时 Vite 注入的是空字符串，?? 拦不住。
     */
    const dtype = import.meta.env.VITE_MODEL_DTYPE || (device === 'webgpu' ? 'fp16' : 'q8');

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
  /** 权重就绪、即将开始推理时回调一次。推理本身没有进度事件，只能给个阶段切换 */
  onModelReady?: () => void,
): Promise<DepthMap> {
  const estimator = await loadDepthModel(onProgress);
  onModelReady?.();
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

  /*
   * 归一化前要先判断这个跨度是不是「真的」。
   *
   * 模型输出的是视差，量级在几十上下。正对着一堵墙拍出来的图，各像素可能是
   * 12.3400、12.3401 这种——跨度相对量级只有 1e-5，全是量化噪声。
   * 无条件按 span 拉满会把这点噪声放大到 0..1，下游看到的是一张满量程的
   * 「深度图」，于是照着噪声切层，切出来的分界毫无意义。
   * 所以用相对阈值：跨度不到量级的千分之一就当作没有深度，全 0 交给下游出一层。
   */
  const span = max - min;
  const scale = Math.max(Math.abs(min), Math.abs(max), 1e-6);
  const normalized = new Float32Array(data.length);
  if (span > scale * 1e-3) {
    for (let i = 0; i < data.length; i++) {
      normalized[i] = ((data[i] ?? 0) - min) / span;
    }
  }

  return { data: normalized, width, height };
}
