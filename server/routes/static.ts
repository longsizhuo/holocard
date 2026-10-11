/**
 * 前端静态文件：按请求语言发页面，首页和分享页注入分享标签，robots.txt、sitemap.xml
 */

import { readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { LANGS, LANG_TAG, localizeHtml, translate, type Lang } from '../../src/i18n/core';
import { OUT_DIR, PUBLIC_ORIGIN, WEB_DIR } from '../config';
import { escapeAttr, json } from '../http';
import { PREVIEW_HEIGHT, PREVIEW_WIDTH } from '../render/preview';
import { previewFile, queuePreview } from '../render/previews';
import { db } from '../store';
import { recordHit } from '../store/cards';

/**
 * robots.txt。欢迎所有爬虫，包括 AI 的——站点就是想被找到、被引用。
 * 只挡两类：服务端截分享图用的内部页面，和接口。
 * /api/layers/ 故意不挡：分享图在那下面，挡了 Twitter 取不到图；
 * 用户的图不进搜索结果靠的是那边的 x-robots-tag: noindex 响应头。
 */
export function robotsTxt(): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /render/',
    'Disallow: /api/jobs',
    'Disallow: /api/cards',
    // 模型权重给浏览器端退回处理用，27MB，爬虫抓了没意义
    'Disallow: /models/',
    '',
    `Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`,
    '',
  ].join('\n');
}

/**
 * sitemap.xml。只有首页的三个语言版本：用户的卡片页是 noindex 的，不该出现在这里。
 * 每一条都列出所有语言版本（xhtml:link），搜索引擎据此把它们认成同一页的不同语言。
 * lastmod 取 index.html 的修改时间，也就是最近一次发版。
 */
export async function sitemapXml(): Promise<string> {
  const index = WEB_DIR ? await stat(join(WEB_DIR, 'index.html')).catch(() => null) : null;
  const lastmod = index ? new Date(index.mtimeMs).toISOString().slice(0, 10) : null;
  const url = (lang: Lang): string => `${PUBLIC_ORIGIN}/${lang === 'zh' ? '' : `?lang=${lang}`}`;
  const alternates = [
    ...LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${LANG_TAG[l]}" href="${url(l)}" />`),
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${PUBLIC_ORIGIN}/" />`,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...LANGS.flatMap((lang) => [
      '  <url>',
      `    <loc>${url(lang)}</loc>`,
      ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
      ...alternates,
      '  </url>',
    ]),
    '</urlset>',
    '',
  ].join('\n');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * 前端路由。这些路径落不到文件上，由 index.html 接手，状态码 200。
 *
 * 其他落不到文件的路径同样回 index.html——人打错地址还能看到站点——但状态码是 404。
 * 以前一律回 200，/abc、/wp-admin 在搜索引擎眼里全是和首页一模一样的页面（软 404），
 * 重复内容多了会拉低整站的评价。
 */
const SPA_ROUTES = [
  /^\/$/,
  /^\/index\.html$/,
  /^\/c\/[0-9a-f-]{36}\/?$/,
  /^\/render\/[0-9a-f-]{36}\/?$/,
];

/** 各语言版本的地址：中文就是本来的地址，别的语言带 ?lang= */
function langUrl(path: string, lang: Lang): string {
  return `${PUBLIC_ORIGIN}${path}${lang === 'zh' ? '' : `?lang=${lang}`}`;
}

const OG_LOCALE: Record<Lang, string> = { zh: 'zh_CN', en: 'en_US', ja: 'ja_JP' };

/** OG 和 Twitter card 标签，首页和分享页共用 */
function socialTags(o: {
  url: string;
  title: string;
  description: string;
  image: string | null;
  lang: Lang;
}): string[] {
  return [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escapeAttr(o.url)}" />`,
    `<meta property="og:title" content="${escapeAttr(o.title)}" />`,
    `<meta property="og:description" content="${escapeAttr(o.description)}" />`,
    `<meta property="og:locale" content="${OG_LOCALE[o.lang]}" />`,
    ...LANGS.filter((l) => l !== o.lang).map(
      (l) => `<meta property="og:locale:alternate" content="${OG_LOCALE[l]}" />`,
    ),
    // 预览图还没渲染好时不给 og:image，免得抓取方缓存一个 404
    ...(o.image
      ? [
          `<meta property="og:image" content="${escapeAttr(o.image)}" />`,
          `<meta property="og:image:width" content="${PREVIEW_WIDTH}" />`,
          `<meta property="og:image:height" content="${PREVIEW_HEIGHT}" />`,
          `<meta name="twitter:card" content="summary_large_image" />`,
          `<meta name="twitter:image" content="${escapeAttr(o.image)}" />`,
        ]
      : [`<meta name="twitter:card" content="summary" />`]),
    `<meta name="twitter:title" content="${escapeAttr(o.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(o.description)}" />`,
  ];
}

/**
 * 给 /c/<id> 注入 OG / Twitter card 标签。
 *
 * 这是分享能不能扩散的关键：链接在微信、Twitter 里有没有大图预览，
 * 直接决定别人点不点。标签里的 URL 必须是绝对地址。
 *
 * 标题、描述按分享链接上的语言出（分享人的语言）。分享图优先用同一语言的那张；
 * 那张还没渲染出来时先用中文那张顶上——有图总比没图强，卡片本身才是主角。
 * 图的地址带文件 mtime 当版本号：预览图在 CDN 上按 immutable 缓存，
 * 重新出图之后不换 URL 的话抓取方和边缘都还拿着旧图。
 */
function injectShareMeta(
  html: string,
  id: string,
  lang: Lang,
  preview: { lang: Lang; version: number } | null,
): string {
  const image = preview
    ? `${PUBLIC_ORIGIN}/api/layers/${id}/${previewFile(preview.lang)}?v=${preview.version}`
    : null;
  const tags = [
    ...socialTags({
      url: langUrl(`/c/${id}`, lang),
      title: translate(lang, 'share.ogTitle'),
      description: translate(lang, 'share.ogDescription'),
      image,
      lang,
    }),
    // 用户上传的内容，不进搜索引擎
    `<meta name="robots" content="noindex, nofollow" />`,
  ].join('\n    ');

  return html.replace('</head>', `  ${tags}\n  </head>`);
}

/**
 * 给首页注入 OG / Twitter card 标签、规范地址和各语言版本的地址。
 *
 * 分享图是 public/og.jpg（英文、日文是 og-en.jpg、og-ja.jpg）——用 `pnpm og` 从一张挑好的卡
 * 渲染出来的静态文件，不直接引用某张用户卡：用户的卡会过期、会被删，首页的门面不能跟着没了。
 * 某个语言的图还没做出来时用中文那张。
 *
 * 放在服务端注入而不是写死在 index.html 里，是为了拿 PUBLIC_ORIGIN 拼绝对地址——
 * 别人自托管时地址自然就对。
 */
function injectHomeMeta(html: string, lang: Lang, image: { file: string; version: number } | null): string {
  const tags = [
    ...socialTags({
      url: langUrl('/', lang),
      title: translate(lang, 'home.ogTitle'),
      description: translate(lang, 'home.ogDescription'),
      image: image ? `${PUBLIC_ORIGIN}/${image.file}?v=${image.version}` : null,
      lang,
    }),
    // 每种语言一个规范地址；带别的参数（?utm=…、?pose=…）的都算同一页
    `<link rel="canonical" href="${escapeAttr(langUrl('/', lang))}" />`,
    // 各语言版本在哪；x-default 是不带参数、按浏览器语言自动选的那个入口
    ...LANGS.map(
      (l) => `<link rel="alternate" hreflang="${LANG_TAG[l]}" href="${escapeAttr(langUrl('/', l))}" />`,
    ),
    `<link rel="alternate" hreflang="x-default" href="${escapeAttr(`${PUBLIC_ORIGIN}/`)}" />`,
    `<script type="application/ld+json">${structuredData(html, lang)}</script>`,
  ].join('\n    ');

  return html.replace('</head>', `  ${tags}\n  </head>`);
}

/**
 * 首页的结构化数据（JSON-LD）。
 *
 * 搜索引擎和 AI 靠它确认「这是个免费、开源的网页工具，谁做的，源码在哪」，
 * 不用从一堆按钮文字里猜。描述直接取页面上（已经换成当前语言的）meta description，
 * 不在这里另写一份——改页面描述时这里自动跟着变。
 */
function structuredData(html: string, lang: Lang): string {
  const description =
    /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
  const repo = 'https://github.com/longsizhuo/holocard';
  const license = 'https://www.gnu.org/licenses/gpl-3.0.html';
  const author = { '@type': 'Person', name: 'longsizhuo', url: 'https://github.com/longsizhuo' };

  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        '@id': `${PUBLIC_ORIGIN}/#app`,
        name: 'HoloCard',
        url: langUrl('/', lang),
        description,
        image: `${PUBLIC_ORIGIN}/og.jpg`,
        inLanguage: LANG_TAG[lang],
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Any',
        browserRequirements: 'Requires JavaScript',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY' },
        license,
        author,
        sameAs: [repo],
      },
      {
        '@type': 'SoftwareSourceCode',
        name: 'HoloCard',
        codeRepository: repo,
        programmingLanguage: 'TypeScript',
        license,
        author,
        targetProduct: { '@id': `${PUBLIC_ORIGIN}/#app` },
      },
    ],
  };
  // 放进 <script> 里，「</script>」这类序列得转义掉，否则会提前结束标签
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** 某个文件的 mtime（毫秒取整），不存在返回 null。拿来当 URL 上的版本号 */
async function fileVersion(path: string): Promise<number | null> {
  const s = await stat(path).catch(() => null);
  return s ? Math.floor(s.mtimeMs) : null;
}

/**
 * 发前端静态文件。找不到就回 index.html，交给前端路由。
 *
 * HEAD 和 GET 走同一条路径，只是不写 body——健康检查、链接预览抓取工具、
 * 各种监控都会先发 HEAD，之前只认 GET，它们一律拿到 404。
 *
 * 页面按这次请求的语言发（见 requestLang）：静态文字、标题、分享标签都换成那个语言，
 * 页面一出来就是对的，不用等脚本跑完再变。
 */
export async function serveStatic(
  pathname: string,
  res: ServerResponse,
  method: string,
  ip: string,
  lang: Lang,
): Promise<void> {
  // /c/<id> 要带上这张卡自己的 OG 标签
  const cardPath = /^\/c\/([0-9a-f-]{36})\/?$/.exec(pathname);
  const isHome = pathname === '/' || pathname === '/index.html';
  if (!WEB_DIR) {
    json(res, 404, { error: 'not found' });
    return;
  }

  // 路径可能是畸形的百分号编码，decodeURIComponent 会抛；含 NUL 的路径直接拒绝
  let clean: string;
  try {
    clean = decodeURIComponent(pathname);
  } catch {
    json(res, 400, { error: '非法路径' });
    return;
  }
  if (clean.includes(String.fromCharCode(0))) {
    json(res, 400, { error: '非法路径' });
    return;
  }
  // 规范化之后必须仍在 WEB_DIR 之内，挡住 ../ 之类
  const target = resolve(WEB_DIR, '.' + (clean.endsWith('/') ? clean + 'index.html' : clean));
  const root = resolve(WEB_DIR);
  const safe = target === root || target.startsWith(root + sep);

  // 先找真实文件；落不到文件的回 index.html，不是前端路由的话状态码给 404
  const isFile = (path: string): Promise<boolean> => stat(path).then((s) => s.isFile(), () => false);
  let candidate = target;
  let status = 200;
  // 地址不带 .html：/masks 对应 masks.html，文档站（VitePress cleanUrls）的 /docs/api/x 对应 docs/api/x.html
  if (safe && !(await isFile(target)) && (await isFile(`${target}.html`))) {
    candidate = `${target}.html`;
  } else if (!safe || !(await isFile(target))) {
    candidate = join(root, 'index.html');
    if (!SPA_ROUTES.some((route) => route.test(pathname))) status = 404;
  }
  // 对外接口做的卡是私有的：卡片页对外当作不存在——和不存在的 id 一样回前端页面（200），
  // 但不注入分享标签、不计访问。回 404 的话反而能拿状态码试探出「这是一张活着的接口卡」
  const privateCard = Boolean(cardPath?.[1] && db.get(cardPath[1])?.source === 'api');

  let body: Buffer;
  try {
    body = await readFile(candidate);
  } catch {
    // index.html 都读不到，只能是部署出了问题
    json(res, 404, { error: 'not found' });
    return;
  }
  const ext = extname(candidate);
  const isHashed = candidate.includes(`${sep}assets${sep}`);
  /*
   * 首页示例卡（samples/ 下）每个访客都要下两百多 KB。按 no-cache 发的话，
   * Cloudflare 每次都判过期、整个回源重拉（实测 EXPIRED，出图慢两三秒）。
   * 这些文件不跟着发版变——要换示例卡就换个目录名，旧地址自然没人引用——所以缓存一天没问题。
   *
   * 首页分享图 og*.jpg 同理：抓取方（GitHub 的图片代理、各家的链接预览）从 Cloudflare 回源拉图，
   * 源站那一段慢，拉不完就超时。页面里引用时带 ?v=修改时间，换图会换地址，缓存一天也不会拿到旧图。
   */
  const isStable =
    candidate.startsWith(join(root, 'samples') + sep) ||
    (dirname(candidate) === root && /^og(?:-[a-z]{2})?\.jpg$/.test(basename(candidate)));
  const isHtml = ext === '.html';
  // /docs/ 是 VitePress 生成的文档，自带三种语言的页面，不套首页的标题、描述
  if (isHtml && !pathname.startsWith('/docs/')) body = Buffer.from(localizeHtml(body.toString('utf8'), lang), 'utf8');

  // 404 只是个兜底页：不注入分享标签、不计访问
  if (status === 200 && cardPath?.[1] && isHtml && !privateCard) {
    const id = cardPath[1];
    const dir = join(OUT_DIR, id);
    const own = await fileVersion(join(dir, previewFile(lang)));
    const fallback = own === null && lang !== 'zh' ? await fileVersion(join(dir, previewFile('zh'))) : null;
    const preview =
      own !== null ? { lang, version: own } : fallback !== null ? { lang: 'zh' as Lang, version: fallback } : null;
    body = Buffer.from(injectShareMeta(body.toString('utf8'), id, lang, preview), 'utf8');

    // 这个语言的分享图还没有（渲染失败过、或者是新语言），趁有人打开时补一张
    if (own === null && db.get(id)?.status === 'done') queuePreview(id, lang);

    /*
     * 一次页面访问给这张卡的保留窗口续期。
     *
     * 只在 GET 上计：HEAD 多半是抓取工具和监控，不是真的有人在看。
     * 计数在 cards.ts 里按 IP 做一小时去重，自己反复刷不会把保留期刷上去。
     * 这条路径不会被 CDN 挡掉——/c/<id> 的 cache-control 是 no-cache，每次都回源。
     */
    if (method === 'GET') recordHit(id, ip);
  } else if (status === 200 && isHome && isHtml) {
    const langImage = lang === 'zh' ? null : `og-${lang}.jpg`;
    const langVersion = langImage ? await fileVersion(join(root, langImage)) : null;
    const zhVersion = langVersion === null ? await fileVersion(join(root, 'og.jpg')) : null;
    const image =
      langImage && langVersion !== null
        ? { file: langImage, version: langVersion }
        : zhVersion !== null
          ? { file: 'og.jpg', version: zhVersion }
          : null;
    body = Buffer.from(injectHomeMeta(body.toString('utf8'), lang, image), 'utf8');
  }

  res.writeHead(status, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': body.byteLength,
    // assets 下的文件名带内容 hash，可以永久缓存；示例卡和首页分享图缓存一天（见上）；其余不缓存，保证发版即时生效
    'cache-control': isHashed
      ? 'public, max-age=31536000, immutable'
      : isStable
        ? 'public, max-age=86400'
        : 'no-cache',
    'x-content-type-options': 'nosniff',
    // 同一个地址按语言发不同的页面，任何中间缓存都得把这两个头算进缓存键
    ...(isHtml ? { vary: 'Accept-Language, Cookie', 'content-language': LANG_TAG[lang] } : {}),
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
}
