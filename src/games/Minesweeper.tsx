import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import type { GameMeta } from '../core/types';

export const meta: GameMeta = {
  id: 'minesweeper',
  title: '扫雷',
  description: '推理地雷位置，点击所有安全格！',
  icon: '💣',
  difficulty: '中等',
  category: '逻辑',
  tags: ['推理', '经典'],
  bestScoreLabel: '最快通关',
};

type CellState = 'hidden' | 'revealed' | 'flagged';

interface Cell {
  mine: boolean;
  adjacent: number;
  state: CellState;
}

type Grid = Cell[][];

interface Level {
  label: string;
  rows: number;
  cols: number;
  mines: number;
}

const LEVELS: Level[] = [
  { label: '简单 9×9', rows: 9, cols: 9, mines: 10 },
  { label: '中等 16×16', rows: 16, cols: 16, mines: 40 },
  { label: '困难 16×30', rows: 16, cols: 30, mines: 99 },
];

function buildGrid(rows: number, cols: number, mines: number, safeR: number, safeC: number): Grid {
  const grid: Grid = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ mine: false, adjacent: 0, state: 'hidden' as CellState })),
  );
  // 放置地雷（避开首次点击及其周围 8 格）
  const forbidden = new Set<number>([safeR * cols + safeC]);
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      const r = safeR + dr;
      const c = safeC + dc;
      if (r >= 0 && r < rows && c >= 0 && c < cols) forbidden.add(r * cols + c);
    }
  const candidates: number[] = [];
  for (let i = 0; i < rows * cols; i++) if (!forbidden.has(i)) candidates.push(i);
  // Fisher-Yates 洗牌取前 mines 个
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  for (let k = 0; k < Math.min(mines, candidates.length); k++) {
    const idx = candidates[k];
    grid[Math.floor(idx / cols)][idx % cols].mine = true;
  }
  // 计算相邻地雷数
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (grid[r][c].mine) continue;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && grid[rr][cc].mine) n++;
        }
      grid[r][c].adjacent = n;
    }
  return grid;
}

function floodReveal(grid: Grid, r: number, c: number): Grid {
  const rows = grid.length;
  const cols = grid[0].length;
  const next = grid.map((row) => row.map((cell) => ({ ...cell })));
  const stack: [number, number][] = [[r, c]];
  while (stack.length) {
    const [cr, cc] = stack.pop()!;
    const cell = next[cr][cc];
    if (cell.mine || cell.state !== 'hidden') continue;
    cell.state = 'revealed';
    if (cell.adjacent > 0) continue;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const rr = cr + dr;
        const cc2 = cc + dc;
        if (rr >= 0 && rr < rows && cc2 >= 0 && cc2 < cols && next[rr][cc2].state === 'hidden') {
          stack.push([rr, cc2]);
        }
      }
  }
  return next;
}

export default function Minesweeper() {
  const [levelIdx, setLevelIdx] = useState(0);
  const level = LEVELS[levelIdx];
  const [grid, setGrid] = useState<Grid>(() => buildGrid(level.rows, level.cols, level.mines, 0, 0));
  const [status, setStatus] = useState<'playing' | 'won' | 'lost'>('playing');
  const [time, setTime] = useState(0);
  const [firstClick, setFirstClick] = useState(false);
  const [shake, setShake] = useState(0); // 震屏触发器
  const timerRef = useRef<number | null>(null);
  const best = useBestScore(meta.id);
  const { toast } = useToast();

  useEffect(() => {
    if (status === 'playing') {
      timerRef.current = window.setInterval(() => setTime((t) => t + 1), 1000);
    }
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [status]);

  // 通关时记录最佳时间
  useEffect(() => {
    if (status === 'won') {
      sfx.win();
      if (time > 0) {
        const isNew = best.updateBest(time, (a, b) => a < b);
        if (isNew) {
          sfx.record();
          toast(`新纪录！最快 ${time}s 通关`, 'record');
        }
      }
    }
    if (status === 'lost') {
      sfx.lose();
      toast('踩到地雷了，再来一次！', 'info');
    }
  }, [status, time, best, toast]);

  const startNew = useCallback(
    (idx: number) => {
      const lv = LEVELS[idx];
      setLevelIdx(idx);
      setGrid(buildGrid(lv.rows, lv.cols, lv.mines, 0, 0));
      setStatus('playing');
      setTime(0);
      setFirstClick(false);
    },
    [],
  );

  const reveal = (r: number, c: number) => {
    if (status !== 'playing') return;
    setGrid((prev) => {
      const cell = prev[r][c];
      if (cell.state !== 'hidden') return prev;
      // 首次点击：重建棋盘确保安全
      const g = firstClick ? prev : buildGrid(level.rows, level.cols, level.mines, r, c);
      const target = g[r][c];
      if (target.mine) {
        const exploded = g.map((row) => row.map((x) => ({ ...x })));
        exploded.forEach((row) => row.forEach((x) => { if (x.mine && x.state === 'hidden') x.state = 'revealed'; }));
        setStatus('lost');
        setShake((s) => s + 1);
        return exploded;
      }
      const revealed = floodReveal(g, r, c);
      const allSafe = revealed.flat().filter((x) => !x.mine).every((x) => x.state === 'revealed');
      if (allSafe) setStatus('won');
      else if (revealed[r][c].adjacent === 0) sfx.move();
      return revealed;
    });
    if (!firstClick) setFirstClick(true);
  };

  const flag = (e: React.MouseEvent, r: number, c: number) => {
    e.preventDefault();
    if (status !== 'playing') return;
    setGrid((prev) => {
      const next = prev.map((row) => row.map((x) => ({ ...x })));
      const cell = next[r][c];
      if (cell.state === 'hidden') cell.state = 'flagged';
      else if (cell.state === 'flagged') cell.state = 'hidden';
      return next;
    });
  };

  const flagsLeft = grid.flat().filter((x) => x.state === 'flagged').length;
  const minesLeft = level.mines - flagsLeft;

  // 触屏长按插旗
  const longPressRef = useRef<{ timer: number | null; fired: boolean }>({ timer: null, fired: false });
  const touchStart = (r: number, c: number) => {
    longPressRef.current.fired = false;
    longPressRef.current.timer = window.setTimeout(() => {
      longPressRef.current.fired = true;
      flag({ preventDefault: () => undefined } as React.MouseEvent, r, c);
      sfx.flip();
    }, 420);
  };
  const touchEnd = (e: React.TouchEvent, r: number, c: number) => {
    e.preventDefault(); // 阻止合成 click，避免与 touchEnd 的 reveal 冲突
    if (longPressRef.current.timer) {
      window.clearTimeout(longPressRef.current.timer);
      longPressRef.current.timer = null;
    }
    // 短按（未触发长按）则翻开
    if (!longPressRef.current.fired) reveal(r, c);
  };

  const cellSize = level.cols >= 30 ? 28 : level.cols >= 16 ? 34 : 46;

  return (
    <GameShell
      meta={meta}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>剩余雷</span>
            <strong>{minesLeft}</strong>
          </div>
          <div className="stat-box">
            <span>时间</span>
            <strong>{time}s</strong>
          </div>
          <div className="stat-box">
            <span>{meta.bestScoreLabel}</span>
            <strong>{best.value ? `${best.value}s` : '--'}</strong>
          </div>
        </>
      }
    >
      <div className="mines">
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
          <button className="btn btn-primary" onClick={() => startNew(levelIdx)}>
            🔄 新游戏
          </button>
        </div>
        {status !== 'playing' && (
          <div className={`banner ${status}`}>
            {status === 'won' ? `🎉 恭喜通关！用时 ${time}s` : '💥 踩到地雷了！'}
          </div>
        )}
        <div
          key={shake}
          className={`mines-grid ${shake > 0 ? 'shake' : ''}`}
          style={{
            gridTemplateColumns: `repeat(${level.cols}, ${cellSize}px)`,
          }}
        >
          {grid.map((row, r) =>
            row.map((cell, c) => (
              <button
                key={`${r}-${c}`}
                className={`mines-cell ${cell.state} ${cell.state === 'revealed' && cell.adjacent > 0 ? `n${cell.adjacent}` : ''}`}
                style={{ width: cellSize, height: cellSize, fontSize: cellSize * 0.5 }}
                onClick={() => reveal(r, c)}
                onContextMenu={(e) => flag(e, r, c)}
                onTouchStart={() => touchStart(r, c)}
                onTouchEnd={(e) => touchEnd(e, r, c)}
              >
                {cell.state === 'flagged' && '🚩'}
                {cell.state === 'revealed' && (cell.mine ? '💥' : cell.adjacent > 0 ? cell.adjacent : '')}
              </button>
            )),
          )}
        </div>
        <p className="hint">左键翻开 · 右键插旗 🚩 · 触屏长按插旗</p>
      </div>
    </GameShell>
  );
}
