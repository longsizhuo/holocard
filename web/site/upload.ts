/** 上传区：选图或拖图进来 → 太大先缩 → 交给服务端分层（没有服务端时在浏览器里做）→ 放进卡带的卡包 */

import { loadLayerSet } from '../../src/format/io';
import type { LayerSet } from '../../src/format/types';
import { NoBackendError, rememberAccountCard, rememberOwned, segmentOnServer } from './api';
import { doShare } from './actions';
import type { Deck } from './deck';
import { hideProgress, showProgress } from './progress';
import { track } from './track';
import { describeError, need, setText, status } from './text';

const drop = need<HTMLDivElement>('#drop');
const filePicker = need<HTMLInputElement>('#file');

/** 分层中，防止重复提交 */
let busy = false;

export function isBusy(): boolean {
  return busy;
}

/** 服务端的上传上限是 16MB，留一点余量 */
const UPLOAD_LIMIT_BYTES = 15 * 1024 * 1024;
/** 超过上限时缩到的最长边。分层本来就只用到 1400，原图留 4096 以后重跑也够 */
const SHRINK_TO = 4096;

/**
 * 太大的图先在浏览器里缩小再传。
 *
 * 埋点里有人传过 25MB、32MB 的图：服务端直接拒了，页面退回浏览器端又跑不动，
 * 人就走了。浏览器解不开的格式（比如 Chrome 里的 HEIC）原样上传，由服务端判断。
 * 顺带把 EXIF（含 GPS）也去掉了——画到 canvas 上再导出，只剩像素。
 */
async function shrinkIfHuge(file: File): Promise<Blob> {
  if (file.size <= UPLOAD_LIMIT_BYTES || typeof OffscreenCanvas === 'undefined') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  showProgress('progress.shrinking');
  try {
    for (const [side, quality] of [[SHRINK_TO, 0.92], [3072, 0.85]] as const) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      if (blob.size <= UPLOAD_LIMIT_BYTES) return blob;
    }
    return file;
  } finally {
    bitmap.close();
  }
}

/**
 * 分层：交给服务端做，浏览器一个字节的模型都不用下。
 * 只有部署里压根没有分层服务时才回退到浏览器端流水线——自托管的纯静态部署走的就是这条路。
 * 服务端临时不行就报错让人稍后再试，不回退，原因见 api.ts 开头。
 *
 * stage 记着走到了哪一步，失败时随埋点一起报上去：只看错误原文分不清是上传断了、
 * 服务端失败，还是结果下载到一半断了（之前排查时只能拿服务端数据库一条条对）。
 */
async function processImage(deck: Deck, file: File): Promise<void> {
  if (busy) return;
  busy = true;
  drop.classList.remove('is-over');
  // 卡带最右边先放一个卡包，做好了等人来开；等的时候可以回去玩之前的卡
  const pack = deck.startPack();
  showProgress('progress.preparing');
  setText(status, 'status.processing', { name: file.name });
  // 只报体积档位，不报文件名和具体大小
  track('upload', { sizeMb: Math.round(file.size / 1024 / 1024) });

  let stage: 'upload' | 'server' | 'download' | 'browser' = 'upload';
  try {
    let set: LayerSet;
    let serverId: string | null = null;
    try {
      const upload = await shrinkIfHuge(file);
      const result = await segmentOnServer(upload, (p) => {
        if (p.key !== 'progress.uploading') stage = 'server';
        showProgress(p.key, p.params, p.ratio, p.eta);
      });
      stage = 'download';
      set = await loadLayerSet(result.layers);
      serverId = result.id;
      // 删除口令服务端只给这一次，立刻存下来，否则这张卡就没法删了。
      // 登录着做的卡没有口令：它已经归到账号下，卡册里记上就行
      if (result.deleteToken) rememberOwned(result.id, result.deleteToken);
      else rememberAccountCard(result.id);
      track('segment-ok', { where: 'server', layers: set.manifest.layers.length });
      setText(status, 'status.done', { n: set.manifest.layers.length, generator: set.manifest.generator ?? '' });
    } catch (serverError) {
      if (!(serverError instanceof NoBackendError)) throw serverError;

      // 回退：在浏览器里跑。首次要下约 50MB 权重，所以只在根本没有服务端时才走
      console.info('[holocard] 服务端不可用，回退到浏览器端：', serverError.message);
      stage = 'browser';
      showProgress('progress.fallback');
      const { segmentToLayerSet } = await import('../../src/segmenter');
      set = await segmentToLayerSet(file, {
        onProgress: (p) =>
          p.file
            ? showProgress('stage.downloading', { file: p.file }, p.ratio)
            : showProgress(`stage.${p.stage}`, undefined, p.ratio),
      });
      track('segment-ok', { where: 'browser', layers: set.manifest.layers.length });
      setText(status, 'status.doneLocal', {
        n: set.manifest.layers.length,
        generator: set.manifest.generator ?? '',
      });
    }

    pack.done(set, serverId);
    hideProgress();
    // 做好就转成分享状态，不等开包：保留期按访问量延长，预览图提前渲染好，没开包就刷新了卡也还在
    if (serverId) void doShare(true, serverId);
  } catch (error) {
    hideProgress();
    pack.fail(describeError(error));
    const message = error instanceof Error ? error.message : String(error);
    // 只报错误信息和走到哪一步，不报文件名——那是用户的东西
    track('segment-fail', { stage, message: message.slice(0, 120) });
    setText(status, 'status.failed', { message: describeError(error) });
  } finally {
    busy = false;
  }
}

/** 接上上传区的点击、键盘、文件选择和拖放 */
export function initUpload(deck: Deck): void {
  drop.addEventListener('click', () => filePicker.click());
  // 上传区是 role="button" 的 div，回车、空格要自己接，和原生按钮一样能点；
  // 里面那个 input 是隐藏的，键盘选不到，不接的话只用键盘的人传不了图
  drop.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // 空格默认会滚动页面
    event.preventDefault();
    filePicker.click();
  });
  filePicker.addEventListener('change', () => {
    const file = filePicker.files?.[0];
    if (file) void processImage(deck, file);
    // 清空才能连续选同一个文件
    filePicker.value = '';
  });

  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('is-over');
    const file = event.dataTransfer?.files?.[0];
    if (file?.type.startsWith('image/')) {
      void processImage(deck, file);
    } else if (file) {
      setText(status, 'status.imagesOnly');
    }
  });
}
