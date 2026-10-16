/**
 * 线稿：Anime2Sketch（MIT，https://github.com/Mukosame/Anime2Sketch）的 improved 版——反卷积换成「放大 + 卷积」，
 * 没有原版的棋盘格伪影。原仓库的 PyTorch 模型用 deploy/lineart/export_onnx.py 导出成 ONNX（宽高可变）。
 *
 * 输入 [-1, 1] 的 RGB，宽高须是 256 的倍数；输出白底黑线的灰度，线常常偏淡，深浅交给前端按滑块拉（src/lineart/main.ts）。
 * 原仓库把图压成 512 的正方形再算，竖长的图线条会变形；这里按比例缩到长边 1024，四周复制边缘像素补到 256 的倍数，算完裁回来
 */

import * as ort from 'onnxruntime-node';
import { cpuSessionOptions } from '../../src/segmenter/runtime';

/** 长边缩到这么多以内：4 核 ARM 上一张约 3 秒；再大内存和时间都翻倍，线也不会更清楚 */
export const SKETCH_MAX_SIDE = 1024;
const MULTIPLE = 256;

let session: Promise<ort.InferenceSession> | null = null;

/** rgb 是已经缩到 SKETCH_MAX_SIDE 以内的三通道像素；返回同尺寸的灰度线稿（0 黑 255 白） */
export async function sketch(rgb: Uint8Array, width: number, height: number, modelPath: string): Promise<Uint8Array> {
  // 线程数按服务分到的核数（分层线程启动时设好），线上 CPUQuota 只给 2 核，开满 4 个线程反而互相抢
  session ??= ort.InferenceSession.create(modelPath, cpuSessionOptions());
  const w = Math.ceil(width / MULTIPLE) * MULTIPLE;
  const h = Math.ceil(height / MULTIPLE) * MULTIPLE;
  const plane = w * h;
  const input = new Float32Array(plane * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, y);
    for (let x = 0; x < w; x++) {
      const i = (sy * width + Math.min(width - 1, x)) * 3;
      for (let c = 0; c < 3; c++) input[c * plane + y * w + x] = (rgb[i + c] ?? 0) / 127.5 - 1;
    }
  }
  const s = await session;
  const output = await s.run({ image: new ort.Tensor('float32', input, [1, 3, h, w]) });
  const result = output[s.outputNames[0] ?? '']?.data as Float32Array | undefined;
  if (!result) throw new Error('线稿模型没有输出');
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) gray[y * width + x] = Math.round(Math.min(1, Math.max(0, ((result[y * w + x] ?? 1) + 1) / 2)) * 255);
  }
  return gray;
}
