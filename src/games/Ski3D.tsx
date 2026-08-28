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

/** 在 [lo, hi] 随机取横向位置，重试采样保证与已占用位置拉开 minGap；失败返回 null 由调用方放弃生成，避免静默降级为随机黏连 */
function pickX(taken: number[], lo: number, hi: number, minGap: number): number | null {
  for (let tries = 0; tries < 14; tries++) {
    const x = lo + Math.random() * (hi - lo);
    if (taken.every((o) => Math.abs(o - x) >= minGap)) return x;
  }
  return null;
}

type ObType = 'tree' | 'rock' | 'snowman';

interface Obstacle {
  x: number;
  /** 相对起点距离的位置，渲染/碰撞时用 z = z - dist */
  z: number;
  type: ObType;
  r: number;
  /** 装饰性随机尺寸/相位 */
  seed: number;
  /** 是否已判过碰撞：每个障碍只在穿过玩家平面时判一次，避免里程突变（吃宝石跳跃）时重复/滞后判定 */
  judged: boolean;
}

interface Gem {
  x: number;
  z: number;
  judged: boolean;
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
  // 懒初始化：useRef(newWorld()) 的实参每次渲染都会求值，HUD 高频刷新会白建完整世界
  const worldRef = useRef<World>(null as unknown as World);
  if (!worldRef.current) worldRef.current = newWorld();
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

    /** 雪松：渐变树干 + 三层下垂针叶（含底部阴影、中央体积高亮、层间雪盖） */
    const drawPine = (bx: number, by: number, h: number, tw: number, fog: number) => {
      const trunkH = h * 0.2;
      const trunkW = tw * 0.16;
      // 树干（左亮右暗渐变）
      const tg = ctx.createLinearGradient(bx - trunkW, 0, bx + trunkW, 0);
      tg.addColorStop(0, fogged('134,88,48', fog));
      tg.addColorStop(0.55, fogged('96,64,34', fog));
      tg.addColorStop(1, fogged('54,36,20', fog));
      ctx.fillStyle = tg;
      ctx.beginPath();
      ctx.moveTo(bx - trunkW, by);
      ctx.lineTo(bx - trunkW * 0.7, by - trunkH);
      ctx.lineTo(bx + trunkW * 0.7, by - trunkH);
      ctx.lineTo(bx + trunkW, by);
      ctx.closePath();
      ctx.fill();

      // 三层针叶（底→顶逐层收窄）
      const baseYs = [by - trunkH, by - h * 0.42, by - h * 0.64];
      const apexYs = [by - h * 0.55, by - h * 0.76, by - h];
      const halfWs = [tw, tw * 0.8, tw * 0.56];
      for (let l = 0; l < 3; l++) {
        const bY = baseYs[l];
        const aY = apexYs[l];
        const hw = halfWs[l];
        const sag = (aY - bY) * 0.16; // 底缘下垂
        // 主体
        ctx.fillStyle = fogged('45,96,60', fog);
        ctx.beginPath();
        ctx.moveTo(bx - hw, bY);
        ctx.quadraticCurveTo(bx, bY + sag, bx + hw, bY);
        ctx.lineTo(bx, aY);
        ctx.closePath();
        ctx.fill();
        // 底部深色阴影带
        ctx.strokeStyle = fogged('27,64,42', fog);
        ctx.lineWidth = Math.max(1, tw * 0.05);
        ctx.beginPath();
        ctx.moveTo(bx - hw, bY);
        ctx.quadraticCurveTo(bx, bY + sag, bx + hw, bY);
        ctx.stroke();
        // 中央体积高亮
        ctx.fillStyle = fogged('72,124,84', fog);
        ctx.beginPath();
        ctx.moveTo(bx - hw * 0.12, bY);
        ctx.quadraticCurveTo(bx, bY + sag * 0.5, bx + hw * 0.12, bY);
        ctx.lineTo(bx, aY);
        ctx.closePath();
        ctx.fill();
        // 两侧雪盖（沿上缘）
        ctx.fillStyle = fogged('242,249,254', fog);
        ctx.beginPath();
        ctx.moveTo(bx, aY);
        ctx.lineTo(bx - hw, bY);
        ctx.quadraticCurveTo(bx - hw * 0.55, (aY + bY) / 2, bx - hw * 0.14, aY + (bY - aY) * 0.3);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(bx, aY);
        ctx.lineTo(bx + hw, bY);
        ctx.quadraticCurveTo(bx + hw * 0.55, (aY + bY) / 2, bx + hw * 0.14, aY + (bY - aY) * 0.3);
        ctx.closePath();
        ctx.fill();
      }
      // 顶部雪尖
      ctx.fillStyle = fogged('248,251,254', fog);
      ctx.beginPath();
      ctx.moveTo(bx - tw * 0.14, by - h * 0.93);
      ctx.lineTo(bx + tw * 0.14, by - h * 0.93);
      ctx.lineTo(bx, by - h);
      ctx.closePath();
      ctx.fill();
    };

    /** 雪人：渐变立体三球 + 树枝手臂 + 围巾 + 针织帽 + 脸部细节 + 纽扣 */
    const drawSnowman = (bx: number, by: number, u: number, fog: number) => {
      // 三个雪球（左亮右暗径向渐变）
      const balls: Array<[number, number]> = [
        [by - u * 0.42, u * 0.52],
        [by - u * 1.1, u * 0.38],
        [by - u * 1.6, u * 0.26],
      ];
      for (const [cy, r] of balls) {
        const g = ctx.createRadialGradient(bx - r * 0.35, cy - r * 0.4, r * 0.08, bx, cy, r);
        g.addColorStop(0, fogged('255,255,255', fog));
        g.addColorStop(0.72, fogged('238,245,251', fog));
        g.addColorStop(1, fogged('198,213,229', fog));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 树枝手臂（从中球伸出，带分叉）
      ctx.strokeStyle = fogged('112,76,44', fog);
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.2, u * 0.04);
      for (const dir of [-1, 1]) {
        const shx = bx + dir * u * 0.32;
        const shy = by - u * 1.08;
        const elx = bx + dir * u * 0.66;
        const ely = by - u * 0.92;
        ctx.beginPath();
        ctx.moveTo(shx, shy);
        ctx.lineTo(elx, ely);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(elx, ely);
        ctx.lineTo(elx + dir * u * 0.14, ely - u * 0.12);
        ctx.stroke();
      }

      // 围巾（绕脖 + 垂带）
      const neckY = by - u * 1.36;
      ctx.fillStyle = fogged('226,74,66', fog);
      ctx.beginPath();
      ctx.ellipse(bx, neckY, u * 0.3, u * 0.1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(bx + u * 0.05, neckY);
      ctx.quadraticCurveTo(bx + u * 0.22, neckY + u * 0.1, bx + u * 0.14, neckY + u * 0.32);
      ctx.lineTo(bx + u * 0.08, neckY + u * 0.3);
      ctx.quadraticCurveTo(bx + u * 0.1, neckY + u * 0.08, bx - u * 0.02, neckY);
      ctx.closePath();
      ctx.fill();

      // 针织帽（蓝色帽体 + 白色折边 + 毛球）
      const headY = by - u * 1.6;
      const headR = u * 0.26;
      ctx.fillStyle = fogged('58,120,224', fog);
      ctx.beginPath();
      ctx.moveTo(bx - headR * 0.92, headY - u * 0.08);
      ctx.quadraticCurveTo(bx - headR * 0.6, headY - u * 0.34, bx, headY - u * 0.36);
      ctx.quadraticCurveTo(bx + headR * 0.6, headY - u * 0.34, bx + headR * 0.92, headY - u * 0.08);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = fogged('236,242,250', fog);
      ctx.beginPath();
      ctx.ellipse(bx, headY - u * 0.08, headR * 0.95, u * 0.07, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = fogged('250,251,253', fog);
      ctx.beginPath();
      ctx.arc(bx, headY - u * 0.42, u * 0.07, 0, Math.PI * 2);
      ctx.fill();

      // 脸：眼睛、胡萝卜鼻、微笑
      ctx.fillStyle = fogged('34,38,46', fog);
      ctx.beginPath();
      ctx.arc(bx - u * 0.09, headY - u * 0.02, u * 0.032, 0, Math.PI * 2);
      ctx.arc(bx + u * 0.09, headY - u * 0.02, u * 0.032, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = fogged('242,142,42', fog);
      ctx.beginPath();
      ctx.moveTo(bx, headY);
      ctx.lineTo(bx - u * 0.05, headY + u * 0.12);
      ctx.lineTo(bx + u * 0.05, headY + u * 0.12);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = fogged('52,58,66', fog);
      ctx.lineWidth = Math.max(1, u * 0.025);
      ctx.beginPath();
      ctx.arc(bx, headY + u * 0.06, u * 0.12, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();

      // 纽扣
      ctx.fillStyle = fogged('52,58,66', fog);
      for (const sy of [by - u * 0.98, by - u * 0.8, by - u * 0.62]) {
        ctx.beginPath();
        ctx.arc(bx, sy, u * 0.035, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    /** 岩石：不规则五边形棱角 + 左亮右暗受光 + 落地阴影 + 顶部积雪 */
    const drawRock = (bx: number, by: number, w: number, fog: number, seed: number) => {
      const h = w * (0.5 + seed * 0.3); // 高度
      const dx = (seed - 0.5) * w * 0.6; // 顶点横向偏移（不规则感）
      const L = { x: bx - w, y: by }; // 左下
      const LS = { x: bx - w * 0.6, y: by - h * 0.58 }; // 左上肩
      const P = { x: bx + dx, y: by - h }; // 顶
      const RS = { x: bx + w * 0.72, y: by - h * 0.48 }; // 右上肩
      const R = { x: bx + w, y: by }; // 右下

      // 落地阴影
      ctx.fillStyle = 'rgba(60,80,110,0.22)';
      ctx.beginPath();
      ctx.ellipse(bx, by, w * 1.05, w * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();

      // 主体（中灰）
      ctx.fillStyle = fogged('104,110,124', fog);
      ctx.beginPath();
      ctx.moveTo(L.x, L.y);
      ctx.lineTo(LS.x, LS.y);
      ctx.lineTo(P.x, P.y);
      ctx.lineTo(RS.x, RS.y);
      ctx.lineTo(R.x, R.y);
      ctx.closePath();
      ctx.fill();

      // 左侧受光面（较亮）
      ctx.fillStyle = fogged('150,158,172', fog);
      ctx.beginPath();
      ctx.moveTo(L.x, L.y);
      ctx.lineTo(LS.x, LS.y);
      ctx.lineTo(P.x, P.y);
      ctx.lineTo((P.x + L.x) / 2, by - h * 0.22);
      ctx.closePath();
      ctx.fill();

      // 右侧背光面（较暗）
      ctx.fillStyle = fogged('70,76,90', fog);
      ctx.beginPath();
      ctx.moveTo(P.x, P.y);
      ctx.lineTo(RS.x, RS.y);
      ctx.lineTo(R.x, R.y);
      ctx.lineTo((P.x + R.x) / 2, by - h * 0.26);
      ctx.closePath();
      ctx.fill();

      // 顶部积雪
      ctx.strokeStyle = fogged('240,247,253', fog);
      ctx.lineWidth = Math.max(2, w * 0.13);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(LS.x, LS.y);
      ctx.lineTo(P.x, P.y);
      ctx.lineTo(RS.x, RS.y);
      ctx.stroke();
    };

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
        // 吃宝石大跳跃后 nextSpawn 可能远落后于 dist：先把游标推平到玩家处，
        // 否则 while 多批循环里 Math.max(nextSpawn, dist) 恒取 dist，多批全部
        // 堆叠在同一 zAt 上形成不可穿行的墙、且跨批无横向去重
        if (w.nextSpawn < w.dist) w.nextSpawn = w.dist;
        while (w.dist >= w.nextSpawn) {
          const zAt = w.nextSpawn + FAR * 0.8;
          if (Math.random() < 0.62) {
            const n = 1 + (Math.random() < 0.4 ? 1 : 0);
            const xs: number[] = [];
            for (let i = 0; i < n; i++) {
              const x = pickX(xs, -3.2, 3.2, 2.5);
              if (x == null) continue;
              xs.push(x);
              const roll = Math.random();
              const type: ObType = roll < 0.5 ? 'tree' : roll < 0.8 ? 'rock' : 'snowman';
              const r = type === 'tree' ? 0.32 : type === 'snowman' ? 0.3 : 0.42;
              w.obstacles.push({ x, z: zAt + Math.random() * 2, type, r, seed: Math.random(), judged: false });
            }
            // 宝石单独放前方一排（z 错开 ≥2m 不与障碍同行），横向离障碍 ≥2.2m：
            // 吃宝石半径 0.6 + 最大撞判半径 0.68 ≈ 1.28，留足余量避免"吃宝石顺带撞树"
            if (Math.random() < 0.45) {
              const gx = pickX(xs, -3, 3, 2.2);
              if (gx != null) w.gemsArr.push({ x: gx, z: zAt + 4 + Math.random() * 2, judged: false });
            }
          } else if (Math.random() < 0.8) {
            w.gemsArr.push({ x: -2.6 + Math.random() * 5.2, z: zAt + 1, judged: false });
          }
          // 横向 spacing 已加大；纵向相邻两批间距也放宽，避免远处透视下堆叠成一团
          const gap = clamp(w.speed * 0.82, 10, 18);
          w.nextSpawn += gap;
        }

        // ---- 碰撞与回收 ----
        const rel = (o: { z: number }) => o.z - w.dist;
        for (let i = w.obstacles.length - 1; i >= 0; i--) {
          const o = w.obstacles[i];
          const z = rel(o);
          // 障碍到达玩家平面（z = PZ，即视觉重合位置）时判一次碰撞
          if (!o.judged && z <= PZ) {
            o.judged = true;
            // 只在玩家身前判碰撞：已在身后的障碍（如异常生成）不伤人
            // 窗口放宽到 -1.2 与单帧最大位移（VMAX×dt上限≈1.3m）对齐，防低帧率时障碍单帧跨过判定平面漏扣
            if (z > -1.2 && w.invuln <= 0 && Math.abs(o.x - p.x) < o.r + 0.26) {
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
          }
          if (z < -1) {
            w.obstacles.splice(i, 1);
          } else if (z > FAR * 1.2) {
            w.obstacles.splice(i, 1);
          }
        }
        for (let i = w.gemsArr.length - 1; i >= 0; i--) {
          const g = w.gemsArr[i];
          const z = rel(g);
          // 宝石到达玩家平面时判一次收集
          if (!g.judged && z <= PZ) {
            g.judged = true;
            if (Math.abs(g.x - p.x) < 0.6) {
              w.gems += 1;
              w.combo = Math.min(5, w.combo + 1);
              const jump = 15 * w.combo;
              w.dist += jump;
              // 里程瞬间前跳会把前方障碍直接甩到身后、或把玩家瞬移到障碍跟前，
              // 玩家没有躲避机会：被掠过及落点前方 3.5m 内的障碍免判碰撞，
              // 避免"吃宝石却被撞"的不公平体验
              for (const o of w.obstacles) {
                if (!o.judged && o.z - w.dist <= PZ + 3.5) o.judged = true;
              }
              w.gemFlash = t;
              setGems(w.gems);
              sfx.match();
              if (w.combo > 1) toast(`💎 宝石 ×${w.combo} 连击！里程 +${jump}m`, 'success');
              w.gemsArr.splice(i, 1);
            }
          }
          if (z < -0.5 || z > FAR * 1.2) {
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
      // 远山两层剪影（顶部偏亮带雪感 → 底部略深，轻微反向视差，配合相机横向跟随）
      const ridge = (pts: number[], top: string, bottom: string, parallax: number) => {
        const g = ctx.createLinearGradient(0, HOR - 80, 0, HOR);
        g.addColorStop(0, top);
        g.addColorStop(1, bottom);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-8, HOR);
        pts.forEach((x, i) => ctx.lineTo(x - camX * parallax, HOR - [26, 44, 30, 58, 34, 48, 24][i % 7] - (i % 2 ? 0 : 10)));
        ctx.lineTo(RW + 8, HOR);
        ctx.closePath();
        ctx.fill();
      };
      ridge([-30, 20, 90, 150, 210, 280, 350, 420, 470, 520], 'rgba(196,214,240,0.85)', 'rgba(126,160,204,0.7)', 4);
      ridge([-40, 0, 70, 140, 230, 300, 380, 460, 530], 'rgba(150,178,220,0.9)', 'rgba(90,120,170,0.85)', 8);

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
            drawPine(b.x, b.y, h, tw, fog);
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
              drawPine(b.x, b.y, h, tw, fog);
            } else if (o.type === 'rock') {
              const rw2 = (0.58 + o.seed * 0.28) * b.s;
              drawRock(b.x, b.y, rw2, fog, o.seed);
            } else {
              // 雪人
              const u = b.s * (0.85 + o.seed * 0.2);
              drawSnowman(b.x, b.y, u, fog);
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
            // 描边
            ctx.strokeStyle = `rgba(50,160,200,${(0.85 - fog * 0.5).toFixed(3)})`;
            ctx.lineWidth = Math.max(0.8, r * 0.1);
            ctx.stroke();
            // 顶面高光
            ctx.fillStyle = `rgba(255,255,255,${(0.7 - fog * 0.45).toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(c.x, c.y - r * 1.3);
            ctx.lineTo(c.x + r * 0.55, c.y - r * 0.4);
            ctx.lineTo(c.x - r * 0.55, c.y - r * 0.4);
            ctx.closePath();
            ctx.fill();
            // 底部小反光
            ctx.fillStyle = `rgba(60,180,220,${(0.5 - fog * 0.35).toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(c.x - r * 0.5, c.y + r * 0.32);
            ctx.lineTo(c.x + r * 0.5, c.y + r * 0.32);
            ctx.lineTo(c.x, c.y + r * 0.9);
            ctx.closePath();
            ctx.fill();
            // 闪光星芒
            const sp = Math.max(0, 0.5 + 0.5 * Math.sin(t * 6 + g.x * 5));
            if (sp > 0.4) {
              ctx.strokeStyle = `rgba(255,255,255,${(sp * (0.9 - fog * 0.5)).toFixed(3)})`;
              ctx.lineWidth = Math.max(1, r * 0.12);
              ctx.beginPath();
              ctx.moveTo(c.x - r * 0.5, c.y - r * 0.9);
              ctx.lineTo(c.x + r * 0.5, c.y - r * 0.9);
              ctx.moveTo(c.x, c.y - r * 1.2);
              ctx.lineTo(c.x, c.y - r * 0.6);
              ctx.stroke();
            }
          },
        });
      }

      items.sort((a, b) => b.z - a.z);
      for (const it of items) it.draw();

      // ---- 滑雪者（背面视角，近端中央偏下） ----
      const p = w.player;
      const blink = w.invuln > 0 && Math.floor(t * 10) % 2 === 0;
      if (!blink) {
        const base = proj(p.x, 0, PZ, camX);
        const u = base.s;
        const lean = clamp(p.vx * 0.05, -0.4, 0.4);
        const lx = lean * u; // 头部水平偏移（px），形成倾斜动感

        // 关键纵向层级
        const footY = base.y - u * 0.03;
        const hipY = base.y - u * 0.52;
        const shouY = base.y - u * 0.82;
        const neckY = base.y - u * 0.86;
        const headY = base.y - u * 1.0;
        const headR = u * 0.15;
        const hipX = base.x + lx * 0.15;
        const shouX = base.x + lx * 0.4;
        const headX = base.x + lx * 0.6;

        // —— 影子 ——
        ctx.fillStyle = 'rgba(40,60,90,0.28)';
        ctx.beginPath();
        ctx.ellipse(base.x + lx * 0.4, base.y + u * 0.04, u * 0.48, u * 0.13, lean * 0.3, 0, Math.PI * 2);
        ctx.fill();

        // —— 双板（上翘板头 + 中央高光） ——
        const skiTipOff = lx * 0.5;
        for (const off of [-0.17, 0.17]) {
          const sx = base.x + off * u + lx * 0.14;
          const tx = sx + skiTipOff;
          const bw = u * 0.055; // 板尾半宽
          const tw = u * 0.03; // 板头半宽
          ctx.beginPath();
          ctx.moveTo(sx - bw, footY);
          ctx.lineTo(sx + bw, footY);
          ctx.lineTo(tx + tw, base.y - u * 0.42);
          ctx.quadraticCurveTo(tx + tw * 0.9, base.y - u * 0.55, tx + tw * 0.2, base.y - u * 0.52);
          ctx.lineTo(tx - tw * 0.2, base.y - u * 0.5);
          ctx.lineTo(tx - tw, base.y - u * 0.42);
          ctx.closePath();
          ctx.fillStyle = '#d94040';
          ctx.fill();
          ctx.strokeStyle = 'rgba(150,44,44,0.55)';
          ctx.lineWidth = Math.max(0.8, u * 0.012);
          ctx.stroke();
          ctx.strokeStyle = 'rgba(255,255,255,0.7)';
          ctx.lineWidth = Math.max(1, u * 0.016);
          ctx.beginPath();
          ctx.moveTo(sx, footY - u * 0.02);
          ctx.lineTo(tx, base.y - u * 0.44);
          ctx.stroke();
        }

        // —— 雪靴 ——
        ctx.fillStyle = '#18202e';
        for (const off of [-0.17, 0.17]) {
          const bx = base.x + off * u + lx * 0.14;
          ctx.beginPath();
          ctx.ellipse(bx, footY, u * 0.07, u * 0.05, 0, 0, Math.PI * 2);
          ctx.fill();
        }

        // —— 裤腿（髋→踝） ——
        ctx.strokeStyle = '#24324a';
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(2, u * 0.14);
        for (const off of [-0.12, 0.12]) {
          ctx.beginPath();
          ctx.moveTo(hipX + off * u, hipY);
          ctx.lineTo(base.x + off * u * 1.4 + lx * 0.14, footY - u * 0.02);
          ctx.stroke();
        }

        // —— 躯干（夹克：肩宽腰窄 + 渐变 + 背部接缝 + 领口） ——
        const jacket = ctx.createLinearGradient(shouX - u * 0.24, 0, shouX + u * 0.24, 0);
        jacket.addColorStop(0, '#2e6bd6');
        jacket.addColorStop(0.5, '#3f86ef');
        jacket.addColorStop(1, '#1f4fa6');
        ctx.fillStyle = jacket;
        ctx.beginPath();
        ctx.moveTo(hipX - u * 0.14, hipY);
        ctx.lineTo(shouX - u * 0.22, shouY);
        ctx.quadraticCurveTo(shouX, shouY - u * 0.05, shouX + u * 0.22, shouY);
        ctx.lineTo(hipX + u * 0.14, hipY);
        ctx.closePath();
        ctx.fill();
        // 背部中央接缝
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = Math.max(1, u * 0.015);
        ctx.beginPath();
        ctx.moveTo(hipX, hipY + u * 0.02);
        ctx.lineTo(shouX, shouY - u * 0.02);
        ctx.stroke();
        // 领口
        ctx.fillStyle = '#f4f7fb';
        ctx.beginPath();
        ctx.ellipse(shouX, shouY - u * 0.02, u * 0.09, u * 0.03, 0, 0, Math.PI * 2);
        ctx.fill();

        // —— 手臂（肩→肘→手，持杖弯曲） ——
        ctx.strokeStyle = '#2e6bd6';
        ctx.lineWidth = Math.max(2, u * 0.11);
        for (const dir of [-1, 1]) {
          const sh = { x: shouX + dir * u * 0.2, y: shouY + u * 0.02 };
          const el = { x: shouX + dir * u * 0.34, y: shouY + u * 0.26 };
          const ha = { x: shouX + dir * u * 0.3, y: shouY + u * 0.44 };
          ctx.beginPath();
          ctx.moveTo(sh.x, sh.y);
          ctx.quadraticCurveTo(el.x, el.y, ha.x, ha.y);
          ctx.stroke();
          // 手套
          ctx.fillStyle = '#e9eef5';
          ctx.beginPath();
          ctx.arc(ha.x, ha.y, u * 0.055, 0, Math.PI * 2);
          ctx.fill();
        }

        // —— 雪杖（手→雪面，带杖盘） ——
        ctx.strokeStyle = '#4a5470';
        ctx.lineWidth = Math.max(1.2, u * 0.024);
        for (const dir of [-1, 1]) {
          const ha = { x: shouX + dir * u * 0.3, y: shouY + u * 0.44 };
          const tipX = ha.x + dir * u * 0.05;
          const tipY = base.y - u * 0.12;
          ctx.beginPath();
          ctx.moveTo(ha.x, ha.y);
          ctx.lineTo(tipX, tipY);
          ctx.stroke();
          ctx.fillStyle = '#5b6b8c';
          ctx.beginPath();
          ctx.arc(tipX, tipY, u * 0.05, 0, Math.PI * 2);
          ctx.fill();
        }

        // —— 头部（背视：头盔 + 护目镜带 + 围巾） ——
        ctx.fillStyle = '#f2c9a0';
        ctx.beginPath();
        ctx.arc(headX, headY, headR, 0, Math.PI * 2);
        ctx.fill();
        // 头盔（覆盖后脑上半）
        ctx.fillStyle = '#ff5b56';
        ctx.beginPath();
        ctx.arc(headX, headY - u * 0.02, headR + u * 0.015, Math.PI * 0.85, Math.PI * 2.15);
        ctx.fill();
        // 护目镜带（横向）
        ctx.strokeStyle = '#24324a';
        ctx.lineWidth = Math.max(1.5, u * 0.06);
        ctx.beginPath();
        ctx.moveTo(headX - headR - u * 0.02, headY - u * 0.05);
        ctx.lineTo(headX + headR + u * 0.02, headY - u * 0.05);
        ctx.stroke();
        // 头盔顶饰
        ctx.fillStyle = '#f4f7fb';
        ctx.beginPath();
        ctx.ellipse(headX, headY - u * 0.13, headR * 0.32, u * 0.035, 0, 0, Math.PI * 2);
        ctx.fill();
        // 围巾
        ctx.fillStyle = '#f2b63c';
        ctx.beginPath();
        ctx.ellipse(headX, neckY, u * 0.1, u * 0.04, 0, 0, Math.PI * 2);
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
