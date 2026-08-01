import { useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import type { GameMeta } from '../core/types';

export const meta: GameMeta = {
  id: 'snake',
  title: '贪吃蛇',
  description: '吃食物变长，避开墙壁和自己！',
  icon: '🐍',
  difficulty: '简单',
  category: '经典',
  tags: ['经典', '街机'],
  bestScoreLabel: '最高分',
};

const COLS = 20;
const ROWS = 20;

type Point = { x: number; y: number };
type Dir = 'up' | 'down' | 'left' | 'right';

const DIRS: Record<Dir, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const KEY_DIRS: Record<string, Dir> = {
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

function randFood(snake: Point[]): Point {
  const taken = new Set(snake.map((p) => `${p.x},${p.y}`));
  const free: Point[] = [];
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++) {
      if (!taken.has(`${x},${y}`)) free.push({ x, y });
    }
  return free[Math.floor(Math.random() * free.length)] ?? { x: 0, y: 0 };
}

export default function Snake() {
  const [snake, setSnake] = useState<Point[]>([{ x: 10, y: 10 }]);
  const [food, setFood] = useState<Point>(() => randFood([{ x: 10, y: 10 }]));
  const [score, setScore] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [status, setStatus] = useState<'ready' | 'playing' | 'paused' | 'over'>('ready');
  const best = useBestScore(meta.id);
  const { toast } = useToast();
  const dirRef = useRef<Dir>('right');
  const snakeRef = useRef(snake);
  const foodRef = useRef(food);
  const statusRef = useRef(status);

  snakeRef.current = snake;
  foodRef.current = food;
  statusRef.current = status;

  const start = () => {
    setSnake([{ x: 10, y: 10 }]);
    setFood(randFood([{ x: 10, y: 10 }]));
    dirRef.current = 'right';
    setScore(0);
    setSpeed(1);
    setStatus('playing');
  };

  // 游戏循环
  useEffect(() => {
    if (status !== 'playing') return;
    const tick = 170 - (speed - 1) * 12;
    const t = window.setInterval(() => {
      const cur = snakeRef.current;
      const d = DIRS[dirRef.current];
      const head = { x: cur[0].x + d.x, y: cur[0].y + d.y };
      // 撞墙
      if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
        sfx.lose();
        setStatus('over');
        return;
      }
      // 撞自己
      if (cur.some((p) => p.x === head.x && p.y === head.y)) {
        sfx.lose();
        setStatus('over');
        return;
      }
      const ate = head.x === foodRef.current.x && head.y === foodRef.current.y;
      const next = [head, ...cur];
      if (!ate) next.pop();
      setSnake(next);
      if (ate) {
        sfx.merge();
        setScore((s) => {
          const ns = s + 10;
          setSpeed(Math.min(9, Math.floor(ns / 30) + 1));
          return ns;
        });
        setFood(randFood(next));
      }
    }, tick);
    return () => window.clearInterval(t);
  }, [status, speed]);

  // 键盘控制
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = KEY_DIRS[e.key];
      if (d) {
        e.preventDefault();
        if (statusRef.current === 'ready') start();
        // 禁止 180° 掉头
        const cur = dirRef.current;
        const opp: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };
        if (opp[cur] !== d) {
          dirRef.current = d;
        }
        return;
      }
      if (e.key === ' ' || e.key === 'p' || e.key === 'P') {
        if (statusRef.current === 'playing') setStatus('paused');
        else if (statusRef.current === 'paused') setStatus('playing');
        else if (statusRef.current === 'over') start();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 触屏滑动
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (statusRef.current === 'ready') start();
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touchRef.current) return;
    const dx = e.changedTouches[0].clientX - touchRef.current.x;
    const dy = e.changedTouches[0].clientY - touchRef.current.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
    const d: Dir =
      Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    const cur = dirRef.current;
    const opp: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };
    if (opp[cur] !== d) {
      dirRef.current = d;
    }
    touchRef.current = null;
  };

  // 记录最高分
  useEffect(() => {
    if (status === 'over' && score > 0) {
      const isNew = best.updateBest(score, (a, b) => a > b);
      if (isNew) {
        sfx.record();
        toast(`新纪录！${score} 分`, 'record');
      }
    }
  }, [status, score, best, toast]);

  const cell = 22;
  const snakeSet = new Set(snake.map((p) => `${p.x},${p.y}`));

  return (
    <GameShell
      meta={meta}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>分数</span>
            <strong>{score}</strong>
          </div>
          <div className="stat-box">
            <span>长度</span>
            <strong>{snake.length}</strong>
          </div>
          <div className="stat-box">
            <span>速度</span>
            <strong>{speed}</strong>
          </div>
          <div className="stat-box">
            <span>{meta.bestScoreLabel}</span>
            <strong>{best.value ?? 0}</strong>
          </div>
        </>
      }
    >
      <div className="snake" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div
          className="snake-board"
          style={{ gridTemplateColumns: `repeat(${COLS}, ${cell}px)` }}
        >
          {Array.from({ length: ROWS }, (_, y) =>
            Array.from({ length: COLS }, (_, x) => {
              const isHead = snake[0]?.x === x && snake[0]?.y === y;
              const isBody = !isHead && snakeSet.has(`${x},${y}`);
              const isFood = food.x === x && food.y === y;
              return (
                <div
                  key={`${y}-${x}`}
                  className={`snake-cell ${isHead ? 'head' : ''} ${isBody ? 'body' : ''} ${isFood ? 'food' : ''}`}
                  style={{ width: cell, height: cell }}
                />
              );
            }),
          )}
          {status === 'ready' && (
            <div className="snake-overlay">
              <h2>🐍 贪吃蛇</h2>
              <p>方向键/WASD 或滑动开始游戏</p>
              <button className="btn btn-primary" onClick={start}>
                开始游戏
              </button>
            </div>
          )}
          {status === 'paused' && (
            <div className="snake-overlay">
              <h2>⏸ 已暂停</h2>
              <button className="btn btn-primary" onClick={() => setStatus('playing')}>
                继续
              </button>
            </div>
          )}
          {status === 'over' && (
            <div className="snake-overlay">
              <h2>💀 游戏结束</h2>
              <p>
                得分 {score} · 长度 {snake.length}
              </p>
              <button className="btn btn-primary" onClick={start}>
                再来一局
              </button>
            </div>
          )}
        </div>
        <p className="hint">方向键/WASD 转向 · 空格/滑动暂停 · 触屏滑动控制</p>
      </div>
    </GameShell>
  );
}
