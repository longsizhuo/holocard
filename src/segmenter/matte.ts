/**
 * 前景抠图 —— BiRefNet_lite (MIT)
 *
 * 现状：实验性，默认流程没有接它。在绝大多数机器的浏览器里它跑不起来，实测过四条路：
 *   WebGPU        模型里有个 16 路 Concat，单个着色器要绑 17 个 storage buffer，适配器上限通常是 16
 *   WASM @1024    std::bad_alloc，激活值装不进 32 位寻址的 WASM 堆；关掉 arena 分配器也一样
 *   WASM @512/768 这份 ONNX 导出时把输入焊死在 1024×1024，其他尺寸直接拒收
 * 要真正用上它，得重新导出模型：把那个宽 Concat 拆开，或者放开输入尺寸。
 * 复现方法：node scripts/probe-matte.mjs --image 照片路径
 *
 * 留着这个模块有两个用处：一是能力检查写好了，哪天适配器上限够了可以直接用；
 * 二是边缘精修（refine.ts）的向导是可替换的，任何能产出前景 alpha 的东西都能接进去，
 * 这里定义的 Matte 就是那个接口。
 *
 * 选型备忘：全量 BiRefNet 的 ONNX 有 973MB；RMBG 系列效果相近但都是非商用许可。
 */

import { AutoModel, RawImage, Tensor } from '@huggingface/transformers';
import { configureModelSource, pickDevice, type LoadProgress } from './runtime';

const MODEL_ID = 'onnx-community/BiRefNet_lite-ONNX';

/** 前景 alpha，取值 0..1，1 表示显著主体 */
export interface Matte {
  data: Float32Array;
  width: number;
  height: number;
}

type MatteModel = Awaited<ReturnType<typeof AutoModel.from_pretrained>>;

/** ImageNet 的均值方差，BiRefNet 训练时用的就是这组 */
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

/** BiRefNet 里最宽的那个 Concat 在单个着色器里要绑这么多 storage buffer */
const REQUIRED_STORAGE_BUFFERS = 17;

/** 这台机器跑不了抠图模型。上层应当当作「没有这个功能」处理，而不是报错 */
export class MatteUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatteUnsupportedError';
  }
}

/**
 * BiRefNet 能不能在这台机器上跑，不能的话返回原因。
 *
 * 必须在下载任何权重之前查清楚：109MB 下完才发现跑不了，对用户是纯粹的浪费。
 */
export async function matteUnsupportedReason(): Promise<string | null> {
  if ((await pickDevice()) !== 'webgpu') {
    return '没有 WebGPU；而这个模型在 WASM 上会内存不足';
  }
  type Adapter = { limits?: { maxStorageBuffersPerShaderStage?: number } };
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<Adapter | null> } }).gpu;
  try {
    const adapter = await gpu?.requestAdapter();
    const limit = adapter?.limits?.maxStorageBuffersPerShaderStage ?? 0;
    return limit >= REQUIRED_STORAGE_BUFFERS
      ? null
      : `显卡每个着色器最多绑 ${limit} 个 storage buffer，模型需要 ${REQUIRED_STORAGE_BUFFERS} 个`;
  } catch {
    return '查询显卡能力失败';
  }
}

let loadedPromise: Promise<MatteModel> | null = null;

async function load(onProgress?: (p: LoadProgress) => void): Promise<MatteModel> {
  if (loadedPromise) return loadedPromise;

  loadedPromise = (async () => {
    const reason = await matteUnsupportedReason();
    if (reason) throw new MatteUnsupportedError(reason);

    configureModelSource();
    return AutoModel.from_pretrained(MODEL_ID, {
      device: 'webgpu',
      dtype: 'fp16',
      ...(onProgress ? { progress_callback: (p: unknown) => onProgress(p as LoadProgress) } : {}),
    });
  })();

  try {
    return await loadedPromise;
  } catch (error) {
    loadedPromise = null;
    throw error;
  }
}

/**
 * 输出体检。半精度在某些 GPU 上会数值溢出，表现为整张图全黑、全白或者一片 NaN。
 * 拿这种东西去精修边缘只会把好好的粗切结果弄坏，不如直接报错让上层放弃精修。
 */
function assertUsable(data: Float32Array): void {
  let min = Infinity;
  let max = -Infinity;
  let foreground = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] ?? 0;
    if (Number.isNaN(v)) throw new Error('抠图结果里有 NaN，多半是半精度溢出');
    if (v < min) min = v;
    if (v > max) max = v;
    if (v > 0.5) foreground++;
  }
  if (max - min < 0.5) {
    throw new Error(`抠图结果没有区分度（取值范围 ${min.toFixed(3)}..${max.toFixed(3)}）`);
  }
  const ratio = foreground / data.length;
  if (ratio < 0.002 || ratio > 0.998) {
    throw new Error(`抠图结果几乎全是${ratio < 0.5 ? '背景' : '前景'}，当作失败处理`);
  }
}

/** 自己做预处理而不用 AutoProcessor：输入边长要可控，见 estimateMatte 的说明 */
async function preprocess(image: RawImage, size: number): Promise<Tensor> {
  const resized = await image.rgb().resize(size, size);
  const pixels = resized.data;
  const plane = size * size;
  const data = new Float32Array(plane * 3);
  for (let p = 0; p < plane; p++) {
    for (let c = 0; c < 3; c++) {
      const v = (pixels[p * 3 + c] ?? 0) / 255;
      data[c * plane + p] = (v - (MEAN[c] ?? 0)) / (STD[c] ?? 1);
    }
  }
  return new Tensor('float32', data, [1, 3, size, size]);
}

export interface MatteOptions {
  /** 输入边长。模型按 1024 训练，调小可以省内存，代价是发丝级细节变少 */
  inputSize: number;
  onProgress: (p: LoadProgress) => void;
}

export async function estimateMatte(
  image: Blob,
  options: Partial<MatteOptions> = {},
): Promise<Matte> {
  const model = await load(options.onProgress);
  const input = await RawImage.fromBlob(image);

  const pixel_values = await preprocess(input, options.inputSize ?? 1024);
  const { output_image } = await model({ input_image: pixel_values });

  // 输出是 [1, 1, H, W] 的 logits，过 sigmoid 才是 alpha
  const dims = output_image.dims as number[];
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];
  if (typeof width !== 'number' || typeof height !== 'number') {
    throw new Error(`抠图输出尺寸异常：dims = ${JSON.stringify(dims)}`);
  }

  const logits = output_image.data as Float32Array;
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = 1 / (1 + Math.exp(-(logits[i] ?? 0)));
  }

  assertUsable(data);
  return { data, width, height };
}
