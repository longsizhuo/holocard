/** 面板上对这张卡的操作：分享、删除、导出动图 */

import { lang, t, type Lang, type MessageKey } from '../../src/i18n';
import { deleteCard, isMine, shareCard } from './api';
import { forgetSession } from './deck';
import {
  blockingInAppBrowser,
  detectPlatform,
  download,
  fetchFiles,
  FORMAT_FOR,
  requestExport,
  type Platform,
} from './export';
import { route, shareUrl } from './route';
import { track } from './track';
import { current, flushSave } from './tuning';
import { clearText, describeError, need, setText, status } from './text';

const shareBox = need<HTMLDivElement>('#share');
const shareBtn = need<HTMLButtonElement>('#share-btn');
const shareResult = need<HTMLDivElement>('#share-result');
const ownerBox = need<HTMLDivElement>('#owner');
const deleteBtn = need<HTMLButtonElement>('#delete-btn');
const deleteHint = need<HTMLElement>('#delete-hint');
const shareUrlInput = need<HTMLInputElement>('#share-url');
const shareCopy = need<HTMLButtonElement>('#share-copy');
const shareHint = need<HTMLElement>('#share-hint');
const exportBox = need<HTMLDivElement>('#export');
const exportBtn = need<HTMLButtonElement>('#export-btn');
const exportHint = need<HTMLElement>('#export-hint');

/** 导出按钮按设备说人话：安卓叫动态照片（相册里的叫法），iPhone 存的是 GIF 动图 */
const platform = detectPlatform();
const EXPORT_LABEL: Record<Platform, MessageKey> = {
  ios: 'export.gif',
  android: 'export.motion',
  desktop: 'export.apng',
};
/** 导出进行中，防止重复点 */
let exporting = false;
/**
 * iPhone 上文件取好之后，等用户再点一次按钮才唤起分享面板：
 * Safari 只认用户点击直接唤起的 share()，等了几十秒生成之后再调会被拒绝。
 */
let pendingShare: File[] | null = null;

export function isExporting(): boolean {
  return exporting;
}

function resetExport(): void {
  pendingShare = null;
  exportBtn.disabled = false;
  setText(exportBtn, EXPORT_LABEL[platform]);
  clearText(exportHint);
}

/** 换了一张卡：按这张卡是谁的、有没有服务端 id，决定给哪些操作 */
export function showActions(id: string | null): void {
  // 只有服务端产出的卡才能分享；换卡时把上一张的链接收起来。
  // 卡片页（/c/<id>）上只给卡的主人：做完卡地址栏就换成了卡片链接，主人刷新后落在这里
  shareBox.hidden =
    id === null || route.mode === 'render' || (route.mode === 'card' && !isMine(id));
  shareResult.hidden = true;
  shareBtn.disabled = false;
  setText(shareBtn, 'share.create');
  // 导出不限于卡的主人：别人分享过来的卡也能存成动图
  exportBox.hidden = id === null || route.mode === 'render';
  if (!exporting) resetExport();
  // 只有手上有这张卡口令的人才看得到删除入口
  ownerBox.hidden = id === null || !isMine(id);
  deleteBtn.disabled = false;
  setText(deleteBtn, 'delete.button');
}

export function hideActions(): void {
  shareBox.hidden = true;
  exportBox.hidden = true;
  ownerBox.hidden = true;
}

/** 切换语言后调：已经生成的分享链接也换成新语言的地址 */
export function relabelActions(next: Lang): void {
  if (current.id && !shareResult.hidden) shareUrlInput.value = shareUrl(current.id, next);
}

// ---------- 分享与删除 ----------

/**
 * 把这张卡转为分享状态（保留期改按访问续期，见 server/store/cards.ts 的 expiresAt），并拿到分享链接。
 * 请求头带着当前语言：服务端按它渲染这个语言的分享图，链接上也带上语言，
 * 发到群里别人点开看到的标题、描述、分享图都是分享人的语言。
 *
 * auto：做完卡时自动调的。不算用户的分享动作，不选中输入框（手机上会弹出选择手柄、把页面滚过去），
 * 失败也不提示——按钮还在，用户自己点一下就行。
 */
export async function doShare(auto = false, id: string | null = current.id): Promise<void> {
  if (!id) return;
  // 给还没开包的卡在后台转分享状态时，面板上显示的不是它，按钮别跟着变
  if (id === current.id) {
    shareBtn.disabled = true;
    setText(shareBtn, 'share.creating');
  }

  try {
    // 预览图按服务端上的配置渲染，刚调的那一下得先存上
    await flushSave();
    // 分享只有卡的主人能做（服务端认删除口令或登录状态）：分享会让卡长期保留、公开卡片页
    await shareCard(id);
    // 等待期间换了卡，这个结果就不是当前这张的了
    if (id !== current.id) return;
    shareUrlInput.value = shareUrl(id, lang());
    shareResult.hidden = false;
    setText(shareBtn, 'share.created');
    // 成功不用多说，链接出现在输入框里本身就是反馈
    clearText(shareHint);
    if (!auto) {
      track('share');
      shareUrlInput.select();
    }
  } catch (error) {
    if (id !== current.id) return;
    shareBtn.disabled = false;
    setText(shareBtn, 'share.create');
    if (!auto) setText(shareHint, 'share.failed', { message: describeError(error) });
  }
}

/**
 * 删掉自己的卡。
 *
 * 二次确认是必须的：这个操作不可撤销，而且已经分享出去的链接会立刻失效。
 */
async function doDelete(): Promise<void> {
  const id = current.id;
  if (!id) return;
  if (!confirm(t('delete.confirm'))) return;

  deleteBtn.disabled = true;
  setText(deleteBtn, 'delete.deleting');
  try {
    await deleteCard(id);
    forgetSession(id);
    track('delete');
    // 卡没了，地址栏退回首页，别留着一个打开就是 404 的链接
    history.replaceState(history.state, '', `${import.meta.env.BASE_URL}${location.search}`);
    hideActions();
    setText(status, 'delete.done');
  } catch (error) {
    deleteBtn.disabled = false;
    setText(deleteBtn, 'delete.button');
    setText(deleteHint, 'delete.failed', { message: describeError(error) });
  }
}

// ---------- 导出动图 ----------

/**
 * 导出动图，格式按设备定（见 export.ts）。
 *
 * iPhone 分两步：第一次点生成并把文件取到手上，按钮变成「保存到相册」；
 * 第二次点直接唤起系统分享面板，在里面「存储图像」进相册。
 * 安卓和电脑生成好就直接下载。
 */
async function doExport(): Promise<void> {
  if (pendingShare) {
    // 第二步：这次点击直接唤起分享面板，中间不能有任何 await，否则 Safari 不认这是用户操作
    const files = pendingShare;
    try {
      await navigator.share({ files });
      // 只知道面板里选了某个操作，不知道是不是「存储」
      track('export-share', { format: FORMAT_FOR[platform] });
      resetExport();
    } catch (error) {
      // 用户在面板里点了关闭，不算错，按钮保持「保存到相册」可以再点
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setText(exportHint, 'export.saveFailed', { message: describeError(error) });
    }
    return;
  }

  const id = current.id;
  if (!id || exporting) return;

  const app = blockingInAppBrowser();
  if (app) {
    setText(exportHint, 'export.inApp', { app: t(app) });
    return;
  }

  const format = FORMAT_FOR[platform];
  exporting = true;
  exportBtn.disabled = true;
  setText(exportBtn, 'export.working');
  clearText(exportHint);
  track('export', { format });

  try {
    // 动图按服务端上的配置渲染，刚调的那一下得先存上
    await flushSave();
    const files = await requestExport(id, format, (state) => {
      setText(exportBtn, state === 'queued' ? 'export.queued' : 'export.working');
    });
    // 等的功夫换了一张卡，这份结果就不用了
    if (current.id !== id) {
      resetExport();
      return;
    }

    if (platform === 'ios') {
      const shareFiles = await fetchFiles(files);
      if (navigator.canShare?.({ files: shareFiles })) {
        pendingShare = shareFiles;
        exportBtn.disabled = false;
        setText(exportBtn, 'export.save');
        return;
      }
      // 不支持分享文件的老系统：下载到「文件」App，让用户从那里存进相册
      files.forEach(download);
      resetExport();
      setText(exportHint, 'export.downloaded');
      return;
    }

    const [file] = files;
    if (file) download(file);
    resetExport();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    track('export-fail', { format, message: message.slice(0, 120) });
    resetExport();
    setText(exportHint, 'export.failed', { message: describeError(error) });
  } finally {
    exporting = false;
  }
}

shareBtn.addEventListener('click', () => void doShare());
exportBtn.addEventListener('click', () => void doExport());
deleteBtn.addEventListener('click', () => void doDelete());
shareCopy.addEventListener('click', () => {
  shareUrlInput.select();
  // clipboard API 在非安全上下文下不可用，退回老办法
  navigator.clipboard?.writeText(shareUrlInput.value).catch(() => document.execCommand('copy'));
  // 链接现在做完卡就自动生成，「分享」按钮基本没人点了，复制才是用户真的想发出去
  track('share-copy');
  setText(shareCopy, 'share.copied');
  setTimeout(() => setText(shareCopy, 'share.copy'), 1500);
});
