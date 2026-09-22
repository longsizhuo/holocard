/**
 * 预览分享图（OG）
 *
 * 调分享图样式用的：改完 src/demo/style.css 或 main.ts 里渲染模式那段，跑一下就能看到结果，
 * 不用部署、不用真的去微信里分享。
 *
 * 用法：
 *   pnpm og                        用默认测试图出一张，写到 out/og-preview.jpg 并打开
 *   pnpm og 图片路径                换一张图
 *   pnpm og --watch                改了前端代码自动重出（盯着 src/）
 *   pnpm og --size 1280x640        出别的尺寸。GitHub 仓库的社交预览图要 1280×640
 *   pnpm og --pose 78,22           换个姿态（指针在卡面上的百分比位置，默认和线上一致）
 *   pnpm og --lang en              右边那段字用英文（en / ja；首页的 og-en.jpg、og-ja.jpg 就是这么出的）
 *   pnpm og --out 路径 --png --no-open
 *   pnpm og --export live          出导出动图：live（实况照片）、motion（动态照片）、apng（电脑上的动图），
 *                                  写到 out/export/，文件名和用户下载到的一样
 *
 * 和线上是同一套渲染：前端用 vite 现构建，截图直接调服务端的 renderPreview，
 * 所以这里看到什么，分享出去就是什么。
 *
 * 分层结果按图片内容的哈希缓存在 .og-cache/ 里。调样式的时候模型推理（几秒）是纯浪费，
 * 只在换图时跑一次。
 */

import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { env } from '@huggingface/transformers';
import { segmentToLayerSet } from '../src/segmenter';
import { sharpImages } from '../server/images';
import { renderPreview, closeBrowser } from '../server/preview';
import { EXPORT_FORMATS, exportFiles, runExport, type ExportFormat } from '../server/export';

/**
 * 仓库根目录：从脚本所在位置往上找 package.json。
 * 不能写死「上一级」——这个文件打包之后在 .og-cache/bin/ 里跑，和源码的位置差了两层。
 */
function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error('找不到仓库根目录（package.json）');
    dir = up;
  }
}
const ROOT = findRoot();
const DIST = join(ROOT, 'dist');
const CACHE = join(ROOT, '.og-cache');
const DEFAULT_IMAGE = join(ROOT, 'scripts', 'fixtures', 'og-test.jpg');

// ---------- 参数 ----------

interface Args {
  image: string;
  out: string;
  width: number;
  height: number;
  png: boolean;
  open: boolean;
  watch: boolean;
  pose: { x: number; y: number } | null;
  export: ExportFormat | null;
  lang: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    image: DEFAULT_IMAGE,
    out: '',
    width: 1200,
    height: 630,
    png: false,
    open: true,
    watch: false,
    pose: null,
    export: null,
    lang: 'zh',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const next = (): string => argv[++i] ?? '';
    if (a === '--watch') args.watch = true;
    else if (a === '--no-open') args.open = false;
    else if (a === '--png') args.png = true;
    else if (a === '--out') args.out = resolve(next());
    else if (a === '--pose') {
      const m = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(next());
      if (!m) throw new Error('--pose 的格式是 x,y，卡面上的百分比位置，比如 78,22');
      args.pose = { x: Number(m[1]), y: Number(m[2]) };
    }
    else if (a === '--lang') {
      const lang = next();
      if (!['zh', 'en', 'ja'].includes(lang)) throw new Error('--lang 只认 zh / en / ja');
      args.lang = lang;
    }
    else if (a === '--export') {
      const format = next();
      if (!EXPORT_FORMATS.includes(format as ExportFormat)) {
        throw new Error(`--export 只认 ${EXPORT_FORMATS.join(' / ')}`);
      }
      args.export = format as ExportFormat;
    }
    else if (a === '--size') {
      const m = /^(\d+)x(\d+)$/.exec(next());
      if (!m) throw new Error('--size 的格式是 宽x高，比如 1280x640');
      args.width = Number(m[1]);
      args.height = Number(m[2]);
    } else if (!a.startsWith('--')) args.image = resolve(a);
    else throw new Error(`不认识的参数 ${a}`);
  }
  args.out ||= join(ROOT, 'out', `og-preview.${args.png ? 'png' : 'jpg'}`);
  return args;
}

// ---------- 分层（按哈希缓存） ----------

/** 用图片内容的哈希当卡片 id。渲染页的路由要求 36 位 UUID 格式，这里把哈希摆成那个样子 */
function idFromHash(hash: string): string {
  const h = hash.slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

async function ensureLayers(image: string): Promise<string> {
  const bytes = await readFile(image);
  const id = idFromHash(createHash('sha256').update(bytes).digest('hex'));
  const dir = join(CACHE, id);

  if (await stat(join(dir, 'manifest.json')).catch(() => null)) {
    console.log(`分层：用缓存（${id.slice(0, 8)}）`);
    return id;
  }

  const models = join(ROOT, '.models');
  if (!(await stat(models).catch(() => null))) {
    throw new Error(
      `找不到模型权重 ${models}。下载方法见 deploy/README.md「模型权重」一节，放到这个目录下即可`,
    );
  }
  env.localModelPath = models;
  env.allowRemoteModels = false;

  console.log('分层：第一次用这张图，跑一遍模型（之后走缓存）…');
  const started = Date.now();
  const set = await segmentToLayerSet(new Blob([new Uint8Array(bytes)]), {
    extract: { images: sharpImages },
  });
  await mkdir(dir, { recursive: true });
  await Promise.all(
    set.manifest.layers.map(async (layer, i) => {
      const blob = set.images[i];
      if (blob) await writeFile(join(dir, layer.file), Buffer.from(await blob.arrayBuffer()));
    }),
  );
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(set.manifest));
  const layers = set.manifest.layers.map((l) => l.parallax.toFixed(2)).join(' / ');
  console.log(
    `分层：${set.manifest.layers.length} 层，视差 ${layers}，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  return id;
}

// ---------- 最小静态服务 ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/**
 * 只做渲染页需要的两件事：发 dist/ 里的前端，发缓存里的层文件。
 * 不复用 server/index.ts——那边会连带启动数据库、清理任务这些，这里一样都用不上。
 */
function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    void (async () => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);

      const layer = /^\/api\/layers\/([0-9a-f-]{36})\/([\w.-]+)$/.exec(path);
      if (layer) {
        const file = join(CACHE, layer[1] ?? '', layer[2] ?? '');
        const body = await readFile(file).catch(() => null);
        res.writeHead(body ? 200 : 404, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(body ?? '');
        return;
      }

      // 前端路由（/render/<id>）落不到文件上，回 index.html。
      // 类型要按「实际发出去的是哪个文件」来定，否则回退时会把 HTML 标成二进制流，浏览器直接下载
      const target = resolve(DIST, '.' + path);
      const file = target.startsWith(DIST + sep) ? await readFile(target).catch(() => null) : null;
      const body = file ?? (await readFile(join(DIST, 'index.html')));
      const ext = file ? extname(target) : '.html';
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      ok({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------- 构建、截图、打开 ----------

async function buildFrontend(): Promise<void> {
  const started = Date.now();
  await build({ root: ROOT, logLevel: 'error' });
  console.log(`前端：构建完成（${Date.now() - started}ms）`);
}

async function render(base: string, id: string, args: Args): Promise<void> {
  const started = Date.now();
  const buf = await renderPreview(base, id, {
    width: args.width,
    height: args.height,
    format: args.png ? 'png' : 'jpeg',
    ...(args.pose ? { pose: args.pose } : {}),
    lang: args.lang,
  });
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, buf);
  console.log(
    `出图：${args.width}×${args.height} → ${args.out}（${(buf.length / 1024).toFixed(0)}KB，${Date.now() - started}ms）`,
  );
}

/** 出一种导出格式，拷到 out/export/ 下，用和用户下载时一样的文件名 */
async function renderExport(base: string, id: string, format: ExportFormat): Promise<string> {
  const started = Date.now();
  const dir = join(CACHE, id);
  await runExport(base, id, dir, format);
  const outDir = join(ROOT, 'out', 'export');
  await mkdir(outDir, { recursive: true });
  let first = '';
  for (const f of exportFiles(format, id)) {
    const target = join(outDir, f.download);
    const data = await readFile(join(dir, f.file));
    await writeFile(target, data);
    first ||= target;
    console.log(`导出：${target}（${(data.length / 1024).toFixed(0)}KB）`);
  }
  console.log(`导出：${format} 用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return first;
}

function openFile(file: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '""', file] : [file];
  spawn(cmd, argv, { detached: true, stdio: 'ignore' }).unref();
}

/** 盯着前端源码，一改就重新构建、重新出图。连续保存只触发一次 */
function watchSources(onChange: () => Promise<void>): void {
  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  let again = false;
  const run = async (): Promise<void> => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      await onChange();
    } catch (error) {
      console.error('重出失败：', error instanceof Error ? error.message : error);
    } finally {
      busy = false;
      if (again) {
        again = false;
        void run();
      }
    }
  };
  watch(join(ROOT, 'src'), { recursive: true }, (_event, name) => {
    if (!name || !/\.(css|ts)$/.test(String(name))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), 200);
  });
  console.log('\n盯着 src/ 的改动，保存即重出。Ctrl+C 退出');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 本地一般没装 Playwright 自带的那份 Chromium，默认借用系统浏览器
  process.env.HOLOCARD_BROWSER_CHANNEL ??=
    process.platform === 'win32' ? 'msedge' : process.platform === 'darwin' ? 'chrome' : '';

  if (!(await stat(args.image).catch(() => null))) throw new Error(`找不到图片 ${args.image}`);
  console.log(`图片：${args.image}`);

  const id = await ensureLayers(args.image);
  await buildFrontend();
  const { server, base } = await startServer();

  if (args.export) {
    const file = await renderExport(base, id, args.export);
    if (args.open) openFile(file);
    server.close();
    await closeBrowser();
    return;
  }

  await render(base, id, args);
  if (args.open) openFile(args.out);

  if (args.watch) {
    watchSources(async () => {
      await buildFrontend();
      await render(base, id, args);
    });
    return;
  }

  server.close();
  await closeBrowser();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await closeBrowser();
  process.exit(1);
});
