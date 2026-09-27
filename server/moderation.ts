/**
 * 裸露识别：只记录、不拦。
 *
 * 站点只不接受完全裸露——露出的生殖器、肛门、女性乳房。泳装、低胸、露背、露腹都没问题。
 * 所以不用「整张图有多色情」的分类模型（它们刻意从严，露肤多的也算），而用 NudeNet 这种部位检测模型：
 * 它找的是具体露出了什么，只看上面那几类。
 *
 * 分层完成后给原图打分：这几类里置信度最高的那个，存进 cards.nsfw（0..1）和 cards.nsfw_part（是哪个部位），
 * 用 `node scripts/db.mjs nsfw` 查，删不删由人决定（用 scripts/delete-card.mjs）。
 * 对用户完全无感：不拦上传、不加文案、不影响分享。模型在本机跑，图片不出这台机器。
 *
 * 模型 NudeNet v3.4 的 320n.onnx（YOLOv8n，12MB，AGPL-3.0，和本项目的 GPL-3.0 可以组合：GPLv3 第 13 条），
 * 放在模型目录的 nudenet/ 下。预处理和类别顺序照着它的 nudenet.py（v3 分支）。
 * 链路是否对齐的检验：普通人像上 FACE_FEMALE / FACE_MALE 应该有 0.5 以上的分数，全为 0 就是预处理错了
 */

import { join } from 'node:path';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import sharp from 'sharp';

const INPUT_SIZE = 320;

/** 模型输出的类别顺序，照抄 nudenet.py 的 __labels */
const LABELS = [
  'FEMALE_GENITALIA_COVERED',
  'FACE_FEMALE',
  'BUTTOCKS_EXPOSED',
  'FEMALE_BREAST_EXPOSED',
  'FEMALE_GENITALIA_EXPOSED',
  'MALE_BREAST_EXPOSED',
  'ANUS_EXPOSED',
  'FEET_EXPOSED',
  'BELLY_COVERED',
  'FEET_COVERED',
  'ARMPITS_COVERED',
  'ARMPITS_EXPOSED',
  'FACE_MALE',
  'BELLY_EXPOSED',
  'MALE_GENITALIA_EXPOSED',
  'ANUS_COVERED',
  'FEMALE_BREAST_COVERED',
  'BUTTOCKS_COVERED',
];

/**
 * 算「完全裸露」的部位。露出的臀部不算：丁字泳裤、比基尼背面也会被认成它。
 * 男性胸部、肚子、腋下、脚露出来都是正常的
 */
const NUDE = new Set(['FEMALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'ANUS_EXPOSED', 'FEMALE_BREAST_EXPOSED']);

/** nudenet.py 自己的检测门槛。低于它连「找到了一个框」都不算，部位名只是噪声，不记 */
const DETECTION_FLOOR = 0.2;

let session: Promise<InferenceSession | null> | null = null;

/** 第一次用时加载，之后常驻（模型 12MB，推理只占几十 MB）。加载失败（比如别人自托管时没放模型）是 null，只提示一次 */
function load(modelDir: string): Promise<InferenceSession | null> {
  session ??= InferenceSession.create(join(modelDir, 'nudenet', '320n.onnx')).catch((error: unknown) => {
    console.error(`[nsfw] 模型加载失败，不做识别：${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  return session;
}

export interface Nudity {
  /** 「完全裸露」各部位里置信度最高的那个，0..1 */
  score: number;
  /** 是哪个部位（NudeNet 的类名）。分数低于检测门槛（什么都没找到）时是 null */
  part: string | null;
}

/** 一张原图的裸露识别结果。模型不可用或这张图读不了时返回 null，调用方照常往下走 */
export async function detectNudity(file: string, modelDir: string): Promise<Nudity | null> {
  const model = await load(modelDir);
  if (!model) return null;
  try {
    // 长边缩到模型尺寸，再在右下补黑边成正方形——和 nudenet.py 的「先补边、再缩放」结果一样。
    // 顺序不能反过来写：sharp 不管调用顺序，总是先 resize 后 extend，写成「先补边再缩放」会把图拉扁再补一大块黑边。
    // 存下来的原图上传时已经摆正方向、去掉 EXIF（images.ts 的 normalizeOriginal），这里不用再转
    const { width = 0, height = 0 } = await sharp(file).metadata();
    const scale = INPUT_SIZE / Math.max(width, height, 1);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const { data } = await sharp(file)
      .removeAlpha()
      .resize(w, h, { fit: 'fill' })
      .extend({ right: INPUT_SIZE - w, bottom: INPUT_SIZE - h, background: { r: 0, g: 0, b: 0 } })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (data.length !== INPUT_SIZE * INPUT_SIZE * 3) throw new Error(`预处理尺寸不对：${data.length} 字节`);

    /*
     * HWC 字节 → NCHW 的 0..1 浮点，通道按 B、G、R 排：nudenet.py 读进来是 BGR，
     * cvtColor(RGBA2BGR) 对调一次红蓝，blobFromImage(swapRB=True) 又对调一次，喂给模型的实际是 BGR。
     * 照它来，结果才和作者验证过的一致（实测和 RGB 差别很小）
     */
    const plane = INPUT_SIZE * INPUT_SIZE;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) input[c * plane + i] = (data[i * 3 + (2 - c)] ?? 0) / 255;
    }
    const feeds = { [model.inputNames[0] ?? 'images']: new Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]) };
    const output = (await model.run(feeds))[model.outputNames[0] ?? 'output0'];
    if (!output) return null;

    // 输出是 [1, 4 + 类别数, 候选框数]：每个候选框前 4 个是坐标，后面是各类的分数。
    // 只要「有没有、多确定」，不要框的位置，所以不用做 NMS：直接取目标类别的最大分
    const values = output.data as Float32Array;
    const boxes = output.dims[2] ?? 0;
    let best: Nudity = { score: 0, part: null };
    LABELS.forEach((label, k) => {
      if (!NUDE.has(label)) return;
      const row = (4 + k) * boxes;
      for (let b = 0; b < boxes; b++) {
        const score = values[row + b] ?? 0;
        if (score > best.score) best = { score, part: label };
      }
    });
    return best.score >= DETECTION_FLOOR ? best : { score: best.score, part: null };
  } catch (error) {
    console.error(`[nsfw] ${file} 识别失败`, error);
    return null;
  }
}
