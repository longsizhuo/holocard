/**
 * 卡包图案：在浏览器里现画，拼成一组两层的 LayerSet 交给卡片渲染器。
 *
 * 卡包就当一张「只有两层」的卡来渲染：跟手倾斜、箔面、炫光全是现成的，不用另写一套 3D。
 *   layer-0  包身（撕开线以下）
 *   layer-1  封条（撕开线以上）。开包时单独把它掀走，见 pack.ts
 * 两层视差系数相同，倾斜时贴在一起，看起来就是一整包。
 *
 * 底色用偏暗的紫色金属而不是珠光白：箔面在亮部会被高光保护压掉（见 renderer/highlight.ts），
 * 中间调上彩虹才出得来，卡包要的就是一眼看上去闪。
 */

import { defaultHalo, type FoilType, type LayerSet } from '../format/types';

const W = 700;
const H = 1000;
/** 撕开线的高度。线以上是封条 */
export const TEAR_Y = 130;
/** 上下锯齿封边：齿宽、齿深 */
const TOOTH = 20;
const TOOTH_DEPTH = 14;

function outline(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(0, TOOTH_DEPTH);
  for (let x = 0; x < W; x += TOOTH) {
    ctx.lineTo(x + TOOTH / 2, 0);
    ctx.lineTo(x + TOOTH, TOOTH_DEPTH);
  }
  ctx.lineTo(W, H - TOOTH_DEPTH);
  for (let x = W; x > 0; x -= TOOTH) {
    ctx.lineTo(x - TOOTH / 2, H);
    ctx.lineTo(x - TOOTH, H - TOOTH_DEPTH);
  }
  ctx.closePath();
}

/** 整包画在一张画布上，之后按撕开线切成两层 */
function drawPack(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('拿不到 2D 上下文');

  outline(ctx);
  ctx.save();
  ctx.clip();

  const base = ctx.createLinearGradient(0, 0, W, H);
  base.addColorStop(0, '#3b3558');
  base.addColorStop(0.45, '#6b6396');
  base.addColorStop(0.7, '#4a4470');
  base.addColorStop(1, '#2d2a46');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  // 斜向高光条：金属袋子压出来的反光
  ctx.globalCompositeOperation = 'lighter';
  for (const [x, width, alpha] of [
    [120, 90, 0.1],
    [330, 40, 0.14],
    [520, 120, 0.07],
  ] as const) {
    ctx.save();
    ctx.translate(x, H / 2);
    ctx.rotate(-Math.PI / 7);
    const band = ctx.createLinearGradient(-width / 2, 0, width / 2, 0);
    band.addColorStop(0, 'rgba(255,255,255,0)');
    band.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
    band.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = band;
    ctx.fillRect(-width / 2, -H, width, H * 2);
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';

  // 上下封边压痕
  ctx.fillStyle = 'rgba(20, 16, 36, 0.35)';
  ctx.fillRect(0, 0, W, TOOTH_DEPTH + 18);
  ctx.fillRect(0, H - TOOTH_DEPTH - 18, W, TOOTH_DEPTH + 18);

  // 中间一个卡片轮廓，暗示里面装的是一张卡
  ctx.strokeStyle = 'rgba(245, 242, 255, 0.55)';
  ctx.lineWidth = 6;
  // 手写圆角：roundRect 要 iOS 16，iPhone 用户最多，老系统也要画得出来
  const [x, y, w, h, r] = [210, 300, 280, 390, 22];
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.stroke();

  ctx.fillStyle = '#f5f2ff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '800 96px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText('HoloCard', W / 2, 800);
  ctx.font = '600 26px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillStyle = 'rgba(245, 242, 255, 0.75)';
  ctx.fillText('L A Y E R E D   F O I L   C A R D', W / 2, 872);

  // 撕开线：一排小孔
  ctx.fillStyle = 'rgba(15, 12, 28, 0.55)';
  for (let x = 12; x < W; x += 18) {
    ctx.beginPath();
    ctx.arc(x, TEAR_Y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  return canvas;
}

/** 从整包里切出 [top, bottom) 这一段，其余透明 */
function slice(full: HTMLCanvasElement, top: number, bottom: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('拿不到 2D 上下文');
  ctx.drawImage(full, 0, top, W, bottom - top, 0, top, W, bottom - top);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('卡包图案导出失败'))), 'image/png'),
  );
}

let art: Promise<Blob[]> | null = null;

/**
 * 卡包的 LayerSet。图案只画一次，每次拼一份新的 manifest：箔面类型各包不同，
 * 而且渲染器会原地改 manifest（面板调参），不能共用一份。
 */
export async function packLayerSet(foil: FoilType): Promise<LayerSet> {
  art ??= (async () => {
    const full = drawPack();
    return Promise.all([slice(full, TEAR_Y, H), slice(full, 0, TEAR_Y)]);
  })();
  const images = await art;
  const layer = (file: string) => ({
    file,
    depth: 0.5,
    parallax: 0,
    bbox: [0, 0, W, H] as const,
    inpainted: false,
    foil: { type: foil, intensity: 1 },
  });
  return {
    manifest: {
      version: 1,
      source: { width: W, height: H },
      layers: [layer('body.png'), layer('strip.png')],
      effects: { halo: defaultHalo(), glare: true },
      generator: 'holocard-pack',
    },
    images,
  };
}
