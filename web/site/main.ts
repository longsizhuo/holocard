/** 首页、卡片页、渲染页的入口：建卡带，把面板各部分接到当前这张卡上，按路由加载首屏 */

import './style.css';
// 珠光底的漂移动画，由 scripts/pearl-keyframes.mjs 生成
import './pearl-drift.css';
import { loadLayerSet } from '../../src/format/io';
import type { LayerSet } from '../../src/format/types';
import { applyTranslations, lang, LANGS, onLangChange, setLang, type Lang } from '../../src/i18n';
import { account, isMine, loadMe } from './api';
import { initAlbums, openAlbums } from './albums-ui';
import { initAccount, openAccount, refreshAccountButton } from './account-ui';
import { hideActions, isExporting, relabelActions, showActions } from './actions';
import { Deck } from './deck';
import { reducedMotion } from './pack';
import { initTracking, pageView, track } from './track';
import { measurePerf } from './perf';
import { finishRender, renderExportLayout } from './render-page';
import { route, shareUrl } from './route';
import { card, current, parallaxOn, pollHalo, relabelTuning, tune, untune } from './tuning';
import { clearText, describeError, need, rewriteTexts, setText, status } from './text';
import { initUpload, isBusy } from './upload';

const panel = need<HTMLElement>('.panel');
const langButtons = [...document.querySelectorAll<HTMLButtonElement>('.lang [data-lang]')];

/*
 * 卡带：这次访问做的卡左右切换，上传时最右边先放一个卡包（见 deck.ts）。
 * 卡片格用 tuning.ts 里那个 HoloCard，面板跟着当前这张卡走；切到卡包格时面板上跟卡有关的先收起来
 */
const deck = new Deck(need<HTMLElement>('.deck'), {
  showCard: (set, id) => show(set, id),
  showPack: showPackPanel,
  revealed: (set, id, method) => {
    show(set, id);
    track('pack-open', { how: method });
    if (id && !isMine(id)) markSeen(id);
    // 地址栏换成这张卡的链接：用浏览器菜单分享、复制地址、刷新，拿到的都是这张卡而不是首页。
    // replaceState 只改地址，不刷新页面，也不多一条后退记录
    if (id) history.replaceState(history.state, '', shareUrl(id, lang()));
  },
  load: (id) => loadLayerSet(`${import.meta.env.BASE_URL}api/layers/${id}`),
  loadFailed: (error) => setText(status, 'status.cardFailed', { message: describeError(error) }),
});

/** 换一组层：面板上的操作按这张卡重新给，卡片和调参面板换成这组层 */
function show(set: LayerSet, id: string | null = null): void {
  panel.classList.remove('is-pack');
  showActions(id);
  tune(set, id);
}

/** 卡带停在卡包上：还没有卡可调、可分享，面板上跟卡有关的先收起来 */
function showPackPanel(): void {
  panel.classList.add('is-pack');
  untune();
  hideActions();
  // 状态栏上可能还是上一张卡的层数，或者首屏的「正在加载素材」，跟卡包对不上，清掉
  clearText(status);
}

initUpload(deck);
initAlbums(need<HTMLDialogElement>('#albums'), describeError);
initAccount(need<HTMLDialogElement>('#account'), need<HTMLButtonElement>('#account-open'), describeError);
// 页头的「文档」按当前语言进对应的那份
const docsLink = need<HTMLAnchorElement>('#docs-link');
function syncDocsLink(l: Lang): void {
  docsLink.href = `${import.meta.env.BASE_URL}docs/${l === 'zh' ? '' : `${l}/`}`;
}
syncDocsLink(lang());

// ---------- 语言切换 ----------

function markLangButtons(active: Lang): void {
  for (const button of langButtons) {
    button.setAttribute('aria-pressed', String(button.dataset['lang'] === active));
  }
}

for (const button of langButtons) {
  button.addEventListener('click', () => {
    const next = LANGS.find((l) => l === button.dataset['lang']);
    if (next) setLang(next);
  });
}

onLangChange((next) => {
  markLangButtons(next);
  syncDocsLink(next);
  rewriteTexts();
  relabelTuning();
  relabelActions(next);
  track('lang', { lang: next });
});

/**
 * 手机上卡片跟着倾斜。iOS 13+ 要在用户手势里申请权限，所以等第一次点卡带再问
 * （挂在整个卡带上而不是卡面上：分享链接打开先是卡包，第一下点的是卡包）；
 * 别的平台直接开。render 模式不开：无头截图要的是固定姿态
 */
function initGyro(): void {
  if (!('DeviceOrientationEvent' in window)) return;
  const request = (
    DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }
  ).requestPermission;
  if (typeof request !== 'function') {
    card.enableGyro();
    return;
  }
  need<HTMLDivElement>('.deck').addEventListener(
    'click',
    () => {
      void request
        .call(DeviceOrientationEvent)
        .then((state) => {
          if (state === 'granted') card.enableGyro();
        })
        .catch(() => {
          // 拒绝了就只能用手指拨，不算错误
        });
    },
    { once: true },
  );
}

// ---------- 启动 ----------

/** 这台设备上开过包的、别人分享的卡。存最近的几百张就够了 */
const SEEN_KEY = 'holocard:seen';
const SEEN_MAX = 300;

function seenCards(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // 隐私模式下可能直接抛：那就每次都出卡包
    return [];
  }
}

function markSeen(id: string): void {
  try {
    const ids = seenCards().filter((other) => other !== id);
    localStorage.setItem(SEEN_KEY, JSON.stringify([...ids, id].slice(-SEEN_MAX)));
  } catch {
    // 同上
  }
}

/**
 * 分享链接要不要先出卡包：别人分享的卡、在这台设备上第一次打开才出。
 * 自己做的卡、开过包的卡直接看；截图和导出用的 render 页面、「减少动态效果」下也不出
 */
function sharedPackDue(id: string): boolean {
  return route.mode === 'card' && !isMine(id) && !reducedMotion() && !seenCards().includes(id);
}

/** 按路由决定首屏加载什么 */
async function boot(): Promise<void> {
  // 服务端发页面时已经按语言换好了文字；这里再过一遍，本地开发（vite 直接发页面）时也对
  applyTranslations();
  markLangButtons(lang());

  // 登录状态决定一张卡算不算「我的」（出不出卡包、给不给分享和删除），卡片页要等它；
  // 首页不等，打开卡册的时候早就回来了。截图用的 render 页面不问
  const meReady = route.mode === 'render' ? Promise.resolve() : loadMe();
  void meReady.then(refreshAccountButton);
  if (route.id) await meReady;
  // 从卡册点的登录，回来时地址带着 #albums：接着把卡册打开，好认领这台设备上的卡；从页头点的带着 #account，打开个人中心
  if (location.hash === '#albums' || location.hash === '#account') {
    const from = location.hash === '#albums' ? 'albums' : 'account';
    history.replaceState(history.state, '', location.pathname + location.search);
    void meReady.then(() => {
      // 带着这个地址回来的只有刚登录完的人（登录入口在卡册和页头）
      if (account().user) track('login', { from });
      if (from === 'albums') openAlbums();
      else openAccount();
    });
  }

  const exportLayout = route.mode === 'render' ? renderExportLayout() : null;
  if (route.mode === 'render') {
    // 给服务端截 OG 图、导出动图用：只留卡片，固定在炫光峰值姿态，不带任何 UI
    document.body.classList.add('is-render');
    if (exportLayout) document.body.classList.add(`is-export-${exportLayout}`);
  } else {
    /*
     * 统计只在真人访问的页面上加载，render 模式（无头浏览器截 OG 图）跳过——
     * 否则每生成一张预览图就多一条假访问，而且刚好都落在分享这个动作上，
     * 会把「分享后有多少人真的点开」这个最关心的数字打歪。
     */
    initTracking();
    initGyro();
    // /c/<uuid> 归一成 /c，否则页面列表会被几千个 uuid 撑爆
    pageView(route.mode === 'card' ? '/c' : '/');
    // 哪张卡带来的流量另走一个事件——pageview 的 payload 塞不下自定义字段
    // 主人自己刷新不算：做完卡地址栏就是卡片链接，刷一下不该算成「分享出去有人点开」
    if (route.mode === 'card' && route.id && !isMine(route.id)) {
      track('card-view', { card: route.id });
    }
  }

  if (route.id) {
    // 层图下完才能挂卡片，网速慢时卡片区会空着很久：先放这张卡的缩略图（约 40KB）占位，挂上卡片再撤掉
    const placeholder =
      route.mode === 'render' ? null : Object.assign(document.createElement('img'), { className: 'deck__placeholder', alt: '', src: `${import.meta.env.BASE_URL}api/layers/${route.id}/thumb.jpg` });
    if (placeholder) {
      placeholder.addEventListener('error', () => placeholder.remove());
      need<HTMLElement>('.deck__view').append(placeholder);
      setText(status, 'status.loadingCard');
    }
    try {
      const set = await loadLayerSet(`${import.meta.env.BASE_URL}api/layers/${route.id}`).finally(() => placeholder?.remove());
      if (sharedPackDue(route.id)) {
        // 卡包格：状态栏由卡带清空，这里不写层数
        deck.addPack(set, route.id);
        return;
      }
      deck.addCard(set, route.id);
      if (route.mode !== 'render') deck.restore();
      setText(status, 'status.layers', { n: set.manifest.layers.length });

      if (route.mode === 'render') await finishRender(card, exportLayout);
      return;
    } catch (error) {
      setText(status, 'status.cardFailed', { message: describeError(error) });
      if (route.mode === 'render') document.body.dataset['ready'] = 'error';
      return;
    }
  }

  try {
    // 首页默认摆的就是分享图（og.jpg）上那张卡，进来第一眼和分享出去的样子一致
    const sample = await loadLayerSet(`${import.meta.env.BASE_URL}samples/demo`);
    deck.addCard(sample, null);
    deck.restore();
    setText(status, 'status.layers', { n: sample.manifest.layers.length });
  } catch (error) {
    setText(status, 'status.sampleFailed', { message: describeError(error) });
  }
}

await boot();
pollHalo();
// 性能埋点，staging 和线上都有。render 模式是服务端的无头浏览器，不是真人的设备；
// 卡片没加载出来（分享链接过期 404）的空页面也不量，不然会把 card 模式的帧率拉高
if (route.mode !== 'render' && current.set) {
  measurePerf(route.mode, () => ({ parallax: parallaxOn(), busy: isBusy() || isExporting() }));
}
