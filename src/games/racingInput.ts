/**
 * 赛车输入按住状态：键盘与触屏都可能有多个来源同时按住同一方向。
 * 用集合而不是布尔值记录，松开其中一个来源时不会把另一个仍按住的方向也清掉。
 */

export interface RacingHold {
  leftKeys: Set<string>;
  rightKeys: Set<string>;
  accelKeys: Set<string>;
  brakeKeys: Set<string>;
  leftTouches: Set<number>;
  rightTouches: Set<number>;
  accelTouches: Set<number>;
  brakeTouches: Set<number>;
}

export const createRacingHold = (): RacingHold => ({
  leftKeys: new Set(),
  rightKeys: new Set(),
  accelKeys: new Set(),
  brakeKeys: new Set(),
  leftTouches: new Set(),
  rightTouches: new Set(),
  accelTouches: new Set(),
  brakeTouches: new Set(),
});

export type HoldControl = 'left' | 'right' | 'accel' | 'brake';

export function steerAxis(h: RacingHold): -1 | 0 | 1 {
  const left = h.leftKeys.size > 0 || h.leftTouches.size > 0;
  const right = h.rightKeys.size > 0 || h.rightTouches.size > 0;
  const v = (right ? 1 : 0) - (left ? 1 : 0);
  return v as -1 | 0 | 1;
}

export const accelHeld = (h: RacingHold) => h.accelKeys.size > 0 || h.accelTouches.size > 0;
export const brakeHeld = (h: RacingHold) => h.brakeKeys.size > 0 || h.brakeTouches.size > 0;

function pick(h: RacingHold, ctrl: HoldControl, touch: boolean): Set<string> | Set<number> {
  if (touch) {
    if (ctrl === 'left') return h.leftTouches;
    if (ctrl === 'right') return h.rightTouches;
    if (ctrl === 'accel') return h.accelTouches;
    return h.brakeTouches;
  }
  if (ctrl === 'left') return h.leftKeys;
  if (ctrl === 'right') return h.rightKeys;
  if (ctrl === 'accel') return h.accelKeys;
  return h.brakeKeys;
}

export function setKeyHold(h: RacingHold, ctrl: HoldControl, code: string, on: boolean): void {
  const set = pick(h, ctrl, false) as Set<string>;
  if (on) set.add(code);
  else set.delete(code);
}

export function setTouchHold(h: RacingHold, ctrl: HoldControl, pointerId: number, on: boolean): void {
  const set = pick(h, ctrl, true) as Set<number>;
  if (on) set.add(pointerId);
  else set.delete(pointerId);
}
