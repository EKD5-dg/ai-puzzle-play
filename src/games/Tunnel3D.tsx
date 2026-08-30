import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaTunnel3D } from '../core/gameMetas';

// ============ 常量 ============

/** 内部渲染分辨率（4:3） */
const RW = 480;
const RH = 360;
const CX = RW / 2;
const CY = RH / 2;
const FOCAL = RH * 1.1;
/** 隧道半径（世界单位） */
const TR = 2.6;
/** 飞船平面深度：相机在 z=-ZP 看向 +z，投影分母统一用 z+ZP */
const ZP = 7;
/** 隧道近端截面深度（画到略小于 0，让管壁扫过镜头） */
const ZNEAR = 0.25;
/** 飞船可活动半径（世界单位，≈半个屏宽） */
const LIMIT = 2.05;
/** 环障碍半径（略小于隧道，视觉上贴在壁内） */
const RR = 2.42;
/** 可见最远距离 */
const FAR = 64;
/** 起始/极限速度（米/秒） */
const V0 = 10;
const VMAX = 28;
/** 转向加速度与阻尼 */
const STEER = 30;
const DAMP = 5.4;
const LIVES = 3;
/** 撞后无敌时间（秒） */
const INVULN = 1.6;
/** 飞船碰撞半径 / 吃核心判定半径 */
const SHIP_R = 0.5;
const CORE_R = 0.85;
/** 环自转角速度基准（圈/全程：新生成到飞抵约 2.5s，慢于半圈，保证可预判） */
const SPIN_RATE = 0.16;
/** 环缺口最小角度（度），随难度略收窄 */
const GAP_DEG_EARLY = 132;
const GAP_DEG_LATE = 96;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const TAU = Math.PI * 2;

/** 种子伪随机（稳定不规则轮廓用） */
const hash01 = (n: number) => {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
};

/** 两角差（归一化到 [-PI, PI]） */
const angDiff = (a: number, b: number) => {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

/** 生成一个不与前序重叠 too much 的极角（用于小行星散布） */
function pickAngle(taken: number[], minGap: number): number {
  let a = Math.random() * TAU;
  for (let tries = 0; tries < 14; tries++) {
    if (taken.every((o) => Math.abs(angDiff(o, a)) >= minGap)) return a;
    a = Math.random() * TAU;
  }
  return a;
}

interface Ring {
  z: number;
  /** 缺口中心角 */
  gap: number;
  /** 缺口半宽（弧度） */
  half: number;
  /** 自转速度（弧度/秒） */
  spin: number;
  /** 霓虹色相 */
  hue: number;
  judged: boolean;
}

/** 漂浮陨石：极坐标摆放（贴在隧道壁附近） */
interface Rock {
  z: number;
  a: number;
  /** 距轴心的半径 */
  r: number;
  /** 碰撞半径 */
  cr: number;
  seed: number;
  judged: boolean;
}

/** 能量核心（收集物，直角坐标摆放） */
interface Core {
  x: number;
  y: number;
  z: number;
  judged: boolean;
}

/** 隧道圈（纯装饰，循环回收） */
interface TunnelRing {
  z: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
  hue: number;
}

interface BgStar {
  x: number;
  y: number;
  r: number;
  depth: number;
}

interface World {
  dist: number;
  speed: number;
  player: { x: number; y: number; vx: number; vy: number };
  /** 相机位置（滞后跟随玩家，隧道相对相机偏移，保证飞船始终在画面内） */
  cam: { x: number; y: number };
  /** 指针目标位置（世界坐标，null=无输入） */
  aim: { x: number; y: number } | null;
  lives: number;
  cores: number;
  combo: number;
  invuln: number;
  rings: Ring[];
  rocks: Rock[];
  coreArr: Core[];
  deco: TunnelRing[];
  parts: Particle[];
  stars: BgStar[];
  nextSpawn: number;
  nextMilestone: number;
  hitFlash: number;
  coreFlash: number;
  shakeAt: number;
}

function newWorld(): World {
  const deco: TunnelRing[] = [];
  for (let z = 3; z < FAR; z += 3) deco.push({ z });
  const stars: BgStar[] = [];
  for (let i = 0; i < 70; i++) {
    stars.push({ x: Math.random() * RW, y: Math.random() * RH, r: 0.4 + Math.random() * 1.2, depth: 0.3 + Math.random() * 1 });
  }
  return {
    dist: 0,
    speed: V0,
    player: { x: 0, y: 0, vx: 0, vy: 0 },
    cam: { x: 0, y: 0 },
    aim: null,
    lives: LIVES,
    cores: 0,
    combo: 1,
    invuln: 0,
    rings: [],
    rocks: [],
    coreArr: [],
    deco,
    parts: [],
    stars,
    nextSpawn: 16,
    nextMilestone: 300,
    hitFlash: -9,
    coreFlash: -9,
    shakeAt: -9,
  };
}

/** 世界坐标 → 屏幕投影（相对相机偏移，z 为相对起点距离，尺度随 s 衰减） */
function projX(x: number, camx: number, z: number) {
  return CX + ((x - camx) * FOCAL) / (z + ZP);
}
function projY(y: number, camy: number, z: number) {
  return CY - ((y - camy) * FOCAL) / (z + ZP);
}
/** 尺度系数（物体大小随深度缩放） */
function projS(z: number) {
  return FOCAL / (z + ZP);
}

/** 屏幕坐标 → 飞船深度平面（z=0）的世界坐标（以相机为基准） */
function screenToWorld(px: number, py: number, camx: number, camy: number) {
  const s = projS(0);
  return { x: clamp((px - CX) / s + camx, -LIMIT, LIMIT), y: clamp((CY - py) / s + camy, -LIMIT, LIMIT) };
}

/** 屏幕坐标 → 画布内部坐标 */
function toLocal(e: React.PointerEvent<HTMLCanvasElement>) {
  const rect = e.currentTarget.getBoundingClientRect();
  return { x: ((e.clientX - rect.left) / rect.width) * RW, y: ((e.clientY - rect.top) / rect.height) * RH };
}

// ============ 主组件 ============

type Status = 'ready' | 'playing' | 'paused' | 'over';

export default function Tunnel3D() {
  const [status, setStatus] = useState<Status>('ready');
  const [dist, setDist] = useState(0);
  const [speed, setSpeed] = useState(V0);
  const [cores, setCores] = useState(0);
  const [lives, setLives] = useState(LIVES);
  const [newRecord, setNewRecord] = useState(false);
  const best = useBestScore(metaTunnel3D.id);
  const { toast } = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(newWorld());
  const statusRef = useRef<Status>('ready');
  const keysRef = useRef({ l: false, r: false, u: false, d: false });
  const overHandledRef = useRef(false);
  /** 触屏只跟随第一根手指 */
  const activePtrRef = useRef<number | null>(null);

  statusRef.current = status;

  const start = useCallback(() => {
    worldRef.current = newWorld();
    overHandledRef.current = false;
    setDist(0);
    setSpeed(V0);
    setCores(0);
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
      else if (k === 'ArrowUp' || k === 'KeyW') keys.u = true;
      else if (k === 'ArrowDown' || k === 'KeyS') keys.d = true;
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
      else if (k === 'ArrowUp' || k === 'KeyW') keys.u = false;
      else if (k === 'ArrowDown' || k === 'KeyS') keys.d = false;
    };
    // 失焦清空按键并自动暂停，避免按住方向键切窗口后一直转向
    const clear = () => {
      keysRef.current = { l: false, r: false, u: false, d: false };
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

  // ============ 指针（鼠标悬停 / 触屏拖动飞行） ============

  const updateAim = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (statusRef.current !== 'playing') return;
    if (activePtrRef.current != null && e.pointerId !== activePtrRef.current) return;
    const p = toLocal(e);
    const cam = worldRef.current.cam;
    worldRef.current.aim = screenToWorld(p.x, p.y, cam.x, cam.y);
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

  // ============ 主循环（常驻 rAF：ready/over 也渲染隧道作背景） ============

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // HiDPI 按 DPR 放大 backing store（封顶 2 控性能），逻辑坐标仍用 RW×RH
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = RW * dpr;
    canvas.height = RH * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /** 远雾混合：k=0 原色，k→1 融入深空 */
    const fogA = (rgb: string, a: number, fog: number) => `rgba(${rgb},${(a * (1 - fog * 0.85)).toFixed(3)})`;

    /** 隧道纵向线：从近端角 a 出发，随深度螺旋 */
    const spiralA = (a: number, z: number, twist: number) => a + z * twist;
    /** 隧道轴心在深度 z 处的屏幕投影（相机偏移使管体在画面内平移） */
    const axisAt = (z: number, cam: { x: number; y: number }) => {
      const s = projS(z);
      return { x: CX - cam.x * s, y: CY + cam.y * s, s };
    };

    /** 能量环：外圈 + 辐条 + 缺口端点灯球（带霓虹辉光），半径加 max 保护防负值 */
    const drawGate = (ring: Ring, z: number, t: number, cam: { x: number; y: number }) => {
      const s = projS(z);
      const fog = clamp(z / FAR, 0, 1);
      const { x: mx, y: my } = axisAt(z, cam);
      const rr = Math.max(2, RR * s);
      const hue = ring.hue;
      const seg = 40;
      // 缺口角随接近进度自转：spin 语义=全程总转角(rad)，剩余深度越浅转得越多
      const gapA = ring.gap + (ring.spin * (FAR - z)) / FAR;
      // 外圈辉光打底
      ctx.strokeStyle = fogA('255,255,255', 0.16, fog);
      ctx.lineWidth = Math.max(1.5, s * 0.16);
      ctx.beginPath();
      ctx.arc(mx, my, rr, 0, TAU);
      ctx.stroke();
      // 外圈（只画缺口以外的阻断面）
      ctx.strokeStyle = `hsla(${hue},92%,66%,${(0.92 - fog * 0.6).toFixed(3)})`;
      ctx.lineWidth = Math.max(1.2, s * 0.075);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= seg; i++) {
        const a = gapA + ring.half + (TAU - ring.half * 2) * (i / seg);
        const x = mx + Math.cos(a) * rr;
        const y = my + Math.sin(a) * rr;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // 辐条 + 内毂
      ctx.strokeStyle = `hsla(${hue},80%,58%,${(0.5 - fog * 0.38).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.8, s * 0.035);
      for (let i = 0; i < 6; i++) {
        const a = gapA + ring.half + (TAU - ring.half * 2) * (i / 6);
        ctx.beginPath();
        ctx.moveTo(mx + Math.cos(a) * rr, my + Math.sin(a) * rr);
        ctx.lineTo(mx + Math.cos(a) * rr * 0.42, my + Math.sin(a) * rr * 0.42);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(mx, my, rr * 0.4, 0, TAU);
      ctx.stroke();
      // 缺口端点警示灯球（呼吸闪烁）
      const pulse = 0.65 + 0.35 * Math.sin(t * 6 + ring.z);
      for (const edge of [gapA - ring.half, gapA + ring.half]) {
        const ex = mx + Math.cos(edge) * rr;
        const ey = my + Math.sin(edge) * rr;
        const er = Math.max(1.5, s * 0.13);
        const g = ctx.createRadialGradient(ex, ey, er * 0.2, ex, ey, er * 2.4);
        g.addColorStop(0, `hsla(${hue},95%,72%,${Math.max(0, 0.9 * pulse - fog * 0.6).toFixed(3)})`);
        g.addColorStop(1, `hsla(${hue},95%,72%,0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(ex, ey, er * 2.4, 0, TAU);
        ctx.fill();
        ctx.fillStyle = `hsla(${hue},95%,75%,${(0.95 - fog * 0.6).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(ex, ey, er, 0, TAU);
        ctx.fill();
      }
    };

    /** 漂浮陨石：不规则五边形 + 受光面（极坐标贴壁摆放） */
    const drawRock = (rk: Rock, t: number, cam: { x: number; y: number }) => {
      const z = rk.z;
      const fog = clamp(z / FAR, 0, 1);
      const wob = rk.a + Math.sin(t * 1.2 + rk.seed * 9) * 0.04;
      const wx = Math.cos(wob) * rk.r;
      const wy = Math.sin(wob) * rk.r;
      const s = projS(z);
      const bx = projX(wx, cam.x, z);
      const by = projY(wy, cam.y, z);
      const w = Math.max(2, rk.cr * s * 1.15);
      // 落地感阴影（贴壁暗晕）
      ctx.fillStyle = fogA('0,0,0', 0.5, fog * 0.4);
      ctx.beginPath();
      ctx.ellipse(bx, by, w * 1.25, w * 1.05, rk.seed * TAU, 0, TAU);
      ctx.fill();
      // 主体轮廓（不规则）
      const pts: Array<[number, number]> = [];
      for (let i = 0; i < 5; i++) {
        const a = rk.seed * TAU + (i / 5) * TAU;
        const rad = w * (0.72 + hash01(i * 12.9898 + rk.seed * 78.233) * 0.4);
        pts.push([bx + Math.cos(a) * rad, by + Math.sin(a) * rad]);
      }
      ctx.fillStyle = fogA('104,102,118', 0.98, fog);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.fill();
      // 左上受光面
      ctx.fillStyle = fogA('156,152,170', 0.9, fog);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
      ctx.lineTo(bx, by);
      ctx.closePath();
      ctx.fill();
      // 陨石坑
      ctx.fillStyle = fogA('70,68,84', 0.9, fog);
      ctx.beginPath();
      ctx.arc(bx + w * 0.25, by + w * 0.1, w * 0.2, 0, TAU);
      ctx.arc(bx - w * 0.15, by + w * 0.38, w * 0.13, 0, TAU);
      ctx.fill();
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
        w.speed = Math.min(VMAX, V0 + w.dist / 38);
        w.dist += w.speed * dt;

        // 转向：指针目标位优先，键盘叠加加速度
        const p = w.player;
        if (w.aim != null) {
          p.vx += (w.aim.x - p.x) * STEER * 0.9 * dt;
          p.vy += (w.aim.y - p.y) * STEER * 0.9 * dt;
        }
        const dx = (keysRef.current.r ? 1 : 0) - (keysRef.current.l ? 1 : 0);
        const dy = (keysRef.current.u ? 1 : 0) - (keysRef.current.d ? 1 : 0);
        if (dx !== 0) p.vx += dx * STEER * dt;
        if (dy !== 0) p.vy += dy * STEER * dt;
        p.vx *= Math.exp(-DAMP * dt);
        p.vy *= Math.exp(-DAMP * dt);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        // 圆形活动边界（隧道内飞行）：超出则钉回边界并去掉外向速度分量
        const pr = Math.hypot(p.x, p.y);
        if (pr > LIMIT) {
          const ux = p.x / pr;
          const uy = p.y / pr;
          p.x = ux * LIMIT;
          p.y = uy * LIMIT;
          const vr = p.vx * ux + p.vy * uy;
          if (vr > 0) {
            p.vx -= vr * ux;
            p.vy -= vr * uy;
          }
        }

        // 相机滞后跟随：飞船与隧道同向平移，极限位置也不会出屏
        const kCam = 1 - Math.exp(-6 * dt);
        w.cam.x += (p.x - w.cam.x) * kCam;
        w.cam.y += (p.y - w.cam.y) * kCam;

        w.invuln = Math.max(0, w.invuln - dt);

        // ---- 生成：前方阈值到达时铺一批障碍（环 + 陨石 + 核心） ----
        while (w.dist >= w.nextSpawn) {
          // 核心跳里程后游标追平，避免多批障碍叠在同一 z 成死墙
          w.nextSpawn = Math.max(w.nextSpawn, w.dist);
          const zAt = w.nextSpawn + FAR * 0.8;
          const diff = clamp(w.dist / 2500, 0, 1);
          // 能量环：必出，难度越高缺口越窄、转得越快
          const halfDeg = (GAP_DEG_EARLY - (GAP_DEG_EARLY - GAP_DEG_LATE) * diff) / 2;
          w.rings.push({
            z: zAt,
            gap: Math.random() * TAU,
            half: (halfDeg * Math.PI) / 180,
            spin: (Math.random() < 0.5 ? -1 : 1) * SPIN_RATE * TAU * (0.5 + diff * 0.5) * (0.6 + Math.random() * 0.8),
            hue: Math.floor(Math.random() * 360),
            judged: false,
          });
          // 陨石：难度越高越多（与环错开 z，不同时贴脸）
          const rockN = Math.random() < 0.35 + diff * 0.45 ? (Math.random() < 0.35 + diff * 0.3 ? 2 : 1) : 0;
          const usedA: number[] = [];
          for (let i = 0; i < rockN; i++) {
            const a = pickAngle(usedA, 1.4);
            usedA.push(a);
            w.rocks.push({
              z: zAt + 3 + Math.random() * 3,
              a,
              r: 1.1 + Math.random() * 1.15,
              cr: 0.42 + Math.random() * 0.22,
              seed: Math.random(),
              judged: false,
            });
          }
          // 核心：避开陨石所在扇区
          if (Math.random() < 0.6) {
            let cx2 = 0;
            let cy2 = 0;
            for (let tries = 0; tries < 10; tries++) {
              const a = pickAngle(usedA, 1.0);
              const r = Math.random() * 1.5;
              cx2 = Math.cos(a) * r;
              cy2 = Math.sin(a) * r;
              if (Math.hypot(cx2 - p.x, cy2 - p.y) > 0.8) break;
            }
            w.coreArr.push({ x: cx2, y: cy2, z: zAt + 1.5, judged: false });
          }
          const gap = clamp(w.speed * 0.85, 11, 19);
          w.nextSpawn += gap;
        }

        // ---- 碰撞与回收 ----
        const pAng = Math.atan2(p.y, p.x);
        for (let i = w.rings.length - 1; i >= 0; i--) {
          const rg = w.rings[i];
          const z = rg.z - w.dist;
          if (!rg.judged && z <= 0) {
            rg.judged = true;
            if (z > -1.2 && w.invuln <= 0) {
              const gapA = rg.gap + (rg.spin * (FAR - (rg.z - w.dist))) / FAR;
              // 穿环瞬间贴墙也算撞（缺口外且几乎贴壁）
              const outsideGap = Math.abs(angDiff(pAng, gapA)) > rg.half - 0.06;
              if (outsideGap) {
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
                  toast('⚡ 撞上能量环！对准缺口穿过，剩余 ' + w.lives + ' 条命', 'info');
                }
              }
            }
          }
          if (z < -1 || z > FAR * 1.2) w.rings.splice(i, 1);
        }
        for (let i = w.rocks.length - 1; i >= 0; i--) {
          const rk = w.rocks[i];
          const z = rk.z - w.dist;
          if (!rk.judged && z <= 0) {
            rk.judged = true;
            if (z > -1.2 && w.invuln <= 0) {
              const wob = rk.a + Math.sin(t * 1.2 + rk.seed * 9) * 0.04;
              const rx = Math.cos(wob) * rk.r;
              const ry = Math.sin(wob) * rk.r;
              if (Math.hypot(rx - p.x, ry - p.y) < rk.cr + SHIP_R) {
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
                  toast('🪨 撞上陨石！剩余 ' + w.lives + ' 条命', 'info');
                }
              }
            }
          }
          if (z < -1 || z > FAR * 1.2) w.rocks.splice(i, 1);
        }
        for (let i = w.coreArr.length - 1; i >= 0; i--) {
          const c = w.coreArr[i];
          const z = c.z - w.dist;
          if (!c.judged && z <= 0) {
            c.judged = true;
            if (Math.hypot(c.x - p.x, c.y - p.y) < CORE_R) {
              w.cores += 1;
              w.combo = Math.min(5, w.combo + 1);
              const jump = 12 * w.combo;
              w.dist += jump;
              // 里程前跳会掠过沿途障碍：被掠过及落点前方 4m 内的免判碰撞，
              // 避免"吃核心却被撞"的不公平体验
              for (const rg of w.rings) if (!rg.judged && rg.z - w.dist <= 4) rg.judged = true;
              for (const rk of w.rocks) if (!rk.judged && rk.z - w.dist <= 4) rk.judged = true;
              w.coreFlash = t;
              setCores(w.cores);
              sfx.match();
              if (w.combo > 1) toast(`✨ 能量核心 ×${w.combo} 连击！里程 +${jump}m`, 'success');
              w.coreArr.splice(i, 1);
              continue;
            }
          }
          if (z < -0.5 || z > FAR * 1.2) w.coreArr.splice(i, 1);
        }

        // 隧道圈循环回收
        for (const dr of w.deco) {
          dr.z -= w.speed * dt;
          if (dr.z < -1) dr.z += FAR;
        }

        // 引擎尾焰粒子（只在游玩时发射，屏幕坐标）
        const ps = projS(0);
        const spx = projX(p.x, w.cam.x, 0);
        const spy = projY(p.y, w.cam.y, 0);
        for (let i = 0; i < 2; i++) {
          w.parts.push({
            x: spx + (Math.random() - 0.5) * ps * 0.12,
            y: spy + ps * 0.26 + Math.random() * ps * 0.06,
            vx: (Math.random() - 0.5) * 24 - p.vx * 6,
            vy: 46 + Math.random() * 40,
            life: 0,
            max: 0.35 + Math.random() * 0.25,
            r: 1.5 + Math.random() * 2.5,
            hue: 185 + Math.random() * 40,
          });
        }

        // 里程碑提示
        if (w.dist >= w.nextMilestone) {
          toast(`🚀 已飞行 ${w.nextMilestone} 米！`, 'success');
          sfx.clear();
          w.nextMilestone += 300;
        }

        // HUD 节流：里程变化 ≥1m 才触发重渲染
        if (Math.floor(w.dist) !== lastDistShown) {
          lastDistShown = Math.floor(w.dist);
          setDist(lastDistShown);
          setSpeed(Math.round(w.speed));
        }
      }

      // 粒子寿命推进与回收（不受 playing 门控，暂停/结算时也能自然消散）
      for (let i = w.parts.length - 1; i >= 0; i--) {
        const pt = w.parts[i];
        pt.life += dt;
        if (pt.life > pt.max) {
          w.parts.splice(i, 1);
          continue;
        }
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
      }

      // 背景星点闪烁（装饰，不受 playing 门控）
      for (const st of w.stars) {
        st.x -= (playing ? w.speed : 1.2) * st.depth * 2.4 * dt * ((st.x - CX) / RW + (Math.random() - 0.5) * 0.02);
        st.y -= (playing ? w.speed : 1.2) * st.depth * 2.4 * dt * ((st.y - CY) / RH);
        // 漂出屏幕的星点从中心附近重生（放射状星流强化速度感）
        if (st.x < -4 || st.x > RW + 4 || st.y < -4 || st.y > RH + 4) {
          const a = Math.random() * TAU;
          const r = 4 + Math.random() * 18;
          st.x = CX + Math.cos(a) * r;
          st.y = CY + Math.sin(a) * r;
          st.depth = 0.3 + Math.random();
        }
      }

      // ---- 渲染 ----
      const shakeK = Math.max(0, 1 - (t - w.shakeAt) * 4);
      ctx.save();
      if (shakeK > 0) ctx.translate((Math.random() - 0.5) * 7 * shakeK, (Math.random() - 0.5) * 5 * shakeK);

      // 深空背景
      const sky = ctx.createRadialGradient(CX, CY, 20, CX, CY, RW * 0.72);
      sky.addColorStop(0, '#1b2450');
      sky.addColorStop(0.55, '#0e1330');
      sky.addColorStop(1, '#05070f');
      ctx.fillStyle = sky;
      ctx.fillRect(-8, -8, RW + 16, RH + 16);
      // 星云两团
      const neb = (nx: number, ny: number, nr: number, col: string) => {
        const g = ctx.createRadialGradient(nx, ny, 2, nx, ny, nr);
        g.addColorStop(0, col);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(nx - nr, ny - nr, nr * 2, nr * 2);
      };
      neb(CX - 130, CY - 70, 120, 'rgba(120,60,200,0.14)');
      neb(CX + 140, CY + 80, 130, 'rgba(0,150,200,0.12)');
      // 星点
      ctx.fillStyle = 'rgba(220,230,255,0.9)';
      for (const st of w.stars) {
        ctx.globalAlpha = 0.25 + st.depth * 0.55;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 隧道结构（纵向螺旋线 + 循环横圈，相对相机偏移）
      const cam = w.cam;
      const p = w.player;
      const twist = 0.045 + Math.sin(t * 0.4) * 0.004;
      ctx.lineWidth = 1;
      for (let i = 0; i < 8; i++) {
        const baseA = (i / 8) * TAU + w.dist * 0.01;
        const nA = spiralA(baseA, ZNEAR, twist);
        const fA = spiralA(baseA, FAR, twist);
        const n = axisAt(ZNEAR, cam);
        const f = axisAt(FAR, cam);
        const nx = n.x + Math.cos(nA) * TR * n.s;
        const ny = n.y + Math.sin(nA) * TR * n.s;
        const fx = f.x + Math.cos(fA) * TR * f.s;
        const fy = f.y + Math.sin(fA) * TR * f.s;
        const lg = ctx.createLinearGradient(nx, ny, fx, fy);
        lg.addColorStop(0, 'rgba(90,170,255,0.0)');
        lg.addColorStop(0.25, 'rgba(90,170,255,0.35)');
        lg.addColorStop(1, 'rgba(90,170,255,0.05)');
        ctx.strokeStyle = lg;
        ctx.beginPath();
        ctx.moveTo(nx, ny);
        ctx.lineTo(fx, fy);
        ctx.stroke();
      }
      for (const dr of w.deco) {
        if (dr.z < 0.1) continue;
        const fog = clamp(dr.z / FAR, 0, 1);
        const a = axisAt(dr.z, cam);
        ctx.strokeStyle = fogA('110,190,255', 0.3, fog);
        ctx.beginPath();
        ctx.arc(a.x, a.y, Math.max(1, TR * a.s), 0, TAU);
        ctx.stroke();
      }
      // 中心奇点辉光（灭点固定在屏幕中心）
      const coreGlow = ctx.createRadialGradient(CX, CY, 1, CX, CY, 46);
      coreGlow.addColorStop(0, 'rgba(160,220,255,0.5)');
      coreGlow.addColorStop(1, 'rgba(160,220,255,0)');
      ctx.fillStyle = coreGlow;
      ctx.beginPath();
      ctx.arc(CX, CY, 46, 0, TAU);
      ctx.fill();

      // ---- 收集所有可绘制物按 z 远→近排序（画家算法） ----
      interface Drawable {
        z: number;
        draw: () => void;
      }
      const items: Drawable[] = [];

      for (const rg of w.rings) {
        const z = rg.z - w.dist;
        if (z < 0 || z > FAR) continue;
        items.push({ z, draw: () => drawGate(rg, z, t, cam) });
      }
      for (const rk of w.rocks) {
        const z = rk.z - w.dist;
        if (z < 0 || z > FAR) continue;
        items.push({ z, draw: () => drawRock(rk, t, cam) });
      }
      for (const c of w.coreArr) {
        const z = c.z - w.dist;
        if (z < 0 || z > FAR) continue;
        items.push({
          z,
          draw: () => {
            const s = projS(z);
            const fog = clamp(z / FAR, 0, 1);
            const bobY = c.y + Math.sin(t * 3 + c.x * 4) * 0.08;
            const cxp = projX(c.x, cam.x, z);
            const cyp = projY(bobY, cam.y, z);
            const r = Math.max(1.5, 0.2 * s);
            // 光晕
            const glow = ctx.createRadialGradient(cxp, cyp, r * 0.3, cxp, cyp, r * 2.8);
            glow.addColorStop(0, `rgba(255,225,130,${(0.55 - fog * 0.45).toFixed(3)})`);
            glow.addColorStop(1, 'rgba(255,225,130,0)');
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(cxp, cyp, r * 2.8, 0, TAU);
            ctx.fill();
            // 六角能量核心
            ctx.fillStyle = fogA('255,214,90', 1, fog);
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
              const a = (i / 6) * TAU + t * 2;
              const px2 = cxp + Math.cos(a) * r;
              const py2 = cyp + Math.sin(a) * r;
              if (i === 0) ctx.moveTo(px2, py2);
              else ctx.lineTo(px2, py2);
            }
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = fogA('255,244,200', 0.9, fog);
            ctx.lineWidth = Math.max(0.8, r * 0.16);
            ctx.stroke();
            // 内芯高光
            ctx.fillStyle = `rgba(255,255,255,${(0.85 - fog * 0.5).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(cxp - r * 0.25, cyp - r * 0.25, r * 0.34, 0, TAU);
            ctx.fill();
          },
        });
      }

      items.sort((a, b) => b.z - a.z);
      for (const it of items) it.draw();

      // ---- 尾焰粒子（画在飞船下层） ----
      for (const pt of w.parts) {
        const k = 1 - pt.life / pt.max;
        ctx.fillStyle = `hsla(${pt.hue},100%,68%,${(k * 0.55).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.r * (0.5 + k), 0, TAU);
        ctx.fill();
      }

      // ---- 飞船（尾部视角，随速度倾斜，相机跟随下始终在画面内） ----
      const blink = w.invuln > 0 && Math.floor(t * 10) % 2 === 0;
      if (!blink) {
        const s = projS(0);
        const sx = projX(p.x, cam.x, 0);
        const sy = projY(p.y, cam.y, 0);
        const bank = clamp(p.vx * 0.045, -0.5, 0.5);
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(bank);
        const u = s * 0.3; // 机身尺度（px）
        // 主引擎光晕
        const eng = ctx.createRadialGradient(0, u * 0.62, u * 0.08, 0, u * 0.62, u * 0.7);
        eng.addColorStop(0, 'rgba(130,235,255,0.85)');
        eng.addColorStop(1, 'rgba(130,235,255,0)');
        ctx.fillStyle = eng;
        ctx.beginPath();
        ctx.arc(0, u * 0.62, u * 0.7, 0, TAU);
        ctx.fill();
        // 双翼
        ctx.fillStyle = '#33406b';
        ctx.beginPath();
        ctx.moveTo(-u * 0.28, u * 0.1);
        ctx.lineTo(-u * 1.15, u * 0.52);
        ctx.lineTo(-u * 0.3, u * 0.44);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(u * 0.28, u * 0.1);
        ctx.lineTo(u * 1.15, u * 0.52);
        ctx.lineTo(u * 0.3, u * 0.44);
        ctx.closePath();
        ctx.fill();
        // 翼尖航行灯
        ctx.fillStyle = '#ff5b74';
        ctx.beginPath();
        ctx.arc(-u * 1.08, u * 0.5, u * 0.09, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#59e08f';
        ctx.beginPath();
        ctx.arc(u * 1.08, u * 0.5, u * 0.09, 0, TAU);
        ctx.fill();
        // 机身（上窄下宽的尾视轮廓 + 左亮右暗渐变）
        const body = ctx.createLinearGradient(-u * 0.4, 0, u * 0.4, 0);
        body.addColorStop(0, '#aebadd');
        body.addColorStop(0.5, '#7c8bc0');
        body.addColorStop(1, '#4a5788');
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.moveTo(-u * 0.3, u * 0.5);
        ctx.quadraticCurveTo(-u * 0.44, -u * 0.1, 0, -u * 0.78);
        ctx.quadraticCurveTo(u * 0.44, -u * 0.1, u * 0.3, u * 0.5);
        ctx.closePath();
        ctx.fill();
        // 垂尾
        ctx.fillStyle = '#2e6bd6';
        ctx.beginPath();
        ctx.moveTo(-u * 0.06, u * 0.44);
        ctx.lineTo(0, -u * 0.62);
        ctx.lineTo(u * 0.06, u * 0.44);
        ctx.closePath();
        ctx.fill();
        // 引擎喷口
        ctx.fillStyle = '#131a30';
        ctx.beginPath();
        ctx.ellipse(0, u * 0.5, u * 0.22, u * 0.12, 0, 0, Math.PI);
        ctx.fill();
        ctx.restore();
      }

      // 撞击红闪 / 吃核心金闪
      const hf = Math.max(0, 1 - (t - w.hitFlash) * 2.2);
      if (hf > 0) {
        ctx.fillStyle = `rgba(255,50,70,${hf * 0.24})`;
        ctx.fillRect(-8, -8, RW + 16, RH + 16);
      }
      const cf = Math.max(0, 1 - (t - w.coreFlash) * 3);
      if (cf > 0) {
        ctx.fillStyle = `rgba(255,220,110,${cf * 0.14})`;
        ctx.fillRect(-8, -8, RW + 16, RH + 16);
      }

      // 画布内 HUD（里程 + 时速）
      if (statusRef.current !== 'ready') {
        ctx.font = '700 15px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(190,225,255,0.92)';
        ctx.fillText(`🚀 ${Math.floor(w.dist)} m`, 12, 24);
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.fillText(`${Math.round(w.speed * 12)} km/h`, 12, 42);
        if (w.combo > 1) {
          ctx.fillStyle = '#ffd35c';
          ctx.fillText(`✨ 连击 ×${w.combo}`, 12, 59);
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
      meta={metaTunnel3D}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>里程</span>
            <strong>{dist}m</strong>
          </div>
          <div className="stat-box">
            <span>时速</span>
            <strong>{Math.round(speed * 12)}km/h</strong>
          </div>
          <div className="stat-box">
            <span>核心</span>
            <strong>{cores}</strong>
          </div>
          <div className="stat-box">
            <span>生命</span>
            <strong className="t3d-lives">
              {'♥'.repeat(lives)}
              {'♡'.repeat(Math.max(0, LIVES - lives))}
            </strong>
          </div>
          <div className="stat-box">
            <span>{metaTunnel3D.bestScoreLabel}</span>
            <strong>{best.value != null ? `${best.value}m` : '—'}</strong>
          </div>
        </>
      }
    >
      <div className="t3d">
        <div className="t3d-stage">
          <canvas
            ref={canvasRef}
            className="t3d-canvas"
            role="img"
            aria-label="3D 星空隧道游戏画面"
            onPointerDown={onPointerDown}
            onPointerMove={updateAim}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {status === 'ready' && (
            <div className="t3d-overlay">
              <h2>🌌 3D 星空隧道</h2>
              <p>
                驾驶飞船穿越小行星带的能量隧道，
                <br />
                旋转的能量环只留一道缺口，对准缺口穿过！
                <br />
                收集金色能量核心可获得里程加成，连续收集触发连击！
              </p>
              <p className="t3d-keys">← → ↑ ↓ / WASD 飞行 · 鼠标悬停 / 触屏拖动直接控制 · 空格暂停</p>
              <button className="btn btn-primary" onClick={start}>
                起飞
              </button>
            </div>
          )}
          {status === 'paused' && (
            <div className="t3d-overlay">
              <h2>⏸ 已暂停</h2>
              <button className="btn btn-primary" onClick={togglePause}>
                继续
              </button>
            </div>
          )}
          {status === 'over' && (
            <div className="t3d-overlay">
              <h2>🛬 飞行结束</h2>
              <p>
                总里程 {dist}m · 收集能量核心 {cores} 枚
                {newRecord ? ' · 🏆 新纪录！' : best.value != null ? ` · 最远 ${best.value}m` : ''}
              </p>
              <button className="btn btn-primary" onClick={start}>
                再来一次
              </button>
            </div>
          )}
        </div>
        <div className="t3d-actions">
          <button className="btn btn-ghost" onClick={togglePause} disabled={status !== 'playing' && status !== 'paused'}>
            {status === 'paused' ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button className="btn btn-ghost" onClick={start}>
            🔄 重新开始
          </button>
        </div>
        <p className="hint">能量环会缓慢旋转 · 速度随里程提升 · 撞击后有短暂无敌闪烁</p>
      </div>
    </GameShell>
  );
}
