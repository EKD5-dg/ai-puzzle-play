import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RACING_LANES,
  RACING_LANE_GAP,
  applyCarFollowing,
  isSceneryVisible,
  nearestLaneIndex,
  pickFreeLaneIndex,
} from '../src/games/racingCore.ts';

const CAR_LEN = 105;
const WINDOW = CAR_LEN * 2.6;

test('空路或单车时只会挑未被占用的车道', () => {
  for (let i = 0; i < 30; i++) {
    const idx = pickFreeLaneIndex([], 0, null, WINDOW);
    assert.ok(idx !== null && idx >= 0 && idx < RACING_LANES.length);
  }
  const cars = [{ offset: RACING_LANES[0], z: 100 }];
  for (let i = 0; i < 30; i++) assert.notEqual(pickFreeLaneIndex(cars, 100, null, WINDOW), 0);
});

test('三条车道都被占用时返回 null，而不是硬塞', () => {
  const cars = RACING_LANES.map((offset) => ({ offset, z: 500 }));
  assert.equal(pickFreeLaneIndex(cars, 500, null, WINDOW), null);
  // 超出重叠窗口的车不算占用
  const far = RACING_LANES.map((offset) => ({ offset, z: 500 + WINDOW + 1 }));
  assert.notEqual(pickFreeLaneIndex(far, 500, null, WINDOW), null);
});

test('exclude 让即将回归的车不算自己占道', () => {
  const self = { offset: RACING_LANES[1], z: 300 };
  const cars = [self, { offset: RACING_LANES[0], z: 300 }, { offset: RACING_LANES[2], z: 300 }];
  const idx = pickFreeLaneIndex(cars, 300, self, WINDOW);
  assert.equal(idx, 1); // 两侧都被占，只有自己所在的中间道可用
});

test('带抖动的 offset 仍归到最近车道', () => {
  assert.equal(RACING_LANE_GAP, 0.62);
  assert.equal(nearestLaneIndex(-0.62), 0);
  assert.equal(nearestLaneIndex(0.0), 1);
  assert.equal(nearestLaneIndex(0.62), 2);
  assert.equal(nearestLaneIndex(-0.55), 0);
  assert.equal(nearestLaneIndex(0.55), 2);
  // 抖动不超过 ±0.06，单侧不会跨过中线
  for (const base of RACING_LANES) {
    for (const d of [-0.06, 0.06]) {
      assert.equal(nearestLaneIndex(base + d), RACING_LANES.indexOf(base));
    }
  }
});

test('跟车按空间顺序解析：数组顺序相反也不会穿模', () => {
  const front = { offset: 0, z: 2000, speed: 1000, cruise: 1000 };
  const middle = { offset: 0, z: 1500, speed: 2000, cruise: 2000 };
  const rear = { offset: 0, z: 1000, speed: 3000, cruise: 3000 };
  // 后→前排列：旧实现先处理后车，会读到中车的巡航速度
  const cars = [rear, middle, front];
  applyCarFollowing(cars, CAR_LEN * 8);
  assert.ok(rear.speed <= middle.speed + 1e-9);
  assert.ok(middle.speed <= front.speed + 1e-9);
  assert.equal(front.speed, 1000);
  assert.equal(middle.speed, 1000);
  assert.equal(rear.speed, 1000);
});

test('换景物窗口按环回绕，窗口内的段不得立刻刷新', () => {
  const total = 100;
  const draw = 20;
  assert.equal(isSceneryVisible(10, 0, total, draw), true);
  assert.equal(isSceneryVisible(19, 0, total, draw), true);
  assert.equal(isSceneryVisible(20, 0, total, draw), false);
  assert.equal(isSceneryVisible(99, 90, total, draw), true);
  assert.equal(isSceneryVisible(9, 90, total, draw), true);
  assert.equal(isSceneryVisible(10, 90, total, draw), false); // 刚出窗口
  assert.equal(isSceneryVisible(89, 90, total, draw), false);
});

test('不同车道互不影响，前车离开后恢复巡航', () => {
  const a = { offset: RACING_LANES[0], z: 1000, speed: 1000, cruise: 1000 };
  const b = { offset: RACING_LANES[2], z: 1100, speed: 3000, cruise: 3000 };
  applyCarFollowing([a, b], CAR_LEN * 8);
  assert.equal(b.speed, 3000); // 不同车道不跟车

  const rear = { offset: RACING_LANES[0], z: 800, speed: 500, cruise: 2500 };
  applyCarFollowing([a, rear], CAR_LEN * 8);
  assert.equal(rear.speed, 1000); // 被前车压速
  applyCarFollowing([rear], CAR_LEN * 8);
  assert.equal(rear.speed, 2500); // 前车移走后恢复巡航
});
