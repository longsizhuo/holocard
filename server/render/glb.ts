/**
 * 导出 3D 模型（glTF 二进制，.glb）：给想在 Blender、Unity、Godot、three.js 里自己渲染的人。
 *
 * 每层一块带透明的平面，按视差前后错开：卡面在 XY 平面，高 1、宽按原图比例，朝 +Z（近处的层 z 更大）。
 * 层图用不受光照的材质（KHR_materials_unlit），导进去颜色和原图一样；透明度即这一层箔面的遮罩。
 * 箔面是网页里的 CSS 效果，带不过去：配方、强度、特效类型、深度和视差写在每个节点的 extras 里，
 * 怎么渲染由用的人决定。不选 FBX：私有格式、没有好用的开源写入；Blender 能把 glb 再导出成 fbx。
 * 规范见 Khronos glTF 2.0
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { LayerManifest } from '../../src/format/types';
import { crop, layerName, opaqueBox, rgbaOf } from './psd';

/** 视差最大（parallax = 1）的层离最远的层多远，按卡高算 */
const DEPTH_SPAN = 0.06;
/** 同一视差的层（景深层和它的特效层）之间错开一点，免得在引擎里互相闪烁 */
const STACK_GAP = 0.0005;

export async function buildGlb(dir: string): Promise<Buffer> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as LayerManifest;
  const first = manifest.layers[0];
  if (!first) throw new Error('这张卡没有层');
  const meta = await sharp(join(dir, first.file)).metadata();
  const W = meta.width ?? manifest.source.width;
  const H = meta.height ?? manifest.source.height;
  const aspect = W / H;

  const bin: Buffer[] = [];
  let binLength = 0;
  const bufferViews: object[] = [];
  /** 往二进制块里追加一段（按 4 字节对齐），返回 bufferView 的序号 */
  const addView = (data: Buffer, target?: number): number => {
    const pad = (4 - (binLength % 4)) % 4;
    if (pad) {
      bin.push(Buffer.alloc(pad));
      binLength += pad;
    }
    bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.length, ...(target ? { target } : {}) });
    bin.push(data);
    binLength += data.length;
    return bufferViews.length - 1;
  };

  // 所有平面共用一套贴图坐标和三角形：每层的贴图就是裁好的那块
  const uv = Buffer.from(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]).buffer);
  const indices = Buffer.from(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer);
  const accessors: object[] = [
    { bufferView: addView(uv, 34962), componentType: 5126, count: 4, type: 'VEC2' },
    { bufferView: addView(indices, 34963), componentType: 5123, count: 6, type: 'SCALAR' },
  ];

  const depthLayers = manifest.layers.filter((l) => l.role !== 'effects');
  const images: object[] = [];
  const textures: object[] = [];
  const materials: object[] = [];
  const meshes: object[] = [];
  const nodes: object[] = [];
  for (const [i, layer] of manifest.layers.entries()) {
    const full = await rgbaOf(await readFile(join(dir, layer.file)), W, H);
    const [x, y, w, h] = opaqueBox(full, W, H);
    const png = await sharp(crop(full, W, x, y, w, h), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    images.push({ bufferView: addView(png), mimeType: 'image/png' });
    textures.push({ source: images.length - 1, sampler: 0 });
    const name = layerName(layer, depthLayers);
    materials.push({
      name,
      pbrMetallicRoughness: { baseColorTexture: { index: textures.length - 1 }, metallicFactor: 0, roughnessFactor: 1 },
      alphaMode: 'BLEND',
      doubleSided: true,
      extensions: { KHR_materials_unlit: {} },
    });

    // 像素坐标换成卡面坐标：原点在卡面中心，y 向上
    const left = (x / W - 0.5) * aspect;
    const right = ((x + w) / W - 0.5) * aspect;
    const top = 0.5 - y / H;
    const bottom = 0.5 - (y + h) / H;
    const z = layer.parallax * DEPTH_SPAN + i * STACK_GAP;
    const position = new Float32Array([left, bottom, z, right, bottom, z, right, top, z, left, top, z]);
    accessors.push({
      bufferView: addView(Buffer.from(position.buffer), 34962),
      componentType: 5126,
      count: 4,
      type: 'VEC3',
      min: [left, bottom, z],
      max: [right, top, z],
    });
    meshes.push({
      name,
      primitives: [{ attributes: { POSITION: accessors.length - 1, TEXCOORD_0: 0 }, indices: 1, material: materials.length - 1 }],
    });
    nodes.push({
      name,
      mesh: meshes.length - 1,
      extras: {
        file: layer.file,
        depth: layer.depth,
        parallax: layer.parallax,
        foil: layer.foil,
        ...(layer.role ? { role: layer.role, effect: layer.effect ?? 'energy' } : {}),
      },
    });
  }

  const json = {
    asset: { version: '2.0', generator: 'HoloCard' },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes: [{ name: 'HoloCard', nodes: [nodes.length] }],
    // 一个父节点挂所有层，整张卡一起移动、旋转；整卡的炫光、高光参数也挂在这里
    nodes: [...nodes, { name: 'HoloCard', children: nodes.map((_, i) => i), extras: { effects: manifest.effects } }],
    meshes,
    materials,
    textures,
    images,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };
  return encodeGlb(json, Buffer.concat(bin));
}

/** GLB 容器：12 字节文件头 + JSON 块（空格补齐）+ BIN 块（0 补齐），都按 4 字节对齐 */
function encodeGlb(json: object, bin: Buffer): Buffer {
  let text = Buffer.from(JSON.stringify(json), 'utf8');
  if (text.length % 4) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)]);
  const body = bin.length % 4 ? Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]) : bin;
  const chunk = (type: number, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  const chunks = Buffer.concat([chunk(0x4e4f534a, text), chunk(0x004e4942, body)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // glTF
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + chunks.length, 8);
  return Buffer.concat([header, chunks]);
}
