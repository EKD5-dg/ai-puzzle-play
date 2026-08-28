import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaSnake } from '../core/gameMetas';



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
  // 切后台自动暂停：后台 setInterval 被节流为 1s/次，蛇会以约 1 格/秒继续爬，切回常已撞死
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') setStatus((s) => (s === 'playing' ? 'paused' : s));
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  const best = useBestScore(metaSnake.id);
  const { toast } = useToast();
  const dirRef = useRef<Dir>('right');
  /** 上次 tick 实际应用的方向（180° 掉头守卫的基准，防止同 tick 双按键绕过） */
  const lastAppliedRef = useRef<Dir>('right');
  const snakeRef = useRef(snake);
  const foodRef = useRef(food);
  const statusRef = useRef(status);
  const scoreRef = useRef(score);

  snakeRef.current = snake;
  foodRef.current = food;
  statusRef.current = status;
  scoreRef.current = score;

  const start = useCallback(() => {
    setSnake([{ x: 10, y: 10 }]);
    setFood(randFood([{ x: 10, y: 10 }]));
    dirRef.current = 'right';
    lastAppliedRef.current = 'right';
    scoreRef.current = 0;
    setScore(0);
    setSpeed(1);
    setStatus('playing');
  }, []);

  // 游戏循环
  useEffect(() => {
    if (status !== 'playing') return;
    // 速度下限 90ms/格（≈11 格/秒）：无下限的最高速接近不可反应区间
    const tick = Math.max(90, 170 - (speed - 1) * 12);
    const t = window.setInterval(() => {
      const cur = snakeRef.current;
      const d = DIRS[dirRef.current];
      lastAppliedRef.current = dirRef.current;
      const head = { x: cur[0].x + d.x, y: cur[0].y + d.y };
      // 撞墙
      if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
        sfx.lose();
        setStatus('over');
        return;
      }
      const ate = head.x === foodRef.current.x && head.y === foodRef.current.y;
      // 撞自己（不进食时尾格本 tick 会腾空，移入尾格是合法移动）
      const bodyForCollision = ate ? cur : cur.slice(0, -1);
      if (bodyForCollision.some((p) => p.x === head.x && p.y === head.y)) {
        sfx.lose();
        setStatus('over');
        return;
      }
      const next = [head, ...cur];
      if (!ate) next.pop();
      setSnake(next);
      if (ate) {
        sfx.merge();
        const ns = scoreRef.current + 10;
        scoreRef.current = ns;
        setScore(ns);
        setSpeed(Math.min(9, Math.floor(ns / 30) + 1));
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
        // 禁止 180° 掉头（以"上次 tick 应用的方向"为基准，同 tick 双按键也无法绕过）
        const cur = lastAppliedRef.current;
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
  }, [start]);

  // 触屏滑动（记录手指 id：多指时只响应最初那根手指）
  const touchRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    if (touchRef.current) return; // 忽略第二根手指，避免污染滑动基准
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY, id: t.identifier };
    if (statusRef.current === 'ready') start();
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const base = touchRef.current;
    if (!base) return;
    const t = Array.from(e.changedTouches).find((t) => t.identifier === base.id);
    if (!t) return; // 抬起的不是被追踪的那根手指
    touchRef.current = null; // 先清基准：短按（<20px）也要释放，否则后续触摸全部被忽略
    const dx = t.clientX - base.x;
    const dy = t.clientY - base.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
    const d: Dir =
      Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    const cur = lastAppliedRef.current;
    const opp: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };
    if (opp[cur] !== d) {
      dirRef.current = d;
    }
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
      meta={metaSnake}
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
            <span>{metaSnake.bestScoreLabel}</span>
            <strong>{best.value ?? 0}</strong>
          </div>
        </>
      }
    >
      <div className="snake" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div
          className="snake-board"
          style={{ gridTemplateColumns: `repeat(${COLS}, var(--snake-cell, ${cell}px))` }}
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
                  style={{ width: 'var(--snake-cell, 22px)', height: 'var(--snake-cell, 22px)' }}
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
        <p className="hint">方向键/WASD 转向 · 空格暂停/继续 · 触屏滑动控制</p>
      </div>
    </GameShell>
  );
}
