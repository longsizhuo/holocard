/**
 * 导出动图：按设备给不同的格式
 *   live    iPhone：实况照片（JPEG + MOV 两个文件，靠 UUID 配对）
 *   motion  安卓：  动态照片（JPEG 末尾接一段 MP4，一个文件）
 *   apng    电脑：  透明底的 APNG，后缀就是 .png，浏览器和大多数看图软件直接能播
 *
 * 画面和分享图是同一套渲染：无头浏览器打开 /render/<id>?export=…，
 * 逐帧摆姿态、截图，帧交给 ffmpeg（视频）或 UPNG.js（APNG）编码，最后按格式封装。
 *
 * 动作：指针绕卡面中心转一整圈，卡片跟着转，箔面和炫光随角度流动。
 * 起点和终点都落在分享图的那个姿态（炫光峰值），所以首尾相接、可以无缝循环；
 * 实况照片和动态照片的封面就取最后一帧——相册从播放切回封面时画面不跳。
 *
 * 性能是这里的主要约束：服务器没有显卡，箔面的混合模式和滤镜全靠 CPU 软件光栅化，
 * 1080×1920 一帧要 1.3 秒，其中七成花在箔面上。所以：
 *   - 视频帧按 2 倍截（720×1280），只有封面按 3 倍截（1080×1920）。
 *     真机也是这样：实况照片、动态照片的静态图分辨率都远高于里面的视频
 *   - 两个页面并行截，单个页面吃不满两个核（实测快 1.5 倍）
 *   - 截图前不等浏览器自己画一遍：captureScreenshot 会按指定倍率重新光栅化，
 *     等 rAF 只会让页面在屏幕上白画一次（实测两种截法逐像素一致）
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Page } from 'playwright-core';
import { withRenderPage } from './preview';
import { packLivePhotoJpeg, packLivePhotoMov } from './livephoto';
import { packMotionPhoto } from './motionphoto';
// upng-js 是 CommonJS（module.exports = UPNG），在 Node 的 ESM 里只能按默认导出取
import UPNG from 'upng-js';

export type ExportFormat = 'live' | 'motion' | 'apng';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['live', 'motion', 'apng'];

/**
 * 导出的版本号，写在文件名里。改了画面、动作或封装参数就加一：
 * 旧文件名对不上，下次有人导出时自然重新生成，不用手工清理存量。
 */
const EXPORT_VERSION = 1;

const FFMPEG = process.env.HOLOCARD_FFMPEG ?? 'ffmpeg';

/** 整个导出的超时。服务器上一张要二三十秒，超过这个多半是卡死了 */
const EXPORT_TIMEOUT_MS = 3 * 60 * 1000;

/** 同时开几个页面截帧 */
const PARALLEL_PAGES = 2;

export interface ExportFile {
  /** 卡片目录里的文件名 */
  file: string;
  type: string;
  /** 给用户下载时的文件名 */
  download: string;
}

/**
 * 每种格式产出哪些文件。
 *
 * 动态照片的文件名按 Google 规范的建议以「MP.jpg」结尾，再带上 MVIMG_ 前缀——
 * 那是老版 MicroVideo 的命名，有的相册先看文件名再决定要不要去解析 XMP。
 * 实况照片两个文件同名不同后缀，在「文件」App 里一眼看得出是一对。
 */
export function exportFiles(format: ExportFormat, id: string): ExportFile[] {
  const base = `HoloCard_${id.slice(0, 8)}`;
  const v = EXPORT_VERSION;
  switch (format) {
    case 'live':
      return [
        { file: `live-v${v}.jpg`, type: 'image/jpeg', download: `${base}.jpg` },
        { file: `live-v${v}.mov`, type: 'video/quicktime', download: `${base}.mov` },
      ];
    case 'motion':
      return [{ file: `motion-v${v}.jpg`, type: 'image/jpeg', download: `MVIMG_${base}.MP.jpg` }];
    case 'apng':
      return [{ file: `sticker-v${v}.png`, type: 'image/png', download: `${base}.png` }];
  }
}

/** 层文件路由要放行的导出文件名 */
export const EXPORT_FILE = /^(?:live-v\d+\.(?:jpg|mov)|motion-v\d+\.jpg|sticker-v\d+\.png)$/;

/**
 * 这种格式的导出是否已经有了、而且比 manifest 新。
 * manifest 会被就地修补（改视差、改箔面），改过之后旧的导出就不对了。
 * 返回文件的修改时间，当下载地址上的版本号用；没有或过期返回 null。
 */
export async function exportReady(dir: string, format: ExportFormat, id: string): Promise<number | null> {
  const manifest = await stat(join(dir, 'manifest.json')).catch(() => null);
  if (!manifest) return null;
  let version = 0;
  for (const f of exportFiles(format, id)) {
    const s = await stat(join(dir, f.file)).catch(() => null);
    if (!s || s.mtimeMs < manifest.mtimeMs) return null;
    version = Math.max(version, Math.floor(s.mtimeMs));
  }
  return version;
}

// ---------- 动作 ----------

type Pose = { x: number; y: number };

/** 分享图的姿态：炫光峰值。首尾帧都落在这里 */
const PEAK: Pose = { x: 78, y: 22 };

/**
 * 第 i 帧的姿态（指针在卡面上的百分比位置）：以卡面中心为圆心、过 PEAK 的圆，
 * 第 0 帧和第 n 帧都在 PEAK 上。半径 ≈ 39.6，对应最大转角约 11°。
 */
function poseAt(i: number, n: number): Pose {
  const dx = PEAK.x - 50;
  const dy = PEAK.y - 50;
  const r = Math.hypot(dx, dy);
  const theta = Math.atan2(dy, dx) + (2 * Math.PI * i) / n;
  const round = (v: number): number => Math.round(v * 100) / 100;
  return { x: round(50 + r * Math.cos(theta)), y: round(50 + r * Math.sin(theta)) };
}

// ---------- 截帧 ----------

type ExportHooks = Window & {
  __hcExportPose?: (x: number, y: number) => void;
  __hcExportLayer?: (layer: 'background' | 'card') => void;
};

/** 把卡片摆到某个姿态。不用等它画出来，截图时会现画 */
async function setPose(page: Page, pose: Pose): Promise<void> {
  await page.evaluate(([x, y]) => (window as ExportHooks).__hcExportPose?.(x, y), [pose.x, pose.y] as const);
}

/** 竖屏导出分两遍截：先只截背景，再只截卡片（透明底） */
async function setLayer(page: Page, layer: 'background' | 'card'): Promise<void> {
  await page.evaluate((l) => (window as ExportHooks).__hcExportLayer?.(l), layer);
}

/** 按某个倍率截一张当前画面，PNG */
type Shot = (scale: number) => Promise<Buffer>;

/**
 * 在这个页面上截图。
 *
 * 直接走 CDP 的 captureScreenshot 而不是 page.screenshot：后者每张都要做一堆
 * 与这里无关的准备（等字体、藏光标之类），几十帧下来差出好几秒。
 * optimizeForSpeed 让 PNG 用最快的压缩档——帧马上就被解掉，体积无所谓。
 *
 * 出图的分辨率只由 clip.scale 决定，和页面的像素密度无关（实测逐像素一致），
 * 所以页面本身按 1 倍开，屏幕上那一份画得最省；要多清晰由每次截图的倍率定。
 */
async function withCapture<T>(page: Page, signal: AbortSignal, work: (shot: Shot) => Promise<T>): Promise<T> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('拿不到视口尺寸');

  // 超时或别的页面出错时直接关页面：卡在 evaluate 或截图里的调用会立刻失败，而不是一直挂着
  const onAbort = (): void => void page.close().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  const cdp = await page.context().newCDPSession(page);
  try {
    // 页面自己的底色透明时（贴纸、卡片层），浏览器默认的白底也要去掉，否则透明处截出来是白的
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    return await work(async (scale) => {
      signal.throwIfAborted();
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        optimizeForSpeed: true,
        clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale },
      });
      return Buffer.from(shot.data, 'base64');
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
    await cdp.detach().catch(() => undefined);
  }
}

interface SequenceOptions {
  baseUrl: string;
  id: string;
  /** 渲染页的视口（CSS 像素）和地址参数 */
  width: number;
  height: number;
  query: Record<string, string>;
  poses: Pose[];
  scale: number;
  signal: AbortSignal;
  /** 每个页面开始截帧之前做的准备 */
  prepare?: (page: Page) => Promise<void>;
  /** 只在第一个页面上、准备之前做一次（竖屏导出在这里截背景和封面） */
  before?: (page: Page, shot: Shot) => Promise<void>;
  /** 帧按顺序交到这里，不管是哪个页面先截好的 */
  onFrame: (frame: Buffer, index: number) => Promise<void>;
}

/**
 * 用几个页面分头截一串姿态：页面 k 截第 k、k+N、k+2N… 帧，截好的帧按帧序交给 onFrame。
 * 任何一个页面出错，其余页面也立刻停下，不在后台白跑。
 */
async function captureSequence(o: SequenceOptions): Promise<void> {
  const local = new AbortController();
  const signal = AbortSignal.any([o.signal, local.signal]);

  // 乱序截好的帧先放着，轮到它了再交出去；交付串成一条链，保证顺序、也自带背压
  const pending = new Map<number, Buffer>();
  let next = 0;
  let delivering: Promise<void> = Promise.resolve();
  const deliver = (index: number, frame: Buffer): Promise<void> => {
    pending.set(index, frame);
    delivering = delivering.then(async () => {
      for (let f = pending.get(next); f; f = pending.get(next)) {
        pending.delete(next);
        await o.onFrame(f, next);
        next++;
      }
    });
    return delivering;
  };

  await Promise.all(
    Array.from({ length: PARALLEL_PAGES }, (_, k) =>
      withRenderPage(o.baseUrl, o.id, { width: o.width, height: o.height, scale: 1, query: o.query }, (page) =>
        withCapture(page, signal, async (shot) => {
          if (k === 0) await o.before?.(page, shot);
          await o.prepare?.(page);
          for (let i = k; i < o.poses.length; i += PARALLEL_PAGES) {
            await setPose(page, o.poses[i] ?? PEAK);
            await deliver(i, await shot(o.scale));
          }
        }),
      ).catch((error: unknown) => {
        local.abort(error);
        throw error;
      }),
    ),
  );
}

// ---------- 编码 ----------

/** 一个 ffmpeg 进程：帧从标准输入一张张喂进去（PNG 串流），输出写到文件 */
class Encoder {
  readonly #proc: ChildProcessWithoutNullStreams;
  readonly #done: Promise<void>;
  #stderr = '';

  constructor(args: string[], signal: AbortSignal) {
    this.#proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    signal.addEventListener('abort', () => this.kill(), { once: true });
    this.#proc.stdout.resume();
    this.#proc.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-4000);
    });
    // ffmpeg 中途退出时再往管道写会 EPIPE，错误以退出码为准，这里吞掉
    this.#proc.stdin.on('error', () => undefined);
    this.#done = new Promise((resolve, reject) => {
      this.#proc.on('error', reject);
      this.#proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg 失败（退出码 ${code}）：${this.#stderr.trim().slice(-500)}`));
      });
    });
    // 真正的错误在 write / finish 里抛，这里只是别让它变成未处理的 rejection
    this.#done.catch(() => undefined);
  }

  async write(frame: Buffer): Promise<void> {
    if (!this.#proc.stdin.write(frame)) {
      await Promise.race([once(this.#proc.stdin, 'drain'), this.#done]);
    }
  }

  async finish(): Promise<void> {
    this.#proc.stdin.end();
    await this.#done;
  }

  kill(): void {
    if (this.#proc.exitCode === null) this.#proc.kill('SIGKILL');
  }
}

/**
 * 截图是 sRGB，转成 BT.709 的有限范围 YUV 4:2:0，并把色彩信息标清楚。
 * 不标的话，iOS 和一些安卓相册会按 BT.601 解，整体偏色（红偏橙、绿偏黄）。
 * 标记要在滤镜里用 setparams 打到帧上：只给编码器传 -color_primaries 之类的参数，
 * 新版 ffmpeg 会被帧上的「未指定」盖掉（实测 8.1 如此），文件里还是 unknown。
 */
const TO_BT709 =
  'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,' +
  'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';

// ---------- 各格式 ----------

/**
 * 手机竖屏的两种格式共用的画面参数。画布 360×640（CSS 像素）：
 * 封面按 3 倍截成 1080×1920，视频帧按 2 倍截成 720×1280。
 * 25 帧/秒、一圈 1.6 秒，共 41 帧（首尾各一帧落在峰值姿态上）。
 * 最初按 3 倍、61 帧、HEVC 编，服务器上一张要两分多钟。
 */
const PHONE = { width: 360, height: 640, stillScale: 3, videoScale: 2, fps: 25, steps: 40 };

/**
 * 透明底贴纸的画面参数。APNG 每一帧都是一整张图，体积涨得很快：
 * 卡片宽 300、按 1.25 倍截（375 像素宽），20 帧/秒、一圈 2 秒共 40 帧，首尾相接循环。
 * 量化成 256 色之后竖卡约 3MB、横卡约 1.5MB。试过 1.5 倍、48 帧，竖卡要 5.6MB。
 */
const STICKER = { cardWidth: 300, margin: 36, scale: 1.25, fps: 20, steps: 40 };

async function readManifestRatio(dir: string): Promise<number> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
    source?: { width?: number; height?: number };
  };
  const w = manifest.source?.width ?? 0;
  const h = manifest.source?.height ?? 0;
  return w > 0 && h > 0 ? w / h : 0.718;
}

/**
 * 渲染竖屏视频（H.264，按 output 指定的格式写出），并给出封面的完整画面（PNG）。
 *
 * 分两遍截：背景（照片糊开的底色）是静的，只截一次；卡片每帧截，透明底，
 * 由 ffmpeg 叠到背景上。卡片自成一个隔离的合成层（带 transform 和 filter），
 * 和背景之间没有混合模式，分开截再叠回去和一次截出来是等价的。
 * 背景那张模糊了 90px，每帧重算一遍的话，光它就比卡片还贵。
 *
 * 不开 B 帧：封面帧的时刻要能直接从帧序号算出来（实况照片的 still-image-time、
 * 动态照片的 PresentationTimestampUs 都指着它）。
 */
async function renderPhone(
  baseUrl: string,
  id: string,
  tmp: string,
  output: string[],
  signal: AbortSignal,
): Promise<{ cover: Buffer; frames: number }> {
  const poses = Array.from({ length: PHONE.steps + 1 }, (_, i) => poseAt(i, PHONE.steps));
  const background = `${tmp}-bg.png`;
  // 编码器要等背景截好、落了盘才能起（背景是它的第 0 路输入），所以在 before 里创建
  const state: { encoder: Encoder | null; cover: Buffer | null } = { encoder: null, cover: null };

  try {
    await captureSequence({
      baseUrl,
      id,
      width: PHONE.width,
      height: PHONE.height,
      query: { export: 'phone' },
      poses,
      scale: PHONE.videoScale,
      signal,
      async before(page, shot) {
        await setLayer(page, 'background');
        const bg = await shot(PHONE.stillScale);
        await setLayer(page, 'card');
        await setPose(page, PEAK);
        state.cover = await sharp(bg)
          .composite([{ input: await shot(PHONE.stillScale) }])
          .png()
          .toBuffer();
        await sharp(bg)
          .resize(PHONE.width * PHONE.videoScale, PHONE.height * PHONE.videoScale)
          .png()
          .toFile(background);
        state.encoder = new Encoder(
          [
            ...['-framerate', String(PHONE.fps), '-loop', '1', '-i', background],
            ...['-f', 'image2pipe', '-framerate', String(PHONE.fps), '-c:v', 'png', '-i', 'pipe:0'],
            // 在 RGB 下把卡片叠到背景上，再转色彩空间
            ...['-filter_complex', `[0:v][1:v]overlay=format=rgb:shortest=1,${TO_BT709}[v]`, '-map', '[v]'],
            ...['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-bf', '0'],
            ...['-map_metadata', '-1', '-fflags', '+bitexact'],
            ...output,
          ],
          signal,
        );
      },
      prepare: (page) => setLayer(page, 'card'),
      onFrame: async (frame) => {
        if (!state.encoder) throw new Error('编码器没有启动');
        await state.encoder.write(frame);
      },
    });
    if (!state.encoder) throw new Error('编码器没有启动');
    await state.encoder.finish();
  } catch (error) {
    state.encoder?.kill();
    throw error;
  } finally {
    await rm(background, { force: true });
  }
  if (!state.cover) throw new Error('没有截到封面');
  return { cover: state.cover, frames: poses.length };
}

/** 封面 JPEG。手机相册里看到的静态图就是它，给足质量 */
function coverJpeg(png: Buffer): Promise<Buffer> {
  return sharp(png).jpeg({ quality: 92 }).toBuffer();
}

async function exportLive(baseUrl: string, id: string, tmp: string, signal: AbortSignal): Promise<Buffer[]> {
  const mov = `${tmp}.mov`;
  /*
   * H.264 的 MOV。iPhone 的相机设成「兼容性最佳」时拍的实况照片就是这样，
   * 真机默认的 HEVC 在服务器上编得太慢（同样的帧 x265 要 30 秒，x264 7 秒）。
   * moov 放在末尾（不加 faststart）：livephoto.ts 要在它前面插一段新的 mdat。
   * 时间刻度和真机一样用 600。
   */
  const output = ['-video_track_timescale', '600', '-movie_timescale', '600', '-f', 'mov', mov];
  try {
    const { cover, frames } = await renderPhone(baseUrl, id, tmp, output, signal);
    const contentId = randomUUID().toUpperCase();
    const video = packLivePhotoMov(await readFile(mov), contentId, frames - 1);
    const still = packLivePhotoJpeg(await coverJpeg(cover), contentId);
    return [still, video];
  } finally {
    await rm(mov, { force: true });
  }
}

async function exportMotion(baseUrl: string, id: string, tmp: string, signal: AbortSignal): Promise<Buffer[]> {
  const mp4 = `${tmp}.mp4`;
  try {
    const output = ['-movflags', '+faststart', '-f', 'mp4', mp4];
    const { cover, frames } = await renderPhone(baseUrl, id, tmp, output, signal);
    const presentationUs = ((frames - 1) / PHONE.fps) * 1_000_000;
    return [await packMotionPhoto(cover, await readFile(mp4), presentationUs)];
  } finally {
    await rm(mp4, { force: true });
  }
}

async function exportApng(baseUrl: string, id: string, dir: string, signal: AbortSignal): Promise<Buffer[]> {
  const ratio = await readManifestRatio(dir);
  // 首尾相接：只截 0..steps-1，第 steps 帧就是第 0 帧
  const poses = Array.from({ length: STICKER.steps }, (_, i) => poseAt(i, STICKER.steps));
  const frames: Buffer[] = [];
  const size = { width: 0, height: 0 };

  await captureSequence({
    baseUrl,
    id,
    width: STICKER.cardWidth + STICKER.margin * 2,
    height: Math.round(STICKER.cardWidth / ratio) + STICKER.margin * 2,
    query: { export: 'sticker' },
    poses,
    scale: STICKER.scale,
    signal,
    prepare: (page) =>
      page.evaluate((margin) => {
        document.body.style.setProperty('--export-margin', `${margin}px`);
      }, STICKER.margin),
    onFrame: async (png) => {
      const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      frames.push(data);
      size.width = info.width;
      size.height = info.height;
    },
  });
  signal.throwIfAborted();

  /*
   * 量化成调色板再编：真彩 + alpha 直接编要 9MB，箔面全是细颗粒，无损压缩几乎压不动。
   *
   * APNG 全片只能有一个调色板，所以所有帧上下摞成一张长图，交给 sharp（libimagequant）
   * 一起量化——它带抖动，调色板也带逐项 alpha，阴影和圆角的半透明边是平滑的。
   * 量化完的帧颜色不超过 255 种，UPNG.js 拿到后直接按调色板无损写成 APNG。
   * 为什么不让 UPNG.js 自己量化：它没有抖动，阴影和暗部一圈圈的色带（实测）；
   * ffmpeg 的 palettegen 只有全透明 / 不透明两档，边缘一圈锯齿。
   * UPNG.js 自己会占一格给全透明（0x00000000），所以量化只要 255 色，
   * 而且全透明像素要统一清成 0——libimagequant 给透明色随手留了 RGB，
   * 不清的话多出一种颜色、凑成 257 种，UPNG.js 就退回真彩编码（实测踩到过，3.4MB）。
   */
  const { width: w, height: h } = size;
  const quantized = await sharp(
    await sharp(Buffer.concat(frames), { raw: { width: w, height: h * frames.length, channels: 4 } })
      .png({ palette: true, colours: 255, dither: 0.5, compressionLevel: 0 })
      .toBuffer(),
  )
    .ensureAlpha()
    .raw()
    .toBuffer();
  const pixels = new Uint32Array(quantized.buffer, quantized.byteOffset, quantized.length / 4);
  for (let i = 0; i < pixels.length; i++) {
    // 小端机器上 alpha 在最高字节
    if ((pixels[i] ?? 0) >>> 24 === 0) pixels[i] = 0;
  }
  const frameBytes = w * h * 4;
  const buffers = frames.map((_, i) => {
    const slice = quantized.subarray(i * frameBytes, (i + 1) * frameBytes);
    return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer;
  });
  // 第 4 个参数 0 = 不再量化；每帧时长单位是毫秒
  const delays = frames.map(() => 1000 / STICKER.fps);
  return [Buffer.from(UPNG.encode(buffers, w, h, 0, delays))];
}

/**
 * 生成一种格式的导出，写进卡片目录。
 *
 * 先写临时文件再改名：生成到一半失败或者服务被重启，目录里不会留下半截文件，
 * exportReady 看到的永远是完整的。
 */
export async function runExport(
  baseUrl: string,
  id: string,
  dir: string,
  format: ExportFormat,
): Promise<void> {
  const tmp = join(dir, `.export-${randomUUID()}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('导出超时')), EXPORT_TIMEOUT_MS);
  const { signal } = controller;

  try {
    const outputs =
      format === 'live'
        ? await exportLive(baseUrl, id, tmp, signal)
        : format === 'motion'
          ? await exportMotion(baseUrl, id, tmp, signal)
          : await exportApng(baseUrl, id, dir, signal);
    const files = exportFiles(format, id);
    await Promise.all(outputs.map((data, i) => writeFile(`${tmp}-${i}`, data)));
    // 同一格式的几个文件依次改名。实况照片是两个文件，缺了任何一个 exportReady 都判成没好
    for (const [i, f] of files.entries()) {
      await rename(`${tmp}-${i}`, join(dir, f.file));
    }
  } catch (error) {
    // 超时关掉页面之后，里面报的是「页面已关闭」之类，换成真正的原因
    throw signal.aborted ? signal.reason : error;
  } finally {
    clearTimeout(timer);
    await Promise.all([0, 1].map((i) => rm(`${tmp}-${i}`, { force: true }).catch(() => undefined)));
  }
}
