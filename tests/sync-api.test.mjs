import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost } from '../functions/api/sync.js';

function makeKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async list({ prefix = '' } = {}) {
      return {
        keys: [...store.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((name) => ({ name })),
      };
    },
  };
}

function post(body) {
  return new Request('https://example.test/api/sync', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

test('成绩按方向合并：越大取 max，越小取 min', async () => {
  const env = { SYNC_KV: makeKV() };
  await onRequestPost({ request: post({ code: 'ABC123', scores: { 'game-2048': 100, 'minesweeper:0': 60 } }), env });
  await onRequestPost({ request: post({ code: 'ABC123', scores: { 'game-2048': 80, 'minesweeper:0': 40 } }), env });
  assert.equal(env.SYNC_KV.store.get('score:ABC123:game-2048'), '100');
  assert.equal(env.SYNC_KV.store.get('score:ABC123:minesweeper:0'), '40');
});

test('0/负数/非数字成绩被忽略', async () => {
  const env = { SYNC_KV: makeKV() };
  await onRequestPost({
    request: post({ code: 'ABC123', scores: { 'minesweeper:0': 0, 'game-2048': -5, 'snake': '12' } }),
    env,
  });
  assert.equal(env.SYNC_KV.store.size, 0);
});

test('null/数组 body 返回 400 而不是 500', async () => {
  const env = { SYNC_KV: makeKV() };
  const res = await onRequestPost({ request: post('null'), env });
  assert.equal(res.status, 400);
});

test('DQ 脏存档被忽略，成绩仍落库', async () => {
  const env = { SYNC_KV: makeKV() };
  const dq = {
    floor: 999,
    player: { level: 1, xp: 1e308, hp: 1e308, maxHp: 1e308, mp: -1, maxMp: 1e9, atk: -1, def: 1e9, gold: 1e308, kills: -1 },
  };
  const res = await onRequestPost({
    request: post({ code: 'ABC123', scores: { 'game-2048': 100 }, progress: { dqSave: dq } }),
    env,
  });
  assert.equal(res.status, 200);
  assert.equal(env.SYNC_KV.store.get('score:ABC123:game-2048'), '100');
  assert.equal(env.SYNC_KV.store.has('progress:ABC123'), false);
});

test('DQ 同层同级按 xp 取更优，差档不覆盖', async () => {
  const env = { SYNC_KV: makeKV() };
  const base = {
    floor: 5,
    player: { level: 7, xp: 10, hp: 40, maxHp: 120, mp: 5, maxMp: 25, atk: 20, def: 10, gold: 100, kills: 12 },
  };
  await onRequestPost({ request: post({ code: 'ABC123', progress: { dqSave: base } }), env });
  await onRequestPost({
    request: post({ code: 'ABC123', progress: { dqSave: { ...base, player: { ...base.player, xp: 50 } } } }),
    env,
  });
  assert.equal(JSON.parse(env.SYNC_KV.store.get('progress:ABC123')).dqSave.player.xp, 50);
  await onRequestPost({
    request: post({ code: 'ABC123', progress: { dqSave: { ...base, player: { ...base.player, xp: 5 } } } }),
    env,
  });
  assert.equal(JSON.parse(env.SYNC_KV.store.get('progress:ABC123')).dqSave.player.xp, 50);
});

test('迷宫星级 cloud id 可写入并按 max 合并', async () => {
  const env = { SYNC_KV: makeKV() };
  await onRequestPost({ request: post({ code: 'ABC123', scores: { 'labyrinth-3d:star-l1': 4 } }), env });
  assert.equal(env.SYNC_KV.store.get('score:ABC123:labyrinth-3d:star-l1'), '3');
  await onRequestPost({ request: post({ code: 'ABC123', scores: { 'labyrinth-3d:star-l1': 2 } }), env });
  await onRequestPost({ request: post({ code: 'ABC123', scores: { 'labyrinth-3d:star-l1': 1 } }), env });
  assert.equal(env.SYNC_KV.store.get('score:ABC123:labyrinth-3d:star-l1'), '3');
  const res = await onRequestGet({
    request: new Request('https://example.test/api/sync?code=ABC123'),
    env,
  });
  assert.deepEqual((await res.json()).scores, { 'labyrinth-3d:star-l1': 3 });
});

test('65 条成绩可整批上传（覆盖全游戏+分档+星级）', async () => {
  const env = { SYNC_KV: makeKV() };
  const scores = {};
  for (let i = 0; i < 65; i++) scores[`fake-${i}`] = i + 1;
  const res = await onRequestPost({ request: post({ code: 'ABC123', scores }), env });
  assert.equal(res.status, 200);
  assert.equal(env.SYNC_KV.store.size, 65);
});

test('每码成绩 key 超过上限时拒绝', async () => {
  const kv = makeKV();
  for (let i = 0; i < 128; i++) kv.store.set(`score:ABC123:fake-${i}`, '1');
  const res = await onRequestPost({ request: post({ code: 'ABC123', scores: { 'game-2048': 10 } }), env: { SYNC_KV: kv } });
  assert.equal(res.status, 413);
});

test('GET 过滤 0 分，不把 0 传给客户端', async () => {
  const kv = makeKV();
  kv.store.set('score:ABC123:game-2048', '0');
  kv.store.set('score:ABC123:snake', '42');
  const res = await onRequestGet({
    request: new Request('https://example.test/api/sync?code=ABC123'),
    env: { SYNC_KV: kv },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.scores, { snake: 42 });
});
