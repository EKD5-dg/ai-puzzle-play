import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaTetris } from '../core/gameMetas';



const COLS = 10;
const ROWS = 20;

type Shape = number[][];

const SHAPES: Record<string, { shape: Shape; color: string }> = {
  I: { shape: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]], color: '#00d4ff' },
  O: { shape: [[1, 1], [1, 1]], color: '#ffd700' },
  T: { shape: [[0, 1, 0], [1, 1, 1], [0, 0, 0]], color: '#b453ff' },
  S: { shape: [[0, 1, 1], [1, 1, 0], [0, 0, 0]], color: '#34d399' },
  Z: { shape: [[1, 1, 0], [0, 1, 1], [0, 0, 0]], color: '#f87171' },
  J: { shape: [[1, 0, 0], [1, 1, 1], [0, 0, 0]], color: '#60a5fa' },
  L: { shape: [[0, 0, 1], [1, 1, 1], [0, 0, 0]], color: '#fb923c' },
};

const KEYS = Object.keys(SHAPES);

function rotateCW(shape: Shape): Shape {
  const n = shape.length;
  const out = Array.from({ length: n }, () => Array(n).fill(0));
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) out[c][n - 1 - r] = shape[r][c];
  return out;
}

/** 7-bag 随机：保证每种方块出现频率均匀 */
function makeBag(): string[] {
  const bag = [...KEYS];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

interface Active {
  type: string;
  shape: Shape;
  x: number;
  y: number;
}

type Board = (string | null)[][]; // 颜色字符串

function emptyBoard(): Board {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function collides(board: Board, shape: Shape, x: number, y: number): boolean {
  for (let r = 0; r < shape.length; r++)
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const bx = x + c;
      const by = y + r;
      if (bx < 0 || bx >= COLS || by >= ROWS) return true;
      if (by >= 0 && board[by][bx]) return true;
    }
  return false;
}

function merge(board: Board, active: Active): Board {
  const next = board.map((row) => [...row]);
  const { shape, x, y, type } = active;
  for (let r = 0; r < shape.length; r++)
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const by = y + r;
      if (by >= 0) next[by][x + c] = SHAPES[type].color;
    }
  return next;
}

function clearLines(board: Board): { board: Board; lines: number } {
  const remaining = board.filter((row) => row.some((cell) => cell === null));
  const cleared = ROWS - remaining.length;
  while (remaining.length < ROWS) remaining.unshift(Array(COLS).fill(null));
  return { board: remaining, lines: cleared };
}

function levelSpeed(level: number): number {
  return Math.max(90, 750 - (level - 1) * 70);
}

const LINE_SCORES = [0, 100, 300, 500, 800];

export default function Tetris() {
  const [board, setBoard] = useState<Board>(emptyBoard);
  const [active, setActive] = useState<Active | null>(null);
  const [nextType, setNextType] = useState<string>(() => makeBag()[0]);
  const [score, setScore] = useState(0);
  const [lines, setLines] = useState(0);
  const [level, setLevel] = useState(1);
  const [gameOver, setGameOver] = useState(false);
  const [paused, setPaused] = useState(false);
  const [flash, setFlash] = useState(0); // 消行闪光触发器
  const [flashing, setFlashing] = useState(false); // 消行动画播放中（避免整盘重建）
  const bagRef = useRef<string[]>(makeBag());
  const boardRef = useRef(board);
  const activeRef = useRef(active);
  /** nextType 实时镜像：lock 时用预览块作为下一个当前块 */
  const nextTypeRef = useRef<string>(makeBag()[0]);
  nextTypeRef.current = nextType;
  const best = useBestScore(metaTetris.id);
  const { toast } = useToast();
  const gameOverRef = useRef(false);
  const initRef = useRef(false);

  boardRef.current = board;
  activeRef.current = active;

  // 消行闪光动画：类切换 + 定时移除，不用 key 重建 200 格 DOM
  useEffect(() => {
    if (flash === 0) return;
    setFlashing(true);
    const t = window.setTimeout(() => setFlashing(false), 300);
    return () => window.clearTimeout(t);
  }, [flash]);

  const pullNext = useCallback((): string => {
    if (bagRef.current.length === 0) bagRef.current = makeBag();
    return bagRef.current.pop()!;
  }, []);

  const spawn = useCallback(
    (type: string) => {
      const shape = SHAPES[type].shape;
      const x = Math.floor((COLS - shape[0].length) / 2);
      const y = 0;
      if (collides(boardRef.current, shape, x, y)) {
        gameOverRef.current = true;
        return null;
      }
      return { type, shape, x, y } as Active;
    },
    [],
  );

  const lock = useCallback((customActive?: Active) => {
    const cur = customActive ?? activeRef.current;
    if (!cur) return;
    const merged = merge(boardRef.current, cur);
    const { board: cleared, lines: n } = clearLines(merged);
    boardRef.current = cleared;
    setBoard(cleared);
    setLines((l) => l + n);
    if (n > 0) {
      sfx.clear();
      setFlash((f) => f + 1);
    } else {
      sfx.drop();
    }
    setScore((s) => s + LINE_SCORES[n] * level);
    if (n > 0) setLevel((lv) => Math.min(15, lv + Math.floor(n / 2)));
    // 下一个当前块 = 预览块（7-bag 连续抽取），预览再抽下一个
    const next = spawn(nextTypeRef.current);
    setNextType(pullNext());
    if (!next) {
      setGameOver(true);
      gameOverRef.current = true;
      sfx.lose();
      toast('游戏结束，再战一局！', 'info');
    } else {
      setActive(next);
    }
  }, [level, pullNext, spawn, toast]);

  // 初始化（幂等：StrictMode dev 下 effect 双执行不会重复抽块）
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    // 当前块先抽、预览后抽，与 lock 的抽取顺序一致（保证预览 = 下一个实际落下的块）
    setActive(spawn(pullNext()));
    setNextType(pullNext());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const move = useCallback(
    (dx: number, dy: number, silent = false): boolean => {
      const cur = activeRef.current;
      if (!cur || gameOverRef.current || paused) return false;
      const x = cur.x + dx;
      const y = cur.y + dy;
      if (collides(boardRef.current, cur.shape, x, y)) return false;
      setActive({ ...cur, x, y });
      if (!silent) sfx.move();
      return true;
    },
    [paused],
  );

  const rotate = useCallback(() => {
    const cur = activeRef.current;
    if (!cur || gameOverRef.current || paused) return;
    const rotated = rotateCW(cur.shape);
    // 简单踢墙：尝试左/右偏移 1
    for (const dx of [0, -1, 1, -2, 2]) {
      if (!collides(boardRef.current, rotated, cur.x + dx, cur.y)) {
        setActive({ ...cur, shape: rotated, x: cur.x + dx });
        sfx.flip();
        return;
      }
    }
  }, [paused]);

  const hardDrop = useCallback(() => {
    const cur = activeRef.current;
    if (!cur || gameOverRef.current || paused) return;
    let y = cur.y;
    while (!collides(boardRef.current, cur.shape, cur.x, y + 1)) y++;
    setScore((s) => s + (y - cur.y) * 2);
    const dropped = { ...cur, y };
    setActive(dropped);
    lock(dropped);
  }, [lock, paused]);

  const softDrop = useCallback(() => {
    // 静音下落：重力循环与 ↓ 键都不播移动音效（高等级时避免声音密集）
    if (!move(0, 1, true)) lock();
  }, [move, lock]);

  // 重力循环
  useEffect(() => {
    if (gameOver || paused) return;
    const t = window.setInterval(() => softDrop(), levelSpeed(level));
    return () => window.clearInterval(t);
  }, [gameOver, paused, level, softDrop]);

  // 键盘控制
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          move(-1, 0);
          break;
        case 'ArrowRight':
          e.preventDefault();
          move(1, 0);
          break;
        case 'ArrowDown':
          e.preventDefault();
          softDrop();
          break;
        case 'ArrowUp':
          e.preventDefault();
          rotate();
          break;
        case ' ':
          e.preventDefault();
          hardDrop();
          break;
        case 'p':
        case 'P':
          if (!gameOver) setPaused((p) => !p);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, softDrop, rotate, hardDrop, gameOver]);

  // 记录最高分
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
    bagRef.current = makeBag();
    gameOverRef.current = false;
    boardRef.current = emptyBoard();
    setBoard(boardRef.current);
    setActive(spawn(pullNext()));
    setNextType(pullNext());
    setScore(0);
    setLines(0);
    setLevel(1);
    setGameOver(false);
    setPaused(false);
  };

  // 渲染棋盘（含当前方块）
  const display: Board = board.map((row) => [...row]);
  if (active && !gameOver) {
    const { shape, x, y, type } = active;
    for (let r = 0; r < shape.length; r++)
      for (let c = 0; c < shape[r].length; c++) {
        if (!shape[r][c]) continue;
        const by = y + r;
        if (by >= 0) display[by][x + c] = SHAPES[type].color;
      }
  }

  return (
    <GameShell
      meta={metaTetris}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>分数</span>
            <strong>{score}</strong>
          </div>
          <div className="stat-box">
            <span>行数</span>
            <strong>{lines}</strong>
          </div>
          <div className="stat-box">
            <span>等级</span>
            <strong>{level}</strong>
          </div>
          <div className="stat-box">
            <span>{metaTetris.bestScoreLabel}</span>
            <strong>{best.value ?? 0}</strong>
          </div>
        </>
      }
    >
      <div className="tetris">
        <div className="tetris-main">
          <div
            className={`tetris-board ${flashing ? 'flash' : ''}`}
            style={{ gridTemplateColumns: `repeat(${COLS}, var(--tet-cell, 30px))` }}
          >
            {display.map((row, r) =>
              row.map((cell, c) => (
                <div
                  key={`${r}-${c}`}
                  className="tetris-cell"
                  style={{ background: cell ?? 'rgba(255,255,255,0.05)' }}
                />
              )),
            )}
            {paused && !gameOver && <div className="tetris-overlay">⏸ 已暂停</div>}
            {gameOver && (
              <div className="tetris-overlay">
                <h2>💀 游戏结束</h2>
                <p>
                  得分 {score} · 消除 {lines} 行
                </p>
                <button className="btn btn-primary" onClick={restart}>
                  再来一局
                </button>
              </div>
            )}
          </div>
          <div className="tetris-side">
            <div className="tetris-next">
              <span>下一个</span>
              <div
                className="tetris-preview"
                style={{ gridTemplateColumns: `repeat(4, 22px)` }}
              >
                {SHAPES[nextType].shape.flat().map((v, i) => (
                  <div
                    key={i}
                    style={{
                      background: v ? SHAPES[nextType].color : 'transparent',
                    }}
                  />
                ))}
              </div>
            </div>
            <button className="btn btn-ghost" onClick={() => setPaused((p) => !p)}>
              {paused ? '▶ 继续' : '⏸ 暂停'}
            </button>
            <div className="tetris-controls">
              <button className="btn btn-ghost" onClick={() => move(-1, 0)}>←</button>
              <button className="btn btn-ghost" onClick={rotate}>↻</button>
              <button className="btn btn-ghost" onClick={() => move(1, 0)}>→</button>
              <button className="btn btn-ghost" onClick={softDrop}>↓</button>
              <button className="btn btn-ghost" onClick={hardDrop}>⤓</button>
            </div>
          </div>
        </div>
        <p className="hint">← → 移动 · ↑ 旋转 · ↓ 加速下落 · 空格 硬降 · P 暂停</p>
      </div>
    </GameShell>
  );
}
