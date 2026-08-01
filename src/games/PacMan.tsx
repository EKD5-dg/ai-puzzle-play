import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { TouchDpad } from '../core/TouchControls';
import type { GameMeta } from '../core/types';

export const meta: GameMeta = {
  id: 'pac-man',
  title: '吃豆人',
  description: '吃掉所有豆子，躲避幽灵追击！',
  icon: '👻',
  difficulty: '中等',
  category: '经典',
  tags: ['日系', '街机'],
  bestScoreLabel: '最高分',
};

/** 迷宫地图：#墙 .豆 o能量豆 空格 */
const MAP = [
  '###################',
  '#........#........#',
  '#o##.###.#.###.##o#',
  '#.................#',
  '#.##.#.#####.#.##.#',
  '#....#...#...#....#',
  '####.# ##### #.####',
  '    #.  P  .#    ',
  '####.# ##=## #.####',
  '    .  #   #  .    ',
  '####.# ##### #.####',
  '#....#...#...#....#',
  '#.##.#.#####.#.##.#',
  '#o##.#.......#.##o#',
  '#.................#',
  '#.#############.#  ',
  '#.................#',
  '###################',
];

const COLS = 19;
const ROWS = 17;
const TILE = 26;

const GHOST_COLORS = ['#ff1744', '#ff9f1a', '#4dd0e1', '#ff6ec7'];

export default function PacMan() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'ready' | 'playing' | 'over' | 'win'>('ready');
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [level, setLevel] = useState(1);
  const best = useBestScore(meta.id);
  const { toast } = useToast();

  // 游戏状态（ref 供游戏循环读写）
  const gameRef = useRef({
    player: { x: 9 * TILE + TILE / 2, y: 7.5 * TILE, dir: 'left' as string, nextDir: 'left' as string, speed: 2.6, invincible: 0 },
    ghosts: [] as Array<{ x: number; y: number; dir: string; color: string; mode: 'chase' | 'fright' | 'eyes'; timer: number; delay: number }>,
    dots: 0,
    totalDots: 0,
    maze: [] as string[][],
    frightTimer: 0,
  });
  const staticRef = useRef<HTMLCanvasElement | null>(null);

  const initMaze = useCallback((): string[][] => {
    const maze = MAP.map((row) => row.split(''));
    let total = 0;
    maze.forEach((row) =>
      row.forEach((c) => {
        if (c === '.' || c === 'o') total++;
      }),
    );
    gameRef.current.totalDots = total;
    gameRef.current.dots = total;
    // 构建静态迷宫层（离屏 Canvas，每帧直接贴图免重绘）
    const cv = document.createElement('canvas');
    cv.width = COLS * TILE;
    cv.height = ROWS * TILE;
    const ctx = cv.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#0d0f1e';
      ctx.fillRect(0, 0, cv.width, cv.height);
      for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++) {
          const ch = maze[r][c];
          if (ch === '#') {
            ctx.fillStyle = '#2a3f9e';
            ctx.fillRect(c * TILE + 1, r * TILE + 1, TILE - 2, TILE - 2);
            ctx.fillStyle = '#3f5cd0';
            ctx.fillRect(c * TILE + 2, r * TILE + 2, TILE - 4, TILE - 4);
          } else if (ch === '.') {
            ctx.fillStyle = '#ffd54f';
            ctx.beginPath();
            ctx.arc(c * TILE + TILE / 2, r * TILE + TILE / 2, 3, 0, Math.PI * 2);
            ctx.fill();
          } else if (ch === 'o') {
            ctx.fillStyle = '#ffd54f';
            ctx.beginPath();
            ctx.arc(c * TILE + TILE / 2, r * TILE + TILE / 2, 7, 0, Math.PI * 2);
            ctx.fill();
          }
        }
    }
    staticRef.current = cv;
    return maze;
  }, []);

  const startGame = useCallback(() => {
    const maze = initMaze();
    gameRef.current.maze = maze;
    gameRef.current.player = { x: 9 * TILE + TILE / 2, y: 7.5 * TILE, dir: 'left', nextDir: 'left', speed: 2.6, invincible: 150 };
    gameRef.current.ghosts = [
      { x: 9 * TILE + TILE / 2, y: 8.5 * TILE, dir: 'up', color: GHOST_COLORS[0], mode: 'chase', timer: 0, delay: 90 },
      { x: 8 * TILE + TILE / 2, y: 8.5 * TILE, dir: 'up', color: GHOST_COLORS[1], mode: 'chase', timer: 0, delay: 180 },
      { x: 10 * TILE + TILE / 2, y: 8.5 * TILE, dir: 'up', color: GHOST_COLORS[2], mode: 'chase', timer: 0, delay: 270 },
      { x: 9 * TILE + TILE / 2, y: 9.5 * TILE, dir: 'up', color: GHOST_COLORS[3], mode: 'chase', timer: 0, delay: 360 },
    ];
    gameRef.current.frightTimer = 0;
    setScore(0);
    setLives(3);
    setLevel(1);
    setStatus('playing');
  }, [initMaze]);

  const isWall = useCallback((x: number, y: number): boolean => {
    const maze = gameRef.current.maze;
    const col = Math.floor(x / TILE);
    const row = Math.floor(y / TILE);
    if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return true;
    const ch = maze[row][col];
    // '#' 墙、'=' 幽灵房墙体（玩家不可入）；其余（空格/豆子/能量豆/P）均可通行
    return ch === '#' || ch === '=';
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
      const p = g.player;

      // 玩家移动
      const tryDir = (d: string): boolean => {
        const vx = d === 'left' ? -1 : d === 'right' ? 1 : 0;
        const vy = d === 'up' ? -1 : d === 'down' ? 1 : 0;
        const nx = p.x + vx * (p.speed * 1.2 + TILE / 2);
        const ny = p.y + vy * (p.speed * 1.2 + TILE / 2);
        if (!isWall(nx, ny)) {
          p.x += vx * p.speed * dt * 0.06;
          p.y += vy * p.speed * dt * 0.06;
          return true;
        }
        return false;
      };
      if (p.dir !== p.nextDir && tryDir(p.nextDir)) p.dir = p.nextDir;
      else tryDir(p.dir);

      // 隧道穿越
      if (p.x < -TILE / 2) p.x = COLS * TILE + TILE / 2 - 1;
      if (p.x > COLS * TILE + TILE / 2) p.x = -TILE / 2 + 1;

      // 吃豆
      const col = Math.floor(p.x / TILE);
      const row = Math.floor(p.y / TILE);
      const cell = g.maze[row]?.[col];
      if (cell === '.' || cell === 'o') {
        g.maze[row][col] = ' ';
        // 同步擦除静态层上的豆子
        const sctx = staticRef.current?.getContext('2d');
        if (sctx) {
          sctx.fillStyle = '#0d0f1e';
          sctx.fillRect(col * TILE, row * TILE, TILE, TILE);
        }
        g.dots--;
        if (cell === '.') {
          setScore((s) => s + 10);
        } else {
          setScore((s) => s + 50);
          g.frightTimer = 500;
          g.ghosts.forEach((gh) => {
            if (gh.mode === 'chase') gh.mode = 'fright';
          });
          sfx.merge();
        }
        if (g.dots === 0) {
          setStatus('win');
          sfx.win();
          return;
        }
      }

      // 幽灵移动（简单追逐：趋向玩家 + 随机扰动；恐惧时远离）
      g.ghosts.forEach((gh) => {
        // 出房延迟：分批放出，避免开局围杀
        if (gh.delay > 0) {
          gh.delay--;
          return;
        }
        if (gh.mode === 'fright') {
          gh.timer++;
          if (gh.timer > g.frightTimer) {
            gh.mode = 'chase';
            gh.timer = 0;
          }
        }
        // 每帧按格子对齐点决策转向
        const gx = Math.floor(gh.x / TILE) * TILE + TILE / 2;
        const gy = Math.floor(gh.y / TILE) * TILE + TILE / 2;
        if (Math.abs(gh.x - gx) < 1.5 && Math.abs(gh.y - gy) < 1.5) {
          const options: string[] = [];
          const dirs: Array<[string, number, number]> = [
            ['left', -1, 0],
            ['right', 1, 0],
            ['up', 0, -1],
            ['down', 0, 1],
          ];
          for (const [d, dx, dy] of dirs) {
            if (d === (gh.dir === 'left' ? 'right' : gh.dir === 'right' ? 'left' : gh.dir === 'up' ? 'down' : 'up')) continue;
            const nx = gx + dx * TILE;
            const ny = gy + dy * TILE;
            if (!isWall(nx, ny)) options.push(d);
          }
          if (options.length > 0) {
            // 追逐：选朝玩家的方向（曼哈顿距离最小）
            const target = gh.mode === 'fright' ? { x: COLS * TILE - p.x, y: p.y } : p;
            let bestD = options[0];
            let bestDist = Infinity;
            for (const d of options) {
              const dx = d === 'left' ? -1 : d === 'right' ? 1 : 0;
              const dy = d === 'up' ? -1 : d === 'down' ? 1 : 0;
              const dist = Math.abs(gx + dx * TILE - target.x) + Math.abs(gy + dy * TILE - target.y);
              if (dist < bestDist) {
                bestDist = dist;
                bestD = d;
              }
            }
            if (Math.random() < 0.12) gh.dir = options[Math.floor(Math.random() * options.length)];
            else gh.dir = bestD;
          }
        }
        const vx = gh.dir === 'left' ? -1 : gh.dir === 'right' ? 1 : 0;
        const vy = gh.dir === 'up' ? -1 : gh.dir === 'down' ? 1 : 0;
        gh.x += vx * 2 * dt * 0.06;
        gh.y += vy * 2 * dt * 0.06;
      });

      // 碰撞检测（开局短暂无敌，幽灵可穿过）
      if (p.invincible > 0) p.invincible--;
      for (const gh of g.ghosts) {
        const dist = Math.hypot(gh.x - p.x, gh.y - p.y);
        if (dist < TILE * 0.7) {
          if (gh.mode === 'fright') {
            gh.mode = 'eyes';
            setScore((s) => s + 200);
            sfx.clear();
            window.setTimeout(() => {
              gh.x = 9 * TILE + TILE / 2;
              gh.y = 9.5 * TILE;
              gh.mode = 'chase';
            }, 1200);
          } else if (gh.mode !== 'eyes' && p.invincible <= 0) {
            setLives((l) => {
              const nl = l - 1;
              if (nl <= 0) {
                setStatus('over');
                sfx.lose();
              } else {
                p.x = 9 * TILE + TILE / 2;
                p.y = 7.5 * TILE;
                p.dir = 'left';
                p.nextDir = 'left';
                p.invincible = 120;
                g.ghosts.forEach((gg) => {
                  gg.x = 9 * TILE + TILE / 2;
                  gg.y = 8.5 * TILE;
                });
                sfx.mismatch();
              }
              return nl;
            });
            break;
          }
        }
      }

      // 渲染（静态层贴图 + 动态层）
      const cv = canvasRef.current;
      const ctx = cv?.getContext('2d');
      if (cv && ctx) {
        if (staticRef.current) ctx.drawImage(staticRef.current, 0, 0);
        else {
          ctx.fillStyle = '#0d0f1e';
          ctx.fillRect(0, 0, cv.width, cv.height);
        }
        // 幽灵
        g.ghosts.forEach((gh) => {
          if (gh.mode === 'eyes') {
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(gh.x - 5, gh.y - 3, 4, 0, Math.PI * 2);
            ctx.arc(gh.x + 5, gh.y - 3, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#1e88e5';
            ctx.beginPath();
            ctx.arc(gh.x - 5, gh.y - 3, 2, 0, Math.PI * 2);
            ctx.arc(gh.x + 5, gh.y - 3, 2, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillStyle = gh.mode === 'fright' ? '#5e35b1' : gh.color;
            ctx.beginPath();
            ctx.arc(gh.x, gh.y - 4, TILE / 2 - 2, Math.PI, 0);
            ctx.lineTo(gh.x + TILE / 2 - 2, gh.y + TILE / 2 - 2);
            ctx.lineTo(gh.x + TILE / 2 - 8, gh.y + TILE / 2 - 6);
            ctx.lineTo(gh.x + TILE / 2 - 14, gh.y + TILE / 2 - 2);
            ctx.lineTo(gh.x - TILE / 2 + 14, gh.y + TILE / 2 - 2);
            ctx.lineTo(gh.x - TILE / 2 + 8, gh.y + TILE / 2 - 6);
            ctx.lineTo(gh.x - TILE / 2 + 2, gh.y + TILE / 2 - 2);
            ctx.closePath();
            ctx.fill();
            // 眼睛
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(gh.x - 5, gh.y - 4, 4, 0, Math.PI * 2);
            ctx.arc(gh.x + 5, gh.y - 4, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#1e88e5';
            ctx.beginPath();
            ctx.arc(gh.x - 5, gh.y - 4, 2, 0, Math.PI * 2);
            ctx.arc(gh.x + 5, gh.y - 4, 2, 0, Math.PI * 2);
            ctx.fill();
          }
        });
        // 玩家（张嘴动画）
        const mouth = 0.2 + Math.sin(now / 90) * 0.18;
        const angle = p.dir === 'left' ? Math.PI : p.dir === 'right' ? 0 : p.dir === 'up' ? -Math.PI / 2 : Math.PI / 2;
        ctx.fillStyle = '#ffeb3b';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.arc(p.x, p.y, TILE / 2 - 1, angle + mouth, angle - mouth + Math.PI * 2);
        ctx.closePath();
        ctx.fill();
      }
      if (statusRef.current === 'playing') raf = requestAnimationFrame(step);
    };

    const statusRef = { current: status };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [status, isWall]);

  // 键盘控制
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, string> = {
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
      const dir = map[e.key];
      if (dir) {
        e.preventDefault();
        if (status === 'ready') startGame();
        gameRef.current.player.nextDir = dir;
      }
      if (e.key === ' ' && (status === 'ready' || status === 'over' || status === 'win')) {
        startGame();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, startGame]);

  // 触屏方向键
  const setTouchDir = (d: string) => {
    if (status === 'ready') startGame();
    gameRef.current.player.nextDir = d;
  };

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
          <canvas
            ref={canvasRef}
            width={COLS * TILE}
            height={ROWS * TILE}
            style={{ imageRendering: 'pixelated' }}
          />
          {status === 'ready' && (
            <div className="arcade-overlay">
              <h2>👻 吃豆人</h2>
              <p>吃掉所有豆子 · 能量豆可反吃幽灵</p>
              <button className="btn btn-primary" onClick={startGame}>
                开始游戏
              </button>
            </div>
          )}
          {status === 'over' && (
            <div className="arcade-overlay">
              <h2>💀 游戏结束</h2>
              <p>得分 {score} · 到达第 {level} 关</p>
              <button className="btn btn-primary" onClick={startGame}>
                再来一局
              </button>
            </div>
          )}
          {status === 'win' && (
            <div className="arcade-overlay">
              <h2>🎉 通关！</h2>
              <p>得分 {score}</p>
              <button className="btn btn-primary" onClick={startGame}>
                下一关
              </button>
            </div>
          )}
        </div>
        <p className="hint">方向键 / WASD 转向 · 空格开始</p>
        <div className="tc-row">
          <TouchDpad onDir={(d) => setTouchDir(d)} />
        </div>
      </div>
    </GameShell>
  );
}
