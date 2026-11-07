import { BALL_R, HOLE_R, cellAt, cellCenter } from './levels.ts';
import { WALL } from './types.ts';
import { CAPTURE, MAX_TILT, G, advance, createRun, dampingAt, isFalling, isTerminal } from './physics.ts';
import type { Level, TiltInput, Vec2 } from './types.ts';

/** 格子可通行：不是墙，且不含任何洞（球心必须离洞心至少 holeR×CAPTURE） */
export function passable(level: Level, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= level.size || row >= level.size) return false;
  if (level.terrain[row * level.size + col] === WALL) return false;
  const c = cellCenter(col, row, level.size);
  for (const hole of level.holes) {
    if (Math.hypot(c.x - hole.x, c.z - hole.z) < HOLE_R * CAPTURE + 0.05) return false;
  }
  return true;
}

/** 四邻域 BFS：只走轴对齐格子，是一条保守但一定物理可行的路线 */
export function findRoute(level: Level, from?: Vec2, to?: Vec2): Vec2[] | null {
  const startCell = cellAt(from?.x ?? level.start.x, from?.z ?? level.start.z, level.size);
  const goalCell = cellAt(to?.x ?? level.goal.x, to?.z ?? level.goal.z, level.size);
  const key = (c: number, r: number) => r * level.size + c;
  const startKey = key(startCell.col, startCell.row);
  const goalKey = key(goalCell.col, goalCell.row);
  // 终点本身是洞，passable 会拒绝它，所以单独放行
  const ok = (c: number, r: number) => key(c, r) === goalKey || passable(level, c, r);
  if (!ok(startCell.col, startCell.row) || !ok(goalCell.col, goalCell.row)) return null;

  const prev = new Int32Array(level.size * level.size).fill(-1);
  const seen = new Uint8Array(level.size * level.size);
  const queue: number[] = [startKey];
  seen[startKey] = 1;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    if (cur === goalKey) break;
    const c = cur % level.size;
    const r = (cur - c) / level.size;
    const neighbours = [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]];
    for (const [nc, nr] of neighbours) {
      if (nc < 0 || nr < 0 || nc >= level.size || nr >= level.size) continue;
      const nk = key(nc, nr);
      if (seen[nk] || !ok(nc, nr)) continue;
      seen[nk] = 1;
      prev[nk] = cur;
      queue.push(nk);
    }
  }
  if (!seen[goalKey]) return null;

  const cells: number[] = [];
  for (let cur = goalKey; cur !== -1; cur = prev[cur]) cells.push(cur);
  cells.reverse();
  if (cells[0] !== startKey) return null;
  return cells.map((k) => {
    const c = k % level.size;
    return cellCenter(c, (k - c) / level.size, level.size);
  });
}

/** 只保留方向改变处与起终点，作为自动驾驶航点 */
export function simplify(route: Vec2[]): Vec2[] {
  if (route.length <= 2) return route.slice();
  const out: Vec2[] = [route[0]];
  for (let i = 1; i < route.length - 1; i++) {
    const a = route[i - 1];
    const b = route[i];
    const c = route[i + 1];
    const d1x = Math.sign(b.x - a.x);
    const d1z = Math.sign(b.z - a.z);
    const d2x = Math.sign(c.x - b.x);
    const d2z = Math.sign(c.z - b.z);
    if (d1x !== d2x || d1z !== d2z) out.push(b);
  }
  out.push(route[route.length - 1]);
  return out;
}

export interface AutoOptions {
  /** 开局先等多久再动，用来错开摆杆相位 */
  wait?: number;
  /** 巡航速度上限 */
  cruise?: number;
  /** 最多模拟秒数 */
  limit?: number;
}

export interface AutoResult {
  cleared: boolean;
  elapsed: number;
  falls: number;
  gems: number;
  frames: number;
}

const ZERO: TiltInput = { x: 0, z: 0 };

/** 把期望面内加速度反解成归一化倾斜输入（planeGravity 的逆） */
export function inputForAccel(ax: number, az: number): TiltInput {
  const limit = G * Math.sin(MAX_TILT);
  const cx = Math.max(-limit, Math.min(limit, ax));
  const cz = Math.max(-limit, Math.min(limit, az));
  // ax = G·sin(input.x·MAX_TILT)；az = G·sin(input.z·MAX_TILT)·cos(roll)
  const x = Math.asin(cx / G) / MAX_TILT;
  const roll = -x * MAX_TILT;
  const z = Math.asin(Math.max(-1, Math.min(1, cz / (G * Math.cos(roll))))) / MAX_TILT;
  return { x: Math.max(-1, Math.min(1, x)), z: Math.max(-1, Math.min(1, z)) };
}

/**
 * PD 自动驾驶：沿 BFS 航点走，带阻尼前馈、洞与摆杆的斥力。
 * 用途一是可解性门禁（真跑通才算这关能过），二是产出 par 时间，三是游戏内提示线。
 */
export function autoPlay(level: Level, options: AutoOptions = {}): AutoResult {
  const route = findRoute(level);
  if (!route) return { cleared: false, elapsed: 0, falls: 0, gems: 0, frames: 0 };
  const points = simplify(route);
  const wait = options.wait ?? 0;
  const cruise = options.cruise ?? 2.1;
  const limit = options.limit ?? 150;
  const run = createRun(level);
  const dt = 1 / 60;
  let leg = 1;
  let frames = 0;
  let waited = 0;

  while (run.phase === 'rolling' || run.phase === 'falling') {
    frames += 1;
    if (run.elapsed > limit) break;
    if (waited < wait) {
      waited += dt;
      advance(level, run, ZERO, dt);
      continue;
    }
    if (isFalling(run)) {
      advance(level, run, ZERO, dt);
      if (!isFalling(run)) leg = 1;
      continue;
    }

    const b = run.ball;
    const target = points[Math.min(leg, points.length - 1)];
    const last = leg >= points.length - 1;
    let dx = target.x - b.x;
    let dz = target.z - b.z;
    let dist = Math.hypot(dx, dz);
    if (!last && dist < 0.3) {
      leg += 1;
      continue;
    }
    if (dist < 1e-6) { dx = 0; dz = 0; dist = 1e-6; }
    const dirx = dx / dist;
    const dirz = dz / dist;
    // 终点洞要主动掉进去，中途航点要减速停准
    const want = last ? Math.min(cruise, 0.7 + dist * 1.6) : Math.min(cruise, dist * 2.4);
    let dvx = dirx * want;
    let dvz = dirz * want;

    // 陷阱洞斥力：贴近时把期望速度推离洞口
    for (const hole of level.holes) {
      if (hole.goal) continue;
      const hx = b.x - hole.x;
      const hz = b.z - hole.z;
      const hd = Math.hypot(hx, hz);
      const safe = hole.r * CAPTURE + BALL_R + 0.22;
      if (hd < safe && hd > 1e-6) {
        const push = ((safe - hd) / safe) * cruise * 2.6;
        dvx += (hx / hd) * push;
        dvz += (hz / hd) * push;
      }
    }

    // 摆杆斥力：杆扫到附近就退开或停住等它过去
    for (let i = 0; i < level.sweepers.length; i++) {
      const s = level.sweepers[i];
      const a = run.sweeperAngles[i];
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const t = Math.max(-s.arm, Math.min(s.arm, (b.x - s.x) * ca + (b.z - s.z) * sa));
      const px = s.x + ca * t;
      const pz = s.z + sa * t;
      const sx = b.x - px;
      const sz = b.z - pz;
      const sd = Math.hypot(sx, sz);
      const safe = s.r + BALL_R + 0.62;
      if (sd < safe) {
        const push = ((safe - sd) / safe) * cruise * 3.4;
        if (sd > 1e-6) {
          dvx += (sx / sd) * push;
          dvz += (sz / sd) * push;
        } else {
          dvx -= sa * push;
          dvz += ca * push;
        }
      }
    }

    const k = dampingAt(level, b.x, b.z);
    const kp = 3.4;
    const ax = kp * (dvx - b.vx) + k * b.vx;
    const az = kp * (dvz - b.vz) + k * b.vz;
    advance(level, run, inputForAccel(ax, az), dt);
    if (isTerminal(run)) break;
  }

  return {
    cleared: run.phase === 'cleared',
    elapsed: run.elapsed,
    falls: run.falls,
    gems: run.taken.filter(Boolean).length,
    frames,
  };
}

/** 摆杆关卡：扫一遍开局等待相位，只要存在一个能过的时机就算可解 */
export function autoSolve(level: Level, tries = 14): AutoResult & { wait: number } {
  let best: AutoResult & { wait: number } = { cleared: false, elapsed: 0, falls: 0, gems: 0, frames: 0, wait: 0 };
  const period = level.sweepers.length
    ? (2 * Math.PI) / Math.max(...level.sweepers.map((s) => Math.abs(s.omega)))
    : 0;
  for (let i = 0; i < tries; i++) {
    const wait = period ? (i / tries) * period : 0;
    const result = autoPlay(level, { wait });
    if (result.cleared && (!best.cleared || result.elapsed < best.elapsed)) best = { ...result, wait };
    if (!period) break;
  }
  return best;
}

export function routeLength(route: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < route.length; i++) total += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
  return total;
}