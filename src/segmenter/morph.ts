/**
 * 分层用到的几个栅格运算：深度边缘吸附、二值膨胀、最近源点传播、alpha 抗锯齿。
 * 全是纯函数，不碰 DOM，方便单独验证。
 */

/** 可分离的方窗最小/最大值滤波，窗口边长 2r+1 */
function minMaxFilter(
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
): { min: Float32Array; max: Float32Array } {
  const count = width * height;
  const rowMin = new Float32Array(count);
  const rowMax = new Float32Array(count);

  // 方窗的最值可以拆成先横后竖两趟，复杂度从 O(r²) 降到 O(r)
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = x0; k <= x1; k++) {
        const v = src[base + k] ?? 0;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      rowMin[base + x] = lo;
      rowMax[base + x] = hi;
    }
  }

  const min = new Float32Array(count);
  const max = new Float32Array(count);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = y0; k <= y1; k++) {
        const a = rowMin[k * width + x] ?? 0;
        const b = rowMax[k * width + x] ?? 0;
        if (a < lo) lo = a;
        if (b > hi) hi = b;
      }
      min[y * width + x] = lo;
      max[y * width + x] = hi;
    }
  }
  return { min, max };
}

/**
 * 深度边缘吸附（形态学 toggle mapping）。
 *
 * 单目深度图在物体边缘不是台阶而是一段斜坡：从前景深度平滑滑到背景深度。
 * 斜坡中段的深度值会恰好落进「中间层」的区间，于是物体轮廓外凭空多出一圈
 * 被分进中间层的细环。三层视差系数不同，一动起来这圈环就和物体分离成鬼影。
 *
 * 做法：看每个像素邻域内的最小、最大深度。落差够大说明这里是遮挡边界，
 * 就把像素吸附到离它更近的那一端，斜坡被压成台阶，中间值不复存在。
 * 落差小的地方（地面这类平缓延展面）原样保留——那里需要的恰恰是平滑过渡。
 */
export function snapDepthEdges(
  depth: Float32Array,
  width: number,
  height: number,
  radius: number,
  threshold: number,
  iterations = 2,
): Float32Array {
  let current = depth;
  // 斜坡比窗口宽时，一趟只能压成几级台阶；再来一趟把残余的台阶也吸掉
  for (let pass = 0; pass < iterations; pass++) {
    const { min, max } = minMaxFilter(current, width, height, radius);
    const out = new Float32Array(current.length);
    for (let i = 0; i < current.length; i++) {
      const d = current[i] ?? 0;
      const lo = min[i] ?? d;
      const hi = max[i] ?? d;
      out[i] = hi - lo > threshold ? (d - lo < hi - d ? lo : hi) : d;
    }
    current = out;
  }
  return current;
}

/**
 * 前景膨胀：让更近的区域向外长 radius 个像素（对视差图做灰度膨胀，值越大越近）。
 *
 * 深度图给出的边界和物体的真实边缘总有几个像素的出入，而且往往是往物体里面缩。
 * 缩进去的那一圈会被分到后面的层：物体一挪开，它自己的边就留在了原地。
 * 让前景统一往外长一点，物体的边缘就永远跟着物体走；代价只是顺带捎上一丝背景，
 * 这一丝背景跟着前景一起动，肉眼看不出来。3D 照片类流水线普遍这么处理。
 */
export function growForeground(
  depth: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  if (radius <= 0) return depth;
  return minMaxFilter(depth, width, height, radius).max;
}

/** 二值掩码膨胀，方形结构元，边长 2r+1 */
export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) return mask.slice();

  const rows = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      let hit = 0;
      for (let k = x0; k <= x1 && hit === 0; k++) hit = mask[base + k] ?? 0;
      rows[base + x] = hit;
    }
  }

  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      let hit = 0;
      for (let k = y0; k <= y1 && hit === 0; k++) hit = rows[k * width + x] ?? 0;
      out[y * width + x] = hit;
    }
  }
  return out;
}

export interface NearestSource {
  /** 到最近源像素的偏移，源像素自身为 0。找不到任何源时保持为一个很大的值 */
  dx: Int16Array;
  dy: Int16Array;
}

/**
 * 最近源点传播（8SSEDT）：给每个像素算出「离它最近的源像素在哪」。
 *
 * 两趟光栅扫描，每个像素从已处理的邻居那里继承最近源并比较距离。
 * 结果是近似欧氏最近点，对补洞和层归属判断足够准，复杂度 O(n)。
 */
export function nearestSource(isSource: Uint8Array, width: number, height: number): NearestSource {
  const FAR = 16384;
  const count = width * height;
  const dx = new Int16Array(count).fill(FAR);
  const dy = new Int16Array(count).fill(FAR);
  for (let i = 0; i < count; i++) {
    if (isSource[i]) {
      dx[i] = 0;
      dy[i] = 0;
    }
  }

  // 用邻居 (x+ox, y+oy) 已知的最近源来更新当前像素
  const relax = (i: number, x: number, y: number, ox: number, oy: number): void => {
    const nx = x + ox;
    const ny = y + oy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
    const j = ny * width + nx;
    const ndx = dx[j] ?? FAR;
    if (ndx >= FAR) return; // 邻居自己都还没找到源
    // 邻居到源的偏移 + 我到邻居的一步 = 我到源的偏移
    const cx = ndx + ox;
    const cy = (dy[j] ?? FAR) + oy;
    const mx = dx[i] ?? FAR;
    const my = dy[i] ?? FAR;
    if (cx * cx + cy * cy < mx * mx + my * my) {
      dx[i] = cx;
      dy[i] = cy;
    }
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      relax(i, x, y, -1, 0);
      relax(i, x, y, 0, -1);
      relax(i, x, y, -1, -1);
      relax(i, x, y, 1, -1);
    }
    for (let x = width - 1; x >= 0; x--) {
      relax(y * width + x, x, y, 1, 0);
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      relax(i, x, y, 1, 0);
      relax(i, x, y, 0, 1);
      relax(i, x, y, -1, 1);
      relax(i, x, y, 1, 1);
    }
    for (let x = 0; x < width; x++) {
      relax(y * width + x, x, y, -1, 0);
    }
  }

  return { dx, dy };
}

/** 3×3 方框模糊。深度吸附之后层边缘是硬台阶，用它补回一点抗锯齿 */
export function blurAlpha(alpha: Float32Array, width: number, height: number): Float32Array {
  const rows = new Float32Array(alpha.length);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      const l = alpha[base + Math.max(0, x - 1)] ?? 0;
      const c = alpha[base + x] ?? 0;
      const r = alpha[base + Math.min(width - 1, x + 1)] ?? 0;
      rows[base + x] = (l + c + r) / 3;
    }
  }
  const out = new Float32Array(alpha.length);
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width;
    const mid = y * width;
    const down = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x++) {
      out[mid + x] = ((rows[up + x] ?? 0) + (rows[mid + x] ?? 0) + (rows[down + x] ?? 0)) / 3;
    }
  }
  return out;
}
