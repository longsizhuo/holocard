/**
 * 卡带：首页主舞台上这次访问做的卡，左右切换，最新的在右边。
 *
 * 一格是一张卡，或者一个卡包（正在做 / 做好了还没开）。同一时间只显示当前这一格：
 * 卡片格共用页面上那个 HoloCard（渲染器很重，不给每格都建一个），卡包格各有各的 Pack。
 * 上传时最右边加一个卡包格并滑过去；等的时候可以按「<」回去玩之前的卡，
 * 做好了卡包亮起来，停在别的格上时「>」按钮上亮一个小点。开包后这一格变成卡片格。
 *
 * 做好的卡记在 sessionStorage：做完卡地址栏就换成了卡片链接，刷新后按它把卡带排回来。
 * 关掉标签页就没了——所有做过的卡在「我做过的」里一直都有。
 */

import type { FoilType, LayerSet } from '../format/types';
import { onLangChange, t } from '../i18n';
import { Pack, type OpenMethod } from './pack';

interface CardSlot {
  kind: 'card';
  id: string | null;
  /** 刷新后恢复出来的格子，点到时才加载 */
  set: LayerSet | null;
}
interface PackSlot {
  kind: 'pack';
  pack: Pack;
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
    // 存不下只是刷新后卡带里少这一张，「我做过的」里还有
  }
}

/** 卡包的颜色跟这张卡背景层的箔面走；背景是哑光的就用离得最远的那层有箔的 */
function backgroundFoil(set: LayerSet): FoilType {
  return set.manifest.layers.find((layer) => layer.foil.type !== 'none')?.foil.type ?? 'sunpillar';
}

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Deck {
  readonly #hooks: DeckHooks;
  readonly #view: HTMLElement;
  readonly #cardHost: HTMLElement;
  readonly #prev: HTMLButtonElement;
  readonly #next: HTMLButtonElement;
  #slots: Slot[] = [];
  #index = 0;

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

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // 在滑块、输入框、下拉框里按方向键是在调它们；卡册窗口开着时也不动卡带
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, select, textarea, [contenteditable="true"]')) return;
      if (document.querySelector('dialog[open]')) return;
      this.#go(this.#index + (event.key === 'ArrowLeft' ? -1 : 1));
    });
    onLangChange(() => this.#updateNav());
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
    const host = document.createElement('div');
    host.className = 'deck__pack';
    this.#view.append(host);
    const slot: PackSlot = {
      kind: 'pack',
      pack: new Pack(host, () => this.#dismiss(slot)),
      host,
      result: null,
    };
    slot.pack.onOpen((method) => void this.#reveal(slot, method));
    this.#slots.push(slot);
    this.#go(this.#slots.length - 1);

    return {
      done: (set, id) => {
        slot.result = { set, id };
        slot.pack.setFoil(backgroundFoil(set));
        slot.pack.setState('ready');
        if (id) remember(id);
        this.#updateNav();
      },
      fail: (message) => {
        slot.pack.setState('failed', message);
        this.#updateNav();
      },
    };
  }

  #go(index: number): void {
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

  /** 开包：卡包动画播到揭晓那一刻，新卡从卡包的位置放大滑出，卡包淡出后拆掉 */
  async #reveal(slot: PackSlot, method: OpenMethod): Promise<void> {
    const result = slot.result;
    if (!result) return;
    slot.result = null;
    await slot.pack.playOpen(method);

    const index = this.#slots.indexOf(slot);
    if (index < 0) return;
    const card: CardSlot = { kind: 'card', id: result.id, set: result.set };
    this.#slots[index] = card;
    this.#cardHost.hidden = false;
    this.#hooks.revealed(result.set, result.id, method);

    if (!reducedMotion()) {
      this.#cardHost.animate(
        [
          { opacity: 0, scale: '0.7', translate: '0 10%' },
          { opacity: 1, scale: '1', translate: '0 0' },
        ],
        { duration: 480, easing: 'cubic-bezier(.2,.9,.25,1)' },
      );
      await slot.host
        .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 360, easing: 'ease-out', fill: 'forwards' })
        .finished.catch(() => undefined);
    }
    slot.pack.destroy();
    this.#updateNav();
  }
}
