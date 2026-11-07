import { BALL_R, terrainAt } from './levels.ts';
import { ICE, SAND, WALL } from './types.ts';
import type { Level, RunState, TiltInput, Vec2 } from './types.ts';

export const G = 9.8;
export const MAX_TILT = 0.3;
export const TILT_RATE = 1.9;
export const SUBSTEP = 1 / 240;
export const DAMPING = 1.05;
export const ICE_MUL = 0.28;
export const SAND_MUL = 3.4;
export const ROLL_RESIST = 0.22;
export const MAX_SPEED = 5.5;
export const RESTITUTION = 0.34;
export const TANGENT_KEEP = 0.88;
/** 洞捕获阈值：球心进入 holeR × 此比例才算掉下去，碾过边缘是安全的 */
export const CAPTURE = 0.8;
export const FALL_TIME = 0.55;
export const RESPAWN_GRACE = 0.7;
export const LIVES = 3;
export const GEM_R = 0.24;
export const CHECKPOINT_R = 0.46;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 盘面局部重力：世界 (0,-G,0) 经 Rx(-pitch)·Rz(-roll) 变换后的面内分量 */
export function planeGravity(pitch: number, roll: number): { ax: number; az: number } {
  return { ax: -G * Math.sin(roll), az: G * Math.sin(pitch) * Math.cos(roll) };
}

/** 输入 → 目标倾角。x=+1 让右缘下沉（球向右滚），z=+1 让近缘下沉（球向屏幕下方滚） */
export function tiltTarget(input: TiltInput): { pitch: number; roll: number } {
  return {
    pitch: clamp(input.z, -1, 1) * MAX_TILT,
    roll: -clamp(input.x, -1, 1) * MAX_TILT,
  };
}

export function dampingAt(level: Level, x: number, z: number): number {
  const t = terrainAt(level, x, z);
  if (t === ICE) return DAMPING * ICE_MUL;
  if (t === SAND) return DAMPING * SAND_MUL;
  return DAMPING;
}

export function createRun(level: Level): RunState {
  return {
    phase: 'rolling',
    ball: { x: level.start.x, z: level.start.z, vx: 0, vz: 0, y: 0, spin: 0 },
    pitch: 0,
    roll: 0,
    lives: LIVES,
    elapsed: 0,
    taken: level.gems.map(() => false),
    falls: 0,
    hints: 0,
    respawn: { x: level.start.x, z: level.start.z },
    checkpoint: -1,
    fallT: 0,
    fallGoal: false,
    fallX: 0,
    fallZ: 0,
    grace: RESPAWN_GRACE,
    sweeperAngles: level.sweepers.map((s) => s.phase),
    bumpLock: 0,
    acc: 0,
    events: [],
  };
}

export function respawn(run: RunState): void {
  const point: Vec2 = run.respawn;
  run.ball.x = point.x;
  run.ball.z = point.z;
  run.ball.vx = 0;
  run.ball.vz = 0;
  run.ball.y = 0;
  run.pitch = 0;
  run.roll = 0;
  run.grace = RESPAWN_GRACE;
  run.phase = 'rolling';
}

function moveTilt(run: RunState, input: TiltInput, h: number): void {
  const target = run.grace > 0 ? { pitch: 0, roll: 0 } : tiltTarget(input);
  const step = TILT_RATE * h;
  run.pitch += clamp(target.pitch - run.pitch, -step, step);
  run.roll += clamp(target.roll - run.roll, -step, step);
}

function collideWalls(level: Level, run: RunState): void {
  const b = run.ball;
  const half = level.half;
  const col0 = Math.floor(b.x + half - BALL_R + 0.5);
  const col1 = Math.floor(b.x + half + BALL_R + 0.5);
  const row0 = Math.floor(b.z + half - BALL_R + 0.5);
  const row1 = Math.floor(b.z + half + BALL_R + 0.5);
  for (let row = row0; row <= row1; row++) {
    for (let col = col0; col <= col1; col++) {
      if (row < 0 || col < 0 || row >= level.size || col >= level.size) continue;
      if (level.terrain[row * level.size + col] !== WALL) continue;
      const cx = col - half;
      const cz = row - half;
      const nearX = clamp(b.x, cx - 0.5, cx + 0.5);
      const nearZ = clamp(b.z, cz - 0.5, cz + 0.5);
      let nx = b.x - nearX;
      let nz = b.z - nearZ;
      let dist = Math.hypot(nx, nz);
      let push: number;
      if (dist < 1e-6) {
        // 球心陷进墙里（只可能由摆杆甩飞造成）：沿最小穿透轴推出
        const left = b.x - (cx - 0.5);
        const right = cx + 0.5 - b.x;
        const top = b.z - (cz - 0.5);
        const bottom = cz + 0.5 - b.z;
        const min = Math.min(left, right, top, bottom);
        if (min === left) { nx = -1; nz = 0; } else if (min === right) { nx = 1; nz = 0; }
        else if (min === top) { nx = 0; nz = -1; } else { nx = 0; nz = 1; }
        push = min + BALL_R;
        dist = 1;
      } else {
        nx /= dist;
        nz /= dist;
        push = BALL_R - dist;
      }
      if (push <= 0) continue;
      b.x += nx * push;
      b.z += nz * push;
      const vn = b.vx * nx + b.vz * nz;
      if (vn < 0) {
        b.vx -= (1 + RESTITUTION) * vn * nx;
        b.vz -= (1 + RESTITUTION) * vn * nz;
        const tx = -nz;
        const tz = nx;
        const vt = b.vx * tx + b.vz * tz;
        b.vx += (TANGENT_KEEP - 1) * vt * tx;
        b.vz += (TANGENT_KEEP - 1) * vt * tz;
        if (-vn > 0.75 && run.bumpLock <= 0) {
          run.events.push({ type: 'bump', speed: -vn });
          run.bumpLock = 0.09;
        }
      }
    }
  }
}

/** 摆杆胶囊碰撞：推出穿透后把杆面线速度传给球，所以会被甩飞 */
function collideSweepers(level: Level, run: RunState): void {
  const b = run.ball;
  for (let i = 0; i < level.sweepers.length; i++) {
    const s = level.sweepers[i];
    const a = run.sweeperAngles[i];
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const ax = s.x - ca * s.arm;
    const az = s.z - sa * s.arm;
    const dx = ca * s.arm * 2;
    const dz = sa * s.arm * 2;
    const len2 = dx * dx + dz * dz;
    const t = clamp(((b.x - ax) * dx + (b.z - az) * dz) / len2, 0, 1);
    const px = ax + dx * t;
    const pz = az + dz * t;
    let nx = b.x - px;
    let nz = b.z - pz;
    const dist = Math.hypot(nx, nz);
    const reach = s.r + BALL_R;
    if (dist >= reach) continue;
    if (dist < 1e-6) { nx = -sa; nz = ca; } else { nx /= dist; nz /= dist; }
    const push = reach - dist;
    b.x += nx * push;
    b.z += nz * push;
    // 接触点相对轴心的有符号臂长，决定该点线速度
    const armT = (t - 0.5) * 2 * s.arm;
    const bvx = -sa * armT * s.omega;
    const bvz = ca * armT * s.omega;
    const vn = b.vx * nx + b.vz * nz;
    const bvn = bvx * nx + bvz * nz;
    const want = bvn + Math.max(0.5, -vn * 0.35);
    b.vx += (want - vn) * nx;
    b.vz += (want - vn) * nz;
    if (run.bumpLock <= 0) {
      run.events.push({ type: 'bump', speed: Math.abs(want - vn) });
      run.bumpLock = 0.12;
    }
  }
}

function captureHoles(level: Level, run: RunState): void {
  const b = run.ball;
  for (const hole of level.holes) {
    const d = Math.hypot(b.x - hole.x, b.z - hole.z);
    if (d >= hole.r * CAPTURE) continue;
    run.phase = 'falling';
    run.fallT = 0;
    run.fallGoal = hole.goal;
    run.fallX = hole.x;
    run.fallZ = hole.z;
    run.events.push({ type: 'fall', goal: hole.goal });
    return;
  }
}

function pickUps(level: Level, run: RunState): void {
  const b = run.ball;
  for (let i = 0; i < level.gems.length; i++) {
    if (run.taken[i]) continue;
    const g = level.gems[i];
    if (Math.hypot(b.x - g.x, b.z - g.z) < BALL_R + GEM_R) {
      run.taken[i] = true;
      run.events.push({ type: 'gem', index: i });
    }
  }
  for (let i = 0; i < level.checkpoints.length; i++) {
    if (run.checkpoint === i) continue;
    const c = level.checkpoints[i];
    if (Math.hypot(b.x - c.x, b.z - c.z) < CHECKPOINT_R) {
      run.checkpoint = i;
      run.respawn = { x: c.x, z: c.z };
      run.events.push({ type: 'checkpoint', index: i });
    }
  }
}

function substep(level: Level, run: RunState, input: TiltInput, h: number): void {
  run.elapsed += h;
  run.grace = Math.max(0, run.grace - h);
  run.bumpLock = Math.max(0, run.bumpLock - h);
  for (let i = 0; i < level.sweepers.length; i++) {
    const s = level.sweepers[i];
    run.sweeperAngles[i] = s.phase + s.omega * run.elapsed;
  }

  if (run.phase === 'falling') {
    run.fallT += h;
    const b = run.ball;
    const k = clamp(run.fallT / FALL_TIME, 0, 1);
    b.x += (run.fallX - b.x) * Math.min(1, h * 9);
    b.z += (run.fallZ - b.z) * Math.min(1, h * 9);
    b.y = -k * k * 1.9;
    b.vx = 0;
    b.vz = 0;
    if (run.fallT >= FALL_TIME) {
      if (run.fallGoal) {
        run.phase = 'cleared';
        b.y = -1.9;
        run.events.push({ type: 'cleared' });
      } else {
        run.lives -= 1;
        run.falls += 1;
        if (run.lives <= 0) {
          run.phase = 'over';
          run.events.push({ type: 'over' });
        } else {
          respawn(run);
        }
      }
    }
    return;
  }

  moveTilt(run, input, h);
  const b = run.ball;
  const { ax, az } = planeGravity(run.pitch, run.roll);
  b.vx += ax * h;
  b.vz += az * h;

  const decay = Math.exp(-dampingAt(level, b.x, b.z) * h);
  b.vx *= decay;
  b.vz *= decay;
  const speed = Math.hypot(b.vx, b.vz);
  if (speed > 1e-6) {
    const dropped = Math.max(0, speed - ROLL_RESIST * h);
    const scale = Math.min(dropped, MAX_SPEED) / speed;
    b.vx *= scale;
    b.vz *= scale;
    b.spin += (Math.min(dropped, MAX_SPEED) * h) / BALL_R;
  }

  b.x += b.vx * h;
  b.z += b.vz * h;
  collideWalls(level, run);
  collideSweepers(level, run);
  const after = Math.hypot(b.vx, b.vz);
  if (after > MAX_SPEED) {
    b.vx *= MAX_SPEED / after;
    b.vz *= MAX_SPEED / after;
  }
  pickUps(level, run);
  captureHoles(level, run);
}

/** 推进一帧。dt 会被夹到 0.05 并按固定子步积分，事件累积在 run.events 里由调用方取走。 */
export function advance(level: Level, run: RunState, input: TiltInput, dt: number): void {
  if (isTerminal(run)) return;
  run.acc += clamp(dt, 0, 0.05);
  let guard = 0;
  while (run.acc >= SUBSTEP && guard < 64) {
    substep(level, run, input, SUBSTEP);
    run.acc -= SUBSTEP;
    guard += 1;
    if (isTerminal(run)) { run.acc = 0; break; }
  }
}

export function drainEvents(run: RunState): RunState['events'] {
  if (run.events.length === 0) return [];
  const out = run.events;
  run.events = [];
  return out;
}

/** 用函数读相态：直接比较会让 TS 把后续被 substep 改写的 phase 当成已收窄 */
export function isTerminal(run: RunState): boolean {
  return run.phase === 'cleared' || run.phase === 'over';
}

export function isFalling(run: RunState): boolean {
  return run.phase === 'falling';
}

export function starsFor(elapsed: number, par: number): number {
  if (elapsed <= par) return 3;
  if (elapsed <= par * 1.6) return 2;
  return 1;
}

export interface ScoreBreakdown {
  base: number;
  gems: number;
  timeBonus: number;
  fallPenalty: number;
  hintPenalty: number;
  total: number;
  stars: number;
}

export const LEVEL_BASE = 600;
export const GEM_VALUE = 120;
export const TIME_RATE = 20;
export const FALL_COST = 120;
export const HINT_COST = 50;

export function levelScore(level: Level, run: RunState): ScoreBreakdown {
  const gems = run.taken.filter(Boolean).length;
  const par = level.def.par;
  const timeBonus = Math.max(0, Math.round((par * 1.6 - run.elapsed) * TIME_RATE));
  const fallPenalty = run.falls * FALL_COST;
  const hintPenalty = run.hints * HINT_COST;
  const total = Math.max(0, LEVEL_BASE + gems * GEM_VALUE + timeBonus - fallPenalty - hintPenalty);
  return {
    base: LEVEL_BASE,
    gems: gems * GEM_VALUE,
    timeBonus,
    fallPenalty,
    hintPenalty,
    total,
    stars: starsFor(run.elapsed, par),
  };
}

/** 提示：标出可行路线，本关结算扣 50 分，不影响星级 */
export function useHint(run: RunState): void {
  if (run.phase !== 'rolling') return;
  run.hints += 1;
}

/** 摆杆当前线段两端（渲染与自动驾驶共用） */
export function sweeperEnds(level: Level, run: RunState, i: number): { ax: number; az: number; bx: number; bz: number } {
  const s = level.sweepers[i];
  const a = run.sweeperAngles[i];
  const ca = Math.cos(a) * s.arm;
  const sa = Math.sin(a) * s.arm;
  return { ax: s.x - ca, az: s.z - sa, bx: s.x + ca, bz: s.z + sa };
}