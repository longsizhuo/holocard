/**
 * 弹簧动画
 *
 * 语义刻意与 svelte/motion 的 spring 保持一致（stiffness / damping / precision，
 * 以及 soft、hard 两种 set 方式）。参考项目 pokemon-cards-css 的手感全靠这组弹簧，
 * 语义对齐之后，它调好的参数可以原样搬过来，不用重新凭感觉试。
 *
 * 这里只负责数值积分，不自己开 rAF——由持有者统一驱动，
 * 这样一张卡上的几根弹簧可以共用一个循环、一次性写样式。
 */

export interface SpringOptions {
  /** 刚度，越大回位越快 */
  stiffness: number;
  /** 阻尼，越大越不晃 */
  damping: number;
  /** 位移和速度都小于它就判定静止 */
  precision: number;
}

export interface SpringSetOptions {
  /**
   * 软启动：把「质量」临时设成无穷大再逐渐恢复，弹簧力是慢慢加上去的。
   * true 等价于 0.5；数值表示恢复过程持续多少秒。
   * 用在松手回正上，卡片会先迟疑一下再缓缓归位，而不是立刻弹回去。
   */
  soft?: boolean | number;
  /** 直接跳到目标值，不做动画 */
  hard?: boolean;
}

export class Spring<T extends Record<string, number>> {
  stiffness: number;
  damping: number;
  precision: number;

  readonly #keys: string[];
  #value: Record<string, number>;
  #last: Record<string, number>;
  #target: Record<string, number>;

  /** 质量的倒数。0 表示无穷重（完全不受弹簧力），1 表示正常 */
  #invMass = 1;
  #invMassRecoveryPerFrame = 0;

  constructor(initial: T, options: Partial<SpringOptions> = {}) {
    this.stiffness = options.stiffness ?? 0.15;
    this.damping = options.damping ?? 0.8;
    this.precision = options.precision ?? 0.01;

    this.#keys = Object.keys(initial);
    this.#value = { ...initial };
    this.#last = { ...initial };
    this.#target = { ...initial };
  }

  get value(): T {
    return this.#value as T;
  }

  /** 当前目标值。「减少动态效果」时持有者据此直接把弹簧推到位 */
  get target(): T {
    return this.#target as T;
  }

  set(target: T, options: SpringSetOptions = {}): void {
    this.#target = { ...target };

    if (options.hard) {
      this.#value = { ...target };
      this.#last = { ...target };
      // 必须把 soft 留下的质量系数复位。松手回正用的是 { soft: 1 }，会把
      // #invMass 压到 0 再每帧恢复；如果回正途中被 setPose / 换卡打断，
      // 这里不复位就会把一个接近 0 的系数冻住，下次交互的头一秒卡片不跟手。
      this.#invMass = 1;
      this.#invMassRecoveryPerFrame = 0;
      return;
    }

    if (options.soft) {
      const seconds = options.soft === true ? 0.5 : options.soft;
      this.#invMassRecoveryPerFrame = 1 / (seconds * 60);
      this.#invMass = 0;
      // 从静止起步。质量无穷大时弹簧力和阻尼都不起作用，手上还带着速度的话
      // 会在「迟疑」的那一秒里一路滑出去——60 帧时上一段动画早就停稳了看不出来，
      // 低帧率的手机上上一段还没停稳，卡片就会冲过头转到二十几度
      this.#last = { ...this.#value };
    }
  }

  /**
   * 推进一步。dt 以「帧」为单位，即 1 表示 1/60 秒。
   * 返回 true 表示所有分量都已静止，持有者可以据此停掉循环。
   */
  tick(dt: number): boolean {
    // 只有正的 dt 才算数。dt 可能是 0（同一帧重复 tick），也可能是负的——
    // 指针事件里记的 performance.now() 会晚于 rAF 回调拿到的帧起始时间戳。
    // 写成 `dt || 1/60` 的话负数是真值，会原样用上，弹簧朝远离目标的方向走。
    const step = dt > 0 ? dt : 1 / 60;
    // 按实际经过的帧数恢复，而不是每 tick 恢复一格：低帧率下「迟疑 1 秒」不能变成迟疑好几秒
    this.#invMass = Math.min(this.#invMass + this.#invMassRecoveryPerFrame * step, 1);
    const next: Record<string, number> = {};
    let settled = true;

    for (const key of this.#keys) {
      const current = this.#value[key] ?? 0;
      const last = this.#last[key] ?? 0;
      const target = this.#target[key] ?? 0;

      const delta = target - current;
      // 速度由上一帧的位移反推，不单独存
      const velocity = (current - last) / step;
      const acceleration = (this.stiffness * delta - this.damping * velocity) * this.#invMass;
      const d = (velocity + acceleration) * step;

      if (Math.abs(d) < this.precision && Math.abs(delta) < this.precision) {
        next[key] = target;
      } else {
        settled = false;
        next[key] = current + d;
      }
    }

    this.#last = this.#value;
    this.#value = next;
    return settled;
  }
}
