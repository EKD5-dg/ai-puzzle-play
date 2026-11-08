/**
 * 数独生成/求解的纯计算模块：可以整体放进 Worker，不碰 DOM。
 * 生成会重试多个完整解，尽量达到目标空格数；单次挖洞失败不会回头补，
 * 所以靠“换一个解/换一个顺序”提高命中率，而不是无限重挖。
 */

export type Grid = number[];

export interface SudokuPuzzle {
  puzzle: Grid;
  solution: Grid;
  /** 实际挖掉的空格数（可能略低于目标） */
  blanks: number;
}

function shuffle<T>(input: T[]): T[] {
  const a = [...input];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function valid(grid: Grid, idx: number, v: number): boolean {
  const r = Math.floor(idx / 9);
  const c = idx % 9;
  for (let i = 0; i < 9; i++) {
    if (grid[r * 9 + i] === v) return false;
    if (grid[i * 9 + c] === v) return false;
  }
  const br = Math.floor(r / 3) * 3;
  const bc = Math.floor(c / 3) * 3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      if (grid[(br + i) * 9 + bc + j] === v) return false;
    }
  return true;
}

/** 用回溯法随机生成一个完整数独盘 */
export function generateSolved(): Grid {
  const grid: Grid = Array(81).fill(0);
  const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const fill = (): boolean => {
    for (let idx = 0; idx < 81; idx++) {
      if (grid[idx] !== 0) continue;
      for (const v of shuffle(nums)) {
        if (valid(grid, idx, v)) {
          grid[idx] = v;
          if (fill()) return true;
          grid[idx] = 0;
        }
      }
      return false;
    }
    return true;
  };
  fill();
  return grid;
}

/** 求解数独，返回解的个数（最多数到 limit） */
export function countSolutions(source: Grid, limit = 2): number {
  const grid = [...source];
  let count = 0;
  const solve = (): boolean => {
    let idx = -1;
    for (let i = 0; i < 81; i++) {
      if (grid[i] === 0) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      count++;
      return count >= limit;
    }
    for (let v = 1; v <= 9; v++) {
      if (valid(grid, idx, v)) {
        grid[idx] = v;
        if (solve()) return true;
        grid[idx] = 0;
      }
    }
    return false;
  };
  solve();
  return count;
}

/** 从完整解挖空；返回实际挖掉的数量 */
function carve(solution: Grid, blanks: number): { puzzle: Grid; removed: number } {
  const puzzle = [...solution];
  let removed = 0;
  for (const idx of shuffle(Array.from({ length: 81 }, (_, i) => i))) {
    if (removed >= blanks) break;
    const backup = puzzle[idx];
    puzzle[idx] = 0;
    if (countSolutions(puzzle) !== 1) puzzle[idx] = backup;
    else removed++;
  }
  return { puzzle, removed };
}

/**
 * 挖空生成谜题（保证唯一解）。最多尝试 maxAttempts 个完整解，
 * 保留空格数最多的一次；达到目标立即返回。
 */
export function generatePuzzle(blanks: number, maxAttempts = 4): SudokuPuzzle {
  let best: SudokuPuzzle | null = null;
  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt++) {
    const solution = generateSolved();
    const { puzzle, removed } = carve(solution, blanks);
    if (!best || removed > best.blanks) best = { puzzle, solution, blanks: removed };
    if (best.blanks >= blanks) break;
  }
  // 至少尝试一次，best 必然存在
  return best as SudokuPuzzle;
}
