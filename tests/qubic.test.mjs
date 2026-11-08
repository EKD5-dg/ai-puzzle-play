import test from 'node:test';
import assert from 'node:assert/strict';
import {
  N,
  CELLS,
  HUMAN,
  AI,
  LINES,
  LINES_THROUGH,
  ax,
  ay,
  az,
  idxOf,
  winLineAt,
  winningSquares,
  enclosedCell,
  chooseMove,
  emptyBoard,
} from '../src/games/qubicAI.ts';

const range = (n) => Array.from({ length: n }, (_, i) => i);

test('76 条四子直线：数量、去重、格子在盘内', () => {
  assert.equal(N, 4);
  assert.equal(CELLS, 64);
  assert.equal(LINES.length, 76);
  const seen = new Set();
  for (const line of LINES) {
    assert.equal(line.length, 4);
    assert.equal(new Set(line).size, 4);
    for (const c of line) assert.ok(c >= 0 && c < CELLS);
    const key = [...line].sort((a, b) => a - b).join(',');
    assert.ok(!seen.has(key), `重复直线 ${key}`);
    seen.add(key);
  }
  // 每条线都记录进了经过格子的索引表，且双向一致
  const throughCount = new Array(CELLS).fill(0);
  LINES.forEach((line, li) => {
    for (const c of line) {
      assert.ok(LINES_THROUGH[c].includes(li));
      throughCount[c]++;
    }
  });
  assert.equal(throughCount.reduce((a, b) => a + b, 0), LINES.length * N);
  for (const c of range(CELLS)) {
    assert.equal(LINES_THROUGH[c].length, throughCount[c]);
    assert.equal(new Set(LINES_THROUGH[c]).size, throughCount[c]);
  }
  // 每条线必须是等距直线，且方向向量各分量属于 {-1,0,1}
  for (const line of LINES) {
    const p0 = [ax(line[0]), ay(line[0]), az(line[0])];
    const p1 = [ax(line[1]), ay(line[1]), az(line[1])];
    const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    assert.ok(d.every((v) => v >= -1 && v <= 1) && d.some((v) => v !== 0), `非法方向 ${d}`);
    line.forEach((c, k) => {
      const q = [p0[0] + d[0] * k, p0[1] + d[1] * k, p0[2] + d[2] * k];
      assert.ok(q.every((v) => v >= 0 && v < N), `直线出界 ${line}`);
      assert.equal(c, idxOf(q[0], q[1], q[2]));
    });
  }
});

test('winLineAt 只认最后一手所在成线', () => {
  const empty = emptyBoard();
  assert.equal(winLineAt(empty, idxOf(0, 0, 0)), null); // 空格返回 null

  const board = emptyBoard();
  const line = [idxOf(0, 0, 0), idxOf(1, 0, 0), idxOf(2, 0, 0), idxOf(3, 0, 0)];
  board[line[0]] = board[line[1]] = board[line[2]] = AI;
  assert.equal(winLineAt(board, line[2]), null); // 三连不算
  board[line[3]] = AI;
  assert.deepEqual(winLineAt(board, line[3]), line);
  // 不在成线上的最后一手
  board[idxOf(0, 1, 0)] = AI;
  assert.equal(winLineAt(board, idxOf(0, 1, 0)), null);

  // 最后一手同时凑成两条线：返回任一条，但必须整条同色
  const cross = emptyBoard();
  for (const c of [idxOf(1, 0, 0), idxOf(2, 0, 0), idxOf(3, 0, 0)]) cross[c] = HUMAN; // x 轴缺 (0,0,0)
  for (const c of [idxOf(0, 1, 0), idxOf(0, 2, 0), idxOf(0, 3, 0)]) cross[c] = HUMAN; // y 轴缺 (0,0,0)
  cross[idxOf(0, 0, 0)] = HUMAN;
  const hit = winLineAt(cross, idxOf(0, 0, 0));
  assert.ok(hit);
  assert.ok(hit.every((c) => cross[c] === HUMAN));
});

test('winningSquares 同一空点被多条威胁线共享时只返回一次', () => {
  const board = emptyBoard();
  for (const c of [idxOf(1, 0, 0), idxOf(2, 0, 0), idxOf(3, 0, 0)]) board[c] = HUMAN;
  for (const c of [idxOf(0, 1, 0), idxOf(0, 2, 0), idxOf(0, 3, 0)]) board[c] = HUMAN;
  const threats = winningSquares(board, HUMAN);
  assert.deepEqual(threats, [idxOf(0, 0, 0)]);
});

test('winningSquares 返回差一子即可成线的空点', () => {
  const board = emptyBoard();
  const line = [idxOf(0, 0, 0), idxOf(1, 0, 0), idxOf(2, 0, 0), idxOf(3, 0, 0)];
  for (let k = 0; k < 3; k++) board[line[k]] = HUMAN;
  assert.deepEqual(winningSquares(board, HUMAN), [line[3]]);
  // 被对手占住的一端不算威胁
  board[line[3]] = AI;
  assert.deepEqual(winningSquares(board, HUMAN), []);
  assert.deepEqual(winningSquares(emptyBoard(), HUMAN), []);
});

test('chooseMove 优先自己成四，其次堵对手成四', () => {
  // 双方各有三连，AI 自己的成四优先
  const board = emptyBoard();
  board[idxOf(0, 0, 0)] = board[idxOf(1, 0, 0)] = board[idxOf(2, 0, 0)] = AI; // 缺 (3,0,0)
  board[idxOf(0, 1, 0)] = board[idxOf(1, 1, 0)] = board[idxOf(2, 1, 0)] = HUMAN; // 缺 (3,1,0)
  assert.equal(chooseMove(board, 0).move, idxOf(3, 0, 0));

  // 只有对手有威胁时必须堵
  const board2 = emptyBoard();
  board2[idxOf(0, 1, 0)] = board2[idxOf(1, 1, 0)] = board2[idxOf(2, 1, 0)] = HUMAN;
  assert.equal(chooseMove(board2, 0).move, idxOf(3, 1, 0));
});

test('chooseMove 在满盘时返回 -1，且不修改传入棋盘', () => {
  const board = new Array(CELLS).fill(AI);
  // 满盘时先检查 winningSquares 仍能返回非空（已无空点则不能）
  assert.deepEqual(winningSquares(board, AI), []);
  assert.equal(chooseMove(board, 0).move, -1);

  const mid = emptyBoard();
  mid[idxOf(0, 0, 0)] = HUMAN;
  mid[idxOf(1, 1, 1)] = AI;
  mid[idxOf(2, 2, 2)] = HUMAN;
  const snapshot = mid.slice();
  const { move } = chooseMove(mid, 0);
  assert.ok(move >= 0 && move < CELLS);
  assert.equal(mid[move], 0);
  assert.deepEqual(mid, snapshot);
});

test('enclosedCell 只认六个正交邻居全被占的内部格', () => {
  const board = emptyBoard();
  const i = idxOf(1, 1, 1);
  assert.equal(enclosedCell(board, i), false);
  for (const [x, y, z] of [
    [2, 1, 1],
    [0, 1, 1],
    [1, 2, 1],
    [1, 0, 1],
    [1, 1, 2],
    [1, 1, 0],
  ]) {
    board[idxOf(x, y, z)] = HUMAN;
  }
  assert.equal(enclosedCell(board, i), true);
  assert.equal(enclosedCell(board, idxOf(0, 0, 0)), false); // 边界格永远不算包住
});
