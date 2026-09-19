/** .layers 的读写与校验 */

import {
  DEFAULT_HALO_LIGHT,
  FOIL_TYPES,
  LAYERS_FORMAT_VERSION,
  defaultFoilFor,
  defaultHalo,
  type BBox,
  type FoilType,
  type LayerEntry,
  type LayerFoil,
  type LayerManifest,
  type LayerSet,
} from './types';

/** manifest 校验失败时抛出，带上具体原因便于排查坏数据 */
export class LayerFormatError extends Error {
  constructor(message: string) {
    super(`[.layers] ${message}`);
    this.name = 'LayerFormatError';
  }
}

/** 合法的层文件名：不含路径分隔符，只能是 manifest 同目录下的文件 */
const SAFE_FILENAME = /^[^/\\]+$/;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isFoilType(v: unknown): v is FoilType {
  return typeof v === 'string' && (FOIL_TYPES as readonly string[]).includes(v);
}

function parseBBox(raw: unknown, index: number): BBox {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(isFiniteNumber)) {
    throw new LayerFormatError(`第 ${index} 层的 bbox 必须是 4 个数字`);
  }
  const [x, y, w, h] = raw as number[];
  return [x!, y!, w!, h!] as const;
}

/** foil 缺省或写错时返回 null，由调用方按层序补默认值 */
function parseFoil(raw: unknown): LayerFoil | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isFoilType(o['type'])) return null;
  const intensity = isFiniteNumber(o['intensity']) ? Math.min(1, Math.max(0, o['intensity'])) : 1;
  return { type: o['type'], intensity };
}

/** 解析单层。foil 先留空位，等全部层排好序、知道层序之后再补默认值 */
function parseLayer(raw: unknown, index: number): Omit<LayerEntry, 'foil'> & { foil: LayerFoil | null } {
  if (typeof raw !== 'object' || raw === null) {
    throw new LayerFormatError(`第 ${index} 层不是对象`);
  }
  const o = raw as Record<string, unknown>;

  if (typeof o['file'] !== 'string' || o['file'].length === 0) {
    throw new LayerFormatError(`第 ${index} 层缺少 file 字段`);
  }
  // 防目录穿越：manifest 可能来自用户上传的压缩包
  if (o['file'].includes('..') || !SAFE_FILENAME.test(o['file'])) {
    throw new LayerFormatError(`第 ${index} 层的 file 只能是同目录下的文件名`);
  }
  if (!isFiniteNumber(o['depth'])) {
    throw new LayerFormatError(`第 ${index} 层的 depth 不是数字`);
  }

  return {
    file: o['file'],
    depth: o['depth'],
    // parallax 缺省时从 depth 推导，让手写 manifest 更省事
    parallax: isFiniteNumber(o['parallax']) ? o['parallax'] : o['depth'],
    bbox: parseBBox(o['bbox'], index),
    inpainted: o['inpainted'] === true,
    foil: parseFoil(o['foil']),
  };
}

/** 把任意 JSON 解析成 LayerManifest，字段缺失时给出可用的默认值 */
export function parseManifest(raw: unknown): LayerManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new LayerFormatError('manifest 不是对象');
  }
  const o = raw as Record<string, unknown>;

  if (o['version'] !== LAYERS_FORMAT_VERSION) {
    throw new LayerFormatError(
      `版本不匹配：期望 ${LAYERS_FORMAT_VERSION}，实际 ${String(o['version'])}`,
    );
  }

  const source = o['source'] as Record<string, unknown> | undefined;
  if (!source || !isFiniteNumber(source['width']) || !isFiniteNumber(source['height'])) {
    throw new LayerFormatError('source.width / source.height 缺失');
  }

  if (!Array.isArray(o['layers']) || o['layers'].length === 0) {
    throw new LayerFormatError('layers 为空');
  }
  const parsed = o['layers'].map(parseLayer);

  // 渲染器依赖「数组顺序 == 由远及近」这个不变量，这里强制成立
  parsed.sort((a, b) => a.depth - b.depth);

  // 层序定下来之后才能补默认箔面：最远层上箔、最近层哑光
  const layers: LayerEntry[] = parsed.map((layer, i) => ({
    ...layer,
    foil: layer.foil ?? defaultFoilFor(i, parsed.length),
  }));

  const fallback = defaultHalo();
  const effects = (o['effects'] ?? {}) as Record<string, unknown>;
  const halo = (effects['halo'] ?? {}) as Record<string, unknown>;
  const light = (halo['light'] ?? {}) as Record<string, unknown>;

  const rawPeak = light['peakAt'];
  const peakAt: readonly [number, number] =
    Array.isArray(rawPeak) && rawPeak.length === 2 && rawPeak.every(isFiniteNumber)
      ? [rawPeak[0] as number, rawPeak[1] as number]
      : DEFAULT_HALO_LIGHT.peakAt;

  const manifest: LayerManifest = {
    version: LAYERS_FORMAT_VERSION,
    source: { width: source['width'], height: source['height'] },
    layers,
    effects: {
      halo: {
        intensity: isFiniteNumber(halo['intensity']) ? halo['intensity'] : fallback.intensity,
        light: {
          peakAt,
          sharpness: isFiniteNumber(light['sharpness'])
            ? light['sharpness']
            : DEFAULT_HALO_LIGHT.sharpness,
        },
      },
      glare: effects['glare'] !== false,
    },
  };
  if (typeof o['generator'] === 'string') {
    manifest.generator = o['generator'];
  }
  return manifest;
}

/**
 * 从一个 .layers 目录的 URL 加载完整层集合。
 * baseUrl 指向目录本身，例如 "/samples/forest"。
 */
export async function loadLayerSet(baseUrl: string, signal?: AbortSignal): Promise<LayerSet> {
  const base = baseUrl.replace(/\/+$/, '');
  const init: RequestInit = signal ? { signal } : {};

  const res = await fetch(`${base}/manifest.json`, init);
  if (!res.ok) {
    throw new LayerFormatError(`读取 manifest 失败：HTTP ${res.status}`);
  }
  const manifest = parseManifest(await res.json());

  // 并行拉取所有层，层数很少（2~5），不必限流
  const images = await Promise.all(
    manifest.layers.map(async (layer) => {
      const imgRes = await fetch(`${base}/${layer.file}`, init);
      if (!imgRes.ok) {
        throw new LayerFormatError(`读取 ${layer.file} 失败：HTTP ${imgRes.status}`);
      }
      return imgRes.blob();
    }),
  );

  return { manifest, images };
}
