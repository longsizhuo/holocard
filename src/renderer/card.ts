/**
 * HoloCard 渲染器
 *
 * 吃一个 LayerSet，产出一张会跟着指针倾斜 + 分层视差 + 卡面炫光的卡片。
 * 不依赖任何框架，也不依赖分层算法——手工切的图一样能渲染。
 *
 * 结构上严格区分两类东西：
 *   景深层（画面内容）参与视差；
 *   卡面层（炫光、高光）是卡面本身的物理属性，压在所有景深层之上，不参与视差。
 */

import './card.css';
import type { HaloEffect, HaloLight, LayerSet } from '../format/types';

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

/**
 * 由归一化指针位置算出卡面法线。
 *
 * 必须和 CSS 里的 `rotateX(ny * tilt) rotateY(nx * tilt)` 严格对应，
 * 否则算出来的炫光角度和肉眼看到的卡片姿态对不上。
 *
 * 推导：法线初始为 (0,0,1)，先绕 Y 转 ay 再绕 X 转 ax，
 *   Ry·(0,0,1) = (sin ay, 0, cos ay)
 *   Rx·(sin ay, 0, cos ay) = (sin ay, -sin ax · cos ay, cos ax · cos ay)
 */
export function surfaceNormal(
  nx: number,
  ny: number,
  tiltDeg: number,
): readonly [number, number, number] {
  const toRad = Math.PI / 180;
  const ax = ny * tiltDeg * toRad;
  const ay = nx * tiltDeg * toRad;
  const cosAy = Math.cos(ay);
  return [Math.sin(ay), -Math.sin(ax) * cosAy, Math.cos(ax) * cosAy];
}

/**
 * 算某个卡片姿态下的卡面炫光强度，返回 0..1。
 *
 * 模型很简单：卡面法线越接近「能把光源反射进眼睛」的那个朝向，虹彩越强。
 * 用两瓣叠加——一瓣宽而弱当底光，一瓣窄而亮当主峰，
 * 这样既不会全程死黑，又能保留「转到某个角度突然爆开」的观感。
 *
 * 抽成纯函数是为了能单独验证，也方便将来用陀螺仪之类的其他输入驱动。
 */
export function computeHalo(
  nx: number,
  ny: number,
  tiltDeg: number,
  light: HaloLight,
): number {
  const current = surfaceNormal(nx, ny, tiltDeg);
  const peak = surfaceNormal(light.peakAt[0], light.peakAt[1], tiltDeg);

  const dot = Math.max(
    0,
    current[0] * peak[0] + current[1] * peak[1] + current[2] * peak[2],
  );

  const sharpness = Math.max(1, light.sharpness);
  const wide = Math.pow(dot, Math.max(1, sharpness / 5));
  const tight = Math.pow(dot, sharpness);
  return 0.2 * wide + 0.8 * tight;
}

export class HoloCard {
  readonly #host: HTMLElement;
  #options: HoloCardOptions;

  #root: HTMLDivElement | null = null;
  /** 当前持有的 object URL，切换卡片和销毁时必须全部 revoke，否则内存泄漏 */
  #objectUrls: string[] = [];
  /** 当前卡面炫光配置，每帧算强度时要用 */
  #halo: HaloEffect | null = null;

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

  /** 当前卡片的根节点，供演示页读调试数值。未挂载时为 null */
  get element(): HTMLDivElement | null {
    return this.#root;
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

    const halo = manifest.effects.halo;
    this.#halo = halo;

    const root = document.createElement('div');
    root.className = 'hc';
    root.style.setProperty('--hc-aspect', `${manifest.source.width} / ${manifest.source.height}`);
    root.style.setProperty('--hc-tilt', `${this.#options.tilt}deg`);
    root.style.setProperty('--hc-amp', `${this.#options.amplitude * 100}%`);

    const inner = document.createElement('div');
    inner.className = 'hc__inner';

    const stack = document.createElement('div');
    stack.className = 'hc__stack';

    // 景深层：按由远及近的顺序铺，各自带视差系数
    const layerUrls: string[] = [];
    manifest.layers.forEach((layer, index) => {
      const blob = images[index];
      if (!blob) return; // 上面已校验过长度，这里只为满足类型收窄

      const url = URL.createObjectURL(blob);
      this.#objectUrls.push(url);
      layerUrls.push(url);

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
    });

    // 卡面层：压在所有景深层之上，不带任何 translate
    if (halo.type !== 'none') {
      const el = document.createElement('div');
      el.className = 'hc__halo';
      el.dataset['type'] = halo.type;
      el.style.setProperty('--hc-halo-intensity', String(halo.intensity));

      // 局部压印：借用某一景深层的形状，但压印本身留在卡面上
      const maskUrl = halo.maskLayer === null ? null : layerUrls[halo.maskLayer];
      if (maskUrl) {
        el.dataset['masked'] = 'true';
        el.style.setProperty('--hc-halo-mask', `url("${maskUrl}")`);
      }
      stack.append(el);
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

    // 静止姿态下的炫光也要算出来，否则首帧是全黑的
    root.style.setProperty('--hc-halo', this.#computeHalo(0, 0).toFixed(4));

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

    // 倾斜角变了，同一个指针位置对应的法线也变了，炫光要重算
    this.#scheduleFlush();
  }

  destroy(): void {
    this.#teardownDom();
  }

  #computeHalo(nx: number, ny: number): number {
    const halo = this.#halo;
    if (!halo || halo.type === 'none') return 0;
    return computeHalo(nx, ny, this.#options.tilt, halo.light);
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
      root.style.setProperty(
        '--hc-halo',
        this.#computeHalo(this.#pendingNx, this.#pendingNy).toFixed(4),
      );
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
    this.#halo = null;

    this.#root?.remove();
    this.#root = null;
  }
}
