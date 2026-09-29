/**
 * 卡包。两种画法，接口一样（PackView），卡带只认接口：
 *   - pack-gl.ts 的 GlPack：WebGL 真 3D 铝箔袋，能用 WebGL 的设备都用它
 *   - 这里的 Pack：平面版，退路。一个跟手倾斜的两层「卡」（图案见 pack-art.ts），
 *     倾斜、箔面、炫光都是卡片渲染器现成的
 *
 * 两种都一样的部分：
 *   - 状态：在做（边缘呼吸微光）、做好（微光变亮、出提示）、失败（变灰、写原因）——外壳在 PackChrome
 *   - 开法：沿顶边划过去撕开（swipe）；点一下或按回车、空格，抖几下炸开（tap / key）
 *   - 开包动画：到了该把卡摆上来的那一刻 resolve；播放中再点一下直接跳到这一刻
 * 开出来的卡怎么摆上来由卡带决定（deck.ts），这里不管。
 */

import { HoloCard } from '../renderer/card';
import type { FoilType, LayerSet } from '../format/types';
import { onLangChange, t, type MessageKey } from '../i18n';
import { packLayerSet, TEAR_Y } from './pack-art';

export type PackState = 'working' | 'ready' | 'failed';
export type OpenMethod = 'swipe' | 'tap' | 'key';

/** WebGL 卡包撕开时交给卡带的：袋子里那张卡此刻在屏幕上的位置，和手划的方向（1 往右、-1 往左） */
export interface Handoff {
  rect: DOMRect;
  side: number;
}

export interface PackView {
  /** 图案等资源都就位 */
  readonly ready: Promise<void>;
  setState(state: PackState, message?: string): void;
  /** 卡包的箔面（颜色） */
  setFoil(foil: FoilType): void;
  /** 做好了：里面装的是哪张卡。WebGL 版撕开时要让这张卡从袋口升出来 */
  setCard(set: LayerSet): void;
  onOpen(handler: (method: OpenMethod) => void): void;
  /**
   * 播开包动画，到了该把卡摆上来的那一刻 resolve。
   * WebGL 版撕开时卡从袋口升出来，带回它的位置，卡带从这里接着转；
   * 其他情况是 null，卡带让卡从中间弹出来。zoom：闪卡静止时画面的放大系数，袋子里那张要画得一样大
   */
  playOpen(method: OpenMethod, zoom: number): Promise<Handoff | null>;
  destroy(): void;
}

/** 顶部多高以内按下去算「撕」，占卡包高度的比例。封条本身占 13%，手指没那么准，放宽一点 */
const TEAR_ZONE = 0.22;
/** 划过卡包宽度的这么多就算撕开了，松手自动撕完；不够就弹回去 */
export const TEAR_DONE = 0.6;
/** 位移小于这么多像素的按下松开算点击 */
export const TAP_SLOP = 8;

/** 炸开那团光的颜色跟箔面走 */
export const FLASH: Record<FoilType, string> = {
  sunpillar: 'conic-gradient(from 90deg, #ffb3c7, #ffe8a3, #b8f5c9, #a8e6ff, #c9b8ff, #ffb3c7)',
  rainbow: 'conic-gradient(from 0deg, #ff9ec4, #ffd36e, #8ef0b0, #7fd4ff, #b69cff, #ff9ec4)',
  holo: 'radial-gradient(circle, #ffffff, #cfe3ff)',
  none: 'radial-gradient(circle, #ffffff, #f1ecff)',
};

export const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 卡包默认的箔面：彩虹闪粉 */
export const DEFAULT_PACK_FOIL: FoilType = 'rainbow';

/**
 * 两种卡包共用的外壳：宿主上的状态 class 和无障碍属性、底下那行字、失败时的「关掉」、炸开的那团光。
 * 画卡包的那部分（平面卡 / WebGL 画布）由各自塞到 flash 前面
 */
export class PackChrome {
  readonly flash: HTMLElement;
  #state: PackState = 'working';
  readonly #host: HTMLElement;
  readonly #caption: HTMLElement;
  #captionText: { key: MessageKey; params?: Record<string, string | number> } | null = null;
  readonly #offLang: () => void;

  constructor(host: HTMLElement, onDismiss: () => void) {
    this.#host = host;
    host.classList.add('pack');
    host.tabIndex = 0;
    host.setAttribute('role', 'button');

    this.flash = document.createElement('div');
    this.flash.className = 'pack__flash';
    this.#caption = document.createElement('p');
    this.#caption.className = 'pack__caption';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'pack__dismiss';
    dismiss.addEventListener('click', (event) => {
      event.stopPropagation();
      onDismiss();
    });
    host.append(this.flash, this.#caption, dismiss);

    const relabel = (): void => {
      host.setAttribute('aria-label', t('pack.label'));
      dismiss.textContent = t('pack.dismiss');
      if (this.#captionText) this.#caption.textContent = t(this.#captionText.key, this.#captionText.params);
    };
    relabel();
    this.#offLang = onLangChange(relabel);
    this.setState('working');
  }

  get state(): PackState {
    return this.#state;
  }

  setState(state: PackState, message?: string): void {
    this.#state = state;
    for (const s of ['working', 'ready', 'failed'] as const) this.#host.classList.toggle(`is-${s}`, s === state);
    this.#host.setAttribute('aria-disabled', String(state !== 'ready'));
    this.#captionText =
      state === 'ready'
        ? { key: 'pack.hint' }
        : state === 'failed'
          ? { key: 'pack.failed', params: { message: message ?? '' } }
          : { key: 'pack.working' };
    this.#caption.textContent = t(this.#captionText.key, this.#captionText.params);
  }

  destroy(): void {
    this.#offLang();
    this.#host.remove();
  }
}

export class Pack implements PackView {
  /** 图案、遮罩都就位 */
  readonly ready: Promise<void>;

  readonly #host: HTMLElement;
  readonly #chrome: PackChrome;
  readonly #card: HoloCard;
  #foil: FoilType = DEFAULT_PACK_FOIL;
  #onOpen: ((method: OpenMethod) => void) | null = null;
  /** 开包动画播放中时是「直接跳到揭晓」，没在播时是 null */
  #skip: (() => void) | null = null;
  #destroyed = false;

  constructor(host: HTMLElement, onDismiss: () => void) {
    this.#host = host;
    this.#chrome = new PackChrome(host, onDismiss);
    const cardHost = document.createElement('div');
    cardHost.className = 'pack__card hc-pack';
    host.prepend(cardHost);

    this.#card = new HoloCard(cardHost, { amplitude: 0 });
    this.ready = packLayerSet(this.#foil).then((set) => {
      // 图案还没画完卡包就被拆了（做失败马上点了关掉）
      if (this.#destroyed) return;
      this.#card.setLayerSet(set);
      return this.#card.ready;
    });

    this.#bindGestures();
  }

  setState(state: PackState, message?: string): void {
    this.#chrome.setState(state, message);
  }

  setFoil(foil: FoilType): void {
    this.#foil = foil;
    void this.ready.then(() => {
      for (const index of [0, 1]) this.#card.setLayerFoil(index, { type: foil, intensity: 1 });
    });
  }

  /** 平面版开包时卡不从袋子里出来，用不着这张卡 */
  setCard(): void {}

  onOpen(handler: (method: OpenMethod) => void): void {
    this.#onOpen = handler;
  }

  /**
   * 撕开在封条飞走一半时 resolve，炸开在光最亮的时候。
   * 剩下的（封条飞远、光散掉）接着播，和卡带那边的淡出叠在一起。
   * 平面版没有「卡从袋口出来」，总是带回 null；「减少动态效果」下立刻 resolve
   */
  playOpen(method: OpenMethod): Promise<Handoff | null> {
    if (reducedMotion()) return Promise.resolve(null);
    const animations = method === 'swipe' ? this.#flyStrip() : [...this.#shake(), this.#burst()];
    const revealAt = method === 'swipe' ? 200 : 615;
    return new Promise((resolve) => {
      const done = (): void => {
        window.clearTimeout(timer);
        this.#skip = null;
        resolve(null);
        // 平面版没有「空袋子掉出画面」，剩下的袋身跟着卡转圈淡掉
        this.#host.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 360, easing: 'ease-out', fill: 'forwards' });
      };
      const timer = window.setTimeout(done, revealAt);
      this.#skip = () => {
        for (const a of animations) a.finish();
        done();
      };
    });
  }

  /** 从 DOM 上拿掉，释放渲染器的资源 */
  destroy(): void {
    this.#destroyed = true;
    this.#card.destroy();
    this.#chrome.destroy();
  }

  // ---------- 手势 ----------

  #strip(): HTMLElement | null {
    return this.#host.querySelectorAll<HTMLElement>('.hc__plane')[1] ?? null;
  }

  #bindGestures(): void {
    const host = this.#host;
    let start: { x: number; y: number; id: number; tearing: boolean; width: number } | null = null;
    let progress = 0;
    let side = 1;

    const tearTo = (p: number): void => {
      progress = p;
      const strip = this.#strip();
      if (!strip) return;
      // 从划进来的那一侧掀起，另一端当轴
      strip.style.transformOrigin = `${side > 0 ? 100 : 0}% ${(TEAR_Y / 1000) * 100}%`;
      strip.style.rotate = `${-side * p * 22}deg`;
      strip.style.translate = `0 ${-p * 12}px`;
    };

    host.addEventListener(
      'pointerdown',
      (event) => {
        // 播开包动画时点一下：直接跳到揭晓
        if (this.#skip) {
          this.#skip();
          return;
        }
        const box = host.querySelector('.hc')?.getBoundingClientRect();
        if (!box) return;
        const tearing = this.#chrome.state === 'ready' && event.clientY - box.top < box.height * TEAR_ZONE;
        start = { x: event.clientX, y: event.clientY, id: event.pointerId, tearing, width: box.width };
        if (tearing) {
          // 接管这根指针：之后的移动都发给卡包自己，渲染器收不到，撕的时候卡包不跟着转
          host.setPointerCapture(event.pointerId);
          this.#card.setPose(null);
        }
      },
      true,
    );

    host.addEventListener('pointermove', (event) => {
      if (!start?.tearing || event.pointerId !== start.id) return;
      const dx = event.clientX - start.x;
      if (Math.abs(dx) < TAP_SLOP) return;
      side = dx > 0 ? 1 : -1;
      tearTo(Math.min(1, Math.abs(dx) / start.width));
    });

    const release = (event: PointerEvent): void => {
      if (!start || event.pointerId !== start.id) return;
      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      const wasTearing = start.tearing;
      start = null;
      if (moved < TAP_SLOP) {
        if (wasTearing) tearTo(0);
        this.#request('tap');
        return;
      }
      if (!wasTearing) return;
      if (progress >= TEAR_DONE && this.#chrome.state === 'ready') {
        this.#request('swipe');
        return;
      }
      // 没划够：封条弹回去
      const strip = this.#strip();
      strip
        ?.animate([{ rotate: strip.style.rotate, translate: strip.style.translate }, { rotate: '0deg', translate: '0 0' }], {
          duration: reducedMotion() ? 0 : 180,
          easing: 'ease-out',
        })
        .finished.then(() => tearTo(0))
        .catch(() => undefined);
    };
    host.addEventListener('pointerup', release);
    host.addEventListener('pointercancel', (event) => {
      if (start?.tearing) tearTo(0);
      if (start && event.pointerId === start.id) start = null;
    });

    host.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.#request('key');
    });
  }

  #request(method: OpenMethod): void {
    if (this.#chrome.state !== 'ready') {
      // 还没做好：轻轻晃一下，让人知道点到了
      if (this.#chrome.state === 'working' && !reducedMotion()) {
        this.#host.querySelector('.hc')?.animate(
          [{ translate: '0 0' }, { translate: '0 -6px' }, { translate: '0 0' }],
          { duration: 260, easing: 'ease-out' },
        );
      }
      return;
    }
    this.#onOpen?.(method);
  }

  // ---------- 开包动画 ----------

  /** 撕开：封条顺着撕的方向飞走 */
  #flyStrip(): Animation[] {
    const strip = this.#strip();
    if (!strip) return [];
    const side = strip.style.transformOrigin.startsWith('100%') ? 1 : -1;
    return [
      strip.animate(
        [
          { rotate: strip.style.rotate || '0deg', translate: strip.style.translate || '0 0', opacity: 1 },
          { rotate: `${-side * 70}deg`, translate: `${-side * 40}% -160%`, opacity: 0 },
        ],
        { duration: 340, easing: 'cubic-bezier(.4,0,.9,.6)', fill: 'forwards' },
      ),
    ];
  }

  /** 点开：卡包抖三下 */
  #shake(): Animation[] {
    const card = this.#host.querySelector<HTMLElement>('.hc');
    if (!card) return [];
    return [
      card.animate(
        [
          { translate: '0 0', rotate: '0deg' },
          { translate: '-7px 0', rotate: '-2deg' },
          { translate: '7px 0', rotate: '2deg' },
          { translate: '-6px 0', rotate: '-1.5deg' },
          { translate: '6px 0', rotate: '1.5deg' },
          { translate: '-3px 0', rotate: '-0.5deg' },
          { translate: '0 0', rotate: '0deg' },
        ],
        { duration: 380, easing: 'ease-in-out' },
      ),
    ];
  }

  /** 点开：一团和箔面同色的光从卡包中间炸开 */
  #burst(): Animation {
    this.#chrome.flash.style.background = FLASH[this.#foil];
    return this.#chrome.flash.animate(
      [
        { opacity: 0, scale: '0.2' },
        { opacity: 0, scale: '0.2', offset: 0.45 },
        { opacity: 1, scale: '1.1', offset: 0.75 },
        { opacity: 0, scale: '1.8' },
      ],
      { duration: 820, easing: 'ease-out' },
    );
  }
}
