import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useLocalStorage } from '../core/useLocalStorage';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import type { GameMeta } from '../core/types';

export const meta: GameMeta = {
  id: 'frogger',
  title: '青蛙过河',
  description: '躲过车流、踏着浮木，把青蛙送回家！',
  icon: '🐸',
  difficulty: '中等',
  category: '经典',
  tags: ['日系', '躲避'],
  bestScoreLabel: '最高分',
};

const W = 480;
const H = 440;
const ROWS = 12;
const ROW_H = H / ROWS;

interface Lane {
  kind: 'road' | 'river' | 'safe';
  dir: 1 | -1;
  speed: number;
  /** 车/浮木间隔与宽度 */
  items: Array<{ x: number; w: number }>;
}

function buildLanes(level: number): Lane[] {
  const speedMul = 1 + (level - 1) * 0.25;
  const lanes: Lane[] = [];
  // row0: 起点安全区；row1-4: 道路；row5: 安全岛；row6-9: 河流；row10: 安全区（目标）；row11: 目标线
  const defs = [
    { kind: 'safe', dir: 1 as const, speed: 0, items: [] },
    { kind: 'road', dir: 1 as const, speed: 2.4 * speedMul, items: [] },
    { kind: 'road', dir: -1 as const, speed: 3 * speedMul, items: [] },
    { kind: 'road', dir: 1 as const, speed: 3.6 * speedMul, items: [] },
    { kind: 'road', dir: -1 as const, speed: 4.4 * speedMul, items: [] },
    { kind: 'safe', dir: 1 as const, speed: 0, items: [] },
    { kind: 'river', dir: 1 as const, speed: 1.8 * speedMul, items: [] },
    { kind: 'river', dir: -1 as const, speed: 2.4 * speedMul, items: [] },
    { kind: 'river', dir: 1 as const, speed: 3 * speedMul, items: [] },
    { kind: 'river', dir: -1 as const, speed: 3.6 * speedMul, items: [] },
    { kind: 'safe', dir: 1 as const, speed: 0, items: [] },
    { kind: 'safe', dir: 1 as const, speed: 0, items: [] },
  ];
  defs.forEach((d, i) => {
    const lane: Lane = { kind: d.kind as Lane['kind'], dir: d.dir, speed: d.speed, items: [] };
    if (lane.kind !== 'safe') {
      const spacing = lane.kind === 'road' ? 130 - level * 4 : 150 - level * 4;
      const w = lane.kind === 'road' ? 46 : 62;
      for (let x = -20; x < W + 20; x += spacing) {
        lane.items.push({ x: x + ((i * 37) % spacing), w });
      }
    }
    lanes.push(lane);
  });
  return lanes;
}

export default function Frogger() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'ready' | 'playing' | 'over' | 'win'>('ready');
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [level, setLevel] = useState(1);
  const best = useLocalStorage<number>(`best:${meta.id}`);
  const { toast } = useToast();

  const gameRef = useRef({
    frog: { x: W / 2 - 14, y: H - ROW_H + 8, onLog: null as { dx: number } | null },
    lanes: [] as Lane[],
    goals: Array(5).fill(false) as boolean[],
    deathTimer: 0,
  });

  // 静态背景层（车道/河流底色+线+目标洞），每帧直接贴图
  const bgRef = useRef<HTMLCanvasElement | null>(null);
  if (!bgRef.current) {
    const bg = document.createElement('canvas');
    bg.width = W;
    bg.height = H;
    const bctx = bg.getContext('2d');
    if (bctx) {
      buildLanes(1).forEach((lane, ri) => {
        const y = ri * ROW_H;
        if (lane.kind === 'safe') {
          bctx.fillStyle = ri === 11 ? '#1b3a2a' : '#1a2417';
          bctx.fillRect(0, y, W, ROW_H);
        } else if (lane.kind === 'road') {
          bctx.fillStyle = '#241d16';
          bctx.fillRect(0, y, W, ROW_H);
          bctx.fillStyle = 'rgba(255,255,255,0.15)';
          bctx.fillRect(0, y + ROW_H - 2, W, 2);
        } else {
          bctx.fillStyle = '#12294a';
          bctx.fillRect(0, y, W, ROW_H);
          bctx.fillStyle = 'rgba(255,255,255,0.08)';
          for (let x = 0; x < W; x += 24) bctx.fillRect(x + ((ri * 13) % 24), y + ROW_H - 2, 10, 2);
        }
      });
      // 目标洞（空状态，激活态动态绘制）
      for (let i = 0; i < 5; i++) {
        const gx = i * (W / 5) + W / 10 - 20;
        bctx.fillStyle = '#3a2a10';
        bctx.beginPath();
        bctx.arc(gx + 20, ROW_H / 2, 16, 0, Math.PI * 2);
        bctx.fill();
        bctx.strokeStyle = '#6b4f1d';
        bctx.lineWidth = 3;
        bctx.stroke();
      }
    }
    bgRef.current = bg;
  }

  const startGame = useCallback(() => {
    gameRef.current.frog = { x: W / 2 - 14, y: H - ROW_H + 8, onLog: null };
    gameRef.current.lanes = buildLanes(1);
    gameRef.current.goals = Array(5).fill(false);
    gameRef.current.deathTimer = 0;
    setScore(0);
    setLives(3);
    setLevel(1);
    setStatus('playing');
  }, []);

  const respawn = useCallback(() => {
    const g = gameRef.current;
    g.frog = { x: W / 2 - 14, y: H - ROW_H + 8, onLog: null };
  }, []);

  // 主循环
  useEffect(() => {
    if (status !== 'playing') return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      const g = gameRef.current;
      const cv = canvasRef.current;
      const ctx = cv?.getContext('2d');
      if (!cv || !ctx) return;

      // 移动车道/河流道具
      g.lanes.forEach((lane) => {
        if (lane.kind === 'safe') return;
        lane.items.forEach((it) => {
          it.x += lane.dir * lane.speed * dt * 0.06;
          if (it.x > W + 20) it.x = -60;
          if (it.x < -60) it.x = W + 20;
        });
      });

      const f = g.frog;
      const row = Math.floor((f.y + 10) / ROW_H);
      const lane = g.lanes[Math.min(Math.max(row, 0), ROWS - 1)];

      // 死亡计时（撞车后动画）
      if (g.deathTimer > 0) {
        g.deathTimer -= dt;
        if (g.deathTimer <= 0) {
          setLives((l) => {
            const nl = l - 1;
            if (nl <= 0) {
              setStatus('over');
              sfx.lose();
            } else {
              respawn();
            }
            return nl;
          });
        }
      } else if (lane.kind === 'road') {
        // 撞车检测
        for (const car of lane.items) {
          if (f.x + 24 > car.x && f.x < car.x + car.w && f.y > row * ROW_H && f.y < (row + 1) * ROW_H) {
            g.deathTimer = 600;
            sfx.mismatch();
            break;
          }
        }
      } else if (lane.kind === 'river') {
        // 找浮木
        let onLog: { dx: number } | null = null;
        for (const log of lane.items) {
          if (f.x + 20 > log.x && f.x + 8 < log.x + log.w && f.y > row * ROW_H && f.y < (row + 1) * ROW_H) {
            onLog = { dx: lane.dir * lane.speed * dt * 0.06 };
            break;
          }
        }
        if (onLog) {
          f.x += onLog.dx;
          f.onLog = onLog;
        } else {
          // 落水
          g.deathTimer = 500;
          sfx.mismatch();
        }
      } else {
        f.onLog = null;
      }

      // 边界
      f.x = Math.max(2, Math.min(W - 30, f.x));

      // 到达目标
      if (f.y < ROW_H) {
        const goalIdx = Math.floor(f.x / (W / 5));
        if (goalIdx >= 0 && goalIdx < 5 && !g.goals[goalIdx]) {
          g.goals[goalIdx] = true;
          setScore((s) => s + 100 + level * 50);
          sfx.clear();
          if (g.goals.every(Boolean)) {
            setStatus('win');
            sfx.win();
            return;
          }
          respawn();
        } else {
          f.y = ROW_H + 6;
        }
      }

      // 渲染（静态背景 + 动态元素）
      if (bgRef.current) ctx.drawImage(bgRef.current, 0, 0);
      else {
        ctx.fillStyle = '#0c1220';
        ctx.fillRect(0, 0, W, H);
      }
      // 已激活目标洞（覆盖静态层的空洞）
      g.goals.forEach((done, i) => {
        if (!done) return;
        const gx = i * (W / 5) + W / 10 - 20;
        ctx.fillStyle = '#34d399';
        ctx.beginPath();
        ctx.arc(gx + 20, ROW_H / 2, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#6ee7b7';
        ctx.lineWidth = 3;
        ctx.stroke();
      });
      // 车
      g.lanes.forEach((lane, ri) => {
        if (lane.kind !== 'road') return;
        const y = ri * ROW_H;
        lane.items.forEach((car) => {
          ctx.fillStyle = ri % 2 === 0 ? '#e05252' : '#f08c3a';
          ctx.fillRect(car.x, y + 6, car.w, ROW_H - 12);
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.fillRect(car.x + 4, y + 10, car.w - 8, 3);
          ctx.fillRect(car.x + 4, y + ROW_H - 13, car.w - 8, 3);
        });
      });
      // 浮木
      g.lanes.forEach((lane, ri) => {
        if (lane.kind !== 'river') return;
        const y = ri * ROW_H;
        lane.items.forEach((log) => {
          ctx.fillStyle = '#7a5230';
          ctx.fillRect(log.x, y + 5, log.w, ROW_H - 10);
          ctx.fillStyle = '#96693f';
          ctx.fillRect(log.x + 3, y + 8, log.w - 6, 4);
        });
      });
      // 青蛙
      ctx.fillStyle = '#34d399';
      ctx.beginPath();
      ctx.arc(f.x + 15, f.y + 14, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#065f46';
      ctx.beginPath();
      ctx.arc(f.x + 9, f.y + 10, 5, 0, Math.PI * 2);
      ctx.arc(f.x + 21, f.y + 10, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(f.x + 8, f.y + 9, 2, 0, Math.PI * 2);
      ctx.arc(f.x + 20, f.y + 9, 2, 0, Math.PI * 2);
      ctx.fill();
      // 死亡动画（闪烁）
      if (g.deathTimer > 0 && Math.floor(g.deathTimer / 80) % 2 === 0) {
        ctx.fillStyle = 'rgba(255,0,0,0.3)';
        ctx.fillRect(0, row * ROW_H, W, ROW_H);
      }

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [status, respawn]);

  // 键盘/方向控制
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const f = gameRef.current.frog;
      const step = ROW_H;
      const move = (dx: number, dy: number) => {
        f.x = Math.max(2, Math.min(W - 30, f.x + dx));
        f.y = Math.max(0, Math.min(H - ROW_H + 8, f.y + dy));
        f.onLog = null;
        sfx.move();
      };
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        if (status === 'ready') startGame();
        else move(0, -step);
      } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
        e.preventDefault();
        move(0, step);
      } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        move(-step, 0);
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        move(step, 0);
      }
      if (e.key === ' ' && (status === 'ready' || status === 'over' || status === 'win')) {
        startGame();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, startGame]);

  // 最高分
  useEffect(() => {
    if (score > 0) {
      const isNew = best.updateBest(score, (a, b) => a > b);
      if (isNew && score > 0) {
        sfx.record();
        toast(`新纪录！${score} 分`, 'record');
      }
    }
  }, [score, best, toast]);

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
            <span>生命</span>
            <strong>{'❤'.repeat(Math.max(0, lives)) || '--'}</strong>
          </div>
          <div className="stat-box">
            <span>回家</span>
            <strong>{gameRef.current.goals.filter(Boolean).length}/5</strong>
          </div>
          <div className="stat-box">
            <span>{meta.bestScoreLabel}</span>
            <strong>{best.value ?? 0}</strong>
          </div>
        </>
      }
    >
      <div className="arcade">
        <div className="arcade-canvas-wrap">
          <canvas ref={canvasRef} width={W} height={H} style={{ imageRendering: 'pixelated' }} />
          {status === 'ready' && (
            <div className="arcade-overlay">
              <h2>🐸 青蛙过河</h2>
              <p>方向键移动 · 躲开汽车 · 踩着浮木过河 · 跳进 5 个家</p>
              <button className="btn btn-primary" onClick={startGame}>
                开始游戏
              </button>
            </div>
          )}
          {status === 'over' && (
            <div className="arcade-overlay">
              <h2>💀 青蛙牺牲了</h2>
              <p>得分 {score} · 第 {level} 关</p>
              <button className="btn btn-primary" onClick={startGame}>
                再来一局
              </button>
            </div>
          )}
          {status === 'win' && (
            <div className="arcade-overlay">
              <h2>🎉 全家团聚！</h2>
              <p>得分 {score}</p>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setLevel((l) => l + 1);
                  gameRef.current.lanes = buildLanes(level + 1);
                  gameRef.current.goals = Array(5).fill(false);
                  respawn();
                  setStatus('playing');
                }}
              >
                下一关（更快！）
              </button>
            </div>
          )}
        </div>
        <p className="hint">方向键 / WASD 移动 · 空格开始</p>
      </div>
    </GameShell>
  );
}
