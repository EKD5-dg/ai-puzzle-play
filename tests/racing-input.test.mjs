import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accelHeld,
  brakeHeld,
  createRacingHold,
  setKeyHold,
  setTouchHold,
  steerAxis,
} from '../src/games/racingInput.ts';

test('双指按同一方向键：松开一根仍有转向', () => {
  const h = createRacingHold();
  setTouchHold(h, 'left', 11, true);
  setTouchHold(h, 'left', 12, true);
  assert.equal(steerAxis(h), -1);
  setTouchHold(h, 'left', 11, false);
  assert.equal(steerAxis(h), -1); // 第二根手指仍按着
  setTouchHold(h, 'left', 12, false);
  assert.equal(steerAxis(h), 0);
});

test('键盘与触屏同向叠加，松开一路不打断另一路', () => {
  const h = createRacingHold();
  setKeyHold(h, 'right', 'KeyD', true);
  setTouchHold(h, 'right', 7, true);
  assert.equal(steerAxis(h), 1);
  setKeyHold(h, 'right', 'KeyD', false);
  assert.equal(steerAxis(h), 1);
  setTouchHold(h, 'right', 7, false);
  assert.equal(steerAxis(h), 0);
});

test('左右同时按住回正，松开一侧恢复另一侧', () => {
  const h = createRacingHold();
  setKeyHold(h, 'left', 'ArrowLeft', true);
  setTouchHold(h, 'right', 3, true);
  assert.equal(steerAxis(h), 0);
  setKeyHold(h, 'left', 'ArrowLeft', false);
  assert.equal(steerAxis(h), 1);
});

test('油门/刹车同样按 pointerId 与键位计数', () => {
  const h = createRacingHold();
  setTouchHold(h, 'accel', 1, true);
  setTouchHold(h, 'accel', 2, true);
  setKeyHold(h, 'accel', 'KeyW', true);
  assert.equal(accelHeld(h), true);
  setTouchHold(h, 'accel', 1, false);
  setTouchHold(h, 'accel', 2, false);
  assert.equal(accelHeld(h), true); // 键盘仍按住
  setKeyHold(h, 'accel', 'KeyW', false);
  assert.equal(accelHeld(h), false);

  setTouchHold(h, 'brake', 5, true);
  assert.equal(brakeHeld(h), true);
  setTouchHold(h, 'brake', 5, false);
  assert.equal(brakeHeld(h), false);
});
