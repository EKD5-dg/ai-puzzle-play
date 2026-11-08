import test from 'node:test';
import assert from 'node:assert/strict';
import { cuePocketClearance, isCueSpotSafe, safeHandSpot } from '../src/games/poolRules.ts';

// 与 Pool3D 一致的台面/袋口尺寸
const HX = 4.3;
const HZ = 2.15;
const BALL_R = 0.155;
const POCKET_R = 0.32;
const POCKETS = [
  [-HX + 0.12, -HZ + 0.12],
  [HX - 0.12, -HZ + 0.12],
  [-HX + 0.12, HZ - 0.12],
  [HX - 0.12, HZ - 0.12],
  [0, -HZ + 0.06],
  [0, HZ - 0.06],
];
const bounds = (maxX = HX - BALL_R - 0.05) => ({
  minX: -HX + BALL_R + 0.05,
  maxX,
  minZ: -HZ + BALL_R + 0.05,
  maxZ: HZ - BALL_R - 0.05,
  pocketR: POCKET_R,
  ballR: BALL_R,
  pockets: POCKETS,
});

const distToPockets = (x, z) => Math.min(...POCKETS.map(([px, pz]) => Math.hypot(x - px, z - pz)));

test('自由球不能落在袋口捕获圈内', () => {
  const b = bounds();
  const clear = cuePocketClearance(POCKET_R, BALL_R);
  assert.ok(clear > POCKET_R, '安全距离必须大于袋口捕获半径');
  assert.equal(isCueSpotSafe(0, 0, b), true);
  for (const [px, pz] of POCKETS) assert.equal(isCueSpotSafe(px, pz, b), false);
});

test('指针钳到台角袋口时会被挪到最近的安全点', () => {
  const b = bounds();
  const clear = cuePocketClearance(POCKET_R, BALL_R);
  const [x, z] = safeHandSpot(-999, -999, b);
  assert.ok(x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ);
  assert.ok(distToPockets(x, z) >= clear - 1e-9);
  assert.ok(isCueSpotSafe(x, z, b));
});

test('全台自由球：右侧袋口边界同样安全，开球线限制仍生效', () => {
  const full = bounds();
  const [fx, fz] = safeHandSpot(999, 999, full);
  assert.ok(isCueSpotSafe(fx, fz, full));
  assert.ok(distToPockets(fx, fz) >= cuePocketClearance(POCKET_R, BALL_R) - 1e-9);

  const breakBounds = bounds(-HX * 0.45);
  const [bx, bz] = safeHandSpot(0, 0, breakBounds);
  assert.ok(bx <= -HX * 0.45 + 1e-9, `开球犯规自由球不得越过开球线，实测 ${bx}`);
  assert.ok(isCueSpotSafe(bx, bz, breakBounds));
});

test('普通钳制与安全区内目标点保持不变', () => {
  const b = bounds();
  const [x, z] = safeHandSpot(2.5, 1.0, b);
  assert.ok(Math.abs(x - 2.5) < 1e-9);
  assert.ok(Math.abs(z - 1.0) < 1e-9);
});
