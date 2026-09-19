/**
 * HoloCard 渲染器
 *
 * 吃一个 LayerSet，产出一张会跟着指针倾斜 + 分层视差 + 闪光的卡片。
 * 不依赖任何框架，也不依赖分层算法——手工切的图一样能渲染。
 */

import './card.css';
import type { LayerSet } from '../format/types';

export interface HoloCardOptions {
  /** 最大倾斜角，单位度 */
  tilt: number;
  /**
   * 视差振幅：最外层相对卡片宽度的最大位移比例。
   * 0.06 表示视差系数为 1 的层最多平移 6% 卡宽。
   * 调大很爽但也更容易暴露补洞质量问题。
   */
  amplitude: number;
}

const DEFAULT_OPTIONS: HoloCardOptions = {
  tilt: 14,
  amplitude: 0.06,
};

/** 把值限制在 [min, max] */
function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export class HoloCard {
  readonly #host: HTMLElement;
  #options: HoloCardOptions;

  #root: HTMLDivElement | null = null;
  /** 当前持有的 object URL，切换卡片和销毁时必须全部 revoke，否则内存泄漏 */
  #objectUrls: string[] = [];

  /** 待写入的指针状态，由 rAF 统一 flush，避免 pointermove 里频繁改样式 */
  #pendingNx = 0;
  #pendingNy = 0;
  #pendingMx = 50;
  #pendingMy = 50;
  #rafId = 0;

  /** 指针监听的生命周期跟随当前这组层，换卡时整体解绑 */
  #pointerAbort: AbortController | null = null;

  constructor(host: HTMLElement, options: Partial<HoloCardOptions> = {}) {
    this.#host = host;
    this.#options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 挂载（或替换）一组层。重复调用会先清掉上一组的资源 */
  setLayerSet(set: LayerSet): void {
    this.#teardownDom();

    const { manifest, images } = set;
    if (images.length !== manifest.layers.length) {
      throw new Error(
        `层数对不上：manifest 声明 ${manifest.layers.length} 层，实际给了 ${images.length} 张图`,
      );
    }

    const root = document.createElement('div');
    root.className = 'hc';
    root.style.setProperty('--hc-aspect', `${manifest.source.width} / ${manifest.source.height}`);
    root.style.setProperty('--hc-tilt', `${this.#options.tilt}deg`);
    root.style.setProperty('--hc-amp', `${this.#options.amplitude * 100}%`);

    const inner = document.createElement('div');
    inner.className = 'hc__inner';

    const stack = document.createElement('div');
    stack.className = 'hc__stack';

    const foilTargets = new Set(manifest.effects.foil.layers);
    const foilType = manifest.effects.foil.type;
    const wholeCardFoil = foilTargets.size === 0 && foilType !== 'none';

    manifest.layers.forEach((layer, index) => {
      const blob = images[index];
      if (!blob) return; // 上面已校验过长度，这里只为满足类型收窄

      const url = URL.createObjectURL(blob);
      this.#objectUrls.push(url);

      const img = document.createElement('img');
      img.className = 'hc__layer';
      img.src = url;
      img.alt = '';
      img.decoding = 'async';
      img.style.setProperty('--hc-parallax', String(layer.parallax));
      // 位移会让层的边缘露白，按最大位移量反推需要放大多少
      img.style.setProperty(
        '--hc-scale',
        String(1 + 2 * Math.abs(layer.parallax) * this.#options.amplitude),
      );
      stack.append(img);

      // 该层需要独立光泽时，紧跟在这一层后面插一个被它形状裁剪的光泽层
      if (foilTargets.has(index)) {
        stack.append(this.#createFoil(foilType, layer.parallax, manifest.effects.foil.intensity, url));
      }
    });

    // 没有指定作用层时退化成整卡一层光泽（也就是 pokemon-cards-css 的做法）
    if (wholeCardFoil) {
      stack.append(this.#createFoil(foilType, 0, manifest.effects.foil.intensity, null));
    }

    if (manifest.effects.glare) {
      const glare = document.createElement('div');
      glare.className = 'hc__glare';
      stack.append(glare);
    }

    inner.append(stack);
    root.append(inner);
    this.#host.append(root);
    this.#root = root;

    this.#bindPointer(root);
  }

  /** 运行时改参数，用于演示页的调参面板 */
  setOptions(patch: Partial<HoloCardOptions>): void {
    this.#options = { ...this.#options, ...patch };
    const root = this.#root;
    if (!root) return;

    root.style.setProperty('--hc-tilt', `${this.#options.tilt}deg`);
    root.style.setProperty('--hc-amp', `${this.#options.amplitude * 100}%`);

    // 振幅变了，每层的缩放补偿要跟着重算
    for (const el of root.querySelectorAll<HTMLElement>('.hc__layer')) {
      const parallax = Number(el.style.getPropertyValue('--hc-parallax')) || 0;
      el.style.setProperty(
        '--hc-scale',
        String(1 + 2 * Math.abs(parallax) * this.#options.amplitude),
      );
    }
  }

  destroy(): void {
    this.#teardownDom();
  }

  #createFoil(
    type: string,
    parallax: number,
    intensity: number,
    maskUrl: string | null,
  ): HTMLDivElement {
    const foil = document.createElement('div');
    foil.className = 'hc__foil';
    foil.dataset['type'] = type;
    foil.style.setProperty('--hc-parallax', String(parallax));
    foil.style.setProperty('--hc-foil-intensity', String(intensity));

    if (maskUrl !== null) {
      // 用这一层自己的图做遮罩，光泽就被关在它的 alpha 形状里
      foil.dataset['masked'] = 'true';
      foil.style.setProperty('--hc-foil-mask', `url("${maskUrl}")`);
    }
    return foil;
  }

  #bindPointer(root: HTMLDivElement): void {
    const controller = new AbortController();
    this.#pointerAbort = controller;
    const { signal } = controller;

    root.addEventListener(
      'pointermove',
      (event) => {
        const rect = root.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const px = (event.clientX - rect.left) / rect.width;
        const py = (event.clientY - rect.top) / rect.height;

        this.#pendingMx = clamp(px * 100, 0, 100);
        this.#pendingMy = clamp(py * 100, 0, 100);
        // 归一化到 -1..1，中心为 0
        this.#pendingNx = clamp(px * 2 - 1, -1, 1);
        this.#pendingNy = clamp(py * 2 - 1, -1, 1);

        this.#scheduleFlush();
      },
      { signal, passive: true },
    );

    root.addEventListener(
      'pointerenter',
      () => {
        root.classList.add('is-interacting');
        root.style.setProperty('--hc-active', '1');
      },
      { signal, passive: true },
    );

    root.addEventListener(
      'pointerleave',
      () => {
        // 先摘掉 is-interacting 恢复过渡，再把各变量归零，卡片才会平滑回正
        root.classList.remove('is-interacting');
        root.style.setProperty('--hc-active', '0');
        this.#pendingNx = 0;
        this.#pendingNy = 0;
        this.#pendingMx = 50;
        this.#pendingMy = 50;
        this.#scheduleFlush();
      },
      { signal, passive: true },
    );
  }

  /**
   * 把指针状态合并到下一帧统一写入，pointermove 高频触发时只写一次。
   *
   * 这里刻意「取消后重排」而不是「已排队就跳过」：
   * 页面隐藏时 rAF 不会执行，跳过式写法会让标志位永久卡住，
   * 用户切走标签页再回来卡片就彻底不动了。
   */
  #scheduleFlush(): void {
    if (this.#rafId !== 0) {
      cancelAnimationFrame(this.#rafId);
    }
    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = 0;
      const root = this.#root;
      if (!root) return;
      root.style.setProperty('--hc-nx', this.#pendingNx.toFixed(4));
      root.style.setProperty('--hc-ny', this.#pendingNy.toFixed(4));
      root.style.setProperty('--hc-mx', this.#pendingMx.toFixed(2));
      root.style.setProperty('--hc-my', this.#pendingMy.toFixed(2));
    });
  }

  #teardownDom(): void {
    if (this.#rafId !== 0) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = 0;
    }
    this.#pointerAbort?.abort();
    this.#pointerAbort = null;

    for (const url of this.#objectUrls) {
      URL.revokeObjectURL(url);
    }
    this.#objectUrls = [];

    this.#root?.remove();
    this.#root = null;
  }
}
