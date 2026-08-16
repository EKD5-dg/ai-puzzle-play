import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { TouchButtons } from '../core/TouchControls';
import { metaInvaders } from '../core/gameMetas';



const W = 480;
const H = 420;

interface Bullet {
  x: number;
  y: number;
  vy: number;
}

/** 外星人类型配色（模块级常量，避免每帧为每只重建数组） */
const INVADER_COLORS = ['#f44336', '#ff9800', '#4dd0e1', '#8bc34a', '#e91e63'];

export default function SpaceInvaders() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'ready' | 'playing' | 'over' | 'win'>('ready');
  const [score, setScore] = useState(0);
  const [level, setLevel] = useState(1);
  const [lives, setLives] = useState(3);
  const best = useBestScore(metaInvaders.id);
  const { toast } = useToast();
  const keysRef = useRef({ left: false, right: false });
  /** 生命值镜像（rAF/定时器回调内读取最新值） */
  const livesRef = useRef(3);
  livesRef.current = lives;

  const gameRef = useRef({
    player: { x: W / 2 - 20, y: H - 44 },
    invaders: [] as Array<{ x: number; y: number; alive: boolean; type: number }>,
    bullets: [] as Bullet[],
    enemyBullets: [] as Bullet[],
    dir: 1,
    downTimer: 0,
    fireTimer: 0,
    moveTimer: 0,
  });

  // 静态背景层（黑底 + 预生成星星），每帧直接贴图
  const bgRef = useRef<HTMLCanvasElement | null>(null);
  if (!bgRef.current) {
    const bg = document.createElement('canvas');
    bg.width = W;
    bg.height = H;
    const bctx = bg.getContext('2d');
    if (bctx) {
      bctx.fillStyle = '#0a0c1c';
      bctx.fillRect(0, 0, W, H);
      // 预生成固定星星（种子随机一次）
      let seed = 12345;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      for (let i = 0; i < 40; i++) {
        bctx.fillStyle = `rgba(255,255,255,${0.2 + rand() * 0.5})`;
        bctx.fillRect(Math.floor(rand() * W), Math.floor(rand() * H), 2, 2);
      }
    }
    bgRef.current = bg;
  }

  const initLevel = useCallback((lv: number) => {
    const inv: Array<{ x: number; y: number; alive: boolean; type: number }> = [];
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 8; c++) {
        inv.push({ x: 40 + c * 48, y: 50 + r * 36, alive: true, type: r });
      }
    gameRef.current.invaders = inv;
    gameRef.current.player = { x: W / 2 - 20, y: H - 44 };
    gameRef.current.bullets = [];
    gameRef.current.enemyBullets = [];
    gameRef.current.dir = 1;
    gameRef.current.moveTimer = 0;
    gameRef.current.fireTimer = 0; // 重置敌方开火计时，避免新一波开局立即出弹
    void lv;
  }, []);

  const startGame = useCallback(() => {
    setScore(0);
    livesRef.current = 3;
    setLives(3);
    setLevel(1);
    initLevel(1);
    setStatus('playing');
  }, [initLevel]);

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

      // 移动：炮台由键盘控制（通过 ref）
      // 外星人移动（时间驱动）
      g.moveTimer += dt;
      const invSpeed = Math.max(120, 420 - level * 40);
      if (g.moveTimer > invSpeed) {
        g.moveTimer = 0;
        let edge = false;
        for (const inv of g.invaders) {
          if (!inv.alive) continue;
          if (inv.x + g.dir * 16 < 8 || inv.x + g.dir * 16 > W - 40) {
            edge = true;
            break;
          }
        }
        if (edge) {
          g.dir *= -1;
          g.invaders.forEach((inv) => {
            if (inv.alive) inv.y += 18;
          });
        } else {
          g.invaders.forEach((inv) => {
            if (inv.alive) inv.x += g.dir * 16;
          });
        }
        // 触底判定
        if (g.invaders.some((inv) => inv.alive && inv.y > H - 80)) {
          setStatus('over');
          sfx.lose();
          return;
        }
      }

      // 玩家子弹
      g.bullets.forEach((b) => (b.y -= 8));
      g.bullets = g.bullets.filter((b) => b.y > -10);
      // 外星人子弹
      g.enemyBullets.forEach((b) => (b.y += 3.5));
      g.enemyBullets = g.enemyBullets.filter((b) => b.y < H + 10);
      g.fireTimer += dt;
      if (g.fireTimer > 900 - level * 60 && g.enemyBullets.length < 3) {
        g.fireTimer = 0;
        const alive = g.invaders.filter((i) => i.alive);
        if (alive.length > 0) {
          const shooter = alive[Math.floor(Math.random() * alive.length)];
          g.enemyBullets.push({ x: shooter.x + 16, y: shooter.y + 16, vy: 3.5 });
        }
      }

      // 子弹碰撞
      for (let i = g.bullets.length - 1; i >= 0; i--) {
        const b = g.bullets[i];
        for (const inv of g.invaders) {
          if (inv.alive && b.x > inv.x && b.x < inv.x + 32 && b.y > inv.y && b.y < inv.y + 28) {
            inv.alive = false;
            g.bullets.splice(i, 1);
            const pts = inv.type === 0 ? 30 : inv.type === 1 || inv.type === 2 ? 20 : 10;
            setScore((s) => s + pts);
            sfx.clear();
            break;
          }
        }
      }
      // 外星人子弹 vs 炮台
      for (let i = g.enemyBullets.length - 1; i >= 0; i--) {
        const b = g.enemyBullets[i];
        if (b.x > g.player.x && b.x < g.player.x + 40 && b.y > g.player.y && b.y < g.player.y + 24) {
          g.enemyBullets.splice(i, 1);
          const nl = livesRef.current - 1;
          livesRef.current = nl;
          setLives(nl);
          if (nl <= 0) {
            setStatus('over');
            sfx.lose();
          } else {
            sfx.mismatch();
          }
        }
      }

      // 通关判定
      if (g.invaders.every((i) => !i.alive)) {
        setStatus('win');
        sfx.win();
        return;
      }

      // 渲染（背景静态层 + 动态元素）
      if (bgRef.current) ctx.drawImage(bgRef.current, 0, 0);
      else {
        ctx.fillStyle = '#0a0c1c';
        ctx.fillRect(0, 0, W, H);
      }
      // 外星人
      g.invaders.forEach((inv) => {
        if (!inv.alive) return;
        ctx.fillStyle = INVADER_COLORS[inv.type];
        // 简易外星人造型
        ctx.fillRect(inv.x + 4, inv.y, 24, 8);
        ctx.fillRect(inv.x, inv.y + 8, 32, 6);
        ctx.fillRect(inv.x + 4, inv.y + 14, 8, 8);
        ctx.fillRect(inv.x + 20, inv.y + 14, 8, 8);
        ctx.fillStyle = '#fff';
        ctx.fillRect(inv.x + 8, inv.y + 4, 4, 4);
        ctx.fillRect(inv.x + 20, inv.y + 4, 4, 4);
      });
      // 炮台
      ctx.fillStyle = '#00e676';
      ctx.fillRect(g.player.x, g.player.y + 12, 40, 8);
      ctx.fillRect(g.player.x + 10, g.player.y + 4, 20, 8);
      ctx.fillRect(g.player.x + 16, g.player.y, 8, 6);
      // 子弹
      ctx.fillStyle = '#ffeb3b';
      g.bullets.forEach((b) => ctx.fillRect(b.x - 2, b.y - 10, 4, 12));
      ctx.fillStyle = '#ff1744';
      g.enemyBullets.forEach((b) => ctx.fillRect(b.x - 2, b.y, 4, 10));

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [status, level]);

  // 键盘控制（左右键阻止页面滚动；窗口失焦时清空按键，防止切回后炮台漂移）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        keysRef.current.left = true;
      }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        keysRef.current.right = true;
      }
      if (e.key === ' ') {
        e.preventDefault();
        if (status === 'ready' || status === 'over' || status === 'win') {
          startGame();
        } else if (gameRef.current.bullets.length < 2) {
          gameRef.current.bullets.push({ x: gameRef.current.player.x + 20, y: gameRef.current.player.y - 10, vy: -8 });
          sfx.drop();
        }
      }
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
        if (status === 'ready' || status === 'over' || status === 'win') startGame();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keysRef.current.left = false;
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keysRef.current.right = false;
    };
    const onBlur = () => {
      keysRef.current.left = false;
      keysRef.current.right = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [status, startGame]);

  // 炮台移动（独立循环，按按键状态）
  useEffect(() => {
    if (status !== 'playing') return;
    const t = window.setInterval(() => {
      const p = gameRef.current.player;
      if (keysRef.current.left) p.x = Math.max(4, p.x - 6);
      if (keysRef.current.right) p.x = Math.min(W - 44, p.x + 6);
    }, 16);
    return () => window.clearInterval(t);
  }, [status]);

  // 最高分：只在游戏结束时结算一次（避免破纪录后每击杀一个外星人刷屏）
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
      meta={metaInvaders}
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
            <span>{metaInvaders.bestScoreLabel}</span>
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
              <h2>👾 太空侵略者</h2>
              <p>← → 移动 · 空格射击 · 击落全部外星人</p>
              <button className="btn btn-primary" onClick={startGame}>
                开始游戏
              </button>
            </div>
          )}
          {status === 'over' && (
            <div className="arcade-overlay">
              <h2>💀 地球失守</h2>
              <p>得分 {score} · 第 {level} 波</p>
              <button className="btn btn-primary" onClick={startGame}>
                再来一局
              </button>
            </div>
          )}
          {status === 'win' && (
            <div className="arcade-overlay">
              <h2>🎉 第 {level} 波击退！</h2>
              <p>得分 {score}</p>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setLevel((l) => l + 1);
                  initLevel(level + 1);
                  setStatus('playing');
                }}
              >
                下一波
              </button>
            </div>
          )}
        </div>
        <p className="hint">← → 移动 · 空格射击 · 波次递增难度</p>
        <div className="tc-row">
          <TouchButtons
            items={[
              { label: '◀', onPress: () => { keysRef.current.left = true; }, onRelease: () => { keysRef.current.left = false; } },
              { label: '▶', onPress: () => { keysRef.current.right = true; }, onRelease: () => { keysRef.current.right = false; } },
              {
                label: '🔥 射击',
                primary: true,
                onPress: () => {
                  if (status === 'ready' || status === 'over' || status === 'win') startGame();
                  else if (gameRef.current.bullets.length < 2) {
                    gameRef.current.bullets.push({ x: gameRef.current.player.x + 20, y: gameRef.current.player.y - 10, vy: -8 });
                    sfx.drop();
                  }
                },
              },
            ]}
          />
        </div>
      </div>
    </GameShell>
  );
}
