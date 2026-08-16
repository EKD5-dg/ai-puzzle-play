import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { meta2048 } from '../core/gameMetas';



const SIZE = 4;
const CELLS = SIZE * SIZE;

type Board = number[];

/** 每个格子配色 */
const TILE_COLORS: Record<number, string> = {
  2: '#eee4da',
  4: '#ede0c8',
  8: '#f2b179',
  16: '#f59563',
  32: '#f67c5f',
  64: '#f65e3b',
  128: '#edcf72',
  256: '#edcc61',
  512: '#edc850',
  1024: '#edc53f',
  2048: '#edc22e',
};

function tileColor(v: number): string {
  if (v >= 4096) return '#3c3a32';
  return TILE_COLORS[v] ?? '#3c3a32';
}

function tileTextColor(v: number): string {
  return v <= 4 ? '#776e65' : '#f9f6f2';
}

/** 在空位随机生成 2 或 4 */
function spawn(board: Board): Board {
  const empty = board.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
  if (empty.length === 0) return board;
  const idx = empty[Math.floor(Math.random() * empty.length)];
  const next = [...board];
  next[idx] = Math.random() < 0.9 ? 2 : 4;
  return next;
}

function newBoard(): Board {
  return spawn(spawn(Array(CELLS).fill(0)));
}

/** 单行左移合并：返回 [新行, 得分] */
function slideRow(row: number[]): [number[], number] {
  const filtered = row.filter((v) => v !== 0);
  const out: number[] = [];
  let score = 0;
  for (let i = 0; i < filtered.length; i++) {
    if (i + 1 < filtered.length && filtered[i] === filtered[i + 1]) {
      const merged = filtered[i] * 2;
      out.push(merged);
      score += merged;
      i++;
    } else {
      out.push(filtered[i]);
    }
  }
  while (out.length < SIZE) out.push(0);
  return [out, score];
}

type Dir = 'up' | 'down' | 'left' | 'right';

/** 按方向提取行列 → 左移合并 → 放回 */
function moveBoard(board: Board, dir: Dir): { board: Board; score: number; moved: boolean } {
  const grid: number[][] = Array.from({ length: SIZE }, (_, r) =>
    board.slice(r * SIZE, r * SIZE + SIZE),
  );
  const getRow = (r: number) => grid[r];
  const setRow = (r: number, row: number[]) => {
    grid[r] = row;
  };
  const getCol = (c: number) => grid.map((row) => row[c]);
  const setCol = (c: number, col: number[]) => {
    col.forEach((v, r) => {
      grid[r][c] = v;
    });
  };

  let gainedTotal = 0;
  for (let i = 0; i < SIZE; i++) {
    const line = dir === 'left' ? getRow(i) : dir === 'right' ? [...getRow(i)].reverse() : dir === 'up' ? getCol(i) : [...getCol(i)].reverse();
    const [newLine, gained] = slideRow(line);
    gainedTotal += gained;
    const reversed = dir === 'right' || dir === 'down' ? [...newLine].reverse() : newLine;
    if (dir === 'left' || dir === 'right') setRow(i, reversed);
    else setCol(i, reversed);
  }

  const flat = grid.flat();
  const moved = flat.some((v, i) => v !== board[i]);
  return { board: flat, score: gainedTotal, moved };
}

function canMove(board: Board): boolean {
  if (board.some((v) => v === 0)) return true;
  for (let i = 0; i < CELLS; i++) {
    const r = Math.floor(i / SIZE);
    const c = i % SIZE;
    const neighbors = [
      r > 0 ? i - SIZE : -1,
      r < SIZE - 1 ? i + SIZE : -1,
      c > 0 ? i - 1 : -1,
      c < SIZE - 1 ? i + 1 : -1,
    ];
    for (const n of neighbors) {
      if (n >= 0 && board[n] === board[i]) return true;
    }
  }
  return false;
}

const DIR_KEYS: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
  W: 'up',
  S: 'down',
  A: 'left',
  D: 'right',
};

export default function Game2048() {
  const [board, setBoard] = useState<Board>(newBoard);
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);
  const [won, setWon] = useState(false);
  /** 达成 2048 后玩家选择"继续挑战"时隐藏成就遮罩 */
  const [dismissed, setDismissed] = useState(false);
  const [scorePop, setScorePop] = useState(0); // 触发分数动画
  const best = useBestScore(meta2048.id);
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const { toast } = useToast();

  const doMove = useCallback(
    (dir: Dir) => {
      // 终局拦截：over 恒拦截；won 且玩家选择了"继续挑战"（dismissed）后允许继续
      if (over || (won && !dismissed)) return;
      const { board: next, score: gained, moved } = moveBoard(board, dir);
      if (!moved) return;
      const spawned = spawn(next);
      setBoard(spawned);
      if (gained > 0) {
        sfx.merge();
        setScore((s) => s + gained);
        setScorePop((p) => p + 1);
      }
      if (!won && spawned.some((v) => v >= 2048)) {
        setWon(true);
        sfx.win();
        toast('达成 2048！可以继续冲击更高分', 'success');
      }
      if (!canMove(spawned)) {
        setOver(true);
        sfx.lose();
        toast('没有可移动的格子了', 'info');
      }
    },
    [board, over, won, dismissed, toast],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = DIR_KEYS[e.key];
      if (dir) {
        e.preventDefault();
        sfx.move();
        doMove(dir);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doMove]);

  useEffect(() => {
    if (score > 0) {
      const isNew = best.updateBest(score, (a, b) => a > b);
      if (isNew) {
        sfx.record();
        toast(`新纪录！最高分 ${score}`, 'record');
      }
    }
  }, [score, best, toast]);

  const restart = () => {
    setBoard(newBoard());
    setScore(0);
    setOver(false);
    setWon(false);
    setDismissed(false);
  };

  const onTouchStart = (e: React.TouchEvent) => {
    touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touchRef.current) return;
    const dx = e.changedTouches[0].clientX - touchRef.current.x;
    const dy = e.changedTouches[0].clientY - touchRef.current.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    doMove(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
    touchRef.current = null;
  };

  return (
    <GameShell
      meta={meta2048}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>分数</span>
            <strong key={scorePop} className={scorePop > 0 ? 'score-pop' : ''}>{score}</strong>
          </div>
          <div className="stat-box">
            <span>{meta2048.bestScoreLabel}</span>
            <strong>{best.value ?? 0}</strong>
          </div>
          <button className="btn btn-primary" onClick={restart}>
            重新开始
          </button>
        </>
      }
    >
      <div className="g2048" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="g2048-grid" style={{ gridTemplateColumns: `repeat(${SIZE}, 1fr)` }}>
          {board.map((v, i) => (
            <div key={i} className="g2048-cell" style={{ background: v ? tileColor(v) : 'rgba(238,228,218,0.35)', color: v ? tileTextColor(v) : 'transparent' }}>
              {v > 0 && <span className="g2048-tile" key={`${v}-${i}`}>{v}</span>}
            </div>
          ))}
        </div>
        {(over || (won && !dismissed)) && (
          <div className="g2048-overlay">
            <h2>{over ? '💀 没有可移动的格子了' : '🎉 你合成了 2048！'}</h2>
            <p>最终得分 {score}</p>
            {won && !over && (
              <button className="btn btn-primary" onClick={() => setDismissed(true)}>
                🚀 继续挑战更高分
              </button>
            )}
            <button className="btn btn-ghost" onClick={restart}>
              再来一局
            </button>
          </div>
        )}
        <p className="hint">使用 ↑ ↓ ← → 或 W A S D 移动，手机可滑动</p>
      </div>
    </GameShell>
  );
}
