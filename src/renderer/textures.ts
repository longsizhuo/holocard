/**
 * 箔面配方用到的两张纹理，运行时程序化生成。
 *
 * 参考项目是直接引用两张位图（grain.webp / glitter.png）。我们改成现算：
 * 仓库里不用放二进制素材，也不牵扯素材本身的来源问题。
 * 质感是对着原图调的——
 *   grain    近乎全黑的极细噪点。用 screen 叠到渐变上只有微弱提亮，
 *            但随后会被 contrast(2.95) 放大成金属颗粒感
 *   glitter  黑底上密布大小亮度不一的亮点，外加少量带光晕的大星芒
 */

export interface FoilTextures {
  grain: string;
  glitter: string;
}

/**
 * 固定种子的伪随机（mulberry32）。
 * 纹理每次生成都一样，视觉可复现，调配方时不会被随机性干扰。
 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function toUrl(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return URL.createObjectURL(blob);
}

async function makeGrain(size: number): Promise<string> {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('拿不到 2D 上下文');

  const random = seeded(0x9e3779b9);
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let i = 0; i < size * size; i++) {
    // 幂次把分布压向暗部：绝大多数像素接近黑，偶尔冒出稍亮的颗粒
    const v = Math.floor(Math.pow(random(), 2.2) * 48);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return toUrl(canvas);
}

async function makeGlitter(size: number): Promise<string> {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('拿不到 2D 上下文');

  const random = seeded(0x51f15eed);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);

  // 底层：密集的细小亮点，亮度参差
  const dust = Math.round(size * size * 0.028);
  for (let i = 0; i < dust; i++) {
    const brightness = Math.pow(random(), 1.8);
    ctx.globalAlpha = 0.15 + brightness * 0.85;
    ctx.fillStyle = '#fff';
    const r = 0.35 + random() * 0.9;
    ctx.beginPath();
    ctx.arc(random() * size, random() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 上层：少量带光晕的大星芒，闪粉的「闪」主要靠它们
  const sparks = Math.round(size * size * 0.0007);
  for (let i = 0; i < sparks; i++) {
    const x = random() * size;
    const y = random() * size;
    const r = 1.6 + random() * 2.6;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2);
    glow.addColorStop(0, 'rgba(255,255,255,1)');
    glow.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = 0.6 + random() * 0.4;
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  return toUrl(canvas);
}

/** 纹理全页面只生成一次，所有卡片共用。blob URL 活到页面关闭，不回收 */
let cache: Promise<FoilTextures> | null = null;

export function ensureTextures(): Promise<FoilTextures> {
  cache ??= (async () => {
    const [grain, glitter] = await Promise.all([makeGrain(500), makeGlitter(640)]);
    return { grain, glitter };
  })();
  return cache;
}
