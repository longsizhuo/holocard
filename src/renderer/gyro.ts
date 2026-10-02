/**
 * 陀螺仪 → 卡面指针位置
 *
 * 映射的量程沿用 pokemon-cards-css 的 orientation 版本（左右 ±16°、前后 ±18° 转到头），
 * 方向和上游相反：上游是手机往右倾、卡片往左转（把手机的倾斜抵消掉），真机上手感是反的；
 * 这里卡片跟着手机同向转，像手里那张卡真的被拿着转了一下。
 * 上游的基准姿态是第一次读数、之后再也不动——用户换个姿势拿手机，卡片就永远歪着回不来。
 * 这里的基准会缓慢跟着当前姿态走：一直拿着不动，卡片几秒内自己回正；
 * 转一下手机，转动的那一下才有效果。
 *
 * 纯计算，不碰 DOM，scripts/verify-gyro.mjs 直接跑它。
 */

/** 左右倾斜多少度时指针到卡面边缘 */
const LIMIT_X = 16;
/** 前后倾斜多少度时指针到卡面边缘 */
const LIMIT_Y = 18;
/**
 * 基准跟随的时间常数，秒。越小回正越快，但转过去停着欣赏时效果也褪得越快。
 * ponytail: 定值；真机上手感不对就调这一个数
 */
const RECENTER_SECONDS = 3;
/** 和基准差这么多度以上视为读数跳变（手机翻过竖直位置时 beta / gamma 会整段跳），直接重置基准 */
const JUMP_DEGREES = 60;
/** 和基准差不到这么多度就当没动，让卡片回正、动画循环停下来，不然拿着手机就一直在 60 帧重绘 */
export const DEADZONE_DEGREES = 1;

/** 两个角度之差，绕到 (-180, 180] */
function angleDelta(a: number, b: number): number {
  const d = (((a - b) % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

/**
 * 设备坐标的 beta / gamma 换成屏幕坐标：横屏时左右、前后对调。
 * screenAngle 取 screen.orientation.angle（0 / 90 / 180 / 270）
 */
function toScreen(beta: number, gamma: number, screenAngle: number): [number, number] {
  switch (((screenAngle % 360) + 360) % 360) {
    case 90:
      return [beta, -gamma];
    case 180:
      return [-gamma, -beta];
    case 270:
      return [-beta, gamma];
    default:
      return [gamma, beta];
  }
}

export class TiltTracker {
  #base: [number, number] | null = null;

  /** 下一次读数直接当基准（切回前台、换卡时用） */
  reset(): void {
    this.#base = null;
  }

  /**
   * 喂一次读数，返回相对基准的偏转（度，屏幕坐标），以及换算成的指针位置（0..100）。
   * dtSeconds 是距上一次读数的时间。
   */
  update(
    beta: number,
    gamma: number,
    screenAngle: number,
    dtSeconds: number,
  ): { dx: number; dy: number; x: number; y: number } {
    const [sx, sy] = toScreen(beta, gamma, screenAngle);
    const base = this.#base;
    let dx = base ? angleDelta(sx, base[0]) : 0;
    let dy = base ? angleDelta(sy, base[1]) : 0;

    if (!base || Math.abs(dx) > JUMP_DEGREES || Math.abs(dy) > JUMP_DEGREES) {
      this.#base = [sx, sy];
      dx = 0;
      dy = 0;
    } else {
      // 指数跟随，按实际时间算，事件频率不同的手机回正速度一样
      const k = 1 - Math.exp(-Math.max(0, dtSeconds) / RECENTER_SECONDS);
      base[0] += dx * k;
      base[1] += dy * k;
    }

    const clamp = (v: number): number => Math.min(Math.max(v, -1), 1);
    return {
      dx,
      dy,
      x: 50 - clamp(dx / LIMIT_X) * 50,
      y: 50 - clamp(dy / LIMIT_Y) * 50,
    };
  }
}
