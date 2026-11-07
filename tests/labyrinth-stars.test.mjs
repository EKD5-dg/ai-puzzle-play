import test from 'node:test';
import assert from 'node:assert/strict';
import { clampStars, starId, starKey } from '../src/games/labyrinth3d/stars.ts';

// 与服务端 functions/api/sync.js 的 GAME_ID_RE 保持一致
const GAME_ID_RE = /^[a-z0-9-]{1,40}(:[a-z0-9-]{1,20})?$/;

test('云端 id 与本地 key 分开：云端不能带 best: 前缀', () => {
  const id = starId('labyrinth-3d', 'l1');
  const key = starKey('labyrinth-3d', 'l1');
  assert.equal(id, 'labyrinth-3d:star-l1');
  assert.equal(key, 'best:labyrinth-3d:star-l1');
  assert.match(id, GAME_ID_RE, '云端 id 必须匹配服务端 gameId 正则（只允许一个冒号）');
  assert.doesNotMatch(id, /^best:/);
});

test('星级夹到 0..3，脏值不参与渲染', () => {
  assert.equal(clampStars(0), 0);
  assert.equal(clampStars(2), 2);
  assert.equal(clampStars(3), 3);
  assert.equal(clampStars(4), 3);
  assert.equal(clampStars(3.9), 3);
  assert.equal(clampStars(-1), 0);
  assert.equal(clampStars(NaN), 0);
  assert.equal(clampStars('3'), 0);
  assert.equal(clampStars(null), 0);
});
