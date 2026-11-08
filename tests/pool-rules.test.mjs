import test from 'node:test';
import assert from 'node:assert/strict';
import { cuePocketClearance, isCueSpotSafe, resolveCueSpot, safeHandSpot } from '../src/games/poolRules.ts';

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

test('resolveCueSpot 推开压住的球，且落点仍避开袋口', () => {
  const b = bounds();
  const ball = { id: 1, x: 0, z: 0, pocketed: false };
  const [x, z] = resolveCueSpot(0, 0, b, [ball], [-HX * 0.55, 0]);
  assert.ok(Math.hypot(x - ball.x, z - ball.z) >= BALL_R * 2 + 0.02 - 1e-9);
  assert.ok(isCueSpotSafe(x, z, b));
});

test('袋口边压球时落点应靠近点击处，而不是瞬移到默认点', () => {
  const b = bounds();
  const ball = { id: 1, x: 0, z: 1.72, pocketed: false };
  const click = { x: 0, z: 1.9 };
  const [x, z] = resolveCueSpot(click.x, click.z, b, [ball], [-HX * 0.55, 0]);
  assert.ok(Math.hypot(x - ball.x, z - ball.z) >= BALL_R * 2 + 0.02 - 1e-9);
  assert.ok(isCueSpotSafe(x, z, b));
  const moved = Math.hypot(x - click.x, z - click.z);
  assert.ok(moved < 1.0, `落点应靠近点击处，实测偏移 ${moved.toFixed(2)}`);
});

test('球群围住目标点时最终落点不压球、不入袋', () => {
  const b = bounds();
  const balls = [
    { id: 1, x: 0, z: 0.33, pocketed: false },
    { id: 2, x: 0, z: -0.33, pocketed: false },
    { id: 3, x: 0.33, z: 0, pocketed: false },
    { id: 4, x: -0.33, z: 0, pocketed: false },
    { id: 5, x: 0, z: 0, pocketed: false },
  ];
  const [x, z] = resolveCueSpot(0, 0, b, balls, [-HX * 0.55, 0]);
  assert.ok(isCueSpotSafe(x, z, b));
  for (const o of balls) {
    assert.ok(Math.hypot(x - o.x, z - o.z) >= BALL_R * 2 + 0.02 - 1e-9, `压住了 ${o.id} 号球`);
  }
});
