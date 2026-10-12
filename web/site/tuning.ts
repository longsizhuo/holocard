/**
 * 卡片和调参：页面上那一张 HoloCard，面板上的视差、炫光、各层箔面，以及主人调完之后存回服务端
 */

import { HoloCard } from '../../src/renderer/card';
import { FOIL_TYPES, type FoilType, type LayerSet, type ParallaxEffect } from '../../src/format/types';
import { configOf, type CardConfig } from '../../src/format/config';
import { t, type MessageKey } from '../../src/i18n';
import { isMine, saveConfig } from './api';
import { route } from './route';
import { track } from './track';
import { describeError, need, setText, status } from './text';

const FOIL_LABEL: Record<FoilType, MessageKey> = {
  none: 'foil.none',
  holo: 'foil.holo',
  sunpillar: 'foil.sunpillar',
  rainbow: 'foil.rainbow',
};

const foilList = need<HTMLDivElement>('#foil-list');
const ctlParallax = need<HTMLInputElement>('#ctl-parallax');
const ctlAmp = need<HTMLInputElement>('#ctl-amp');
const ctlIntensity = need<HTMLInputElement>('#ctl-intensity');
const ctlSharp = need<HTMLInputElement>('#ctl-sharp');
const outAmp = need<HTMLOutputElement>('#out-amp');
const outIntensity = need<HTMLOutputElement>('#out-intensity');
const outSharp = need<HTMLOutputElement>('#out-sharp');
const outHalo = need<HTMLOutputElement>('#out-halo');
const haloFill = need<HTMLElement>('#halo-fill');

/** 立体视差开关记在本机。隐私模式下读写 localStorage 会抛，当作没记过 */
const PARALLAX_KEY = 'holocard:parallax';
try {
  ctlParallax.checked = localStorage.getItem(PARALLAX_KEY) !== 'off';
} catch {
  // 同上
}

/** 当前该用的视差振幅：开关关着就是 0（平面卡），开着按滑块 */
function amplitude(): number {
  return ctlParallax.checked ? Number(ctlAmp.value) / 100 : 0;
}
ctlAmp.disabled = !ctlParallax.checked;

export const card = new HoloCard(need<HTMLDivElement>('.deck__card'), { amplitude: amplitude() });

// 开发环境下把实例挂到 window 上，方便在控制台里 __holocard.setPose({x:25,y:25}) 摆姿态看效果
if (import.meta.env.DEV) {
  (window as Window & { __holocard?: HoloCard }).__holocard = card;
}

/**
 * 面板正对着的那张卡。set：面板上的改动会同步写回这里，导出时拿到的就是调好的配置；
 * id：这张卡在服务端的 id，只有服务端产出的卡才有，手工素材、示例卡没有
 */
export const current: { set: LayerSet | null; id: string | null } = { set: null, id: null };

/** 视差开关此刻开着没有（性能埋点要带上） */
export function parallaxOn(): boolean {
  return ctlParallax.checked;
}

// ---------- 箔面面板 ----------

/** 层的称呼：由远及近 */
function layerName(index: number, count: number): string {
  if (count === 1) return t('layer.whole');
  if (index === 0) return t('layer.far');
  if (index === count - 1) return t('layer.near');
  return count === 3 ? t('layer.middle') : t('layer.middleN', { n: index });
}

/** 按当前层数重建「各层箔面」面板。层数是算出来的，不能写死在 HTML 里 */
function buildFoilControls(set: LayerSet): void {
  foilList.replaceChildren();
  const count = set.manifest.layers.length;

  // 面板从近到远排，和肉眼看卡的顺序一致：先看到主体，再看到背景
  for (let index = count - 1; index >= 0; index--) {
    const layer = set.manifest.layers[index];
    if (!layer) continue;

    const row = document.createElement('div');
    row.className = 'foil-row';

    const name = document.createElement('span');
    name.className = 'foil-row__name';
    name.textContent = layerName(index, count);

    const select = document.createElement('select');
    for (const type of FOIL_TYPES) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = t(FOIL_LABEL[type]);
      select.append(option);
    }
    select.value = layer.foil.type;

    const strength = document.createElement('input');
    strength.type = 'range';
    strength.min = '0';
    strength.max = '1';
    strength.step = '0.05';
    strength.value = String(layer.foil.intensity);
    strength.title = t('panel.foilStrength');

    const apply = (): void => {
      layer.foil = { type: select.value as FoilType, intensity: Number(strength.value) };
      strength.disabled = layer.foil.type === 'none';
      card.setLayerFoil(index, layer.foil);
      // 静止的卡片上箔面是透明的，转过去才看得见调了什么
      card.preview();
      scheduleSave();
    };
    select.addEventListener('change', apply);
    strength.addEventListener('input', apply);
    strength.disabled = layer.foil.type === 'none';

    row.append(name, select, strength);
    foilList.append(row);
  }
}

/** 切换语言后调：箔面面板里的层名、箔面名是建面板时写进去的 */
export function relabelTuning(): void {
  if (current.set) buildFoilControls(current.set);
}

/** 换一组层：渲染 + 重建面板 + 让面板上的全局参数继续生效 */
export function tune(set: LayerSet, id: string | null): void {
  current.set = set;
  current.id = id;
  // 方向是 manifest → 面板，和 buildFoilControls 处理逐层箔面的方向一致。
  // 反过来写（拿滑杆当前值去覆盖 manifest）的话，任何自带炫光参数的卡
  // ——别人分享过来的、或本地导入的 .layers——一加载就被滑杆默认值悄悄改掉了。
  const halo = set.manifest.effects.halo;
  ctlIntensity.value = String(halo.intensity);
  ctlSharp.value = String(halo.light.sharpness);
  // 视差同理：作者存过就按作者的；没存过（旧卡、刚做出来的卡）按看的人本机的偏好
  applyParallax(set.manifest.effects.parallax ?? localParallax());

  card.setLayerSet(set);
  buildFoilControls(set);
  // 刚做出来的卡还没存过视差：把主人此刻的设置记下来，分享出去别人看到的才和主人一样
  if (!set.manifest.effects.parallax) scheduleSave();
}

/** 卡带停在卡包上：还没有卡可调 */
export function untune(): void {
  current.set = null;
  current.id = null;
  foilList.replaceChildren();
}

function applyHalo(): void {
  if (!current.set) return;
  const halo = current.set.manifest.effects.halo;
  halo.intensity = Number(ctlIntensity.value);
  halo.light = { ...halo.light, sharpness: Number(ctlSharp.value) };
  card.setHalo(halo);
  scheduleSave();
}

// ---------- 作者配置存回服务端 ----------

/** 面板上视差开关和滑块此刻的状态 */
function panelParallax(): ParallaxEffect {
  return { enabled: ctlParallax.checked, amplitude: Number(ctlAmp.value) / 100 };
}

/** 没存过视差的卡用这个：开关按本机记的偏好，幅度用滑块的默认值 */
function localParallax(): ParallaxEffect {
  let enabled = true;
  try {
    enabled = localStorage.getItem(PARALLAX_KEY) !== 'off';
  } catch {
    // 同上
  }
  return { enabled, amplitude: Number(ctlAmp.defaultValue) / 100 };
}

function applyParallax(parallax: ParallaxEffect): void {
  ctlParallax.checked = parallax.enabled;
  ctlAmp.value = String(Math.round(parallax.amplitude * 1000) / 10);
  ctlAmp.disabled = !parallax.enabled;
  outAmp.value = `${ctlAmp.value}%`;
  card.setOptions({ amplitude: amplitude() });
}

/** 拖滑块时别每一下都发：停手这么久再存 */
const SAVE_DELAY_MS = 800;
let pendingSave: { id: string; config: CardConfig } | null = null;
let saveTimer = 0;

/** 主人调了东西：记下这张卡此刻的配置，停手一会儿再存。别人的卡在本机随便调，不存 */
function scheduleSave(): void {
  const { set, id } = current;
  if (!set || !id || route.mode === 'render' || !isMine(id)) return;
  const parallax = panelParallax();
  set.manifest.effects.parallax = parallax;
  // 等着存的是另一张卡（停手不到一秒就换了卡），那张先发出去
  if (pendingSave && pendingSave.id !== id) void flushSave();
  pendingSave = { id, config: configOf(set.manifest, parallax) };
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushSave(), SAVE_DELAY_MS);
}

/**
 * 存的请求排成一条链：一次一次按顺序发，后调的不会被先调的覆盖；
 * 分享、导出等的也是这条链，这样已经发出去还没回来的那次也算在内
 */
let saving: Promise<void> = Promise.resolve();

/** 立刻把等着的那次存掉。分享、导出之前要先等它，否则拿到的是服务端上旧的配置 */
export function flushSave(): Promise<void> {
  window.clearTimeout(saveTimer);
  const job = pendingSave;
  pendingSave = null;
  if (job) {
    saving = saving.then(async () => {
      try {
        await saveConfig(job.id, job.config);
      } catch (error) {
        // 本机的效果不受影响，只是分享出去的还是旧的，告诉主人一声
        if (job.id === current.id) setText(status, 'status.saveFailed', { message: describeError(error) });
      }
    });
  }
  return saving;
}

// 调完马上关页面：还没到点的那次也发出去（saveConfig 带 keepalive）。
// 不排进 saving 链：链上要是还有一发在路上，排在它后面的这一发得等它回来才发，那时页面已经没了。
// 服务端是整份覆盖，和在路上那发乱序到达的话，后到的赢——两发只差几百毫秒，接受这点概率
window.addEventListener('pagehide', () => {
  window.clearTimeout(saveTimer);
  const job = pendingSave;
  pendingSave = null;
  if (job) void saveConfig(job.id, job.config).catch(() => undefined);
});

/**
 * 把此刻炫光实际有多亮显示出来，纯读数：角度决定的那部分（渲染器算的 --hc-halo）× 炫光强度。
 * 乘上强度，拖强度滑块时读数条才会跟着动。
 *
 * 只在「景深与炫光」展开时每帧读：读数就在那个默认折叠的面板里，折着时看不见。
 * 以前是无条件每帧跑，每秒按屏幕刷新率（60～240 次）多跑一轮主线程、提交一帧。
 * （页面上的扫光、标题渐变这些 CSS 动画照样每帧出图，所以页面并不会因此完全闲下来，省的只是这一份）
 */
const moreBox = need<HTMLDetailsElement>('details.more');
let haloRaf = 0;
export function pollHalo(): void {
  haloRaf = 0;
  if (!moreBox.open) return;
  const root = card.element;
  if (root) {
    const value = (Number(root.style.getPropertyValue('--hc-halo')) || 0) * Number(ctlIntensity.value);
    outHalo.value = value.toFixed(2);
    haloFill.style.width = `${Math.round(value * 100)}%`;
  }
  haloRaf = requestAnimationFrame(pollHalo);
}
moreBox.addEventListener('toggle', () => {
  if (moreBox.open && !haloRaf) pollHalo();
});

/*
 * 这三个滑块拖动时都让卡片转到炫光最亮的角度（card.preview）。
 * 手指在滑块上时卡片是静止的，而视差要歪过去才看得出、炫光要转到那个角度才出来，
 * 不转的话拖滑块画面上什么都不变（issue #3 第 3、4 条说的「感知不明显」就是这个）。
 */
ctlAmp.addEventListener('input', () => {
  outAmp.value = `${ctlAmp.value}%`;
  card.setOptions({ amplitude: amplitude() });
  card.preview();
  scheduleSave();
});

// 关掉视差：振幅归零，放大补偿也跟着变成 1，照片完整显示、不再被裁掉一圈
ctlParallax.addEventListener('change', () => {
  ctlAmp.disabled = !ctlParallax.checked;
  card.setOptions({ amplitude: amplitude() });
  card.preview();
  scheduleSave();
  try {
    localStorage.setItem(PARALLAX_KEY, ctlParallax.checked ? 'on' : 'off');
  } catch {
    // 存不下就只管这一次
  }
  track('parallax', { on: ctlParallax.checked ? 1 : 0 });
});

ctlIntensity.addEventListener('input', () => {
  outIntensity.value = Number(ctlIntensity.value).toFixed(2);
  applyHalo();
  card.preview();
});

ctlSharp.addEventListener('input', () => {
  outSharp.value = ctlSharp.value;
  applyHalo();
  card.preview();
});
