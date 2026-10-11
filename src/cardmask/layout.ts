/**
 * 版式先验：游戏卡上各类东西的位置大致固定，拿位置来分文字、约束主角。
 *
 *   有画框的卡（宝可梦普通卡、万智牌、游戏王）  画框上面是名字栏，下面是招式说明，最底下一行是编号、版权
 *   全图卡（宝可梦 V、VMAX、VSTAR）            内板上面是名字栏，内板下半截是压在画上的招式说明，内板下面是弱点栏
 *   都没找到                                  按「上图下文」的通例：顶上一条是名字栏，最底下一条是版权
 *
 * 这些只在认得出版式（找到画框或内板）时才靠得住，所以认不出时只用最宽松的那条通例。
 * 坐标都按卡图宽高归一化到 0..1
 */

import type { Box } from './frame';

/**
 * 一行字在卡上的角色：
 *   name    名字栏左边（名字、进化阶段）     hp      名字栏右边（HP、属性）
 *   body    招式、效果说明                  footer  最底下的弱点栏、编号、版权
 *   art     画里的字（标志、插画里的文字），以及位置说不清的
 */
export type TextRole = 'name' | 'hp' | 'body' | 'footer' | 'art';

export interface TextLine extends Box {
  role: TextRole;
}

/** 名字栏的下沿：没有画框、内板可参照时，按卡高这么多算 */
const TITLE_BOTTOM = 0.12;
/** 名字栏里中心在这条线左边的算名字，右边的算 HP */
const NAME_RIGHT = 0.6;
/** 中心低于这条线的算最底下的编号、版权（有内板时看内板下沿） */
const FOOTER_TOP = 0.9;
/** 全图卡的招式说明不会比这更靠上（按卡高） */
const BODY_MIN_Y = 0.45;
/** 太小的连通块不算一行字（占卡宽），是检测器在画里的零星误报 */
const MIN_LINE_WIDTH = 0.02;
/** 上下差不多高、左右挨得近（占卡宽）的块并成一行 */
const JOIN_GAP = 0.02;

/**
 * 文字遮罩里的连通块，横向挨着的并成一行，再按位置定角色。
 * 不在原图尺寸上找连通块：按 step 抽样，一张 1400 宽的卡只看三四十万个点
 */
export function textLines(mask: Uint8Array, width: number, height: number, layout: { window: Box | null; panel: Box | null }): TextLine[] {
  const step = Math.max(1, Math.round(width / 400));
  const gw = Math.ceil(width / step);
  const gh = Math.ceil(height / step);
  const grid = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) grid[y * gw + x] = (mask[y * step * width + x * step] ?? 0) > 127 ? 1 : 0;

  const seen = new Uint8Array(gw * gh);
  const boxes: Box[] = [];
  for (let start = 0; start < grid.length; start++) {
    if (!grid[start] || seen[start]) continue;
    let x0 = gw, y0 = gh, x1 = -1, y1 = -1;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % gw;
      const y = (p - x) / gw;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const q of [p - 1, p + 1, p - gw, p + gw]) {
        if (q < 0 || q >= grid.length || seen[q] || !grid[q]) continue;
        if (Math.abs((q % gw) - x) > 1) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    boxes.push({ x: x0 / gw, y: y0 / gh, w: (x1 - x0 + 1) / gw, h: (y1 - y0 + 1) / gh });
  }

  // 同一行的字常被检测成几段（招式名和伤害数字之间空着一大截），竖直方向大半重叠、横向挨着的并起来
  boxes.sort((a, b) => a.x - b.x);
  const lines: Box[] = [];
  for (const b of boxes) {
    const prev = lines.find((l) => {
      const overlap = Math.min(l.y + l.h, b.y + b.h) - Math.max(l.y, b.y);
      return overlap > 0.5 * Math.min(l.h, b.h) && b.x - (l.x + l.w) < JOIN_GAP;
    });
    if (prev) {
      const x1 = Math.max(prev.x + prev.w, b.x + b.w);
      const y1 = Math.max(prev.y + prev.h, b.y + b.h);
      prev.y = Math.min(prev.y, b.y);
      prev.w = x1 - prev.x;
      prev.h = y1 - prev.y;
    } else {
      lines.push({ ...b });
    }
  }

  return lines.filter((l) => l.w >= MIN_LINE_WIDTH).map((l) => ({ ...l, role: roleOf(l, layout) }));
}

function roleOf(line: Box, { window, panel }: { window: Box | null; panel: Box | null }): TextRole {
  const cx = line.x + line.w / 2;
  const cy = line.y + line.h / 2;
  const titleBottom = (window ?? panel)?.y ?? TITLE_BOTTOM;
  if (cy < titleBottom) return cx < NAME_RIGHT ? 'name' : 'hp';
  if (window) {
    if (cy < window.y + window.h) return 'art';
    return cy > FOOTER_TOP ? 'footer' : 'body';
  }
  const footerTop = panel ? panel.y + panel.h : FOOTER_TOP;
  if (cy > footerTop) return 'footer';
  // 全图卡上，招式说明从卡的下半截开始；上半截的「字」是画里的
  return cy > BODY_MIN_Y ? 'body' : 'art';
}

/** 招式说明区的上沿：最靠上的一行 body 字。没有就是 null */
export function bodyTop(lines: TextLine[]): number | null {
  let top: number | null = null;
  for (const l of lines) if (l.role === 'body' && (top === null || l.y < top)) top = l.y;
  return top;
}
