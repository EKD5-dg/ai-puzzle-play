import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaGaze3D } from '../core/gameMetas';

/**
 * 3D 凝视回廊 —— 第一人称射击。
 *
 * 与仓库其他 3D 游戏不同，这里不用光线投射：自己写了一套软 3D 管线
 * （世界坐标 → 相机空间 → 近平面裁剪 → 透视投影 → 画家算法排序 → 逐面光照），
 * 于是墙是有厚度与顶面的立体块、石像是可以转身前扑的组合方块，
 * 而不是逐列贴图与 billboard 精灵。全程 Canvas 2D，零依赖。
 */

// ============ 玩法常量 ============

/** 回廊格数 */
const GRID = 25;
/** 内部渲染分辨率 */
const RW = 480;
const RH = 300;
const RADIUS = 0.26;
const SPEED = 3.1;
const SPRINT_K = 1.4;
const TURN_SPEED = 2.7;
/** 石像只在这个距离内、落在画面里且没被墙挡住时才会冻结 */
const GAZE_RANGE = 12;
/** 视线锥相对画面的宽出量（1 = 与屏幕严格一致，略大避免"看得见却不动"） */
const GAZE_MARGIN = 1.06;
/** 持续凝视致死：累积秒数与生效距离。必须走近了盯，否则站着环视就能刷分 */
const STARE_KILL = 2.4;
const STARE_RANGE = 7;
const LIVES_MAX = 3;
const ENERGY_MAX = 100;
const SHOT_COST = 24;
const ENERGY_REGEN = 27;
/** 命中回充：奖励瞄准，避免无脑按住扫射 */
const ENERGY_REFUND = 12;
const SHOT_CD = 0.24;
/** 光矛命中半宽：光束粗细固定，比按透视缩放更好瞄 */
const BEAM_HALF = 0.36;
const CONTACT = 0.62;
const STAGGER = 1.5;
const RESPAWN_MIN = 4.5;
const SCORE_CORE = 120;
const SCORE_SHOT = 100;
const SCORE_STARE = 80;
const SCORE_FLOOR = 400;
const CHAIN_MAX = 3;
const CHAIN_WINDOW = 5;

// ============ 软 3D 常量 ============

/** 厅高与视点高度（世界单位 = 格） */
const WALL_H = 1.55;
const EYE = 0.74;
/** 焦距（内部像素）：FOCAL = RW/2 / tan(半视场角)，0.72·RW ≈ 70° */
const FOCAL = RW * 0.72;
/** 画面半宽对应的 tan(半视场角)：判定"石像是否落在画面里"与投影严格同源 */
const HALF_TAN = RW / (2 * FOCAL);
/** 近平面：小于该深度的顶点先裁剪 */
const NEAR = 0.12;
/** 几何剔除半径：超出即完全融进雾里，不必投影 */
const CULL_R = 15;
const FOG_START = 3;
const FOG_END = 16;
/** 雾色（与远处天花板同调，墙面消隐时不露边） */
const FOGC: RGB = [10, 11, 24];
const PITCH_MAX = 70;

const DIRS4: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

type RGB = [number, number, number];
/** 世界坐标顶点 */
type Vec3 = [number, number, number];

// ============ 通用工具 ============

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const inRange = (x: number, y: number) => x >= 0 && y >= 0 && x < GRID && y < GRID;

function solid(g: Uint8Array, x: number, y: number): boolean {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  return !inRange(ix, iy) || g[iy * GRID + ix] === 1;
}

/** 从 fromIdx 做 BFS，返回每格步距（-1 = 墙/不可达）；石像寻路与布点共用 */
function bfs(g: Uint8Array, fromIdx: number): Int16Array {
  const d = new Int16Array(GRID * GRID).fill(-1);
  if (fromIdx < 0 || fromIdx >= d.length || g[fromIdx] === 1) return d;
  const q: number[] = [fromIdx];
  d[fromIdx] = 0;
  for (let head = 0; head < q.length; head++) {
    const cur = q[head];
    const cx = cur % GRID;
    const cy = (cur / GRID) | 0;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inRange(nx, ny)) continue;
      const idx = ny * GRID + nx;
      if (g[idx] === 1 || d[idx] >= 0) continue;
      d[idx] = d[cur] + 1;
      q.push(idx);
    }
  }
  return d;
}

function reachCount(g: Uint8Array, fromIdx: number): number {
  const d = bfs(g, fromIdx);
  let n = 0;
  for (let i = 0; i < d.length; i++) if (d[i] >= 0) n++;
  return n;
}

/** 视线是否被墙挡住：按 0.18 格步长采样 */
function losClear(g: Uint8Array, ax: number, ay: number, bx: number, by: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const n = Math.ceil(Math.hypot(dx, dy) / 0.18);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (solid(g, ax + dx * t, ay + dy * t)) return false;
  }
  return true;
}

/** 分轴移动（贴墙滑动） */
function freeAt(g: Uint8Array, x: number, y: number, r: number): boolean {
  return !solid(g, x - r, y - r) && !solid(g, x + r, y - r) && !solid(g, x - r, y + r) && !solid(g, x + r, y + r);
}

function slideMove(g: Uint8Array, e: { x: number; y: number }, mx: number, my: number, r: number): void {
  if (freeAt(g, e.x + mx, e.y, r)) e.x += mx;
  if (freeAt(g, e.x, e.y + my, r)) e.y += my;
}

/** 玩家用 px/py 存坐标，单独走一份；返回本帧实际位移（脚步计步用） */
function movePlayer(w: World, mx: number, my: number): number {
  const ox = w.px;
  const oy = w.py;
  if (freeAt(w.grid, w.px + mx, w.py, RADIUS)) w.px += mx;
  if (freeAt(w.grid, w.px, w.py + my, RADIUS)) w.py += my;
  return Math.hypot(w.px - ox, w.py - oy);
}

// ============ 软 3D 引擎 ============

interface Cam {
  x: number;
  y: number;
  yaw: number;
  /** 俯仰以地平线位移近似（像素）：竖直线保持竖直，够用且不需要真旋转投影 */
  pitch: number;
  eye: number;
}

interface Face {
  /** 世界坐标顶点（墙面约定：底左、底右、顶右、顶左，砌缝按此插值） */
  v: Vec3[];
  /** 世界法线（单位） */
  n: Vec3;
  /** 面中心（深度排序与光照用） */
  c: Vec3;
  col: RGB;
  /** 自发光：跳过光照，只留一点雾（石像眼睛、星门核心） */
  glow?: boolean;
  /** 墙面砌缝：底边到顶边之间的归一化高度 */
  seams?: number[];
}

/** 单个世界点投影到屏幕（HUD 锚点、光束端点、凝视进度条用） */
function project(cam: Cam, p: Vec3): { x: number; y: number; z: number } | null {
  const dx = p[0] - cam.x;
  const dy = p[1] - cam.y;
  const c = Math.cos(cam.yaw);
  const s = Math.sin(cam.yaw);
  const z = dx * c + dy * s;
  if (z < NEAR) return null;
  const x = -dx * s + dy * c;
  return {
    x: RW / 2 + (x * FOCAL) / z,
    y: RH / 2 + cam.pitch - ((p[2] - cam.eye) * FOCAL) / z,
    z,
  };
}

/** 近平面裁剪（Sutherland–Hodgman 单平面版）：输入输出都是 [x,y,z,...] 扁平数组 */
function clipNear(src: Float64Array, n: number, dst: Float64Array): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 3;
    const b = ((i + 1) % n) * 3;
    const az = src[a + 2];
    const bz = src[b + 2];
    const ain = az >= NEAR;
    const bin = bz >= NEAR;
    if (ain) {
      dst[m * 3] = src[a];
      dst[m * 3 + 1] = src[a + 1];
      dst[m * 3 + 2] = az;
      m++;
    }
    if (ain !== bin && m < 8) {
      const t = (NEAR - az) / (bz - az);
      dst[m * 3] = src[a] + (src[b] - src[a]) * t;
      dst[m * 3 + 1] = src[a + 1] + (src[b + 1] - src[a + 1]) * t;
      dst[m * 3 + 2] = NEAR;
      m++;
    }
  }
  return m;
}

/** 由两条边算单位法线（右手系：绕序决定正反面） */
function faceNormal(a: Vec3, b: Vec3, d: Vec3): Vec3 {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = d[0] - a[0];
  const vy = d[1] - a[1];
  const vz = d[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  return [nx, ny, nz];
}

function pushQuad(faces: Face[], a: Vec3, b: Vec3, c: Vec3, d: Vec3, col: RGB, opts?: { glow?: boolean; seams?: number[] }): void {
  faces.push({
    v: [a, b, c, d],
    n: faceNormal(a, b, d),
    c: [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4, (a[2] + b[2] + c[2] + d[2]) / 4],
    col,
    glow: opts?.glow,
    seams: opts?.seams,
  });
}

/** 双面片：正反各发一次，用于星门环这类中空结构（否则背面会穿帮） */
function pushQuad2(faces: Face[], a: Vec3, b: Vec3, c: Vec3, d: Vec3, col: RGB, glow = false): void {
  pushQuad(faces, a, b, c, d, col, { glow });
  pushQuad(faces, a, d, c, b, col, { glow });
}

function pushTri(faces: Face[], a: Vec3, b: Vec3, c: Vec3, col: RGB, glow = false): void {
  faces.push({
    v: [a, b, c],
    n: faceNormal(a, b, c),
    c: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
    col,
    glow,
  });
}

/** 绕 z 轴旋转的长方体：石像、碎石、墙柱都用它拼 */
function pushBox(
  faces: Face[],
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  yaw: number,
  col: RGB,
  top?: RGB,
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const P = (lx: number, ly: number, lz: number): Vec3 => [cx + lx * c - ly * s, cy + lx * s + ly * c, cz + lz];
  const z0 = -hz;
  const z1 = hz;
  const x0 = -hx;
  const x1 = hx;
  const y0 = -hy;
  const y1 = hy;
  const side = col;
  pushQuad(faces, P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1), side); // +x
  pushQuad(faces, P(x0, y1, z0), P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), side); // -x
  pushQuad(faces, P(x1, y1, z0), P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1), side); // +y
  pushQuad(faces, P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), side); // -y
  pushQuad(faces, P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), top ?? col); // +z
}

/**
 * 着色：环境光 + 手电（沿视线打回相机方向，随距离衰减）+ 顶部微光，再按距离混入雾色。
 * 法线 lambert 用面心到相机的方向，因此正对玩家的墙最亮、侧墙自然压暗。
 */
function shade(f: Face, cam: Cam): string {
  const vx = cam.x - f.c[0];
  const vy = cam.y - f.c[1];
  const vz = cam.eye - f.c[2];
  const dist = Math.hypot(vx, vy, vz) || 1;
  const fog = Math.min(1, Math.max(0, (dist - FOG_START) / (FOG_END - FOG_START)));
  if (f.glow) {
    const k = 1 - fog * 0.75;
    return `rgb(${Math.round(f.col[0] * k)},${Math.round(f.col[1] * k)},${Math.round(f.col[2] * k)})`;
  }
  const lam = Math.max(0, (f.n[0] * vx + f.n[1] * vy + f.n[2] * vz) / dist);
  const torch = lam / (1 + dist * 0.34);
  const up = Math.max(0, f.n[2]) * 0.22;
  // 上限 1.15：近处墙面不钳制会直接烧成白块
  const lit = Math.min(1.15, Math.max(0.08, 0.38 + torch * 1.0 + up));
  const r = f.col[0] * lit * (1 - fog) + FOGC[0] * fog;
  const g = f.col[1] * lit * (1 - fog) + FOGC[1] * fog;
  const b = f.col[2] * lit * (1 - fog) + FOGC[2] * fog;
  return `rgb(${r < 0 ? 0 : r > 255 ? 255 : r | 0},${g < 0 ? 0 : g > 255 ? 255 : g | 0},${b < 0 ? 0 : b > 255 ? 255 : b | 0})`;
}

/** 逐帧复用的顶点暂存：src/dst 走近平面裁剪，pool 存排序前落盘的各面顶点 */
interface Scratch {
  src: Float64Array;
  dst: Float64Array;
  pool: Float64Array;
}

interface Prepared {
  f: Face;
  depth: number;
  n: number;
  off: number;
}

/**
 * 一帧的绘制：背面剔除 → 近平面裁剪 → 画家算法（按面心深度从远到近）→ 填充 + 砌缝 + 轮廓。
 * 凸体互不穿插，所以按面心排序在本场景里足够稳定；相邻同色块偶发次序颠倒肉眼看不出来。
 */
function renderScene(ctx: CanvasRenderingContext2D, cam: Cam, faces: Face[], list: Prepared[], sc: Scratch): void {
  list.length = 0;
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  let used = 0;
  for (const f of faces) {
    const vx = cam.x - f.c[0];
    const vy = cam.y - f.c[1];
    const vz = cam.eye - f.c[2];
    if (Math.hypot(vx, vy, vz) > CULL_R + 2) continue;
    if (f.n[0] * vx + f.n[1] * vy + f.n[2] * vz <= 0) continue; // 背面
    const nv = f.v.length;
    let behind = 0;
    for (let i = 0; i < nv; i++) {
      const p = f.v[i];
      const dx = p[0] - cam.x;
      const dy = p[1] - cam.y;
      const z = dx * cy + dy * sy;
      sc.src[i * 3] = -dx * sy + dy * cy;
      sc.src[i * 3 + 1] = p[2] - cam.eye;
      sc.src[i * 3 + 2] = z;
      if (z < NEAR) behind++;
    }
    if (behind === nv) continue;
    const m = behind === 0 ? nv : clipNear(sc.src, nv, sc.dst);
    if (m < 3) continue;
    if (used + m * 3 > sc.pool.length) continue; // 暂存预算用完：丢掉这一面，下一帧再来
    const from = behind === 0 ? sc.src : sc.dst;
    for (let i = 0; i < m * 3; i++) sc.pool[used + i] = from[i];
    let depth = 0;
    for (let i = 0; i < m; i++) depth += sc.pool[used + i * 3 + 2];
    list.push({ f, depth: depth / m, n: m, off: used });
    used += m * 3;
  }
  list.sort((a, b) => b.depth - a.depth);
  const P = sc.pool;
  for (const it of list) {
    const { f, n, off } = it;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const z = P[off + i * 3 + 2];
      const sx = RW / 2 + (P[off + i * 3] * FOCAL) / z;
      const syp = RH / 2 + cam.pitch - (P[off + i * 3 + 1] * FOCAL) / z;
      if (i === 0) ctx.moveTo(sx, syp);
      else ctx.lineTo(sx, syp);
    }
    ctx.closePath();
    ctx.fillStyle = shade(f, cam);
    ctx.fill();
    if (f.seams && n === 4) {
      // 顶点顺序为底左/底右/顶右/顶左：同一高度 h 在左棱 0→3 与右棱 1→2 上各插一点，
      // 连线自然跟着梯形一起透视变形，就是墙上的砌缝
      ctx.strokeStyle = 'rgba(4,5,14,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const h of f.seams) {
        const lx = P[off] + (P[off + 9] - P[off]) * h;
        const ly = P[off + 1] + (P[off + 10] - P[off + 1]) * h;
        const lz = P[off + 2] + (P[off + 11] - P[off + 2]) * h;
        const rx = P[off + 3] + (P[off + 6] - P[off + 3]) * h;
        const ry = P[off + 4] + (P[off + 7] - P[off + 4]) * h;
        const rz = P[off + 5] + (P[off + 8] - P[off + 5]) * h;
        ctx.moveTo(RW / 2 + (lx * FOCAL) / lz, RH / 2 + cam.pitch - (ly * FOCAL) / lz);
        ctx.lineTo(RW / 2 + (rx * FOCAL) / rz, RH / 2 + cam.pitch - (ry * FOCAL) / rz);
      }
      ctx.stroke();
    }
    if (!f.glow && n <= 4) {
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

// ============ 场景几何 ============

const MARBLE: RGB = [146, 154, 184];
const MARBLE_WARM: RGB = [176, 158, 140];
const FLOOR_A: RGB = [92, 90, 118];
const FLOOR_B: RGB = [66, 62, 88];
const STONE: RGB = [178, 182, 200];
const STONE_DARK: RGB = [104, 108, 130];
const CREEP: RGB = [162, 142, 182];
const CREEP_DARK: RGB = [94, 76, 118];

/** 墙体：从地板格向外看，邻格是墙就贴一面立起的四边形（有厚度感、可带砌缝） */
function emitRoom(faces: Face[], w: World, cam: Cam): void {
  const g = w.grid;
  const fx = Math.cos(cam.yaw);
  const fy = Math.sin(cam.yaw);
  for (let cy = 0; cy < GRID; cy++) {
    for (let cx = 0; cx < GRID; cx++) {
      const idx = cy * GRID + cx;
      if (g[idx] === 1) continue;
      const mx = cx + 0.5;
      const my = cy + 0.5;
      const ddx = mx - cam.x;
      const ddy = my - cam.y;
      const dc = Math.hypot(ddx, ddy);
      if (dc > CULL_R) continue;
      if (ddx * fx + ddy * fy < -1.4) continue;
      // 地板砖：棋盘双色，给透视一个可读的地面
      const tile = (cx + cy) % 2 === 0 ? FLOOR_A : FLOOR_B;
      const tint = 0.9 + (((cx * 5 + cy * 11) % 4) * 0.05);
      pushQuad(
        faces,
        [cx, cy, 0],
        [cx + 1, cy, 0],
        [cx + 1, cy + 1, 0],
        [cx, cy + 1, 0],
        [tile[0] * tint, tile[1] * tint, tile[2] * tint],
      );
      for (const [ox, oy] of DIRS4) {
        const nx = cx + ox;
        const ny = cy + oy;
        if (!inRange(nx, ny) || g[ny * GRID + nx] === 0) continue;
        const wx = mx + ox * 0.5;
        const wy = my + oy * 0.5;
        const wdx = wx - cam.x;
        const wdy = wy - cam.y;
        if (Math.hypot(wdx, wdy) > CULL_R) continue;
        if (wdx * fx + wdy * fy < -0.75) continue;
        const warm = (nx * 7 + ny * 13) % 3 === 0;
        const base = warm ? MARBLE_WARM : MARBLE;
        const k = 0.86 + ((nx * 3 + ny * 5) % 5) * 0.055;
        const tx = -oy;
        const ty = ox;
        // 绕序让法线指向地板格（(oy,-ox,0)）：反过来就会被背面剔除，整面墙直接消失
        pushQuad(
          faces,
          [wx + tx * 0.5, wy + ty * 0.5, 0],
          [wx - tx * 0.5, wy - ty * 0.5, 0],
          [wx - tx * 0.5, wy - ty * 0.5, WALL_H],
          [wx + tx * 0.5, wy + ty * 0.5, WALL_H],
          [base[0] * k, base[1] * k, base[2] * k],
          { seams: [0.3, 0.58, 0.84] },
        );
      }
    }
  }
}

function tint(base: RGB, k: number): RGB {
  return [base[0] * k, base[1] * k, base[2] * k];
}

/** 石像：基座 + 腿 + 躯干 + 肩 + 双臂 + 头 + 兜帽 + 双眼，全部绕同一 yaw 组合，转身时整具一起转 */
function emitStatue(faces: Face[], s: Statue, cam: Cam, t: number): void {
  const dx = cam.x - s.x;
  const dy = cam.y - s.y;
  if (Math.hypot(dx, dy) > CULL_R) return;
  const yaw = s.faceYaw;
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const off = (lx: number, ly: number): [number, number] => [s.x + lx * c - ly * sn, s.y + lx * sn + ly * c];
  const moving = !s.frozen && s.stagger <= 0;
  const body = moving ? CREEP : STONE;
  const dark = moving ? CREEP_DARK : STONE_DARK;
  const z = moving ? Math.sin(t * 9 + s.phase) * 0.016 : 0;
  let [bx, by] = off(0, 0);
  pushBox(faces, bx, by, 0.045, 0.25, 0.25, 0.045, yaw, dark, tint(dark, 1.3));
  [bx, by] = off(0, 0);
  pushBox(faces, bx, by, z + 0.3, 0.13, 0.09, 0.2, yaw, tint(body, 0.82)); // 腿
  [bx, by] = off(0, moving ? 0.04 : 0);
  pushBox(faces, bx, by, z + 0.72, 0.15, 0.1, 0.22, yaw, body, tint(body, 1.1)); // 躯干
  const [sx2, sy2] = off(0, moving ? 0.04 : 0);
  pushBox(faces, sx2, sy2, z + 0.95, 0.2, 0.1, 0.05, yaw, tint(body, 0.94)); // 肩
  // 手臂：前扑时向前抬，冻结时垂在体侧
  const armF = moving ? 0.17 : 0;
  const armHz = moving ? 0.14 : 0.23;
  for (const side of [-1, 1]) {
    const [ax, ay] = off(side * 0.22, armF);
    pushBox(faces, ax, ay, z + 0.74 - (moving ? 0.08 : 0), 0.055, 0.055, armHz, yaw + side * (moving ? 0.22 : 0.05), tint(body, side < 0 ? 1.04 : 0.88));
  }
  const [hx, hy] = off(0, moving ? 0.06 : 0);
  pushBox(faces, hx, hy, z + 1.08, 0.095, 0.095, 0.1, yaw, tint(body, 1.06), tint(body, 1.16)); // 头
  const [cx2, cy2] = off(0, moving ? 0.02 : -0.02);
  pushBox(faces, cx2, cy2, z + 1.19, 0.108, 0.108, 0.035, yaw, dark); // 兜帽
  // 眼睛：只有会动的石像才亮红眼——这是"它在逼近"的核心视觉信号
  const eyeCol: RGB = moving ? [255, 74, 92] : s.stagger > 0 ? [130, 240, 255] : [34, 36, 50];
  for (const side of [-1, 1]) {
    const [ex, ey] = off(side * 0.042, 0.096);
    pushBox(faces, ex, ey, z + 1.1, 0.021, 0.008, 0.016, yaw, eyeCol, eyeCol);
  }
}

/** 碎裂后的碎石堆（重生倒计时期间留在原地） */
function emitRubble(faces: Face[], s: Statue): void {
  const rnd = mulberry(Math.floor(s.phase * 1000));
  pushBox(faces, s.x, s.y, 0.035, 0.26, 0.26, 0.035, s.faceYaw, tint(STONE_DARK, 0.8));
  for (let i = 0; i < 4; i++) {
    const [ox, oy] = [(rnd() - 0.5) * 0.42, (rnd() - 0.5) * 0.42];
    const sz = 0.05 + rnd() * 0.07;
    pushBox(faces, s.x + ox, s.y + oy, 0.05 + rnd() * 0.06, sz, sz, sz * 0.7, rnd() * 3.14, tint(STONE, 0.72 + rnd() * 0.3));
  }
}

/** 星门：绕竖直轴旋转的环 + 内部暗核 */
function emitPortal(faces: Face[], x: number, y: number, open: boolean, t: number): void {
  const SEG = 12;
  const spin = t * (open ? 1.1 : 0.25);
  const col: RGB = open ? [150, 120, 255] : [96, 44, 66];
  const hot: RGB = open ? [126, 232, 255] : [150, 60, 84];
  for (let i = 0; i < SEG; i++) {
    const a0 = spin + (i / SEG) * Math.PI * 2;
    const a1 = spin + ((i + 0.72) / SEG) * Math.PI * 2;
    const r0 = 0.34;
    const r1 = 0.46;
    const h0 = 0.12;
    const h1 = 1.34;
    pushQuad2(
      faces,
      [x + Math.cos(a0) * r0, y + Math.sin(a0) * r0, h0],
      [x + Math.cos(a1) * r0, y + Math.sin(a1) * r0, h0],
      [x + Math.cos(a1) * r1, y + Math.sin(a1) * r1, h1],
      [x + Math.cos(a0) * r1, y + Math.sin(a0) * r1, h1],
      i % 2 === 0 ? col : hot,
      true,
    );
  }
  const N = 10;
  const inner: Vec3[] = [];
  for (let i = 0; i < N; i++) {
    const a = -spin * 0.6 + (i / N) * Math.PI * 2;
    inner.push([x + Math.cos(a) * 0.33, y + Math.sin(a) * 0.33, 0.72 + Math.sin(a * 2 + t * 2) * 0.3]);
  }
  for (let i = 0; i < N; i++) {
    pushTri(faces, [x, y, 0.72], inner[i], inner[(i + 1) % N], open ? [16, 10, 40] : [22, 8, 14], true);
  }
}

// ============ 回廊生成 ============

/**
 * 完美迷宫 + 打通部分隔断 + 三座开阔大厅 + 柱子。
 * 大厅给石像冲刺距离，柱子提供视线遮挡——两者是"注视冻结"能玩起来的前提。
 */
function genGrid(): Uint8Array {
  const g = new Uint8Array(GRID * GRID).fill(1);
  const start = 1 * GRID + 1;
  g[start] = 0;
  const stack: number[] = [start];
  while (stack.length > 0) {
    const cur = stack[stack.length - 1];
    const cx = cur % GRID;
    const cy = (cur / GRID) | 0;
    const dirs = [...DIRS4].sort(() => Math.random() - 0.5);
    let moved = false;
    for (const [dx, dy] of dirs) {
      const nx = cx + dx * 2;
      const ny = cy + dy * 2;
      if (nx <= 0 || ny <= 0 || nx >= GRID - 1 || ny >= GRID - 1) continue;
      if (g[ny * GRID + nx] === 0) continue;
      g[ny * GRID + nx] = 0;
      g[(cy + dy) * GRID + (cx + dx)] = 0;
      stack.push(ny * GRID + nx);
      moved = true;
      break;
    }
    if (!moved) stack.pop();
  }
  // 回环越多越能绕到背后，纯树状迷宫会让石像永远堵在死路里
  for (let y = 1; y < GRID - 1; y++)
    for (let x = 1; x < GRID - 1; x++) {
      const idx = y * GRID + x;
      if (g[idx] !== 1 || (x % 2 === 1 && y % 2 === 1)) continue;
      if (Math.random() < 0.22) g[idx] = 0;
    }
  for (let r = 0; r < 3; r++) {
    const w = 5 + 2 * Math.floor(Math.random() * 2);
    const h = 5 + 2 * Math.floor(Math.random() * 2);
    const x0 = 1 + 2 * Math.floor(Math.random() * ((GRID - 2 - w) / 2));
    const y0 = 1 + 2 * Math.floor(Math.random() * ((GRID - 2 - h) / 2));
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) if (x > 0 && y > 0 && x < GRID - 1 && y < GRID - 1) g[y * GRID + x] = 0;
  }
  // 柱子：只放在四邻皆通路的格上，并验证"封掉本格后其余格仍全部可达"，
  // 否则一个十字路口的中心格会把半张图变成永远拿不到的孤岛
  let reach = reachCount(g, start);
  for (let y = 2; y < GRID - 2; y++)
    for (let x = 2; x < GRID - 2; x++) {
      const idx = y * GRID + x;
      if (g[idx] !== 0) continue;
      if (DIRS4.some(([dx, dy]) => g[(y + dy) * GRID + (x + dx)] !== 0)) continue;
      if (Math.random() > 0.3) continue;
      g[idx] = 1;
      const after = reachCount(g, start);
      if (after === reach - 1) reach = after;
      else g[idx] = 0;
    }
  return g;
}

/** 在候选格里挑 n 个，尽量彼此分散（曼哈顿距离 ≥ minDist 优先） */
function pickSpread(cands: number[], n: number, minDist: number): number[] {
  const pool = [...cands].sort(() => Math.random() - 0.5);
  const picked: number[] = [];
  for (const idx of pool) {
    if (picked.length >= n) break;
    const x = idx % GRID;
    const y = (idx / GRID) | 0;
    if (picked.every((p) => Math.abs((p % GRID) - x) + Math.abs(((p / GRID) | 0) - y) >= minDist)) picked.push(idx);
  }
  for (const idx of pool) {
    if (picked.length >= n) break;
    if (!picked.includes(idx)) picked.push(idx);
  }
  return picked;
}

// ============ 世界 ============

interface Core {
  x: number;
  y: number;
  taken: boolean;
}

interface Statue {
  x: number;
  y: number;
  alive: boolean;
  /** 本帧是否被注视（决定动画，也决定它能不能移动） */
  frozen: boolean;
  /** >0 = 被光矛打瘫；再命中一次即碎裂 */
  stagger: number;
  stare: number;
  respawn: number;
  phase: number;
  speed: number;
  /** 石像自身朝向：冻结时定住，追人时转向玩家 */
  faceYaw: number;
}

interface World {
  grid: Uint8Array;
  /** 全部可达地板格（石像重生点候选） */
  cells: number[];
  floor: number;
  px: number;
  py: number;
  ang: number;
  pitch: number;
  lives: number;
  score: number;
  energy: number;
  cd: number;
  invuln: number;
  flash: number;
  shake: number;
  shotFx: number;
  hitFx: number;
  /** 本发光束的世界终点与衰减 */
  beamTo: Vec3 | null;
  beamFx: number;
  cores: Core[];
  coresTaken: number;
  portalX: number;
  portalY: number;
  open: boolean;
  statues: Statue[];
  collapses: number;
  chain: number;
  chainT: number;
  /** 以玩家所在格为源的 BFS 距离场：石像靠它绕过墙角 */
  flow: Int16Array;
  flowT: number;
  warnT: number;
  stepAcc: number;
  banner: string;
  bannerT: number;
}

function statueSpeed(floor: number): number {
  return Math.min(2.5, 1.4 + 0.12 * floor);
}

function makeWorld(floor: number, score: number, lives: number): World {
  const grid = genGrid();
  const startIdx = 1 * GRID + 1;
  const dist = bfs(grid, startIdx);
  const cells: number[] = [];
  for (let i = 0; i < dist.length; i++) if (dist[i] >= 0) cells.push(i);

  const coreTotal = Math.min(8, 4 + floor);
  const farCores = cells.filter((i) => dist[i] >= 6);
  const cores: Core[] = pickSpread(farCores.length >= coreTotal ? farCores : cells, coreTotal, 5).map((idx) => ({
    x: (idx % GRID) + 0.5,
    y: ((idx / GRID) | 0) + 0.5,
    taken: false,
  }));

  let portalIdx = startIdx;
  let bestD = -1;
  for (const i of cells)
    if (dist[i] > bestD) {
      bestD = dist[i];
      portalIdx = i;
    }

  // 开局石像要足够远：否则第一帧就贴脸，玩家根本无从判断它是不是在动
  const spawnPool = cells.filter((i) => dist[i] >= 8);
  const statueTotal = Math.min(7, 1 + floor);
  const cellOf = (idx: number) => ({ x: (idx % GRID) + 0.5, y: ((idx / GRID) | 0) + 0.5 });
  const statues: Statue[] = pickSpread(spawnPool.length >= statueTotal ? spawnPool : cells, statueTotal, 3).map((idx) => {
    const p = cellOf(idx);
    return {
      x: p.x,
      y: p.y,
      alive: true,
      frozen: false,
      stagger: 0,
      stare: 0,
      respawn: 0,
      phase: Math.random() * 6.28,
      speed: statueSpeed(floor),
      faceYaw: Math.atan2(1.5 - p.y, 1.5 - p.x),
    };
  });

  const face = DIRS4.find(([dx, dy]) => grid[(1 + dy) * GRID + (1 + dx)] === 0);

  return {
    grid,
    cells,
    floor,
    px: 1.5,
    py: 1.5,
    ang: face ? Math.atan2(face[1], face[0]) : 0,
    pitch: 0,
    lives,
    score,
    energy: ENERGY_MAX,
    cd: 0,
    invuln: 0,
    flash: 0,
    shake: 0,
    shotFx: 0,
    hitFx: 0,
    beamTo: null,
    beamFx: 0,
    cores,
    coresTaken: 0,
    portalX: cellOf(portalIdx).x,
    portalY: cellOf(portalIdx).y,
    open: false,
    statues,
    collapses: 0,
    chain: 0,
    chainT: 0,
    flow: dist,
    flowT: 0,
    warnT: 0,
    stepAcc: 0,
    banner: `第 ${floor} 层 · 盯住它们`,
    bannerT: 2.2,
  };
}

// ============ 规则 ============

/** 碎裂：返回本尊带来的得分（连锁倍率已乘进去） */
function collapseStatue(w: World, s: Statue, byStare: boolean): number {
  s.alive = false;
  s.stagger = 0;
  s.stare = 0;
  s.frozen = false;
  s.respawn = Math.max(RESPAWN_MIN, 8 - 0.4 * w.floor);
  w.collapses += 1;
  w.chain = w.chainT > 0 ? Math.min(CHAIN_MAX, w.chain + 1) : 1;
  w.chainT = CHAIN_WINDOW;
  const gain = (byStare ? SCORE_STARE : SCORE_SHOT) * w.chain;
  w.score += gain;
  sfx.drop();
  return gain;
}

function reviveStatue(w: World, s: Statue): void {
  let pool = w.cells.filter((i) => w.flow[i] >= 9);
  if (pool.length === 0) pool = w.cells.filter((i) => w.flow[i] >= 5);
  if (pool.length === 0) pool = w.cells;
  const idx = pool[Math.floor(Math.random() * pool.length)];
  s.x = (idx % GRID) + 0.5;
  s.y = ((idx / GRID) | 0) + 0.5;
  s.alive = true;
  s.stagger = 0;
  s.stare = 0;
  s.respawn = 0;
  s.speed = statueSpeed(w.floor);
  s.faceYaw = Math.atan2(w.py - s.y, w.px - s.x);
}

/** 看不见的石像沿距离场下坡推进；看得见直线路径时直接抄近道 */
function chaseStatue(w: World, s: Statue, dt: number): void {
  const g = w.grid;
  const cx = Math.floor(s.x);
  const cy = Math.floor(s.y);
  const here = w.flow[cy * GRID + cx];
  let tx = w.px;
  let ty = w.py;
  if (here >= 0 && !losClear(g, s.x, s.y, w.px, w.py)) {
    let bd = here;
    let bi = -1;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inRange(nx, ny)) continue;
      const idx = ny * GRID + nx;
      const fd = w.flow[idx];
      if (fd >= 0 && fd < bd) {
        bd = fd;
        bi = idx;
      }
    }
    if (bi >= 0) {
      tx = (bi % GRID) + 0.5;
      ty = ((bi / GRID) | 0) + 0.5;
    }
  }
  const dx = tx - s.x;
  const dy = ty - s.y;
  const len = Math.hypot(dx, dy) || 1;
  const step = s.speed * dt;
  slideMove(g, s, (dx / len) * step, (dy / len) * step, 0.3);
  // 朝向平滑转向玩家：转身看得见，比瞬移朝向更能提示"它盯上你了"
  const want = Math.atan2(w.py - s.y, w.px - s.x);
  let diff = want - s.faceYaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  s.faceYaw += Math.max(-4 * dt, Math.min(4 * dt, diff));
}

/** 光矛：一条从眼睛出发的射线，先撞墙就不算命中，取最近的一尊石像 */
function shoot(w: World): boolean {
  w.energy -= SHOT_COST;
  w.cd = SHOT_CD;
  w.shotFx = 0.1;
  w.beamFx = 1;
  const dirX = Math.cos(w.ang);
  const dirY = Math.sin(w.ang);
  // 到第一面墙的距离：逐步推进，够密就不会漏判
  let wallD = 20;
  for (let d = 0.2; d < 20; d += 0.12) {
    if (solid(w.grid, w.px + dirX * d, w.py + dirY * d)) {
      wallD = d;
      break;
    }
  }
  let hit: Statue | null = null;
  let hitD = Infinity;
  for (const s of w.statues) {
    if (!s.alive) continue;
    const rx = s.x - w.px;
    const ry = s.y - w.py;
    const along = rx * dirX + ry * dirY;
    if (along <= 0.15 || along > wallD || along >= hitD) continue;
    // 右向轴 = (-dirY, dirX)
    if (Math.abs(-rx * dirY + ry * dirX) <= BEAM_HALF) {
      hit = s;
      hitD = along;
    }
  }
  const endD = hit ? hitD : Math.min(wallD, 9);
  w.beamTo = [w.px + dirX * endD, w.py + dirY * endD, hit ? 0.72 : EYE];
  sfx.shoot();
  if (!hit) return false;
  w.energy = Math.min(ENERGY_MAX, w.energy + ENERGY_REFUND);
  w.hitFx = 0.22;
  sfx.hit();
  if (hit.stagger > 0) {
    collapseStatue(w, hit, false);
  } else {
    hit.stagger = STAGGER;
    hit.stare *= 0.4;
    slideMove(w.grid, hit, dirX * 0.9, dirY * 0.9, 0.3);
  }
  return true;
}

/** 被石像抓到：扣血 + 把它推开瘫一会儿，给玩家喘口气 */
function hurtPlayer(w: World, s: Statue): void {
  w.lives -= 1;
  w.invuln = 1.9;
  w.flash = 1;
  w.shake = 0.65;
  w.chain = 0;
  s.stagger = 1.8;
  s.stare = 0;
  const dx = s.x - w.px;
  const dy = s.y - w.py;
  const len = Math.hypot(dx, dy) || 1;
  slideMove(w.grid, s, (dx / len) * 1.4, (dy / len) * 1.4, 0.3);
  movePlayer(w, (-dx / len) * 0.35, (-dy / len) * 0.35);
  sfx.thud();
}

interface Step {
  threat: number;
  gain: number;
  chain: number;
}

/** 注视/移动判定；返回视线外最近逼远距离与本帧碎裂得分 */
function updateStatues(w: World, dt: number): Step {
  let threat = Infinity;
  let gain = 0;
  const dirX = Math.cos(w.ang);
  const dirY = Math.sin(w.ang);
  for (const s of w.statues) {
    if (!s.alive) {
      s.respawn -= dt;
      if (s.respawn <= 0) reviveStatue(w, s);
      continue;
    }
    if (s.stagger > 0) {
      s.stagger -= dt;
      s.frozen = true;
      s.stare = Math.max(0, s.stare - dt);
      continue;
    }
    const rx = s.x - w.px;
    const ry = s.y - w.py;
    const d = Math.hypot(rx, ry);
    const along = rx * dirX + ry * dirY;
    const perp = -rx * dirY + ry * dirX;
    // 画面半宽对应 |perp| = along * HALF_TAN，与投影用的同一个 FOCAL，所以"看得见"与"会冻结"严格一致
    const seen = along > 0.2 && Math.abs(perp) <= along * HALF_TAN * GAZE_MARGIN && d <= GAZE_RANGE && losClear(w.grid, w.px, w.py, s.x, s.y);
    if (seen) {
      s.frozen = true;
      // 只有走近了盯才会长裂纹：否则站着环视就能白刷分
      if (d <= STARE_RANGE) s.stare += dt;
      if (s.stare >= STARE_KILL) gain += collapseStatue(w, s, true);
    } else {
      s.frozen = false;
      s.stare = Math.max(0, s.stare - dt * 1.6);
      chaseStatue(w, s, dt);
      if (d < threat) threat = d;
    }
  }
  return { threat, gain, chain: w.chain };
}

// ============ 屏幕空间美术（HUD 用，与 3D 管线无关） ============

/** 光矛发射器：画面右下角的简易"枪模" */
function weaponSprite(): HTMLCanvasElement {
  const W = 118;
  const H = 74;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#2a2340';
  ctx.beginPath();
  ctx.moveTo(6, H);
  ctx.lineTo(40, 24);
  ctx.lineTo(74, 30);
  ctx.lineTo(96, H);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#3b3260';
  ctx.beginPath();
  ctx.moveTo(14, H);
  ctx.lineTo(44, 32);
  ctx.lineTo(70, 37);
  ctx.lineTo(88, H);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#6f5cff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(44, 30);
  ctx.lineTo(78, 12);
  ctx.stroke();
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = `rgba(90,235,255,${0.85 - i * 0.22})`;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.ellipse(78 + i * 11, 12 + i * 4, 9 - i * 1.6, 4.6 - i * 0.8, 0.35, 0, Math.PI * 2);
    ctx.stroke();
  }
  const mg = ctx.createRadialGradient(108, 20, 1, 108, 20, 12);
  mg.addColorStop(0, 'rgba(220,250,255,0.95)');
  mg.addColorStop(1, 'rgba(90,200,255,0)');
  ctx.fillStyle = mg;
  ctx.beginPath();
  ctx.arc(108, 20, 12, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function vignetteSprite(inner: string, outer: string): HTMLCanvasElement {
  const c = makeCanvas(RW, RH);
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(RW / 2, RH / 2, RH * 0.26, RW / 2, RH / 2, RH * 0.95);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, RW, RH);
  return c;
}

// ============ 主组件 ============

type Status = 'ready' | 'playing' | 'paused' | 'over';

interface Hud {
  floor: number;
  lives: number;
  cores: number;
  total: number;
  score: number;
}

export default function Gaze3D() {
  const [status, setStatus] = useState<Status>('ready');
  const [hud, setHud] = useState<Hud>({ floor: 1, lives: LIVES_MAX, cores: 0, total: 5, score: 0 });
  const best = useBestScore(metaGaze3D.id);
  const { toast } = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 懒初始化：useRef(makeWorld()) 的实参每次渲染都会求值，而回廊生成含十几次 BFS，
  // HUD 10Hz 刷新会白白重建整座迷宫
  const worldRef = useRef<World>(null as unknown as World);
  if (!worldRef.current) worldRef.current = makeWorld(1, 0, LIVES_MAX);
  const statusRef = useRef<Status>('ready');
  const keysRef = useRef({ fwd: false, back: false, strafeL: false, strafeR: false, turnL: false, turnR: false, run: false, fire: false });
  /** 触控左半屏虚拟摇杆（移动）；右半屏/鼠标拖拽转向，轻点开火 */
  const stickRef = useRef<{ id: number; ox: number; oy: number; dx: number; dy: number } | null>(null);
  const lookRef = useRef<{ id: number; lastX: number; lastY: number; x0: number; y0: number; t0: number; moved: boolean } | null>(null);
  const btnFireRef = useRef(false);
  const settledRef = useRef(false);

  statusRef.current = status;

  const syncHud = useCallback((w: World) => {
    setHud({ floor: w.floor, lives: w.lives, cores: w.coresTaken, total: w.cores.length, score: w.score });
  }, []);

  const start = useCallback(() => {
    worldRef.current = makeWorld(1, 0, LIVES_MAX);
    settledRef.current = false;
    keysRef.current = { fwd: false, back: false, strafeL: false, strafeR: false, turnL: false, turnR: false, run: false, fire: false };
    stickRef.current = null;
    lookRef.current = null;
    btnFireRef.current = false;
    syncHud(worldRef.current);
    setStatus('playing');
  }, [syncHud]);

  const fireOnce = useCallback(() => {
    const w = worldRef.current;
    if (statusRef.current === 'playing' && w.cd <= 0 && w.energy >= SHOT_COST) shoot(w);
  }, []);

  // ============ 键盘 ============

  useEffect(() => {
    const clearKeys = () => {
      keysRef.current = { fwd: false, back: false, strafeL: false, strafeR: false, turnL: false, turnR: false, run: false, fire: false };
      stickRef.current = null;
      lookRef.current = null;
      btnFireRef.current = false;
    };
    const down = (e: KeyboardEvent) => {
      const k = e.code;
      if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault();
      // Enter 落在已聚焦的按钮上会同时走热键与按钮 onClick（点过"重新开始"后按 Enter 会连开两局），交给按钮自身
      if (e.key === 'Enter' && (e.target as HTMLElement | null)?.closest('button')) return;
      const keys = keysRef.current;
      if (k === 'KeyW' || k === 'ArrowUp') keys.fwd = true;
      else if (k === 'KeyS' || k === 'ArrowDown') keys.back = true;
      else if (k === 'KeyA') keys.strafeL = true;
      else if (k === 'KeyD') keys.strafeR = true;
      else if (k === 'ArrowLeft' || k === 'KeyQ') keys.turnL = true;
      else if (k === 'ArrowRight' || k === 'KeyE') keys.turnR = true;
      else if (k === 'ShiftLeft' || k === 'ShiftRight') keys.run = true;
      else if (k === 'Space' || k === 'KeyF' || k === 'KeyJ') keys.fire = true;
      else if (k === 'KeyP' && !e.repeat) {
        const s = statusRef.current;
        if (s === 'playing') setStatus('paused');
        else if (s === 'paused') setStatus('playing');
      } else if (k === 'Enter' && !e.repeat) {
        const s = statusRef.current;
        if (s === 'ready' || s === 'over') start();
      }
    };
    const up = (e: KeyboardEvent) => {
      const keys = keysRef.current;
      const k = e.code;
      if (k === 'KeyW' || k === 'ArrowUp') keys.fwd = false;
      if (k === 'KeyS' || k === 'ArrowDown') keys.back = false;
      if (k === 'KeyA') keys.strafeL = false;
      if (k === 'KeyD') keys.strafeR = false;
      if (k === 'ArrowLeft' || k === 'KeyQ') keys.turnL = false;
      if (k === 'ArrowRight' || k === 'KeyE') keys.turnR = false;
      if (k === 'ShiftLeft' || k === 'ShiftRight') keys.run = false;
      if (k === 'Space' || k === 'KeyF' || k === 'KeyJ') keys.fire = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    // 失焦清键并暂停：否则"按住 W 切窗口"回来人一脚踏进石像堆
    const blur = () => {
      clearKeys();
      if (statusRef.current === 'playing') setStatus('paused');
    };
    // 移动端锁屏/切 App 只发 visibilitychange 不发 blur
    const onVis = () => {
      if (document.visibilityState === 'hidden') blur();
    };
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [start]);

  // ============ 指针（转向 / 俯仰 / 摇杆 / 点按开火） ============

  const toCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) * RW) / rect.width, y: ((e.clientY - rect.top) * RH) / rect.height };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (statusRef.current !== 'playing') return;
    const p = toCanvas(e);
    if (e.pointerType === 'touch' && p.x < RW * 0.42) {
      stickRef.current = { id: e.pointerId, ox: p.x, oy: p.y, dx: 0, dy: 0 };
    } else {
      lookRef.current = { id: e.pointerId, lastX: p.x, lastY: p.y, x0: p.x, y0: p.y, t0: performance.now(), moved: false };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // 非游玩态丢掉拖拽：暂停/结束后仍能转视角，恢复时会把跨暂停期的位移一次性累加上
    if (statusRef.current !== 'playing') {
      lookRef.current = null;
      return;
    }
    const stick = stickRef.current;
    if (stick && e.pointerId === stick.id) {
      const p = toCanvas(e);
      const dx = p.x - stick.ox;
      const dy = p.y - stick.oy;
      const len = Math.hypot(dx, dy);
      const R = 56;
      stick.dx = len > R ? (dx / len) * R : dx;
      stick.dy = len > R ? (dy / len) * R : dy;
      return;
    }
    const look = lookRef.current;
    if (look && e.pointerId === look.id) {
      const p = toCanvas(e);
      const dx = p.x - look.lastX;
      const dy = p.y - look.lastY;
      look.lastX = p.x;
      look.lastY = p.y;
      if (Math.hypot(p.x - look.x0, p.y - look.y0) > 9) look.moved = true;
      const w = worldRef.current;
      // 拖过整幅画布 ≈ 转 130°（dx 已是内部像素，须按渲染宽度折算，与 CSS 宽度无关）
      w.ang += (dx / RW) * 2.3;
      w.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, w.pitch - dy * 0.5));
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const look = lookRef.current;
    if (look && e.pointerId === look.id) {
      // 没拖动且时间短 = 轻点 = 单发；长按已由帧循环按持续射击处理
      if (!look.moved && performance.now() - look.t0 < 240) fireOnce();
      lookRef.current = null;
    }
    if (stickRef.current?.id === e.pointerId) stickRef.current = null;
  };

  // ============ 帧循环 ============

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = RW;
    canvas.height = RH;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    const weapon = weaponSprite();
    const vignette = vignetteSprite('rgba(0,0,0,0)', 'rgba(2,3,10,0.82)');
    const danger = vignetteSprite('rgba(0,0,0,0)', 'rgba(150,10,30,0.9)');
    const faces: Face[] = [];
    const list: Prepared[] = [];
    const sc: Scratch = { src: new Float64Array(24), dst: new Float64Array(24), pool: new Float64Array(24 * 1400) };
    const cam: Cam = { x: 1.5, y: 1.5, yaw: 0, pitch: 0, eye: EYE };

    let raf = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const rawDt = (now - last) / 1000;
      // 步长钳制：切后台回来的病态长帧不能一次跑完（石像 2.5 单位/秒 × 0.05 秒远小于判定窗）
      const dt = Math.min(0.05, rawDt);
      last = now;
      const w = worldRef.current;
      const playing = statusRef.current === 'playing';
      const t = now / 1000;

      // ---- 更新 ----
      if (playing) {
        const keys = keysRef.current;
        w.ang += ((keys.turnL ? -1 : 0) + (keys.turnR ? 1 : 0)) * TURN_SPEED * dt;

        let mf = (keys.fwd ? 1 : 0) - (keys.back ? 1 : 0);
        let ms = (keys.strafeR ? 1 : 0) - (keys.strafeL ? 1 : 0);
        const stick = stickRef.current;
        if (stick && Math.hypot(stick.dx, stick.dy) / 56 > 0.14) {
          mf += -stick.dy / 56; // 上推 = 前进
          ms += stick.dx / 56;
        }
        mf = Math.max(-1, Math.min(1, mf));
        ms = Math.max(-1, Math.min(1, ms));
        const mag = Math.hypot(mf, ms);
        const norm = mag > 1 ? 1 / mag : 1;
        if (mag > 0.01) {
          const cos = Math.cos(w.ang);
          const sin = Math.sin(w.ang);
          const sp = SPEED * (keys.run ? SPRINT_K : 1) * norm;
          // 前向 = (cos,sin)，右向 = (-sin,cos)
          w.stepAcc += movePlayer(w, (cos * mf - sin * ms) * sp * dt, (sin * mf + cos * ms) * sp * dt);
          if (w.stepAcc > (keys.run ? 1.15 : 0.85)) {
            w.stepAcc = 0;
            sfx.move();
          }
        }

        // 距离场跟着玩家重算（0.22s 一次足够：石像只能借它挪一两格）
        w.flowT -= dt;
        if (w.flowT <= 0) {
          w.flowT = 0.22;
          w.flow = bfs(w.grid, Math.floor(w.py) * GRID + Math.floor(w.px));
        }

        w.cd = Math.max(0, w.cd - dt);
        w.energy = Math.min(ENERGY_MAX, w.energy + ENERGY_REGEN * dt);
        w.invuln = Math.max(0, w.invuln - dt);
        w.flash = Math.max(0, w.flash - dt * 2.2);
        w.shake = Math.max(0, w.shake - dt * 2.6);
        w.shotFx = Math.max(0, w.shotFx - dt);
        w.hitFx = Math.max(0, w.hitFx - dt);
        w.beamFx = Math.max(0, w.beamFx - dt * 3.2);
        w.bannerT = Math.max(0, w.bannerT - dt);
        if (w.chainT > 0) {
          w.chainT -= dt;
          if (w.chainT <= 0) w.chain = 0;
        }

        if ((keys.fire || btnFireRef.current) && w.cd <= 0 && w.energy >= SHOT_COST) shoot(w);

        const step = updateStatues(w, dt);
        if (step.gain > 0) {
          toast(step.chain > 1 ? `🗿 连锁碎裂 ×${step.chain}！+${step.gain}` : `🗿 石像碎裂 +${step.gain}`, 'info');
        }
        w.warnT -= dt;
        // 只在真的有人贴过来时才提示，否则每 1.6 秒一条 toast 会把屏幕糊满
        if (step.threat < 2.8 && w.warnT <= 0) {
          w.warnT = 5;
          sfx.thud();
          toast('⚠️ 石像已到身后，转身！', 'info');
        }

        for (const s of w.statues) {
          if (!s.alive || s.stagger > 0 || w.invuln > 0) continue;
          if (Math.hypot(s.x - w.px, s.y - w.py) < CONTACT) hurtPlayer(w, s);
        }

        for (const c of w.cores) {
          if (c.taken || Math.hypot(c.x - w.px, c.y - w.py) > 0.6) continue;
          c.taken = true;
          w.coresTaken += 1;
          w.score += SCORE_CORE;
          w.energy = Math.min(ENERGY_MAX, w.energy + 18);
          if (w.coresTaken >= w.cores.length) {
            w.open = true;
            sfx.clear();
            toast('🌌 星门已开启！去离入口最远那格', 'success');
          } else {
            sfx.match();
            toast(`✦ 光核 ${w.coresTaken}/${w.cores.length} +${SCORE_CORE}`, 'info');
          }
        }

        if (w.open && Math.hypot(w.portalX - w.px, w.portalY - w.py) < 0.66) {
          const bonus = SCORE_FLOOR * w.floor;
          const nxt = makeWorld(w.floor + 1, w.score + bonus, Math.min(LIVES_MAX, w.lives + 1));
          worldRef.current = nxt;
          sfx.win();
          toast(`🌌 进入第 ${nxt.floor} 层 +${bonus} 分（回复 1 点生命）`, 'success');
          syncHud(nxt);
        } else if (w.lives <= 0) {
          // 立即同步 statusRef：重渲染完成前的帧不再重复结算、重复扣分
          statusRef.current = 'over';
          syncHud(w);
          setStatus('over');
        }
      }

      // ---- 渲染 ----
      cam.x = w.px;
      cam.y = w.py;
      cam.yaw = w.ang;
      cam.pitch = w.pitch;

      const horizon = RH / 2 + cam.pitch;
      ctx.save();
      if (w.shake > 0.01) ctx.translate((Math.random() - 0.5) * 11 * w.shake, (Math.random() - 0.5) * 8 * w.shake);
      // 天空/屋顶与地面底色：以地平线为界，俯仰时一起移动
      const up = ctx.createLinearGradient(0, Math.min(0, horizon - RH), 0, Math.max(0, horizon));
      up.addColorStop(0, '#04050c');
      up.addColorStop(1, '#191533');
      ctx.fillStyle = up;
      ctx.fillRect(-12, -12, RW + 24, horizon + 12);
      const dn = ctx.createLinearGradient(0, Math.min(RH, horizon), 0, Math.max(RH, horizon + RH));
      dn.addColorStop(0, '#241f31');
      dn.addColorStop(1, '#090710');
      ctx.fillStyle = dn;
      ctx.fillRect(-12, horizon, RW + 24, RH - horizon + 12);

      faces.length = 0;
      emitRoom(faces, w, cam);
      for (const s of w.statues) {
        if (s.alive) emitStatue(faces, s, cam, t);
        else emitRubble(faces, s);
      }
      for (const c of w.cores) {
        if (c.taken) continue;
        const spin = t * 1.9 + c.x;
        const r = 0.17;
        const cz = 0.62 + Math.sin(t * 2.4 + c.x * 3) * 0.05;
        const ring: Vec3[] = [];
        for (let i = 0; i < 4; i++) {
          const a = spin + (i / 4) * Math.PI * 2;
          ring.push([c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, cz]);
        }
        const top: Vec3 = [c.x, c.y, cz + 0.24];
        const bot: Vec3 = [c.x, c.y, cz - 0.24];
        for (let i = 0; i < 4; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % 4];
          pushTri(faces, a, b, top, [255, 214, 120], true);
          pushTri(faces, b, a, bot, [236, 168, 60], true);
        }
      }
      emitPortal(faces, w.portalX, w.portalY, w.open, t);
      renderScene(ctx, cam, faces, list, sc);

      // 光矛光束：世界两点投影成屏幕线段
      if (w.beamFx > 0 && w.beamTo) {
        const muzzle = project(cam, [w.px + Math.cos(w.ang) * 0.4, w.py + Math.sin(w.ang) * 0.4, 0.42]);
        const end = project(cam, w.beamTo);
        if (muzzle && end) {
          const a = w.beamFx;
          ctx.strokeStyle = `rgba(150,240,255,${0.25 * a})`;
          ctx.lineWidth = 7;
          ctx.beginPath();
          ctx.moveTo(RW - 10, RH - 52);
          ctx.lineTo(muzzle.x, muzzle.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
          ctx.strokeStyle = `rgba(238,252,255,${0.9 * a})`;
          ctx.lineWidth = 1.6;
          ctx.stroke();
          const fl = ctx.createRadialGradient(end.x, end.y, 1, end.x, end.y, 15 * a + 3);
          fl.addColorStop(0, `rgba(220,250,255,${0.85 * a})`);
          fl.addColorStop(1, 'rgba(120,200,255,0)');
          ctx.fillStyle = fl;
          ctx.beginPath();
          ctx.arc(end.x, end.y, 15 * a + 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 凝视进度：把石像头顶投影到屏幕上画一条
      for (const s of w.statues) {
        if (!s.alive || s.stare <= 0.25 || s.stagger > 0) continue;
        const p = project(cam, [s.x, s.y, 1.06]);
        if (!p) continue;
        const bw = Math.max(16, (FOCAL / p.z) * 0.5);
        const ratio = Math.min(1, s.stare / STARE_KILL);
        ctx.fillStyle = 'rgba(6,8,18,0.72)';
        ctx.fillRect(p.x - bw / 2 - 1, p.y - 4, bw + 2, 6);
        ctx.fillStyle = ratio > 0.75 ? '#ffe37a' : '#7ee8ff';
        ctx.fillRect(p.x - bw / 2, p.y - 3, bw * ratio, 4);
      }
      ctx.restore();

      // ---- HUD（不随震动偏移，避免准星/雷达乱跳） ----
      if (statusRef.current !== 'ready') {
        const rec = w.shotFx > 0 ? w.shotFx / 0.1 : 0;
        ctx.drawImage(weapon, RW - 116, RH - 70 + rec * 7);

        const dirX = Math.cos(w.ang);
        const dirY = Math.sin(w.ang);
        const aimHot = w.statues.some((s) => {
          if (!s.alive) return false;
          const rx = s.x - w.px;
          const ry = s.y - w.py;
          const along = rx * dirX + ry * dirY;
          return along > 0.15 && Math.abs(-rx * dirY + ry * dirX) <= BEAM_HALF;
        });
        const gap = 5 + rec * 9;
        ctx.strokeStyle = w.hitFx > 0 ? '#ffd166' : aimHot ? '#ff6b81' : 'rgba(200,240,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (const [ax, ay] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as Array<[number, number]>) {
          ctx.moveTo(RW / 2 + ax * gap, RH / 2 + ay * gap);
          ctx.lineTo(RW / 2 + ax * (gap + 7), RH / 2 + ay * (gap + 7));
        }
        ctx.stroke();
        ctx.fillStyle = aimHot ? 'rgba(255,107,129,0.9)' : 'rgba(200,240,255,0.5)';
        ctx.fillRect(RW / 2 - 1, RH / 2 - 1, 2, 2);
        if (w.hitFx > 0) {
          ctx.strokeStyle = `rgba(255,225,140,${Math.min(1, w.hitFx * 4)})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (const [sx, sy] of [
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
          ] as Array<[number, number]>) {
            ctx.moveTo(RW / 2 + sx * 4, RH / 2 + sy * 4);
            ctx.lineTo(RW / 2 + sx * 10, RH / 2 + sy * 10);
          }
          ctx.stroke();
        }

        // 能量条
        const bx = 14;
        const by = RH - 22;
        ctx.fillStyle = 'rgba(6,8,18,0.66)';
        ctx.fillRect(bx - 1, by - 1, 132, 12);
        ctx.fillStyle = w.energy >= SHOT_COST ? '#7ee8ff' : '#5a6a8a';
        ctx.fillRect(bx, by, 130 * (w.energy / ENERGY_MAX), 10);
        ctx.fillStyle = 'rgba(4,6,14,0.55)';
        for (let i = 1; i < 4; i++) ctx.fillRect(bx + (130 * i) / 4, by, 1, 10);
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx - 1.5, by - 1.5, 133, 13);
        ctx.fillStyle = 'rgba(220,235,255,0.75)';
        ctx.font = '9px "Segoe UI", sans-serif';
        ctx.fillText('光矛能量', bx, by - 4);

        // 逼近雷达（右上角，与枪模错开）：红=视线外逼近，青=被你盯住，黄=打瘫中
        const rcx = RW - 48;
        const rcy = 48;
        const rr = 34;
        ctx.fillStyle = 'rgba(8,10,20,0.6)';
        ctx.beginPath();
        ctx.arc(rcx, rcy, rr, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.stroke();
        const cos = Math.cos(w.ang);
        const sin = Math.sin(w.ang);
        ctx.fillStyle = 'rgba(126,232,255,0.16)';
        ctx.beginPath();
        ctx.moveTo(rcx, rcy);
        ctx.arc(rcx, rcy, rr, -Math.PI / 2 - 0.62, -Math.PI / 2 + 0.62);
        ctx.closePath();
        ctx.fill();
        const plot = (x: number, y: number, r: number, color: string) => {
          const dx = x - w.px;
          const dy = y - w.py;
          const ru = -sin * dx + cos * dy;
          const fv = cos * dx + sin * dy;
          const dd = Math.hypot(dx, dy);
          const k = Math.min(1, dd / 11);
          const len = Math.hypot(ru, fv) || 1;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(rcx + (ru / len) * k * rr, rcy - (fv / len) * k * rr, r, 0, Math.PI * 2);
          ctx.fill();
        };
        for (const c of w.cores) if (!c.taken) plot(c.x, c.y, 2.2, '#ffd75e');
        if (w.open) plot(w.portalX, w.portalY, 3.2, '#3ef0a2');
        for (const s of w.statues) {
          if (!s.alive) continue;
          plot(s.x, s.y, 3.4, s.stagger > 0 ? '#ffe37a' : s.frozen ? '#7ee8ff' : '#ff4d63');
        }

        if (w.bannerT > 0) {
          ctx.globalAlpha = Math.min(1, w.bannerT * 1.4);
          ctx.fillStyle = 'rgba(230,240,255,0.92)';
          ctx.font = 'bold 17px "Segoe UI", "Microsoft YaHei", sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(w.banner, RW / 2, RH * 0.28);
          ctx.textAlign = 'left';
          ctx.globalAlpha = 1;
        }

        ctx.drawImage(vignette, 0, 0);
        if (w.lives === 1 && playing) {
          ctx.globalAlpha = 0.16 + 0.1 * Math.sin(t * 4.5);
          ctx.drawImage(danger, 0, 0);
          ctx.globalAlpha = 1;
        }
        if (w.flash > 0) {
          ctx.fillStyle = `rgba(190,20,40,${w.flash * 0.34})`;
          ctx.fillRect(0, 0, RW, RH);
        }
        if (w.invuln > 0 && playing) {
          ctx.strokeStyle = `rgba(126,232,255,${0.25 + 0.25 * Math.sin(t * 12)})`;
          ctx.lineWidth = 3;
          ctx.strokeRect(2, 2, RW - 4, RH - 4);
        }
        const stick = stickRef.current;
        if (stick) {
          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(stick.ox, stick.oy, 56, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.45)';
          ctx.beginPath();
          ctx.arc(stick.ox + stick.dx, stick.oy + stick.dy, 18, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============ HUD 刷新（10Hz，避免每帧 setState） ============

  useEffect(() => {
    if (status !== 'playing') return;
    const timer = window.setInterval(() => syncHud(worldRef.current), 100);
    return () => window.clearInterval(timer);
  }, [status, syncHud]);

  // ============ 结算 ============

  useEffect(() => {
    if (status !== 'over') return;
    if (settledRef.current) return;
    settledRef.current = true;
    const score = worldRef.current.score;
    if (best.updateBest(score, (a, b) => a > b)) {
      sfx.record();
      toast(`🏆 新纪录！${score} 分`, 'record');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <GameShell
      meta={metaGaze3D}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>生命</span>
            <strong className="g3d-lives">{'♥'.repeat(Math.max(0, hud.lives)) || '—'}</strong>
          </div>
          <div className="stat-box">
            <span>光核</span>
            <strong>
              {hud.cores}/{hud.total}
            </strong>
          </div>
          <div className="stat-box">
            <span>层数</span>
            <strong>{hud.floor}</strong>
          </div>
          <div className="stat-box">
            <span>分数</span>
            <strong>{hud.score}</strong>
          </div>
          <div className="stat-box">
            <span>{metaGaze3D.bestScoreLabel}</span>
            <strong>{best.value ?? '—'}</strong>
          </div>
        </>
      }
    >
      <div className="g3d">
        <div className="g3d-stage">
          <canvas
            ref={canvasRef}
            className="g3d-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {status === 'ready' && (
            <div className="g3d-overlay">
              <h2>🗿 3D 凝视回廊</h2>
              <p>
                被你的视线锁定的石像不会动
                <br />
                一旦移开目光、或它们绕到墙后，就会直冲过来
                <br />
                收集全部光核打开星门，逐层深入
              </p>
              <p className="g3d-keys">
                W/S 前进后退 · A/D 侧移 · ←/→ 转向 · Shift 疾跑 · 空格/点击 光矛 · P 暂停
                <br />
                光矛两发碎裂；<b>走近了死盯</b>也能让它裂开，但别的石像会趁虚而入
              </p>
              <p className="g3d-keys">📱 左半屏拖动 = 移动摇杆 · 右半屏拖动 = 转向/俯仰 · 右半屏轻点 = 开火</p>
              <button className="btn btn-primary" onClick={start}>
                进入回廊
              </button>
            </div>
          )}
          {status === 'paused' && (
            <div className="g3d-overlay">
              <h2>⏸ 已暂停</h2>
              <p>石像也停下了——它们在等你看别处</p>
              <button className="btn btn-primary" onClick={() => setStatus('playing')}>
                继续
              </button>
            </div>
          )}
          {status === 'over' && (
            <div className="g3d-overlay">
              <h2>🗿 被石像拖回了基座</h2>
              <p>
                第 {hud.floor} 层 · {hud.score} 分 · 碎裂 {worldRef.current.collapses} 尊
                {best.value != null && ` · 最佳 ${best.value}`}
              </p>
              <button className="btn btn-primary" onClick={start}>
                再来一次
              </button>
            </div>
          )}
        </div>
        <div className="g3d-actions">
          <button
            className="btn btn-ghost"
            onClick={() => setStatus((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s))}
          >
            {status === 'paused' ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button
            className="btn btn-ghost"
            onPointerDown={(e) => {
              e.preventDefault();
              btnFireRef.current = true;
            }}
            onPointerUp={() => {
              btnFireRef.current = false;
            }}
            onPointerCancel={() => {
              btnFireRef.current = false;
            }}
            onPointerLeave={() => {
              btnFireRef.current = false;
            }}
          >
            ✦ 光矛
          </button>
          <button className="btn btn-ghost" onClick={start}>
            🎲 换一座回廊
          </button>
        </div>
        <p className="hint">
          右上角雷达：红点 = 视线外正在逼近的石像，青点 = 被你盯住的石像 · 星门开在离入口最远处那格
        </p>
      </div>
    </GameShell>
  );
}
