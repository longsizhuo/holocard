/**
 * WebGL 卡包：真 3D 的铝箔袋。能用 WebGL 的设备都用它，用不了的退回 pack.ts 的平面版。
 *
 *   - 袋身是鼓起来的曲面，前后两片膜；封口扁平、带压痕和锯齿。转动时摄影棚的灯光在弧面上滑过，
 *     箔面的彩虹按箔面类型变（默认彩虹闪粉）。正面印 involutionhell.com 的 logo
 *   - 撕：沿顶部封口横着划。划过的那段封条像小翻盖，在卡包平面里往上翘，切口前沿有个跟手的亮点；
 *     划过六成松手就整条扯下来、顺着划的方向甩出画面，不够就弹回去
 *   - 撕开后卡从袋口升出上面一截，停一下，空袋子往下掉；卡底离开袋口的那一刻把卡在屏幕上的位置
 *     交给卡带（playOpen 的返回值），卡带换成真正的闪卡接着转一圈（见 deck.ts）
 *   - 点一下（或回车、空格）：抖几下，一团光炸开，袋子没了
 *
 * 动效是在原型上逐帧调过的：封条不要朝人翻卷（像袋顶卷边，很怪），卡升出来时要整张留在画面里。
 * 改完跑 scripts/verify-pack.mjs，看它逐帧截的图。
 */

import { defaultFoilFor, type FoilType, type LayerSet } from '../format/types';
import {
  DEFAULT_PACK_FOIL,
  FLASH,
  PackChrome,
  reducedMotion,
  TAP_SLOP,
  TEAR_DONE,
  type Handoff,
  type OpenMethod,
  type PackState,
  type PackView,
} from './pack';
import { sfx, tearSound, type TearSound } from './sfx';
import logoUrl from './ih-logo.svg';

// ---------- 小工具 ----------

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

type Mat = Float32Array;

/** 4×4 矩阵，列主序 */
const M4 = {
  ident: (): Mat => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  mul(a: Mat, b: Mat): Mat {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
        o[c * 4 + r] = s;
      }
    return o;
  },
  chain: (...ms: Mat[]): Mat => ms.reduce((a, b) => M4.mul(a, b)),
  persp(fovy: number, aspect: number, near: number, far: number): Mat {
    const f = 1 / Math.tan(fovy / 2);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
  },
  tr(x: number, y: number, z: number): Mat {
    const m = M4.ident();
    m[12] = x;
    m[13] = y;
    m[14] = z;
    return m;
  },
  rx(a: number): Mat {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
  },
  ry(a: number): Mat {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
  },
  rz(a: number): Mat {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  },
  sc(s: number): Mat {
    const m = M4.ident();
    m[0] = m[5] = m[10] = s;
    return m;
  },
  /** 取旋转部分（模型里只有等比缩放，按列归一化） */
  rot3(m: Mat): Float32Array {
    const out = new Float32Array(9);
    for (let c = 0; c < 3; c++) {
      const l = Math.hypot(m[c * 4] ?? 0, m[c * 4 + 1] ?? 0, m[c * 4 + 2] ?? 0) || 1;
      for (let r = 0; r < 3; r++) out[c * 3 + r] = (m[c * 4 + r] ?? 0) / l;
    }
    return out;
  },
  /** 投影到 NDC 的 x、y */
  point(m: Mat, x: number, y: number, z: number): [number, number] {
    const at = (i: number): number => m[i] ?? 0;
    const w = at(3) * x + at(7) * y + at(11) * z + at(15);
    return [(at(0) * x + at(4) * y + at(8) * z + at(12)) / w, (at(1) * x + at(5) * y + at(9) * z + at(13)) / w];
  },
};

// ---------- 卡包的形状 ----------

/** 卡包宽 1、高 1.62（TCGP 卡包的比例）；上下封口各占 5.5%；撕口在 90% 高度 */
const PW = 1, PH = 1.62, SEAL = 0.055, BULGE = 0.1, TEAR_V = 0.9;
/** 撕口在卡包坐标里的高度 */
const MOUTH_Y = (TEAR_V - 0.5) * PH;
/** 卡在袋子里最大多宽、多高 */
const CARD_MAX_W = 0.86, CARD_MAX_H = 1.2;
const FOV = (32 * Math.PI) / 180;

/**
 * 袋身在 (u, v) 处鼓出来多高。封口是扁的；袋身中间饱满、四边收到接缝，
 * 左右接缝是前后两片膜压在一起的地方所以高度为 0；封口附近还压出一圈细褶
 */
function height(u: number, v: number): number {
  if (v <= SEAL || v >= 1 - SEAL) return 0;
  const t = (v - SEAL) / (1 - 2 * SEAL);
  const px = Math.max(0, 1 - Math.pow(Math.abs(2 * u - 1), 3.2));
  const py = Math.max(0, 1 - Math.pow(Math.abs(2 * t - 1), 5));
  const base = BULGE * Math.pow(px * py, 0.55);
  const near = Math.exp(-Math.min(t, 1 - t) * 16);
  const crease = 0.007 * near * Math.sin(u * 48 + Math.sin(u * 11) * 2.2) * Math.sqrt(px);
  return base + crease;
}

interface Mesh {
  pos: number[];
  nor: number[];
  uv: number[];
  idx: number[];
}

/** 在 v0..v1 这一段生成曲面网格。back：背面那片膜，向后鼓 */
function surface(v0: number, v1: number, cols: number, rows: number, back: boolean): Mesh {
  const mesh: Mesh = { pos: [], nor: [], uv: [], idx: [] };
  const e = 1e-3, sign = back ? -1 : 1;
  for (let r = 0; r <= rows; r++) {
    const v = v0 + ((v1 - v0) * r) / rows;
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      mesh.pos.push((u - 0.5) * PW, (v - 0.5) * PH, height(u, v) * sign);
      const dx = (height(u + e, v) - height(u - e, v)) / (2 * e * PW);
      const dy = (height(u, v + e) - height(u, v - e)) / (2 * e * PH);
      const l = Math.hypot(dx, dy, 1);
      mesh.nor.push((-dx * sign) / l, (-dy * sign) / l, sign / l);
      mesh.uv.push(u, v);
    }
  }
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c, b = a + 1, d = a + cols + 1, f = d + 1;
      mesh.idx.push(a, b, d, b, f, d);
    }
  return mesh;
}

/** 装在袋子里的那张卡：一块平板，夹在前后两片膜中间 */
function cardQuad(w: number, h: number): Mesh {
  return {
    pos: [-w / 2, -h / 2, 0, w / 2, -h / 2, 0, w / 2, h / 2, 0, -w / 2, h / 2, 0],
    nor: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uv: [0, 0, 1, 0, 1, 1, 0, 1],
    idx: [0, 1, 2, 0, 2, 3],
  };
}

// ---------- 贴图：卡包的印刷图案和箔面遮罩 ----------

const ART_W = 1024, ART_H = Math.round(1024 * PH);
/** logo 的高宽比（ih-logo.svg 的 viewBox） */
const LOGO_RATIO = 160.501 / 283.173;

function canvas2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('拿不到 2D 上下文');
  return [c, g];
}

/** 手写圆角：roundRect 要 iOS 16 */
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** 印刷图案（颜色）和箔面遮罩（白 = 这里是会反光变色的箔）。所有卡包共用一份 */
let packArt: Promise<[HTMLCanvasElement, HTMLCanvasElement]> | null = null;
function drawPackArt(): Promise<[HTMLCanvasElement, HTMLCanvasElement]> {
  packArt ??= (async () => {
    const logo = new Image();
    logo.src = logoUrl;
    // logo 加载不出来也照样画卡包，只是中间空着
    const hasLogo = await logo.decode().then(
      () => true,
      () => false,
    );
    const [art, a] = canvas2d(ART_W, ART_H);
    const [mask, m] = canvas2d(ART_W, ART_H);
    const sealPx = SEAL * ART_H;
    const cx = ART_W / 2, cy = ART_H * 0.43;

    const base = a.createLinearGradient(0, 0, 0, ART_H);
    base.addColorStop(0, '#2c2452');
    base.addColorStop(0.45, '#4a3d88');
    base.addColorStop(1, '#1f1a3e');
    a.fillStyle = base;
    a.fillRect(0, 0, ART_W, ART_H);
    m.fillStyle = '#000';
    m.fillRect(0, 0, ART_W, ART_H);

    // 放射光：印刷上是淡淡的亮条，遮罩上是箔
    for (let i = 0; i < 28; i++) {
      const a0 = (i / 28) * Math.PI * 2, a1 = a0 + (Math.PI * 2) / 56;
      for (const [g, style] of [[a, 'rgba(255,255,255,0.05)'], [m, 'rgba(255,255,255,0.32)']] as const) {
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + Math.cos(a0) * 2000, cy + Math.sin(a0) * 2000);
        g.lineTo(cx + Math.cos(a1) * 2000, cy + Math.sin(a1) * 2000);
        g.closePath();
        g.fillStyle = style;
        g.fill();
      }
    }
    // logo 后面一团光
    const halo = a.createRadialGradient(cx, cy, 40, cx, cy, 520);
    halo.addColorStop(0, 'rgba(210,190,255,0.55)');
    halo.addColorStop(1, 'rgba(210,190,255,0)');
    a.fillStyle = halo;
    a.fillRect(0, 0, ART_W, ART_H);

    // 中间：involutionhell.com 的 logo。白色的帽子和轮廓是箔烫的，猫脸是深色油墨
    const lw = 720, lh = lw * LOGO_RATIO;
    if (hasLogo) {
      a.drawImage(logo, cx - lw / 2, cy - lh / 2, lw, lh);
      m.drawImage(logo, cx - lw / 2, cy - lh / 2, lw, lh);
    }

    // 字标：箔烫的，遮罩上满
    for (const g of [a, m]) {
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = '800 150px system-ui, -apple-system, "Segoe UI", sans-serif';
      g.fillStyle = g === a ? '#f6f2ff' : '#fff';
      g.fillText('HoloCard', cx, ART_H * 0.75);
    }
    a.font = '600 38px system-ui, -apple-system, "Segoe UI", sans-serif';
    a.fillStyle = 'rgba(246,242,255,0.8)';
    a.fillText('L A Y E R E D   F O I L   C A R D', cx, ART_H * 0.8);
    roundRect(a, cx - 90, ART_H * 0.835, 180, 60, 30);
    a.lineWidth = 4;
    a.strokeStyle = 'rgba(246,242,255,0.7)';
    a.stroke();
    a.font = '700 32px system-ui, -apple-system, "Segoe UI", sans-serif';
    a.fillText('1 CARD', cx, ART_H * 0.835 + 31);

    // 撕开线：一排虚线，左边三个箭头指着撕的方向（不写字，各种语言都看得懂）
    const tearY = (1 - TEAR_V) * ART_H;
    a.setLineDash([18, 12]);
    a.lineWidth = 3;
    a.strokeStyle = 'rgba(246,242,255,0.5)';
    a.beginPath();
    a.moveTo(40, tearY);
    a.lineTo(ART_W - 40, tearY);
    a.stroke();
    a.setLineDash([]);
    a.lineWidth = 4;
    a.strokeStyle = 'rgba(246,242,255,0.7)';
    for (let i = 0; i < 3; i++) {
      const x = 64 + i * 30, y = tearY - 34;
      a.beginPath();
      a.moveTo(x, y - 12);
      a.lineTo(x + 12, y);
      a.lineTo(x, y + 12);
      a.stroke();
    }

    // 上下封口：银色印刷，压褶在着色器里做
    for (const y of [0, ART_H - sealPx]) {
      const s = a.createLinearGradient(0, y, 0, y + sealPx);
      s.addColorStop(0, '#d9d5e6');
      s.addColorStop(1, '#b7b1ca');
      a.fillStyle = s;
      a.fillRect(0, y, ART_W, sealPx);
    }
    return [art, mask];
  })();
  return packArt;
}

/** 把一张卡的各层叠成一张平面图，给袋子里那张卡当贴图。层图都是满幅的，按顺序由远及近画上去 */
async function flattenCard(set: LayerSet): Promise<HTMLCanvasElement> {
  const { width, height } = set.manifest.source;
  const s = Math.min(1, 1024 / Math.max(width, height));
  const [canvas, g] = canvas2d(Math.round(width * s), Math.round(height * s));
  for (const blob of set.images) {
    const bitmap = await createImageBitmap(blob);
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
  }
  return canvas;
}

/**
 * 卡包的颜色：默认彩虹闪粉。这张卡的箔面被人改过（别人调好再分享的卡）才跟着它背景那层的箔走——
 * 刚做好的卡箔面都是出厂设置，跟着走的话每个卡包都是一个颜色
 */
export function packFoil(set: LayerSet): FoilType {
  const layers = set.manifest.layers;
  const custom = layers.some((layer, i) => layer.foil.type !== defaultFoilFor(i, layers.length).type);
  if (!custom) return DEFAULT_PACK_FOIL;
  return layers.find((layer) => layer.foil.type !== 'none')?.foil.type ?? DEFAULT_PACK_FOIL;
}

/** 着色器里的箔面编号 */
const FOIL_INDEX: Record<FoilType, number> = { sunpillar: 0, holo: 1, rainbow: 2, none: 3 };

// ---------- 着色器 ----------

const VERT = `
attribute vec3 aPos; attribute vec3 aNor; attribute vec2 aUv;
uniform mat4 uModel; uniform mat4 uViewProj;
uniform float uPart, uTear, uSide, uTearV;
varying vec3 vWorld; varying vec3 vNor; varying vec2 vUv;
void main() {
  vec3 p = aPos;
  vec3 n = aNor;
  // 封条（uPart = 1）：手指划过的那段已经切开，像个小翻盖，绕切口前沿在卡包平面里往上翘，
  // 翘开一道楔形的缝；切口前面还没切到的部分原样连在袋子上
  if (uPart > 0.5 && uPart < 1.5) {
    float s = uSide > 0.0 ? aUv.x : 1.0 - aUv.x;
    float cut = clamp((uTear - s) / 0.3, 0.0, 1.0);
    cut = cut * cut * (3.0 - 2.0 * cut);
    float front = uSide > 0.0 ? min(uTear, 1.0) : 1.0 - min(uTear, 1.0);
    vec2 pivot = vec2((front - 0.5) * ${PW.toFixed(3)}, (uTearV - 0.5) * ${PH.toFixed(3)});
    float ang = -uSide * 0.2 * cut;
    float c = cos(ang), sn = sin(ang);
    vec2 d = p.xy - pivot;
    p.xy = pivot + vec2(d.x * c - d.y * sn, d.x * sn + d.y * c);
    n.xy = vec2(n.x * c - n.y * sn, n.x * sn + n.y * c);
    // 往人这边抬一点点，免得翘起来的封条和袋身打架
    p.z += 0.02 * cut;
  }
  vec4 w = uModel * vec4(p, 1.0);
  vWorld = w.xyz; vNor = n; vUv = aUv;
  gl_Position = uViewProj * w;
}`;

const PACK_FRAG = `
precision highp float;
varying vec3 vWorld; varying vec3 vNor; varying vec2 vUv;
uniform mat3 uRot; uniform vec3 uCam; uniform vec3 uLight;
uniform sampler2D uArt; uniform sampler2D uMask;
uniform float uBack, uFoil, uTime, uReady, uSeal, uTearV, uPart, uTear, uSide, uCutting;
uniform vec2 uTilt;

float h1(float n) { return fract(sin(n * 91.7) * 4375.5453); }
// 撕口的毛边：高低不齐的一条线
float jag(float u) {
  float x = u * 140.0;
  float i = floor(x);
  return 0.0065 * (mix(h1(i), h1(i + 1.0), fract(x)) - 0.5) + 0.0025 * sin(u * 410.0);
}

vec3 rainbow(float t) { return 0.55 + 0.45 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// 假的摄影棚环境光：上亮下暗，一条横的柔光箱、两条竖的。袋子一转，这些亮条就在弧面上滑
vec3 env(vec3 r) {
  float sky = smoothstep(-0.7, 0.9, r.y);
  vec3 c = mix(vec3(0.3, 0.27, 0.4), vec3(0.78, 0.76, 0.86), sky);
  c += 1.7 * exp(-pow((r.y - 0.38) / 0.09, 2.0)) * vec3(1.0, 0.98, 0.96);
  c += 1.1 * exp(-pow((r.x + 0.55) / 0.1, 2.0)) * smoothstep(-0.3, 0.3, r.y) * vec3(0.95, 0.97, 1.0);
  c += 0.7 * exp(-pow((r.x - 0.7) / 0.06, 2.0)) * vec3(1.0, 0.95, 1.0);
  return c;
}

// 箔面的颜色，和卡片的箔面类型一一对应：0 日柱、1 经典闪、2 彩虹闪粉、3 哑光银
vec3 foil(vec2 uv, float ndv) {
  float shift = uTilt.x * 1.6 - uTilt.y * 1.1 + ndv * 1.4;
  if (uFoil < 0.5) return rainbow(uv.x * 0.55 + uv.y * 1.05 + shift);
  if (uFoil < 1.5) {
    float lines = 0.5 + 0.5 * sin((uv.x * 0.8 + uv.y) * 240.0);
    return mix(vec3(0.9, 0.92, 0.98), rainbow(uv.y * 2.2 + shift * 1.4), 0.45 + 0.45 * lines);
  }
  if (uFoil < 2.5) {
    float g = hash(floor(uv * vec2(150.0, 243.0)));
    float sparkle = step(0.9, g) * max(0.0, sin(g * 40.0 + uTilt.x * 25.0 + uTilt.y * 18.0));
    return rainbow(uv.x * 1.3 - uv.y * 0.9 + shift) + sparkle * 1.2;
  }
  return vec3(0.9, 0.91, 0.95);
}

void main() {
  // 上下封口的锯齿
  float tooth = 0.016 * (1.0 - abs(2.0 * fract(vUv.x * 30.0) - 1.0));
  if (vUv.y < tooth || 1.0 - vUv.y < tooth) discard;
  // 撕口两侧的小三角缺口
  float dn = abs(vUv.y - uTearV);
  if (dn < 0.012) {
    float w = 0.024 * (1.0 - dn / 0.012);
    if (vUv.x < w || 1.0 - vUv.x < w) discard;
  }

  // 撕口：已经撕开的那段按毛边分开，袋身只留线下、封条只留线上；没撕到的地方是一条直线，两边严丝合缝
  float along = uSide > 0.0 ? vUv.x : 1.0 - vUv.x;
  bool torn = along < uTear;
  float edgeV = uTearV + (torn ? jag(vUv.x) : 0.0);
  if (uPart < 0.5 && vUv.y > edgeV) discard;
  if (uPart > 0.5 && vUv.y < edgeV) discard;
  float tornEdge = torn ? 1.0 - smoothstep(0.0, 0.0045, abs(vUv.y - edgeV)) : 0.0;

  bool seal = vUv.y < uSeal || vUv.y > 1.0 - uSeal;
  vec3 n = normalize(vNor);
  // 封口的横向压痕
  if (seal) n = normalize(n + vec3(0.0, 0.55 * sin(vUv.y * 430.0), 0.0));
  // 膜上的细皱
  float wr = sin(vUv.x * 83.0 + sin(vUv.y * 21.0) * 3.0) * sin(vUv.y * 57.0 + vUv.x * 9.0);
  n = normalize(n + vec3(wr, wr * 0.7, 0.0) * 0.03);

  vec3 N = normalize(uRot * n);
  vec3 V = normalize(uCam - vWorld);
  vec3 L = normalize(uLight);
  vec3 H = normalize(L + V);
  float ndl = max(dot(N, L), 0.0);
  float ndh = max(dot(N, H), 0.0);
  float ndv = max(dot(N, V), 0.0);
  vec3 R = reflect(-V, N);

  vec3 art; float m;
  if (uBack > 0.5) { art = vec3(0.17, 0.14, 0.3); m = seal ? 0.9 : 0.3; }
  else { art = texture2D(uArt, vUv).rgb; m = seal ? 0.92 : texture2D(uMask, vUv).r; }

  vec3 metal = env(R) * mix(vec3(0.86, 0.87, 0.92), foil(vUv, ndv), 0.8) * (0.55 + 0.6 * art);
  vec3 ink = art * (0.25 + 0.85 * ndl);
  vec3 col = mix(ink, metal, m);
  // 塑料膜的高光：印刷和箔面上都有
  col += vec3(1.0, 0.98, 0.96) * (pow(ndh, 90.0) * 0.9 + pow(ndh, 14.0) * 0.1);
  // 左右接缝、袋子边缘暗一点，显出厚度
  float edge = smoothstep(0.0, 0.06, min(vUv.x, 1.0 - vUv.x));
  col *= mix(0.55, 1.0, edge);
  // 轮廓光：在做的时候慢慢呼吸，做好了更亮
  float rim = pow(1.0 - ndv, 3.0);
  float pulse = mix(0.15 + 0.1 * sin(uTime * 2.2), 0.45 + 0.15 * sin(uTime * 4.0), uReady);
  col += rim * pulse * vec3(0.78, 0.7, 1.0);
  // 撕开的断面发白：铝箔袋撕开时露出里面那层
  col = mix(col, vec3(0.95, 0.94, 0.99), tornEdge * 0.8);
  // 切口前沿跟着手指的一个小亮点
  float front = uSide > 0.0 ? uTear : 1.0 - uTear;
  vec2 fd = vec2(vUv.x - front, (vUv.y - uTearV) * 1.62);
  col += uCutting * exp(-dot(fd, fd) / 0.0009) * vec3(1.0, 0.96, 1.0) * 1.3;
  gl_FragColor = vec4(col, 1.0);
}`;

// 袋子里那张卡：只在袋子里出现，出了袋口卡带就换成真正的闪卡。
// 画成原图（按闪卡静止时的放大系数裁），圆角和闪卡一样，换手时不跳
const CARD_FRAG = `
precision highp float;
varying vec3 vWorld; varying vec3 vNor; varying vec2 vUv;
uniform mat3 uRot; uniform vec3 uCam; uniform vec3 uLight; uniform sampler2D uTex;
uniform vec2 uSize; uniform float uZoom;
void main() {
  float r = 0.0455 * uSize.x;
  vec2 q = abs((vUv - 0.5) * uSize) - (uSize * 0.5 - r);
  if (length(max(q, 0.0)) > r) discard;
  vec3 N = normalize(uRot * vec3(0.0, 0.0, 1.0));
  vec3 H = normalize(normalize(uLight) + normalize(uCam - vWorld));
  vec3 c = texture2D(uTex, (vUv - 0.5) / uZoom + 0.5).rgb;
  c += pow(max(dot(N, H), 0.0), 60.0) * 0.08;
  gl_FragColor = vec4(c, 1.0);
}`;

// ---------- WebGL 场景 ----------

interface Program {
  p: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation>;
  attribs: Record<'aPos' | 'aNor' | 'aUv', number>;
}
interface GpuMesh {
  pos: WebGLBuffer;
  nor: WebGLBuffer;
  uv: WebGLBuffer;
  idx: WebGLBuffer;
  count: number;
}
interface Scene {
  pack: Program;
  card: Program;
  bodyFront: GpuMesh;
  bodyBack: GpuMesh;
  stripFront: GpuMesh;
  stripBack: GpuMesh;
  art: WebGLTexture;
  mask: WebGLTexture;
  /** 装在里面的卡，做好了才有 */
  cardMesh: GpuMesh | null;
  cardTex: WebGLTexture | null;
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error('建不了着色器');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || '着色器编译失败');
  return s;
}

function program(gl: WebGLRenderingContext, frag: string): Program {
  const p = gl.createProgram();
  if (!p) throw new Error('建不了着色器程序');
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || '着色器链接失败');
  const uniforms = new Map<string, WebGLUniformLocation>();
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(p, i);
    const loc = info && gl.getUniformLocation(p, info.name);
    if (info && loc) uniforms.set(info.name, loc);
  }
  const attribs = {
    aPos: gl.getAttribLocation(p, 'aPos'),
    aNor: gl.getAttribLocation(p, 'aNor'),
    aUv: gl.getAttribLocation(p, 'aUv'),
  };
  return { p, uniforms, attribs };
}

function upload(gl: WebGLRenderingContext, mesh: Mesh): GpuMesh {
  const buffer = (data: ArrayBufferView, target: number): WebGLBuffer => {
    const b = gl.createBuffer();
    if (!b) throw new Error('建不了缓冲区');
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  };
  return {
    pos: buffer(new Float32Array(mesh.pos), gl.ARRAY_BUFFER),
    nor: buffer(new Float32Array(mesh.nor), gl.ARRAY_BUFFER),
    uv: buffer(new Float32Array(mesh.uv), gl.ARRAY_BUFFER),
    idx: buffer(new Uint16Array(mesh.idx), gl.ELEMENT_ARRAY_BUFFER),
    count: mesh.idx.length,
  };
}

function texture(gl: WebGLRenderingContext, source: TexImageSource): WebGLTexture {
  const t = gl.createTexture();
  if (!t) throw new Error('建不了贴图');
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  // 尺寸不是 2 的幂，WebGL1 下不能用 mipmap 和重复寻址
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// ---------- 卡包 ----------

type Phase = 'sealed' | 'tearing' | 'settle' | 'nudge' | 'flying' | 'reveal' | 'shake' | 'burst' | 'gone';

export class GlPack implements PackView {
  readonly ready: Promise<void>;

  readonly #host: HTMLElement;
  readonly #chrome: PackChrome;
  readonly #canvas: HTMLCanvasElement;
  readonly #gl: WebGLRenderingContext;
  #scene: Scene | null = null;
  #foil: FoilType = DEFAULT_PACK_FOIL;
  #onOpen: ((method: OpenMethod) => void) | null = null;
  /** 做好了的那张卡的平面图，WebGL 上下文丢了重建时要用 */
  #cardArt: { canvas: HTMLCanvasElement; w: number; h: number } | null = null;
  #zoom = 1;

  // 动画状态。长度单位是卡包宽，时间是 performance.now() 的毫秒
  #phase: Phase = 'sealed';
  #t0 = 0;
  #tear = 0;
  #tearFrom = 0;
  #side = 1;
  #flyStart = 0;
  #rot = { x: 0, y: 0 };
  #target = { x: 0, y: 0 };
  #hovering = false;
  #packY = 0;
  #packScale = 1;
  #shake = 0;
  #packVisible = true;
  #cardVisible = false;
  #cardY = 0;
  #revealFrom = 0;
  #slid = false;
  #drag: { x: number; y: number; id: number; tearing: boolean; width: number; lastX: number; lastT: number } | null = null;
  #tearSound: TearSound | null = null;
  /** 开包动画播放中时是 playOpen 的 resolve，交出去之后是 null */
  #reveal: ((handoff: Handoff | null) => void) | null = null;

  #viewProj: Mat = M4.ident();
  #camZ = 3.3;
  #raf = 0;
  #last = 0;
  #onScreen = false;
  #destroyed = false;
  readonly #observers: { disconnect(): void }[] = [];

  /**
   * WebGL 起不来（没有、着色器编译不过）时直接抛，宿主上什么都还没动；卡带接住后换平面版
   */
  constructor(host: HTMLElement, onDismiss: () => void) {
    this.#canvas = document.createElement('canvas');
    this.#canvas.className = 'pack__gl';
    const gl = this.#canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error('这台设备用不了 WebGL');
    this.#gl = gl;
    this.ready = this.#build();
    this.#host = host;
    this.#chrome = new PackChrome(host, onDismiss);
    host.prepend(this.#canvas);

    // 手机切后台、显存吃紧时上下文会丢；丢了就等浏览器还回来，重建一遍
    this.#canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.#scene = null;
      this.#stop();
      // 开包开到一半丢的：动画续不上了，直接把卡交出去，别让卡带一直等
      if (this.#reveal) this.#finish();
    });
    this.#canvas.addEventListener('webglcontextrestored', () => {
      try {
        void this.#build().catch(() => undefined);
      } catch {
        // 重建不了就停在那儿；卡在「我做过的」里一直都有
      }
    });

    const resize = new ResizeObserver(() => this.#resize());
    resize.observe(this.#canvas);
    // 卡带切到别的格（hidden）或滚出屏幕就停下来，不空烧 GPU
    const visible = new IntersectionObserver((entries) => {
      this.#onScreen = entries.some((entry) => entry.isIntersecting);
      if (this.#onScreen) this.#start();
      else this.#stop();
    });
    visible.observe(this.#canvas);
    this.#observers.push(resize, visible);
    this.#bindInput();
  }

  setState(state: PackState, message?: string): void {
    this.#chrome.setState(state, message);
  }

  setFoil(foil: FoilType): void {
    this.#foil = foil;
  }

  setCard(set: LayerSet): void {
    const { width, height } = set.manifest.source;
    const ratio = width / height;
    // 竖卡按高度放、横卡按宽度放，都装得进袋子
    const h = Math.min(CARD_MAX_H, CARD_MAX_W / ratio);
    void flattenCard(set)
      .then((canvas) => {
        this.#cardArt = { canvas, w: h * ratio, h };
        this.#uploadCard();
      })
      .catch(() => {
        // 叠不出来就不画袋子里那张卡，封条照样撕、卡照样从卡带那边出来
      });
  }

  onOpen(handler: (method: OpenMethod) => void): void {
    this.#onOpen = handler;
  }

  playOpen(method: OpenMethod, zoom: number): Promise<Handoff | null> {
    this.#zoom = zoom;
    this.#tearSound?.stop();
    this.#tearSound = null;
    if (reducedMotion() || !this.#scene) return Promise.resolve(null);
    const now = performance.now();
    if (method === 'swipe') {
      this.#tearFrom = this.#tear;
      this.#phase = 'flying';
      this.#flyStart = now;
      this.#t0 = now;
      this.#slid = false;
      this.#cardVisible = this.#scene.cardTex !== null;
      this.#cardY = MOUTH_Y - 0.07 - this.#cardH() / 2;
      sfx.rip();
    } else {
      this.#phase = 'shake';
      this.#t0 = now;
      sfx.shake();
    }
    this.#host.classList.add('is-opening');
    this.#start();
    return new Promise((resolve) => {
      this.#reveal = resolve;
    });
  }

  destroy(): void {
    this.#destroyed = true;
    this.#stop();
    this.#tearSound?.stop();
    for (const observer of this.#observers) observer.disconnect();
    // 主动还掉上下文：一页里开过几包，浏览器同时能开的 WebGL 上下文有上限
    this.#gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.#chrome.destroy();
  }

  // ---------- 场景 ----------

  /** 编着色器、传网格是同步的，出错直接抛给构造函数；图案画好了再传贴图 */
  #build(): Promise<void> {
    const gl = this.#gl;
    const pack = program(gl, PACK_FRAG);
    const card = program(gl, CARD_FRAG);
    // 撕口上下各多留一点，毛边在着色器里按撕开进度切
    const bodyFront = upload(gl, surface(0, TEAR_V + 0.01, 96, 110, false));
    const bodyBack = upload(gl, surface(0, TEAR_V + 0.01, 96, 110, true));
    const stripFront = upload(gl, surface(TEAR_V - 0.01, 1, 96, 16, false));
    const stripBack = upload(gl, surface(TEAR_V - 0.01, 1, 96, 16, true));
    return drawPackArt().then(([art, mask]) => {
      if (this.#destroyed || gl.isContextLost()) return;
      this.#scene = {
        pack,
        card,
        bodyFront,
        bodyBack,
        stripFront,
        stripBack,
        art: texture(gl, art),
        mask: texture(gl, mask),
        cardMesh: null,
        cardTex: null,
      };
      this.#uploadCard();
      gl.enable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0);
      this.#resize();
      if (this.#onScreen) this.#start();
    });
  }

  #uploadCard(): void {
    const scene = this.#scene;
    const card = this.#cardArt;
    if (!scene || !card) return;
    scene.cardMesh = upload(this.#gl, cardQuad(card.w, card.h));
    scene.cardTex = texture(this.#gl, card.canvas);
  }

  #cardH(): number {
    return this.#cardArt?.h ?? CARD_MAX_H;
  }

  #resize(): void {
    const w = this.#canvas.clientWidth, h = this.#canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.#canvas.width = Math.round(w * dpr);
    this.#canvas.height = Math.round(h * dpr);
    this.#gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
    const aspect = w / h;
    // 竖着能放下 1.95 高、横着能放下 1.3 宽：卡包四周留出转动、翘封条的余量
    const tan = Math.tan(FOV / 2);
    this.#camZ = Math.max(1.95 / (2 * tan), 1.3 / (2 * tan * aspect));
    this.#viewProj = M4.mul(M4.persp(FOV, aspect, 0.1, 30), M4.tr(0, 0, -this.#camZ));
    if (this.#scene && !this.#raf) this.#render(performance.now());
  }

  #start(): void {
    if (this.#raf || this.#destroyed || !this.#scene || this.#phase === 'gone') return;
    this.#last = performance.now();
    this.#raf = requestAnimationFrame(this.#frame);
  }

  #stop(): void {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  // 时间一律用 performance.now()，不用 rAF 给的时间戳：两个在测试的虚拟时钟下不同源
  readonly #frame = (): void => {
    const now = performance.now();
    this.#raf = 0;
    if (this.#destroyed || !this.#scene) return;
    const dt = Math.min(0.05, (now - this.#last) / 1000);
    this.#last = now;
    this.#update(now, dt);
    this.#render(now);
    if (this.#onScreen && this.#phase !== 'gone') this.#raf = requestAnimationFrame(this.#frame);
  };

  #packModel(): Mat {
    return M4.chain(
      M4.tr(0, this.#packY, 0),
      M4.ry(this.#rot.y),
      M4.rx(this.#rot.x),
      M4.rz(this.#shake),
      M4.sc(this.#packScale),
    );
  }

  /** 松手之后封条顺着划的方向飞出画面，一边飞一边接着往上翘；撕的过程中不整体动，翘起来的形状在顶点着色器里 */
  #stripModel(pack: Mat, now: number): Mat {
    if (this.#phase !== 'flying' && this.#phase !== 'reveal') return pack;
    const e = Math.pow(clamp01((now - this.#flyStart) / 380), 2);
    const cy = ((1 + TEAR_V) / 2 - 0.5) * PH;
    return M4.chain(
      pack,
      M4.tr(this.#side * 1.3 * e, 0.12 + 0.5 * e, 0.05),
      M4.tr(0, cy, 0),
      M4.rz(-this.#side * 0.5 * e),
      M4.tr(0, -cy, 0),
    );
  }

  /** 撕开进度：撕的时候跟手；松手后很快撕完整条 */
  #tearAmount(now: number): number {
    if (this.#phase !== 'flying' && this.#phase !== 'reveal') return this.#tear;
    return lerp(this.#tearFrom, 1.3, easeOut(clamp01((now - this.#flyStart) / 160)));
  }

  #render(now: number): void {
    const scene = this.#scene;
    if (!scene) return;
    const gl = this.#gl;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const common = {
      uFoil: FOIL_INDEX[this.#foil],
      uTime: now / 1000,
      uReady: this.#chrome.state === 'ready' ? 1 : 0,
      uSeal: SEAL,
      uTearV: TEAR_V,
      uTear: this.#tearAmount(now),
      uSide: this.#side,
      uCutting: this.#phase === 'tearing' ? 1 : 0,
    };
    gl.useProgram(scene.pack.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.art);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, scene.mask);
    const pack = this.#packModel();
    if (this.#packVisible) {
      const unit = { uArt: 0, uMask: 1 };
      this.#draw(scene.pack, scene.bodyFront, pack, { ...common, ...unit, uBack: 0, uPart: 0 });
      this.#draw(scene.pack, scene.bodyBack, pack, { ...common, ...unit, uBack: 1, uPart: 0 });
      const flying = this.#phase === 'flying' || this.#phase === 'reveal';
      // 封条飞出画面后就不画了
      if (!flying || now - this.#flyStart < 420) {
        const strip = this.#stripModel(pack, now);
        this.#draw(scene.pack, scene.stripFront, strip, { ...common, ...unit, uBack: 0, uPart: 1 });
        this.#draw(scene.pack, scene.stripBack, strip, { ...common, ...unit, uBack: 1, uPart: 1 });
      }
    }
    if (this.#cardVisible && scene.cardMesh && scene.cardTex && this.#cardArt) {
      gl.useProgram(scene.card.p);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, scene.cardTex);
      this.#draw(scene.card, scene.cardMesh, M4.mul(pack, M4.tr(0, this.#cardY, 0)), {
        uTex: 2,
        uZoom: this.#zoom,
        uSize: [this.#cardArt.w, this.#cardArt.h],
        uPart: 2,
      });
    }
  }

  #draw(prog: Program, mesh: GpuMesh, model: Mat, uniforms: Record<string, number | [number, number]>): void {
    const gl = this.#gl;
    const u = prog.uniforms;
    gl.useProgram(prog.p);
    const set = (name: string, apply: (loc: WebGLUniformLocation) => void): void => {
      const loc = u.get(name);
      if (loc) apply(loc);
    };
    set('uModel', (loc) => gl.uniformMatrix4fv(loc, false, model));
    set('uViewProj', (loc) => gl.uniformMatrix4fv(loc, false, this.#viewProj));
    set('uRot', (loc) => gl.uniformMatrix3fv(loc, false, M4.rot3(model)));
    set('uCam', (loc) => gl.uniform3f(loc, 0, 0, this.#camZ));
    set('uLight', (loc) => gl.uniform3f(loc, -0.45, 0.6, 1.0));
    set('uTilt', (loc) => gl.uniform2f(loc, this.#rot.y, this.#rot.x));
    for (const [name, value] of Object.entries(uniforms)) {
      if (name === 'uTex' || name === 'uArt' || name === 'uMask') set(name, (loc) => gl.uniform1i(loc, value as number));
      else if (Array.isArray(value)) set(name, (loc) => gl.uniform2f(loc, value[0], value[1]));
      else set(name, (loc) => gl.uniform1f(loc, value));
    }
    const buffers = { aPos: [mesh.pos, 3], aNor: [mesh.nor, 3], aUv: [mesh.uv, 2] } as const;
    for (const [attr, [buffer, size]] of Object.entries(buffers)) {
      const loc = prog.attribs[attr as keyof typeof buffers];
      if (loc < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idx);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
  }

  // ---------- 开包的节奏 ----------

  #update(now: number, dt: number): void {
    const t = (now - this.#t0) / 1000;
    // 倾斜：平时跟手，手不在就慢慢摆；开包过程中摆正
    let tx = 0, ty = 0;
    const idle = this.#phase === 'sealed' || this.#phase === 'nudge';
    if (idle && this.#hovering) {
      tx = this.#target.x;
      ty = this.#target.y;
    } else if (idle && !reducedMotion()) {
      tx = Math.sin(now / 1500) * 0.07;
      ty = Math.sin(now / 1150) * 0.2;
    }
    const k = 1 - Math.exp(-dt * 7);
    this.#rot.x += (tx - this.#rot.x) * k;
    this.#rot.y += (ty - this.#rot.y) * k;

    switch (this.#phase) {
      case 'settle':
        this.#tear *= Math.exp(-dt * 14);
        if (this.#tear < 0.01) {
          this.#tear = 0;
          this.#phase = 'sealed';
        }
        break;
      case 'nudge':
        this.#packY = Math.sin(clamp01(t / 0.3) * Math.PI) * 0.04;
        if (t >= 0.3) {
          this.#packY = 0;
          this.#phase = 'sealed';
        }
        break;
      case 'flying': {
        // 封条飞走的同时，卡从袋口升出上面一截；袋子往下让一点，卡整体留在画面里
        const p = clamp01((t - 0.12) / 0.6);
        if (p > 0 && !this.#slid) {
          this.#slid = true;
          if (this.#cardVisible) sfx.slide();
        }
        this.#cardY = MOUTH_Y - 0.07 - this.#cardH() / 2 + 0.42 * this.#cardH() * easeOut(p);
        this.#packY = -0.22 * easeOut(p);
        // 升到位后停一小下再抽出来
        if (t >= 0.9) {
          this.#phase = 'reveal';
          this.#t0 = now;
          this.#revealFrom = this.#packY + this.#cardY;
        }
        break;
      }
      case 'reveal': {
        // 空袋子往下掉，卡被往上带一点；卡还在袋子里时照旧画在两片膜之间，下半截被前膜挡着
        const p = clamp01(t / 0.7);
        this.#packY = -0.22 - 3.4 * p * p;
        if (this.#reveal) {
          const y = this.#revealFrom + 0.05 * easeOut(clamp01(t / 0.3));
          this.#cardY = y - this.#packY;
          // 卡底离开袋口：把卡在屏幕上的位置交给卡带，这边不再画它
          if (this.#packY + MOUTH_Y < y - this.#cardH() / 2) {
            this.#handOff({ rect: this.#cardRect(), side: this.#side });
            this.#cardVisible = false;
          }
        }
        if (p >= 1) this.#finish();
        break;
      }
      case 'shake': {
        const p = clamp01(t / 0.45);
        this.#shake = Math.sin(t * 58) * 0.075 * (1 - p * 0.6);
        this.#packScale = 1 + 0.04 * p;
        if (p >= 1) {
          this.#shake = 0;
          this.#phase = 'burst';
          this.#t0 = now;
          this.#flash();
          sfx.burst();
        }
        break;
      }
      case 'burst': {
        // 光最亮的时候袋子没了，卡从光里弹出来（卡带那边接手）
        const p = clamp01(t / 0.6);
        this.#packScale = 1.04 + 0.2 * clamp01(p * 3);
        if (p > 0.22) this.#handOff(null);
        if (p > 0.28) this.#packVisible = false;
        if (p >= 1) this.#finish();
        break;
      }
    }
  }

  #handOff(handoff: Handoff | null): void {
    const resolve = this.#reveal;
    this.#reveal = null;
    resolve?.(handoff);
  }

  #finish(): void {
    this.#handOff(null);
    this.#phase = 'gone';
    this.#packVisible = false;
    this.#cardVisible = false;
  }

  /** 袋子里那张卡此刻在屏幕上的位置（CSS 像素，相对视口） */
  #cardRect(): DOMRect {
    const art = this.#cardArt;
    const w = art?.w ?? CARD_MAX_W, h = art?.h ?? CARD_MAX_H;
    const m = M4.mul(this.#viewProj, M4.mul(this.#packModel(), M4.tr(0, this.#cardY, 0)));
    const box = this.#canvas.getBoundingClientRect();
    const xs: number[] = [], ys: number[] = [];
    for (const [x, y] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as const) {
      const [nx, ny] = M4.point(m, x, y, 0);
      xs.push(box.left + ((nx + 1) / 2) * box.width);
      ys.push(box.top + ((1 - ny) / 2) * box.height);
    }
    const left = Math.min(...xs), top = Math.min(...ys);
    return new DOMRect(left, top, Math.max(...xs) - left, Math.max(...ys) - top);
  }

  /** 一团和箔面同色的光从卡包中间炸开 */
  #flash(): void {
    const flash = this.#chrome.flash;
    flash.style.background = FLASH[this.#foil];
    flash.animate(
      [
        { opacity: 0, scale: '0.3' },
        { opacity: 1, scale: '1.05', offset: 0.35 },
        { opacity: 0, scale: '1.7' },
      ],
      { duration: 760, easing: 'ease-out' },
    );
  }

  // ---------- 输入 ----------

  /** 顶部封口到撕开线这一条在画布上的位置（CSS 像素） */
  #tearZone(): { left: number; right: number; top: number; bottom: number } {
    const w = this.#canvas.clientWidth, h = this.#canvas.clientHeight;
    const px = ([x, y]: [number, number]): [number, number] => [((x + 1) / 2) * w, ((1 - y) / 2) * h];
    const m = M4.mul(this.#viewProj, M4.tr(0, this.#packY, 0));
    const [left, top] = px(M4.point(m, -PW / 2, PH / 2, 0));
    const [right, bottom] = px(M4.point(m, PW / 2, MOUTH_Y - 0.03, 0));
    return { left, right, top, bottom };
  }

  #request(method: OpenMethod): void {
    // 撕开是从「正在撕」松手来的，点开、按键是从封好的状态来的
    if (this.#phase !== 'sealed' && this.#phase !== 'tearing') return;
    if (this.#chrome.state !== 'ready') {
      // 还没做好：轻轻跳一下，让人知道点到了
      if (this.#chrome.state === 'working') {
        this.#phase = 'nudge';
        this.#t0 = performance.now();
        this.#start();
        sfx.nudge();
      }
      return;
    }
    this.#onOpen?.(method);
  }

  #bindInput(): void {
    const canvas = this.#canvas;
    canvas.addEventListener('pointermove', (event) => {
      const r = canvas.getBoundingClientRect();
      const nx = ((event.clientX - r.left) / r.width) * 2 - 1;
      const ny = ((event.clientY - r.top) / r.height) * 2 - 1;
      this.#hovering = true;
      // 指针在哪一侧，哪一侧朝人抬起来
      this.#target.y = -nx * 0.34;
      this.#target.x = -ny * 0.26;
      const d = this.#drag;
      if (!d?.tearing || event.pointerId !== d.id) return;
      const dx = event.clientX - d.x;
      if (Math.abs(dx) <= TAP_SLOP) return;
      this.#side = dx > 0 ? 1 : -1;
      this.#tear = clamp01(Math.abs(dx) / d.width);
      const dt = Math.max(1, event.timeStamp - d.lastT) / 1000;
      this.#tearSound?.move(Math.abs(event.clientX - d.lastX) / d.width / dt, this.#tear);
      d.lastX = event.clientX;
      d.lastT = event.timeStamp;
    });
    canvas.addEventListener('pointerleave', () => {
      this.#hovering = false;
    });
    canvas.addEventListener('pointerdown', (event) => {
      // 开包动画播放中再点一下：直接跳到卡摆上来那一刻
      if (this.#reveal) {
        this.#finish();
        return;
      }
      if (this.#phase !== 'sealed') return;
      const r = canvas.getBoundingClientRect();
      const x = event.clientX - r.left, y = event.clientY - r.top;
      const z = this.#tearZone();
      // 手指没那么准，撕的区域上下左右都放宽一些
      const tearing =
        this.#chrome.state === 'ready' &&
        !reducedMotion() &&
        y >= z.top - 28 &&
        y <= z.bottom + 26 &&
        x >= z.left - 30 &&
        x <= z.right + 30;
      this.#drag = {
        x: event.clientX,
        y: event.clientY,
        id: event.pointerId,
        tearing,
        width: z.right - z.left,
        lastX: event.clientX,
        lastT: event.timeStamp,
      };
      if (tearing) {
        canvas.setPointerCapture(event.pointerId);
        this.#phase = 'tearing';
        this.#tearSound = tearSound();
      }
    });
    const release = (event: PointerEvent): void => {
      const d = this.#drag;
      if (!d || event.pointerId !== d.id) return;
      this.#drag = null;
      const moved = Math.hypot(event.clientX - d.x, event.clientY - d.y);
      if (d.tearing) {
        if (this.#tear >= TEAR_DONE) {
          this.#request('swipe');
          // 卡带没接（不该发生）：当没划够
          if (this.#phase === 'tearing') this.#phase = 'settle';
          return;
        }
        this.#tearSound?.stop();
        this.#tearSound = null;
        this.#tear = moved < TAP_SLOP ? 0 : this.#tear;
        this.#phase = moved < TAP_SLOP ? 'sealed' : 'settle';
        if (moved < TAP_SLOP) this.#request('tap');
        return;
      }
      if (moved < TAP_SLOP) this.#request('tap');
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', () => {
      if (this.#drag?.tearing && this.#phase === 'tearing') this.#phase = 'settle';
      this.#drag = null;
      this.#tearSound?.stop();
      this.#tearSound = null;
    });
    this.#host.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target !== this.#host) return;
      event.preventDefault();
      this.#request('key');
    });
  }
}
