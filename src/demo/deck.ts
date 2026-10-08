/**
 * 卡带：首页主舞台上这次访问做的卡，左右切换，最新的在右边。
 *
 * 一格是一张卡，或者一个卡包（正在做 / 做好了还没开）。同一时间只显示当前这一格：
 * 卡片格共用页面上那个 HoloCard（渲染器很重，不给每格都建一个），卡包格各有各的卡包（WebGL 版或平面版，见 pack.ts）。
 * 上传时最右边加一个卡包格并滑过去；等的时候可以按「<」回去玩之前的卡，
 * 做好了卡包亮起来，停在别的格上时「>」按钮上亮一个小点。开包后这一格变成卡片格。
 *
 * 做好的卡记在 sessionStorage：做完卡地址栏就换成了卡片链接，刷新后按它把卡带排回来。
 * 关掉标签页就没了——所有做过的卡在卡册里都有（个人中心 →「打开卡册」）。
 *
 * 开包后新卡绕竖轴转一圈亮相，带一点厚度、转过去能看到卡背（#spinIn）。
 * 卡包是 WebGL 的就从袋口接着转：卡包交出它那张卡在屏幕上的位置，真正的闪卡从那里接手。
 */

import type { LayerSet } from '../format/types';
import { onLangChange, t } from '../i18n';
import { reducedMotion, type Handoff, type OpenMethod, type PackView } from './pack';
import { createPack, packFoil } from './pack-gl';
import { setSfxOn, sfx, sfxOn } from './sfx';
import logoUrl from './ih-logo.svg';

interface CardSlot {
  kind: 'card';
  id: string | null;
  /** 刷新后恢复出来的格子，点到时才加载 */
  set: LayerSet | null;
}
interface PackSlot {
  kind: 'pack';
  pack: PackView;
  host: HTMLElement;
  /** 做好了才有 */
  result: { set: LayerSet; id: string | null } | null;
}
type Slot = CardSlot | PackSlot;

export interface DeckHooks {
  /** 显示一张卡：渲染 + 面板绑定到这张卡（main.ts 的 show） */
  showCard(set: LayerSet, id: string | null): void;
  /** 切到卡包格：面板上跟卡相关的东西先收起来 */
  showPack(): void;
  /** 开完包：卡已经摆上来了，改地址栏、埋点这类事交给页面 */
  revealed(set: LayerSet, id: string | null, method: OpenMethod): void;
  load(id: string): Promise<LayerSet>;
  loadFailed(error: unknown): void;
}

export interface PackHandle {
  done(set: LayerSet, id: string | null): void;
  fail(message: string): void;
}

const SESSION_KEY = 'holocard:session';

/** 这个标签页里做好的卡，按先后排 */
export function sessionCards(): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // 隐私模式下可能直接抛
    return [];
  }
}

/** 卡删掉了：刷新时别再把它排回卡带 */
export function forgetSession(id: string): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionCards().filter((other) => other !== id)));
  } catch {
    // 同上
  }
}

function remember(id: string): void {
  try {
    const ids = sessionCards();
    if (!ids.includes(id)) sessionStorage.setItem(SESSION_KEY, JSON.stringify([...ids, id]));
  } catch {
    // 存不下只是刷新后卡带里少这一张，卡册里还有
  }
}

/** 新卡亮相转一圈多久 */
const SPIN_MS = 1100;
/** 卡的厚度占卡宽的比例（真卡约 0.5%，放大一点才看得出来） */
const THICKNESS = 0.014;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t: number): number => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

export class Deck {
  readonly #hooks: DeckHooks;
  readonly #view: HTMLElement;
  readonly #cardHost: HTMLElement;
  readonly #prev: HTMLButtonElement;
  readonly #next: HTMLButtonElement;
  readonly #sfxToggle: HTMLButtonElement;
  /** 转圈时的厚度和卡背，平时藏着 */
  readonly #thick: HTMLElement;
  #slots: Slot[] = [];
  #index = 0;
  /** 正在开包：动画播完之前不让左右切 */
  #revealing = false;

  constructor(root: HTMLElement, hooks: DeckHooks) {
    this.#hooks = hooks;
    const need = <T extends Element>(selector: string): T => {
      const el = root.querySelector<T>(selector);
      if (!el) throw new Error(`卡带里找不到 ${selector}`);
      return el;
    };
    this.#view = need('.deck__view');
    this.#cardHost = need('.deck__card');
    this.#prev = need('.deck__nav--prev');
    this.#next = need('.deck__nav--next');
    this.#prev.addEventListener('click', () => this.#go(this.#index - 1));
    this.#next.addEventListener('click', () => this.#go(this.#index + 1));

    // 音效开关：卡带里有卡包时才出现（声音都是开包时的）
    this.#sfxToggle = need('.deck__sfx');
    this.#sfxToggle.addEventListener('click', () => {
      setSfxOn(!sfxOn());
      this.#updateSfx();
    });

    // 卡的厚度：几层同色的片叠在正反两面之间，斜着看时连成一条边；正好侧对时靠左右两条竖边
    this.#thick = document.createElement('div');
    this.#thick.className = 'deck__thick';
    this.#thick.hidden = true;
    for (const z of [-0.25, 0, 0.25]) {
      const slice = document.createElement('i');
      slice.className = 'deck__slice';
      slice.style.setProperty('--z', String(z));
      this.#thick.append(slice);
    }
    for (const side of ['l', 'r']) {
      const edge = document.createElement('i');
      edge.className = `deck__edge deck__edge--${side}`;
      this.#thick.append(edge);
    }
    const back = document.createElement('div');
    back.className = 'deck__back';
    const logo = document.createElement('img');
    logo.src = logoUrl;
    logo.alt = '';
    back.append(logo);
    this.#thick.append(back);
    this.#cardHost.append(this.#thick);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // 在滑块、输入框、下拉框里按方向键是在调它们；卡册窗口开着时也不动卡带
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, select, textarea, [contenteditable="true"]')) return;
      if (document.querySelector('dialog[open]')) return;
      this.#go(this.#index + (event.key === 'ArrowLeft' ? -1 : 1));
    });
    onLangChange(() => {
      this.#updateNav();
      this.#updateSfx();
    });
    this.#updateSfx();
  }

  /** 这台设备的卡片宿主，页面的 HoloCard 挂在这里 */
  get cardHost(): HTMLElement {
    return this.#cardHost;
  }

  /** 首屏那张卡（示例卡，或者链接里的卡） */
  addCard(set: LayerSet, id: string | null): void {
    this.#slots.push({ kind: 'card', id, set });
    this.#index = this.#slots.length - 1;
    this.#render(0);
  }

  /**
   * 刷新后把这个标签页里做过的卡排回来。首屏那张如果就是其中之一，按做的先后放回原位；
   * 不是（示例卡、别人分享的卡）就排在最左边
   */
  restore(): void {
    const ids = sessionCards();
    const first = this.#slots[0];
    if (!ids.length || !first || first.kind !== 'card') return;
    const later = (id: string): CardSlot => ({ kind: 'card', id, set: null });
    if (first.id && ids.includes(first.id)) {
      this.#slots = ids.map((id) => (id === first.id ? first : later(id)));
      this.#index = ids.indexOf(first.id);
    } else {
      this.#slots.push(...ids.filter((id) => id !== first.id).map(later));
    }
    this.#updateNav();
  }

  /** 开一个卡包格（正在做），滑到它上面 */
  startPack(): PackHandle {
    const slot = this.#packSlot();
    this.#go(this.#slots.length - 1);

    return {
      done: (set, id) => {
        this.#fill(slot, set, id);
        // 可能正在玩别的卡：叮一声告诉人做好了
        sfx.ready();
        if (id) remember(id);
        this.#updateNav();
      },
      fail: (message) => {
        slot.pack.setState('failed', message);
        this.#updateNav();
      },
    };
  }

  /** 别人分享的卡在这台设备上第一次打开：首屏先放一个做好了的卡包，开了才是卡 */
  addPack(set: LayerSet, id: string): void {
    const slot = this.#packSlot();
    this.#fill(slot, set, id);
    this.#index = this.#slots.length - 1;
    this.#render(0);
  }

  #packSlot(): PackSlot {
    const host = document.createElement('div');
    host.className = 'deck__pack';
    this.#view.append(host);
    const slot: PackSlot = {
      kind: 'pack',
      pack: createPack(host, () => this.#dismiss(slot)),
      host,
      result: null,
    };
    slot.pack.onOpen((method) => void this.#reveal(slot, method));
    this.#slots.push(slot);
    return slot;
  }

  /** 卡包里装好这张卡，亮起来等人开 */
  #fill(slot: PackSlot, set: LayerSet, id: string | null): void {
    slot.result = { set, id };
    slot.pack.setFoil(packFoil(set));
    slot.pack.setCard(set);
    slot.pack.setState('ready');
  }

  #go(index: number): void {
    if (this.#revealing) return;
    if (index < 0 || index >= this.#slots.length || index === this.#index) return;
    const direction = index > this.#index ? 1 : -1;
    this.#index = index;
    this.#render(direction);
  }

  #render(direction: number): void {
    const slot = this.#slots[this.#index];
    if (!slot) return;
    for (const other of this.#slots) {
      if (other.kind === 'pack') other.host.hidden = other !== slot;
    }
    this.#cardHost.hidden = slot.kind !== 'card';

    if (slot.kind === 'pack') {
      this.#hooks.showPack();
    } else if (slot.set) {
      this.#hooks.showCard(slot.set, slot.id);
    } else if (slot.id) {
      const id = slot.id;
      this.#hooks
        .load(id)
        .then((set) => {
          slot.set = set;
          if (this.#slots[this.#index] === slot) this.#hooks.showCard(set, id);
        })
        .catch((error: unknown) => this.#hooks.loadFailed(error));
    }

    if (direction && !reducedMotion()) {
      this.#view.animate(
        [
          { translate: `${direction * 28}px 0`, opacity: 0 },
          { translate: '0 0', opacity: 1 },
        ],
        { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    }
    this.#updateNav();
  }

  #updateNav(): void {
    this.#prev.hidden = this.#index <= 0;
    this.#next.hidden = this.#index >= this.#slots.length - 1;
    // 右边有做好了还没开的卡包：按钮上亮个小点
    const waiting = this.#slots.slice(this.#index + 1).some((slot) => slot.kind === 'pack' && slot.result);
    this.#next.classList.toggle('has-new', waiting);
    this.#prev.setAttribute('aria-label', t('deck.prev'));
    this.#next.setAttribute('aria-label', t(waiting ? 'deck.nextReady' : 'deck.next'));
    this.#updateSfx();
  }

  #updateSfx(): void {
    this.#sfxToggle.hidden = !this.#revealing && !this.#slots.some((slot) => slot.kind === 'pack');
    const on = sfxOn();
    this.#sfxToggle.setAttribute('aria-pressed', String(on));
    this.#sfxToggle.setAttribute('aria-label', t('deck.sfx'));
    this.#sfxToggle.title = t(on ? 'deck.sfxOn' : 'deck.sfxOff');
  }

  /** 失败的卡包格「关掉」：拿掉这一格，停在它左边那格 */
  #dismiss(slot: PackSlot): void {
    const index = this.#slots.indexOf(slot);
    if (index < 0) return;
    this.#slots.splice(index, 1);
    slot.pack.destroy();
    // 「关掉」只能点在当前显示的这一格上
    this.#index = Math.max(0, index - 1);
    this.#render(0);
  }

  /**
   * 开包。新卡一开始就挂到（藏着的）卡片宿主上：图片提前解码好，卡出袋口换手的那一下不会闪白；
   * 卡包动画播到该摆卡的那一刻，新卡接着转一圈亮相，转完拆掉卡包
   */
  async #reveal(slot: PackSlot, method: OpenMethod): Promise<void> {
    const result = slot.result;
    if (!result) return;
    slot.result = null;
    const index = this.#slots.indexOf(slot);
    if (index < 0) return;
    this.#revealing = true;
    this.#slots[index] = { kind: 'card', id: result.id, set: result.set };
    const host = this.#cardHost;
    host.style.visibility = 'hidden';
    host.hidden = false;
    this.#hooks.revealed(result.set, result.id, method);
    const hc = host.querySelector<HTMLElement>('.hc');
    for (const img of host.querySelectorAll('img')) void img.decode().catch(() => undefined);
    // 闪卡静止时画面放大的倍数：袋子里那张要画得一样大
    const zoom = Number.parseFloat(hc?.style.getPropertyValue('--hc-scale') ?? '') || 1;

    const handoff = await slot.pack.playOpen(method, zoom);
    // 卡包自己的尾巴（空袋子掉出画面、光散掉）和卡转圈叠在一起播，都比转圈短，转完再拆
    slot.host.style.pointerEvents = 'none';
    if (reducedMotion()) host.style.visibility = '';
    else await this.#spinIn(handoff);
    slot.pack.destroy();
    this.#revealing = false;
    this.#updateNav();
  }

  /**
   * 新卡亮相：绕竖轴转一圈，带一点厚度，转过去看得到卡背。
   * handoff：卡包里那张卡此刻在屏幕上的位置，卡从那里一边顺着手划的方向转、一边回到原位；
   * 没有（点开炸出、平面版卡包）就从中间弹出来。
   * 进来时卡片宿主是藏着的：先摆好第一帧的姿态再露出来，否则会有一帧原样大小的卡闪一下
   */
  async #spinIn(handoff: Handoff | null): Promise<void> {
    const from = handoff?.rect ?? null;
    const side = handoff?.side ?? 1;
    const host = this.#cardHost;
    const hc = host.querySelector<HTMLElement>('.hc');
    if (!hc) {
      host.style.visibility = '';
      return;
    }
    const w = hc.offsetWidth, h = hc.offsetHeight;
    const box = hc.getBoundingClientRect();
    const dx = from ? from.left + from.width / 2 - (box.left + box.width / 2) : 0;
    const dy = from ? from.top + from.height / 2 - (box.top + box.height / 2) : 0;
    const s0 = from ? from.width / box.width : 0;
    const thickness = Math.max(2, w * THICKNESS);

    Object.assign(this.#thick.style, { width: `${w}px`, height: `${h}px` });
    host.style.setProperty('--deck-t', `${thickness}px`);
    host.style.setProperty('--deck-w', `${w}px`);
    this.#thick.hidden = false;
    host.classList.add('is-spinning');
    // 透视和卡包那边的相机差不多：相机离卡约 2.4 个卡高
    this.#view.style.perspective = `${h * 2.4}px`;
    hc.style.transform = `translateZ(${thickness / 2}px)`;
    sfx.spin();

    /** 转圈进行到 p（0..1）时的姿态 */
    const pose = (p: number): void => {
      let x = 0, y = 0, scale: number, angle: number;
      if (from) {
        // 从袋口那个位置回到正中间放大，一边匀匀地转一圈
        const m = easeInOut(Math.min(1, p * 1.5));
        x = dx * (1 - m);
        y = dy * (1 - m);
        scale = lerp(s0, 1, m);
        angle = side * Math.PI * 2 * easeInOut(p);
      } else {
        // 从光里弹出来，刚出来转得最快，慢慢停下
        scale = Math.max(0.01, easeOutBack(Math.min(1, p / 0.45)));
        angle = side * Math.PI * 2 * easeOut(p);
      }
      host.style.transform = `translate(${x}px, ${y}px) scale(${scale}) rotateY(${angle}rad)`;
      // 转到背面时正面藏起来（闪卡里面自己也有 3D，不能指望 backface-visibility）；
      // 卡背朝光的时候亮、侧过去暗
      const facing = Math.cos(angle);
      hc.style.visibility = facing < 0 ? 'hidden' : '';
      this.#thick.style.setProperty('--deck-shade', (0.55 * (1 - Math.min(1, Math.max(0, -facing)))).toFixed(3));
    };
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const frame = (): void => {
        const p = clamp01((performance.now() - start) / SPIN_MS);
        pose(p);
        if (p < 1) requestAnimationFrame(frame);
        else resolve();
      };
      pose(0);
      host.style.visibility = '';
      requestAnimationFrame(frame);
    });

    host.style.transform = '';
    host.classList.remove('is-spinning');
    this.#view.style.perspective = '';
    hc.style.transform = '';
    hc.style.visibility = '';
    this.#thick.hidden = true;
  }
}
