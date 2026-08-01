import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useLocalStorage } from '../core/useLocalStorage';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import type { GameMeta } from '../core/types';

export const meta: GameMeta = {
  id: 'space-invaders',
  title: '太空侵略者',
  description: '击落外星人军团，保卫地球！',
  icon: '👾',
  difficulty: '中等',
  category: '反应',
  tags: ['日系', '射击'],
  bestScoreLabel: '最高分',
};

const W = 480;
const H = 420;

interface Bullet {
  x: number;
  y: number;
  vy: number;
}

export default function SpaceInvaders() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'ready' | 'playing' | 'over' | 'win'>('ready');
  const [score, setScore] = useState(0);
  const [level, setLevel] = useState(1);
  const [lives, setLives] = useState(3);
  const best = useLocalStorage<number>(`best:${meta.id}`);
  const { toast } = useToast();
  const keysRef = useRef({ left: false, right: false });

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
    void lv;
  }, []);

  const startGame = useCallback(() => {
    setScore(0);
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
          setLives((l) => {
            const nl = l - 1;
            if (nl <= 0) {
              setStatus('over');
              sfx.lose();
            } else {
              sfx.mismatch();
            }
            return nl;
          });
        }
      }

      // 通关判定
      if (g.invaders.every((i) => !i.alive)) {
        setStatus('win');
        sfx.win();
        return;
      }

      // 渲染
      ctx.fillStyle = '#0a0c1c';
      ctx.fillRect(0, 0, W, H);
      // 星星
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.2 + Math.random() * 0.5})`;
        ctx.fillRect(((i * 97) % W), ((i * 53) % H), 2, 2);
      }
      // 外星人
      g.invaders.forEach((inv) => {
        if (!inv.alive) return;
        const colors = ['#f44336', '#ff9800', '#4dd0e1', '#8bc34a', '#e91e63'];
        ctx.fillStyle = colors[inv.type];
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

  // 键盘控制
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keysRef.current.left = true;
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keysRef.current.right = true;
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
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
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
      </div>
    </GameShell>
  );
}
