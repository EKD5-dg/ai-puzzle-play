import test from 'node:test';
import assert from 'node:assert/strict';
import { frameTotals } from '../src/games/bowlingScore.ts';

const frames = (rolls) => rolls.map((r) => ({ rolls: r }));

test('全中 12 球 = 300 分', () => {
  const t = frameTotals(frames([[10], [10], [10], [10], [10], [10], [10], [10], [10], [10, 10, 10]]));
  assert.equal(t[9], 300);
  assert.equal(t[0], 30);
});

test('全补中 5+5 加第 10 局补投 = 150 分', () => {
  const t = frameTotals(frames([[5, 5], [5, 5], [5, 5], [5, 5], [5, 5], [5, 5], [5, 5], [5, 5], [5, 5], [5, 5, 5]]));
  assert.equal(t[9], 150);
});

test('全开 9+0 = 90 分', () => {
  const t = frameTotals(frames(Array.from({ length: 10 }, () => [9, 0])));
  assert.equal(t[9], 90);
  assert.equal(t[0], 9);
});

test('混合一局的逐局累计黄金表', () => {
  const t = frameTotals(
    frames([[10], [7, 3], [9, 0], [8, 2], [10], [0, 6], [10], [10], [4, 2], [10, 10, 10]]),
  );
  assert.deepEqual(t, [20, 39, 48, 68, 84, 90, 114, 130, 136, 166]);
});

test('strike 后两球补分与 open 局累计', () => {
  const t = frameTotals(frames([[10], [3, 4], [0, 0]]));
  assert.equal(t[0], 17);
  assert.equal(t[1], 24);
  assert.equal(t[2], 24);
});

test('洗沟全 0 = 0 分', () => {
  const t = frameTotals(frames(Array.from({ length: 10 }, () => [0, 0])));
  assert.equal(t[9], 0);
});

test('未完成的 strike 不给分（等待补投）', () => {
  const t = frameTotals(frames([[10], [3], []]));
  assert.equal(t[0], null);
  assert.equal(t[1], null);
});

test('第 10 局补中 + 第三投', () => {
  const t = frameTotals(frames([...Array.from({ length: 9 }, () => [0, 0]), [5, 5, 3]]));
  assert.equal(t[9], 13);
});

test('第 10 局未完成时不给分（strike 只补了一球 / spare 缺第三投）', () => {
  const strike = frameTotals(frames([...Array.from({ length: 9 }, () => [0, 0]), [10, 3]]));
  assert.equal(strike[8], 0);
  assert.equal(strike[9], null);
  const spare = frameTotals(frames([...Array.from({ length: 9 }, () => [0, 0]), [5, 5]]));
  assert.equal(spare[9], null);
});

test('少于 10 局时后续为 null', () => {
  const t = frameTotals(frames([[1, 2], [3, 4]]));
  assert.equal(t[0], 3);
  assert.equal(t[1], 10);
  assert.equal(t[2], null);
  assert.equal(t[9], null);
});
