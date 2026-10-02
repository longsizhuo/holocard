/**
 * 作者配置：面板上能调、要跟着分享出去的那部分 manifest。
 *
 * 卡的主人调完会存回服务端（PUT /api/cards/:id/config），分享页、OG 预览图、导出的动图都按它来。
 * 只收这几个字段，不收整份 manifest——否则改得动层文件名、深度这些不该由客户端决定的东西。
 * 前端和服务端共用这里的校验，scripts/verify-config.mjs 直接跑它。
 */

import {
  FOIL_TYPES,
  PARALLAX_MAX,
  type FoilType,
  type LayerFoil,
  type LayerManifest,
  type ParallaxEffect,
} from './types';

export interface CardConfig {
  /** 与 manifest.layers 一一对应，由远及近 */
  foils: LayerFoil[];
  halo: { intensity: number; sharpness: number };
  parallax: ParallaxEffect;
}

/** 炫光锐度的合法范围，和面板滑块一致 */
const SHARPNESS_MIN = 10;
const SHARPNESS_MAX = 400;

const inRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** 从当前 manifest 取出作者配置 */
export function configOf(manifest: LayerManifest, parallax: ParallaxEffect): CardConfig {
  return {
    foils: manifest.layers.map((layer) => ({ ...layer.foil })),
    halo: {
      intensity: manifest.effects.halo.intensity,
      sharpness: manifest.effects.halo.light.sharpness,
    },
    parallax: { ...parallax },
  };
}

/** 校验客户端发来的配置。层数必须和这张卡对得上；任何一项不合法整个拒收，返回 null */
export function parseConfig(raw: unknown, layerCount: number): CardConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const foils = o['foils'];
  if (!Array.isArray(foils) || foils.length !== layerCount) return null;
  const parsedFoils: LayerFoil[] = [];
  for (const f of foils) {
    if (typeof f !== 'object' || f === null) return null;
    const { type, intensity } = f as Record<string, unknown>;
    if (!FOIL_TYPES.includes(type as FoilType) || !inRange(intensity, 0, 1)) return null;
    parsedFoils.push({ type: type as FoilType, intensity });
  }

  const halo = o['halo'] as Record<string, unknown> | undefined;
  if (
    !halo ||
    !inRange(halo['intensity'], 0, 1) ||
    !inRange(halo['sharpness'], SHARPNESS_MIN, SHARPNESS_MAX)
  ) {
    return null;
  }

  const parallax = o['parallax'] as Record<string, unknown> | undefined;
  if (
    !parallax ||
    typeof parallax['enabled'] !== 'boolean' ||
    !inRange(parallax['amplitude'], 0, PARALLAX_MAX)
  ) {
    return null;
  }

  return {
    foils: parsedFoils,
    halo: { intensity: halo['intensity'], sharpness: halo['sharpness'] },
    parallax: { enabled: parallax['enabled'], amplitude: parallax['amplitude'] },
  };
}

/** 把配置合并进 manifest（原地改），其余字段不动 */
export function applyConfig(manifest: LayerManifest, config: CardConfig): void {
  manifest.layers.forEach((layer, i) => {
    const foil = config.foils[i];
    if (foil) layer.foil = { ...foil };
  });
  manifest.effects.halo = {
    intensity: config.halo.intensity,
    light: { ...manifest.effects.halo.light, sharpness: config.halo.sharpness },
  };
  manifest.effects.parallax = { ...config.parallax };
}
