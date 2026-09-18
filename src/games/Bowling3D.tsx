import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaBowling3D } from '../core/gameMetas';

// ============ 常量 ============

/** 内部渲染分辨率（4:3） */
const RW = 480;
const RH = 360;
const CX = RW / 2;
const CY = RH * 0.58;
const FOCAL = 460;
/** 相机俯角（固定，机位沿球道跟随） */
const PITCH = 0.3;
const COSP = Math.cos(PITCH);
const SINP = Math.sin(PITCH);
/** 相机高度 */
const CAM_Y = 1.5;
/** 站位机位 z / 跟随上限 / 跟随距离 */
const CAM_Z0 = -1.8;
const CAM_ZMAX = 8.2;
const CAM_LAG = 2.4;
/** 机位回位速度 */
const CAM_EASE = 5.5;

/** 球道半宽 / 犯规线到 1 号瓶距离 / 边沟宽 */
const LANE_HW = 0.95;
const LANE_LEN = 13;
const GUTTER_W = 0.3;
/** 球与瓶尺寸（世界单位；瓶腹半径按真实比例 ≈ 0.102） */
const BALL_R = 0.175;
const PIN_R = 0.102;
/** 瓶瓶碰撞半径：倒下瓶身会横扫，接触半径大于瓶腹 */
const PIN_R_PIN = 0.15;
const PIN_H = 0.62;
const PIN_SP = 0.52;
const ROW_DZ = PIN_SP * 0.866;
/** 站位（出手点）与左右范围 */
const STANCE_Z = 0.6;
const STANCE_XMAX = 0.6;
/** 球瓶区后端（落坑线）与背墙 */
const PIT_Z = LANE_LEN + 3 * ROW_DZ + 0.55;
const WALL_Z = PIT_Z + 1.1;

/** 质量与恢复系数 */
const BALL_M = 6.8;
const PIN_M = 1.55;
const E_BALL_PIN = 0.35;
const E_PIN_PIN = 0.48;
/** 倒瓶判定速度 / 倒瓶最小滑行速度（真实瓶是"倒"而非"滑"，轻擦也会整瓶扫倒邻瓶） / 倒瓶滑行速度上限 */
const KNOCK_V = 0.2;
const PIN_TOPPLE = 1.4;
const PIN_SLIDE_MAX = 3.2;
/** 倒下瓶可撞他瓶的时长 / 瓶惯性滑行方向随机散射 / 倒定耗时 / 摆瓶位置随机量 */
const PIN_PUSH_T = 0.26;
const PIN_SCATTER = 0.14;
const PIN_FALL_T = 0.34;
const PIN_DOWN_T = 0.55;
const RACK_JITTER = 0.025;
/** 出手速度范围与球体摩擦 */
const V_MIN = 6.6;
const V_MAX = 11.8;
const BALL_DAMP = 0.16;
/** 侧旋最大横向加速度（球道后段生效） */
const HOOK_A = 1.35;
/** 球落坑判定（z 超过 PIT_Z 即入坑） */
const MAX_ROLL_T = 9;
/** 瞄准角上限（球道半宽仅 0.95，超过约 5° 必然出界，限在球道内更易把控） / 键盘微调步长 */
const AIM_MAX = 0.085;
const AIM_STEP = 0.008;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const easeOut = (v: number) => 1 - (1 - v) * (1 - v);

/** 十瓶标准位置：1 号瓶在犯规线后 LANE_LEN，行距 ROW_DZ、行内间距 PIN_SP */
const PIN_SPOTS: Array<[number, number]> = (() => {
  const out: Array<[number, number]> = [];
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i <= r; i++) out.push([(i - r / 2) * PIN_SP, LANE_LEN + r * ROW_DZ]);
  }
  return out;
})();

/** 球瓶轮廓（局部坐标：底在原点，y 向上为负，x 最大宽度 ±0.5） */
const PIN_PATH = (() => {
  const p = new Path2D();
  p.moveTo(-0.21, 0);
  p.bezierCurveTo(-0.45, -0.02, -0.5, -0.2, -0.5, -0.34);
  p.bezierCurveTo(-0.5, -0.5, -0.3, -0.56, -0.19, -0.66);
  p.bezierCurveTo(-0.13, -0.72, -0.2, -0.78, -0.26, -0.84);
  p.bezierCurveTo(-0.32, -0.9, -0.28, -1, 0, -1);
  p.bezierCurveTo(0.28, -1, 0.32, -0.9, 0.26, -0.84);
  p.bezierCurveTo(0.2, -0.78, 0.13, -0.72, 0.19, -0.66);
  p.bezierCurveTo(0.3, -0.56, 0.5, -0.5, 0.5, -0.34);
  p.bezierCurveTo(0.5, -0.2, 0.45, -0.02, 0.21, 0);
  p.closePath();
  return p;
})();

// ============ 相机 ============

/** 相机 z（模块级：渲染循环内更新，project/unproject 读取） */
const cam = { z: CAM_Z0 };

/** 世界 → 屏幕（相机在 (0, CAM_Y, cam.z)，固定俯角、无偏航） */
function project(x: number, y: number, z: number) {
  const dy = y - CAM_Y;
  const dz = z - cam.z;
  const vy = dy * COSP + dz * SINP;
  const vz = Math.max(0.32, -dy * SINP + dz * COSP);
  const s = FOCAL / vz;
  return { x: CX + x * s, y: CY - vy * s, s };
}

/** 屏幕 → 球道地面（y=0） */
function unproject(sx: number, sy: number): [number, number] {
  const k = CY - sy;
  const den = k * COSP - FOCAL * SINP;
  const dz = den === 0 ? 40 : -CAM_Y * (FOCAL * COSP + k * SINP) / den;
  const d = clamp(dz, -10, 60);
  const vz = Math.max(0.32, CAM_Y * SINP + d * COSP);
  return [((sx - CX) * vz) / FOCAL, d + cam.z];
}

// ============ 类型 ============

type PinState = 'up' | 'falling' | 'down';

interface Pin {
  id: number;
  /** 标准摆放位 */
  stdX: number;
  stdZ: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** 是否在球道上（被清扫后为 false） */
  present: boolean;
  state: PinState;
  /** 倾倒角 0→π/2 */
  fallA: number;
  fallT: number;
  /** 倾倒方向（世界 xz 角） */
  fallDir: number;
  /** 0→1 摆放动画 */
  spawn: number;
  /** >0 正在被清扫淡出 */
  fade: number;
}

interface Ball {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  /** 累计滚动距离（驱动指孔旋转） */
  travel: number;
  live: boolean;
  /** 已掉入边沟 */
  gutter: boolean;
  /** 已进入落瓶坑 */
  pit: boolean;
  trail: Array<[number, number]>;
}

interface FrameRec {
  rolls: number[];
  marks: string[];
}

type Phase = 'aim' | 'roll' | 'wait';

interface World {
  pins: Pin[];
  ball: Ball;
  stanceX: number;
  aim: number;
  power: number;
  spin: number;
  drag: 'none' | 'stance' | 'aim';
  dragMoved: boolean;
  dragX0: number;
  dragDragStance: number;
  phase: Phase;
  frames: FrameRec[];
  frameIdx: number;
  /** 本球出手前站立瓶数 */
  standingBefore: number;
  /** 上一球是否清空球瓶（决定下一球摆放） */
  lastCleared: boolean;
  /** 当前这一球面对的是否为整组新瓶（区分全中与"洗沟后补中"） */
  rackFresh: boolean;
  waitT: number;
  settleT: number;
  rollT: number;
  trailT: number;
  msg: string;
  msgAt: number;
  msgBig: boolean;
  flashAt: number;
}

function makePins(): Pin[] {
  return PIN_SPOTS.map(([x, z], id) => ({
    id,
    stdX: x,
    stdZ: z,
    x,
    z,
    vx: 0,
    vz: 0,
    present: true,
    state: 'up' as PinState,
    fallA: 0,
    fallT: 0,
    fallDir: 0,
    spawn: 1,
    fade: 0,
  }));
}

function newWorld(): World {
  return {
    pins: makePins(),
    ball: { x: 0, y: BALL_R, z: STANCE_Z, vx: 0, vz: 0, travel: 0, live: false, gutter: false, pit: false, trail: [] },
    stanceX: 0,
    aim: 0,
    power: 0.62,
    spin: 0,
    drag: 'none',
    dragMoved: false,
    dragX0: 0,
    dragDragStance: 0,
    phase: 'aim',
    frames: Array.from({ length: 10 }, () => ({ rolls: [], marks: [] })),
    frameIdx: 0,
    standingBefore: 10,
    lastCleared: false,
    rackFresh: true,
    waitT: 0,
    settleT: 0,
    rollT: 0,
    trailT: 0,
    msg: '',
    msgAt: -9,
    msgBig: false,
    flashAt: -9,
  };
}

// ============ 物理 ============

function pinSpeed(p: Pin): number {
  return Math.hypot(p.vx, p.vz);
}

/** 击倒该瓶：进入倾倒动画，滑行速度取不小于倒瓶冲量的值并加随机散射 */
function knockPin(p: Pin, vx: number, vz: number) {
  p.state = 'falling';
  p.fallT = 0;
  p.fallA = 0;
  const ang = Math.atan2(vz, vx) + (Math.random() - 0.5) * 0.5;
  p.fallDir = ang;
  const rot = ang + (Math.random() - 0.5) * 2 * PIN_SCATTER;
  const sp = Math.max(Math.hypot(vx, vz), PIN_TOPPLE);
  const k = sp > PIN_SLIDE_MAX ? PIN_SLIDE_MAX / sp : 1;
  p.vx = Math.cos(rot) * sp * k;
  p.vz = Math.sin(rot) * sp * k;
}

interface Body {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

/** 圆-圆碰撞：位置修正 + 法向冲量（质量加权），返回是否接触 */
function collide(a: Body, ma: number, b: Body, mb: number, ra: number, rb: number, e: number): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const d = Math.hypot(dx, dz);
  const min = ra + rb;
  if (d >= min || d < 1e-6) return false;
  const nx = dx / d;
  const nz = dz / d;
  const push = min - d;
  const wa = mb / (ma + mb);
  const wb = ma / (ma + mb);
  a.x -= nx * push * wa;
  a.z -= nz * push * wa;
  b.x += nx * push * wb;
  b.z += nz * push * wb;
  const rel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
  if (rel <= 0) return true;
  const j = ((1 + e) * rel) / (1 / ma + 1 / mb);
  a.vx -= (j / ma) * nx;
  a.vz -= (j / ma) * nz;
  b.vx += (j / mb) * nx;
  b.vz += (j / mb) * nz;
  return true;
}

function substep(w: World, h: number) {
  const b = w.ball;
  const rolling = w.phase === 'roll' && b.live && !b.gutter && !b.pit;

  if (rolling) {
    // 侧旋：球道后段（约 3→11）逐渐发力，形成先直后弯的弧线
    const ramp = clamp((b.z - 3) / 8, 0.08, 1);
    b.vx += w.spin * HOOK_A * ramp * h;
    b.x += b.vx * h;
    b.z += b.vz * h;
    const damp = Math.exp(-BALL_DAMP * h);
    b.vx *= damp;
    b.vz *= damp;
    // 进入瓶台后横向迅速收敛，避免撞瓶偏转把球带进边沟
    if (b.z > LANE_LEN - 0.4) b.vx *= Math.exp(-6 * h);
    b.travel += Math.hypot(b.vx, b.vz) * h;
    if (Math.abs(b.x) > LANE_HW - BALL_R * 0.35) {
      b.gutter = true;
      b.x = Math.sign(b.x) * (LANE_HW + GUTTER_W * 0.45);
      b.vx = 0;
    }
  } else if (b.gutter && !b.pit) {
    // 边沟光滑，基本不减速，保证滚到落瓶坑
    b.z += b.vz * h;
    b.vz *= Math.exp(-0.05 * h);
    b.y = Math.max(-BALL_R * 0.5, b.y - h * 1.6);
  }
  if (!b.pit && b.z > PIT_Z) {
    b.pit = true;
    b.vx = 0;
  }
  if (b.pit && b.y > -0.7) b.y -= h * 3.2;

  // 球瓶：摆放 / 淡出 / 倾倒
  for (const p of w.pins) {
    if (!p.present) {
      if (p.fade > 0 && p.fade < 1) p.fade = Math.min(1, p.fade + h / 0.32);
      continue;
    }
    if (p.spawn < 1) p.spawn = Math.min(1, p.spawn + h / 0.26);
    if (p.state === 'falling') {
      p.fallT += h;
      p.fallA = easeOut(Math.min(1, p.fallT / PIN_FALL_T)) * (Math.PI / 2);
      if (p.fallT < PIN_PUSH_T) {
        p.x += p.vx * h;
        p.z += p.vz * h;
        const damp = Math.exp(-5 * h);
        p.vx *= damp;
        p.vz *= damp;
        // 撞侧板/后墙回弹：真实球馆的 kickback，是清角瓶的关键
        if (p.x > LANE_HW - 0.06) {
          p.x = LANE_HW - 0.06;
          p.vx = -Math.abs(p.vx) * 0.55;
        } else if (p.x < -LANE_HW + 0.06) {
          p.x = -LANE_HW + 0.06;
          p.vx = Math.abs(p.vx) * 0.55;
        }
        if (p.z > PIT_Z - 0.25) {
          p.z = PIT_Z - 0.25;
          p.vz = -Math.abs(p.vz) * 0.4;
        }
      } else {
        p.vx = 0;
        p.vz = 0;
      }
      if (p.fallT > PIN_DOWN_T) p.state = 'down';
    }
  }

  // 球撞瓶
  if (rolling) {
    for (const p of w.pins) {
      if (!p.present || p.state === 'down') continue;
      if (collide(b, BALL_M, p, PIN_M, BALL_R, PIN_R, E_BALL_PIN) && p.state === 'up') {
        if (pinSpeed(p) > KNOCK_V) knockPin(p, p.vx, p.vz);
        else {
          p.vx = 0;
          p.vz = 0;
        }
      }
    }
  }

  // 瓶撞瓶（倾倒中的瓶在 PIN_PUSH_T 内仍可撞倒它瓶，形成连锁）
  const live = w.pins.filter((p) => p.present && p.state !== 'down' && !(p.state === 'falling' && p.fallT >= PIN_PUSH_T));
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const c = live[j];
      if (collide(a, PIN_M, c, PIN_M, PIN_R_PIN, PIN_R_PIN, E_PIN_PIN)) {
        if (a.state === 'up' && pinSpeed(a) > KNOCK_V) knockPin(a, a.vx, a.vz);
        if (c.state === 'up' && pinSpeed(c) > KNOCK_V) knockPin(c, c.vx, c.vz);
      }
    }
  }
}

function stepPhysics(w: World, dt: number) {
  const b = w.ball;
  let fastest = Math.hypot(b.vx, b.vz);
  for (const p of w.pins) fastest = Math.max(fastest, pinSpeed(p));
  const n = clamp(Math.ceil((fastest * dt) / 0.05), 1, 24);
  const h = dt / n;
  for (let i = 0; i < n; i++) substep(w, h);

  // 轨迹采样（每 30ms 一点，最多 46 点）
  if (w.phase === 'roll' && b.live && !b.pit) {
    w.trailT += dt;
    if (w.trailT > 0.03) {
      w.trailT = 0;
      b.trail.push([b.x, b.z]);
      if (b.trail.length > 46) b.trail.shift();
    }
  }
}

function throwBall(w: World) {
  const b = w.ball;
  b.x = w.stanceX;
  b.z = STANCE_Z;
  b.y = BALL_R;
  const sp = V_MIN + w.power * (V_MAX - V_MIN);
  b.vx = Math.sin(w.aim) * sp;
  b.vz = Math.cos(w.aim) * sp;
  b.live = true;
  b.gutter = false;
  b.pit = false;
  b.travel = 0;
  b.trail = [[b.x, b.z]];
  w.phase = 'roll';
  w.rollT = 0;
  w.settleT = 0;
  w.trailT = 0;
  w.standingBefore = w.pins.filter((p) => p.present && p.state === 'up').length;
  w.msg = '';
  w.msgBig = false;
  w.flashAt = -9;
}

/** 摆放球瓶：full=整组重摆（全中/补中后），否则保留站立瓶、清扫倒瓶 */
function rackPins(w: World, full: boolean) {
  for (const p of w.pins) {
    const standing = p.present && p.state === 'up';
    if (full || standing) {
      const isNew = full || !standing;
      p.present = true;
      p.state = 'up';
      p.fallA = 0;
      p.fallT = 0;
      p.vx = 0;
      p.vz = 0;
      p.x = p.stdX + (Math.random() - 0.5) * 2 * RACK_JITTER;
      p.z = p.stdZ + (Math.random() - 0.5) * 2 * RACK_JITTER;
      p.fade = 0;
      if (isNew) p.spawn = 0;
      else p.spawn = 1;
    } else if (p.present || p.fade > 0) {
      p.present = false;
      if (p.fade <= 0) p.fade = 0.001;
    }
  }
  const b = w.ball;
  b.x = w.stanceX;
  b.z = STANCE_Z;
  b.y = BALL_R;
  b.vx = 0;
  b.vz = 0;
  b.live = false;
  b.gutter = false;
  b.pit = false;
  b.trail = [];
  w.rackFresh = full;
  w.standingBefore = w.pins.filter((p) => p.present && p.state === 'up').length;
}

/** 一球结束后推进局数/球数；返回 'over' 表示十局打完 */
function advanceRoll(w: World): 'ok' | 'over' {
  const fr = w.frames[w.frameIdx];
  const cleared = w.lastCleared;
  if (w.frameIdx < 9) {
    const done = fr.rolls[0] === 10 || fr.rolls.length >= 2;
    rackPins(w, done);
    if (done) w.frameIdx += 1;
  } else {
    const r = fr.rolls;
    if (r.length === 1) {
      rackPins(w, cleared);
    } else if (r.length === 2) {
      const bonus = r[0] === 10 || r[0] + r[1] === 10;
      if (!bonus) return 'over';
      rackPins(w, cleared);
    } else {
      return 'over';
    }
  }
  w.phase = 'aim';
  return 'ok';
}

/** 按当前瞄准/力度/旋转预测球路（与物理同参数，含侧旋弧线） */
function predictPath(w: World): Array<[number, number]> {
  const b = w.ball;
  let x = b.x;
  let z = b.z;
  const sp = V_MIN + w.power * (V_MAX - V_MIN);
  let vx = Math.sin(w.aim) * sp;
  let vz = Math.cos(w.aim) * sp;
  const pts: Array<[number, number]> = [[x, z]];
  const h = 0.03;
  for (let i = 0; i < 320; i++) {
    const ramp = clamp((z - 3) / 8, 0.08, 1);
    vx += w.spin * HOOK_A * ramp * h;
    x += vx * h;
    z += vz * h;
    const damp = Math.exp(-BALL_DAMP * h);
    vx *= damp;
    vz *= damp;
    if (Math.abs(x) > LANE_HW) {
      pts.push([Math.sign(x) * LANE_HW, z]);
      break;
    }
    if (z > PIT_Z - 0.3) break;
    if (i % 5 === 0) pts.push([x, z]);
  }
  return pts;
}

// ============ 计分 ============

/** 按标准十瓶规则算各局累计分（未定局为 null） */
function frameTotals(frames: FrameRec[]): Array<number | null> {
  const flat: number[] = [];
  const starts: number[] = [];
  for (let f = 0; f < 10; f++) {
    starts.push(flat.length);
    for (const v of frames[f]?.rolls ?? []) flat.push(v);
  }
  const totals: Array<number | null> = new Array(10).fill(null);
  let cum = 0;
  for (let f = 0; f < 10; f++) {
    const r = frames[f]?.rolls ?? [];
    if (r.length === 0) break;
    if (f === 9) {
      const complete = r.length === 3 || (r.length === 2 && r[0] !== 10 && r[0] + r[1] < 10);
      if (!complete) break;
      cum += r[0] + r[1] + (r[2] ?? 0);
      totals[9] = cum;
      break;
    }
    const i = starts[f];
    if (r[0] === 10) {
      const n1 = flat[i + 1];
      const n2 = flat[i + 2];
      if (n1 === undefined || n2 === undefined) break;
      cum += 10 + n1 + n2;
    } else if (r.length < 2) {
      break;
    } else if (r[0] + r[1] === 10) {
      const n1 = flat[i + 2];
      if (n1 === undefined) break;
      cum += 10 + n1;
    } else {
      cum += r[0] + r[1];
    }
    totals[f] = cum;
  }
  return totals;
}

// ============ 渲染 ============

/** 球瓶渐变（局部坐标，跨瓶复用） */
let pinGrad: CanvasGradient | null = null;

function quad(ctx: CanvasRenderingContext2D, pts: Array<[number, number, number]>, fill: string) {
  ctx.beginPath();
  pts.forEach(([x, y, z], i) => {
    const p = project(x, y, z);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function groundLine(ctx: CanvasRenderingContext2D, x0: number, z0: number, x1: number, z1: number, y: number) {
  const a = project(x0, y, z0);
  const b = project(x1, y, z1);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawPin(ctx: CanvasRenderingContext2D, p: Pin) {
  const base = project(p.x, 0, p.z);
  const s = base.s;
  const fallA = p.state === 'up' ? 0 : p.fallA;
  const dirX = Math.cos(p.fallDir);
  const dirZ = Math.sin(p.fallDir);
  const tip = project(p.x + Math.sin(fallA) * dirX * PIN_H, Math.cos(fallA) * PIN_H, p.z + Math.sin(fallA) * dirZ * PIN_H);

  if (p.spawn < 1 || p.fade > 0) {
    const a = (p.fade > 0 ? Math.max(0, 1 - p.fade) : 1) * p.spawn;
    ctx.globalAlpha = clamp(a, 0, 1);
  }
  // 地面阴影
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(base.x, base.y, 0.24 * s, 0.11 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  const dx = tip.x - base.x;
  const dy = tip.y - base.y;
  const len = Math.hypot(dx, dy);
  if (len > 0.4) {
    ctx.save();
    ctx.translate(base.x, base.y);
    ctx.rotate(Math.atan2(dy, dx) + Math.PI / 2);
    ctx.scale(PIN_R * 2 * s, len);
    if (!pinGrad) {
      pinGrad = ctx.createLinearGradient(-0.5, 0, 0.5, 0);
      pinGrad.addColorStop(0, '#a9b1c9');
      pinGrad.addColorStop(0.32, '#ffffff');
      pinGrad.addColorStop(0.75, '#e6e9f4');
      pinGrad.addColorStop(1, '#9aa3bf');
    }
    ctx.fillStyle = pinGrad;
    ctx.fill(PIN_PATH);
    ctx.save();
    ctx.clip(PIN_PATH);
    ctx.fillStyle = '#e5484d';
    ctx.fillRect(-0.6, -0.73, 1.2, 0.085);
    ctx.fillRect(-0.6, -0.61, 1.2, 0.085);
    ctx.restore();
    ctx.lineWidth = 1 / (0.45 * s + 0.001);
    ctx.strokeStyle = 'rgba(30,38,66,0.45)';
    ctx.stroke(PIN_PATH);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawBall(ctx: CanvasRenderingContext2D, b: Ball) {
  const p = project(b.x, b.y, b.z);
  const r = BALL_R * p.s;
  if (r < 0.6) return;
  // 与地面的高度越小影子越深越大
  const shadowA = clamp(1 - (b.y - BALL_R) * 1.6, 0.15, 1);
  const gp = project(b.x, 0, b.z);
  ctx.fillStyle = `rgba(0,0,0,${(0.34 * shadowA).toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(gp.x, gp.y, r * (0.95 + (b.y - BALL_R) * 0.5), r * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();

  const g = ctx.createRadialGradient(p.x - r * 0.36, p.y - r * 0.42, r * 0.08, p.x, p.y, r * 1.12);
  g.addColorStop(0, '#8f9bff');
  g.addColorStop(0.35, '#4c58d8');
  g.addColorStop(0.78, '#242a72');
  g.addColorStop(1, '#141838');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();

  // 指孔随滚动旋转（只画朝向镜头一侧的）
  const phase = b.travel / BALL_R;
  for (let i = 0; i < 3; i++) {
    const a = phase + i * 2.094;
    const hx = Math.sin(a);
    const hy = Math.cos(a);
    if (hy < -0.15) continue;
    const rr = Math.max(0.9, r * 0.12);
    ctx.fillStyle = 'rgba(8,10,26,0.8)';
    ctx.beginPath();
    ctx.arc(p.x + hx * r * 0.46, p.y + hy * r * 0.46, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  // 高光
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.ellipse(p.x - r * 0.36, p.y - r * 0.4, r * 0.2, r * 0.12, -0.6, 0, Math.PI * 2);
  ctx.fill();
}

/** 球道上的一排目标箭头（V 字） */
const ARROWS: Array<[number, number]> = [
  [-0.62, 4.6],
  [-0.31, 5.05],
  [0, 5.5],
  [0.31, 5.05],
  [0.62, 4.6],
];

function drawMarkings(ctx: CanvasRenderingContext2D) {
  // 木板缝
  ctx.strokeStyle = 'rgba(74,44,16,0.35)';
  ctx.lineWidth = 1;
  for (let i = -6; i <= 6; i++) {
    const x = (i / 6) * LANE_HW;
    groundLine(ctx, x, -0.6, x, PIT_Z, 0.005);
  }
  // 犯规线
  ctx.strokeStyle = 'rgba(248,113,113,0.85)';
  ctx.lineWidth = 2;
  groundLine(ctx, -LANE_HW, 0, LANE_HW, 0, 0.01);
  // 助走区圆点
  ctx.fillStyle = 'rgba(60,36,14,0.55)';
  for (const x of [-0.66, -0.33, 0, 0.33, 0.66]) {
    const p = project(x, 0.01, -0.35);
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(1, 0.045 * p.s), 0, Math.PI * 2);
    ctx.fill();
  }
  // 箭头
  for (const [ax, az] of ARROWS) {
    const a = project(ax, 0.01, az + 0.16);
    const l = project(ax - 0.07, 0.01, az - 0.16);
    const r = project(ax + 0.07, 0.01, az - 0.16);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(l.x, l.y);
    ctx.lineTo(r.x, r.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(58,34,12,0.5)';
    ctx.fill();
  }
  // 摆瓶点
  ctx.fillStyle = 'rgba(58,34,12,0.4)';
  for (const [x, z] of PIN_SPOTS) {
    const p = project(x, 0.01, z);
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0.8, 0.05 * p.s), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawAim(ctx: CanvasRenderingContext2D, w: World, t: number) {
  const pts = predictPath(w);
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = 'rgba(180,220,255,0.75)';
  ctx.beginPath();
  pts.forEach(([x, z], i) => {
    const p = project(x, 0.02, z);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
  const last = pts[pts.length - 1];
  const lp = project(last[0], 0.02, last[1]);
  ctx.strokeStyle = 'rgba(180,220,255,0.9)';
  ctx.beginPath();
  ctx.arc(lp.x, lp.y, 4 + Math.sin(t * 6) * 1.2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  // 侧旋指示弧
  if (Math.abs(w.spin) > 0.05) {
    const b = w.ball;
    const p = project(b.x, BALL_R, b.z);
    const r = BALL_R * p.s * 2.1;
    ctx.save();
    ctx.strokeStyle = w.spin > 0 ? 'rgba(255,170,120,0.9)' : 'rgba(120,220,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, -Math.PI * 0.5 - w.spin * 0.5, Math.PI * 0.5 - w.spin * 0.5);
    ctx.stroke();
    ctx.restore();
  }
}

/** 右上角十瓶状态小图（正面朝下，与真实监视器一致） */
function drawPinWidget(ctx: CanvasRenderingContext2D, w: World) {
  const bx = RW - 56;
  const by = 16;
  ctx.save();
  ctx.fillStyle = 'rgba(8,12,28,0.55)';
  ctx.beginPath();
  ctx.roundRect(bx - 34, by - 12, 74, 66, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
  for (const p of w.pins) {
    const r = Math.floor(p.id < 1 ? 0 : p.id < 3 ? 1 : p.id < 6 ? 2 : 3);
    const idx = p.id - (r * (r + 1)) / 2;
    const x = bx + (idx - r / 2) * 9;
    const y = by + 40 - r * 8.5;
    const standing = p.present && p.state === 'up';
    ctx.fillStyle = standing ? '#f4f6ff' : 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.moveTo(x, y - 4.4);
    ctx.lineTo(x + 2.9, y + 3);
    ctx.lineTo(x - 2.9, y + 3);
    ctx.closePath();
    ctx.fill();
  }
}

function render(ctx: CanvasRenderingContext2D, w: World, t: number, playing: boolean) {
  ctx.clearRect(0, 0, RW, RH);
  const bg = ctx.createLinearGradient(0, 0, 0, RH);
  bg.addColorStop(0, '#080b1a');
  bg.addColorStop(0.5, '#111735');
  bg.addColorStop(1, '#1a2044');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, RW, RH);

  // 顶灯光晕
  for (const lx of [CX - 130, CX + 130]) {
    const g = ctx.createRadialGradient(lx, -40, 6, lx, -40, 210);
    g.addColorStop(0, 'rgba(190,215,255,0.20)');
    g.addColorStop(0.5, 'rgba(150,180,255,0.06)');
    g.addColorStop(1, 'rgba(150,180,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, RW, RH);
  }

  // 背墙（无偏航机位下投影为屏幕矩形）
  const wb = project(0, 0, WALL_Z);
  const wt = project(0, 3.0, WALL_Z);
  const wl = project(-3.0, 0, WALL_Z).x;
  const wr = project(3.0, 0, WALL_Z).x;
  const wg = ctx.createLinearGradient(0, wt.y, 0, wb.y);
  wg.addColorStop(0, '#0c1226');
  wg.addColorStop(1, '#1b2350');
  ctx.fillStyle = wg;
  ctx.fillRect(wl, wt.y, wr - wl, wb.y - wt.y);
  // 背墙霓虹条与发光面板
  ctx.fillStyle = 'rgba(124,92,255,0.16)';
  ctx.fillRect(wl, wb.y - (wb.y - wt.y) * 0.62, wr - wl, (wb.y - wt.y) * 0.26);
  ctx.strokeStyle = 'rgba(0,212,255,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(wl, wb.y - (wb.y - wt.y) * 0.62);
  ctx.lineTo(wr, wb.y - (wb.y - wt.y) * 0.62);
  ctx.stroke();

  // 落瓶坑（暗区）
  quad(
    ctx,
    [
      [-2.2, 0, PIT_Z],
      [2.2, 0, PIT_Z],
      [2.2, 0, WALL_Z],
      [-2.2, 0, WALL_Z],
    ],
    '#0a0e20',
  );

  // 两侧挡板（内侧面）
  for (const sx of [-1, 1]) {
    const x = sx * (LANE_HW + GUTTER_W);
    quad(
      ctx,
      [
        [x, 0, -0.8],
        [x, 0.95, -0.8],
        [x, 0.95, WALL_Z],
        [x, 0, WALL_Z],
      ],
      sx < 0 ? '#1a2140' : '#171d38',
    );
    const a = project(x, 0.95, -0.8);
    const b = project(x, 0.95, WALL_Z);
    ctx.strokeStyle = 'rgba(124,92,255,0.35)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // 边沟
  for (const sx of [-1, 1]) {
    quad(
      ctx,
      [
        [sx * LANE_HW, -0.06, -0.8],
        [sx * (LANE_HW + GUTTER_W), -0.06, -0.8],
        [sx * (LANE_HW + GUTTER_W), -0.06, PIT_Z],
        [sx * LANE_HW, -0.06, PIT_Z],
      ],
      '#141a33',
    );
  }

  // 球道（含助走区）
  quad(
    ctx,
    [
      [-LANE_HW, 0, PIT_Z],
      [LANE_HW, 0, PIT_Z],
      [LANE_HW, 0, -0.8],
      [-LANE_HW, 0, -0.8],
    ],
    '#c08a4a',
  );
  // 球瓶区略亮 + 助走区略暗
  quad(
    ctx,
    [
      [-LANE_HW, 0.002, PIT_Z - 0.05],
      [LANE_HW, 0.002, PIT_Z - 0.05],
      [LANE_HW, 0.002, LANE_LEN - 0.75],
      [-LANE_HW, 0.002, LANE_LEN - 0.75],
    ],
    'rgba(255,236,200,0.10)',
  );
  quad(
    ctx,
    [
      [-LANE_HW, 0.002, 0],
      [LANE_HW, 0.002, 0],
      [LANE_HW, 0.002, -0.8],
      [-LANE_HW, 0.002, -0.8],
    ],
    'rgba(40,22,6,0.22)',
  );
  drawMarkings(ctx);

  // 球路轨迹
  if (w.ball.trail.length > 1) {
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 1; i < w.ball.trail.length; i++) {
      const [x0, z0] = w.ball.trail[i - 1];
      const [x1, z1] = w.ball.trail[i];
      const a = project(x0, 0.012, z0);
      const b = project(x1, 0.012, z1);
      ctx.strokeStyle = `rgba(255,255,255,${(0.05 + 0.22 * (i / w.ball.trail.length)).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, 0.06 * b.s);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 瞄准线
  if (playing && w.phase === 'aim') drawAim(ctx, w, t);

  // 瓶与球按深度（z 大者先画）
  const items: Array<{ z: number; pin: Pin | null }> = [];
  for (const p of w.pins) {
    if (p.present || p.fade > 0) items.push({ z: p.z, pin: p });
  }
  items.push({ z: w.ball.z, pin: null });
  items.sort((a, b) => b.z - a.z);
  for (const it of items) {
    if (it.pin) drawPin(ctx, it.pin);
    else if (!w.ball.pit || w.ball.y > -0.55) drawBall(ctx, w.ball);
  }

  // 力度条（贴左下角，避免与球重叠）
  if (playing && w.phase === 'aim') {
    const bw = 96;
    const bh = 8;
    const bx = 16;
    const by = RH - 20;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
    const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    g.addColorStop(0, '#34d399');
    g.addColorStop(0.6, '#fbbf24');
    g.addColorStop(1, '#f87171');
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = g;
    ctx.fillRect(bx, by, bw * w.power, bh);
    ctx.font = '600 10.5px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(`力度 ${Math.round(w.power * 100)}%`, bx, by - 6);
  }

  drawPinWidget(ctx, w);

  // 提示语
  const mk = Math.max(0, 1 - (t - w.msgAt) * 0.8);
  if (mk > 0 && w.msg) {
    const fs = w.msgBig ? 30 : 20;
    ctx.save();
    ctx.font = `800 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 5;
    ctx.strokeStyle = `rgba(8,12,26,${(0.7 * mk).toFixed(3)})`;
    ctx.strokeText(w.msg, CX, RH * 0.22);
    ctx.fillStyle = w.msgBig ? `rgba(255,214,102,${mk.toFixed(3)})` : `rgba(255,255,255,${mk.toFixed(3)})`;
    ctx.fillText(w.msg, CX, RH * 0.22);
    ctx.restore();
  }

  // 击球闪白
  const fk = Math.max(0, 1 - (t - w.flashAt) * 2.6);
  if (fk > 0) {
    ctx.fillStyle = `rgba(255,240,200,${(0.22 * fk).toFixed(3)})`;
    ctx.fillRect(0, 0, RW, RH);
  }
}

// ============ 主组件 ============

type Status = 'ready' | 'playing' | 'paused' | 'over';

export default function Bowling3D() {
  const [status, setStatus] = useState<Status>('ready');
  const [frames, setFrames] = useState<FrameRec[]>(() => Array.from({ length: 10 }, () => ({ rolls: [], marks: [] })));
  const [standing, setStanding] = useState(10);
  const [spin, setSpin] = useState(0);
  const [newRecord, setNewRecord] = useState(false);
  const best = useBestScore(metaBowling3D.id);
  const { toast } = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(null as unknown as World);
  // 懒初始化：useRef(newWorld()) 的实参每次渲染都会求值，每球结算的重渲染会白摆一组瓶
  if (!worldRef.current) worldRef.current = newWorld();
  const statusRef = useRef<Status>('ready');
  const overRef = useRef(false);
  statusRef.current = status;

  useEffect(() => {
    worldRef.current.spin = spin;
  }, [spin]);

  const start = useCallback(() => {
    const w = newWorld();
    w.spin = spin;
    worldRef.current = w;
    cam.z = CAM_Z0;
    overRef.current = false;
    setFrames(w.frames.map((f) => ({ rolls: [...f.rolls], marks: [...f.marks] })));
    setStanding(10);
    setNewRecord(false);
    setStatus('playing');
  }, [spin]);

  const togglePause = useCallback(() => {
    const s = statusRef.current;
    if (s === 'playing') setStatus('paused');
    else if (s === 'paused') setStatus('playing');
  }, []);

  /** 出手：按当前站位/角度/力度/旋转投球 */
  const shoot = useCallback(() => {
    const w = worldRef.current;
    if (statusRef.current !== 'playing' || w.phase !== 'aim') return;
    throwBall(w);
    sfx.drop();
  }, []);

  /** 结算一球：记录倒瓶数/标记，进入 wait 阶段 */
  const finishRoll = useCallback(() => {
    const w = worldRef.current;
    if (w.phase !== 'roll') return;
    const before = w.standingBefore;
    const n = w.pins.filter((p) => p.present && p.state !== 'up').length;
    const fr = w.frames[w.frameIdx];
    // 全中必须是"整组新瓶一球清空"：洗沟后再扫倒全部 10 瓶只是补中
    const strike = n === 10 && before === 10 && w.rackFresh;
    const spare = !strike && n === before && before > 0;
    fr.rolls.push(n);
    fr.marks.push(strike ? 'X' : spare ? '/' : n === 0 ? '–' : String(n));
    w.lastCleared = strike || spare;
    w.phase = 'wait';
    w.waitT = 0;
    const t = performance.now() / 1000;
    w.msgAt = t;
    if (strike) {
      w.msg = 'STRIKE!';
      w.msgBig = true;
      w.flashAt = t;
      sfx.match();
      toast('🎳 全中 STRIKE！', 'success');
    } else if (spare) {
      w.msg = 'SPARE!';
      w.msgBig = true;
      w.flashAt = t;
      sfx.merge();
      toast('🎳 补中 SPARE！', 'success');
    } else if (n === 0) {
      w.msg = w.ball.gutter ? '洗沟…' : '空球';
      w.msgBig = false;
      sfx.mismatch();
    } else {
      w.msg = `${n} 瓶`;
      w.msgBig = false;
      sfx.click();
    }
    setFrames(w.frames.map((f) => ({ rolls: [...f.rolls], marks: [...f.marks] })));
  }, [toast]);

  const finishRef = useRef(finishRoll);
  finishRef.current = finishRoll;

  // 主循环
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = RW * dpr;
    canvas.height = RH * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    let last = performance.now();

    const loop = (nowMs: number) => {
      const dt = Math.min(0.05, (nowMs - last) / 1000);
      last = nowMs;
      const t = nowMs / 1000;
      const w = worldRef.current;
      const playing = statusRef.current === 'playing';

      if (playing) {
        const target = w.phase === 'roll' ? clamp(w.ball.z - CAM_LAG, CAM_Z0, CAM_ZMAX) : CAM_Z0;
        cam.z += (target - cam.z) * (1 - Math.exp(-CAM_EASE * dt));
        stepPhysics(w, dt);
        if (w.phase === 'roll') {
          w.rollT += dt;
          const b = w.ball;
          const stopped = !b.pit && Math.hypot(b.vx, b.vz) < 0.3;
          const ballDone = b.pit || stopped || w.rollT > MAX_ROLL_T;
          const pinsSettled = w.pins.every((p) => p.state !== 'falling');
          if (ballDone && (pinsSettled || w.rollT > MAX_ROLL_T)) w.settleT += dt;
          if (w.settleT > 0.5 || w.rollT > MAX_ROLL_T + 2) {
            w.settleT = 0;
            finishRef.current();
          }
        } else if (w.phase === 'wait') {
          w.waitT += dt;
          if (w.waitT > 0.95) {
            if (advanceRoll(w) === 'over') {
              statusRef.current = 'over';
              setStatus('over');
            }
          }
        }
      }

      render(ctx, w, t, playing);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 站立瓶数（面板展示）
  useEffect(() => {
    const id = window.setInterval(() => {
      const w = worldRef.current;
      setStanding(w.pins.filter((p) => p.present && p.state === 'up').length);
    }, 160);
    return () => window.clearInterval(id);
  }, []);

  // 结算纪录
  useEffect(() => {
    if (status !== 'over') return;
    if (overRef.current) return;
    overRef.current = true;
    const totals = frameTotals(frames);
    const sc = totals[9] ?? 0;
    const isNew = sc > 0 && best.updateBest(sc, (a, b) => a > b);
    setNewRecord(isNew);
    if (isNew) {
      sfx.record();
      toast(`🏆 新纪录！${sc} 分`, 'record');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const togglePauseRef = useRef(togglePause);
  togglePauseRef.current = togglePause;
  const startRef = useRef(start);
  startRef.current = start;
  const shootRef = useRef(shoot);
  shootRef.current = shoot;

  // 键盘
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.code;
      if (k.startsWith('Arrow') || k === 'Space') e.preventDefault();
      if (k === 'KeyP' && !e.repeat) {
        togglePauseRef.current();
      } else if (k === 'Enter') {
        const s = statusRef.current;
        if (s === 'ready' || s === 'over') startRef.current();
      } else if (k === 'Space') {
        const s = statusRef.current;
        if (s === 'ready' || s === 'over') startRef.current();
        else if (s === 'paused') togglePauseRef.current();
        else if (!e.repeat) shootRef.current();
      } else if (statusRef.current === 'playing') {
        const w = worldRef.current;
        if (w.phase !== 'aim') return;
        if (k === 'ArrowLeft' && !e.repeat) {
          w.aim = clamp(w.aim - AIM_STEP, -AIM_MAX, AIM_MAX);
          sfx.move();
        } else if (k === 'ArrowRight' && !e.repeat) {
          w.aim = clamp(w.aim + AIM_STEP, -AIM_MAX, AIM_MAX);
          sfx.move();
        } else if (k === 'ArrowUp' && !e.repeat) {
          w.power = clamp(w.power + 0.06, 0.12, 1);
          sfx.move();
        } else if (k === 'ArrowDown' && !e.repeat) {
          w.power = clamp(w.power - 0.06, 0.12, 1);
          sfx.move();
        } else if (k === 'KeyA' && !e.repeat) {
          w.stanceX = clamp(w.stanceX - 0.07, -STANCE_XMAX, STANCE_XMAX);
          w.ball.x = w.stanceX;
          sfx.move();
        } else if (k === 'KeyD' && !e.repeat) {
          w.stanceX = clamp(w.stanceX + 0.07, -STANCE_XMAX, STANCE_XMAX);
          w.ball.x = w.stanceX;
          sfx.move();
        } else if (k === 'KeyQ' && !e.repeat) {
          setSpin((v) => clamp(Math.round((v - 0.15) * 100) / 100, -1, 1));
          sfx.move();
        } else if (k === 'KeyE' && !e.repeat) {
          setSpin((v) => clamp(Math.round((v + 0.15) * 100) / 100, -1, 1));
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
  }, []);

  // ============ 指针交互 ============

  const pointerToCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return [0, 0] as const;
    const rect = canvas.getBoundingClientRect();
    return [((e.clientX - rect.left) / rect.width) * RW, ((e.clientY - rect.top) / rect.height) * RH] as const;
  };

  const capture = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件无有效 pointerId 时忽略 */
    }
  };

  /** 拖拽方向 → 瞄准角与力度（从球心指向拖拽点，向前为投球方向） */
  const updateAim = useCallback((sx: number, sy: number) => {
    const w = worldRef.current;
    const [wx, wz] = unproject(sx, sy);
    const dx = wx - w.ball.x;
    const dz = wz - w.ball.z;
    w.aim = clamp(Math.atan2(dx, Math.max(dz, 0.35)), -AIM_MAX, AIM_MAX);
    w.power = clamp((Math.hypot(dx, dz) - 0.55) / 3.2, 0.12, 1);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const w = worldRef.current;
    if (statusRef.current !== 'playing' || w.phase !== 'aim') return;
    const [sx, sy] = pointerToCanvas(e);
    const bp = project(w.ball.x, BALL_R, w.ball.z);
    const hitR = Math.max(16, bp.s * BALL_R * 1.9);
    w.dragMoved = false;
    w.dragX0 = sx;
    w.dragDragStance = w.stanceX;
    if (Math.hypot(sx - bp.x, sy - bp.y) < hitR) {
      w.drag = 'stance';
    } else {
      w.drag = 'aim';
      updateAim(sx, sy);
    }
    capture(e);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const w = worldRef.current;
    if (statusRef.current !== 'playing' || w.drag === 'none') return;
    const [sx, sy] = pointerToCanvas(e);
    if (Math.abs(sx - w.dragX0) > 5) w.dragMoved = true;
    if (w.drag === 'stance') {
      const bp = project(w.ball.x, BALL_R, w.ball.z);
      // 从球体向前拖 → 直接转入瞄准
      if (sy < bp.y - bp.s * BALL_R * 2.4) {
        w.drag = 'aim';
        w.dragMoved = true;
        updateAim(sx, sy);
        return;
      }
      w.stanceX = clamp(w.dragDragStance + (sx - w.dragX0) / bp.s, -STANCE_XMAX, STANCE_XMAX);
      w.ball.x = w.stanceX;
      return;
    }
    updateAim(sx, sy);
  };

  const onPointerUp = () => {
    const w = worldRef.current;
    if (w.drag === 'aim' && w.dragMoved && w.power > 0.15) shootRef.current();
    w.drag = 'none';
    w.dragMoved = false;
  };

  const totals = frameTotals(frames);
  const total = [...totals].reverse().find((v) => v != null) ?? 0;
  const strikes = frames.reduce((acc, f) => acc + f.marks.filter((m) => m === 'X').length, 0);
  const spares = frames.reduce((acc, f) => acc + f.marks.filter((m) => m === '/').length, 0);
  const activeFrame = frames.findIndex((f) => f.rolls.length === 0 || (f.rolls.length < 2 && f.rolls[0] !== 10));

  return (
    <GameShell
      meta={metaBowling3D}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>得分</span>
            <strong>{total}</strong>
          </div>
          <div className="stat-box">
            <span>局数</span>
            <strong>{Math.min(10, (activeFrame < 0 ? 9 : activeFrame) + 1)}/10</strong>
          </div>
          <div className="stat-box">
            <span>站立瓶</span>
            <strong>{standing}</strong>
          </div>
          <div className="stat-box">
            <span>全中/补中</span>
            <strong>
              {strikes}/{spares}
            </strong>
          </div>
          <div className="stat-box">
            <span>{metaBowling3D.bestScoreLabel}</span>
            <strong>{best.value != null ? best.value : '—'}</strong>
          </div>
        </>
      }
    >
      <div className="bw3d">
        <div className="bw3d-stage">
          <canvas
            ref={canvasRef}
            className="bw3d-canvas"
            role="img"
            aria-label="3D 保龄球游戏画面"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {status === 'ready' && (
            <div className="bw3d-overlay">
              <h2>🎳 3D 保龄球</h2>
              <p>
                标准十局计分：全中 X 与补中 / 都有加分，满分 300。
                <br />
                瞄准 1-3 号瓶之间的入袋口最容易全中，侧旋能让球到后段再拐弯。
              </p>
              <p className="bw3d-keys">
                拖小球调站位 · 球道向前拖拽瞄准（拉得越远力度越大）松手投球
                <br />
                A/D 站位 ←→ 调角 ↑↓ 调力 Q/E 旋转 · 空格投球 · P 暂停
              </p>
              <button className="btn btn-primary" onClick={start}>
                开始比赛
              </button>
            </div>
          )}
          {status === 'paused' && (
            <div className="bw3d-overlay">
              <h2>⏸ 已暂停</h2>
              <button className="btn btn-primary" onClick={togglePause}>
                继续
              </button>
            </div>
          )}
          {status === 'over' && (
            <div className="bw3d-overlay" onClick={start}>
              <h2>🏁 十局结束</h2>
              <p>
                总分 {total} 分 · 全中 {strikes} 次 · 补中 {spares} 次
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

        <div className="bw3d-board" role="table" aria-label="计分板">
          {frames.map((f, i) => {
            const t = totals[i];
            return (
              <div key={i} className={`bw3d-frame ${i === activeFrame && status === 'playing' ? 'active' : ''}`}>
                <span className="bw3d-frame-no">{i + 1}</span>
                <div className="bw3d-marks">
                  {[0, 1, 2].map((k) => (
                    <span key={k} className={`bw3d-mark ${f.marks[k] === 'X' || f.marks[k] === '/' ? 'hot' : ''}`}>
                      {f.marks[k] ?? ''}
                    </span>
                  ))}
                </div>
                <b className="bw3d-total">{t ?? ''}</b>
              </div>
            );
          })}
        </div>

        <div className="bw3d-spin">
          <span>旋转</span>
          <button className="btn btn-ghost bw3d-spin-btn" onClick={() => setSpin((v) => clamp(v - 0.25, -1, 1))}>
            ← 左旋
          </button>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={spin}
            aria-label="侧旋强度"
            onChange={(e) => setSpin(Number(e.target.value))}
          />
          <button className="btn btn-ghost bw3d-spin-btn" onClick={() => setSpin((v) => clamp(v + 0.25, -1, 1))}>
            右旋 →
          </button>
          <b className="bw3d-spin-val">
            {spin === 0 ? '直球' : `${spin > 0 ? '右' : '左'} ${Math.abs(Math.round(spin * 100))}%`}
          </b>
        </div>

        <div className="bw3d-actions">
          <button className="btn btn-ghost" onClick={togglePause} disabled={status !== 'playing' && status !== 'paused'}>
            {status === 'paused' ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button className="btn btn-ghost" onClick={start}>
            🔄 重新开始
          </button>
        </div>
        <p className="hint">
          {status === 'playing' && frames[activeFrame] && frames[activeFrame].rolls.length === 1
            ? '第二次投球：清扫倒瓶后保留站立瓶，注意剩下的是哪几个瓶'
            : '虚线是预测球路（含侧旋弧线）· 轻拖近处力度小、拖向远处力度大'}
        </p>
      </div>
    </GameShell>
  );
}
