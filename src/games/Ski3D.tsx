import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaSki3D } from '../core/gameMetas';

// ============ 常量 ============

/** 内部渲染分辨率（4:3） */
const RW = 480;
const RH = 360;
/** 地平线 y（世界 z → ∞ 的投影极限 = CAM·FOCAL/CAMH） */
const HOR = 180;
const FOCAL = RH * 1.1;
/** 相机高度 / 相机到玩家的 z 距离 */
const CAMH = 1.7;
const CAM = 2.2;
/** 玩家所在深度与横向移动范围（滑道半宽 4，留边距） */
const PZ = 0.5;
const LIMIT = 3.4;
/** 可见最远距离（超出有浓雾遮挡） */
const FAR = 60;
/** 起始/极限速度（米/秒），距离越远越快 */
const V0 = 9;
const VMAX = 26;
/** 转向加速度与阻尼 */
const STEER = 26;
const DAMP = 5.2;
const LIVES = 3;
/** 撞后无敌时间（秒） */
const INVULN = 1.6;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

type ObType = 'tree' | 'rock' | 'snowman';

interface Obstacle {
  x: number;
  /** 相对起点距离的位置，渲染/碰撞时用 z = z - dist */
  z: number;
  type: ObType;
  r: number;
  /** 装饰性随机尺寸/相位 */
  seed: number;
}

interface Gem {
  x: number;
  z: number;
}

/** 路边树（纯装饰，不随距离消失，循环回收） */
interface SideTree {
  x: number;
  z: number;
  s: number;
}

interface Flake {
  x: number;
  y: number;
  r: number;
  vy: number;
  vx: number;
}

interface World {
  dist: number;
  speed: number;
  player: { x: number; vx: number };
  /** 键盘/指针共同作用的目标横向位置（null=无输入） */
  aim: number | null;
  lives: number;
  gems: number;
  combo: number;
  /** 无敌剩余时间 */
  invuln: number;
  obstacles: Obstacle[];
  gemsArr: Gem[];
  sides: SideTree[];
  flakes: Flake[];
  /** 下一次生成障碍物的距离阈值 */
  nextSpawn: number;
  /** 下一个里程碑（每 500m 提示一次） */
  nextMilestone: number;
  /** 各闪光触发时刻（秒） */
  hitFlash: number;
  gemFlash: number;
  shakeAt: number;
}

function newWorld(): World {
  const sides: SideTree[] = [];
  for (let z = 2; z < FAR; z += 2.4) {
    for (const dir of [-1, 1]) {
      if (Math.random() < 0.8) sides.push({ x: dir * (4.4 + Math.random() * 1.4), z, s: 0.8 + Math.random() * 0.5 });
    }
  }
  const flakes: Flake[] = [];
  for (let i = 0; i < 40; i++) {
    flakes.push({
      x: Math.random() * RW,
      y: Math.random() * RH,
      r: 0.8 + Math.random() * 1.6,
      vy: 22 + Math.random() * 40,
      vx: -14 + Math.random() * 28,
    });
  }
  return {
    dist: 0,
    speed: V0,
    player: { x: 0, vx: 0 },
    aim: null,
    lives: LIVES,
    gems: 0,
    combo: 1,
    invuln: 0,
    obstacles: [],
    gemsArr: [],
    sides,
    flakes,
    nextSpawn: 18,
    nextMilestone: 500,
    hitFlash: -9,
    gemFlash: -9,
    shakeAt: -9,
  };
}

/** 屏幕坐标 → 画布内部坐标 */
function toLocal(e: React.PointerEvent<HTMLCanvasElement>) {
  const rect = e.currentTarget.getBoundingClientRect();
  return { x: ((e.clientX - rect.left) / rect.width) * RW, y: ((e.clientY - rect.top) / rect.height) * RH };
}

// ============ 主组件 ============

type Status = 'ready' | 'playing' | 'paused' | 'over';

export default function Ski3D() {
  const [status, setStatus] = useState<Status>('ready');
  const [dist, setDist] = useState(0);
  const [speed, setSpeed] = useState(V0);
  const [gems, setGems] = useState(0);
  const [lives, setLives] = useState(LIVES);
  const [newRecord, setNewRecord] = useState(false);
  const best = useBestScore(metaSki3D.id);
  const { toast } = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(newWorld());
  const statusRef = useRef<Status>('ready');
  const keysRef = useRef({ l: false, r: false });
  const overHandledRef = useRef(false);
  /** 触屏只跟随第一根手指 */
  const activePtrRef = useRef<number | null>(null);

  statusRef.current = status;

  const start = useCallback(() => {
    worldRef.current = newWorld();
    overHandledRef.current = false;
    setDist(0);
    setSpeed(V0);
    setGems(0);
    setLives(LIVES);
    setNewRecord(false);
    setStatus('playing');
  }, []);

  const togglePause = useCallback(() => {
    const s = statusRef.current;
    if (s === 'playing') setStatus('paused');
    else if (s === 'paused') setStatus('playing');
  }, []);

  // ============ 键盘 ============

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.code;
      if (e.key.startsWith('Arrow') || e.key === ' ') e.preventDefault();
      const keys = keysRef.current;
      if (k === 'ArrowLeft' || k === 'KeyA') keys.l = true;
      else if (k === 'ArrowRight' || k === 'KeyD') keys.r = true;
      else if (k === 'KeyP' || k === 'Space') togglePause();
      else if (k === 'Enter') {
        const s = statusRef.current;
        if (s === 'ready' || s === 'over') start();
      }
    };
    const up = (e: KeyboardEvent) => {
      const keys = keysRef.current;
      const k = e.code;
      if (k === 'ArrowLeft' || k === 'KeyA') keys.l = false;
      else if (k === 'ArrowRight' || k === 'KeyD') keys.r = false;
    };
    // 失焦清空按键并自动暂停，避免按住方向键切窗口后一直转向
    const clear = () => {
      keysRef.current = { l: false, r: false };
      worldRef.current.aim = null;
      if (statusRef.current === 'playing') setStatus('paused');
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') clear();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [start, togglePause]);

  // ============ 指针（鼠标悬停 / 触屏拖动转向） ============

  /** 屏幕 x 逆投影到玩家深度平面的世界 x（相机跟随玩家，需加回相机偏移） */
  const screenToWorldX = (px: number): number => {
    const s = FOCAL / (PZ + CAM);
    return clamp((px - RW / 2) / s + worldRef.current.player.x, -LIMIT, LIMIT);
  };

  const updateAim = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (statusRef.current !== 'playing') return;
    if (activePtrRef.current != null && e.pointerId !== activePtrRef.current) return;
    worldRef.current.aim = screenToWorldX(toLocal(e).x);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (statusRef.current !== 'playing') return;
    if (activePtrRef.current == null) activePtrRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateAim(e);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePtrRef.current === e.pointerId) {
      activePtrRef.current = null;
      worldRef.current.aim = null;
    }
  };

  // ============ 主循环（常驻 rAF：ready/over 也渲染雪坡作背景） ============

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // HiDPI 按 DPR 放大 backing store（封顶 2 控性能），逻辑坐标仍用 RW×RH
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = RW * dpr;
    canvas.height = RH * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /** 世界坐标 → 屏幕投影（相机在玩家后方上方并横向跟随，看向 +z 下坡方向） */
    const proj = (x: number, y: number, z: number, camX: number) => {
      const s = FOCAL / (z + CAM);
      return { x: RW / 2 + (x - camX) * s, y: HOR + (CAMH - y) * s, s };
    };

    /** 远雾混合：k=0 原色，k→1 融入雪白 */
    const fogged = (rgb: string, k: number) => `rgba(${rgb},${(1 - k * 0.82).toFixed(3)})`;

    let raf = 0;
    let last = performance.now();
    let lastDistShown = -1;

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const w = worldRef.current;
      const playing = statusRef.current === 'playing';
      const t = now / 1000;

      // ---- 更新 ----
      if (playing) {
        w.speed = Math.min(VMAX, V0 + w.dist / 40);
        w.dist += w.speed * dt;

        // 转向：指针目标位优先，键盘叠加加速度
        const p = w.player;
        if (w.aim != null) {
          p.vx += (w.aim - p.x) * STEER * 0.9 * dt;
        }
        const dir = (keysRef.current.r ? 1 : 0) - (keysRef.current.l ? 1 : 0);
        if (dir !== 0) p.vx += dir * STEER * dt;
        p.vx *= Math.exp(-DAMP * dt);
        p.x += p.vx * dt;
        if (p.x > LIMIT) {
          p.x = LIMIT;
          p.vx = Math.min(p.vx, 0);
        } else if (p.x < -LIMIT) {
          p.x = -LIMIT;
          p.vx = Math.max(p.vx, 0);
        }

        w.invuln = Math.max(0, w.invuln - dt);

        // ---- 生成：前方阈值到达时铺一段障碍（可能附带宝石） ----
        while (w.dist >= w.nextSpawn) {
          const zAt = w.nextSpawn + FAR * 0.8;
          if (Math.random() < 0.62) {
            const n = 1 + (Math.random() < 0.55 ? 1 : 0);
            const xs: number[] = [];
            for (let i = 0; i < n; i++) {
              let x = -3.2 + Math.random() * 6.4;
              // 与已选位置错开，避免完全重叠
              if (xs.some((o) => Math.abs(o - x) < 1.2)) x = clamp(x + 1.6, -3.2, 3.2);
              xs.push(x);
              const roll = Math.random();
              const type: ObType = roll < 0.5 ? 'tree' : roll < 0.8 ? 'rock' : 'snowman';
              const r = type === 'tree' ? 0.32 : type === 'snowman' ? 0.3 : 0.42;
              w.obstacles.push({ x, z: zAt + Math.random() * 2, type, r, seed: Math.random() });
            }
            // 缝隙里放宝石引导走位（离障碍至少 1.1 米）
            if (Math.random() < 0.45) {
              let gx = -3 + Math.random() * 6;
              if (xs.some((o) => Math.abs(o - gx) < 1.1)) gx = clamp(gx + 1.4, -3, 3);
              w.gemsArr.push({ x: gx, z: zAt + 1 });
            }
          } else if (Math.random() < 0.8) {
            w.gemsArr.push({ x: -2.6 + Math.random() * 5.2, z: zAt });
          }
          // 间距随速度收紧（时间下限约 0.55s），保证始终可穿行
          const gap = clamp(w.speed * 0.72, 8, 16);
          w.nextSpawn += gap;
        }

        // ---- 碰撞与回收 ----
        const rel = (o: { z: number }) => o.z - w.dist;
        for (let i = w.obstacles.length - 1; i >= 0; i--) {
          const o = w.obstacles[i];
          const z = rel(o);
          // 障碍穿过玩家平面（z 从正到负）时判一次碰撞
          if (z < 0) {
            if (w.invuln <= 0 && Math.abs(o.x - p.x) < o.r + 0.26) {
              w.lives -= 1;
              w.combo = 1;
              w.invuln = INVULN;
              w.hitFlash = t;
              w.shakeAt = t;
              setLives(w.lives);
              if (w.lives <= 0) {
                sfx.lose();
                statusRef.current = 'over';
                setStatus('over');
              } else {
                sfx.mismatch();
                toast(`💥 撞上${o.type === 'tree' ? '松树' : o.type === 'rock' ? '岩石' : '雪人'}！剩余 ${w.lives} 条命`, 'info');
              }
            }
            w.obstacles.splice(i, 1);
          } else if (z > FAR * 1.2) {
            w.obstacles.splice(i, 1);
          }
        }
        for (let i = w.gemsArr.length - 1; i >= 0; i--) {
          const g = w.gemsArr[i];
          const z = rel(g);
          if (z < 0.4 && z > -0.4 && Math.abs(g.x - p.x) < 0.6) {
            w.gems += 1;
            w.combo = Math.min(5, w.combo + 1);
            w.dist += 15 * w.combo;
            w.gemFlash = t;
            setGems(w.gems);
            sfx.match();
            if (w.combo > 1) toast(`💎 宝石 ×${w.combo} 连击！里程 +${15 * w.combo}m`, 'success');
            w.gemsArr.splice(i, 1);
          } else if (z < -0.5 || z > FAR * 1.2) {
            w.gemsArr.splice(i, 1);
          }
        }

        // 路边树循环回收
        for (const s of w.sides) {
          s.z -= w.speed * dt;
          if (s.z < -2) {
            s.z += FAR + 2;
            s.s = 0.8 + Math.random() * 0.5;
          }
        }

        // 里程碑提示
        if (w.dist >= w.nextMilestone) {
          toast(`⛷️ 已滑行 ${w.nextMilestone} 米！`, 'success');
          sfx.clear();
          w.nextMilestone += 500;
        }

        // HUD 节流：里程变化 ≥1m 才触发重渲染
        if (Math.floor(w.dist) !== lastDistShown) {
          lastDistShown = Math.floor(w.dist);
          setDist(lastDistShown);
          setSpeed(Math.round(w.speed));
        }
      }

      // 雪花（装饰，不受 playing 门控）
      for (const f of w.flakes) {
        f.y += f.vy * dt;
        f.x += (f.vx + (playing ? -w.player.vx * 2.2 : 0)) * dt;
        if (f.y > RH) {
          f.y = -2;
          f.x = Math.random() * RW;
        }
        if (f.x > RW) f.x -= RW;
        else if (f.x < 0) f.x += RW;
      }

      // ---- 渲染 ----
      const camX = w.player.x;
      const shakeK = Math.max(0, 1 - (t - w.shakeAt) * 4);
      ctx.save();
      if (shakeK > 0) ctx.translate((Math.random() - 0.5) * 7 * shakeK, (Math.random() - 0.5) * 5 * shakeK);

      // 天空
      const sky = ctx.createLinearGradient(0, 0, 0, HOR);
      sky.addColorStop(0, '#2c4c8a');
      sky.addColorStop(1, '#bcd8f2');
      ctx.fillStyle = sky;
      ctx.fillRect(-8, -8, RW + 16, HOR + 8);
      // 太阳
      const sun = ctx.createRadialGradient(RW * 0.76, HOR * 0.42, 4, RW * 0.76, HOR * 0.42, 46);
      sun.addColorStop(0, 'rgba(255,244,214,0.95)');
      sun.addColorStop(1, 'rgba(255,244,214,0)');
      ctx.fillStyle = sun;
      ctx.fillRect(RW * 0.76 - 46, HOR * 0.42 - 46, 92, 92);
      // 远山两层剪影（轻微反向视差，配合相机横向跟随）
      const ridge = (pts: number[], color: string, parallax: number) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(-8, HOR);
        pts.forEach((x, i) => ctx.lineTo(x - camX * parallax, HOR - [26, 44, 30, 58, 34, 48, 24][i % 7] - (i % 2 ? 0 : 10)));
        ctx.lineTo(RW + 8, HOR);
        ctx.closePath();
        ctx.fill();
      };
      ridge([-30, 20, 90, 150, 210, 280, 350, 420, 470, 520], 'rgba(126,160,204,0.7)', 4);
      ridge([-40, 0, 70, 140, 230, 300, 380, 460, 530], 'rgba(90,120,170,0.85)', 8);

      // 雪坡地面
      const snow = ctx.createLinearGradient(0, HOR, 0, RH);
      snow.addColorStop(0, '#dbe9f7');
      snow.addColorStop(1, '#f4f9ff');
      ctx.fillStyle = snow;
      ctx.fillRect(-8, HOR, RW + 16, RH - HOR + 8);

      // 滑道侧边线（近宽远窄）
      ctx.strokeStyle = 'rgba(120,160,210,0.55)';
      ctx.lineWidth = 1.5;
      for (const ex of [-4, 4]) {
        const a = proj(ex, 0, 0, camX);
        const b = proj(ex, 0, FAR, camX);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // 滑行痕线：随距离移动的横向细线，强化速度感
      ctx.strokeStyle = 'rgba(150,185,225,0.5)';
      ctx.lineWidth = 1;
      const stripeGap = 4;
      for (let z = stripeGap - (w.dist % stripeGap); z < FAR; z += stripeGap) {
        const a = proj(-4, 0, z, camX);
        const b = proj(4, 0, z, camX);
        const alpha = Math.max(0, 0.5 - (z / FAR) * 0.55);
        ctx.strokeStyle = `rgba(150,185,225,${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // ---- 收集所有可绘制物按 z 远→近排序（画家算法） ----
      interface Drawable {
        z: number;
        draw: () => void;
      }
      const items: Drawable[] = [];

      for (const s of w.sides) {
        items.push({
          z: s.z,
          draw: () => {
            const b = proj(s.x, 0, s.z, camX);
            const fog = clamp(s.z / FAR, 0, 1);
            const h = 1.9 * s.s * b.s;
            const tw = 0.55 * s.s * b.s;
            // 树干
            ctx.fillStyle = fogged('101,67,33', fog);
            ctx.fillRect(b.x - tw * 0.12, b.y - h * 0.18, tw * 0.24, h * 0.2);
            // 三层针叶
            ctx.fillStyle = fogged('47,94,60', fog);
            for (let l = 0; l < 3; l++) {
              const ly = b.y - h * (0.16 + l * 0.26);
              const lw = tw * (1 - l * 0.24);
              ctx.beginPath();
              ctx.moveTo(b.x - lw, ly);
              ctx.lineTo(b.x + lw, ly);
              ctx.lineTo(b.x, ly - h * 0.36);
              ctx.closePath();
              ctx.fill();
            }
            // 积雪顶
            ctx.fillStyle = fogged('235,244,252', fog);
            ctx.beginPath();
            ctx.moveTo(b.x - tw * 0.3, b.y - h * 0.86);
            ctx.lineTo(b.x + tw * 0.3, b.y - h * 0.86);
            ctx.lineTo(b.x, b.y - h);
            ctx.closePath();
            ctx.fill();
          },
        });
      }

      for (const o of w.obstacles) {
        const z = o.z - w.dist;
        if (z < -0.6 || z > FAR) continue;
        items.push({
          z,
          draw: () => {
            const b = proj(o.x, 0, z, camX);
            const fog = clamp(z / FAR, 0, 1);
            if (o.type === 'tree') {
              const h = (1.7 + o.seed * 0.5) * b.s;
              const tw = (0.62 + o.seed * 0.2) * b.s;
              ctx.fillStyle = fogged('92,60,30', fog);
              ctx.fillRect(b.x - tw * 0.1, b.y - h * 0.14, tw * 0.2, h * 0.16);
              ctx.fillStyle = fogged('36,86,52', fog);
              for (let l = 0; l < 3; l++) {
                const ly = b.y - h * (0.12 + l * 0.26);
                const lw = tw * (1 - l * 0.25);
                ctx.beginPath();
                ctx.moveTo(b.x - lw, ly);
                ctx.lineTo(b.x + lw, ly);
                ctx.lineTo(b.x, ly - h * 0.38);
                ctx.closePath();
                ctx.fill();
              }
            } else if (o.type === 'rock') {
              const rw2 = (0.75 + o.seed * 0.3) * b.s;
              const rh2 = rw2 * (0.62 + o.seed * 0.2);
              ctx.fillStyle = fogged('104,110,126', fog);
              ctx.beginPath();
              ctx.moveTo(b.x - rw2, b.y);
              ctx.lineTo(b.x - rw2 * 0.5, b.y - rh2);
              ctx.lineTo(b.x + rw2 * 0.15, b.y - rh2 * 0.72);
              ctx.lineTo(b.x + rw2, b.y);
              ctx.closePath();
              ctx.fill();
              ctx.fillStyle = fogged('226,236,246', fog);
              ctx.beginPath();
              ctx.moveTo(b.x - rw2 * 0.5, b.y - rh2);
              ctx.lineTo(b.x + rw2 * 0.15, b.y - rh2 * 0.72);
              ctx.lineTo(b.x - rw2 * 0.12, b.y - rh2 * 0.88);
              ctx.closePath();
              ctx.fill();
            } else {
              // 雪人
              const u = b.s * (0.85 + o.seed * 0.2);
              ctx.fillStyle = fogged('244,248,252', fog);
              for (const [cy, cr] of [
                [-u * 0.4, u * 0.52],
                [-u * 1.15, u * 0.36],
                [-u * 1.68, u * 0.24],
              ] as const) {
                ctx.beginPath();
                ctx.arc(b.x, b.y + cy, cr, 0, Math.PI * 2);
                ctx.fill();
              }
              ctx.fillStyle = fogged('30,34,44', fog);
              ctx.beginPath();
              ctx.arc(b.x - u * 0.08, b.y - u * 1.72, u * 0.035, 0, Math.PI * 2);
              ctx.arc(b.x + u * 0.08, b.y - u * 1.72, u * 0.035, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = fogged('240,140,40', fog);
              ctx.beginPath();
              ctx.moveTo(b.x, b.y - u * 1.68);
              ctx.lineTo(b.x + u * 0.22, b.y - u * 1.64);
              ctx.lineTo(b.x, b.y - u * 1.62);
              ctx.closePath();
              ctx.fill();
            }
          },
        });
      }

      for (const g of w.gemsArr) {
        const z = g.z - w.dist;
        if (z < -0.6 || z > FAR) continue;
        items.push({
          z,
          draw: () => {
            const hover = 0.45 + 0.12 * Math.sin(t * 4 + g.x * 3);
            const c = proj(g.x, hover, z, camX);
            const fog = clamp(z / FAR, 0, 1);
            const r = Math.max(1.2, 0.18 * c.s);
            // 光晕
            const glow = ctx.createRadialGradient(c.x, c.y, r * 0.3, c.x, c.y, r * 2.6);
            glow.addColorStop(0, `rgba(120,240,255,${(0.5 - fog * 0.4).toFixed(3)})`);
            glow.addColorStop(1, 'rgba(120,240,255,0)');
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(c.x, c.y, r * 2.6, 0, Math.PI * 2);
            ctx.fill();
            // 菱形宝石
            ctx.fillStyle = fogged('94,225,255', fog);
            ctx.beginPath();
            ctx.moveTo(c.x, c.y - r * 1.3);
            ctx.lineTo(c.x + r, c.y);
            ctx.lineTo(c.x, c.y + r * 1.3);
            ctx.lineTo(c.x - r, c.y);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = `rgba(255,255,255,${(0.7 - fog * 0.5).toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(c.x, c.y - r * 0.7);
            ctx.lineTo(c.x + r * 0.4, c.y);
            ctx.lineTo(c.x, c.y + r * 0.3);
            ctx.closePath();
            ctx.fill();
          },
        });
      }

      items.sort((a, b) => b.z - a.z);
      for (const it of items) it.draw();

      // ---- 滑雪者（近端中央偏下） ----
      const p = w.player;
      const blink = w.invuln > 0 && Math.floor(t * 10) % 2 === 0;
      if (!blink) {
        const base = proj(p.x, 0, PZ, camX);
        const u = base.s;
        const lean = clamp(p.vx * 0.05, -0.4, 0.4);
        // 影子
        ctx.fillStyle = 'rgba(40,60,90,0.28)';
        ctx.beginPath();
        ctx.ellipse(base.x, base.y + u * 0.04, u * 0.42, u * 0.13, 0, 0, Math.PI * 2);
        ctx.fill();
        // 双板
        ctx.strokeStyle = '#e04f4f';
        ctx.lineWidth = Math.max(2, u * 0.07);
        ctx.lineCap = 'round';
        for (const off of [-0.14, 0.14]) {
          ctx.beginPath();
          ctx.moveTo(base.x + (off - 0.05 * lean) * u, base.y + u * 0.02);
          ctx.lineTo(base.x + (off + 0.32 * lean) * u, base.y - u * 0.1);
          ctx.stroke();
        }
        // 身体（倾斜）
        const headX = base.x + lean * u * 0.42;
        const headY = base.y - u * 1.05;
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = Math.max(2.5, u * 0.14);
        ctx.beginPath();
        ctx.moveTo(base.x, base.y - u * 0.12);
        ctx.lineTo(headX, headY + u * 0.16);
        ctx.stroke();
        // 手臂 + 雪杖
        ctx.strokeStyle = '#1e40af';
        ctx.lineWidth = Math.max(1.5, u * 0.07);
        ctx.beginPath();
        ctx.moveTo(base.x - u * 0.3, base.y - u * 0.55);
        ctx.lineTo(base.x + u * 0.3, base.y - u * 0.62);
        ctx.stroke();
        // 头
        ctx.fillStyle = '#ffd9b3';
        ctx.beginPath();
        ctx.arc(headX, headY, u * 0.16, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#e04f4f';
        ctx.beginPath();
        ctx.arc(headX, headY - u * 0.05, u * 0.16, Math.PI, Math.PI * 2);
        ctx.fill();
      }

      // 雪花前景
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (const f of w.flakes) {
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 撞击红闪 / 吃宝石青闪
      const hf = Math.max(0, 1 - (t - w.hitFlash) * 2.2);
      if (hf > 0) {
        ctx.fillStyle = `rgba(255,50,70,${hf * 0.24})`;
        ctx.fillRect(-8, -8, RW + 16, RH + 16);
      }
      const gf = Math.max(0, 1 - (t - w.gemFlash) * 3);
      if (gf > 0) {
        ctx.fillStyle = `rgba(90,240,255,${gf * 0.12})`;
        ctx.fillRect(-8, -8, RW + 16, RH + 16);
      }

      // 画布内 HUD（里程 + 时速）
      if (statusRef.current !== 'ready') {
        ctx.font = '700 15px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(20,40,80,0.85)';
        ctx.fillText(`⛷ ${Math.floor(w.dist)} m`, 12, 24);
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.fillText(`${Math.round(w.speed * 3.6)} km/h`, 12, 42);
        if (w.combo > 1) {
          ctx.fillStyle = '#0891b2';
          ctx.fillText(`💎 连击 ×${w.combo}`, 12, 59);
        }
      }

      ctx.restore();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============ 结算 ============

  useEffect(() => {
    if (status !== 'over') return;
    if (overHandledRef.current) return;
    overHandledRef.current = true;
    const d = Math.floor(worldRef.current.dist);
    // 0 米不入档，避免大厅显示"最远 0m"
    const isNew = d > 0 && best.updateBest(d, (a, b) => a > b);
    setNewRecord(isNew);
    if (isNew) {
      sfx.record();
      toast(`🏆 新纪录！${d} 米`, 'record');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <GameShell
      meta={metaSki3D}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>里程</span>
            <strong>{dist}m</strong>
          </div>
          <div className="stat-box">
            <span>时速</span>
            <strong>{Math.round(speed * 3.6)}km/h</strong>
          </div>
          <div className="stat-box">
            <span>宝石</span>
            <strong>{gems}</strong>
          </div>
          <div className="stat-box">
            <span>生命</span>
            <strong className="s3d-lives">
              {'♥'.repeat(lives)}
              {'♡'.repeat(Math.max(0, LIVES - lives))}
            </strong>
          </div>
          <div className="stat-box">
            <span>{metaSki3D.bestScoreLabel}</span>
            <strong>{best.value != null ? `${best.value}m` : '—'}</strong>
          </div>
        </>
      }
    >
      <div className="s3d">
        <div className="s3d-stage">
          <canvas
            ref={canvasRef}
            className="s3d-canvas"
            role="img"
            aria-label="3D 滑雪游戏画面"
            onPointerDown={onPointerDown}
            onPointerMove={updateAim}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {status === 'ready' && (
            <div className="s3d-overlay">
              <h2>⛷️ 3D 滑雪冲刺</h2>
              <p>
                从雪山之巅俯冲而下，左右转向避开松树、岩石与雪人，
                <br />
                沿途收集宝石可获得里程加成，连续收集触发连击！
                <br />
                滑得越远速度越快，看看你能坚持多少米？
              </p>
              <p className="s3d-keys">← → / A D 转向 · 鼠标悬停 / 触屏拖动直接控制 · 空格暂停</p>
              <button className="btn btn-primary" onClick={start}>
                开始滑行
              </button>
            </div>
          )}
          {status === 'paused' && (
            <div className="s3d-overlay">
              <h2>⏸ 已暂停</h2>
              <button className="btn btn-primary" onClick={togglePause}>
                继续
              </button>
            </div>
          )}
          {status === 'over' && (
            <div className="s3d-overlay">
              <h2>🏁 滑行结束</h2>
              <p>
                总里程 {dist}m · 收集宝石 {gems} 颗
                {newRecord ? ' · 🏆 新纪录！' : best.value != null ? ` · 最远 ${best.value}m` : ''}
              </p>
              <button className="btn btn-primary" onClick={start}>
                再来一次
              </button>
            </div>
          )}
        </div>
        <div className="s3d-actions">
          <button className="btn btn-ghost" onClick={togglePause} disabled={status !== 'playing' && status !== 'paused'}>
            {status === 'paused' ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button className="btn btn-ghost" onClick={start}>
            🔄 重新开始
          </button>
        </div>
        <p className="hint">宝石连击越高里程加成越多 · 撞击后有短暂无敌闪烁</p>
      </div>
    </GameShell>
  );
}
