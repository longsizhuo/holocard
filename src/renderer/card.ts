/**
 * HoloCard 渲染器
 *
 * 吃一个 LayerSet，产出一张闪卡。一张卡由四样东西叠成：
 *   1. 景深层      画面内容，带视差
 *   2. 每层的箔面  各层各有各的箔，用该层自己的 alpha 做遮罩，随层一起移动
 *   3. 整卡炫光    铺满卡面的细微五彩，只在特定倾角浮出来
 *   4. 整卡高光    跟随指针的镜面反光
 *
 * 交互手感（指针 → 转角 / 高光 / 背景位移的映射、弹簧参数、松手回正的节奏）
 * 移植自 pokemon-cards-css 的 Card.svelte：
 *   作者 Simon Goellner (@simeydotme)，GPL-3.0
 *   https://github.com/simeydotme/pokemon-cards-css
 * 视差、逐层箔面遮罩、整卡炫光的角度模型是本项目自己的部分。
 *
 * 不依赖任何框架，也不依赖分层算法——手工切的图一样能渲染。
 */

import './card.css';
import './foils.css';
import type { HaloEffect, HaloLight, LayerFoil, LayerSet } from '../format/types';
import { DEADZONE_DEGREES, TiltTracker } from './gyro';
import { Relief, sampleDepth } from './relief';
import { groupMask, layerMask } from './highlight';
import { Spring } from './spring';
import { ensureTextures } from './textures';

export interface HoloCardOptions {
  /**
   * 视差振幅：最近层和最远层之间最大的相对位移，占卡片宽度的比例。
   * 0.1 表示卡片转到头时，主体和背景错开 10% 卡宽（各朝相反方向挪一半，见 setLayerSet）。
   * 0 即关闭视差，卡面完全平。
   */
  amplitude: number;
  /** 倾斜幅度倍率。1 与上游一致，最大转角约 14° */
  tiltScale: number;
  /**
   * 浮雕强度：层内按深度图逐像素视差（见 relief.ts）。1 表示深度差 1 的两个像素
   * 错开的距离和「视差差 1 的两层」一样；0 关掉。卡片没带深度图、浏览器没有 WebGL 时不起作用。
   * ponytail: 建卡时是 0 就不建画布，之后再调大不会生效，要用得重新 setLayerSet
   */
  relief: number;
}

const DEFAULT_OPTIONS: HoloCardOptions = {
  // 以前是 0.06、而且只有主体在动，用户反馈分层感太弱（issue #3 第 3 条）
  amplitude: 0.1,
  tiltScale: 1,
  relief: 1,
};

/** 跟手时的弹簧参数（上游 springInteractSettings） */
const INTERACT_SPRING = { stiffness: 0.066, damping: 0.25 };
/**
 * 陀螺仪驱动时的弹簧参数。传感器读数本来就平滑，再套跟手那根软弹簧会明显跟不上手（真机反馈「粘」），
 * 这里接近临界阻尼：几帧就到位、不晃
 */
const GYRO_SPRING = { stiffness: 0.25, damping: 0.85 };
/** 松手回正时的弹簧参数：很软，配合 soft 启动，卡片会迟疑一下再缓缓归位 */
const SNAP_SPRING = { stiffness: 0.01, damping: 0.06 };
/** 指针离开后多久才开始回正，毫秒 */
const SNAP_DELAY_MS = 500;
/** preview() 摆好姿态后停多久再回正。比松手回正久一些，给人看清调了什么 */
const PREVIEW_HOLD_MS = 1200;
/** 指针位置 → 转角的除数。50 / 3.5 ≈ 14.3°，即最大转角 */
const ROTATE_DIVISOR = 3.5;
/** 手指离开卡面后，陀螺仪等多久再接管，毫秒。比松手回正的延迟长，不和回正抢 */
const POINTER_PRIORITY_MS = 1000;

const round = (value: number, precision = 3): number => parseFloat(value.toFixed(precision));

const clamp = (value: number, min = 0, max = 100): number => Math.min(Math.max(value, min), max);

/**
 * 用户是否要求「减少动态效果」。
 *
 * card.css 里同名的媒体查询锁掉了 transform，但弹簧循环仍在跑——
 * 箔面会在松手后继续晃两下（欠阻尼过冲），那也是运动。
 * 这里让弹簧直接落位：指针停了就是停了。
 * 每次读实时值，用户在系统设置里改了偏好不用刷新页面。
 */
function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** 把 value 从 [fromMin, fromMax] 线性映射到 [toMin, toMax] */
const adjust = (
  value: number,
  fromMin: number,
  fromMax: number,
  toMin: number,
  toMax: number,
): number => round(toMin + ((toMax - toMin) * (value - fromMin)) / (fromMax - fromMin));

/**
 * 指针位置（百分比 0..100）→ 卡片转角（度）。
 * x 分量给 rotateY、y 分量给 rotateX，符号与上游一致：指针所在一侧朝观察者抬起。
 */
export function rotationFromPointer(
  percentX: number,
  percentY: number,
  tiltScale: number,
): { x: number; y: number } {
  return {
    x: round(-((percentX - 50) / ROTATE_DIVISOR)) * tiltScale,
    y: round((percentY - 50) / ROTATE_DIVISOR) * tiltScale,
  };
}

/**
 * 由转角算卡面法线。必须和 CSS 里的 `rotateY(rx) rotateX(ry)` 严格对应，
 * 否则算出来的炫光角度和肉眼看到的卡片姿态对不上。
 *
 * 推导（CSS 坐标系，y 轴向下）：法线初始为 (0,0,1)，
 *   Rx(ry)·(0,0,1)           = (0, -sin ry, cos ry)
 *   Ry(rx)·(0,-sin ry,cos ry) = (sin rx · cos ry, -sin ry, cos rx · cos ry)
 */
export function surfaceNormal(rxDeg: number, ryDeg: number): readonly [number, number, number] {
  const toRad = Math.PI / 180;
  const rx = rxDeg * toRad;
  const ry = ryDeg * toRad;
  const cosRy = Math.cos(ry);
  return [Math.sin(rx) * cosRy, -Math.sin(ry), Math.cos(rx) * cosRy];
}

/**
 * 算某个卡片姿态下的整卡炫光强度，返回 0..1。
 *
 * 卡面法线越接近「能把光源反射进眼睛」的那个朝向，五彩越明显。
 * 用两瓣叠加——一瓣宽而弱当底光，一瓣窄而亮当主峰，
 * 这样既不会全程死黑，又保留「转到某个角度才浮出来」的观感。
 */
export function computeHalo(
  rxDeg: number,
  ryDeg: number,
  light: HaloLight,
  tiltScale: number,
): number {
  const peakRotation = rotationFromPointer(
    50 + light.peakAt[0] * 50,
    50 + light.peakAt[1] * 50,
    tiltScale,
  );
  const current = surfaceNormal(rxDeg, ryDeg);
  const peak = surfaceNormal(peakRotation.x, peakRotation.y);

  const dot = Math.max(0, current[0] * peak[0] + current[1] * peak[1] + current[2] * peak[2]);

  const sharpness = Math.max(1, light.sharpness);
  const wide = Math.pow(dot, Math.max(1, sharpness / 5));
  const tight = Math.pow(dot, sharpness);
  return 0.2 * wide + 0.8 * tight;
}

export class HoloCard {
  readonly #host: HTMLElement;
  #options: HoloCardOptions;

  #root: HTMLDivElement | null = null;
  #shines: HTMLDivElement[] = [];
  /** 每个视差组各一份整卡炫光（见 setLayerSet） */
  #haloEls: HTMLDivElement[] = [];
  #halo: HaloEffect | null = null;

  /** 开了浮雕的层：画布 + 这一层的参考深度。没有深度图或者建不起来就是空的 */
  #reliefs: { relief: Relief; ref: number }[] = [];

  /** 当前持有的 object URL，切换卡片和销毁时必须全部 revoke，否则内存泄漏 */
  #objectUrls: string[] = [];
  /** 各层相对焦平面的最大视差偏移，放大补偿按它算（见 #scale） */
  #maxOffset = 0;
  /** 当前这组层的高光保护遮罩全部换上了（失败的保持原遮罩，也算完成） */
  #ready: Promise<void> = Promise.resolve();

  readonly #rotate = new Spring({ x: 0, y: 0 }, INTERACT_SPRING);
  readonly #glare = new Spring({ x: 50, y: 50, o: 0 }, INTERACT_SPRING);
  readonly #background = new Spring({ x: 50, y: 50 }, INTERACT_SPRING);

  #rafId = 0;
  #lastTime = 0;
  #snapTimer = 0;

  /** enableGyro() 调过了。跨换卡保留，每组层绑定时据此挂监听 */
  #gyro = false;
  readonly #tilt = new TiltTracker();
  #lastOrientTime = 0;
  /** 这个时刻之前陀螺仪不接管：手指在卡上、或者 preview() 正在展示 */
  #gyroYieldUntil = 0;
  /** 卡片现在是陀螺仪摆的姿态。回到死区时据此回正一次，不每帧都回 */
  #gyroAiming = false;

  /** 监听器的生命周期跟随当前这组层，换卡时整体解绑 */
  #listenerAbort: AbortController | null = null;

  constructor(host: HTMLElement, options: Partial<HoloCardOptions> = {}) {
    this.#host = host;
    this.#options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 高光保护遮罩都算好、换上了。截图（分享图、导出动图）前要等它，
   * 否则可能截到亮部还没收住的那一版
   */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /** 当前卡片的根节点，供演示页读调试数值。未挂载时为 null */
  get element(): HTMLDivElement | null {
    return this.#root;
  }

  /** 挂载（或替换）一组层。重复调用会先清掉上一组的资源 */
  setLayerSet(set: LayerSet): void {
    const { manifest, images } = set;
    // 校验要在拆掉旧卡之前做。反过来的话，一组坏数据会先把当前这张卡拆干净、
    // object URL 也 revoke 了，然后才抛错——用户看到的是一片空白且无法恢复。
    if (images.length !== manifest.layers.length) {
      throw new Error(
        `层数对不上：manifest 声明 ${manifest.layers.length} 层，实际给了 ${images.length} 张图`,
      );
    }

    this.#teardownDom();

    const root = document.createElement('div');
    root.className = 'hc';
    root.style.setProperty('--hc-aspect', `${manifest.source.width} / ${manifest.source.height}`);
    // 同一个比例再给一份纯数字。aspect-ratio 吃「宽 / 高」的写法，但 calc 里没法拿它做乘法，
    // 宿主页面要按「装进某个框」来算卡片尺寸时用这个
    root.style.setProperty('--hc-ratio', String(manifest.source.width / manifest.source.height));
    root.style.setProperty('--hc-amp', `${this.#options.amplitude * 100}%`);

    const translater = document.createElement('div');
    translater.className = 'hc__translater';
    const rotator = document.createElement('div');
    rotator.className = 'hc__rotator';
    const stack = document.createElement('div');
    stack.className = 'hc__stack';

    /*
     * 视差的「焦平面」取最远层和最近层的正中间：近处的往外飘，远处的往里退，两头一起动。
     * 以前是最远层钉死不动、只有近处在动，同样的立体感全压在主体上，
     * 主体要挪得多、放大补偿也大，边缘被裁掉一圈。现在每层只挪一半，放大也减半。
     * 所有层视差相同（整张图是一个刚体）时焦平面就落在它们上面，照旧完全不动。
     */
    const parallaxes = manifest.layers.map((layer) => layer.parallax);
    const focus = (Math.min(...parallaxes) + Math.max(...parallaxes)) / 2;
    this.#maxOffset = Math.max(...parallaxes.map((p) => Math.abs(p - focus)));
    root.style.setProperty('--hc-scale', String(this.#scale()));

    // 景深层：由远及近，每层 = 画面 + 这一层自己的箔面
    const masks: Promise<void>[] = [];
    const arts: { art: HTMLImageElement; ref: number }[] = [];
    // 拷一份，不持有调用方的对象。共用引用的话，外面对 manifest 的原地修改
    // 会不经 setHalo 就影响下一帧的炫光计算，而 --hc-halo-intensity 还停在旧值，
    // 强度和角度两条线对不上。
    this.#halo = { ...manifest.effects.halo, light: { ...manifest.effects.halo.light } };
    let group: Blob[] = [];
    manifest.layers.forEach((layer, index) => {
      const blob = images[index];
      if (!blob) return; // 上面已校验过长度，这里只为满足类型收窄

      const url = URL.createObjectURL(blob);
      this.#objectUrls.push(url);

      const plane = document.createElement('div');
      plane.className = 'hc__plane';
      plane.style.setProperty('--hc-parallax', String(layer.parallax - focus));

      const art = document.createElement('img');
      art.className = 'hc__art';
      art.src = url;
      art.alt = '';
      art.decoding = 'async';
      art.draggable = false;
      arts.push({ art, ref: layer.depth });

      // 箔面用这一层自己的图当遮罩，于是箔只出现在该层的 alpha 形状里。
      // 先直接用层图，高光保护遮罩（亮部箔面减弱，见 highlight.ts）异步算好再换上。
      // 静止时箔面本来就是透明的，换的那一下看不出来
      const shine = document.createElement('div');
      shine.className = 'hc__shine';
      shine.style.setProperty('--hc-mask', `url("${url}")`);
      const mask = layerMask(blob);
      masks.push(this.#applyMask(root, mask, shine, '--hc-mask'));
      this.#applyFoil(shine, layer.foil);
      this.#shines.push(shine);

      plane.append(art, shine);
      stack.append(plane);

      /*
       * 整卡炫光、高光：视差相同的相邻层是一组（它们一起动），每组上面各压一份，
       * 遮罩只按这一组的画面算亮部保护、并且跟着这一组平移和放大（见 card.css 的 .hc__fx）。
       * 更近的组画上来时盖住下面那份，所以每个像素最后吃到的是它最上面那一组的炫光。
       * 以前是整卡一份、遮罩静止不动，层一动遮罩里的轮廓就和人物错开，人物边上多出一道白带。
       * 渐变本身不动，还是整卡一片光。
       *
       * 遮罩位置：plane 是先平移 −n·s·amp（s = 这组视差 − 焦平面，百分比相对 plane 自身）再放大 k 倍，
       * k = 1 + 2·maxOffset·amp。遮罩尺寸取 k 倍后，百分比位置 P 对应的偏移是 (1 − k)·P，
       * 要等于 (1 − k)/2 − n·s·amp，解得 P = 50% + n·s / (2·maxOffset)，和振幅无关
       */
      group.push(blob);
      if (manifest.layers[index + 1]?.parallax === layer.parallax) return;
      const fx = document.createElement('div');
      fx.className = 'hc__fx';
      const shift = this.#maxOffset > 0 ? (layer.parallax - focus) / (2 * this.#maxOffset) : 0;
      fx.style.setProperty('--hc-fx-shift', `${round(shift * 100, 4)}%`);
      const halo = document.createElement('div');
      halo.className = 'hc__halo';
      halo.style.setProperty('--hc-halo-intensity', String(manifest.effects.halo.intensity));
      this.#haloEls.push(halo);
      fx.append(halo);
      if (manifest.effects.glare) {
        const glare = document.createElement('div');
        glare.className = 'hc__glare';
        fx.append(glare);
      }
      stack.append(fx);
      // 只有一层的组（主体一般就是），遮罩和这一层箔面的是同一张，不用再算一遍
      const fxMask = group.length === 1 ? mask : groupMask(group);
      masks.push(this.#applyMask(root, fxMask, fx, '--hc-card-mask'));
      group = [];
    });

    rotator.append(stack);
    translater.append(rotator);
    root.append(translater);
    this.#host.append(root);
    this.#root = root;
    if (set.depth && this.#options.relief > 0) masks.push(this.#setupRelief(root, set.depth, arts));
    this.#ready = Promise.all(masks).then(() => undefined);

    this.#writeVars();
    this.#bind(rotator);

    // 纹理是异步现算的；算好之前箔面照常工作，只是暂时没有颗粒和闪粉
    void ensureTextures()
      .then((textures) => {
        if (this.#root !== root) return; // 等纹理的功夫卡片已经换掉了
        root.style.setProperty('--grain', `url("${textures.grain}")`);
        root.style.setProperty('--glitter', `url("${textures.glitter}")`);
      })
      .catch(() => {
        // 没有 OffscreenCanvas 的环境生成不了纹理，箔面退化成纯渐变，不算错误
      });
  }

  /** 改某一层的箔面，立即生效，不重建 DOM */
  setLayerFoil(index: number, foil: LayerFoil): void {
    const shine = this.#shines[index];
    if (shine) this.#applyFoil(shine, foil);
  }

  /** 改整卡炫光，立即生效 */
  setHalo(halo: HaloEffect): void {
    this.#halo = { ...halo, light: { ...halo.light } };
    for (const el of this.#haloEls) el.style.setProperty('--hc-halo-intensity', String(halo.intensity));
    this.#writeVars();
  }

  /** 运行时改参数，用于演示页的调参面板 */
  setOptions(patch: Partial<HoloCardOptions>): void {
    this.#options = { ...this.#options, ...patch };
    const root = this.#root;
    if (!root) return;

    root.style.setProperty('--hc-amp', `${this.#options.amplitude * 100}%`);
    // 振幅变了，放大补偿要跟着重算
    root.style.setProperty('--hc-scale', String(this.#scale()));
    this.#writeVars();
  }

  /**
   * 不走动画，直接把卡片摆到「指针停在 (percentX, percentY)」时的姿态。
   * 坐标是卡面内的百分比 0..100。传 null 回到静止姿态。
   *
   * 用途：生成静态预览图、用陀螺仪之类的外部输入驱动、以及在 rAF 不工作的环境里
   * （被遮挡的窗口、无头截图）验证画面。
   */
  setPose(pose: { x: number; y: number } | null): void {
    window.clearTimeout(this.#snapTimer);
    if (this.#rafId !== 0) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = 0;
    }

    if (pose === null) {
      this.#rotate.set({ x: 0, y: 0 }, { hard: true });
      this.#glare.set({ x: 50, y: 50, o: 0 }, { hard: true });
      this.#background.set({ x: 50, y: 50 }, { hard: true });
    } else {
      const x = clamp(pose.x);
      const y = clamp(pose.y);
      this.#rotate.set(rotationFromPointer(x, y, this.#options.tiltScale), { hard: true });
      this.#glare.set({ x, y, o: 1 }, { hard: true });
      this.#background.set(
        { x: adjust(x, 0, 100, 37, 63), y: adjust(y, 0, 100, 33, 67) },
        { hard: true },
      );
    }
    this.#writeVars();
  }

  /**
   * 把卡片平滑转到炫光最亮的角度，停一会儿再缓缓回正。
   *
   * 给调参面板用：拖滑块时手指不在卡片上，卡片是静止的——而箔面、炫光要转起来才显，
   * 视差要歪过去才看得出，静止时这些全是 0，拖滑块看不到任何变化（issue #3 第 3、4 条）。
   * 连续拖动时反复调用，每次都会把回正往后推。
   */
  preview(): void {
    const halo = this.#halo;
    if (!this.#root || !halo) return;
    this.#aim(50 + halo.light.peakAt[0] * 50, 50 + halo.light.peakAt[1] * 50);
    this.#interactEnd(PREVIEW_HOLD_MS);
    // 手机上拖滑块时手难免在动，别让陀螺仪把要展示的姿态立刻盖掉
    this.#gyroYieldUntil = performance.now() + PREVIEW_HOLD_MS + POINTER_PRIORITY_MS;
    this.#gyroAiming = false;
  }

  /**
   * 让卡片跟着手机倾斜。iOS 要先在用户手势里拿到 DeviceOrientationEvent.requestPermission()
   * 的授权再调这里，渲染器不管权限。没有陀螺仪的设备调了也无害，只是收不到事件
   */
  enableGyro(): void {
    if (this.#gyro) return;
    this.#gyro = true;
    const signal = this.#listenerAbort?.signal;
    if (signal) this.#bindGyro(signal);
  }

  destroy(): void {
    this.#teardownDom();
  }

  /**
   * 高光保护遮罩算好后写到 el 的 variable 上。
   * 算不出来（解不开图、拿不到 canvas）就保持原样：效果照常，只是亮部没有保护
   */
  async #applyMask(
    root: HTMLDivElement,
    mask: Promise<string>,
    el: HTMLElement,
    variable: string,
  ): Promise<void> {
    try {
      const url = await mask;
      // 先解码再换上：ready 要保证截图时遮罩已经真正生效，而不只是 CSS 变量写进去了。
      // 解码过的 blob 图，CSS 再引用同一个地址时直接用缓存
      const probe = new Image();
      probe.src = url;
      await probe.decode();
      // 算的功夫卡片已经换掉了
      if (this.#root !== root) {
        URL.revokeObjectURL(url);
        return;
      }
      this.#objectUrls.push(url);
      el.style.setProperty(variable, `url("${url}")`);
    } catch {
      // 见上
    }
  }

  /**
   * 给每层建浮雕画布，顶替原来的 <img>。<img> 留在原处只是藏起来：
   * 演示页、截图脚本还要读它的 src；画布的上下文丢了也要靠它顶回去。
   * 任何一层建不起来就全部不要——一半层有浮雕一半没有，层与层的接缝会错开
   */
  async #setupRelief(
    root: HTMLDivElement,
    depthBlob: Blob,
    arts: { art: HTMLImageElement; ref: number }[],
  ): Promise<void> {
    const url = URL.createObjectURL(depthBlob);
    this.#objectUrls.push(url);
    const depth = new Image();
    depth.src = url;
    try {
      await Promise.all([depth.decode(), ...arts.map(({ art }) => art.decode())]);
    } catch {
      return;
    }
    if (this.#root !== root) return; // 等解码的功夫卡片已经换掉了

    const created: { relief: Relief; ref: number; art: HTMLImageElement }[] = [];
    try {
      const grid = sampleDepth(depth);
      // 画布跟着 plane 放大了 --hc-scale 倍，按放大后的宽度建。
      // 隐藏中的卡（卡带切换时）宽度是 0，按一个常见的卡片宽度建
      const width = (root.clientWidth || 480) * this.#scale();
      for (const { art, ref } of arts) {
        const relief = new Relief(art, grid, width, () => this.#dropRelief());
        created.push({ relief, ref, art });
      }
    } catch (error) {
      for (const { relief } of created) relief.destroy();
      console.info('[holocard] 浮雕不可用，用平的层：', error instanceof Error ? error.message : error);
      return;
    }
    for (const { relief, art } of created) {
      relief.canvas.className = 'hc__relief';
      art.after(relief.canvas);
      art.style.visibility = 'hidden';
    }
    this.#reliefs = created.map(({ relief, ref }) => ({ relief, ref }));
    this.#writeVars();
  }

  /** 有一块画布的 WebGL 上下文丢了（系统回收显存）：全部退回 <img>，理由同上 */
  #dropRelief(): void {
    for (const { relief } of this.#reliefs) {
      relief.canvas.previousElementSibling?.removeAttribute('style');
      relief.destroy();
    }
    this.#reliefs = [];
  }

  /**
   * 位移会让层的边缘露白，按位移最大的那一层反推需要放大多少。
   *
   * 所有层必须用同一个倍数。以前是各层按自己的位移各放各的（主体 1.12、背景 1.0），
   * 放大又是绕卡片中心，结果卡片静止时主体就比它在背景里留下的那个坑大一圈、偏出去一截：
   * 狗头和狗身子对不上、人的肩膀接不上，一张卡还没转就已经断了（issue #3 第 2 条的「分层断裂」）。
   * 统一放大之后，静止时整张卡就是原图等比放大，层与层严丝合缝。
   */
  #scale(): number {
    return 1 + 2 * this.#maxOffset * this.#options.amplitude;
  }

  #applyFoil(shine: HTMLDivElement, foil: LayerFoil): void {
    shine.dataset['foil'] = foil.type;
    shine.style.setProperty('--hc-foil-intensity', String(foil.intensity));
  }

  #bind(rotator: HTMLDivElement): void {
    const controller = new AbortController();
    this.#listenerAbort = controller;
    const { signal } = controller;

    rotator.addEventListener('pointermove', (event) => this.#interact(event), {
      signal,
      passive: true,
    });
    for (const type of ['pointerleave', 'pointerup', 'pointercancel'] as const) {
      rotator.addEventListener(
        type,
        (event) => {
          // 鼠标抬起不算结束，只有触摸抬起才算——鼠标还停在卡上
          if (type === 'pointerup' && event.pointerType === 'mouse') return;
          this.#interactEnd();
        },
        { signal, passive: true },
      );
    }

    if (this.#gyro) this.#bindGyro(signal);

    // 上游在 visibilitychange 时会把卡片整个复位，因为 svelte 的弹簧没有 dt 封顶，
    // 切回前台时攒下的时间差会把卡片甩飞。我们的循环已经把 dt 封顶（见 #ensureLoop），
    // 回到前台只会从原姿态平滑继续，所以不需要那个复位。
  }

  #bindGyro(signal: AbortSignal): void {
    window.addEventListener('deviceorientation', (event) => this.#orient(event), {
      signal,
      passive: true,
    });
  }

  /** 手机倾斜：相对一个会慢慢跟上来的基准姿态算偏转（见 gyro.ts），所以拿着不动会自己回正 */
  #orient(event: DeviceOrientationEvent): void {
    if (event.beta === null || event.gamma === null) return;
    if (!this.#root || document.visibilityState !== 'visible' || prefersReducedMotion()) return;

    const now = performance.now();
    // 切到后台再回来 dt 会很大，基准一步跟到当前姿态，等于重新校准，正是想要的
    const dt = this.#lastOrientTime === 0 ? 0 : (now - this.#lastOrientTime) / 1000;
    this.#lastOrientTime = now;
    // 手指在卡上时基准也照常跟，手指一走接回来不会猛地一跳
    const tilt = this.#tilt.update(event.beta, event.gamma, screen.orientation?.angle ?? 0, dt);
    if (now < this.#gyroYieldUntil) return;

    if (Math.hypot(tilt.dx, tilt.dy) < DEADZONE_DEGREES) {
      // 回正用同一根弹簧，不走松手回正那套「迟疑一下再软软归位」，那在手机上就是粘
      if (this.#gyroAiming) {
        this.#gyroAiming = false;
        this.#aim(50, 50, GYRO_SPRING, 0);
      }
      return;
    }
    this.#gyroAiming = true;
    this.#aim(tilt.x, tilt.y, GYRO_SPRING);
  }

  /** 指针在卡面上移动（对应上游 interact） */
  #interact(event: PointerEvent): void {
    const root = this.#root;
    if (!root || document.visibilityState !== 'visible') return;
    this.#gyroYieldUntil = performance.now() + POINTER_PRIORITY_MS;
    this.#gyroAiming = false;

    // 用不旋转的外框取矩形；旋转中的元素的包围盒会跟着变形，拿它算坐标会自激
    const rect = root.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    this.#aim(
      clamp(round((100 / rect.width) * (event.clientX - rect.left))),
      clamp(round((100 / rect.height) * (event.clientY - rect.top))),
    );
  }

  /** 让卡片跟着弹簧转向「指针停在卡面 (x, y) 百分比处」的姿态 */
  #aim(x: number, y: number, params = INTERACT_SPRING, opacity = 1): void {
    window.clearTimeout(this.#snapTimer);

    for (const spring of [this.#rotate, this.#glare, this.#background]) {
      spring.stiffness = params.stiffness;
      spring.damping = params.damping;
    }

    // 背景位移量故意收窄到中间一小段，箔面花纹只是微微游动而不是满屏乱扫
    this.#background.set({
      x: adjust(x, 0, 100, 37, 63),
      y: adjust(y, 0, 100, 33, 67),
    });
    this.#rotate.set(rotationFromPointer(x, y, this.#options.tiltScale));
    this.#glare.set({ x: round(x), y: round(y), o: opacity });

    this.#ensureLoop();
  }

  /** 指针离开（对应上游 interactEnd）：等一会儿，再用很软的弹簧缓缓回正 */
  #interactEnd(delay = SNAP_DELAY_MS): void {
    window.clearTimeout(this.#snapTimer);
    this.#snapTimer = window.setTimeout(() => {
      for (const spring of [this.#rotate, this.#glare, this.#background]) {
        spring.stiffness = SNAP_SPRING.stiffness;
        spring.damping = SNAP_SPRING.damping;
      }
      this.#rotate.set({ x: 0, y: 0 }, { soft: 1 });
      this.#glare.set({ x: 50, y: 50, o: 0 }, { soft: 1 });
      this.#background.set({ x: 50, y: 50 }, { soft: 1 });
      this.#ensureLoop();
    }, delay);
  }

  /** 三根弹簧共用一个 rAF 循环，全部静止后自动停掉 */
  #ensureLoop(): void {
    if (prefersReducedMotion()) {
      // 不进循环，直接把三根弹簧推到目标值再写一次变量
      this.#rotate.set(this.#rotate.target, { hard: true });
      this.#glare.set(this.#glare.target, { hard: true });
      this.#background.set(this.#background.target, { hard: true });
      this.#writeVars();
      return;
    }
    if (this.#rafId !== 0) return;
    this.#lastTime = performance.now();

    const frame = (now: number): void => {
      // 以 1/60 秒为单位；上界封顶 3 帧，避免卡顿后一步迈太大把弹簧甩飞。
      // 下界也要钳：#lastTime 是在 pointermove 事件里记的，同一帧内输入事件先于
      // rAF 回调派发，所以首帧的 now 可能早于它，算出来是负的。
      const dt = Math.max(0, Math.min(3, ((now - this.#lastTime) * 60) / 1000));
      this.#lastTime = now;

      const settledRotate = this.#rotate.tick(dt);
      const settledGlare = this.#glare.tick(dt);
      const settledBackground = this.#background.tick(dt);
      this.#writeVars();

      this.#rafId =
        settledRotate && settledGlare && settledBackground ? 0 : requestAnimationFrame(frame);
    };
    this.#rafId = requestAnimationFrame(frame);
  }

  /** 把弹簧当前值写成 CSS 变量。变量名与上游一致，foils.css 的配方直接吃这些 */
  #writeVars(): void {
    const root = this.#root;
    if (!root) return;

    const rotate = this.#rotate.value;
    const glare = this.#glare.value;
    const background = this.#background.value;
    const style = root.style;

    const fromCenter = clamp(
      Math.sqrt((glare.y - 50) * (glare.y - 50) + (glare.x - 50) * (glare.x - 50)) / 50,
      0,
      1,
    );

    style.setProperty('--pointer-x', `${round(glare.x)}%`);
    style.setProperty('--pointer-y', `${round(glare.y)}%`);
    style.setProperty('--pointer-from-center', String(round(fromCenter)));
    style.setProperty('--pointer-from-top', String(round(glare.y / 100)));
    style.setProperty('--pointer-from-left', String(round(glare.x / 100)));
    style.setProperty('--card-opacity', String(round(glare.o)));
    style.setProperty('--rotate-x', `${round(rotate.x)}deg`);
    style.setProperty('--rotate-y', `${round(rotate.y)}deg`);
    style.setProperty('--background-x', `${round(background.x)}%`);
    style.setProperty('--background-y', `${round(background.y)}%`);

    // 视差吃的是过了弹簧的指针位置，所以层的滑动和转卡是同一种手感。
    // 必须钳到 [-1, 1]：glare 弹簧是欠阻尼的，快速划过时会过冲出界，
    // 而 #scale 的缩放补偿是按 |n| ≤ 1 推的，过冲时层的边缘会缩进卡面里露边。
    style.setProperty('--hc-nx', String(round(clamp((glare.x - 50) / 50, -1, 1), 4)));
    style.setProperty('--hc-ny', String(round(clamp((glare.y - 50) / 50, -1, 1), 4)));

    // 浮雕：层内每单位深度差比整层多挪多少。和 CSS 的整层平移同方向（近处朝指针反方向），
    // 除以放大倍数是因为画布跟着 plane 放大了，同样的屏幕位移在纹理坐标里要小一些
    if (this.#reliefs.length > 0) {
      const k = (this.#options.amplitude * this.#options.relief) / this.#scale();
      const sx = -clamp((glare.x - 50) / 50, -1, 1) * k;
      const sy = -clamp((glare.y - 50) / 50, -1, 1) * k;
      for (const { relief, ref } of this.#reliefs) relief.draw(sx, sy, ref);
    }

    const halo = this.#halo;
    const haloValue =
      halo && halo.intensity > 0
        ? computeHalo(rotate.x, rotate.y, halo.light, this.#options.tiltScale)
        : 0;
    style.setProperty('--hc-halo', String(round(haloValue, 4)));
  }

  #teardownDom(): void {
    window.clearTimeout(this.#snapTimer);
    if (this.#rafId !== 0) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = 0;
    }
    this.#listenerAbort?.abort();
    this.#listenerAbort = null;

    for (const url of this.#objectUrls) {
      URL.revokeObjectURL(url);
    }
    this.#objectUrls = [];
    for (const { relief } of this.#reliefs) relief.destroy();
    this.#reliefs = [];
    this.#shines = [];
    this.#haloEls = [];
    this.#halo = null;
    this.#gyroAiming = false;

    // 换卡后弹簧从静止姿态重新开始，否则新卡一出来就是歪的
    this.#rotate.set({ x: 0, y: 0 }, { hard: true });
    this.#glare.set({ x: 50, y: 50, o: 0 }, { hard: true });
    this.#background.set({ x: 50, y: 50 }, { hard: true });

    this.#root?.remove();
    this.#root = null;
  }
}
