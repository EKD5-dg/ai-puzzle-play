import test from 'node:test';
import assert from 'node:assert/strict';
import { countSolutions, generatePuzzle, generateSolved } from '../src/games/sudokuCore.ts';

function assertComplete(grid) {
  assert.equal(grid.length, 81);
  for (let i = 0; i < 9; i++) {
    const row = new Set();
    const col = new Set();
    const box = new Set();
    for (let j = 0; j < 9; j++) {
      row.add(grid[i * 9 + j]);
      col.add(grid[j * 9 + i]);
      box.add(grid[Math.floor(i / 3) * 27 + (i % 3) * 3 + Math.floor(j / 3) * 9 + (j % 3)]);
    }
    assert.deepEqual([...row].sort(), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual([...col].sort(), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual([...box].sort(), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }
}

test('完整解行列宫均为 1..9', () => {
  assertComplete(generateSolved());
  assertComplete(generateSolved());
});

test('空盘至少存在两个解（countSolutions limit=2）', () => {
  assert.equal(countSolutions(Array(81).fill(0)), 2);
});

test('生成谜题唯一解、答案完整、空格数接近目标', { timeout: 40000 }, () => {
  for (const blanks of [36, 48, 58]) {
    const result = generatePuzzle(blanks, 4);
    assertComplete(result.solution);
    assert.equal(countSolutions(result.puzzle), 1, `${blanks}: 必须唯一解`);
    assert.ok(result.blanks <= blanks);
    assert.ok(result.blanks >= Math.max(30, blanks - 6), `${blanks}: 实际 ${result.blanks} 空格过少`);
    for (let i = 0; i < 81; i++) {
      if (result.puzzle[i] !== 0) assert.equal(result.puzzle[i], result.solution[i], '题面必须是答案的子集');
    }
  }
});
