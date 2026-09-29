/**
 * 开包音效：全部用 Web Audio 现合成，不带音频文件——零下载，也没有素材版权的事。
 *
 * 浏览器只让用户手势启动声音：每次按下（点、触、按键）时顺手建好或唤醒 AudioContext，
 * 之后异步响的声音（比如「卡做好了」）才放得出来。iPhone 开着静音键时 Web Audio 本来就不出声。
 * 开关记在本机，卡带右下角那个喇叭按钮切换（见 deck.ts）。
 *
 * 每个声音是一份「配方」：往给定的 context 上搭节点、排好时间。实时播放用页面的 AudioContext，
 * scripts/render-sfx.mjs 用 OfflineAudioContext 把同一份配方渲染成 wav，改音色时拿来听、查有没有爆音。
 */

const KEY = 'holocard:sfx';

type Recipe = (c: BaseAudioContext, out: AudioNode, t: number) => void;

let live: { c: AudioContext; out: AudioNode } | null = null;

export function sfxOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    // 隐私模式下可能直接抛；默认开
    return true;
  }
}

export function setSfxOn(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // 存不下只是下次打开又回到默认
  }
  if (on) unlock();
}

/** 总音量 + 压限：几个声音叠在一起也不会爆。返回配方该接到的那个节点 */
export function masterBus(c: BaseAudioContext): AudioNode {
  const master = c.createGain();
  master.gain.value = 0.8;
  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.ratio.value = 6;
  master.connect(limiter).connect(c.destination);
  return master;
}

/** 在用户手势里调用：建好（或唤醒）AudioContext。关着音效时不建 */
function unlock(): void {
  if (!sfxOn()) return;
  if (!live) {
    const Ctor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const c = new Ctor();
    live = { c, out: masterBus(c) };
  }
  // iOS 切到后台再回来会把它挂起，每次手势都唤醒一下，已经在跑就什么都不做
  if (live.c.state === 'suspended') void live.c.resume();
}
for (const type of ['pointerdown', 'keydown'] as const) {
  addEventListener(type, unlock, { capture: true, passive: true });
}

function running(): { c: AudioContext; out: AudioNode } | null {
  return live && live.c.state === 'running' && sfxOn() ? live : null;
}

function play(recipe: Recipe): void {
  const ctx = running();
  if (ctx) recipe(ctx.c, ctx.out, ctx.c.currentTime + 0.005);
}

// ---------- 素材：白噪声和「揉铝箔」 ----------

const banks = new WeakMap<BaseAudioContext, { noise: AudioBuffer; crackle: AudioBuffer }>();

function bank(c: BaseAudioContext): { noise: AudioBuffer; crackle: AudioBuffer } {
  let b = banks.get(c);
  if (b) return b;
  const rate = c.sampleRate;
  const noise = c.createBuffer(1, rate * 2, rate);
  const n = noise.getChannelData(0);
  for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;

  // 揉铝箔的声音：一层很轻的底噪上叠满稀疏的小爆裂，每个几毫秒就衰减掉
  const crackle = c.createBuffer(1, Math.round(rate * 1.5), rate);
  const k = crackle.getChannelData(0);
  for (let i = 0; i < k.length; i++) k[i] = (Math.random() * 2 - 1) * 0.1;
  for (let e = 0; e < 330; e++) {
    const at = Math.floor(Math.random() * k.length);
    const amp = 0.25 + Math.random() * 0.75;
    const len = Math.floor(rate * (0.0015 + Math.random() * 0.005));
    for (let j = 0; j < len && at + j < k.length; j++) {
      k[at + j] = (k[at + j] ?? 0) + (Math.random() * 2 - 1) * amp * Math.exp((-4 * j) / len);
    }
  }
  let peak = 0;
  for (const v of k) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < k.length; i++) k[i] = (k[i] ?? 0) / peak;

  b = { noise, crackle };
  banks.set(c, b);
  return b;
}

// ---------- 积木 ----------

/** 起音 attack 秒到 peak，再 decay 秒指数衰减到无声 */
function envelope(gain: AudioParam, t: number, attack: number, peak: number, decay: number): void {
  gain.setValueAtTime(0.0001, t);
  gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

interface Burst {
  buffer: 'noise' | 'crackle';
  filter: BiquadFilterType;
  /** 滤波频率从 from 滑到 to */
  from: number;
  to: number;
  q: number;
  attack: number;
  peak: number;
  decay: number;
}

/** 一段过滤过的噪声。带通很窄时能量低，peak 要给到 1 以上才和别的声音一样响（用 scripts/render-sfx.mjs 量） */
function burst(c: BaseAudioContext, out: AudioNode, t: number, b: Burst): void {
  const src = c.createBufferSource();
  src.buffer = bank(c)[b.buffer];
  const filter = c.createBiquadFilter();
  filter.type = b.filter;
  filter.Q.value = b.q;
  filter.frequency.setValueAtTime(b.from, t);
  filter.frequency.exponentialRampToValueAtTime(b.to, t + b.attack + b.decay);
  const gain = c.createGain();
  envelope(gain.gain, t, b.attack, b.peak, b.decay);
  src.connect(filter).connect(gain).connect(out);
  // 每次从素材里随便一个位置开始，连着响几次也不会一模一样
  src.start(t, Math.random() * 0.4);
  src.stop(t + b.attack + b.decay + 0.05);
}

/** 一个正弦音，可以滑音 */
function tone(c: BaseAudioContext, out: AudioNode, t: number, freq: number, peak: number, decay: number, to?: number): void {
  const osc = c.createOscillator();
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + decay);
  const gain = c.createGain();
  envelope(gain.gain, t, 0.004, peak, decay);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + decay + 0.05);
}

/** 铃：基音加两个不成倍数的泛音，再加一个略微跑调的副本，听起来有点闪 */
function bell(c: BaseAudioContext, out: AudioNode, t: number, freq: number, peak: number, decay: number): void {
  tone(c, out, t, freq, peak, decay);
  tone(c, out, t, freq * 1.004, peak * 0.5, decay * 0.9);
  tone(c, out, t, freq * 2.76, peak * 0.22, decay * 0.45);
  tone(c, out, t, freq * 5.4, peak * 0.07, decay * 0.25);
}

// ---------- 配方 ----------

export const recipes = {
  /** 封条整条扯下来：一声短促的「嘶啦」，跟着封条飞走的风声 */
  rip(c, out, t) {
    burst(c, out, t, { buffer: 'crackle', filter: 'bandpass', from: 5200, to: 1800, q: 0.8, attack: 0.004, peak: 3.6, decay: 0.16 });
    burst(c, out, t + 0.05, { buffer: 'noise', filter: 'bandpass', from: 1600, to: 380, q: 1.2, attack: 0.08, peak: 0.9, decay: 0.34 });
  },
  /** 卡从袋口滑出来：很轻的一声纸面摩擦，越滑越亮 */
  slide(c, out, t) {
    burst(c, out, t, { buffer: 'noise', filter: 'lowpass', from: 700, to: 2600, q: 0.5, attack: 0.25, peak: 0.4, decay: 0.35 });
  },
  /** 卡亮相转一圈：一串往上走的铃声，垫一阵轻轻的风 */
  spin(c, out, t) {
    [1318.5, 1568, 1975.5, 2637].forEach((freq, i) => bell(c, out, t + 0.05 + i * 0.07, freq, 0.12 - i * 0.015, 0.9));
    burst(c, out, t, { buffer: 'noise', filter: 'bandpass', from: 500, to: 1800, q: 1.4, attack: 0.45, peak: 0.07, decay: 0.55 });
  },
  /** 点开之前抖几下：袋子里的卡磕着膜 */
  shake(c, out, t) {
    for (let i = 0; i < 4; i++) {
      burst(c, out, t + i * 0.11, { buffer: 'crackle', filter: 'bandpass', from: 2400, to: 1400, q: 1.5, attack: 0.003, peak: 2.6 * (1 - i * 0.18), decay: 0.05 });
    }
  },
  /** 炸开：一记闷响加一团散开的气 */
  burst(c, out, t) {
    tone(c, out, t, 170, 0.7, 0.38, 42);
    burst(c, out, t, { buffer: 'noise', filter: 'lowpass', from: 4000, to: 300, q: 0.7, attack: 0.01, peak: 0.4, decay: 0.5 });
  },
  /** 发牌：一张卡落进卡册，轻轻一声「嗒」 */
  deal(c, out, t) {
    burst(c, out, t, { buffer: 'noise', filter: 'bandpass', from: 2600, to: 1200, q: 1.1, attack: 0.002, peak: 1.4, decay: 0.06 });
    tone(c, out, t, 190, 0.14, 0.05, 140);
  },
  /** 还没做好就点：轻轻一声「咚」 */
  nudge(c, out, t) {
    tone(c, out, t, 330, 0.45, 0.12, 220);
  },
  /** 卡做好了：两个音的提示铃 */
  ready(c, out, t) {
    bell(c, out, t, 1318.5, 0.12, 0.7);
    bell(c, out, t + 0.13, 1975.5, 0.12, 0.9);
  },
} satisfies Record<string, Recipe>;

export const sfx = {
  rip: () => play(recipes.rip),
  slide: () => play(recipes.slide),
  spin: () => play(recipes.spin),
  shake: () => play(recipes.shake),
  burst: () => play(recipes.burst),
  nudge: () => play(recipes.nudge),
  deal: () => play(recipes.deal),
  ready: () => play(recipes.ready),
};

export interface TearSound {
  /** 手指在动：speed 是每秒划过几个卡包宽，progress 是撕到哪了（0..1）。at 只给离线渲染用 */
  move(speed: number, progress: number, at?: number): void;
  stop(at?: number): void;
}

/**
 * 撕的时候跟手的「嘶——」：一直循环的铝箔声，手指划得快就响、停下就静，越撕越尖。
 * 不传 c/out 就用页面的 AudioContext（没解锁或关着音效时返回一个什么都不做的）
 */
export function tearSound(c?: BaseAudioContext, out?: AudioNode): TearSound {
  const ctx = c && out ? { c, out } : running();
  if (!ctx) return { move() {}, stop() {} };
  const src = ctx.c.createBufferSource();
  src.buffer = bank(ctx.c).crackle;
  src.loop = true;
  const filter = ctx.c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 0.7;
  filter.frequency.value = 2200;
  const gain = ctx.c.createGain();
  gain.gain.value = 0;
  src.connect(filter).connect(gain).connect(ctx.out);
  src.start();
  return {
    move(speed, progress, at = ctx.c.currentTime) {
      gain.gain.cancelScheduledValues(at);
      gain.gain.setTargetAtTime(Math.min(1, speed / 2) * 0.6, at, 0.03);
      // 手停下来 80ms 没新动静就自己静下去
      gain.gain.setTargetAtTime(0, at + 0.08, 0.05);
      filter.frequency.setTargetAtTime(2200 + 2600 * progress, at, 0.05);
    },
    stop(at = ctx.c.currentTime) {
      gain.gain.cancelScheduledValues(at);
      gain.gain.setTargetAtTime(0, at, 0.02);
      src.stop(at + 0.2);
    },
  };
}
