/**
 * 文字检测：卡面上哪里有字。只要位置，不认字。
 *
 * 模型是 PaddleOCR 的 PP-OCRv4 检测器（DB 算法，Apache-2.0），用 RapidOCR 转好的 ONNX：
 *   https://huggingface.co/SWHL/RapidOCR/blob/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx （4.7MB）
 * 中英日混排都认得出位置。输出是每个像素「是字」的概率，卡面遮罩直接拿它当文字层，不用拼成文字框。
 *
 * 预处理照 PaddleOCR 的 det 配置：长边缩到 960 以内、宽高取 32 的倍数，BGR 通道，ImageNet 均值方差
 */

import * as ort from 'onnxruntime-node';

const MAX_SIDE = 960;
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

let session: Promise<ort.InferenceSession> | null = null;

export interface Probability {
  data: Float32Array;
  width: number;
  height: number;
}

/** rgba 是原图尺寸的像素；返回的概率图是缩小后的尺寸，调用方按需放大 */
export async function textProbability(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  modelPath: string,
): Promise<Probability> {
  session ??= ort.InferenceSession.create(modelPath);
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.max(32, Math.round((width * scale) / 32) * 32);
  const h = Math.max(32, Math.round((height * scale) / 32) * 32);
  const plane = w * h;
  const input = new Float32Array(plane * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / w));
      const i = (sy * width + sx) * 4;
      // 通道顺序 BGR，均值方差也按 B、G、R 依次取（PaddleOCR 用 OpenCV 读图，配置里的均值就是这么套的）
      for (let c = 0; c < 3; c++) {
        const v = (rgba[i + 2 - c] ?? 0) / 255;
        input[c * plane + y * w + x] = (v - (MEAN[c] ?? 0)) / (STD[c] ?? 1);
      }
    }
  }
  const s = await session;
  const output = await s.run({ x: new ort.Tensor('float32', input, [1, 3, h, w]) });
  const result = output[s.outputNames[0] ?? ''];
  if (!result) throw new Error('文字检测没有输出');
  return { data: result.data as Float32Array, width: w, height: h };
}
