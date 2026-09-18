import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaBreak3D } from '../core/gameMetas';

// ============ 常量 ============

/** 内部渲染分辨率（4:3） */
const RW = 480;
const RH = 360;
const CX = RW / 2;
const CY = RH * 0.38;
const FOCAL = 420;
const CAMD = 9.8;
const YAW = 0;
const COSY = Math.cos(YAW);
const SINY = Math.sin(YAW);
/** 俯视：保证挡板与砖墙都落在画布内 */
const PITCH = 0.48;
const COSP = Math.cos(PITCH);
const SINP = Math.sin(PITCH);
/** 注视点偏近端，避免挡板投出画布下沿 */
const LOOK_Z = 3.4;

/** 球台半宽 / 纵深（z: 0 近端挡板 → FAR 远端） */
const HW = 4.0;
const FAR = 9.0;
const NEAR = -0.25;
const SIDE = 0.12;
/** 挡板中心 z / 半长范围 / 厚 / 高 */
const PAD_Z = 0.5;
const PAD_HALF = 1.05;
const PAD_MAX = 1.5;
const PAD_T = 0.24;
const PAD_H = 0.42;
/** 球半径 / 砖块尺寸 */
const BALL_R = 0.17;
const BRICK_W = 0.9;
const BRICK_D = 0.4;
const BRICK_H = 0.34;
const BRICK_GAP = 0.07;
const COLS = 8;
/** 砖墙最远一行中心 z */
const WALL_Z0 = 7.85;
const V0 = 4.2;
const VACC = 0.28;
const VMAX = 8.5;
const MIN_KICK = 0.35;
const LIVES = 3;
/** 球速上限（破砖/触板共用），不封顶会让每次触板 +1% 无限加速 */
const SPEED_CAP_MUL = 1.35;
/** 子步进：单步位移上限（世界单位），须明显小于挡板最薄碰撞带 0.53，否则高速球直接穿板 */
const MAX_STEP = 0.18;
const MAX_SUBSTEPS = 8;
/** 触板后水平分量下限（占速率比例）：正中击球会得到纯竖直球，永远在挡板↔远墙之间往返 */
const PAD_VX_MIN = 0.16;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 每关砖块行数与耐久模式：0=单击碎 1=二击 2=三击 */
const LEVELS: Array<{ rows: number; tough: (r: number, c: number) => number }> = [
  { rows: 5, tough: () => 0 },
  { rows: 6, tough: (r) => (r === 0 ? 1 : 0) },
  { rows: 6, tough: (r, c) => (r === 0 ? 1 : r === 1 && c % 2 === 0 ? 1 : 0) },
  { rows: 7, tough: (r) => (r <= 1 ? 1 : 0) },
  { rows: 7, tough: (r, c) => (r === 0 ? 2 : r <= 2 && (c + r) % 2 === 0 ? 1 : 0) },
  { rows: 8, tough: (r, c) => (r <= 1 ? 1 : r === 2 && c % 2 === 0 ? 1 : r >= 5 && c % 3 === 0 ? 1 : 0) },
];

const ROW_HUES = [345, 28, 48, 140, 195, 265, 310, 200];

interface Brick {
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  hue: number;
  alive: boolean;
}

interface Ball {
  x: number;
  z: number;
  vx: number;
  vz: number;
  y: number;
  vy: number;
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
  hue: number;
}

interface Powerup {
  x: number;
  z: number;
  vz: number;
  kind: 'wide' | 'slow' | 'multiball';
}

type Phase = 'serve' | 'live';
type Status = 'ready' | 'playing' | 'paused' | 'over' | 'win';

interface World {
  bricks: Brick[];
  balls: Ball[];
  particles: Particle[];
  powerups: Powerup[];
  phase: Phase;
  level: number;
  score: number;
  lives: number;
  combo: number;
  bestCombo: number;
  paddleX: number;
  /** 挡板最近的移动方向（0=未移动过）：给纯竖直反弹一个稳定的出射符号 */
  paddleDir: number;
  paddleW: number;
  wideT: number;
  slowT: number;
  flashAt: number;
  shakeAt: number;
  message: string;
  messageAt: number;
  cleared: number;
  total: number;
  endless: number;
}

function spawnBricks(level: number, endless: number): { bricks: Brick[]; total: number } {
  const spec = LEVELS[Math.min(level, LEVELS.length - 1)];
  const rows = Math.min(10, spec.rows + Math.floor(endless * 0.5));
  const bricks: Brick[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLS; c++) {
      // 交错缩进，远端砖墙更有层次
      const inset = r % 2 === 1 ? (BRICK_W + BRICK_GAP) * 0.25 : 0;
      const x = (c - (COLS - 1) / 2) * (BRICK_W + BRICK_GAP) + inset;
      if (Math.abs(x) + BRICK_W / 2 > HW - 0.15) continue;
      const tough = Math.min(2, spec.tough(r, c) + Math.floor(endless / 3));
      bricks.push({
        x,
        z: WALL_Z0 - r * (BRICK_D + BRICK_GAP),
        hp: tough + 1,
        maxHp: tough + 1,
        hue: ROW_HUES[(r + endless) % ROW_HUES.length],
        alive: true,
      });
    }
  }
  return { bricks, total: bricks.length };
}

function newBall(speed: number): Ball {
  const side = Math.random() < 0.5 ? -1 : 1;
  return {
    x: 0,
    z: PAD_Z + 0.45,
    vx: side * speed * (0.25 + Math.random() * 0.25),
    vz: Math.sqrt(Math.max(0.2, speed * speed - (side * speed * 0.35) ** 2)),
    y: BALL_R,
    vy: 0,
  };
}

function newWorld(): World {
  const { bricks, total } = spawnBricks(0, 0);
  return {
    bricks,
    balls: [newBall(V0)],
    particles: [],
    powerups: [],
    phase: 'serve',
    level: 0,
    score: 0,
    lives: LIVES,
    combo: 0,
    bestCombo: 0,
    paddleX: 0,
    paddleDir: 0,
    paddleW: PAD_HALF,
    wideT: 0,
    slowT: 0,
    flashAt: -9,
    shakeAt: -9,
    message: '',
    messageAt: -9,
    cleared: 0,
    total,
    endless: 0,
  };
}

function ballSpeed(w: World): number {
  return clamp(V0 + w.level * VACC + w.endless * 0.18, V0, VMAX);
}

function resetServe(w: World) {
  w.balls = [newBall(ballSpeed(w))];
  w.phase = 'serve';
  w.combo = 0;
  w.wideT = 0;
  w.slowT = 0;
  w.powerups = [];
  w.paddleW = PAD_HALF;
}

function nextLevel(w: World, t: number) {
  w.level += 1;
  if (w.level >= LEVELS.length) {
    w.endless += 1;
    w.message = `🏆 全部通关！无尽 +${w.endless}`;
  } else {
    w.message = `第 ${w.level + 1} 关`;
  }
  w.messageAt = t;
  w.flashAt = t;
  const { bricks, total } = spawnBricks(w.level, w.endless);
  w.bricks = bricks;
  w.total = total;
  w.cleared = 0;
  resetServe(w);
  sfx.win();
}

// 盒子面：法线 + 周界角点索引 + 受光系数
const FACES: Array<{ n: [number, number, number]; idx: [number, number, number, number]; sh: number }> = [
  { n: [1, 0, 0], idx: [1, 5, 6, 2], sh: 0.88 },
  { n: [-1, 0, 0], idx: [0, 3, 7, 4], sh: 0.7 },
  { n: [0, 1, 0], idx: [3, 2, 6, 7], sh: 1 },
  { n: [0, -1, 0], idx: [0, 1, 5, 4], sh: 0.4 },
  { n: [0, 0, 1], idx: [4, 7, 6, 5], sh: 0.94 },
  { n: [0, 0, -1], idx: [0, 1, 2, 3], sh: 0.62 },
];

const CORNERS: Array<[number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

// ============ 主组件 ============

export default function Breakout3D() {
  const [status, setStatus] = useState<Status>('ready');
  const [score, setScore] = useState(0);
  const [level, setLevel] = useState(1);
  const [lives, setLives] = useState(LIVES);
  const [combo, setCombo] = useState(0);
  const [newRecord, setNewRecord] = useState(false);
  const best = useBestScore(metaBreak3D.id);
  const { toast } = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(null as unknown as World);
  // 懒初始化：useRef(newWorld()) 的实参每次渲染都会求值，破砖/拾取强化的重渲染会白建一屏砖块
  if (!worldRef.current) worldRef.current = newWorld();
  const statusRef = useRef<Status>('ready');
  const overHandledRef = useRef(false);
  const keysRef = useRef({ left: false, right: false });
  const pointerRef = useRef<number | null>(null);

  statusRef.current = status;

  const syncHud = useCallback(() => {
    const w = worldRef.current;
    setScore(w.score);
    setLevel(w.level + 1);
    setLives(w.lives);
    setCombo(w.combo);
  }, []);

  const start = useCallback(() => {
    worldRef.current = newWorld();
    overHandledRef.current = false;
    pointerRef.current = null;
    keysRef.current = { left: false, right: false };
    setScore(0);
    setLevel(1);
    setLives(LIVES);
    setCombo(0);
    setNewRecord(false);
    setStatus('playing');
    sfx.click();
  }, []);

  const togglePause = useCallback(() => {
    const s = statusRef.current;
    if (s === 'playing') setStatus('paused');
    else if (s === 'paused') setStatus('playing');
  }, []);

  const serve = useCallback(() => {
    const w = worldRef.current;
    if (statusRef.current !== 'playing' || w.phase !== 'serve') return;
    w.phase = 'live';
    sfx.move();
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
        keysRef.current.left = true;
        e.preventDefault();
      }
      if (e.code === 'ArrowRight' || e.code === 'KeyD') {
        keysRef.current.right = true;
        e.preventDefault();
      }
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (statusRef.current === 'playing') {
          if (worldRef.current.phase === 'serve') serve();
        } else if (statusRef.current === 'ready' || statusRef.current === 'over' || statusRef.current === 'win') {
          start();
        }
      }
      if (e.code === 'KeyP' || e.code === 'Escape') {
        if (statusRef.current === 'playing' || statusRef.current === 'paused') togglePause();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') keysRef.current.left = false;
      if (e.code === 'ArrowRight' || e.code === 'KeyD') keysRef.current.right = false;
    };
    const blur = () => {
      if (statusRef.current === 'playing') setStatus('paused');
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [serve, start, togglePause]);

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

  // ============ 主循环 ============
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(RW * dpr);
    canvas.height = Math.round(RH * dpr);

    const rot = (x: number, y: number, z: number) => {
      const rx = x * COSY - z * SINY;
      const rz = x * SINY + z * COSY;
      return { rx, vy: y * COSP + rz * SINP, vz: -y * SINP + rz * COSP };
    };
    const projAt = (x: number, y: number, z: number) => {
      const r = rot(x, y, z - LOOK_Z);
      const s = FOCAL / (r.vz + CAMD);
      return { x: CX + r.rx * s, y: CY - r.vy * s, s };
    };

    interface Face {
      depth: number;
      pts: Array<[number, number]>;
      style: string;
      glow: boolean;
    }
    const depths = new Array<number>(8).fill(0);

    const drawBox = (
      x0: number,
      x1: number,
      y0: number,
      y1: number,
      z0: number,
      z1: number,
      hue: number,
      sat: number,
      lig: number,
      glow = false,
    ) => {
      const px: number[] = [];
      const py: number[] = [];
      CORNERS.forEach(([bx, by, bz], i) => {
        const r = rot(bx ? x1 : x0, by ? y1 : y0, (bz ? z1 : z0) - LOOK_Z);
        const s = FOCAL / (r.vz + CAMD);
        px.push(CX + r.rx * s);
        py.push(CY - r.vy * s);
        depths[i] = r.vz + CAMD;
      });
      const ctr = rot((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2 - LOOK_Z);
      const faces: Face[] = [];
      for (const f of FACES) {
        const nr = rot(f.n[0], f.n[1], f.n[2]);
        const vv = ctr.vz + CAMD;
        if (nr.rx * ctr.rx + nr.vy * ctr.vy + nr.vz * vv >= 0) continue;
        const [i0, i1, i2, i3] = f.idx;
        faces.push({
          depth: (depths[i0] + depths[i1] + depths[i2] + depths[i3]) / 4,
          pts: [
            [px[i0], py[i0]],
            [px[i1], py[i1]],
            [px[i2], py[i2]],
            [px[i3], py[i3]],
          ],
          style: `hsl(${hue} ${sat}% ${Math.round(lig * f.sh)}%)`,
          glow,
        });
      }
      faces.sort((a, b) => b.depth - a.depth);
      for (const f of faces) {
        if (f.glow) {
          ctx.shadowColor = `hsla(${hue} 90% 60% / 0.85)`;
          ctx.shadowBlur = 10;
        }
        ctx.fillStyle = f.style;
        ctx.beginPath();
        ctx.moveTo(f.pts[0][0], f.pts[0][1]);
        for (let i = 1; i < 4; i++) ctx.lineTo(f.pts[i][0], f.pts[i][1]);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(8,12,28,0.28)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    };

    let raf = 0;
    let last = performance.now();

    const burst = (w: World, x: number, y: number, z: number, hue: number, n = 8) => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 1.2 + Math.random() * 2.4;
        w.particles.push({
          x,
          y,
          z,
          vx: Math.cos(a) * sp * 0.4,
          vy: 0.8 + Math.random() * 2.2,
          vz: Math.sin(a) * sp * 0.35,
          life: 0.35 + Math.random() * 0.35,
          max: 0.7,
          hue,
        });
      }
    };

    const hitBrick = (w: World, b: Brick) => {
      b.hp -= 1;
      if (b.hp <= 0) {
        b.alive = false;
        w.cleared += 1;
        w.combo += 1;
        w.bestCombo = Math.max(w.bestCombo, w.combo);
        w.score += (10 + w.level * 2) * Math.max(1, w.combo);
        burst(w, b.x, BRICK_H * 0.5, b.z, b.hue, 10);
        sfx.merge();
        if (Math.random() < 0.14) {
          const kinds: Powerup['kind'][] = ['wide', 'slow', 'multiball'];
          w.powerups.push({
            x: b.x,
            z: b.z,
            vz: -2.2,
            kind: kinds[(Math.random() * kinds.length) | 0],
          });
        }
      } else {
        w.score += 4;
        burst(w, b.x, BRICK_H * 0.5, b.z, b.hue, 5);
        sfx.move();
      }
    };

    const loop = (now: number) => {
      const dt = Math.min(0.04, (now - last) / 1000);
      last = now;
      const w = worldRef.current;
      const playing = statusRef.current === 'playing';
      const t = now / 1000;

      if (playing) {
        const spd = 6.5;
        const px0 = w.paddleX;
        if (keysRef.current.left) w.paddleX -= spd * dt;
        if (keysRef.current.right) w.paddleX += spd * dt;
        if (pointerRef.current != null) {
          w.paddleX += (pointerRef.current - w.paddleX) * Math.min(1, dt * 14);
        }
        w.paddleX = clamp(w.paddleX, -HW + w.paddleW + SIDE, HW - w.paddleW - SIDE);
        // 记住真实位移方向（含被边界钳住不动的情况不更新），供触板出射角取符号
        if (w.paddleX !== px0) w.paddleDir = w.paddleX > px0 ? 1 : -1;

        if (w.wideT > 0) {
          w.wideT -= dt;
          if (w.wideT <= 0) w.paddleW = PAD_HALF;
        }
        if (w.slowT > 0) w.slowT -= dt;

        if (w.phase === 'serve' && w.balls.length === 1) {
          w.balls[0].x = w.paddleX;
          w.balls[0].z = PAD_Z + 0.45;
          w.balls[0].y = BALL_R;
        }

        const speedMul = w.slowT > 0 ? 0.72 : 1;
        for (let bi = w.balls.length - 1; bi >= 0; bi--) {
          const b = w.balls[bi];
          b.vy -= 14 * dt;
          b.y += b.vy * dt;
          if (b.y < BALL_R) {
            b.y = BALL_R;
            b.vy = 0;
          }

          // 子步进：高速时单帧位移会超过挡板最薄碰撞带（0.53）直接穿板漏球，切成小段逐段判碰撞
          const hdt = dt * speedMul;
          const travel = Math.hypot(b.vx, b.vz) * hdt;
          const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(travel / MAX_STEP)));
          const h = hdt / steps;
          for (let s = 0; s < steps; s++) {
            b.x += b.vx * h;
            b.z += b.vz * h;

            if (b.x < -HW + BALL_R) {
              b.x = -HW + BALL_R;
              b.vx = Math.abs(b.vx);
              sfx.click();
            } else if (b.x > HW - BALL_R) {
              b.x = HW - BALL_R;
              b.vx = -Math.abs(b.vx);
              sfx.click();
            }
            if (b.z > FAR - BALL_R) {
              b.z = FAR - BALL_R;
              b.vz = -Math.abs(b.vz);
              sfx.click();
            }

            // 挡板反弹：击中位置决定出射角
            if (
              b.vz < 0 &&
              b.z <= PAD_Z + PAD_T + BALL_R &&
              b.z >= PAD_Z - PAD_T * 0.5 &&
              Math.abs(b.x - w.paddleX) <= w.paddleW + BALL_R * 0.6
            ) {
              b.z = PAD_Z + PAD_T + BALL_R;
              const rel = clamp((b.x - w.paddleX) / (w.paddleW + 1e-6), -1, 1);
              const cap = ballSpeed(w) * SPEED_CAP_MUL;
              const sp = Math.min(Math.hypot(b.vx, b.vz) * 1.01, cap);
              const ang = Math.PI / 2 - rel * 0.95;
              b.vx = Math.cos(ang) * sp;
              b.vz = Math.abs(Math.sin(ang) * sp);
              // 正中以心 = 纯竖直死循环：补一个水平下限，方向取挡板移动方向（未移动过则取击球偏侧）
              const minVx = sp * PAD_VX_MIN;
              if (Math.abs(b.vx) < minVx) {
                const dir = w.paddleDir !== 0 ? w.paddleDir : rel >= 0 ? 1 : -1;
                b.vx = dir * minVx;
                b.vz = Math.sqrt(Math.max(0, sp * sp - minVx * minVx));
              }
              b.vy = 2.2;
              w.combo = 0;
              sfx.drop();
            }

            // 砖块碰撞：选侵入更深的轴反弹（每子步只碎一块，与旧逻辑一致）
            for (const br of w.bricks) {
              if (!br.alive) continue;
              const hw = BRICK_W / 2 + BALL_R;
              const hd = BRICK_D / 2 + BALL_R;
              const dx = b.x - br.x;
              const dz = b.z - br.z;
              if (Math.abs(dx) < hw && Math.abs(dz) < hd) {
                const ox = hw - Math.abs(dx);
                const oz = hd - Math.abs(dz);
                const sp = Math.hypot(b.vx, b.vz) || 1;
                if (ox < oz) {
                  const sx = dx >= 0 ? 1 : -1;
                  b.x = br.x + sx * hw;
                  b.vx = sx * Math.max(Math.abs(b.vx), sp * MIN_KICK);
                } else {
                  const sz = dz >= 0 ? 1 : -1;
                  b.z = br.z + sz * hd;
                  b.vz = sz * Math.max(Math.abs(b.vz), sp * MIN_KICK);
                }
                const cap = ballSpeed(w) * SPEED_CAP_MUL;
                const sp2 = Math.hypot(b.vx, b.vz);
                if (sp2 > cap) {
                  b.vx = (b.vx / sp2) * cap;
                  b.vz = (b.vz / sp2) * cap;
                }
                hitBrick(w, br);
                break;
              }
            }
          }

          if (b.z < NEAR - 0.4) w.balls.splice(bi, 1);
        }

        for (let i = w.powerups.length - 1; i >= 0; i--) {
          const p = w.powerups[i];
          p.z += p.vz * dt;
          if (
            p.z <= PAD_Z + PAD_T + 0.3 &&
            p.z >= PAD_Z - 0.5 &&
            Math.abs(p.x - w.paddleX) <= w.paddleW + 0.4
          ) {
            if (p.kind === 'wide') {
              w.wideT = 10;
              w.paddleW = PAD_MAX;
              w.message = '加宽挡板！';
            } else if (p.kind === 'slow') {
              w.slowT = 8;
              w.message = '时间减速！';
            } else {
              const src = w.balls[0];
              if (src) {
                for (let k = 0; k < 2; k++) {
                  const ang = Math.atan2(src.vz, src.vx) + (k === 0 ? 0.45 : -0.45);
                  const sp = Math.hypot(src.vx, src.vz);
                  w.balls.push({
                    x: src.x,
                    z: src.z,
                    vx: Math.cos(ang) * sp,
                    vz: Math.sin(ang) * sp,
                    y: src.y,
                    vy: 1.5,
                  });
                }
              }
              w.message = '三重球！';
            }
            w.messageAt = t;
            sfx.match();
            w.powerups.splice(i, 1);
            continue;
          }
          if (p.z < NEAR - 0.6) w.powerups.splice(i, 1);
        }

        for (let i = w.particles.length - 1; i >= 0; i--) {
          const p = w.particles[i];
          p.life -= dt;
          p.vy -= 6 * dt;
          p.x += p.vx * dt;
          p.y = Math.max(0.02, p.y + p.vy * dt);
          p.z += p.vz * dt;
          if (p.life <= 0) w.particles.splice(i, 1);
        }

        if (w.balls.length === 0) {
          w.lives -= 1;
          sfx.lose();
          w.shakeAt = t;
          if (w.lives <= 0) {
            statusRef.current = 'over';
            setStatus('over');
          } else {
            w.message = `剩余 ${w.lives} 命`;
            w.messageAt = t;
            resetServe(w);
          }
        } else if (w.cleared >= w.total) {
          nextLevel(w, t);
        }

        syncHud();
      } else if (statusRef.current === 'over') {
        for (let i = w.particles.length - 1; i >= 0; i--) {
          const p = w.particles[i];
          p.life -= dt;
          p.vy -= 6 * dt;
          p.x += p.vx * dt;
          p.y = Math.max(0.02, p.y + p.vy * dt);
          p.z += p.vz * dt;
          if (p.life <= 0) w.particles.splice(i, 1);
        }
      }

      // ---- 渲染 ----
      const shakeK = Math.max(0, 1 - (t - w.shakeAt) * 3);
      const flashK = Math.max(0, 1 - (t - w.flashAt) * 1.8);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.save();
      if (shakeK > 0) {
        ctx.translate((Math.random() - 0.5) * 7 * shakeK, (Math.random() - 0.5) * 5 * shakeK);
      }

      const sky = ctx.createLinearGradient(0, 0, 0, RH);
      sky.addColorStop(0, '#0b1024');
      sky.addColorStop(0.45, '#151a38');
      sky.addColorStop(1, '#1c1430');
      ctx.fillStyle = sky;
      ctx.fillRect(-10, -10, RW + 20, RH + 20);

      ctx.fillStyle = 'rgba(200,220,255,0.55)';
      for (let i = 0; i < 40; i++) {
        const sx = (i * 97) % RW;
        const sy = (i * 53) % Math.floor(RH * 0.4);
        ctx.globalAlpha = 0.2 + 0.4 * Math.abs(Math.sin(t * 1.4 + i));
        ctx.fillRect(sx, sy, 1.2, 1.2);
      }
      ctx.globalAlpha = 1;

      // 地面网格
      ctx.strokeStyle = 'rgba(80,120,255,0.12)';
      ctx.lineWidth = 1;
      for (let gx = -HW; gx <= HW + 0.01; gx += 1.05) {
        const a = projAt(gx, 0, NEAR);
        const b = projAt(gx, 0, FAR);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      for (let gz = NEAR; gz <= FAR + 0.01; gz += 1.05) {
        const a = projAt(-HW, 0, gz);
        const b = projAt(HW, 0, gz);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // 侧墙 / 远端墙
      drawBox(-HW - SIDE, -HW, 0, 0.22, NEAR, FAR, 220, 40, 38);
      drawBox(HW, HW + SIDE, 0, 0.22, NEAR, FAR, 220, 40, 38);
      drawBox(-HW - SIDE, HW + SIDE, 0, 0.35, FAR, FAR + 0.18, 265, 50, 42);

      // 砖块：远 → 近
      const alive = w.bricks
        .filter((b) => b.alive)
        .slice()
        .sort((a, b) => b.z - a.z);
      for (const b of alive) {
        const dmg = b.maxHp > 1 ? (b.hp - 1) / b.maxHp : 0;
        const lig = 48 + b.hp * 6 - dmg * 8;
        drawBox(
          b.x - BRICK_W / 2,
          b.x + BRICK_W / 2,
          0.02,
          BRICK_H,
          b.z - BRICK_D / 2,
          b.z + BRICK_D / 2,
          b.hue,
          78,
          lig,
          b.hp >= 2,
        );
      }

      // 挡板（俯视下需要足够高度才可见）
      drawBox(
        w.paddleX - w.paddleW - PAD_T,
        w.paddleX + w.paddleW + PAD_T,
        0.04,
        PAD_H,
        PAD_Z - PAD_T,
        PAD_Z + PAD_T,
        190,
        90,
        62,
        true,
      );

      // 强化
      for (const p of w.powerups) {
        const hue = p.kind === 'wide' ? 140 : p.kind === 'slow' ? 200 : 48;
        const bob = Math.sin(t * 6 + p.x) * 0.04;
        drawBox(p.x - 0.18, p.x + 0.18, 0.25 + bob, 0.55 + bob, p.z - 0.18, p.z + 0.18, hue, 90, 58, true);
      }

      // 球
      for (const b of w.balls) {
        const sp = projAt(b.x, b.y, b.z);
        const r = Math.max(2.2, BALL_R * sp.s * 1.15);
        const g = ctx.createRadialGradient(sp.x - r * 0.3, sp.y - r * 0.3, r * 0.15, sp.x, sp.y, r);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.45, '#ffe9a8');
        g.addColorStop(1, '#ff9a3c');
        ctx.shadowColor = 'rgba(255,180,80,0.9)';
        ctx.shadowBlur = 14;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // 粒子
      for (const p of w.particles) {
        const sp = projAt(p.x, p.y, p.z);
        ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
        ctx.fillStyle = `hsl(${p.hue} 90% 62%)`;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, Math.max(1, 1.8 * sp.s * 0.03), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (playing && w.phase === 'serve') {
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillText('空格 / 点击 发球', CX, RH - 48);
      }

      const mk = Math.max(0, 1 - (t - w.messageAt) * 1.3);
      if (mk > 0 && w.message) {
        ctx.font = '700 18px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = `rgba(8,12,28,${(0.7 * mk).toFixed(3)})`;
        ctx.strokeText(w.message, CX, 42);
        ctx.fillStyle = `rgba(255,255,255,${mk.toFixed(3)})`;
        ctx.fillText(w.message, CX, 42);
      }

      if (statusRef.current !== 'ready') {
        ctx.textAlign = 'left';
        ctx.font = '700 14px system-ui, sans-serif';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(8,12,28,0.6)';
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.strokeText(`💥 ${w.score}`, 12, 22);
        ctx.fillText(`💥 ${w.score}`, 12, 22);
        const livesTxt = `❤ ${'●'.repeat(Math.max(0, w.lives))}${'○'.repeat(Math.max(0, LIVES - w.lives))}`;
        ctx.strokeText(livesTxt, 12, 40);
        ctx.fillText(livesTxt, 12, 40);
        const lvlTxt = `关卡 ${w.level + 1}${w.endless ? `+${w.endless}` : ''}`;
        ctx.strokeText(lvlTxt, 12, 58);
        ctx.fillText(lvlTxt, 12, 58);
        if (w.combo > 1) {
          ctx.fillStyle = '#ffcf5c';
          const c = `🔥 ×${w.combo}`;
          ctx.strokeText(c, 12, 76);
          ctx.fillText(c, 12, 76);
        }
        let ty = 22;
        ctx.textAlign = 'right';
        if (w.wideT > 0) {
          ctx.fillStyle = '#6ee7b7';
          const s1 = `加宽 ${w.wideT.toFixed(1)}s`;
          ctx.strokeText(s1, RW - 12, ty);
          ctx.fillText(s1, RW - 12, ty);
          ty += 18;
        }
        if (w.slowT > 0) {
          ctx.fillStyle = '#7dd3fc';
          const s2 = `减速 ${w.slowT.toFixed(1)}s`;
          ctx.strokeText(s2, RW - 12, ty);
          ctx.fillText(s2, RW - 12, ty);
        }
      }

      if (flashK > 0) {
        ctx.fillStyle = `rgba(255,255,255,${(0.35 * flashK).toFixed(3)})`;
        ctx.fillRect(-10, -10, RW + 20, RH + 20);
      }

      ctx.restore();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (statusRef.current !== 'playing') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width;
    pointerRef.current = (u - 0.5) * 2 * (HW + 0.4);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      onPointerMove(e);
      if (statusRef.current === 'playing' && worldRef.current.phase === 'serve') serve();
    },
    [onPointerMove, serve],
  );

  const onPointerUp = useCallback(() => {
    pointerRef.current = null;
  }, []);

  return (
    <GameShell
      meta={metaBreak3D}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>得分</span>
            <strong>{score}</strong>
          </div>
          <div className="stat-box">
            <span>关卡</span>
            <strong>{level}</strong>
          </div>
          <div className="stat-box">
            <span>生命</span>
            <strong className="brk-lives">
              {'●'.repeat(Math.max(0, lives))}
              {'○'.repeat(Math.max(0, LIVES - lives))}
            </strong>
          </div>
          <div className="stat-box">
            <span>连击</span>
            <strong>{combo > 1 ? `×${combo}` : '—'}</strong>
          </div>
          <div className="stat-box">
            <span>{metaBreak3D.bestScoreLabel}</span>
            <strong>{best.value != null ? best.value : '—'}</strong>
          </div>
        </>
      }
    >
      <div className="brk">
        <div className="brk-stage">
          <canvas
            ref={canvasRef}
            className="brk-canvas"
            role="img"
            aria-label="3D 打砖块游戏画面"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {status === 'ready' && (
            <div className="brk-overlay">
              <h2>🧱 3D 打砖块</h2>
              <p>
                霓虹球台上击碎远端砖墙：挡板接球改变出射角，
                <br />
                连击加分，击碎砖块有机会掉落强化（加宽 / 减速 / 三重球）。
                <br />
                清空本关砖块进入下一关，共 6 关后进入无尽挑战！
              </p>
              <p className="brk-keys">拖拽 / ←→ 移动挡板 · 空格或点击发球 · P 暂停</p>
              <button className="btn btn-primary" onClick={start}>
                开始游戏
              </button>
            </div>
          )}
          {status === 'paused' && (
            <div className="brk-overlay">
              <h2>⏸ 已暂停</h2>
              <button className="btn btn-primary" onClick={togglePause}>
                继续
              </button>
            </div>
          )}
          {(status === 'over' || status === 'win') && (
            <div className="brk-overlay" onClick={start}>
              <h2>{status === 'win' ? '🏆 通关！' : '💥 游戏结束'}</h2>
              <p>
                得分 {score} · 到达关卡 {level}
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
        <div className="brk-actions">
          <button className="btn btn-ghost" onClick={togglePause} disabled={status !== 'playing' && status !== 'paused'}>
            {status === 'paused' ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button className="btn btn-ghost" onClick={start}>
            🔄 重新开始
          </button>
        </div>
        <p className="hint">挡板击球位置决定出射角 · 连续破砖连击翻倍 · 掉落方块接住触发强化</p>
      </div>
    </GameShell>
  );
}
