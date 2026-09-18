import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaPool3D } from '../core/gameMetas';

// ============ 常量 ============

/** 内部渲染分辨率（4:3） */
const RW = 480;
const RH = 360;
const CX = RW / 2;
const CY = RH * 0.54;
const FOCAL = 430;
const CAMD = 11.2;
const YAW = 0.52;
const COSY = Math.cos(YAW);
const SINY = Math.sin(YAW);
const PITCH = 0.72;
const COSP = Math.cos(PITCH);
const SINP = Math.sin(PITCH);

/** 台面尺寸（世界单位，长宽约 2:1） */
const TL = 8.6;
const TW = 4.3;
const HX = TL / 2;
const HZ = TW / 2;
const BALL_R = 0.155;
const POCKET_R = 0.32;
const RAIL_H = 0.28;
const FRAME = 0.38;

const LIVES = 3;
const FRICTION = 1.55;
const STOP_EPS = 0.04;
const MAX_POWER = 9.2;
const MIN_POWER = 1.1;
/** 自由球白球只能放在开球区（x ≤ 此值） */
const CUE_MAX_X = -0.15;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 六个袋口（四角 + 两长边中点） */
const POCKETS: Array<[number, number]> = [
  [-HX + 0.12, -HZ + 0.12],
  [HX - 0.12, -HZ + 0.12],
  [-HX + 0.12, HZ - 0.12],
  [HX - 0.12, HZ - 0.12],
  [0, -HZ + 0.06],
  [0, HZ - 0.06],
];

/** 标准球色：1-7 全色，8 黑，9-15 条纹同色系 */
const BALL_COLORS = [
  '#f5f5f5', // 0 cue
  '#f0c94d',
  '#1f6feb',
  '#e5534b',
  '#a855f7',
  '#f59e0b',
  '#22c55e',
  '#b45309',
  '#1a1a1a',
  '#f0c94d',
  '#1f6feb',
  '#e5534b',
  '#a855f7',
  '#f59e0b',
  '#22c55e',
  '#b45309',
];

interface Ball {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  pocketed: boolean;
  /** 下落动画：>0 表示正在入袋 */
  sink: number;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  color: string;
}

type Phase = 'aim' | 'roll' | 'hand';
type Group = 'solid' | 'stripe';

interface World {
  balls: Ball[];
  phase: Phase;
  /** 瞄准角（世界平面 atan2(dz,dx)） */
  aim: number;
  /** 蓄力 0..1 */
  power: number;
  /** 拖拽瞄准中 */
  dragging: boolean;
  /** 本次拖拽是否已超过击球阈值（防轻点误击） */
  dragArmed: boolean;
  /** 本杆入袋球 id（不含 cue） */
  shotPotted: number[];
  /** 本杆白球是否碰过目标球 */
  cueHit: boolean;
  /** 本杆白球第一次碰到的球 id */
  firstContactId: number | null;
  /** 花色归属：首杆合法进球后确定 */
  group: Group | null;
  score: number;
  lives: number;
  combo: number;
  shots: number;
  particles: Particle[];
  flashAt: number;
  scratchAt: number;
  message: string;
  messageAt: number;
  /** 自由球放置预览 */
  handX: number;
  handZ: number;
}

function ballColors(id: number): string {
  if (id === 0) return '#f7f3ea';
  if (id === 8) return '#141414';
  return BALL_COLORS[id] || '#ccc';
}

function isStripe(id: number): boolean {
  return id >= 9;
}

function rackBalls(): Ball[] {
  const balls: Ball[] = [
    { id: 0, x: -HX * 0.55, z: 0, vx: 0, vz: 0, pocketed: false, sink: 0 },
  ];
  // 标准三角：尖朝白球（-x），底在 +x；底角一全色一条纹
  const gap = BALL_R * 2.08;
  const footX = HX * 0.48;
  // 8 号固定中排；底排两角一全色(7)一条纹(15)
  const order = [1, 9, 2, 10, 8, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15];
  let oi = 0;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col <= row; col++) {
      const x = footX + row * gap * 0.92;
      const z = (col - row / 2) * gap;
      const bid = order[oi++] ?? 1;
      balls.push({ id: bid, x, z, vx: 0, vz: 0, pocketed: false, sink: 0 });
    }
  }
  return balls;
}

function newWorld(): World {
  return {
    balls: rackBalls(),
    phase: 'aim',
    aim: 0,
    power: 0.55,
    dragging: false,
    dragArmed: false,
    shotPotted: [],
    cueHit: false,
    firstContactId: null,
    group: null,
    score: 0,
    lives: LIVES,
    combo: 0,
    shots: 0,
    particles: [],
    flashAt: -9,
    scratchAt: -9,
    message: '',
    messageAt: -9,
    handX: -HX * 0.55,
    handZ: 0,
  };
}

function setMessage(w: World, text: string, t: number) {
  w.message = text;
  w.messageAt = t;
}

function spawnSparkles(w: World, x: number, z: number, color: string) {
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 0.8 + Math.random() * 1.6;
    w.particles.push({
      x,
      y: BALL_R,
      z,
      vx: Math.cos(a) * sp,
      vy: 0.8 + Math.random() * 1.4,
      vz: Math.sin(a) * sp,
      life: 0.45 + Math.random() * 0.25,
      max: 0.7,
      color,
    });
  }
}

function cueBall(w: World): Ball {
  return w.balls[0];
}

function placeCue(w: World, x: number, z: number) {
  const c = cueBall(w);
  const minX = -HX + BALL_R + 0.05;
  const maxX = CUE_MAX_X;
  const minZ = -HZ + BALL_R + 0.05;
  const maxZ = HZ - BALL_R - 0.05;
  let cx = clamp(x, minX, maxX);
  let cz = clamp(z, minZ, maxZ);
  const overlaps = () =>
    w.balls.some((b) => b.id !== 0 && !b.pocketed && Math.hypot(cx - b.x, cz - b.z) < BALL_R * 2 + 0.02);
  // 反复"推开再回钳"：一次推开可能把白球顶到库边外，回钳后又压回原来那颗球上
  for (let pass = 0; pass < 6 && overlaps(); pass++) {
    for (const b of w.balls) {
      if (b.id === 0 || b.pocketed) continue;
      const dx = cx - b.x;
      const dz = cz - b.z;
      const d = Math.hypot(dx, dz);
      const min = BALL_R * 2 + 0.02;
      if (d >= min) continue;
      if (d > 0.0001) {
        const push = (min - d) / d;
        cx -= dx * push;
        cz -= dz * push;
      } else {
        cz += min; // 完全同心：任选一向挪开，下一轮再收敛
      }
      cx = clamp(cx, minX, maxX);
      cz = clamp(cz, minZ, maxZ);
    }
  }
  if (overlaps()) {
    [cx, cz] = defaultCuePos(w); // 拖放点被球群围死，退回一个确定能放的位置
  }
  c.x = cx;
  c.z = cz;
}

function defaultCuePos(w: World): [number, number] {
  const x = -HX * 0.55;
  for (let o = 0; o < 8; o++) {
    const zs = [0, 0.45, -0.45, 0.9, -0.9, 1.3, -1.3, 0.2];
    const z = zs[o];
    let ok = true;
    for (const b of w.balls) {
      if (b.id === 0 || b.pocketed) continue;
      if (Math.hypot(x - b.x, z - b.z) < BALL_R * 2 + 0.04) {
        ok = false;
        break;
      }
    }
    if (ok) return [x, z];
  }
  return [x, 0];
}

function ballsMoving(w: World): boolean {
  return w.balls.some((b) => !b.pocketed && (Math.abs(b.vx) > STOP_EPS || Math.abs(b.vz) > STOP_EPS || b.sink > 0));
}

function ballGroup(id: number): Group | null {
  if (id >= 1 && id <= 7) return 'solid';
  if (id >= 9 && id <= 15) return 'stripe';
  return null;
}

function pocketBall(w: World, b: Ball, px: number, pz: number, now: number) {
  b.pocketed = true;
  b.sink = 1;
  b.vx = 0;
  b.vz = 0;
  if (b.id === 0) {
    w.scratchAt = now;
  } else {
    w.shotPotted.push(b.id);
    spawnSparkles(w, px, pz, ballColors(b.id));
  }
}

/** 袋口捕获：中心距小于袋半径，或已越出台面且落在袋口扇区 */
function tryPocket(w: World, b: Ball, now: number): boolean {
  for (const [px, pz] of POCKETS) {
    const d = Math.hypot(b.x - px, b.z - pz);
    if (d < POCKET_R) {
      pocketBall(w, b, px, pz, now);
      return true;
    }
  }
  // 出界且接近袋口 → 判入袋（防止 nearPocket 环带漏网穿台）
  const outside = b.x < -HX + BALL_R || b.x > HX - BALL_R || b.z < -HZ + BALL_R || b.z > HZ - BALL_R;
  if (outside) {
    for (const [px, pz] of POCKETS) {
      if (Math.hypot(b.x - px, b.z - pz) < POCKET_R + BALL_R * 1.35) {
        pocketBall(w, b, px, pz, now);
        return true;
      }
    }
  }
  return false;
}

// ============ 物理 ============

function stepPhysics(w: World, dt: number, now: number) {
  // 入袋下落动画（不参与碰撞）
  for (const b of w.balls) {
    if (b.pocketed && b.sink > 0) {
      b.sink = Math.max(0, b.sink - dt * 2.8);
    }
  }

  // 子步积分：高速时按位移切分，防穿模
  let maxV = 0;
  for (const b of w.balls) {
    if (b.pocketed) continue;
    maxV = Math.max(maxV, Math.hypot(b.vx, b.vz));
  }
  const maxDisp = BALL_R * 0.85;
  const steps = clamp(Math.ceil((maxV * dt) / maxDisp), 1, 10);
  const sdt = dt / steps;

  for (let s = 0; s < steps; s++) {
    const live = w.balls.filter((b) => !b.pocketed);

    for (const b of live) {
      b.x += b.vx * sdt;
      b.z += b.vz * sdt;
      const damp = Math.exp(-FRICTION * sdt);
      b.vx *= damp;
      b.vz *= damp;
      if (Math.hypot(b.vx, b.vz) < STOP_EPS * 0.5) {
        b.vx = 0;
        b.vz = 0;
      }
    }

    // 袋口
    for (const b of live) {
      if (b.pocketed) continue;
      tryPocket(w, b, now);
    }

    // 库边：袋口附近放宽，但出界必须已被 tryPocket 捕获，否则仍夹紧
    for (const b of live) {
      if (b.pocketed) continue;
      const nearPocket = POCKETS.some(([px, pz]) => Math.hypot(b.x - px, b.z - pz) < POCKET_R + BALL_R * 0.9);
      if (nearPocket) continue;
      if (b.x < -HX + BALL_R) {
        b.x = -HX + BALL_R;
        b.vx = Math.abs(b.vx) * 0.82;
      } else if (b.x > HX - BALL_R) {
        b.x = HX - BALL_R;
        b.vx = -Math.abs(b.vx) * 0.82;
      }
      if (b.z < -HZ + BALL_R) {
        b.z = -HZ + BALL_R;
        b.vz = Math.abs(b.vz) * 0.82;
      } else if (b.z > HZ - BALL_R) {
        b.z = HZ - BALL_R;
        b.vz = -Math.abs(b.vz) * 0.82;
      }
      // nearPocket 但未入袋且仍出界：硬夹回
      if (b.x < -HX + BALL_R || b.x > HX - BALL_R || b.z < -HZ + BALL_R || b.z > HZ - BALL_R) {
        b.x = clamp(b.x, -HX + BALL_R, HX - BALL_R);
        b.z = clamp(b.z, -HZ + BALL_R, HZ - BALL_R);
        b.vx *= 0.5;
        b.vz *= 0.5;
      }
    }

    // 球球碰撞（等质量弹性）
    const arr = w.balls.filter((b) => !b.pocketed);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i];
        const b = arr[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        const min = BALL_R * 2;
        if (dist <= 0.0001 || dist >= min) continue;
        const nx = dx / dist;
        const nz = dz / dist;
        const overlap = (min - dist) * 0.5;
        a.x -= nx * overlap;
        a.z -= nz * overlap;
        b.x += nx * overlap;
        b.z += nz * overlap;
        const avn = a.vx * nx + a.vz * nz;
        const bvn = b.vx * nx + b.vz * nz;
        if (avn - bvn <= 0) continue;
        const rest = 0.96;
        const aTanX = a.vx - avn * nx;
        const aTanZ = a.vz - avn * nz;
        const bTanX = b.vx - bvn * nx;
        const bTanZ = b.vz - bvn * nz;
        const aN = bvn * rest;
        const bN = avn * rest;
        a.vx = aTanX + aN * nx;
        a.vz = aTanZ + aN * nz;
        b.vx = bTanX + bN * nx;
        b.vz = bTanZ + bN * nz;
        if (a.id === 0 || b.id === 0) {
          w.cueHit = true;
          if (w.firstContactId == null) {
            w.firstContactId = a.id === 0 ? b.id : a.id;
          }
        }
      }
    }
  }

  // 粒子（整帧 dt）
  for (let i = w.particles.length - 1; i >= 0; i--) {
    const p = w.particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      w.particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    p.vy -= 4.5 * dt;
  }
}

function ballPoints(id: number): number {
  if (id === 8) return 50;
  if (id >= 9) return 15;
  return 10;
}

// ============ 主组件 ============

type Status = 'ready' | 'playing' | 'paused' | 'over' | 'win';

export default function Pool3D() {
  const [status, setStatus] = useState<Status>('ready');
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(LIVES);
  const [combo, setCombo] = useState(0);
  const [left, setLeft] = useState(15);
  const [phase, setPhase] = useState<Phase>('aim');
  const [group, setGroup] = useState<Group | null>(null);
  const [newRecord, setNewRecord] = useState(false);
  const best = useBestScore(metaPool3D.id);
  const { toast } = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(null as unknown as World);
  // 懒初始化：useRef(newWorld()) 的实参每次渲染都会求值，击球过程中的分数/阶段重渲染会白摆一局球
  if (!worldRef.current) worldRef.current = newWorld();
  const statusRef = useRef<Status>('ready');
  const overHandledRef = useRef(false);

  statusRef.current = status;

  const start = useCallback(() => {
    worldRef.current = newWorld();
    overHandledRef.current = false;
    setScore(0);
    setLives(LIVES);
    setCombo(0);
    setLeft(15);
    setPhase('aim');
    setGroup(null);
    setNewRecord(false);
    setStatus('playing');
  }, []);

  const togglePause = useCallback(() => {
    const s = statusRef.current;
    if (s === 'playing') setStatus('paused');
    else if (s === 'paused') setStatus('playing');
  }, []);

  const shoot = useCallback(() => {
    const w = worldRef.current;
    if (statusRef.current !== 'playing' || w.phase !== 'aim') return;
    const c = cueBall(w);
    if (c.pocketed) return;
    const p = w.power;
    const sp = MIN_POWER + (MAX_POWER - MIN_POWER) * p;
    c.vx = Math.cos(w.aim) * sp;
    c.vz = Math.sin(w.aim) * sp;
    w.shotPotted = [];
    w.cueHit = false;
    w.firstContactId = null;
    w.phase = 'roll';
    w.shots += 1;
    w.dragging = false;
    w.dragArmed = false;
    setPhase('roll');
    sfx.click();
  }, []);

  /** 指针 → 世界平面（y=0） */
  const unproject = useCallback((sx: number, sy: number): [number, number] => {
    const num = (CY - sy) * CAMD;
    const den = FOCAL * SINP - (CY - sy) * COSP;
    const rz = den !== 0 ? num / den : 0;
    const rx = ((sx - CX) * (rz * COSP + CAMD)) / FOCAL;
    const x = rx * COSY + rz * SINY;
    const z = -rx * SINY + rz * COSY;
    return [x, z];
  }, []);

  const project = useCallback((x: number, y: number, z: number) => {
    const rx = x * COSY - z * SINY;
    const rz = x * SINY + z * COSY;
    const dy = y;
    const vy = dy * COSP + rz * SINP;
    const vz = -dy * SINP + rz * COSP;
    const s = FOCAL / (vz + CAMD);
    return { x: CX + rx * s, y: CY - vy * s, s };
  }, []);

  const pointerToCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * RW;
    const sy = ((e.clientY - rect.top) / rect.height) * RH;
    return [sx, sy] as const;
  };

  const updateAimFromPointer = (sx: number, sy: number) => {
    const w = worldRef.current;
    if (statusRef.current !== 'playing') return;
    const c = cueBall(w);
    if (c.pocketed) return;
    const [wx, wz] = unproject(sx, sy);
    const dx = wx - c.x;
    const dz = wz - c.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.18) return;
    w.aim = Math.atan2(dz, dx);
    // 指向目标方向越远力度越大
    w.power = clamp(dist / 3.2, 0.12, 1);
    if (dist >= 0.35) w.dragArmed = true;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const w = worldRef.current;
    if (statusRef.current !== 'playing') return;
    if (w.phase === 'hand') {
      const [sx, sy] = pointerToCanvas(e);
      const [wx, wz] = unproject(sx, sy);
      placeCue(w, wx, wz);
      w.phase = 'aim';
      w.handX = cueBall(w).x;
      w.handZ = cueBall(w).z;
      setPhase('aim');
      sfx.drop();
      return;
    }
    if (w.phase === 'aim') {
      w.dragging = true;
      w.dragArmed = false;
      const [sx, sy] = pointerToCanvas(e);
      updateAimFromPointer(sx, sy);
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const w = worldRef.current;
    if (statusRef.current !== 'playing') return;
    const [sx, sy] = pointerToCanvas(e);
    if (w.phase === 'hand') {
      const [wx, wz] = unproject(sx, sy);
      w.handX = clamp(wx, -HX + BALL_R + 0.05, CUE_MAX_X);
      w.handZ = clamp(wz, -HZ + BALL_R + 0.05, HZ - BALL_R - 0.05);
      return;
    }
    if (w.phase !== 'aim') return;
    if (w.dragging) updateAimFromPointer(sx, sy);
  };

  const onPointerUp = () => {
    const w = worldRef.current;
    if (!w.dragging) return;
    w.dragging = false;
    // 仅当拖拽距离足够才击球，轻点白球/画面不误触
    if (statusRef.current === 'playing' && w.phase === 'aim' && w.dragArmed && w.power > 0.14) shoot();
    w.dragArmed = false;
  };

  // 键盘
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.code;
      if (k.startsWith('Arrow') || k === 'Space') e.preventDefault();
      if (k === 'KeyP' && !e.repeat) togglePause();
      else if (k === 'Enter') {
        const s = statusRef.current;
        if (s === 'ready' || s === 'over' || s === 'win') start();
      } else if (k === 'Space') {
        const s = statusRef.current;
        if (s === 'ready' || s === 'over' || s === 'win') start();
        else if (s === 'paused') togglePause();
        else if (!e.repeat) shoot();
      } else if (statusRef.current === 'playing') {
        const w = worldRef.current;
        if (w.phase !== 'aim') return;
        if (k === 'ArrowLeft' && !e.repeat) {
          w.aim -= 0.06;
          sfx.move();
        } else if (k === 'ArrowRight' && !e.repeat) {
          w.aim += 0.06;
          sfx.move();
        } else if (k === 'ArrowUp' && !e.repeat) {
          w.power = clamp(w.power + 0.06, 0.12, 1);
          sfx.move();
        } else if (k === 'ArrowDown' && !e.repeat) {
          w.power = clamp(w.power - 0.06, 0.12, 1);
          sfx.move();
        }
      }
    };
    const clear = () => {
      if (statusRef.current === 'playing') setStatus('paused');
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') clear();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [start, togglePause, shoot]);

  // 杆结束结算
  const finishShot = useCallback(() => {
    const w = worldRef.current;
    const t = performance.now() / 1000;
    const potted = w.shotPotted.slice();
    const scratched = cueBall(w).pocketed;
    const eight = potted.includes(8);
    const othersLeft = w.balls.filter((b) => b.id !== 0 && b.id !== 8 && !b.pocketed).length;

    const syncLeft = () => {
      const n = w.balls.filter((b) => b.id !== 0 && !b.pocketed).length;
      setLeft(n);
    };

    /** 扣命 + 自由球/结束 */
    const applyFoul = (msg: string): boolean => {
      w.lives -= 1;
      w.combo = 0;
      setLives(w.lives);
      setCombo(0);
      setMessage(w, msg, t);
      sfx.mismatch();
      if (w.lives <= 0) {
        sfx.lose();
        statusRef.current = 'over';
        setStatus('over');
        syncLeft();
        return true;
      }
      const [cx, cz] = defaultCuePos(w);
      placeCue(w, cx, cz);
      cueBall(w).pocketed = false;
      cueBall(w).sink = 0;
      w.phase = 'hand';
      w.handX = cueBall(w).x;
      w.handZ = cueBall(w).z;
      setPhase('hand');
      syncLeft();
      return true;
    };

    // 首碰合法性（花色归属后）：8 号只有在全台清空后才是合法目标，
    // 否则会出现"这杆合法、8 号一进袋就判负"的陷阱；己方打完但对方仍有球时放宽（否则每杆皆犯规）
    const ownLeft = w.group
      ? w.balls.filter((b) => !b.pocketed && ballGroup(b.id) === w.group).length
      : 0;
    const eightReady = othersLeft === 0;
    let contactFoul = false;
    if (!w.cueHit) contactFoul = true;
    else if (w.firstContactId != null && w.firstContactId !== 0) {
      const fc = w.firstContactId;
      if (!eightReady && fc === 8) {
        contactFoul = true;
      } else if (w.group && ownLeft > 0 && fc !== 8 && ballGroup(fc) !== w.group) {
        contactFoul = true;
      }
    }

    // 8 号球
    if (eight) {
      if (othersLeft > 0 || scratched || contactFoul) {
        w.lives = 0;
        setLives(0);
        setMessage(w, othersLeft > 0 ? '提前击落 8 号球！' : '8 号球犯规！', t);
        sfx.lose();
        statusRef.current = 'over';
        setStatus('over');
        syncLeft();
        return;
      }
      const bonus = 80 + w.lives * 40;
      w.score += 50 + bonus;
      setScore(w.score);
      setMessage(w, `清台！奖励 ${bonus}`, t);
      sfx.win();
      statusRef.current = 'win';
      setStatus('win');
      syncLeft();
      return;
    }

    // 进球（含白球同杆落袋时仍计分，再单独判犯规）
    let gain = 0;
    let multi = 0;
    /** 开台时这一杆打进的花色：只有无犯规才锁定归属，否则会出现"进球无效"却已锁花色 */
    let firstPotGroup: Group | null = null;
    for (const id of potted) {
      const g = ballGroup(id);
      if (!g) continue;
      if (w.group && g !== w.group) continue;
      if (!w.group && firstPotGroup === null) firstPotGroup = g;
      gain += ballPoints(id);
      multi += 1;
    }
    const claimGroup = () => {
      if (!w.group && firstPotGroup) {
        w.group = firstPotGroup;
        setGroup(firstPotGroup);
      }
    };

    if (scratched) {
      if (multi > 0) {
        w.score += gain;
        setScore(w.score);
        claimGroup();
        applyFoul(`进球 +${gain}，白球落袋！`);
      } else {
        applyFoul('白球落袋！');
      }
      return;
    }

    if (contactFoul) {
      applyFoul(!w.cueHit ? '空杆犯规！' : multi > 0 ? '首碰犯规，进球不计分！' : '首碰犯规！');
      return;
    }

    claimGroup();
    if (multi > 0) {
      const base = gain * Math.max(1, multi);
      let total = base;
      w.combo += 1;
      if (w.combo >= 2) total = Math.round(base * (1 + (w.combo - 1) * 0.15));
      w.score += total;
      setScore(w.score);
      setCombo(w.combo);
      w.flashAt = t;
      setMessage(w, multi > 1 ? `一杆 ${multi} 球！+${total}` : `漂亮！+${total}`, t);
      sfx.match();
      if (multi >= 3) toast(`🎱 一杆 ${multi} 球！+${total}`, 'success');
      if (w.combo === 5) toast(`🔥 连续进球 ×${w.combo}`, 'success');
    } else {
      w.combo = 0;
      setCombo(0);
    }

    w.phase = 'aim';
    setPhase('aim');
    syncLeft();
  }, [toast]);

  const finishRef = useRef(finishShot);
  finishRef.current = finishShot;

  // 主循环
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = RW * dpr;
    canvas.height = RH * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const proj = project;

    let raf = 0;
    let last = performance.now();
    let settleAcc = 0;

    const loop = (nowMs: number) => {
      const dt = Math.min(0.05, (nowMs - last) / 1000);
      last = nowMs;
      const t = nowMs / 1000;
      const w = worldRef.current;
      const playing = statusRef.current === 'playing';

      if (playing && w.phase === 'roll') {
        stepPhysics(w, dt, t);
        if (!ballsMoving(w)) {
          settleAcc += dt;
          if (settleAcc > 0.12) {
            settleAcc = 0;
            finishRef.current();
          }
        } else {
          settleAcc = 0;
        }
      } else if (playing) {
        // 静止时仍更新粒子
        for (let i = w.particles.length - 1; i >= 0; i--) {
          const p = w.particles[i];
          p.life -= dt;
          if (p.life <= 0) w.particles.splice(i, 1);
          else {
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.z += p.vz * dt;
            p.vy -= 4.5 * dt;
          }
        }
      }

      // ---- 渲染 ----
      ctx.clearRect(0, 0, RW, RH);

      // 房间背景
      const bg = ctx.createLinearGradient(0, 0, 0, RH);
      bg.addColorStop(0, '#12152a');
      bg.addColorStop(1, '#1a1f38');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, RW, RH);

      // 吊灯光晕
      const lamp = proj(0, 2.4, 0);
      const glow = ctx.createRadialGradient(lamp.x, lamp.y, 8, lamp.x, lamp.y, 200);
      glow.addColorStop(0, 'rgba(255,230,160,0.18)');
      glow.addColorStop(0.5, 'rgba(255,200,100,0.05)');
      glow.addColorStop(1, 'rgba(255,200,100,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, RW, RH);

      const shakeK = Math.max(0, 1 - (t - w.flashAt) * 4);
      ctx.save();
      if (shakeK > 0.4) ctx.translate((Math.random() - 0.5) * 3 * shakeK, (Math.random() - 0.5) * 2 * shakeK);

      // 外框（木边）
      const drawQuad = (
        pts: Array<[number, number, number]>,
        fill: string,
        stroke?: string,
      ) => {
        ctx.beginPath();
        pts.forEach(([x, y, z], i) => {
          const p = proj(x, y, z);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      };

      // 台呢（略低于库边顶）
      const feltY = 0;
      drawQuad(
        [
          [-HX, feltY, -HZ],
          [HX, feltY, -HZ],
          [HX, feltY, HZ],
          [-HX, feltY, HZ],
        ],
        '#1f7a45',
      );

      // 台呢纹理线
      ctx.save();
      ctx.globalAlpha = 0.12;
      for (let i = -3; i <= 3; i++) {
        const z = (i / 3) * (HZ - 0.2);
        const a = proj(-HX + 0.1, feltY + 0.01, z);
        const b = proj(HX - 0.1, feltY + 0.01, z);
        ctx.strokeStyle = '#0d3d22';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.restore();

      // 开球线
      const hsA = proj(-HX * 0.45, feltY + 0.02, -HZ + 0.15);
      const hsB = proj(-HX * 0.45, feltY + 0.02, HZ - 0.15);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hsA.x, hsA.y);
      ctx.lineTo(hsB.x, hsB.y);
      ctx.stroke();

      // 库边木框（四条）
      const rail = (x0: number, x1: number, z0: number, z1: number) => {
        // 顶面
        drawQuad(
          [
            [x0, RAIL_H, z0],
            [x1, RAIL_H, z0],
            [x1, RAIL_H, z1],
            [x0, RAIL_H, z1],
          ],
          '#6b3f24',
        );
        // 外侧面（取靠外的那条）
        const outwardZ = Math.abs(z0 + z1) > 0.01 ? (Math.abs(z0) > Math.abs(z1) ? z0 : z1) : z0;
        if (Math.abs(z1 - z0) < Math.abs(x1 - x0)) {
          drawQuad(
            [
              [x0, 0, outwardZ],
              [x1, 0, outwardZ],
              [x1, RAIL_H, outwardZ],
              [x0, RAIL_H, outwardZ],
            ],
            '#4a2a18',
          );
        } else {
          const outwardX = Math.abs(x0) > Math.abs(x1) ? x0 : x1;
          drawQuad(
            [
              [outwardX, 0, z0],
              [outwardX, 0, z1],
              [outwardX, RAIL_H, z1],
              [outwardX, RAIL_H, z0],
            ],
            '#4a2a18',
          );
        }
      };
      // 短边
      rail(-HX - FRAME, -HX, -HZ - FRAME, HZ + FRAME);
      rail(HX, HX + FRAME, -HZ - FRAME, HZ + FRAME);
      // 长边（中间留中袋口）
      rail(-HX - FRAME, HX + FRAME, -HZ - FRAME, -HZ);
      rail(-HX - FRAME, HX + FRAME, HZ, HZ + FRAME);

      // 袋口
      for (const [px, pz] of POCKETS) {
        const p = proj(px, 0.02, pz);
        const pr = Math.max(5, POCKET_R * p.s * 1.15);
        const g = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, pr);
        g.addColorStop(0, '#000');
        g.addColorStop(0.7, '#111');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, pr, 0, Math.PI * 2);
        ctx.fill();
      }

      // 球（按深度排序：远→近，s 小的先画）
      const drawList = w.balls
        .filter((b) => !b.pocketed || b.sink > 0)
        .map((b) => {
          const p = proj(b.x, BALL_R * (1 - (1 - b.sink) * 0.85), b.z);
          return { b, p };
        })
        .sort((a, b2) => a.p.s - b2.p.s);

      for (const { b, p } of drawList) {
        const r = Math.max(3, BALL_R * p.s * (b.pocketed ? b.sink : 1));
        // 影子
        if (!b.pocketed) {
          const sh = proj(b.x + 0.08, 0.01, b.z + 0.08);
          ctx.fillStyle = 'rgba(0,0,0,0.28)';
          ctx.beginPath();
          ctx.ellipse(sh.x, sh.y, r * 0.95, r * 0.55, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        // 球体
        const col = ballColors(b.id);
        const grad = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.1, p.x, p.y, r);
        if (b.id === 0) {
          grad.addColorStop(0, '#ffffff');
          grad.addColorStop(1, '#d8d2c4');
        } else if (b.id === 8) {
          grad.addColorStop(0, '#555');
          grad.addColorStop(1, '#111');
        } else {
          grad.addColorStop(0, col);
          grad.addColorStop(1, shade(col, -35));
        }
        ctx.globalAlpha = b.pocketed ? b.sink : 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        // 条纹
        if (isStripe(b.id) && !b.pocketed) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.clip();
          ctx.fillStyle = '#f5f0e6';
          ctx.fillRect(p.x - r, p.y - r * 0.38, r * 2, r * 0.76);
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 0.42, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        // 号码
        if (b.id > 0 && r > 5 && !b.pocketed) {
          ctx.fillStyle = b.id === 8 || isStripe(b.id) ? '#fff' : '#1a1a1a';
          ctx.font = `700 ${Math.max(7, r * 0.75)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(b.id), p.x, p.y);
        }
        // 高光
        if (!b.pocketed && r > 4) {
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.beginPath();
          ctx.ellipse(p.x - r * 0.3, p.y - r * 0.35, r * 0.28, r * 0.18, -0.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // 自由球预览
      if (playing && w.phase === 'hand') {
        const hp = proj(w.handX, BALL_R, w.handZ);
        const hr = Math.max(4, BALL_R * hp.s);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(hp.x, hp.y, hr + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.beginPath();
        ctx.arc(hp.x, hp.y, hr, 0, Math.PI * 2);
        ctx.fill();
      }

      // 瞄准线 + 球杆
      if (playing && w.phase === 'aim' && !cueBall(w).pocketed) {
        const c = cueBall(w);
        const dirX = Math.cos(w.aim);
        const dirZ = Math.sin(w.aim);
        // 射线求第一碰撞点（球或库边）
        let hitT = 3.2 + w.power * 4.5;
        let hitId = -1;
        for (const b of w.balls) {
          if (b.id === 0 || b.pocketed) continue;
          const dx = b.x - c.x;
          const dz = b.z - c.z;
          const projT = dx * dirX + dz * dirZ;
          if (projT <= 0) continue;
          const perp2 = dx * dx + dz * dz - projT * projT;
          const r2 = (BALL_R * 2) * (BALL_R * 2);
          if (perp2 > r2) continue;
          const thc = Math.sqrt(r2 - perp2);
          const t0 = projT - thc;
          if (t0 > 0.05 && t0 < hitT) {
            hitT = t0;
            hitId = b.id;
          }
        }
        // 库边截断
        const margin = BALL_R;
        const boundT = (lo: number, hi: number, p: number, d: number) => {
          if (Math.abs(d) < 1e-6) return Infinity;
          const t1 = (lo - p) / d;
          const t2 = (hi - p) / d;
          const t = d > 0 ? t2 : t1;
          return t > 0 ? t : Infinity;
        };
        const tx = boundT(-HX + margin, HX - margin, c.x, dirX);
        const tz = boundT(-HZ + margin, HZ - margin, c.z, dirZ);
        hitT = Math.min(hitT, tx, tz);

        const endX = c.x + dirX * hitT;
        const endZ = c.z + dirZ * hitT;
        const a0 = proj(c.x, BALL_R, c.z);
        const a1 = proj(endX, BALL_R, endZ);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(a0.x, a0.y);
        ctx.lineTo(a1.x, a1.y);
        ctx.stroke();
        ctx.setLineDash([]);
        // 碰撞点 ghost 球
        if (hitId > 0) {
          const gr = Math.max(3, BALL_R * a1.s);
          ctx.strokeStyle = 'rgba(255,255,255,0.45)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(a1.x, a1.y, gr, 0, Math.PI * 2);
          ctx.stroke();
          // 目标球出球方向提示
          const target = w.balls.find((b) => b.id === hitId);
          if (target) {
            const tdx = target.x - endX;
            const tdz = target.z - endZ;
            const td = Math.hypot(tdx, tdz) || 1;
            const a2 = proj(target.x + (tdx / td) * 0.9, BALL_R, target.z + (tdz / td) * 0.9);
            ctx.strokeStyle = 'rgba(255,220,120,0.4)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(a1.x, a1.y);
            ctx.lineTo(a2.x, a2.y);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          ctx.beginPath();
          ctx.arc(a1.x, a1.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }

        // 球杆（蓄力时杆身后拉）
        const pull = 0.35 + w.power * 1.1;
        const tip = proj(c.x - dirX * (BALL_R + 0.08 + pull * 0.15), BALL_R + 0.05, c.z - dirZ * (BALL_R + 0.08 + pull * 0.15));
        const butt = proj(c.x - dirX * (BALL_R + 0.08 + pull * 0.15 + 3.2), BALL_R + 0.22, c.z - dirZ * (BALL_R + 0.08 + pull * 0.15 + 3.2));
        const cueGrad = ctx.createLinearGradient(tip.x, tip.y, butt.x, butt.y);
        cueGrad.addColorStop(0, '#e8c99a');
        cueGrad.addColorStop(0.15, '#c49a6c');
        cueGrad.addColorStop(1, '#3a2414');
        ctx.strokeStyle = cueGrad;
        ctx.lineWidth = Math.max(2, 3.2 * tip.s * 0.04);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(butt.x, butt.y);
        ctx.stroke();
        // 杆头
        ctx.fillStyle = '#5b8def';
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, Math.max(1.5, 2 * tip.s * 0.03), 0, Math.PI * 2);
        ctx.fill();
      }

      // 粒子
      for (const p of w.particles) {
        const sp = proj(p.x, p.y, p.z);
        const a = clamp(p.life / p.max, 0, 1);
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, Math.max(1, 2.2 * sp.s * 0.03), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 力度条
      if (playing && (w.phase === 'aim' || w.dragging)) {
        const bw = 100;
        const bh = 8;
        const bx = RW / 2 - bw / 2;
        const by = RH - 22;
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
        const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
        grad.addColorStop(0, '#34d399');
        grad.addColorStop(0.6, '#fbbf24');
        grad.addColorStop(1, '#f87171');
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = grad;
        ctx.fillRect(bx, by, bw * w.power, bh);
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillText('力度', RW / 2, by - 6);
      }

      // 提示消息
      const mk = Math.max(0, 1 - (t - w.messageAt) * 1.4);
      if (mk > 0 && w.message) {
        ctx.font = '700 18px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = `rgba(10,14,28,${(0.65 * mk).toFixed(3)})`;
        ctx.strokeText(w.message, CX, 36);
        ctx.fillStyle = `rgba(255,255,255,${mk.toFixed(3)})`;
        ctx.fillText(w.message, CX, 36);
      }

      ctx.restore();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 结算纪录
  useEffect(() => {
    if (status !== 'over' && status !== 'win') return;
    if (overHandledRef.current) return;
    overHandledRef.current = true;
    const sc = worldRef.current.score;
    const isNew = sc > 0 && best.updateBest(sc, (a, b) => a > b);
    setNewRecord(isNew);
    if (isNew) {
      sfx.record();
      toast(`🏆 新纪录！${sc} 分`, 'record');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <GameShell
      meta={metaPool3D}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>得分</span>
            <strong>{score}</strong>
          </div>
          <div className="stat-box">
            <span>剩余球</span>
            <strong>{left}</strong>
          </div>
          <div className="stat-box">
            <span>机会</span>
            <strong className="pl3d-lives">
              {'●'.repeat(Math.max(0, lives))}
              {'○'.repeat(Math.max(0, LIVES - lives))}
            </strong>
          </div>
          <div className="stat-box">
            <span>连进</span>
            <strong>{combo > 0 ? `×${combo}` : '—'}</strong>
          </div>
          <div className="stat-box">
            <span>花色</span>
            <strong>{group === 'solid' ? '全色' : group === 'stripe' ? '条纹' : '待定'}</strong>
          </div>
          <div className="stat-box">
            <span>{metaPool3D.bestScoreLabel}</span>
            <strong>{best.value != null ? best.value : '—'}</strong>
          </div>
        </>
      }
    >
      <div className="pl3d">
        <div className="pl3d-stage">
          <canvas
            ref={canvasRef}
            className="pl3d-canvas"
            role="img"
            aria-label="3D 台球游戏画面"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {status === 'ready' && (
            <div className="pl3d-overlay">
              <h2>🎱 3D 台球</h2>
              <p>
                清台得分：全色 10 / 条纹 15 / 8 号球 50。
                <br />
                首次合法进球确定你的花色，之后须先碰到己方花色。
                <br />
                一杆多球翻倍、连续进球有连击；犯规或白球落袋扣机会。
              </p>
              <p className="pl3d-keys">拖拽瞄准蓄力，松手击球 · ←→ 调角 ↑↓ 调力 · 空格击球 · P 暂停</p>
              <button className="btn btn-primary" onClick={start}>
                开球
              </button>
            </div>
          )}
          {status === 'paused' && (
            <div className="pl3d-overlay">
              <h2>⏸ 已暂停</h2>
              <button className="btn btn-primary" onClick={togglePause}>
                继续
              </button>
            </div>
          )}
          {(status === 'over' || status === 'win') && (
            <div className="pl3d-overlay" onClick={start}>
              <h2>{status === 'win' ? '🏆 清台成功' : '🏁 游戏结束'}</h2>
              <p>
                得分 {score} · 共 {worldRef.current.shots} 杆
                {newRecord ? ' · 🏆 新纪录！' : best.value != null ? ` · 最佳 ${best.value}` : ''}
              </p>
              <button
                className="btn btn-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  start();
                }}
              >
                再来一局
              </button>
            </div>
          )}
        </div>
        <div className="pl3d-actions">
          <button className="btn btn-ghost" onClick={togglePause} disabled={status !== 'playing' && status !== 'paused'}>
            {status === 'paused' ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button className="btn btn-ghost" onClick={start}>
            🔄 重新开始
          </button>
        </div>
        <p className="hint">
          {phase === 'hand'
            ? '自由球：点击开球区放置白球'
            : `拖拽瞄准蓄力，松手击球 · 花色：${group === 'solid' ? '全色' : group === 'stripe' ? '条纹' : '待定'} · 剩余 ${left} 球`}
        </p>
      </div>
    </GameShell>
  );
}

/** 简单色相偏暗（hex → hex） */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(((n >> 16) & 255) + amt, 0, 255);
  const g = clamp(((n >> 8) & 255) + amt, 0, 255);
  const b = clamp((n & 255) + amt, 0, 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
