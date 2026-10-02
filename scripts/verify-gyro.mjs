/**
 * 验证陀螺仪的自动回正（src/renderer/gyro.ts）
 *
 * 没有回正的话，基准就是第一次读数，用户换个姿势拿手机，卡片就永远歪着。这里核对：
 *   - 转一下手机，指针跟着偏过去
 *   - 停在那个角度不动，几秒内回到死区（卡片回正）
 *   - 慢慢转、一直转（模拟传感器漂移），偏转不会无限累积
 *   - 翻过竖直位置时读数整段跳变，直接当新基准，不会一下甩到头
 *   - 横屏时左右、前后对调
 *
 * 用法：node scripts/verify-gyro.mjs（Node 22.6+，直接吃 .ts）
 */

import assert from 'node:assert/strict';
import { DEADZONE_DEGREES, TiltTracker } from '../src/renderer/gyro.ts';

const DT = 1 / 60;

// 转一下：右倾 8° → 指针偏右
let t = new TiltTracker();
t.update(30, 0, 0, DT);
let r = t.update(30, 8, 0, DT);
assert.ok(r.x > 70 && Math.abs(r.y - 50) < 1, `右倾应当指针偏右：${JSON.stringify(r)}`);

// 停着不动 6 秒 → 回到死区
for (let i = 0; i < 6 * 60; i++) r = t.update(30, 8, 0, DT);
assert.ok(Math.hypot(r.dx, r.dy) < DEADZONE_DEGREES, `停住后应当回正：${JSON.stringify(r)}`);

// 漂移：每秒 3° 一直转 60 秒，偏转稳定在 速度 × 时间常数 附近，不累积
t = new TiltTracker();
let maxDx = 0;
for (let i = 0; i <= 60 * 60; i++) {
  r = t.update(30, -60 + (i * DT * 3) % 120, 0, DT);
  if (i > 60) maxDx = Math.max(maxDx, Math.abs(r.dx));
}
assert.ok(maxDx < 8, `漂移不该累积，最大偏转 ${maxDx.toFixed(2)}°`);

// 跳变：gamma 从 85 跳到 -85 → 当新基准，不甩
t = new TiltTracker();
t.update(80, 85, 0, DT);
r = t.update(80, -85, 0, DT);
assert.equal(r.x, 50, '跳变应当重置基准');

// 横屏 90°：beta 变成左右
t = new TiltTracker();
t.update(0, 0, 90, DT);
r = t.update(8, 0, 90, DT);
assert.ok(r.x > 70 && Math.abs(r.y - 50) < 1, `横屏应当对调轴：${JSON.stringify(r)}`);

console.log('gyro ok');
