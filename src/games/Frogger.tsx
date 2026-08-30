import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { TouchDpad } from '../core/TouchControls';
import { metaFrogger } from '../core/gameMetas';



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
      // 间距下限 60：level 增长时不会降到 ≤0 导致死循环，也不会让道具重叠
      const spacing = Math.max(60, lane.kind === 'road' ? 130 - level * 4 : 150 - level * 4);
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
  const best = useBestScore(metaFrogger.id);
  const { toast } = useToast();

  const gameRef = useRef({
    frog: { x: W / 2 - 14, y: H - ROW_H + 8, onLog: null as { log: { x: number; w: number } } | null },
    lanes: [] as Lane[],
    goals: Array(5).fill(false) as boolean[],
    deathTimer: 0,
  });
  /** 生命值镜像（rAF 回调内读取最新值） */
  const livesRef = useRef(3);
  livesRef.current = lives;

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
    livesRef.current = 3;
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

      const f = g.frog;

      // 移动车道/河流道具（浮木回绕时同步搬移站着的青蛙，避免瞬移落水）
      g.lanes.forEach((lane) => {
        if (lane.kind === 'safe') return;
        lane.items.forEach((it) => {
          const dx = lane.dir * lane.speed * dt * 0.06;
          it.x += dx;
          // 载运与浮木同帧同步位移：先按上一帧记录的乘骑关系搬青蛙，
          // 消除"车道先动、青蛙判定后才补位移"的一帧滞后——该滞后会让
          // 站在浮木拖尾边缘（重叠量<单帧位移）的青蛙在下一帧误判落水
          if (f.onLog?.log === it) f.x += dx;
          // 回绕补偿用实际跳变量：it.x += dx 后可能越过边界不止一点点，
          // 固定常数补偿会让青蛙相对浮木滑移、贴边时误判落水
          if (it.x > W + 20) {
            const jump = -60 - it.x;
            it.x = -60;
            if (f.onLog?.log === it) f.x += jump;
          } else if (it.x < -60) {
            const jump = W + 20 - it.x;
            it.x = W + 20;
            if (f.onLog?.log === it) f.x += jump;
          }
        });
      });

      const row = Math.floor((f.y + 10) / ROW_H);
      const lane = g.lanes[Math.min(Math.max(row, 0), ROWS - 1)];

      // 死亡计时（撞车后动画）
      if (g.deathTimer > 0) {
        g.deathTimer -= dt;
        if (g.deathTimer <= 0) {
          const nl = livesRef.current - 1;
          livesRef.current = nl;
          setLives(nl);
          if (nl <= 0) {
            setStatus('over');
            sfx.lose();
          } else {
            respawn();
          }
        }
      } else if (lane.kind === 'road') {
        // 撞车检测（离开河流行后清理浮木引用，防止浮木回绕连带瞬移路上的青蛙）
        if (f.onLog) f.onLog = null;
        for (const car of lane.items) {
          if (f.x + 24 > car.x && f.x < car.x + car.w && f.y > row * ROW_H && f.y < (row + 1) * ROW_H) {
            g.deathTimer = 600;
            sfx.mismatch();
            break;
          }
        }
      } else if (lane.kind === 'river') {
        // 找浮木：本帧已在移动循环里同步载运过，这里只做成员判定记录引用
        let onLog: { log: { x: number; w: number } } | null = null;
        for (const log of lane.items) {
          if (f.x + 20 > log.x && f.x + 8 < log.x + log.w && f.y > row * ROW_H && f.y < (row + 1) * ROW_H) {
            onLog = { log };
            break;
          }
        }
        if (onLog) {
          f.onLog = onLog;
        } else {
          // 落水
          g.deathTimer = 500;
          sfx.mismatch();
        }
      } else {
        f.onLog = null;
      }

      // 边界（不在浮木上时钳制在画布内；在浮木上时允许随浮木短暂出屏再回绕，避免 clamp 破坏搬移）
      if (!f.onLog) f.x = Math.max(2, Math.min(W - 30, f.x));

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
          // 目标位已被占：回起点（不能推回第 1 行，那是车流带）
          respawn();
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

  // 键盘/方向控制（仅游戏中且非死亡动画期间可移动）
  const moveFrog = (dx: number, dy: number) => {
    if (status !== 'playing') return;
    if (gameRef.current.deathTimer > 0) return;
    const f = gameRef.current.frog;
    f.x = Math.max(2, Math.min(W - 30, f.x + dx));
    f.y = Math.max(0, Math.min(H - ROW_H + 8, f.y + dy));
    f.onLog = null;
    sfx.move();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        if (status === 'ready') startGame();
        else moveFrog(0, -ROW_H);
      } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
        e.preventDefault();
        moveFrog(0, ROW_H);
      } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        moveFrog(-ROW_H, 0);
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        moveFrog(ROW_H, 0);
      }
      if (e.key === ' ' && (status === 'ready' || status === 'over' || status === 'win')) {
        startGame();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, startGame, moveFrog]);

  // 最高分：只在游戏结束时结算一次（避免每次进洞加分刷屏 toast/音效/云请求）
  useEffect(() => {
    if ((status === 'over' || status === 'win') && score > 0) {
      const isNew = best.updateBest(score, (a, b) => a > b);
      if (isNew) {
        sfx.record();
        toast(`新纪录！${score} 分`, 'record');
      }
    }
  }, [status, score, best, toast]);

  return (
    <GameShell
      meta={metaFrogger}
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
            <span>{metaFrogger.bestScoreLabel}</span>
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
        <div className="tc-row">
          <TouchDpad onDir={(d) => moveFrog(d === 'up' ? 0 : d === 'down' ? 0 : d === 'left' ? -ROW_H : ROW_H, d === 'up' ? -ROW_H : d === 'down' ? ROW_H : 0)} />
        </div>
      </div>
    </GameShell>
  );
}
