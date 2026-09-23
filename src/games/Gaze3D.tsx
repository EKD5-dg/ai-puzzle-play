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
/**
 * 内部渲染分辨率。桌面用 640×400（软 3D 的填充量随像素数线性涨），
 * 触屏设备退回 480×300：那边 GPU 更弱、面板也更小，看不出这 1.78 倍的细节差。
 * 两者同为 8:5，画布 CSS 与所有投影常量都按 RW 折算，不需要分支。
 */
const HIRES = typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches;
const RW = HIRES ? 640 : 480;
const RH = HIRES ? 400 : 300;
/** 屏幕控件与字号随内部分辨率等比放大（下面按 480 宽的基准写） */
const UIS = RW / 480;
/** 虚拟摇杆最大行程 */
const STICK_R = 56 * UIS;
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

/** 厅高与视点高度（世界单位 = 格）：通道加宽到 2 格后一并拔高，避免变成低矮地道 */
const WALL_H = 1.72;
const EYE = 0.8;
/** 焦距（内部像素）：FOCAL = RW/2 / tan(半视场角)，0.66·RW ≈ 74°，宽通道要配宽视野 */
const FOCAL = RW * 0.66;
/** 画面半宽对应的 tan(半视场角)：判定"石像是否落在画面里"与投影严格同源 */
const HALF_TAN = RW / (2 * FOCAL);
/** 近平面：小于该深度的顶点先裁剪 */
const NEAR = 0.12;
/** 几何剔除半径：超出即完全融进雾里，不必投影（2 格宽通道可见面更多，这里收紧一点换帧率） */
const CULL_R = 13;
const FOG_START = 3;
const FOG_END = 15;
/** 雾色（与远处天花板同调，墙面消隐时不露边） */
const FOGC: RGB = [7, 10, 20];
/** 边缘光颜色：冷青，专门用来把实体轮廓从墙面里"描"出来 */
const RIMC: RGB = [96, 190, 236];
const PITCH_MAX = 70 * UIS;

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
  /** 第一人称视图模型：改用固定的机位打光，不参与雾（否则手里的枪会随距离忽明忽暗） */
  vm?: boolean;
  /** 自定义轮廓描边（石像用近黑硬边把自己切出来） */
  edge?: string;
  edgeW?: number;
  /** 掠射边缘光强度：实体专属，墙面不给，所以敌人永远不会像墙 */
  rim?: number;
  /** 排序深度偏移（负=当作更近，后画）：贴在表面的发光贴片靠它保证不被本体吞掉 */
  bias?: number;
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
 * 锥形柱（圆柱/圆锥台/棱锥）：以 a→b 为轴、两端各一个正多边形截面。
 * 有了它才谈得上"非轴对齐几何"——长袍、手臂、尖兜帽都是斜的、收口的，
 * 剪影因此和轴对齐的墙面彻底分开（只用方块拼的敌人无论怎么配色都像墙）。
 */
function pushLimb(faces: Face[], a: Vec3, b: Vec3, rA: number, rB: number, sides: number, col: RGB, cap?: RGB): void {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const L = Math.hypot(dx, dy, dz) || 1;
  const ax = dx / L;
  const ay = dy / L;
  const az = dz / L;
  // 截面基：取轴与参考向量的正交组（轴接近竖直时参考取 x，避免退化）
  const rx = Math.abs(az) > 0.9 ? 1 : 0;
  const ry = 0;
  const rz = Math.abs(az) > 0.9 ? 0 : 1;
  let ux = ay * rz - az * ry;
  let uy = az * rx - ax * rz;
  let uz = ax * ry - ay * rx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  // v = axis × u，必须是标准叉乘：先前写成分量配错的版本，竖直轴会算出 (0,0,0)，
  // 截面退化成一条线，长袍与双臂因此被画成纸片
  const vx = ay * uz - az * uy;
  const vy = az * ux - ax * uz;
  const vz = ax * uy - ay * ux;
  const ring = (t: number, out: Vec3[]): void => {
    const cx = a[0] + dx * t;
    const cy = a[1] + dy * t;
    const cz = a[2] + dz * t;
    const r = rA + (rB - rA) * t;
    for (let i = 0; i < sides; i++) {
      const th = (i / sides) * Math.PI * 2;
      const co = Math.cos(th) * r;
      const si = Math.sin(th) * r;
      out.push([cx + ux * co + vx * si, cy + uy * co + vy * si, cz + uz * co + vz * si]);
    }
  };
  const top: Vec3[] = [];
  const bot: Vec3[] = [];
  ring(0, bot);
  ring(1, top);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const p = bot[i];
    const q = bot[j];
    const r = top[j];
    const s = top[i];
    // 外法线 = 侧向半径方向；绕序不确定，按点积翻回来
    const mx = (p[0] + q[0] + r[0] + s[0]) / 4 - (a[0] + b[0]) / 2;
    const my = (p[1] + q[1] + r[1] + s[1]) / 4 - (a[1] + b[1]) / 2;
    const mz = (p[2] + q[2] + r[2] + s[2]) / 4 - (a[2] + b[2]) / 2;
    const n = faceNormal(p, q, s);
    if (n[0] * mx + n[1] * my + n[2] * mz < 0) pushQuad(faces, p, s, r, q, col);
    else pushQuad(faces, p, q, r, s, col);
  }
  const cc: Vec3 = [b[0], b[1], b[2]];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const n = faceNormal(cc, top[i], top[j]);
    if (n[0] * ax + n[1] * ay + n[2] * az < 0) pushTri(faces, cc, top[j], top[i], cap ?? col);
    else pushTri(faces, cc, top[i], top[j], cap ?? col);
  }
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
  const lam = Math.max(0, (f.n[0] * vx + f.n[1] * vy + f.n[2] * vz) / dist);
  if (f.glow) {
    const k = 1 - fog * 0.75;
    return `rgb(${Math.round(f.col[0] * k)},${Math.round(f.col[1] * k)},${Math.round(f.col[2] * k)})`;
  }
  let lit: number;
  if (f.vm) {
    // 机位固定三点光：顶光塑形 + 左侧冷光勾边，手里的东西不该随照向哪里而变暗
    const rx = -Math.sin(cam.yaw);
    const ry = Math.cos(cam.yaw);
    const fx = Math.cos(cam.yaw);
    const fy = Math.sin(cam.yaw);
    const nR = f.n[0] * rx + f.n[1] * ry;
    const nF = f.n[0] * fx + f.n[1] * fy;
    const key = Math.max(0, f.n[2] * 0.9 + nF * 0.35);
    const rim = Math.max(0, -nR * 0.55 + nF * 0.45);
    lit = Math.min(1.3, 0.26 + key * 0.92 + rim * 0.42);
  } else {
    const torch = lam / (1 + dist * 0.34);
    const up = Math.max(0, f.n[2]) * 0.22;
    // 上限 1.15：近处墙面不钳制会直接烧成白块
    lit = Math.min(1.15, Math.max(0.08, 0.38 + torch * 1.0 + up));
  }
  // 暖光冷雾：光照分量偏暖、雾与环境偏冷，画面立刻有层次
  const rimAdd = f.rim ? f.rim * Math.pow(1 - lam, 3) : 0;
  const r = (f.col[0] * lit * 1.07 + RIMC[0] * rimAdd) * (1 - fog) + FOGC[0] * fog;
  const g = (f.col[1] * lit + RIMC[1] * rimAdd) * (1 - fog) + FOGC[1] * fog;
  const b = (f.col[2] * lit * 0.92 + RIMC[2] * rimAdd) * (1 - fog) + FOGC[2] * fog;
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
    list.push({ f, depth: depth / m + (f.bias ?? 0), n: m, off: used });
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
      const at = (u: number, h: number): [number, number] => {
        const bx = P[off] + (P[off + 3] - P[off]) * u;
        const by = P[off + 1] + (P[off + 4] - P[off + 1]) * u;
        const bz = P[off + 2] + (P[off + 5] - P[off + 2]) * u;
        const tx = P[off + 9] + (P[off + 6] - P[off + 9]) * u;
        const ty = P[off + 10] + (P[off + 7] - P[off + 10]) * u;
        const tz = P[off + 11] + (P[off + 8] - P[off + 11]) * u;
        const x = bx + (tx - bx) * h;
        const y = by + (ty - by) * h;
        const z = bz + (tz - bz) * h;
        return [RW / 2 + (x * FOCAL) / z, RH / 2 + cam.pitch - (y * FOCAL) / z];
      };
      ctx.beginPath();
      for (const h of f.seams) {
        const a = at(0, h);
        const b = at(1, h);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      // 竖向砌缝：逐层错开（错缝砌法），一面墙就能读出砖块而不是横条纹
      const bounds = [0, ...f.seams, 1];
      for (let i = 0; i + 1 < bounds.length; i++) {
        const u = i % 2 === 0 ? 0.72 : 0.24;
        const a = at(u, bounds[i]);
        const b = at(u, bounds[i + 1]);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
    }
    if (!f.glow && n <= 4) {
      ctx.strokeStyle = f.edge ?? 'rgba(0,0,0,0.28)';
      ctx.lineWidth = f.edgeW ?? 1;
      ctx.stroke();
    }
  }
}

// ============ 场景几何 ============

/**
 * 按功能分色，而不是按"好看"配色：
 * 墙=低明度冷板岩蓝/灰紫（两种同明度不同色相，退成背景）；
 * 地=墨绿青（与墙换色相族，地面不再像"倒过来的墙"）；
 * 石像=骨白（明度直接盖过一切环境，一眼扫到就是活物），追人时转血色。
 */
const MARBLE: RGB = [98, 110, 146];
const MARBLE_WARM: RGB = [116, 100, 134];
const FLOOR_A: RGB = [48, 78, 80];
const FLOOR_B: RGB = [34, 58, 64];
const STONE: RGB = [206, 197, 174];
const STONE_HI: RGB = [238, 230, 208];
const STONE_DARK: RGB = [146, 139, 124];
const CREEP: RGB = [216, 148, 136];
const CREEP_HI: RGB = [246, 190, 172];
const CREEP_DARK: RGB = [152, 88, 84];

/** 墙体：从地板格向外看，邻格是墙就贴一面立起的四边形（有厚度感、可带砌缝） */
function emitRoom(faces: Face[], w: World, cam: Cam): void {
  const g = w.grid;
  const fx = Math.cos(cam.yaw);
  const fy = Math.sin(cam.yaw);
  // 接触阴影：直接压暗实体脚下的地砖。画成地面上的贴片会在画家算法里和
  // 它所属的砖块争绘制顺序，压砖色则永远正确
  const pool: Array<{ x: number; y: number; r: number }> = [];
  for (const s of w.statues) pool.push({ x: s.x, y: s.y, r: s.alive ? 1.4 : 1.05 });
  for (const c of w.cores) if (!c.taken) pool.push({ x: c.x, y: c.y, r: 0.8 });
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
      let occ = 0;
      for (const o of pool) {
        const v = 1 - Math.hypot(mx - o.x, my - o.y) / o.r;
        if (v > occ) occ = v;
      }
      const tint = (0.9 + (((cx * 5 + cy * 11) % 4) * 0.05)) * (1 - 0.55 * occ);
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

/**
 * 石像：八边锥柱拼出的长袍人形——收口长袍 + 披肩 + 八角头 + 尖兜帽 + 斜垂双臂 + 双眼 + 胸口符。
 * 关键是别用轴对齐方块：方块和墙是同一套几何语言，配色再不同也会被读成"一块墙"。
 */
function emitStatue(faces: Face[], s: Statue, cam: Cam, t: number): void {
  const dx = cam.x - s.x;
  const dy = cam.y - s.y;
  if (Math.hypot(dx, dy) > CULL_R) return;
  const from = faces.length;
  const yaw = s.faceYaw;
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  /** 石像局部坐标：lat 沿左侧轴、fwd 沿朝向轴（调用处一律"横在前、纵在后"） */
  const off = (lat: number, fwd: number): [number, number] => [s.x + fwd * c - lat * sn, s.y + fwd * sn + lat * c];
  const P = (lat: number, fwd: number, h: number): Vec3 => {
    const [x, y] = off(lat, fwd);
    return [x, y, h];
  };
  const moving = !s.frozen && s.stagger <= 0;
  const body = moving ? CREEP : STONE;
  const hi = moving ? CREEP_HI : STONE_HI;
  const dark = moving ? CREEP_DARK : STONE_DARK;
  const bob = moving ? Math.sin(t * 9 + s.phase) * 0.018 : 0;
  const lean = moving ? 0.07 : 0;
  // 袍面半径按两段收口分别插值：贴片（胸口符、裂纹）要贴到实际锥面上
  const robeR = (h: number): number => {
    if (h <= 0.56) return 0.33 - 0.11 * Math.min(1, Math.max(0, (h - 0.1) / 0.46));
    return 0.22 - 0.095 * Math.min(1, Math.max(0, (h - 0.56) / 0.42));
  };
  pushLimb(faces, P(0, 0, 0.02), P(0, 0, 0.1 + bob), 0.28, 0.25, 8, dark, tint(dark, 1.4)); // 基座
  // 长袍分两段（下摆→膝→肩）：一整段平滑锥没有腰胯，剪影会读成标枪而不是袍子
  pushLimb(faces, P(0, 0, 0.1 + bob), P(0, lean * 0.4, 0.56 + bob), 0.33, 0.22, 8, tint(body, 0.94), tint(body, 1.2));
  pushLimb(faces, P(0, lean * 0.4, 0.56 + bob), P(0, lean, 0.98 + bob), 0.22, 0.125, 8, body, tint(body, 1.35));
  pushLimb(faces, P(0, lean, 1.0 + bob), P(0, lean * 1.3, 1.1 + bob), 0.2, 0.125, 8, tint(body, 0.92), hi); // 披肩
  pushLimb(faces, P(0, 0.02 + lean * 1.4, 1.12 + bob), P(0, 0.02 + lean * 1.6, 1.3 + bob), 0.095, 0.078, 8, hi); // 头
  pushLimb(faces, P(0, 0.015 + lean * 1.5, 1.27 + bob), P(0, -0.015 + lean * 1.2, 1.42 + bob), 0.106, 0.022, 8, dark); // 兜帽
  for (const side of [-1, 1]) {
    // 手臂：冻结时贴着体侧下垂，扑过来时整条抬到身前（0.235 在袍身之外，否则会被袍子吞掉）
    const base = P(side * 0.2, lean * 0.6, 1.02 + bob);
    const tip = moving ? P(side * 0.13, 0.33, 0.92 + bob) : P(side * 0.235, 0.02 + lean, 0.56 + bob);
    pushLimb(faces, base, tip, 0.058, 0.036, 6, side < 0 ? tint(body, 1.1) : tint(body, 0.86));
  }
  /** 贴在锥面上的自发光小片（双眼与胸口符）：双面发，转身时背面也不会突然消失 */
  const decal = (lat: number, fwd: number, h: number, wl: number, wh: number, col: RGB): void => {
    pushQuad2(faces, P(lat - wl, fwd, h - wh), P(lat + wl, fwd, h - wh), P(lat + wl, fwd, h + wh), P(lat - wl, fwd, h + wh), col, true);
  };
  const eyeCol: RGB = moving ? [255, 84, 96] : s.stagger > 0 ? [130, 240, 255] : [58, 64, 82];
  for (const side of [-1, 1]) decal(side * 0.042, 0.082 + lean * 1.6, 1.22 + bob, 0.019, 0.014, eyeCol);
  decal(0, robeR(0.84) + 0.012, 0.84 + bob, 0.048, 0.048, moving ? [255, 132, 92] : [86, 190, 222]);
  // 凝视裂纹：盯得越久身上亮起的缝越多，让机制本身在画面里可读
  const crackN = Math.min(5, Math.floor((s.stare / STARE_KILL) * 5.5));
  const CRACKS: Array<[number, number, number]> = [
    [0.03, 0.62, 0.11],
    [-0.05, 0.72, 0.13],
    [0.02, 0.88, 0.07],
    [0.07, 0.5, 0.1],
    [-0.03, 0.98, 0.06],
  ];
  const rgx = -sn;
  const rgy = c;
  for (let i = 0; i < crackN; i++) {
    const [ox, cz, half] = CRACKS[i];
    // 沿朝向前移一个"该高度的袍面半径"，靠更近赢过身体的排序，否则被自己那具石像挡住
    const rr = robeR(cz) + 0.012;
    const px = s.x + c * rr + rgx * ox;
    const py = s.y + sn * rr + rgy * ox;
    pushQuad2(
      faces,
      [px - rgx * 0.012, py - rgy * 0.012, bob + cz - half],
      [px + rgx * 0.012, py + rgy * 0.012, bob + cz - half],
      [px + rgx * 0.012, py + rgy * 0.012, bob + cz + half],
      [px - rgx * 0.012, py - rgy * 0.012, bob + cz + half],
      s.stagger > 0 ? [150, 246, 255] : [126, 232, 255],
      true,
    );
  }
  // 硬边剪影 + 掠射边缘光：无论墙面被手电打得多亮，石像轮廓都被"描"出来
  for (let i = from; i < faces.length; i++) {
    const f = faces[i];
    if (f.glow) {
      // 眼睛/胸符/裂纹是贴在八边面上的薄片，八边体的棱面会让它们在部分角度陷进本体，
      // 靠深度偏移保证永远最后画，而不是去赌那 1cm 的前移量
      f.bias = -0.12;
      continue;
    }
    f.edge = 'rgba(5,6,12,0.92)';
    f.edgeW = 1.6;
    f.rim = 0.6;
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
 * 房间块迷宫：每间房是 2×2 格，走廊因此有 2 格宽。
 * 沿用"1 格宽走廊"的格点约定会让侧墙永远贴在眼睛两侧 0.26 单位处，
 * 70° 视场里墙面吃掉大半画面，石像也被埋进墙里——所以这里直接把通道加宽。
 */
const PITCH = 4;

function genGrid(): Uint8Array {
  const g = new Uint8Array(GRID * GRID).fill(1);
  const N = Math.floor((GRID - 3) / PITCH) + 1;
  const room = (i: number, j: number) => {
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) g[(1 + PITCH * j + y) * GRID + (1 + PITCH * i + x)] = 0;
  };
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) room(i, j);
  // 打通两房间之间的 2×2 缺口
  const link = (i: number, j: number, horiz: boolean) => {
    const x0 = 1 + PITCH * i;
    const y0 = 1 + PITCH * j;
    if (horiz) {
      for (const gx of [x0 + 2, x0 + 3]) for (let y = 0; y < 2; y++) g[(y0 + y) * GRID + gx] = 0;
    } else {
      for (const gy of [y0 + 2, y0 + 3]) for (let x = 0; x < 2; x++) g[gy * GRID + (x0 + x)] = 0;
    }
  };
  const seen = new Uint8Array(N * N);
  const stack: Array<[number, number]> = [[0, 0]];
  seen[0] = 1;
  while (stack.length > 0) {
    const [ci, cj] = stack[stack.length - 1];
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].sort(() => Math.random() - 0.5);
    let moved = false;
    for (const [di, dj] of dirs) {
      const ni = ci + di;
      const nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N || seen[nj * N + ni]) continue;
      seen[nj * N + ni] = 1;
      // link 只在给定节点的 +x/+y 侧开缺口，所以必须传两房间里下标较小的那个，
      // 否则向左/向上走会开错位置：真通道没打通，还平白多出一截 stub
      link(Math.min(ci, ni), Math.min(cj, nj), di !== 0);
      stack.push([ni, nj]);
      moved = true;
      break;
    }
    if (!moved) stack.pop();
  }
  // 回环：再多打通三成隔断，纯树状会让石像永远堵在死路里，也少了绕后的可能
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      if (i + 1 < N && Math.random() < 0.34) link(i, j, true);
      if (j + 1 < N && Math.random() < 0.34) link(i, j, false);
    }
  // 大厅：几处矩形清空，给石像冲刺距离与长视线
  for (let r = 0; r < 3; r++) {
    const w = 5 + 2 * Math.floor(Math.random() * 2);
    const h = 5 + 2 * Math.floor(Math.random() * 2);
    const x0 = 1 + 2 * Math.floor(Math.random() * ((GRID - 2 - w) / 2));
    const y0 = 1 + 2 * Math.floor(Math.random() * ((GRID - 2 - h) / 2));
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) if (x > 0 && y > 0 && x < GRID - 1 && y < GRID - 1) g[y * GRID + x] = 0;
  }
  // 柱子：2 格宽的通道里放一根正好留出半格可走，既当掩体又不堵路；
  // 仍要验证"封掉本格后其余格全部可达"，否则十字路口中心会把半张图变成孤岛
  let reach = reachCount(g, 1 * GRID + 1);
  for (let y = 2; y < GRID - 2; y++)
    for (let x = 2; x < GRID - 2; x++) {
      const idx = y * GRID + x;
      if (g[idx] !== 0) continue;
      if (DIRS4.some(([dx, dy]) => g[(y + dy) * GRID + (x + dx)] !== 0)) continue;
      if (Math.random() > 0.16) continue;
      g[idx] = 1;
      const after = reachCount(g, 1 * GRID + 1);
      if (after === reach - 1) reach = after;
      else g[idx] = 0;
    }
  // 兜底：外圈强制是墙（任何一步都不该打穿边界），再把与起点隔断的地板格退回墙，
  // 免得留下永远拿不到的孤岛格
  for (let k = 0; k < GRID; k++) {
    g[k] = 1;
    g[(GRID - 1) * GRID + k] = 1;
    g[k * GRID] = 1;
    g[k * GRID + GRID - 1] = 1;
  }
  const d0 = bfs(g, 1 * GRID + 1);
  // 起点本身是墙时 bfs 全 -1，那样会把整张图抹掉——真发生就保留原样交给上层重生成
  if (d0[1 * GRID + 1] === 0) for (let i = 0; i < g.length; i++) if (g[i] === 0 && d0[i] < 0) g[i] = 1;
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

// ============ 第一人称视图模型（手 + 光矛） ============

const SKIN: RGB = [203, 164, 136];
const SKIN_TOP: RGB = [221, 186, 158];
const SKIN_DARK: RGB = [164, 126, 104];
const SKIN_NAIL: RGB = [238, 216, 196];
const SUIT: RGB = [72, 64, 108];
const SUIT_DARK: RGB = [46, 40, 72];
const SUIT_LIGHT: RGB = [100, 90, 144];
const STEEL: RGB = [88, 94, 124];
const STEEL_DARK: RGB = [50, 54, 78];
const COOL: RGB = [110, 235, 255];

/** 相机局部轴：x=右、y=上、z=前，转成世界坐标 */
function vmPoint(cam: Cam, lx: number, ly: number, lz: number): Vec3 {
  const fx = Math.cos(cam.yaw);
  const fy = Math.sin(cam.yaw);
  return [cam.x - fy * lx + fx * lz, cam.y + fx * lx + fy * lz, cam.eye + ly];
}

/**
 * 视图模型方块：hr 沿相机右轴、hf 沿前轴、hu 沿上轴。
 * pushBox 只能绕世界竖轴转，所以 yaw 取 cam.yaw + 90° 让它的局部 x 轴对齐相机右轴，
 * phi 再绕竖直方向微调（+phi 把长轴从"前"转向"右"）。
 */
function vmBox(faces: Face[], cam: Cam, lx: number, ly: number, lz: number, hr: number, hf: number, hu: number, phi: number, col: RGB, top?: RGB): void {
  const p = vmPoint(cam, lx, ly, lz);
  pushBox(faces, p[0], p[1], p[2], hr, hf, hu, cam.yaw + Math.PI / 2 + phi, col, top);
}

/** 垂直于视线的环（能量线圈）：正负两面都发，避免转身时消失 */
function vmRing(faces: Face[], cam: Cam, lx: number, ly: number, lz: number, r0: number, r1: number, col: RGB): void {
  const N = 8;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    pushQuad2(
      faces,
      vmPoint(cam, lx + Math.cos(a0) * r0, ly + Math.sin(a0) * r0, lz),
      vmPoint(cam, lx + Math.cos(a1) * r0, ly + Math.sin(a1) * r0, lz),
      vmPoint(cam, lx + Math.cos(a1) * r1, ly + Math.sin(a1) * r1, lz),
      vmPoint(cam, lx + Math.cos(a0) * r1, ly + Math.sin(a0) * r1, lz),
      col,
      true,
    );
  }
}

/**
 * 右手握持光矛的第一人称模型：护腕 → 袖口 → 手背 → 四根分段包住握把的手指 → 拇指，
 * 再接握把、机匣、导轨、枪管、能量环与枪口。返回枪口的世界坐标（光束起点）。
 */
function emitViewModel(faces: Face[], cam: Cam, w: World, t: number): Vec3 {
  const from = faces.length;
  const rec = w.shotFx > 0 ? w.shotFx / 0.1 : 0; // 后坐 0..1
  const step = (w.stepAcc / 0.85) * Math.PI * 2; // 每走一步一个摆动周期
  const dx = Math.cos(step * 0.5) * 0.005;
  const dy = Math.sin(step) * 0.006 + Math.sin(t * 1.4) * 0.0035 - 0.012 * rec;
  const dz = -0.055 * rec;
  const dr = 0.07 * rec; // 后坐时枪口上跳
  const box = (lx: number, ly: number, lz: number, hr: number, hf: number, hu: number, phi: number, col: RGB, top?: RGB) =>
    vmBox(faces, cam, lx + dx, ly + dy, lz + dz, hr, hf, hu, phi + dr, col, top);

  // 小臂从画面右下角伸入，袖口收在腕部
  box(0.26, -0.175, 0.44, 0.044, 0.115, 0.044, -0.42, SUIT, SUIT_LIGHT);
  box(0.205, -0.165, 0.545, 0.047, 0.02, 0.047, -0.42, SUIT_DARK, SUIT_LIGHT);
  // 手背
  box(0.16, -0.14, 0.575, 0.052, 0.06, 0.028, -0.1, SKIN, SKIN_TOP);
  // 握把：横在掌前，四指从上方绕到前侧
  box(0.135, -0.118, 0.628, 0.07, 0.021, 0.021, 0, STEEL_DARK, [64, 68, 94]);
  const FING = [0.09, 0.121, 0.152, 0.183];
  for (let i = 0; i < 4; i++) {
    const x = FING[i];
    const droop = 0.0035 * (i - 1.5); // 中指最高、小指最低，排成一条指节弧
    // 三节包握：指节压在握把上方 → 中段沿前侧下行 → 末节绕到下方，指尖指甲朝内
    box(x, -0.094 + droop, 0.617, 0.0135, 0.0155, 0.0125, 0, SKIN, SKIN_TOP);
    box(x, -0.124 + droop, 0.648, 0.0125, 0.0125, 0.016, 0.1, SKIN, SKIN_TOP);
    box(x, -0.15 + droop, 0.634, 0.0115, 0.014, 0.011, 0, SKIN_DARK, SKIN);
    box(x, -0.152 + droop, 0.62, 0.0085, 0.006, 0.0055, 0, SKIN_NAIL); // 指甲
  }
  // 拇指压在机匣侧面
  box(0.205, -0.098, 0.65, 0.014, 0.034, 0.014, -0.25, SKIN, SKIN_TOP);
  // 机匣、导轨、枪管
  box(0.125, -0.056, 0.76, 0.024, 0.16, 0.02, 0.02, STEEL, [112, 118, 150]);
  box(0.125, -0.028, 0.765, 0.009, 0.1, 0.006, 0.02, SUIT_DARK, COOL);
  box(0.125, -0.07, 0.95, 0.014, 0.1, 0.014, 0.02, STEEL_DARK, STEEL);
  // 能量环与枪口
  for (let i = 0; i < 3; i++) vmRing(faces, cam, 0.125 + dx, -0.07 + dy, 1.09 + i * 0.1 + dz, 0.018, 0.028 + i * 0.005, COOL);
  const mz = 1.36 + dz;
  const N = 8;
  const c0 = vmPoint(cam, 0.125 + dx, -0.07 + dy, mz);
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    pushQuad2(
      faces,
      c0,
      vmPoint(cam, 0.125 + dx + Math.cos(a0) * 0.018, -0.07 + dy + Math.sin(a0) * 0.018, mz),
      vmPoint(cam, 0.125 + dx + Math.cos(a1) * 0.018, -0.07 + dy + Math.sin(a1) * 0.018, mz),
      c0,
      [220, 250, 255],
      true,
    );
  }
  for (let i = from; i < faces.length; i++) faces[i].vm = true;
  return c0;
}

// ============ 屏幕空间美术（HUD 用，与 3D 管线无关） ============

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

/** 胶片颗粒：低分辨率平涂最容易出色带，一层细噪点把渐变打散 */
function grainSprite(): HTMLCanvasElement {
  const S = 96;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const rnd = mulberry(404);
  for (let i = 0; i < S * S; i++) {
    const v = 110 + rnd() * 145;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 30;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** 屏幕空间霓虹溢出：世界点投影后画一圈加法光斑，尺寸随深度收放 */
function bloomAt(ctx: CanvasRenderingContext2D, cam: Cam, p: Vec3, r: number, col: string, a: number): void {
  const s = project(cam, p);
  if (!s) return;
  const rr = (FOCAL / s.z) * r;
  if (rr < 1 || s.x < -rr || s.x > RW + rr || s.y < -rr || s.y > RH + rr) return;
  const fade = Math.max(0, 1 - s.z / (FOG_END + 2));
  const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, rr);
  g.addColorStop(0, `rgba(${col},${a * fade})`);
  g.addColorStop(0.5, `rgba(${col},${a * fade * 0.35})`);
  g.addColorStop(1, `rgba(${col},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
  ctx.fill();
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
      const R = STICK_R;
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
      if (Math.hypot(p.x - look.x0, p.y - look.y0) > 9 * UIS) look.moved = true;
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

    const vmFaces: Face[] = [];
    const grainPat = ctx.createPattern(grainSprite(), 'repeat')!;
    const drnd = mulberry(99);
    const dust = Array.from({ length: 95 }, () => ({
      x: (drnd() - 0.5) * 2.6,
      y: (drnd() - 0.5) * 1.6 + 0.15,
      z: 0.5 + drnd() * 5.5,
      p: drnd() * 6.28,
    }));
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
        if (stick && Math.hypot(stick.dx, stick.dy) / STICK_R > 0.14) {
          mf += -stick.dy / STICK_R; // 上推 = 前进
          ms += stick.dx / STICK_R;
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
      if (w.shake > 0.01) ctx.translate((Math.random() - 0.5) * 11 * UIS * w.shake, (Math.random() - 0.5) * 8 * UIS * w.shake);
      // 天空/屋顶与地面底色：以地平线为界，俯仰时一起移动
      const up = ctx.createLinearGradient(0, Math.min(0, horizon - RH), 0, Math.max(0, horizon));
      up.addColorStop(0, '#04060d');
      up.addColorStop(1, '#16203a');
      ctx.fillStyle = up;
      ctx.fillRect(-12, -12, RW + 24, horizon + 12);
      const dn = ctx.createLinearGradient(0, Math.min(RH, horizon), 0, Math.max(RH, horizon + RH));
      dn.addColorStop(0, '#122b2d');
      dn.addColorStop(1, '#050a0b');
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
          pushTri(faces, a, b, top, [255, 198, 72], true);
          pushTri(faces, b, a, bot, [255, 146, 34], true);
        }
      }
      emitPortal(faces, w.portalX, w.portalY, w.open, t);
      renderScene(ctx, cam, faces, list, sc);

      // 先建视图模型拿到枪口世界坐标（光束要从这里射出），但留到最后一步再画，
      // 让它压住世界与光束——第一人称武器永远在最前层
      vmFaces.length = 0;
      const showVm = statusRef.current !== 'ready';
      const muzzleWorld = showVm ? emitViewModel(vmFaces, cam, w, t) : null;

      // 光矛光束：枪口 → 命中点，两端都在世界坐标里算，再投影成屏幕线段
      if (w.beamFx > 0 && w.beamTo) {
        const muzzle = muzzleWorld ? project(cam, muzzleWorld) : null;
        const end = project(cam, w.beamTo);
        if (muzzle && end) {
          const a = w.beamFx;
          ctx.strokeStyle = `rgba(150,240,255,${0.25 * a})`;
          ctx.lineWidth = 7 * UIS;
          ctx.beginPath();
          ctx.moveTo(muzzle.x, muzzle.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
          ctx.strokeStyle = `rgba(238,252,255,${0.9 * a})`;
          ctx.lineWidth = 1.6 * UIS;
          ctx.stroke();
          const fl = ctx.createRadialGradient(end.x, end.y, 1, end.x, end.y, (15 * a + 3) * UIS);
          fl.addColorStop(0, `rgba(220,250,255,${0.85 * a})`);
          fl.addColorStop(1, 'rgba(120,200,255,0)');
          ctx.fillStyle = fl;
          ctx.beginPath();
          ctx.arc(end.x, end.y, (15 * a + 3) * UIS, 0, Math.PI * 2);
          ctx.fill();
          // 枪口火光
          const mf = ctx.createRadialGradient(muzzle.x, muzzle.y, 1, muzzle.x, muzzle.y, (22 * a + 4) * UIS);
          mf.addColorStop(0, `rgba(235,252,255,${0.9 * a})`);
          mf.addColorStop(0.45, `rgba(120,220,255,${0.45 * a})`);
          mf.addColorStop(1, 'rgba(90,180,255,0)');
          ctx.fillStyle = mf;
          ctx.beginPath();
          ctx.arc(muzzle.x, muzzle.y, (22 * a + 4) * UIS, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 凝视进度：把石像头顶投影到屏幕上画一条
      for (const s of w.statues) {
        if (!s.alive || s.stare <= 0.25 || s.stagger > 0) continue;
        const p = project(cam, [s.x, s.y, 1.62]);
        if (!p) continue;
        const bw = Math.max(16 * UIS, (FOCAL / p.z) * 0.5);
        const ratio = Math.min(1, s.stare / STARE_KILL);
        ctx.fillStyle = 'rgba(6,8,18,0.72)';
        ctx.fillRect(p.x - bw / 2 - UIS, p.y - 4 * UIS, bw + 2 * UIS, 6 * UIS);
        ctx.fillStyle = ratio > 0.75 ? '#ffe37a' : '#7ee8ff';
        ctx.fillRect(p.x - bw / 2, p.y - 3 * UIS, bw * ratio, 4 * UIS);
      }
      if (showVm) renderScene(ctx, cam, vmFaces, list, sc);

      // ---- 后期：霓虹溢出 + 浮尘 + 胶片颗粒 ----
      ctx.globalCompositeOperation = 'lighter';
      // 泛光是纯屏幕空间的，不做遮挡就会穿墙浮出一团光（看起来像"敌人在部分视角显示有问题"）
      const vfx = cam.yaw;
      const vfxC = Math.cos(vfx);
      const vfxS = Math.sin(vfx);
      const visibleAt = (x: number, y: number): boolean => {
        const dx = x - cam.x;
        const dy = y - cam.y;
        const along = dx * vfxC + dy * vfxS;
        if (along < 0.3 || Math.abs(-dx * vfxS + dy * vfxC) > along * HALF_TAN * 1.25) return false;
        return losClear(w.grid, cam.x, cam.y, x, y);
      };
      for (const c of w.cores) if (!c.taken && visibleAt(c.x, c.y)) bloomAt(ctx, cam, [c.x, c.y, 0.62], 0.5, '255,168,54', 0.5);
      if (visibleAt(w.portalX, w.portalY))
        bloomAt(ctx, cam, [w.portalX, w.portalY, 0.78], w.open ? 1.5 : 0.85, w.open ? '150,120,255' : '190,60,90', w.open ? 0.5 : 0.16);
      // 红眼溢出：只有真在逼近且看得见的石像会发光，等于给"它在逼近"再加一层提示
      for (const s of w.statues) if (s.alive && s.stagger <= 0 && !s.frozen && visibleAt(s.x, s.y)) bloomAt(ctx, cam, [s.x, s.y, 1.1], 0.34, '255,60,80', 0.42);
      const dRx = -Math.sin(cam.yaw);
      const dRy = Math.cos(cam.yaw);
      const dFx = Math.cos(cam.yaw);
      const dFy = Math.sin(cam.yaw);
      for (const d of dust) {
        const lx = d.x + Math.sin(t * 0.5 + d.p) * 0.08;
        const ly = d.y + Math.sin(t * 0.37 + d.p) * 0.06;
        const lz = d.z + Math.cos(t * 0.23 + d.p) * 0.25;
        const s = project(cam, [cam.x + dRx * lx + dFx * lz, cam.y + dRy * lx + dFy * lz, cam.eye + ly]);
        if (!s) continue;
        const big = s.z < 1.6;
        ctx.fillStyle = `rgba(196,220,255,${Math.max(0, 0.42 - d.z * 0.062)})`;
        ctx.fillRect(s.x, s.y, big ? 2 * UIS : UIS, big ? 2 * UIS : UIS);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.translate(-((t * 97) % 96), (t * 53) % 96);
      ctx.fillStyle = grainPat;
      ctx.fillRect(0, 0, RW + 96, RH + 96);
      ctx.restore();
      ctx.restore();

      // ---- HUD（不随震动偏移，避免准星/雷达乱跳） ----
      if (statusRef.current !== 'ready') {
        const rec = w.shotFx > 0 ? w.shotFx / 0.1 : 0;

        const dirX = Math.cos(w.ang);
        const dirY = Math.sin(w.ang);
        const aimHot = w.statues.some((s) => {
          if (!s.alive) return false;
          const rx = s.x - w.px;
          const ry = s.y - w.py;
          const along = rx * dirX + ry * dirY;
          return along > 0.15 && Math.abs(-rx * dirY + ry * dirX) <= BEAM_HALF;
        });
        const gap = (5 + rec * 9) * UIS;
        ctx.strokeStyle = w.hitFx > 0 ? '#ffd166' : aimHot ? '#ff6b81' : 'rgba(200,240,255,0.85)';
        ctx.lineWidth = 1.5 * UIS;
        ctx.beginPath();
        for (const [ax, ay] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as Array<[number, number]>) {
          ctx.moveTo(RW / 2 + ax * gap, RH / 2 + ay * gap);
          ctx.lineTo(RW / 2 + ax * (gap + 7 * UIS), RH / 2 + ay * (gap + 7 * UIS));
        }
        ctx.stroke();
        ctx.fillStyle = aimHot ? 'rgba(255,107,129,0.9)' : 'rgba(200,240,255,0.5)';
        ctx.fillRect(RW / 2 - UIS, RH / 2 - UIS, 2 * UIS, 2 * UIS);
        if (w.hitFx > 0) {
          ctx.strokeStyle = `rgba(255,225,140,${Math.min(1, w.hitFx * 4)})`;
          ctx.lineWidth = 2 * UIS;
          ctx.beginPath();
          for (const [sx, sy] of [
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
          ] as Array<[number, number]>) {
            ctx.moveTo(RW / 2 + sx * 4 * UIS, RH / 2 + sy * 4 * UIS);
            ctx.lineTo(RW / 2 + sx * 10 * UIS, RH / 2 + sy * 10 * UIS);
          }
          ctx.stroke();
        }

        // 能量条
        const ebw = 130 * UIS;
        const ebh = 10 * UIS;
        const bx = 14 * UIS;
        const by = RH - 22 * UIS;
        ctx.fillStyle = 'rgba(6,8,18,0.66)';
        ctx.fillRect(bx - UIS, by - UIS, ebw + 2 * UIS, ebh + 2 * UIS);
        ctx.fillStyle = w.energy >= SHOT_COST ? '#7ee8ff' : '#5a6a8a';
        ctx.fillRect(bx, by, ebw * (w.energy / ENERGY_MAX), ebh);
        ctx.fillStyle = 'rgba(4,6,14,0.55)';
        for (let i = 1; i < 4; i++) ctx.fillRect(bx + (ebw * i) / 4, by, UIS, ebh);
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx - 1.5 * UIS, by - 1.5 * UIS, ebw + 3 * UIS, ebh + 3 * UIS);
        ctx.fillStyle = 'rgba(220,235,255,0.75)';
        ctx.font = `${Math.round(9 * UIS)}px "Segoe UI", sans-serif`;
        ctx.fillText('光矛能量', bx, by - 4 * UIS);

        // 逼近雷达（右上角，与枪模错开）：红=视线外逼近，青=被你盯住，黄=打瘫中
        const rcx = RW - 48 * UIS;
        const rcy = 48 * UIS;
        const rr = 34 * UIS;
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
        for (const c of w.cores) if (!c.taken) plot(c.x, c.y, 2.2 * UIS, '#ffd75e');
        if (w.open) plot(w.portalX, w.portalY, 3.2 * UIS, '#3ef0a2');
        for (const s of w.statues) {
          if (!s.alive) continue;
          plot(s.x, s.y, 3.4 * UIS, s.stagger > 0 ? '#ffe37a' : s.frozen ? '#7ee8ff' : '#ff4d63');
        }

        if (w.bannerT > 0) {
          ctx.globalAlpha = Math.min(1, w.bannerT * 1.4);
          ctx.fillStyle = 'rgba(230,240,255,0.92)';
          ctx.font = `bold ${Math.round(17 * UIS)}px "Segoe UI", "Microsoft YaHei", sans-serif`;
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
          ctx.lineWidth = 3 * UIS;
          ctx.strokeRect(2 * UIS, 2 * UIS, RW - 4 * UIS, RH - 4 * UIS);
        }
        const stick = stickRef.current;
        if (stick) {
          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
          ctx.lineWidth = 2 * UIS;
          ctx.beginPath();
          ctx.arc(stick.ox, stick.oy, STICK_R, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.45)';
          ctx.beginPath();
          ctx.arc(stick.ox + stick.dx, stick.oy + stick.dy, 18 * UIS, 0, Math.PI * 2);
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
                被注视的石像不会动；一移开视线就直冲过来
                <br />
                集齐光核开星门，逐层深入
              </p>
              <p className="g3d-keys">
                W/S 前后 · A/D 侧移 · ←/→ 转向 · 空格 光矛 · P 暂停
                <br />
                光矛两发碎裂，<b>走近死盯</b>也能压裂
                <br />
                📱 左摇杆移动 · 右拖拽转向 · 轻点开火
              </p>
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
          Shift 疾跑 · 右上角雷达：红点 = 视线外正在逼近的石像，青点 = 被你盯住的石像 · 星门开在离入口最远处那格
        </p>
      </div>
    </GameShell>
  );
}
