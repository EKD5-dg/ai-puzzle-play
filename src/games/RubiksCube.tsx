import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaCube } from '../core/gameMetas';

// ============ 3D 数学工具 ============

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

const ID: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function matMul(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  return out;
}

function matVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function transpose(m: Mat3): Mat3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

/** 绕 x/y/z 轴旋转 angle 的旋转矩阵 */
function rotMat(axis: 0 | 1 | 2, ang: number): Mat3 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  if (axis === 0) return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === 1) return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

function roundVec(v: Vec3): Vec3 {
  return v.map((x) => Math.round(x)) as Vec3;
}

function roundMat(m: Mat3): Mat3 {
  return m.map((r) => r.map((x) => Math.round(x)) as Vec3) as Mat3;
}

/** 由面法线构造正交切线基：静态（整数朝向）时退化为世界轴，动画中保持面片为垂直于法线的正方形 */
function faceFrame(nw: Vec3): { t1: Vec3; t2: Vec3 } {
  const ax =
    Math.abs(nw[0]) <= Math.abs(nw[1]) && Math.abs(nw[0]) <= Math.abs(nw[2])
      ? 0
      : Math.abs(nw[1]) <= Math.abs(nw[2])
        ? 1
        : 2;
  const ref: Vec3 = ax === 0 ? [1, 0, 0] : ax === 1 ? [0, 1, 0] : [0, 0, 1];
  const t1: Vec3 = [
    ref[1] * nw[2] - ref[2] * nw[1],
    ref[2] * nw[0] - ref[0] * nw[2],
    ref[0] * nw[1] - ref[1] * nw[0],
  ];
  const t2: Vec3 = [
    nw[1] * t1[2] - nw[2] * t1[1],
    nw[2] * t1[0] - nw[0] * t1[2],
    nw[0] * t1[1] - nw[1] * t1[0],
  ];
  return { t1, t2 };
}

// ============ 魔方数据 ============

/** 六个面方向：右、左、上、下、前、后 */
const DIRS: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** 标准配色：右红、左橙、上白、下黄、前绿、后蓝 */
const FACE_RGB: number[][] = [
  [226, 92, 92],
  [244, 148, 62],
  [238, 241, 246],
  [250, 205, 66],
  [62, 189, 124],
  [70, 148, 235],
];

/** 六个面转动定义（顺时针，从面外侧观察；' 为反向） */
const FACES: Array<{ label: string; cn: string; axis: 0 | 1 | 2; layer: -1 | 0 | 1 }> = [
  { label: 'U', cn: '上', axis: 1, layer: 1 },
  { label: 'D', cn: '下', axis: 1, layer: -1 },
  { label: 'L', cn: '左', axis: 0, layer: -1 },
  { label: 'R', cn: '右', axis: 0, layer: 1 },
  { label: 'F', cn: '前', axis: 2, layer: 1 },
  { label: 'B', cn: '后', axis: 2, layer: -1 },
];

interface Cubie {
  /** 当前网格坐标（动画中为浮点，落定后为整数） */
  pos: Vec3;
  /** 累计朝向（旋转矩阵，落定后为整数矩阵） */
  rot: Mat3;
  /** 六个面方向的贴纸颜色（RGB 元组），null 表示该方向是内部面 */
  colors: (number[] | null)[];
}

function makeSolvedCube(): Cubie[] {
  const cubies: Cubie[] = [];
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        const pos: Vec3 = [x, y, z];
        const colors = DIRS.map((d, i) => {
          const comp = x * d[0] + y * d[1] + z * d[2];
          return comp === 1 ? FACE_RGB[i] : null;
        });
        cubies.push({ pos, rot: ID, colors });
      }
  return cubies;
}

/** 方块上 dirIdx 方向当前贴纸的颜色（由累计旋转反查原始朝向） */
function stickerColorAt(c: Cubie, dirIdx: number): number[] | null {
  const d = matVec(transpose(c.rot), DIRS[dirIdx]);
  const j = DIRS.findIndex((v) => v[0] === d[0] && v[1] === d[1] && v[2] === d[2]);
  return j >= 0 ? c.colors[j] : null;
}

function isSolvedCube(cube: Cubie[]): boolean {
  for (let f = 0; f < 6; f++) {
    const center = cube.find(
      (c) => c.pos[0] === DIRS[f][0] && c.pos[1] === DIRS[f][1] && c.pos[2] === DIRS[f][2],
    );
    if (!center) return false;
    const target = stickerColorAt(center, f);
    for (const c of cube) {
      if (c === center) continue;
      const onFace = c.pos[0] * DIRS[f][0] + c.pos[1] * DIRS[f][1] + c.pos[2] * DIRS[f][2] === 1;
      if (onFace && stickerColorAt(c, f) !== target) return false;
    }
  }
  return true;
}

/** 立即应用一次转动（无动画，用于打乱） */
function applyMoveInstant(cube: Cubie[], faceIdx: number, dir: 1 | -1): void {
  const face = FACES[faceIdx];
  const R = rotMat(face.axis, (dir * Math.PI) / 2);
  for (const c of cube) {
    if (c.pos[face.axis] !== face.layer) continue;
    c.pos = roundVec(matVec(R, c.pos));
    c.rot = roundMat(matMul(R, c.rot));
  }
}

interface ScrambleMove {
  f: number;
  dir: 1 | -1;
}

/** 随机打乱序列：不与上一步同面、同轴最多连续两次、各轴出现次数均匀（保证颜色充分混合） */
function genScramble(n: number): ScrambleMove[] {
  const seq: ScrambleMove[] = [];
  const axisCount = [0, 0, 0];
  let prev = -1;
  let streakAxis = -1;
  let streak = 0;
  for (let i = 0; i < n; i++) {
    // 轴轮换：优先选择出现次数最少的轴，避免同一轴转动过多导致单面颜色聚集
    const minCnt = Math.min(...axisCount);
    const axisPool = [0, 1, 2].filter((a) => axisCount[a] <= minCnt + 1);
    const cands: number[] = [];
    for (let f = 0; f < 6; f++) {
      if (f === prev) continue;
      if (FACES[f].axis === streakAxis && streak >= 2) continue;
      if (!axisPool.includes(FACES[f].axis)) continue;
      cands.push(f);
    }
    const f = cands[Math.floor(Math.random() * cands.length)];
    const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    seq.push({ f, dir });
    axisCount[FACES[f].axis]++;
    streak = FACES[f].axis === streakAxis ? streak + 1 : 1;
    streakAxis = FACES[f].axis;
    prev = f;
  }
  return seq;
}

// ============ 渲染常量 ============

const W = 420;
const H = 420;
const FOCAL = 6; // 焦距：越大透视越弱
const SCALE = 68; // 投影缩放（魔方占画布主体）
const CX = W / 2;
const CY = H / 2;
const LIGHT: Vec3 = [0.387, 0.732, 0.56]; // 视空间中的固定光源方向（已归一化）

interface Anim {
  axis: 0 | 1 | 2;
  layer: -1 | 0 | 1;
  dir: 1 | -1;
  start: number;
  dur: number;
}

interface FaceDraw {
  depth: number;
  edge: [number, number][];
  sticker: [number, number][];
  shade: number;
  rgb: number[];
}

/** 深色底座（方块塑料本体）：比背景亮、按朝向明暗着色，提供体积感 */
interface BaseDraw {
  pts: [number, number][];
  light: number;
  depth: number;
}

function fmt(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m > 0 ? `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}` : `${rest.toFixed(1)} 秒`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function quadPath(ctx: CanvasRenderingContext2D, pts: [number, number][], _r: number): void {
  const [a, b, c, d] = pts;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.lineTo(c[0], c[1]);
  ctx.lineTo(d[0], d[1]);
  ctx.closePath();
}

export default function RubiksCube() {
  const cubeRef = useRef<Cubie[]>(makeSolvedCube());
  const animRef = useRef<Anim | null>(null);
  const viewRef = useRef({ rx: -0.5, ry: -0.72 });
  const draggingRef = useRef(false);
  const lastRef = useRef({ x: 0, y: 0 });
  const startRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [status, setStatus] = useState<'idle' | 'scrambled' | 'playing' | 'solved'>('idle');
  const [moves, setMoves] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [newRecord, setNewRecord] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  const best = useBestScore(metaCube.id);
  const { toast } = useToast();

  // ============ 操作 ============

  const doMove = useCallback((faceIdx: number, dir: 1 | -1) => {
    if (animRef.current) return;
    const face = FACES[faceIdx];
    animRef.current = { axis: face.axis, layer: face.layer, dir, start: performance.now(), dur: 260 };
    sfx.move();
    if (statusRef.current === 'scrambled') {
      startRef.current = performance.now();
      setStatus('playing');
    }
  }, []);

  const scramble = useCallback(() => {
    cubeRef.current = makeSolvedCube();
    for (const { f, dir } of genScramble(22)) applyMoveInstant(cubeRef.current, f, dir);
    animRef.current = null;
    setMoves(0);
    setElapsed(0);
    setNewRecord(false);
    setStatus('scrambled');
    sfx.click();
    toast('魔方已打乱，开始还原！', 'info');
  }, [toast]);

  const reset = useCallback(() => {
    cubeRef.current = makeSolvedCube();
    animRef.current = null;
    setMoves(0);
    setElapsed(0);
    setNewRecord(false);
    setStatus('idle');
    sfx.click();
  }, []);

  // ============ 主渲染循环 ============

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const loop = () => {
      const now = performance.now();

      // 动画进度：先提交落定，再统一绘制，避免最后 1 帧视觉跳变
      let animState: { R: Mat3; axis: 0 | 1 | 2; layer: -1 | 0 | 1; bulge: number } | null = null;
      const anim = animRef.current;
      if (anim) {
        const t = Math.min(1, (now - anim.start) / anim.dur);
        const eased = t * t * (3 - 2 * t);
        const R = rotMat(anim.axis, (anim.dir * eased * Math.PI) / 2);
        // 旋转层沿垂直旋转轴方向整体轻微膨胀（sin 曲线，起止为 0），旋转过程中不露缝隙
        const bulge = 1 + 0.03 * Math.sin(Math.PI * eased);
        animState = { R, axis: anim.axis, layer: anim.layer, bulge };
        if (t >= 1) {
          const cube = cubeRef.current;
          for (const c of cube) {
            if (Math.round(c.pos[anim.axis]) !== anim.layer) continue;
            c.pos = roundVec(matVec(R, c.pos));
            c.rot = roundMat(matMul(R, c.rot));
          }
          animRef.current = null;
          animState = null;
          if (statusRef.current === 'scrambled' || statusRef.current === 'playing') {
            setMoves((m) => m + 1);
            if (isSolvedCube(cube)) {
              setElapsed(performance.now() - startRef.current);
              setStatus('solved');
            }
          }
        }
      }

      // 视角矩阵：先绕 y 再绕 x
      const view = viewRef.current;
      const V = matMul(rotMat(0, view.rx), rotMat(1, view.ry));

      // 面片：base（塑料底座，所有 6 个面都画，保证任何表面位置不空洞）
      //       + 贴纸（彩色，只画有贴纸且朝向相机的面；全背对时强制补一张）
      const bases: BaseDraw[] = [];
      const faces: FaceDraw[] = [];
      for (const c of cubeRef.current) {
        let pos = c.pos;
        let rot = c.rot;
        // 圆柱外扩：旋转层 cubie 仅沿垂直旋转轴方向膨胀，动画中与静止层保持密接
        let exp = (p: Vec3): Vec3 => p;
        if (animState && Math.round(c.pos[animState.axis]) === animState.layer) {
          pos = matVec(animState.R, c.pos);
          rot = matMul(animState.R, c.rot);
          const b = animState.bulge;
          const ax = animState.axis;
          exp = (p) =>
            ax === 0
              ? ([p[0], p[1] * b, p[2] * b] as Vec3)
              : ax === 1
                ? ([p[0] * b, p[1], p[2] * b] as Vec3)
                : ([p[0] * b, p[1] * b, p[2]] as Vec3);
        }
        // 1) 底座：cubie 的全部 6 个面（内部面会被相邻 cubie 的贴纸覆盖，表面无贴纸处露出塑料）
        for (let i = 0; i < 6; i++) {
          const nw = matVec(rot, DIRS[i]);
          const n = matVec(V, nw);
          if (n[2] >= 0.001) continue; // 背对相机的底座面不画
          const { t1, t2 } = faceFrame(nw);
          const center: Vec3 = [pos[0] + nw[0] * 0.5, pos[1] + nw[1] * 0.5, pos[2] + nw[2] * 0.5];
          const cornersV = (ins: number): Vec3[] =>
            [
              [center[0] + (t1[0] + t2[0]) * ins, center[1] + (t1[1] + t2[1]) * ins, center[2] + (t1[2] + t2[2]) * ins],
              [center[0] + (t1[0] - t2[0]) * ins, center[1] + (t1[1] - t2[1]) * ins, center[2] + (t1[2] - t2[2]) * ins],
              [center[0] - (t1[0] + t2[0]) * ins, center[1] - (t1[1] + t2[1]) * ins, center[2] - (t1[2] + t2[2]) * ins],
              [center[0] - (t1[0] - t2[0]) * ins, center[1] - (t1[1] - t2[1]) * ins, center[2] - (t1[2] - t2[2]) * ins],
            ].map((p) => matVec(V, exp(p as Vec3)));
          const project = (vs: Vec3[]): [number, number][] =>
            vs.map((v) => {
              const s = FOCAL / (FOCAL + v[2]);
              return [CX + v[0] * SCALE * s, CY - v[1] * SCALE * s];
            }) as [number, number][];
          const light = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
          const baseV = cornersV(0.5);
          const depth = (baseV[0][2] + baseV[1][2] + baseV[2][2] + baseV[3][2]) / 4;
          bases.push({ pts: project(baseV), light, depth });
        }
        // 2) 贴纸：按"朝向相机程度"排序，画所有朝向相机的面；
        //    若某 cubie 最朝相机的面恰好没有贴纸（打乱后的合法状态），
        //    用该 cubie 的其他贴纸颜色填充（伪贴纸），保证表面任何位置都有颜色
        const firstColorIdx = [0, 1, 2, 3, 4, 5].find((i) => c.colors[i] != null) ?? 2;
        const allFaces: Array<{ i: number; nw: Vec3; n: Vec3 }> = [];
        for (let i = 0; i < 6; i++) {
          const nw = matVec(rot, DIRS[i]);
          allFaces.push({ i, nw, n: matVec(V, nw) });
        }
        allFaces.sort((a, b) => a.n[2] - b.n[2]);
        let drawnAny = false;
        for (const { i, nw, n } of allFaces) {
          if (n[2] >= 0.001 && drawnAny) continue;
          drawnAny = true;
          const rgbIdx = c.colors[i] != null ? i : firstColorIdx;
          const { t1, t2 } = faceFrame(nw);
          const center: Vec3 = [pos[0] + nw[0] * 0.5, pos[1] + nw[1] * 0.5, pos[2] + nw[2] * 0.5];
          // 面片四角（世界坐标 → 视空间），再投影到屏幕
          const cornersV = (ins: number): Vec3[] =>
            [
              [center[0] + (t1[0] + t2[0]) * ins, center[1] + (t1[1] + t2[1]) * ins, center[2] + (t1[2] + t2[2]) * ins],
              [center[0] + (t1[0] - t2[0]) * ins, center[1] + (t1[1] - t2[1]) * ins, center[2] + (t1[2] - t2[2]) * ins],
              [center[0] - (t1[0] + t2[0]) * ins, center[1] - (t1[1] + t2[1]) * ins, center[2] - (t1[2] + t2[2]) * ins],
              [center[0] - (t1[0] - t2[0]) * ins, center[1] - (t1[1] - t2[1]) * ins, center[2] - (t1[2] - t2[2]) * ins],
            ].map((p) => matVec(V, exp(p as Vec3)));
          const project = (vs: Vec3[]): [number, number][] =>
            vs.map((v) => {
              const s = FOCAL / (FOCAL + v[2]);
              return [CX + v[0] * SCALE * s, CY - v[1] * SCALE * s];
            }) as [number, number][];
          const baseV = cornersV(0.5);
          const depth = (baseV[0][2] + baseV[1][2] + baseV[2][2] + baseV[3][2]) / 4;
          const light = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
          const shade = 0.66 + 0.34 * light;
          faces.push({
            depth,
            edge: project(cornersV(0.466)),
            sticker: project(cornersV(0.46)),
            shade,
            rgb: FACE_RGB[rgbIdx],
          });
        }
      }
      // 统一按深度从远到近绘制（底座与贴纸混排，同面的贴纸微调更近，保证盖在底座上）
      // 解决旋转动画中层与层穿插时底座/贴纸遮挡错误导致的闪烁
      const items: Array<{ depth: number; base?: BaseDraw; face?: FaceDraw }> = [
        ...bases.map((b) => ({ depth: b.depth, base: b })),
        ...faces.map((f) => ({ depth: f.depth - 0.002, face: f })),
      ];
      items.sort((a, b) => b.depth - a.depth);

      ctx.setTransform(canvas.width / W, 0, 0, canvas.width / W, 0, 0);
      ctx.clearRect(0, 0, W, H);
      for (const it of items) {
        if (it.base) {
          const k = 0.85 + 0.55 * it.base.light;
          ctx.fillStyle = `rgb(${Math.round(16 * k)},${Math.round(19 * k)},${Math.round(36 * k)})`;
          quadPath(ctx, it.base.pts, 0);
          ctx.fill();
        } else if (it.face) {
          const f = it.face;
          const edge = f.rgb.map((v) => Math.round(v * 0.52));
          ctx.fillStyle = `rgb(${edge[0]},${edge[1]},${edge[2]})`;
          quadPath(ctx, f.edge, 4);
          ctx.fill();
          const lit = f.rgb.map((v) => Math.min(255, Math.round(v * f.shade)));
          ctx.fillStyle = `rgb(${lit[0]},${lit[1]},${lit[2]})`;
          quadPath(ctx, f.sticker, 3);
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ============ 计时 ============

  useEffect(() => {
    if (status !== 'playing') return;
    const t = window.setInterval(() => {
      setElapsed(performance.now() - startRef.current);
    }, 100);
    return () => window.clearInterval(t);
  }, [status]);

  // ============ 还原成功 ============

  useEffect(() => {
    if (status !== 'solved') return;
    sfx.win();
    toast(`🎉 还原成功！用时 ${fmt(elapsed)}`, 'success');
    const isNew = best.updateBest(Math.round(elapsed), (a, b) => a < b);
    setNewRecord(isNew);
    if (isNew) {
      sfx.record();
      toast('🏆 新纪录！最快还原时间', 'record');
    }
  }, [status, elapsed, best, toast]);

  // ============ 键盘 ============

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      const idx = 'udlrfb'.indexOf(k.toLowerCase());
      if (idx >= 0 && k.length === 1) {
        e.preventDefault();
        doMove(idx, k === k.toLowerCase() ? 1 : -1);
        return;
      }
      if (k === 'ArrowLeft') {
        e.preventDefault();
        viewRef.current.ry -= 0.3;
      } else if (k === 'ArrowRight') {
        e.preventDefault();
        viewRef.current.ry += 0.3;
      } else if (k === 'ArrowUp') {
        e.preventDefault();
        viewRef.current.rx = clamp(viewRef.current.rx - 0.3, -1.3, 1.3);
      } else if (k === 'ArrowDown') {
        e.preventDefault();
        viewRef.current.rx = clamp(viewRef.current.rx + 0.3, -1.3, 1.3);
      } else if (k === 's' || k === 'S') {
        e.preventDefault();
        scramble();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doMove, scramble]);

  // ============ 触控 / 鼠标旋转视角 ============

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    draggingRef.current = true;
    lastRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - lastRef.current.x;
    const dy = e.clientY - lastRef.current.y;
    lastRef.current = { x: e.clientX, y: e.clientY };
    viewRef.current.ry += dx * 0.01;
    viewRef.current.rx = clamp(viewRef.current.rx + dy * 0.01, -1.3, 1.3);
  };
  const onPointerUp = () => {
    draggingRef.current = false;
  };

  return (
    <GameShell
      meta={metaCube}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>步数</span>
            <strong>{moves}</strong>
          </div>
          <div className="stat-box">
            <span>用时</span>
            <strong>{fmt(elapsed)}</strong>
          </div>
          <div className="stat-box">
            <span>{metaCube.bestScoreLabel}</span>
            <strong>{best.value != null ? fmt(best.value) : '—'}</strong>
          </div>
        </>
      }
    >
      <div className="cube">
        <div className="cube-stage">
          <canvas
            ref={canvasRef}
            className="cube-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {status === 'idle' && (
            <div className="cube-overlay">
              <h2>🧊 3D 魔方</h2>
              <p>
                拖动旋转视角 · 点击下方按钮转动对应层
                <br />
                上/下/左/右/前/后 = 六个面，⟳ 顺时针 · ⟲ 逆时针
                <br />
                打乱后开始计时，还原六面颜色！
              </p>
              <button className="btn btn-primary" onClick={scramble}>
                🎲 打乱魔方
              </button>
            </div>
          )}
          {status === 'solved' && (
            <div className="cube-overlay">
              <h2>🎉 还原成功！</h2>
              <p>
                用时 {fmt(elapsed)} · {moves} 步{newRecord ? ' · 🏆 新纪录！' : ''}
              </p>
              <button className="btn btn-primary" onClick={scramble}>
                🔄 再来一局
              </button>
            </div>
          )}
        </div>
        <div className="cube-controls">
          {FACES.map((f, i) => (
            <button key={f.label} className="cube-btn" title={`${f.cn}层顺时针旋转`} onClick={() => doMove(i, 1)}>
              <span className="cube-btn-key">{f.label}</span>
              <span className="cube-btn-cn">{f.cn} ⟳</span>
            </button>
          ))}
          {FACES.map((f, i) => (
            <button
              key={`${f.label}'`}
              className="cube-btn cube-btn-prime"
              title={`${f.cn}层逆时针旋转`}
              onClick={() => doMove(i, -1)}
            >
              <span className="cube-btn-key">{f.label}′</span>
              <span className="cube-btn-cn">{f.cn} ⟲</span>
            </button>
          ))}
        </div>
        <div className="cube-actions">
          <button className="btn btn-primary" onClick={scramble}>
            🎲 打乱
          </button>
          <button className="btn btn-ghost" onClick={reset}>
            ↺ 重置
          </button>
        </div>
        <p className="hint">拖动旋转视角 · 按钮 ⟳ 顺时针 / ⟲ 逆时针 · 键盘 U/D/L/R/F/B 转动（Shift 反向）· S 打乱 · 方向键旋转视角</p>
      </div>
    </GameShell>
  );
}
