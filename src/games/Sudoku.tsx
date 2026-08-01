import { useEffect, useMemo, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useLocalStorage } from '../core/useLocalStorage';
import type { GameMeta } from '../core/types';

export const meta: GameMeta = {
  id: 'sudoku',
  title: '数独',
  description: '每行、每列、每宫填入 1-9 不重复！',
  icon: '🔢',
  difficulty: '困难',
  category: '逻辑',
  tags: ['数字', '推理'],
  bestScoreLabel: '最快完成',
};

type Cell = number; // 0 = 空
type Grid = Cell[]; // 81 格

const LEVELS = [
  { label: '简单', blanks: 36 },
  { label: '中等', blanks: 48 },
  { label: '困难', blanks: 58 },
];

/** 用回溯法随机生成一个完整数独盘 */
function generateSolved(): Grid {
  const grid: Grid = Array(81).fill(0);
  const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9];

  function shuffle(arr: number[]): number[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function valid(idx: number, v: number): boolean {
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

  function fill(): boolean {
    for (let idx = 0; idx < 81; idx++) {
      if (grid[idx] !== 0) continue;
      const candidates = shuffle(nums);
      for (const v of candidates) {
        if (valid(idx, v)) {
          grid[idx] = v;
          if (fill()) return true;
          grid[idx] = 0;
        }
      }
      return false;
    }
    return true;
  }

  fill();
  return grid;
}

/** 挖空生成谜题（保证唯一解：挖掉后求解数仍为 1） */
function generatePuzzle(blanks: number): { puzzle: Grid; solution: Grid } {
  const solution = generateSolved();
  const puzzle = [...solution];
  const cells = Array.from({ length: 81 }, (_, i) => i);
  // 洗牌
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  let removed = 0;
  for (const idx of cells) {
    if (removed >= blanks) break;
    const backup = puzzle[idx];
    puzzle[idx] = 0;
    if (countSolutions([...puzzle]) !== 1) {
      puzzle[idx] = backup;
    } else {
      removed++;
    }
  }
  return { puzzle, solution };
}

/** 求解数独，返回解的个数（最多数到 2） */
function countSolutions(grid: Grid, limit = 2): number {
  let count = 0;

  function findEmpty(): number {
    for (let i = 0; i < 81; i++) if (grid[i] === 0) return i;
    return -1;
  }

  function valid(idx: number, v: number): boolean {
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

  function solve(): boolean {
    const idx = findEmpty();
    if (idx === -1) {
      count++;
      return count >= limit;
    }
    for (let v = 1; v <= 9; v++) {
      if (valid(idx, v)) {
        grid[idx] = v;
        if (solve()) return true;
        grid[idx] = 0;
      }
    }
    return false;
  }

  solve();
  return count;
}

export default function Sudoku() {
  const [levelIdx, setLevelIdx] = useState(1);
  const [puzzle, setPuzzle] = useState<Grid>(() => Array(81).fill(0));
  const [solution, setSolution] = useState<Grid>(() => Array(81).fill(0));
  const [current, setCurrent] = useState<Grid>(() => Array(81).fill(0));
  const [selected, setSelected] = useState<number | null>(null);
  const [mistakes, setMistakes] = useState(0);
  const [showMistakes, setShowMistakes] = useState(true);
  const [time, setTime] = useState(0);
  const [won, setWon] = useState(false);
  const best = useLocalStorage<number>(`best:${meta.id}`);

  const startNew = (idx: number) => {
    const { puzzle: p, solution: s } = generatePuzzle(LEVELS[idx].blanks);
    setLevelIdx(idx);
    setPuzzle(p);
    setSolution(s);
    setCurrent([...p]);
    setSelected(null);
    setMistakes(0);
    setTime(0);
    setWon(false);
  };

  // 首次进入生成一局
  useEffect(() => {
    startNew(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 计时
  useEffect(() => {
    if (won) return;
    const t = window.setInterval(() => setTime((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [won]);

  const inputNumber = (v: number) => {
    if (won || selected === null) return;
    if (puzzle[selected] !== 0) return;
    const next = [...current];
    next[selected] = v;
    if (v !== 0 && v !== solution[selected]) {
      setMistakes((m) => m + 1);
    }
    setCurrent(next);
    // 完成判定
    if (next.every((x) => x !== 0)) {
      if (next.every((x, i) => x === solution[i])) {
        setWon(true);
        best.updateBest(time, (a, b) => a < b);
      }
    }
  };

  const sameNumberCells = useMemo(() => {
    if (selected === null) return new Set<number>();
    const v = current[selected];
    if (v === 0) return new Set<number>();
    return new Set(current.map((x, i) => (x === v ? i : -1)).filter((i) => i >= 0));
  }, [current, selected]);

  const highlightCells = useMemo(() => {
    if (selected === null) return new Set<number>();
    const r = Math.floor(selected / 9);
    const c = selected % 9;
    const set = new Set<number>();
    for (let i = 0; i < 9; i++) {
      set.add(r * 9 + i);
      set.add(i * 9 + c);
    }
    const br = Math.floor(r / 3) * 3;
    const bc = Math.floor(c / 3) * 3;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) set.add((br + i) * 9 + bc + j);
    return set;
  }, [selected]);

  const isWrong = (i: number) =>
    showMistakes && current[i] !== 0 && puzzle[i] === 0 && current[i] !== solution[i];

  const wrongCells = new Set(current.map((_, i) => (isWrong(i) ? i : -1)).filter((i) => i >= 0));

  return (
    <GameShell
      meta={meta}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>时间</span>
            <strong>{time}s</strong>
          </div>
          <div className="stat-box">
            <span>错误</span>
            <strong>{mistakes}</strong>
          </div>
          <div className="stat-box">
            <span>{meta.bestScoreLabel}</span>
            <strong>{best.value ? `${best.value}s` : '--'}</strong>
          </div>
          <button className="btn btn-primary" onClick={() => startNew(levelIdx)}>
            🔄 新一局
          </button>
        </>
      }
    >
      <div className="sudoku">
        <div className="level-bar">
          {LEVELS.map((lv, i) => (
            <button
              key={lv.label}
              className={`btn ${i === levelIdx ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => startNew(i)}
            >
              {lv.label}
            </button>
          ))}
          <label className="sudoku-toggle">
            <input
              type="checkbox"
              checked={showMistakes}
              onChange={(e) => setShowMistakes(e.target.checked)}
            />
            错误提示
          </label>
        </div>
        {won && (
          <div className="banner won">
            🎉 数独完成！用时 {time}s，错误 {mistakes} 次
          </div>
        )}
        <div className="sudoku-grid">
          {current.map((v, i) => {
            const isGiven = puzzle[i] !== 0;
            const r = Math.floor(i / 9);
            const c = i % 9;
            const isSel = selected === i;
            const cls = [
              'sudoku-cell',
              isGiven ? 'given' : 'filled',
              isSel ? 'selected' : '',
              highlightCells.has(i) ? 'hl' : '',
              sameNumberCells.has(i) ? 'same' : '',
              wrongCells.has(i) ? 'wrong' : '',
              r % 3 === 2 && r < 8 ? 'rb' : '',
              c % 3 === 2 && c < 8 ? 'cb' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                key={i}
                className={cls}
                onClick={() => setSelected(isSel ? null : i)}
              >
                {v === 0 ? '' : v}
              </button>
            );
          })}
        </div>
        <div className="num-pad">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <button key={n} className="btn num-btn" onClick={() => inputNumber(n)}>
              {n}
            </button>
          ))}
          <button className="btn num-btn" onClick={() => inputNumber(0)}>
            ✕
          </button>
        </div>
        <p className="hint">先点击棋盘选中格子，再点数字填入</p>
      </div>
    </GameShell>
  );
}
