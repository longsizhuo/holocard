/**
 * 网页用的卡片接口：上传、任务状态、分享、导出动图、作者配置、删除、层文件，以及给浏览器端退回处理用的模型权重
 */

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { applyConfig, parseConfig } from '../../src/format/config';
import type { LayerManifest } from '../../src/format/types';
import { LANGS } from '../../src/i18n/core';
import { owns, sessionOf } from '../account/session';
import {
  EXPORT_RATE_LIMIT,
  KEEP_DOUBLINGS_CAP,
  MATTE_READY,
  MAX_EXPORT_QUEUE,
  MAX_QUEUE,
  MODEL_DIR,
  OUT_DIR,
  PUBLIC_ORIGIN,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  TTL_MS,
} from '../config';
import { clientIp, fail, json, makeLimiter, readBody, requestLang, sameOrigin } from '../http';
import { queuedEta, runningEta } from '../pipeline/eta';
import { acceptUpload, apiJobs, dequeue, ensureThumb, queue } from '../pipeline/jobs';
import { EXPORT_FILE, EXPORT_FORMATS, exportFiles, type ExportFormat } from '../render/export';
import {
  exportErrors,
  exportKey,
  exportQueue,
  exportStatus,
  pumpExports,
  type ExportJob,
} from '../render/exports';
import { previewFile, queuePreview } from '../render/previews';
import { db } from '../store';
import { expiresAt } from '../store/cards';

/** 上传分层的限流 */
const rateLimited = makeLimiter(RATE_LIMIT, RATE_WINDOW_MS);
/** 导出动图的限流，和上传分开计数 */
const exportLimited = makeLimiter(EXPORT_RATE_LIMIT, RATE_WINDOW_MS);

/**
 * 卡片目录里对外发的文件：清单、层图（新卡是 WebP，老卡是 PNG）、各语言的分享图、原图。
 * 导出的动图另见 export.ts 的 EXPORT_FILE
 */
const LAYER_FILE =
  /^(?:manifest\.json|layer-\d{1,2}\.(?:png|webp)|preview(?:-(?:en|ja))?\.jpg|thumb\.jpg|original\.(?:jpg|png|webp))$/;

/** 卡片相关的 /api 路由（上传、分享、导出、作者配置、删除、层文件、权重、任务状态）。没接住返回 false */
export async function handleCards(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    if (rateLimited(clientIp(req))) {
      const minutes = Math.round(RATE_WINDOW_MS / 60000);
      fail(res, 429, 'rate_limited', `提交太频繁了，${minutes} 分钟内最多 ${RATE_LIMIT} 次`, {
        minutes,
        limit: RATE_LIMIT,
      });
      return true;
    }
    // 只数网页任务：对外接口的任务排在后面，另有自己的上限
    const admit = (): boolean => {
      const waiting = queue.length - apiJobs.size;
      if (waiting < MAX_QUEUE) return true;
      fail(res, 503, 'queue_full', `排队的人太多（${waiting} 个在等），稍后再试`, { queued: waiting });
      return false;
    };
    if (!admit()) return true;
    // 登录着做的卡直接归到账号下。只认本站页面发的：兄弟子域借访客的会话传图，会塞进人家的卡册
    const account = sameOrigin(req) ? sessionOf(req) : null;
    const card = await acceptUpload(req, res, 'web', null, admit, account?.user_id ?? null);
    if (!card) return true;

    /*
     * 删除口令只在这里给一次。
     *
     * 不放在 GET /api/jobs/{id} 里：那个接口任何知道 id 的人都能打，
     * 而卡一旦分享出去，id 就是公开的——口令跟着泄漏，删除入口就等于没有。
     * 提交请求的响应只有上传者自己看得到。
     */
    // 归到账号下的卡不给口令：主人认的是会话，口令留在设备上反而会落到下一个用这台设备的人手里
    json(res, 202, {
      id: card.id,
      position: queue.indexOf(card.id) + 1,
      deleteToken: card.user_id ? null : card.delete_token,
    });
    return true;
  }

  // 转为分享状态（保留期改按访问续期），并在后台渲染一张 OG 预览图
  const shareMatch = /^\/api\/cards\/([0-9a-f-]{36})\/share$/.exec(url.pathname);
  if (req.method === 'POST' && shareMatch) {
    const id = shareMatch[1] ?? '';
    const dir = join(OUT_DIR, id);
    const card = db.get(id);
    if (!card || card.status !== 'done' || card.source === 'api') {
      fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
      return true;
    }
    // 只有卡的主人能分享：分享会把卡转成长期保留、公开卡片页、起浏览器渲染预览图。
    // 以前不鉴权，任何拿到 id 的人都能替别人的卡续命
    if (!owns(req, card)) {
      fail(res, 403, 'share_forbidden', '只有生成这张卡的人能分享它');
      return true;
    }
    const now = Date.now();
    // 分享动作本身按一次访问算，保留窗口从此刻起算
    db.update(id, {
      shared: 1,
      shared_at: card.shared_at ?? now,
      last_hit_at: now,
    });
    const updated = db.get(id) ?? card;

    json(res, 200, {
      url: `${PUBLIC_ORIGIN}/c/${id}`,
      expiresAt: expiresAt(updated, TTL_MS, KEEP_DOUBLINGS_CAP),
    });

    // 预览图慢（要起浏览器渲染），不让用户等；排队渲染分享人那个语言的，失败也不影响分享本身
    const lang = requestLang(req, url);
    if (!(await stat(join(dir, previewFile(lang))).catch(() => null))) queuePreview(id, lang);
    return true;
  }

  /*
   * 导出动图（格式由前端按设备决定，见 src/demo/export.ts）。
   *   POST  没有现成的就排队生成，返回当前状态
   *   GET   只查状态，给前端轮询
   * 生成好的文件就放在卡片目录里，和卡片同生共死：过期、被删时一起清掉。
   */
  const exportMatch = /^\/api\/cards\/([0-9a-f-]{36})\/export\/(gif|motion|apng)$/.exec(url.pathname);
  if ((req.method === 'POST' || req.method === 'GET') && exportMatch) {
    const job: ExportJob = { id: exportMatch[1] ?? '', format: (exportMatch[2] ?? 'apng') as ExportFormat };
    const card = db.get(job.id);
    // 对外接口的卡是私有的，不给导出（导出是最重的操作，接口也不提供）
    if (!card || card.status !== 'done' || card.source === 'api') {
      fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
      return true;
    }
    const current = await exportStatus(job);
    if (req.method === 'GET' || (current.state !== 'none' && current.state !== 'error')) {
      json(res, 200, current);
      return true;
    }

    if (exportLimited(clientIp(req))) {
      fail(res, 429, 'export_rate_limited', '导出太频繁了，过几分钟再试');
      return true;
    }
    if (exportQueue.length >= MAX_EXPORT_QUEUE) {
      fail(res, 503, 'export_busy', '现在导出的人太多，稍后再试');
      return true;
    }
    exportErrors.delete(exportKey(job));
    exportQueue.push(job);
    pumpExports();
    json(res, 202, await exportStatus(job));
    return true;
  }

  /*
   * 卡的主人存作者配置（箔面、炫光、视差，见 src/format/config.ts）。
   * 分享页、OG 预览图、导出的动图都读磁盘上的 manifest，存进去之后它们才按作者调的样子来。
   * 鉴权和删除一样用口令；口令走自定义头，跨站请求会触发预检，这个服务不答 OPTIONS，所以借不了访客的浏览器
   */
  const configMatch = /^\/api\/cards\/([0-9a-f-]{36})\/config$/.exec(url.pathname);
  if (req.method === 'PUT' && configMatch) {
    const id = configMatch[1] ?? '';
    const dir = join(OUT_DIR, id);

    const card = db.get(id);
    if (!card || card.status !== 'done' || card.source === 'api') {
      fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
      return true;
    }
    if (!owns(req, card)) {
      fail(res, 403, 'wrong_token', '口令不对，只有生成这张卡的人能改它');
      return true;
    }

    // 这个处理函数外面没有兜底的 catch，读写盘、解析出错都得在这里接住，不然整个服务挂掉
    let manifest: LayerManifest;
    try {
      manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as LayerManifest;
    } catch {
      fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
      return true;
    }
    let config;
    try {
      config = parseConfig(JSON.parse((await readBody(req, 8192)).toString('utf8')), manifest.layers.length);
    } catch {
      config = null;
    }
    if (!config) {
      fail(res, 400, 'bad_config', '配置不合法');
      return true;
    }
    applyConfig(manifest, config);
    try {
      // 先写临时文件再改名：同一时刻可能有人正在读这份 manifest（分享页、导出），不能让他读到写了一半的
      const tmp = join(dir, `manifest.json.${randomUUID()}.tmp`);
      await writeFile(tmp, JSON.stringify(manifest));
      await rename(tmp, join(dir, 'manifest.json'));
    } catch (error) {
      console.error(`[config] ${id} 写 manifest 失败`, error);
      fail(res, 500, 'save_failed', '保存失败');
      return true;
    }

    // 导出的动图自己会拿修改时间和 manifest 比，旧的自动作废（见 exportReady）。
    // 预览图只在「还没有」时才生成，得删掉旧的、按原来有的语言重新排队；
    // 新图修改时间变了，og:image 地址上的 ?v= 跟着变，抓取方会重新拿。
    // 正在渲染的那张由 pumpPreviews 自己发现 manifest 变了、重排，这里不用管
    for (const lang of LANGS) {
      const file = join(dir, previewFile(lang));
      if (!(await stat(file).catch(() => null))) continue;
      try {
        await rm(file, { force: true });
      } catch (error) {
        // 删不掉（权限、磁盘出错）不影响配置本身已经存上，只是分享图暂时还是旧的
        console.error(`[config] ${id} 删旧预览图失败`, error);
        continue;
      }
      queuePreview(id, lang);
    }
    json(res, 200, { saved: true });
    return true;
  }

  /*
   * 删除自己的卡。
   *
   * 口令是产出时随 202 响应给上传者的，只有他们手上有（前端存在 localStorage）。
   * 不登录时，一张卡的「所有者」就是「拿着口令的人」；归到账号下的卡认会话（见 owns）。
   * 比较用定长循环而不是 ===，避免把口令的正确前缀长度泄漏出去。
   */
  const deleteMatch = /^\/api\/cards\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (req.method === 'DELETE' && deleteMatch) {
    const id = deleteMatch[1] ?? '';
    const dir = join(OUT_DIR, id);

    const card = db.get(id);
    // 对外接口的卡走 /v1 删，这里当作不存在（不然错口令回 403、没有的卡回 404，能用来试探 id）
    if (!card || card.status === 'deleted' || card.status === 'expired' || card.source === 'api') {
      fail(res, 404, 'card_not_found', '这张卡不存在或已过期');
      return true;
    }
    if (!owns(req, card)) {
      fail(res, 403, 'wrong_token', '口令不对，只有生成这张卡的人能删除它');
      return true;
    }

    // 还在排队的也能删：从队列里拿掉，免得删完又被处理出来。排着的导出同理
    dequeue(id);
    for (let i = exportQueue.length - 1; i >= 0; i--) {
      if (exportQueue[i]?.id === id) exportQueue.splice(i, 1);
    }

    /*
     * 先改状态再删文件。正在处理的卡，处理那边还在往目录里写层图：
     * 状态先成了 deleted，处理完写回 done 就不生效、会自己把产物清掉（见 runJob）；
     * rm 撞上正在写的文件可能失败（ENOTEMPTY），接住，残留由处理那边收尾
     */
    db.update(id, { status: 'deleted', stage: null });
    // 文件（含原图）全删；数据库那一行留着，只改状态，统计时还能数到。
    // 被站长下架过的卡，隔离区里那份也一起删：上传者要删，页面上承诺的是服务端的文件都清掉
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(join(OUT_DIR, '.removed', id), { recursive: true, force: true }).catch(() => undefined);
    console.log(`[delete] ${id} 已被创建者删除`);
    json(res, 200, { deleted: true });
    return true;
  }

  /*
   * 层文件。本来想交给 Caddy 直接发静态文件，但那样开发环境（没有 Caddy）就跑不通，
   * 而且服务自己能发才算自包含——别人拿去单跑一个 Node 进程就够了。
   * 路径两段都严格匹配，不给目录穿越留口子。
   */
  const fileMatch = /^\/api\/layers\/([0-9a-f-]{36})\/([\w.-]+)$/.exec(url.pathname);
  const fileName = fileMatch?.[2] ?? '';
  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    fileMatch &&
    (LAYER_FILE.test(fileName) || EXPORT_FILE.test(fileName))
  ) {
    const [, id, name] = fileMatch;
    // 对外接口的卡走 /v1/cards/<id>/files（要 key），公开路由上当作不存在
    if (db.get(id ?? '')?.source === 'api') {
      json(res, 404, { error: '层文件不存在或已过期' });
      return true;
    }
    // 卡册缩略图还没有就先做（见 ensureThumb）。卡已经过期、被删的做不出来，照常落到下面的 404
    if (name === 'thumb.jpg') await ensureThumb(id ?? '');
    // 导出的动图按下载处理，文件名用给用户看的那个（HoloCard_xxxx.jpg 之类）
    const exported = EXPORT_FORMATS
      .flatMap((format) => exportFiles(format, id ?? ''))
      .find((f) => f.file === name);
    try {
      const body = await readFile(join(OUT_DIR, id ?? '', name ?? ''));
      res.writeHead(200, {
        'content-type': name?.endsWith('.png')
          ? 'image/png'
          : name?.endsWith('.jpg')
            ? 'image/jpeg'
            : name?.endsWith('.webp')
              ? 'image/webp'
              : name?.endsWith('.gif')
                ? 'image/gif'
                : 'application/json; charset=utf-8',
        ...(exported ? { 'content-disposition': `attachment; filename="${exported.download}"` } : {}),
        'content-length': body.byteLength,
        /*
         * 层图和预览图按 id 是真的不变，可以 immutable。
         * manifest.json 不是：里面的视差、箔面这些参数是会被改的
         * （修过一次分层判据之后，存量卡片的视差就地打过补丁）。
         * 标成 immutable 的话边缘会攥着旧参数不放，改了也不生效。
         */
        'cache-control':
          name === 'manifest.json'
            ? 'public, max-age=60'
            : 'public, max-age=3600, immutable',
        /*
         * 用户的照片不进搜索结果（包括图片搜索）。
         * 用响应头而不是在 robots.txt 里挡：分享图也在这个路径下，Twitter 的爬虫遵守 robots.txt，
         * 挡了的话分享卡片就取不到图了。noindex 只管「别收录」，不影响抓取。
         */
        'x-robots-tag': 'noindex',
      });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
    } catch {
      json(res, 404, { error: '层文件不存在或已过期' });
    }
    return true;
  }

  /*
   * 深度模型的权重，给浏览器端退回处理用（见 src/segmenter/runtime.ts 的 useOwnModelHost）。
   * 国内连不上 huggingface.co，本站能打开，权重就能下。只发服务端自己在用的那三个文件。
   * 27MB 的文件用流发，不整个读进内存。
   */
  const modelMatch =
    /^\/models\/(onnx-community\/depth-anything-v2-small\/(?:config\.json|preprocessor_config\.json|onnx\/model_quantized\.onnx))$/.exec(
      url.pathname,
    );
  if ((req.method === 'GET' || req.method === 'HEAD') && modelMatch) {
    const file = join(MODEL_DIR, modelMatch[1] ?? '');
    const info = await stat(file).catch(() => null);
    if (!info) {
      json(res, 404, { error: 'not found' });
      return true;
    }
    res.writeHead(200, {
      'content-type': file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream',
      'content-length': info.size,
      // 同一个版本的权重不会变；换模型时路径里的文件名也会跟着变
      'cache-control': 'public, max-age=604800',
      'access-control-allow-origin': '*',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
    return true;
  }

  const jobMatch = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (req.method === 'GET' && jobMatch) {
    const card = db.get(jobMatch[1] ?? '');
    // 删掉的、过期的对前端来说都是「没有了」，不暴露内部状态。对外接口的卡查 /v1/cards/<id>
    if (!card || card.status === 'deleted' || card.status === 'expired' || card.status === 'removed' || card.source === 'api') {
      fail(res, 404, 'job_not_found', '任务不存在或已过期');
      return true;
    }
    // 对外仍然叫 state，前端不用改
    const position = card.status === 'queued' ? queue.indexOf(card.id) + 1 : 0;
    // 还要多少秒，给前端的倒计时（见 eta.ts）
    const eta =
      card.status === 'running' ? runningEta(card.id) : card.status === 'queued' ? queuedEta(position, MATTE_READY) : null;
    json(res, 200, {
      state: card.status,
      stage: card.stage,
      position,
      ...(eta === null ? {} : { eta: Math.round(eta) }),
      ...(card.status === 'done'
        ? { layers: `/api/layers/${card.id}`, layerCount: card.layer_count }
        : {}),
      ...(card.error ? { error: card.error } : {}),
    });
    return true;
  }
  return false;
}
