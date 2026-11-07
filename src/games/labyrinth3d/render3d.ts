import { BALL_R, WALL_H } from './levels.ts';
import { MAX_TILT } from './physics.ts';
import { ICE, SAND, WALL } from './types.ts';
import type { Level, RunState, Vec2, Vec3, Viewport } from './types.ts';

export interface Camera {
  distance: number;
  elev: number;
  focal: number;
  cx: number;
  cy: number;
  cosE: number;
  sinE: number;
}

export interface Projected {
  x: number;
  y: number;
  depth: number;
  scale: number;
}

const ELEV = 0.92;
const DIST = 16;
const SLAB_T = 0.55;
const LIGHT: Vec3 = (() => {
  const l = Math.hypot(-0.45, 0.82, 0.36);
  return { x: -0.45 / l, y: 0.82 / l, z: 0.36 / l };
})();

/** 盘面局部 → 世界：先 Rx(pitch) 再 Rz(roll)，与 physics.planeGravity 用的是同一组角 */
export function boardWorld(tilt: { pitch: number; roll: number }, x: number, y: number, z: number): Vec3 {
  const cp = Math.cos(tilt.pitch);
  const sp = Math.sin(tilt.pitch);
  const cr = Math.cos(tilt.roll);
  const sr = Math.sin(tilt.roll);
  const X = x;
  const Y = y * cp - z * sp;
  const Z = y * sp + z * cp;
  return { x: X * cr - Y * sr, y: X * sr + Y * cr, z: Z };
}

/** 固定相机闭式投影：xc=P.x，yc=P.y·cosE−P.z·sinE，zc=D−P.y·sinE−P.z·cosE */
export function project(cam: Camera, p: Vec3): Projected {
  const xc = p.x;
  const yc = p.y * cam.cosE - p.z * cam.sinE;
  const depth = cam.distance - p.y * cam.sinE - p.z * cam.cosE;
  const safe = Math.max(0.5, depth);
  const scale = cam.focal / safe;
  return { x: cam.cx + xc * scale, y: cam.cy - yc * scale, depth, scale };
}

/**
 * 用「最大倾角包络」的 32 个角点一次性拟合焦距与画面中心。
 * 不随每帧倾斜重算，否则盘面一动画面就跟着缩放抽动。
 */
export function makeCamera(level: Level, viewport: Viewport): Camera {
  const cosE = Math.cos(ELEV);
  const sinE = Math.sin(ELEV);
  const edge = level.half + 0.5;
  const raw: Array<{ x: number; y: number }> = [];
  const probe = { pitch: 0, roll: 0 };
  for (const pitch of [-MAX_TILT, MAX_TILT]) {
    for (const roll of [-MAX_TILT, MAX_TILT]) {
      probe.pitch = pitch;
      probe.roll = roll;
      for (const x of [-edge, edge]) {
        for (const z of [-edge, edge]) {
          for (const y of [-SLAB_T, WALL_H]) {
            const w = boardWorld(probe, x, y, z);
            const xc = w.x;
            const yc = w.y * cosE - w.z * sinE;
            const zc = DIST - w.y * sinE - w.z * cosE;
            raw.push({ x: xc / zc, y: -yc / zc });
          }
        }
      }
    }
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of raw) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const padX = viewport.width * 0.04;
  const padTop = viewport.height * 0.11;
  const padBottom = viewport.height * 0.05;
  const availW = Math.max(40, viewport.width - padX * 2);
  const availH = Math.max(40, viewport.height - padTop - padBottom);
  const focal = Math.min(availW / Math.max(1e-6, maxX - minX), availH / Math.max(1e-6, maxY - minY));
  return {
    distance: DIST,
    elev: ELEV,
    focal,
    cx: viewport.width / 2 - (focal * (minX + maxX)) / 2,
    cy: padTop + availH / 2 - (focal * (minY + maxY)) / 2,
    cosE,
    sinE,
  };
}

interface Face {
  pts: Array<{ x: number; y: number }>;
  depth: number;
  fill: string;
  stroke?: string;
  ball?: { x: number; y: number; r: number; spin: number };
}

interface SceneOptions {
  level: Level;
  run: RunState;
  camera: Camera;
  viewport: Viewport;
  time: number;
  hint: Vec2[] | null;
  drag: { ox: number; oy: number; x: number; y: number } | null;
  showTilt: boolean;
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * k));
  const b = Math.min(255, Math.round((n & 255) * k));
  return `rgb(${r},${g},${b})`;
}

function normalOf(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / l, y: ny / l, z: nz / l };
}

/** 定向盒：u/v/w 为世界正交轴，背面剔除后凸体各可见面互不重叠，无需内部排序 */
function pushBox(
  faces: Face[],
  cam: Camera,
  center: Vec3,
  u: Vec3,
  v: Vec3,
  w: Vec3,
  hu: number,
  hv: number,
  hw: number,
  color: string,
  skip: Set<string> = new Set(),
  stroke?: string,
): void {
  const corner = (su: number, sv: number, sw: number): Vec3 => ({
    x: center.x + u.x * hu * su + v.x * hv * sv + w.x * hw * sw,
    y: center.y + u.y * hu * su + v.y * hv * sv + w.y * hw * sw,
    z: center.z + u.z * hu * su + v.z * hv * sv + w.z * hw * sw,
  });
  const specs: Array<{ key: string; n: Vec3; idx: [number, number, number, number] }> = [
    { key: '+u', n: u, idx: [1, 3, 7, 5] },
    { key: '-u', n: { x: -u.x, y: -u.y, z: -u.z }, idx: [0, 4, 6, 2] },
    { key: '+v', n: v, idx: [2, 6, 7, 3] },
    { key: '-v', n: { x: -v.x, y: -v.y, z: -v.z }, idx: [0, 1, 5, 4] },
    { key: '+w', n: w, idx: [4, 5, 7, 6] },
    { key: '-w', n: { x: -w.x, y: -w.y, z: -w.z }, idx: [0, 2, 3, 1] },
  ];
  const signs: Array<[number, number, number]> = [
    [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
  ];
  const pts3 = signs.map(([a, b, c]) => corner(a, b, c));
  for (const spec of specs) {
    if (skip.has(spec.key)) continue;
    const quad = spec.idx.map((i) => pts3[i]);
    const centroid: Vec3 = {
      x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
      y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
      z: (quad[0].z + quad[1].z + quad[2].z + quad[3].z) / 4,
    };
    const toCam = { x: -centroid.x, y: DIST * cam.sinE - centroid.y, z: DIST * cam.cosE - centroid.z };
    if (spec.n.x * toCam.x + spec.n.y * toCam.y + spec.n.z * toCam.z <= 0) continue;
    const lit = 0.34 + 0.66 * Math.max(0, spec.n.x * LIGHT.x + spec.n.y * LIGHT.y + spec.n.z * LIGHT.z);
    const proj = quad.map((p) => project(cam, p));
    faces.push({
      pts: proj.map((p) => ({ x: p.x, y: p.y })),
      depth: proj.reduce((s, p) => s + p.depth, 0) / 4,
      fill: shade(color, lit),
      stroke,
    });
  }
}

function polygon(ctx: CanvasRenderingContext2D, pts: Array<{ x: number; y: number }>): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

/** 盘面上的圆 → 投影多边形（倾斜后自然是椭圆，不用猜长短轴） */
function disc(cam: Camera, run: RunState, x: number, z: number, r: number, y = 0.004, seg = 26): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    out.push(project(cam, boardWorld(run, x + Math.cos(a) * r, y, z + Math.sin(a) * r)));
  }
  return out;
}

function drawBackground(ctx: CanvasRenderingContext2D, opts: SceneOptions): void {
  const { viewport, time, camera } = opts;
  const g = ctx.createLinearGradient(0, 0, 0, viewport.height);
  g.addColorStop(0, '#0b0e1c');
  g.addColorStop(0.55, '#141a35');
  g.addColorStop(1, '#0a0d1a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  // 固定种子的星点：不随帧变化，避免闪烁
  let seed = 20261107;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 78; i++) {
    const x = rnd() * viewport.width;
    const y = rnd() * viewport.height;
    const r = 0.35 + rnd() * 1.05;
    const tw = 0.32 + 0.3 * Math.sin(time * (0.5 + rnd() * 1.4) + i);
    ctx.fillStyle = `rgba(190,205,255,${tw.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const glow = ctx.createRadialGradient(camera.cx, camera.cy, 0, camera.cx, camera.cy, Math.max(viewport.width, viewport.height) * 0.62);
  glow.addColorStop(0, 'rgba(124,92,255,0.16)');
  glow.addColorStop(0.5, 'rgba(0,212,255,0.05)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, viewport.width, viewport.height);
}

function drawSlab(ctx: CanvasRenderingContext2D, opts: SceneOptions, axes: { u: Vec3; v: Vec3; w: Vec3 }): void {
  const { level, run, camera } = opts;
  const edge = level.half + 0.5;
  const faces: Face[] = [];
  pushBox(
    faces, camera, boardWorld(run, 0, -SLAB_T / 2, 0),
    axes.u, axes.v, axes.w, edge, edge, SLAB_T / 2, '#151a33',
    new Set(['+w']),
  );
  faces.sort((a, b) => b.depth - a.depth);
  for (const f of faces) {
    polygon(ctx, f.pts);
    ctx.fillStyle = f.fill;
    ctx.fill();
  }
  // 顶面
  const top = [
    project(camera, boardWorld(run, -edge, 0, -edge)),
    project(camera, boardWorld(run, edge, 0, -edge)),
    project(camera, boardWorld(run, edge, 0, edge)),
    project(camera, boardWorld(run, -edge, 0, edge)),
  ];
  polygon(ctx, top);
  const g = ctx.createLinearGradient(top[0].x, top[0].y, top[2].x, top[2].y);
  g.addColorStop(0, '#232a52');
  g.addColorStop(1, '#171d3a');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,212,255,0.34)';
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

function drawDecals(ctx: CanvasRenderingContext2D, opts: SceneOptions): void {
  const { level, run, camera, time, hint } = opts;
  const size = level.size;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const t = level.terrain[row * size + col];
      if (t !== ICE && t !== SAND) continue;
      const x = col - level.half;
      const z = row - level.half;
      const quad = [
        project(camera, boardWorld(run, x - 0.5, 0.006, z - 0.5)),
        project(camera, boardWorld(run, x + 0.5, 0.006, z - 0.5)),
        project(camera, boardWorld(run, x + 0.5, 0.006, z + 0.5)),
        project(camera, boardWorld(run, x - 0.5, 0.006, z + 0.5)),
      ];
      polygon(ctx, quad);
      ctx.fillStyle = t === ICE ? 'rgba(0,212,255,0.19)' : 'rgba(233,196,121,0.20)';
      ctx.fill();
      ctx.strokeStyle = t === ICE ? 'rgba(150,235,255,0.30)' : 'rgba(233,196,121,0.26)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      if (t === ICE) {
        const a = project(camera, boardWorld(run, x - 0.3, 0.008, z + 0.22));
        const b = project(camera, boardWorld(run, x + 0.24, 0.008, z - 0.26));
        ctx.strokeStyle = 'rgba(220,250,255,0.34)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  // 网格线：给倾斜盘面一个可读的深度参照
  ctx.strokeStyle = 'rgba(150,170,255,0.085)';
  ctx.lineWidth = 0.7;
  for (let i = 0; i <= size; i++) {
    const k = i - level.half - 0.5;
    const a = project(camera, boardWorld(run, k, 0.004, -level.half - 0.5));
    const b = project(camera, boardWorld(run, k, 0.004, level.half + 0.5));
    const c = project(camera, boardWorld(run, -level.half - 0.5, 0.004, k));
    const d = project(camera, boardWorld(run, level.half + 0.5, 0.004, k));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.stroke();
  }

  for (const hole of level.holes) {
    const pulse = hole.goal ? 0.5 + 0.5 * Math.sin(time * 2.6) : 0;
    const rim = disc(camera, run, hole.x, hole.z, hole.r + 0.075 + pulse * 0.035);
    polygon(ctx, rim);
    ctx.fillStyle = hole.goal ? `rgba(251,191,36,${(0.30 + pulse * 0.30).toFixed(3)})` : 'rgba(248,113,113,0.26)';
    ctx.fill();
    const mouth = disc(camera, run, hole.x, hole.z, hole.r);
    polygon(ctx, mouth);
    ctx.fillStyle = '#04060e';
    ctx.fill();
    ctx.strokeStyle = hole.goal ? 'rgba(255,214,110,0.85)' : 'rgba(248,113,113,0.55)';
    ctx.lineWidth = 1.3;
    ctx.stroke();
    // 内壁：向远端偏移的一圈暗面，给出深度
    const inner = disc(camera, run, hole.x, hole.z, hole.r * 0.72, -0.22);
    polygon(ctx, inner);
    ctx.fillStyle = hole.goal ? 'rgba(120,80,10,0.55)' : 'rgba(30,10,16,0.75)';
    ctx.fill();
    if (hole.goal) {
      const c = project(camera, boardWorld(run, hole.x, 0.01, hole.z));
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, hole.r * c.scale * 2.4);
      g.addColorStop(0, `rgba(255,205,90,${(0.30 + pulse * 0.22).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,205,90,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.x, c.y, hole.r * c.scale * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  level.checkpoints.forEach((c, i) => {
    const active = run.checkpoint === i;
    const ring = disc(camera, run, c.x, c.z, 0.40);
    polygon(ctx, ring);
    ctx.strokeStyle = active ? 'rgba(124,92,255,0.95)' : 'rgba(124,92,255,0.42)';
    ctx.lineWidth = active ? 2.4 : 1.4;
    ctx.stroke();
    if (active) {
      const inner = disc(camera, run, c.x, c.z, 0.28);
      polygon(ctx, inner);
      ctx.fillStyle = 'rgba(124,92,255,0.20)';
      ctx.fill();
    }
  });

  if (hint && hint.length > 1) {
    ctx.strokeStyle = 'rgba(52,211,153,0.75)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    hint.forEach((p, i) => {
      const p2 = project(camera, boardWorld(run, p.x, 0.02, p.z));
      if (i === 0) ctx.moveTo(p2.x, p2.y);
      else ctx.lineTo(p2.x, p2.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  level.gems.forEach((g, i) => {
    if (run.taken[i]) return;
    const c = project(camera, boardWorld(run, g.x, 0.01, g.z));
    const r = 0.42 * c.scale;
    const grad = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
    grad.addColorStop(0, 'rgba(0,212,255,0.34)');
    grad.addColorStop(1, 'rgba(0,212,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fill();
  });

  // 球的接触阴影：沿光照反方向偏移，掉洞时随高度缩小淡出
  const b = run.ball;
  const lift = Math.max(0, b.y);
  const shrink = b.y < 0 ? Math.max(0, 1 + b.y / 1.9) : 1;
  if (shrink > 0.02) {
    const sh = disc(camera, run, b.x + 0.16 + lift * 0.2, b.z + 0.12, BALL_R * (1.05 + lift * 0.5) * shrink, 0.01, 20);
    polygon(ctx, sh);
    ctx.fillStyle = `rgba(2,4,10,${(0.42 * shrink).toFixed(3)})`;
    ctx.fill();
  }
}

function drawStanding(ctx: CanvasRenderingContext2D, opts: SceneOptions, axes: { u: Vec3; v: Vec3; w: Vec3 }): void {
  const { level, run, camera, time } = opts;
  const faces: Face[] = [];
  const size = level.size;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (level.terrain[row * size + col] !== WALL) continue;
      const skip = new Set<string>(['-w']);
      const at = (c: number, r: number) => c >= 0 && r >= 0 && c < size && r < size && level.terrain[r * size + c] === WALL;
      // 与相邻墙共用的面不画：省掉内部面，也消除接缝
      if (at(col + 1, row)) skip.add('+u');
      if (at(col - 1, row)) skip.add('-u');
      if (at(col, row + 1)) skip.add('+v');
      if (at(col, row - 1)) skip.add('-v');
      const rim = row === 0 || col === 0 || row === size - 1 || col === size - 1;
      pushBox(
        faces, camera,
        boardWorld(run, col - level.half, WALL_H / 2, row - level.half),
        axes.u, axes.v, axes.w, 0.5, 0.5, WALL_H / 2,
        rim ? '#2b3368' : '#39417d', skip,
        rim ? 'rgba(0,212,255,0.16)' : 'rgba(160,180,255,0.14)',
      );
    }
  }

  for (let i = 0; i < level.sweepers.length; i++) {
    const s = level.sweepers[i];
    const a = run.sweeperAngles[i];
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const u = { x: axes.u.x * ca + axes.v.x * sa, y: axes.u.y * ca + axes.v.y * sa, z: axes.u.z * ca + axes.v.z * sa };
    const v = { x: -axes.u.x * sa + axes.v.x * ca, y: -axes.u.y * sa + axes.v.y * ca, z: -axes.u.z * sa + axes.v.z * ca };
    pushBox(
      faces, camera, boardWorld(run, s.x, 0.19, s.z), u, v, axes.w,
      s.arm, s.r, 0.13, '#c9a227', new Set(['-w']), 'rgba(255,225,150,0.30)',
    );
    pushBox(
      faces, camera, boardWorld(run, s.x, 0.24, s.z), axes.u, axes.v, axes.w,
      0.19, 0.19, 0.24, '#8d6f1c', new Set(['-w']),
    );
  }

  level.gems.forEach((g, i) => {
    if (run.taken[i]) return;
    const spin = time * 1.5 + i;
    const bob = 0.30 + Math.sin(time * 2.2 + i * 1.7) * 0.045;
    const c = boardWorld(run, g.x, bob, g.z);
    const cs = Math.cos(spin);
    const sn = Math.sin(spin);
    const u = { x: axes.u.x * cs + axes.v.x * sn, y: axes.u.y * cs + axes.v.y * sn, z: axes.u.z * cs + axes.v.z * sn };
    const v = { x: -axes.u.x * sn + axes.v.x * cs, y: -axes.u.y * sn + axes.v.y * cs, z: -axes.u.z * sn + axes.v.z * cs };
    const apex = (h: number): Vec3 => ({ x: c.x + axes.w.x * h, y: c.y + axes.w.y * h, z: c.z + axes.w.z * h });
    const top = apex(0.24);
    const bot = apex(-0.20);
    const eq = [
      { x: c.x + u.x * 0.17, y: c.y + u.y * 0.17, z: c.z + u.z * 0.17 },
      { x: c.x + v.x * 0.17, y: c.y + v.y * 0.17, z: c.z + v.z * 0.17 },
      { x: c.x - u.x * 0.17, y: c.y - u.y * 0.17, z: c.z - u.z * 0.17 },
      { x: c.x - v.x * 0.17, y: c.y - v.y * 0.17, z: c.z - v.z * 0.17 },
    ];
    for (let k = 0; k < 4; k++) {
      const a1 = eq[k];
      const a2 = eq[(k + 1) % 4];
      for (const [p1, p2, p3, col] of [[a1, a2, top, '#67e8f9'], [a2, a1, bot, '#0e7490']] as Array<[Vec3, Vec3, Vec3, string]>) {
        const n = normalOf(p1, p2, p3);
        const centroid = { x: (p1.x + p2.x + p3.x) / 3, y: (p1.y + p2.y + p3.y) / 3, z: (p1.z + p2.z + p3.z) / 3 };
        const toCam = { x: -centroid.x, y: DIST * camera.sinE - centroid.y, z: DIST * camera.cosE - centroid.z };
        if (n.x * toCam.x + n.y * toCam.y + n.z * toCam.z <= 0) continue;
        const lit = 0.45 + 0.55 * Math.max(0, n.x * LIGHT.x + n.y * LIGHT.y + n.z * LIGHT.z);
        const proj = [project(camera, p1), project(camera, p2), project(camera, p3)];
        faces.push({
          pts: proj.map((p) => ({ x: p.x, y: p.y })),
          depth: proj.reduce((s, p) => s + p.depth, 0) / 3,
          fill: shade(col, lit),
          stroke: 'rgba(200,250,255,0.45)',
        });
      }
    }
  });

  const b = run.ball;
  const bc = boardWorld(run, b.x, BALL_R + b.y, b.z);
  const bp = project(camera, bc);
  const br = Math.max(1.5, BALL_R * bp.scale * (b.y < 0 ? Math.max(0.15, 1 + b.y / 2.2) : 1));
  faces.push({ pts: [], depth: bp.depth, fill: '', ball: { x: bp.x, y: bp.y, r: br, spin: b.spin } });

  // 墙、摆杆、宝石、球全在这一个列表里，只排一次序、只画一遍
  faces.sort((a, b2) => b2.depth - a.depth);
  for (const f of faces) {
    if (f.ball) {
      paintBall(ctx, f.ball, run.grace > 0 && run.phase === 'rolling', time);
      continue;
    }
    polygon(ctx, f.pts);
    ctx.fillStyle = f.fill;
    ctx.fill();
    if (f.stroke) {
      ctx.strokeStyle = f.stroke;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
  }
}

function paintBall(
  ctx: CanvasRenderingContext2D,
  ball: { x: number; y: number; r: number; spin: number },
  grace: boolean,
  time: number,
): void {
  const { x, y, r, spin } = ball;
  const g = ctx.createRadialGradient(x - r * 0.36, y - r * 0.42, r * 0.08, x, y, r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.22, '#dfe4f2');
  g.addColorStop(0.58, '#8b93b5');
  g.addColorStop(0.88, '#414a6b');
  g.addColorStop(1, '#1d2237');
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.strokeStyle = 'rgba(30,36,60,0.30)';
  ctx.lineWidth = Math.max(0.8, r * 0.14);
  for (let i = -1; i <= 1; i++) {
    const off = ((((spin * 0.32 + i * 0.66) % 2) + 2) % 2) - 1;
    ctx.beginPath();
    ctx.ellipse(x + off * r, y, r * 0.22, r * 0.98, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(x - r * 0.34, y - r * 0.4, r * 0.2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,212,255,0.40)';
  ctx.lineWidth = 0.9;
  ctx.stroke();
  if (grace) {
    ctx.strokeStyle = `rgba(124,92,255,${(0.25 + 0.35 * Math.sin(time * 18)).toFixed(3)})`;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(x, y, r + 2.4, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawInstruments(ctx: CanvasRenderingContext2D, opts: SceneOptions): void {
  const { viewport, run, drag, showTilt } = opts;
  if (!showTilt) return;
  const r = Math.min(26, viewport.width * 0.055);
  const cx = viewport.width - r - 14;
  const cy = viewport.height - r - 14;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(8,11,24,0.62)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(150,170,255,0.30)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.30, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(150,170,255,0.22)';
  ctx.stroke();
  // 气泡往高处跑，所以方向与倾斜相反
  const bx = cx - (run.roll / MAX_TILT) * r * 0.66;
  const by = cy - (run.pitch / MAX_TILT) * r * 0.66;
  ctx.beginPath();
  ctx.arc(bx, by, r * 0.20, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,212,255,0.85)';
  ctx.fill();

  if (drag) {
    ctx.strokeStyle = 'rgba(124,92,255,0.45)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(drag.ox, drag.oy, 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(drag.ox, drag.oy);
    ctx.lineTo(drag.x, drag.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(drag.x, drag.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(124,92,255,0.75)';
    ctx.fill();
  }
}

export function drawScene(ctx: CanvasRenderingContext2D, opts: SceneOptions): void {
  const { run } = opts;
  const axes = {
    u: boardWorld(run, 1, 0, 0),
    v: boardWorld(run, 0, 0, 1),
    w: boardWorld(run, 0, 1, 0),
  };
  drawBackground(ctx, opts);
  drawSlab(ctx, opts, axes);
  drawDecals(ctx, opts);
  drawStanding(ctx, opts, axes);
  drawInstruments(ctx, opts);
}

export type { SceneOptions };