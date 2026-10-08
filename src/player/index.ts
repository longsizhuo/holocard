/**
 * <holo-card>：把一组 .layers 文件（manifest.json + 各层图片）放进别人的网页里，和 HoloCard 站上看到的一样会动。
 *
 *   <script type="module" src="https://cdn.jsdelivr.net/npm/@holocard/player"></script>
 *   <holo-card src="https://example.com/cards/abc"></holo-card>
 *
 * src 指向 .layers 目录（里面有 manifest.json），直接写到 manifest.json 也认。
 * 作者在 HoloCard 上调好的箔面、炫光、视差都存在 manifest 里，这里照着来。
 *
 * 样式装在 Shadow DOM 里：箔面的 CSS 不会漏到宿主页面，宿主页面的 CSS 也改不坏卡片。
 * 大小由宿主控制：给 holo-card 设宽度，高度按卡片比例自动算。
 *
 * 属性：
 *   src    .layers 目录或 manifest.json 的地址（跨域时对方服务器要允许 CORS）
 *   gyro   默认跟着手机倾斜；写 gyro="off" 关掉。iOS 要用户点一下卡片才会弹授权
 * 事件：
 *   load   层都加载好、卡片挂上了
 *   error  加载失败，detail.error 是错误
 *
 * 包的入口，构建见 vite.player.config.ts；发布见 packages/player/README.md。
 */

import { HoloCard } from '../renderer/card';
import { loadLayerSet } from '../format/io';
import cardCss from '../renderer/card.css?inline';
import foilsCss from '../renderer/foils.css?inline';

const HOST_CSS = `
  :host { display: inline-block; width: 320px; max-width: 100%; vertical-align: middle; }
  :host([hidden]) { display: none; }
  .hc { max-width: none; }
`;

export class HoloCardElement extends HTMLElement {
  static observedAttributes = ['src', 'gyro'];

  readonly #mount: HTMLDivElement;
  #card: HoloCard | null = null;
  #loading: AbortController | null = null;
  #gyroAsked = false;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${cardCss}\n${foilsCss}\n${HOST_CSS}`;
    this.#mount = document.createElement('div');
    shadow.append(style, this.#mount);
  }

  connectedCallback(): void {
    if (!this.#card && this.getAttribute('src')) void this.#load();
  }

  disconnectedCallback(): void {
    this.#loading?.abort();
    this.#card?.destroy();
    this.#card = null;
  }

  attributeChangedCallback(name: string, before: string | null, after: string | null): void {
    if (!this.isConnected || before === after) return;
    if (name === 'src') void this.#load();
    if (name === 'gyro' && after !== 'off') this.#armGyro();
  }

  async #load(): Promise<void> {
    const src = this.getAttribute('src');
    if (!src) return;
    this.#loading?.abort();
    const loading = new AbortController();
    this.#loading = loading;
    try {
      // 两种写法都认：目录，或者直接写到 manifest.json
      const set = await loadLayerSet(new URL(src, document.baseURI).href.replace(/\/manifest\.json$/, ''), loading.signal);
      if (loading.signal.aborted) return;
      this.#card?.destroy();
      const parallax = set.manifest.effects.parallax;
      const card = new HoloCard(this.#mount, parallax ? { amplitude: parallax.enabled ? parallax.amplitude : 0 } : {});
      card.setLayerSet(set);
      this.#card = card;
      this.#armGyro();
      this.dispatchEvent(new CustomEvent('load'));
    } catch (error) {
      if (loading.signal.aborted) return;
      this.dispatchEvent(new CustomEvent('error', { detail: { error } }));
    }
  }

  /** 安卓、桌面直接开；iOS 要在用户手势里申请权限，等第一次点卡片 */
  #armGyro(): void {
    const card = this.#card;
    if (!card || this.getAttribute('gyro') === 'off' || !('DeviceOrientationEvent' in window)) return;
    const request = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission;
    if (typeof request !== 'function') {
      card.enableGyro();
      return;
    }
    if (this.#gyroAsked) return;
    this.#gyroAsked = true;
    this.addEventListener(
      'click',
      () => {
        void request()
          .then((state) => {
            if (state === 'granted') this.#card?.enableGyro();
          })
          .catch(() => undefined);
      },
      { once: true },
    );
  }
}

if (!customElements.get('holo-card')) customElements.define('holo-card', HoloCardElement);

declare global {
  interface HTMLElementTagNameMap {
    'holo-card': HoloCardElement;
  }
}
