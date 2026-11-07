import test from 'node:test';
import assert from 'node:assert/strict';
import { DQ_MAX_FLOOR, isBetterDqSave, sanitizeDqSave } from '../src/core/dqSave.ts';
import { sanitizeDqProgress } from '../functions/api/sync.js';

const valid = {
  floor: 5,
  player: {
    level: 7,
    xp: 10,
    hp: 40,
    maxHp: 120,
    mp: 5,
    maxMp: 25,
    atk: 20,
    def: 10,
    gold: 100,
    kills: 12,
  },
};

test('合法存档原样保留', () => {
  assert.deepEqual(sanitizeDqSave(valid), valid);
});

test('缺字段按默认值补齐（旧版存档兼容）', () => {
  const s = sanitizeDqSave({ floor: 2, player: { level: 1 } });
  assert.ok(s);
  assert.equal(s.floor, 2);
  assert.deepEqual(s.player, {
    level: 1,
    xp: 0,
    hp: 60,
    maxHp: 60,
    mp: 10,
    maxMp: 10,
    atk: 8,
    def: 3,
    gold: 0,
    kills: 0,
  });
});

test('越界/NaN 存档直接拒绝，不夹到边界', () => {
  const cases = [
    { ...valid, floor: 999 },
    { ...valid, floor: 0 },
    { ...valid, player: { ...valid.player, level: 1e9 } },
    { ...valid, player: { ...valid.player, xp: 1e308 } },
    { ...valid, player: { ...valid.player, level: 1, xp: 22 } },
    { ...valid, player: { ...valid.player, maxHp: 1e308 } },
    { ...valid, player: { ...valid.player, hp: 0 } },
    { ...valid, player: { ...valid.player, mp: -1 } },
    { ...valid, player: { ...valid.player, atk: 0 } },
    { ...valid, player: { ...valid.player, gold: 1e308 } },
  ];
  for (const c of cases) assert.equal(sanitizeDqSave(c), null);
});

test('缺 player/非对象返回 null', () => {
  assert.equal(sanitizeDqSave(null), null);
  assert.equal(sanitizeDqSave({ floor: 2 }), null);
  assert.equal(sanitizeDqSave({ floor: 2, player: 'x' }), null);
});

test('服务端 DQ 清洗：脏档拒绝、缺字段补默认', () => {
  assert.equal(sanitizeDqProgress({ ...valid, floor: 999 }), null);
  assert.equal(sanitizeDqProgress({ ...valid, player: { ...valid.player, xp: 1e308 } }), null);
  const s = sanitizeDqProgress({ floor: 2, player: { level: 1 } });
  assert.ok(s);
  assert.equal(s.floor, 2);
  assert.equal(s.player.maxHp, 60);
});

test('存档优劣：楼层 → 等级 → 经验 → 金币', () => {
  const mk = (floor, level, xp, gold = 0) =>
    sanitizeDqSave({ ...valid, floor, player: { ...valid.player, level, xp, gold } });
  const a = mk(5, 7, 10);
  const b = mk(4, 20, 0);
  const c = mk(5, 8, 0);
  const d = mk(5, 7, 20);
  const e = mk(5, 7, 20, 500);
  assert.ok(a && b && c && d && e);
  assert.equal(isBetterDqSave(a, b), true);
  assert.equal(isBetterDqSave(c, a), true);
  assert.equal(isBetterDqSave(d, a), true);
  assert.equal(isBetterDqSave(e, d), true);
  assert.equal(isBetterDqSave(a, a), false);
  assert.equal(DQ_MAX_FLOOR, 10);
});
