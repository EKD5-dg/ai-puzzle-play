import test from 'node:test';
import assert from 'node:assert/strict';
import {
  START_GOLD,
  TOWER_DEFS,
  WAVE_COUNT,
  buildCost,
  callWave,
  createGame,
  drainEvents,
  placeTower,
  sellTower,
  sellValue,
  towerAt,
  update,
  upgradeCost,
  upgradeTower,
} from '../src/games/towerDefenseCore.ts';

test('建塔/升级/出售的晶能账目与地形校验', () => {
  const w = createGame();
  // 路径格不能建
  const before = w.gold;
  assert.notEqual(placeTower(w, 'pulse', 0, 2), 'ok');
  assert.equal(w.gold, before);
  // 正常建造
  const cost0 = buildCost('pulse');
  const up1 = TOWER_DEFS.pulse.levels[1].cost;
  const up2 = TOWER_DEFS.pulse.levels[2].cost;
  assert.equal(placeTower(w, 'pulse', 1, 1), 'ok');
  assert.equal(w.gold, START_GOLD - cost0);
  const t = towerAt(w, 1, 1);
  assert.ok(t);
  assert.equal(t.level, 1);
  // 升级两档后到顶（期望值先算好，upgradeTower 会原地改 level）
  assert.equal(upgradeTower(w, t.id), 'ok');
  assert.equal(w.gold, START_GOLD - cost0 - up1);
  assert.equal(upgradeTower(w, t.id), 'ok');
  assert.equal(t.level, 3);
  assert.equal(w.gold, START_GOLD - cost0 - up1 - up2);
  assert.equal(upgradeTower(w, t.id), 'max');
  // 出售按 sellValue 返还
  const refund = sellValue(t);
  assert.equal(sellTower(w, t.id), refund);
  assert.equal(w.gold, START_GOLD - cost0 - up1 - up2 + refund);
  assert.equal(towerAt(w, 1, 1), undefined);
});

test('霜塔弱减速不得续上强减速：卖掉 3 级霜塔后 slowK 必须回落', () => {
  const w = createGame();
  w.gold = 1000; // 测试直接给足晶能，专注减速规则
  assert.equal(placeTower(w, 'frost', 1, 1), 'ok'); // 覆盖路径前段
  const l3 = towerAt(w, 1, 1);
  upgradeTower(w, l3.id);
  upgradeTower(w, l3.id);
  assert.equal(l3.level, 3);
  assert.equal(placeTower(w, 'frost', 4, 4), 'ok'); // 覆盖 x=3 竖直段
  const l1 = w.towers.find((t) => t.gx === 4 && t.gy === 4);
  assert.ok(l1 && l1.level === 1);

  callWave(w);
  assert.equal(w.phase, 'wave');
  const dt = 0.05;
  // 推进到敌人离开 3 级霜塔覆盖、进入 1 级霜塔范围
  let enemy = null;
  for (let i = 0; i < 400 && !enemy; i++) {
    update(w, dt);
    drainEvents(w);
    enemy = w.enemies.find((e) => !e.dead) ?? null;
  }
  assert.ok(enemy, '第一波应有敌人出生');
  enemy.hp = 1e9; // 别让它被霜塔磨死，专注减速
  enemy.maxHp = 1e9;
  for (let i = 0; i < 400 && enemy.dist < 4.6; i++) update(w, dt);
  assert.ok(enemy.dist >= 4.6, '敌人应已进入 1 级霜塔覆盖段');
  // 卖掉 3 级霜塔，场上只剩 1 级
  sellTower(w, l3.id);
  let maxSlow = 0;
  let reachedL1 = false;
  for (let i = 0; i < 240; i++) {
    update(w, dt);
    drainEvents(w);
    if (enemy.dead) break;
    maxSlow = Math.max(maxSlow, enemy.slowK);
    if (enemy.slowK <= TOWER_DEFS.frost.levels[0].slow + 1e-6 && enemy.slowT > 0) reachedL1 = true;
  }
  assert.ok(maxSlow <= TOWER_DEFS.frost.levels[2].slow + 1e-6, `slowK 不应超过 3 级值，实测 ${maxSlow}`);
  assert.ok(reachedL1, '1 级霜塔应把 slowK 拉回自身值，而不是无限续 3 级的 0.55');
});

test('不布防时核心会被打穿：update/lost 路径可用', () => {
  const w = createGame();
  callWave(w);
  for (let i = 0; i < 3600 && w.phase !== 'won' && w.phase !== 'lost'; i++) update(w, 0.1);
  assert.equal(w.phase, 'lost');
  assert.ok(w.coreHp < 20);
  assert.ok(w.wave <= WAVE_COUNT);
});
