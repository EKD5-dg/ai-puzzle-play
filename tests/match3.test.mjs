import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CELLS,
  COLOR_COUNT,
  MOVES_PER_LEVEL,
  SIZE,
  createEngine,
  ensureMove,
  findClusters,
  findValidMove,
  hasReachedTarget,
  idx,
  reshuffle,
  targetForLevel,
  trySwap,
} from '../src/games/match3Core.ts';

function mulberry2(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 无三连背景：(r + 2c) % 6，横竖相邻都不同色 */
function bg(r, c) {
  return (r + 2 * c) % COLOR_COUNT;
}

/** 用类型矩阵造棋盘，overrides: Map<index, {type?, special?}> */
function makeState(overrides = new Map(), seed = 42) {
  const rng = mulberry2(seed);
  const st = createEngine(rng);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const i = idx(r, c);
      const o = overrides.get(i) ?? {};
      st.board[i] = { id: i + 1, type: o.type ?? bg(r, c), special: o.special ?? 'none' };
    }
  }
  st.nextId = CELLS + 1;
  return st;
}

function assertFullClean(st) {
  assert.equal(st.board.length, CELLS);
  const ids = new Set();
  for (const g of st.board) {
    assert.ok(g, '棋盘必须满');
    assert.ok(!ids.has(g.id), 'gem id 必须唯一');
    ids.add(g.id);
    assert.ok(g.type >= 0 && g.type < COLOR_COUNT);
  }
  assert.equal(findClusters(st.board).length, 0, '结算后不允许残留可消除簇');
  assert.ok(findValidMove(st), '结算后必须存在有效步');
}

test('开局：满盘、无预置消除、有有效步（50 个种子）', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const st = createEngine(mulberry2(seed));
    assertFullClean(st);
  }
});

test('连线检测：横3 / 竖3 / 4连火箭 / 5连星钻 / L形炸弹', () => {
  // 横3：row2 c1-3 = 5
  let st = makeState(new Map([[idx(2, 1), { type: 5 }], [idx(2, 2), { type: 5 }], [idx(2, 3), { type: 5 }]]));
  let cls = findClusters(st.board);
  assert.equal(cls.length, 1);
  assert.equal(cls[0].special, 'none');
  assert.deepEqual([...cls[0].cells].sort((a, b) => a - b), [idx(2, 1), idx(2, 2), idx(2, 3)]);

  // 竖3：col5 r4-6 = 0
  st = makeState(new Map([[idx(4, 5), { type: 0 }], [idx(5, 5), { type: 0 }], [idx(6, 5), { type: 0 }]]));
  cls = findClusters(st.board);
  assert.equal(cls.length, 1);
  assert.equal(cls[0].special, 'none');

  // 横4 → row 火箭
  st = makeState(new Map([[idx(1, 2), { type: 5 }], [idx(1, 3), { type: 5 }], [idx(1, 4), { type: 5 }], [idx(1, 5), { type: 5 }]]));
  cls = findClusters(st.board);
  assert.equal(cls.length, 1);
  assert.equal(cls[0].special, 'row');

  // 竖4 → col 火箭（col6 背景是 r%6，选 type2 上下都不会延长连段）
  st = makeState(new Map([[idx(2, 6), { type: 2 }], [idx(3, 6), { type: 2 }], [idx(4, 6), { type: 2 }], [idx(5, 6), { type: 2 }]]));
  cls = findClusters(st.board);
  assert.equal(cls.length, 1);
  assert.equal(cls[0].special, 'col');

  // 横5 → 星钻
  st = makeState(new Map([[idx(6, 1), { type: 5 }], [idx(6, 2), { type: 5 }], [idx(6, 3), { type: 5 }], [idx(6, 4), { type: 5 }], [idx(6, 5), { type: 5 }]]));
  cls = findClusters(st.board);
  assert.equal(cls.length, 1);
  assert.equal(cls[0].special, 'star');

  // L形（横3+竖3共享角）→ 炸弹，生成位在交叉点（type1 不与背景延长任何连段）
  st = makeState(new Map([
    [idx(2, 2), { type: 1 }], [idx(2, 3), { type: 1 }], [idx(2, 4), { type: 1 }],
    [idx(3, 2), { type: 1 }], [idx(4, 2), { type: 1 }],
  ]));
  cls = findClusters(st.board);
  assert.equal(cls.length, 1);
  assert.equal(cls[0].cells.length, 5);
  assert.equal(cls[0].special, 'bomb');
  assert.equal(cls[0].spawn, idx(2, 2));
});

test('星钻不参与颜色匹配', () => {
  const st = makeState(new Map([
    [idx(3, 3), { type: 1, special: 'star' }],
    [idx(3, 4), { type: 1, special: 'star' }],
    [idx(3, 5), { type: 1, special: 'star' }],
  ]));
  assert.equal(findClusters(st.board).length, 0);
});

test('非法交换：回滚且返回 null；非相邻返回 null', () => {
  const st = makeState();
  const before = st.board.map((g) => ({ ...g }));
  // bg 棋盘任意交换都不产生消除（相邻不同色，换后最多两连）
  assert.equal(trySwap(st, idx(0, 0), idx(0, 1)), null);
  assert.deepEqual(st.board, before);
  assert.equal(trySwap(st, idx(0, 0), idx(1, 1)), null);
  assert.deepEqual(st.board, before);
});

test('合法交换：消除、重力、补给，积分按连锁倍率', () => {
  // row2 c1,c3=5，(1,2)=5，换 (1,2)↔(2,2) 形成横3
  const st = makeState(new Map([
    [idx(2, 1), { type: 5 }], [idx(2, 3), { type: 5 }], [idx(1, 2), { type: 5 }],
  ]));
  const steps = trySwap(st, idx(1, 2), idx(2, 2));
  assert.ok(steps && steps.length >= 1);
  assert.ok(steps[0].cleared.includes(idx(2, 1)));
  assert.ok(steps[0].cleared.includes(idx(2, 2)));
  assert.ok(steps[0].cleared.includes(idx(2, 3)));
  for (let k = 0; k < steps.length; k++) {
    assert.equal(steps[k].cascade, k + 1);
    assert.equal(steps[k].score, steps[k].cleared.length * 10 * (k + 1));
    assert.equal(steps[k].afterGravity.filter(Boolean).length, CELLS);
  }
  ensureMove(st);
  assertFullClean(st);
});

test('4连交换生成火箭，生成位优先玩家换入的格子', () => {
  // row4 c1-4 已有三个5：c1,c2,c4；(3,3)=5 换入 (4,3) 成横4
  const st = makeState(new Map([
    [idx(4, 1), { type: 5 }], [idx(4, 2), { type: 5 }], [idx(4, 4), { type: 5 }], [idx(3, 3), { type: 5 }],
  ]));
  const steps = trySwap(st, idx(3, 3), idx(4, 3));
  assert.ok(steps);
  assert.equal(steps[0].transform.length, 1);
  assert.equal(steps[0].transform[0].special, 'row');
  assert.equal(steps[0].transform[0].index, idx(4, 3));
  assert.ok(!steps[0].cleared.includes(idx(4, 3)), '生成位当步不清除');
  const born = steps[0].afterGravity.find((g) => g && g.special === 'row');
  assert.ok(born, '重力后火箭仍在盘上');
});

test('火箭被消除时引爆整行', () => {
  // (2,1) 是 type5 的 row 火箭；换 (1,2)=5 到 (2,2) 成横3，火箭在匹配内
  const st = makeState(new Map([
    [idx(2, 1), { type: 5, special: 'row' }], [idx(2, 3), { type: 5 }], [idx(1, 2), { type: 5 }],
  ]));
  const steps = trySwap(st, idx(1, 2), idx(2, 2));
  assert.ok(steps);
  for (let c = 0; c < SIZE; c++) assert.ok(steps[0].cleared.includes(idx(2, c)), `行2格${c}应被火箭清除`);
});

test('炸弹被消除时引爆 3×3', () => {
  const st = makeState(new Map([
    [idx(2, 1), { type: 5, special: 'bomb' }], [idx(2, 3), { type: 5 }], [idx(1, 2), { type: 5 }],
  ]));
  const steps = trySwap(st, idx(1, 2), idx(2, 2));
  assert.ok(steps);
  for (let r = 1; r <= 3; r++)
    for (let c = 0; c <= 2; c++) assert.ok(steps[0].cleared.includes(idx(r, c)));
});

test('特殊宝石链式引爆：火箭波及炸弹', () => {
  // 横3 内含 row 火箭 (2,1)；炸弹放在 (2,6) 同行，火箭清行时引爆它
  const st = makeState(new Map([
    [idx(2, 1), { type: 5, special: 'row' }], [idx(2, 3), { type: 5 }], [idx(1, 2), { type: 5 }],
    [idx(2, 6), { type: 0, special: 'bomb' }],
  ]));
  const steps = trySwap(st, idx(1, 2), idx(2, 2));
  assert.ok(steps);
  for (let r = 1; r <= 3; r++)
    for (let c = 5; c <= 7; c++) assert.ok(steps[0].cleared.includes(idx(r, c)), '炸弹应被火箭链式引爆');
});

test('星钻交换：消同色；星钻+星钻清屏', () => {
  const st = makeState(new Map([[idx(3, 3), { type: 0, special: 'star' }]]));
  const targetType = st.board[idx(3, 4)].type;
  const expected = [];
  st.board.forEach((g, i) => {
    if (g.special !== 'star' && g.type === targetType) expected.push(i);
  });
  const steps = trySwap(st, idx(3, 3), idx(3, 4));
  assert.ok(steps);
  assert.ok(steps[0].cleared.includes(idx(3, 3)), '星钻自身清除');
  for (const i of expected) assert.ok(steps[0].cleared.includes(i));
  // 精确集合：只清星钻 + 目标色，不能额外触发"全场最多颜色"的 blast
  assert.deepEqual(
    new Set(steps[0].cleared),
    new Set([...expected, idx(3, 3)]),
    '星钻交换普通宝石只能消同色',
  );

  const st2 = makeState(new Map([
    [idx(0, 0), { type: 0, special: 'star' }],
    [idx(0, 1), { type: 1, special: 'star' }],
  ]));
  const steps2 = trySwap(st2, idx(0, 0), idx(0, 1));
  assert.ok(steps2);
  assert.equal(steps2[0].cleared.length, CELLS, '双星钻清屏');
});

test('重力：上方宝石落到被消除格，列内相对顺序不变', () => {
  const st = makeState(new Map([
    [idx(2, 1), { type: 5 }], [idx(2, 3), { type: 5 }], [idx(1, 2), { type: 5 }],
  ]));
  const above = st.board[idx(0, 2)];
  const steps = trySwap(st, idx(1, 2), idx(2, 2));
  assert.ok(steps);
  // (0,2) 的宝石在第一步重力后应落在 col2 更低处
  const pos = steps[0].afterGravity.findIndex((g) => g && g.id === above.id);
  assert.ok(pos >= 0);
  assert.ok(Math.floor(pos / SIZE) > 0, '宝石必须下落');
  assert.equal(pos % SIZE, 2, '列不变');
});

test('连锁：第一消落下后形成第二消', () => {
  const st = makeState(new Map([
    [idx(2, 0), { type: 4 }], [idx(3, 0), { type: 3 }], [idx(4, 0), { type: 3 }],
    [idx(5, 0), { type: 2 }], [idx(6, 0), { type: 1 }], [idx(7, 0), { type: 1 }],
    [idx(7, 1), { type: 3 }], [idx(7, 2), { type: 3 }],
  ]), 7);
  assert.equal(findClusters(st.board).length, 0, '前置棋盘无预置消除');
  // (5,1)=bg(5,1)=1，换到 (5,0) 使 col0 r5-7 = 1,1,1
  const steps = trySwap(st, idx(5, 0), idx(5, 1));
  assert.ok(steps && steps.length >= 2, `应发生连锁，实际 ${steps?.length} 步`);
  assert.ok(steps[1].cleared.includes(idx(7, 0)));
  assert.ok(steps[1].cleared.includes(idx(7, 1)));
  assert.ok(steps[1].cleared.includes(idx(7, 2)));
});

test('重排：特殊宝石留原位，结果无消除且有有效步', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const st = makeState(new Map([
      [idx(0, 0), { type: 0, special: 'star' }],
      [idx(4, 4), { type: 1, special: 'bomb' }],
      [idx(7, 7), { type: 2, special: 'row' }],
    ]), seed);
    reshuffle(st);
    assert.equal(st.board[idx(0, 0)].special, 'star');
    assert.equal(st.board[idx(4, 4)].special, 'bomb');
    assert.equal(st.board[idx(7, 7)].special, 'row');
    assert.equal(findClusters(st.board).length, 0);
    assert.ok(findValidMove(st));
  }
});

test('随机对局 200 步：棋盘始终完整、无残留消除、id 唯一', () => {
  const rng = mulberry2(99);
  const st = createEngine(rng);
  let played = 0;
  for (let m = 0; m < 200; m++) {
    const move = findValidMove(st);
    assert.ok(move, `第 ${m} 步必须有解`);
    const steps = trySwap(st, move[0], move[1]);
    assert.ok(steps, 'findValidMove 给出的交换必须合法');
    played += steps.reduce((a, s) => a + s.score, 0);
    ensureMove(st);
    assertFullClean(st);
  }
  assert.ok(played > 0);
});

test('关卡目标校准：随机乱玩能过第1关，第5关需要技巧', () => {
  const scores = [];
  for (let s = 0; s < 200; s++) {
    const rng = mulberry2(s + 1000);
    const st = createEngine(rng);
    let total = 0;
    for (let m = 0; m < MOVES_PER_LEVEL; m++) {
      let steps = null;
      const start = Math.floor(rng() * CELLS);
      for (let k = 0; k < CELLS && !steps; k++) {
        const i = (start + k) % CELLS;
        const r = Math.floor(i / SIZE), c = i % SIZE;
        for (const j of [c < SIZE - 1 ? i + 1 : -1, r < SIZE - 1 ? i + SIZE : -1]) {
          if (j < 0) continue;
          steps = trySwap(st, i, j);
          if (steps) break;
        }
      }
      if (steps) total += steps.reduce((a, s2) => a + s2.score, 0);
      ensureMove(st);
    }
    scores.push(total);
  }
  scores.sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)];
  const p90 = scores[Math.floor(scores.length * 0.9)];
  assert.ok(median >= targetForLevel(1), `随机中位数 ${median} 应过第1关 ${targetForLevel(1)}`);
  assert.ok(p90 >= targetForLevel(2), `随机 p90 ${p90} 应能摸到第2关 ${targetForLevel(2)}`);
  assert.ok(targetForLevel(5) > p90, `第5关 ${targetForLevel(5)} 应高于随机 p90 ${p90}`);
});

test('跨关分数携带：下一关目标按本关增量判定，溢出分不会直接过关', () => {
  // 第 1 关拿了 2500 分进入第 2 关：本关进度从 0 起算，不能直接判过
  assert.equal(hasReachedTarget(2500, 2500, 2), false);
  assert.equal(hasReachedTarget(2500 + targetForLevel(2) - 1, 2500, 2), false);
  assert.equal(hasReachedTarget(2500 + targetForLevel(2), 2500, 2), true);
});