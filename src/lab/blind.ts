/**
 * 双盲对比页：一次一对，A、B 两张卡用站里同一个渲染器实时渲染，姿态完全同步。
 *
 * 页面和数据分开：页面在这里，跟站点同一份渲染器源码一起构建，不会和线上渲染漂移；
 * 每次实验的数据由 scripts/blind/pack.mjs 生成，放在页面旁边：
 *   experiment.json   { id, total, focus }       实验编号、对数、评审时重点看什么
 *   pairs/NN.json     { a: {manifest, layers}, b: {...} }   layers 是 { 文件名: base64 }
 * A、B 各是哪种做法只写在 pack 另存的 key.json 里，不随页面发出去。流程见 docs-site/develop/index.md「双盲对比」
 */
import { HoloCard } from '../renderer/card';
import { parseManifest } from '../format/io';

interface Experiment {
  id: string;
  total: number;
  /** 评审时重点看什么，一句话，显示在页头 */
  focus?: string;
}

/**
 * A / B：这一边更好（偏好）；= 差不多；X 两边都有问题；
 * A! / B!：这一边赢，是因为对面有明显 bug。偏好和「坏了」分开记，统计时 bug 率比偏好重要得多
 */
const VOTES = ['A', '=', 'B', 'X', 'A!', 'B!'] as const;
type Vote = (typeof VOTES)[number];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const pad = (n: number): string => String(n).padStart(2, '0');

const cards = { a: new HoloCard($('card-a'), { amplitude: 0.1 }), b: new HoloCard($('card-b'), { amplitude: 0.1 }) };
let exp: Experiment = { id: 'unknown', total: 0 };
let votes: Record<string, Vote> = {};
let current = 1;
let loading = 0;

// 按实验分开存，换一次实验不会带上上一次的选择
const storageKey = (): string => `holocard-blind-${exp.id}`;
const save = (): void => {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(votes));
  } catch {
    // 隐私模式等存不了就算了，只是刷新会丢
  }
};

function toBlob(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/webp' });
}

async function open(no: number): Promise<void> {
  current = Math.min(exp.total, Math.max(1, no));
  const ticket = ++loading;
  $('no').textContent = `#${current}`;
  $('stage').classList.add('is-loading');
  paintVotes();
  try {
    const res = await fetch(`pairs/${pad(current)}.json`);
    if (!res.ok) throw new Error(`读取第 ${current} 对失败（HTTP ${res.status}）`);
    const pair = await res.json();
    if (ticket !== loading) return;
    for (const side of ['a', 'b'] as const) {
      const manifest = parseManifest(pair[side].manifest);
      const images = manifest.layers.map((layer) => toBlob(pair[side].layers[layer.file]));
      cards[side].setLayerSet({ manifest, images });
    }
    await Promise.all([cards.a.ready, cards.b.ready]);
    if (ticket !== loading) return;
    $('stage').classList.remove('is-loading');
    $('error').hidden = true;
    pose(lastPose);
  } catch (error) {
    $('error').hidden = false;
    $('error').textContent = `卡片渲染失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

// ---------- 同步姿态 ----------
// 两张卡上各盖一层透明的操作区，卡片自己收不到指针事件，姿态只由这里统一设，保证两边一模一样

let lastPose = { x: 78, y: 22 };
let manualUntil = 0;
function pose(p: { x: number; y: number }): void {
  lastPose = p;
  cards.a.setPose(p);
  cards.b.setPose(p);
}

for (const side of ['a', 'b'] as const) {
  const shield = $(`shield-${side}`);
  const follow = (e: PointerEvent): void => {
    const r = shield.getBoundingClientRect();
    manualUntil = performance.now() + 2500;
    pose({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
  };
  shield.addEventListener('pointermove', follow);
  shield.addEventListener('pointerdown', (e) => {
    shield.setPointerCapture(e.pointerId);
    follow(e);
  });
}

// 手不在卡上时两张一起慢慢摆，不用动鼠标也能对照着看
const sweep = $<HTMLInputElement>('sweep');
sweep.checked = !matchMedia('(prefers-reduced-motion: reduce)').matches;
function tick(t: number): void {
  if (sweep.checked && t > manualUntil) {
    const s = t / 1000;
    pose({ x: 50 + 42 * Math.sin(s * 0.8), y: 50 + 34 * Math.sin(s * 0.55 + 1.2) });
  }
  requestAnimationFrame(tick);
}

// ---------- 投票 ----------

const result = $<HTMLTextAreaElement>('result');
const numbers = (): number[] => Array.from({ length: exp.total }, (_, i) => i + 1);

function paintVotes(): void {
  const v = votes[current];
  for (const b of document.querySelectorAll<HTMLButtonElement>('#vote button')) {
    b.setAttribute('aria-pressed', String(b.dataset.v === v));
  }
  $('done').textContent = String(Object.keys(votes).length);
  result.value = numbers()
    .filter((n) => votes[n])
    .map((n) => `${n}${votes[n]}`)
    .join(' ');
  for (const dot of document.querySelectorAll<HTMLButtonElement>('#dots button')) {
    const n = Number(dot.dataset.no);
    dot.dataset.v = votes[n] ?? '';
    dot.setAttribute('aria-current', String(n === current));
  }
}

function vote(v: Vote): void {
  if (votes[current] === v) delete votes[current];
  else votes[current] = v;
  save();
  paintVotes();
  // 选了就跳到下一对还没评的
  if (votes[current]) {
    const next = numbers()
      .map((_, i) => ((current + i) % exp.total) + 1)
      .find((n) => !votes[n]);
    if (next) window.setTimeout(() => void open(next), 250);
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#vote button')) {
  b.addEventListener('click', () => vote(b.dataset.v as Vote));
}
$('prev').addEventListener('click', () => void open(current === 1 ? exp.total : current - 1));
$('next').addEventListener('click', () => void open(current === exp.total ? 1 : current + 1));

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
  const map: Record<string, Vote> = { '1': 'A', '2': '=', '3': 'B', '4': 'X', '5': 'B!', '6': 'A!', a: 'A', b: 'B' };
  const key = e.key.toLowerCase();
  if (map[key]) vote(map[key]);
  else if (e.key === 'ArrowLeft') $('prev').click();
  else if (e.key === 'ArrowRight') $('next').click();
});

$('copy').addEventListener('click', async () => {
  const note = $('copied');
  try {
    await navigator.clipboard.writeText(result.value);
    note.textContent = '已复制';
  } catch {
    result.select();
    note.textContent = '已选中，按复制键';
  }
  window.setTimeout(() => {
    note.textContent = '';
  }, 2500);
});

async function start(): Promise<void> {
  try {
    const res = await fetch('experiment.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    exp = (await res.json()) as Experiment;
  } catch (error) {
    $('error').hidden = false;
    $('error').textContent = `读不到实验数据 experiment.json：${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  try {
    votes = JSON.parse(localStorage.getItem(storageKey()) || '{}');
  } catch {
    votes = {};
  }
  $('total').textContent = String(exp.total);
  if (exp.focus) $('focus').textContent = exp.focus;

  const dots = $('dots');
  for (const n of numbers()) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.dataset.no = String(n);
    dot.textContent = String(n);
    dot.setAttribute('aria-label', `第 ${n} 对`);
    dot.addEventListener('click', () => void open(n));
    dots.append(dot);
  }
  requestAnimationFrame(tick);
  void open(numbers().find((n) => !votes[n]) ?? 1);
}

void start();
