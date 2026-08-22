import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaStack3D } from '../core/gameMetas';

// ============ 常量 ============

/** 内部渲染分辨率（4:3） */
const RW = 480;
const RH = 360;
const CX = RW / 2;
const CY = RH * 0.44;
const FOCAL = 340;
/** 相机到注视点的距离（俯视斜角固定机位，随塔身升高） */
const CAMD = 11;
const YAW = Math.PI / 6;
const COSY = Math.cos(YAW);
const SINY = Math.sin(YAW);
const PITCH = 0.42;
const COSP = Math.cos(PITCH);
const SINP = Math.sin(PITCH);

const LAYER_H = 0.55;
/** 初始方块边长 / 滑动幅度 */
const BASE = 2.4;
const AMP = 2.7;
/** 初速 / 极限速度 / 每层加速 */
const V0 = 2.2;
const VMAX = 5;
const ACC = 0.05;
/** 完美对齐容差 / 回涨尺寸 */
const EPS = 0.13;
const GROW = 0.08;
const GRAV = 20;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 一层方块：中心 x/z + 底面尺寸（首层为基座，顶面 y=0） */
interface Layer {
  x: number;
  z: number;
  w: number;
  d: number;
}

interface Debris {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  vx: number;
  vy: number;
  vz: number;
}

/** 完美对齐时在方块层面扩散的白色描边框 */
interface Ring {
  x: number;
  z: number;
  w: number;
  d: number;
  y: number;
  t0: number;
}

interface Star {
  x: number;
  y: number;
  r: number;
  tw: number;
  ph: number;
}

interface Cloud {
  x: number;
  y: number;
  s: number;
  v: number;
}

interface World {
  /** tower[0] 为基座（只渲染加大版），实际成绩 = tower.length - 1 */
  tower: Layer[];
  /** 当前滑动轴 */
  axis: 'x' | 'z';
  mover: { pos: number; dir: number; w: number; d: number };
  speed: number;
  /** 下一块的起始侧（交替往返） */
  side: number;
  /** 相机注视高度（平滑追随塔顶） */
  focusY: number;
  debris: Debris[];
  rings: Ring[];
  combo: number;
  bestCombo: number;
  stars: Star[];
  clouds: Cloud[];
  perfectAt: number;
  shakeAt: number;
}

function newWorld(): World {
  const stars: Star[] = [];
  for (let i = 0; i < 46; i++) {
    stars.push({ x: Math.random() * RW, y: Math.random() * RH * 0.75, r: 0.5 + Math.random() * 1.1, tw: 1.5 + Math.random() * 3, ph: Math.random() * 7 });
  }
  const clouds: Cloud[] = [];
  for (let i = 0; i < 5; i++) {
    clouds.push({ x: Math.random() * RW, y: 30 + Math.random() * 190, s: 0.6 + Math.random() * 0.8, v: 3 + Math.random() * 5 });
  }
  return {
    tower: [{ x: 0, z: 0, w: BASE, d: BASE }],
    axis: 'x',
    mover: { pos: -AMP, dir: 1, w: BASE, d: BASE },
    speed: V0,
    side: 1,
    focusY: 0.6,
    debris: [],
    rings: [],
    combo: 0,
    bestCombo: 0,
    stars,
    clouds,
    perfectAt: -9,
    shakeAt: -9,
  };
}

/** 天空调色板：随层数白天 → 黄昏 → 暮色 → 深夜 → 深空 */
const SKY: Array<{ n: number; top: [number, number, number]; bot: [number, number, number] }> = [
  { n: 0, top: [110, 190, 244], bot: [214, 240, 255] },
  { n: 12, top: [244, 168, 106], bot: [255, 219, 168] },
  { n: 24, top: [96, 74, 156], bot: [232, 138, 158] },
  { n: 40, top: [20, 26, 68], bot: [74, 62, 134] },
  { n: 60, top: [8, 10, 36], bot: [32, 30, 84] },
];

function skyColors(n: number): [string, string] {
  let i = 0;
  while (i < SKY.length - 2 && n >= SKY[i + 1].n) i++;
  const a = SKY[i];
  const b = SKY[i + 1];
  const k = clamp((n - a.n) / (b.n - a.n), 0, 1);
  const mix = (u: [number, number, number], v: [number, number, number]) =>
    `rgb(${Math.round(u[0] + (v[0] - u[0]) * k)},${Math.round(u[1] + (v[1] - u[1]) * k)},${Math.round(u[2] + (v[2] - u[2]) * k)})`;
  return [mix(a.top, b.top), mix(a.bot, b.bot)];
}

/** 盒子六面：法线 + 4 角索引（沿周界）+ 受光系数（顶最亮、底最暗） */
const FACES: Array<{ n: [number, number, number]; idx: [number, number, number, number]; sh: number }> = [
  { n: [1, 0, 0], idx: [1, 5, 6, 2], sh: 0.86 },
  { n: [-1, 0, 0], idx: [0, 3, 7, 4], sh: 0.66 },
  { n: [0, 1, 0], idx: [3, 2, 6, 7], sh: 1 },
  { n: [0, -1, 0], idx: [0, 1, 5, 4], sh: 0.42 },
  { n: [0, 0, 1], idx: [4, 7, 6, 5], sh: 0.92 },
  { n: [0, 0, -1], idx: [0, 1, 2, 3], sh: 0.6 },
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

type Status = 'ready' | 'playing' | 'paused' | 'over';

export default function Stack3D() {
  const [status, setStatus] = useState<Status>('ready');
  const [score, setScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [newRecord, setNewRecord] = useState(false);
  const best = useBestScore(metaStack3D.id);
  const { toast } = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(newWorld());
  const statusRef = useRef<Status>('ready');
  const overHandledRef = useRef(false);

  statusRef.current = status;

  const start = useCallback(() => {
    worldRef.current = newWorld();
    overHandledRef.current = false;
    setScore(0);
    setBestCombo(0);
    setNewRecord(false);
    setStatus('playing');
  }, []);

  const togglePause = useCallback(() => {
    const s = statusRef.current;
    if (s === 'playing') setStatus('paused');
    else if (s === 'paused') setStatus('playing');
  }, []);

  // ============ 落块判定 ============

  const placeBlock = () => {
    if (statusRef.current !== 'playing') return;
    const w = worldRef.current;
    const t = performance.now() / 1000;
    const top = w.tower[w.tower.length - 1];
    const a = w.axis;
    const curSize = a === 'x' ? w.mover.w : w.mover.d;
    const prevC = a === 'x' ? top.x : top.z;
    const delta = w.mover.pos - prevC;
    const ad = Math.abs(delta);
    const lvl = w.tower.length - 1;
    const y0 = lvl * LAYER_H;
    const y1 = y0 + LAYER_H;
    // 移动方块的完整底面范围
    const mCx = a === 'x' ? w.mover.pos : top.x;
    const mCz = a === 'z' ? w.mover.pos : top.z;

    if (ad >= curSize) {
      // —— 完全脱靶：整块坠落，游戏结束 ——
      w.debris.push({
        x0: mCx - w.mover.w / 2,
        x1: mCx + w.mover.w / 2,
        y0,
        y1,
        z0: mCz - w.mover.d / 2,
        z1: mCz + w.mover.d / 2,
        vx: a === 'x' ? Math.sign(delta) * 1.4 : 0,
        vz: a === 'z' ? Math.sign(delta) * 1.4 : 0,
        vy: 0,
      });
      w.shakeAt = t;
      sfx.lose();
      statusRef.current = 'over';
      setStatus('over');
      return;
    }

    let nx = mCx;
    let nz = mCz;
    let nw = w.mover.w;
    let nd = w.mover.d;

    if (ad <= EPS) {
      // —— 完美对齐：吸附归位，连击回涨 ——
      if (a === 'x') {
        nx = prevC;
        nw = curSize;
      } else {
        nz = prevC;
        nd = curSize;
      }
      w.combo += 1;
      w.bestCombo = Math.max(w.bestCombo, w.combo);
      if (w.combo >= 2) {
        nw = Math.min(BASE, nw + GROW);
        nd = Math.min(BASE, nd + GROW);
      }
      w.rings.push({ x: nx, z: nz, w: nw, d: nd, y: y1, t0: t });
      w.perfectAt = t;
      sfx.match();
      if (w.combo % 5 === 0) toast(`🎯 完美连击 ×${w.combo}！方块回涨`, 'success');
    } else {
      // —— 部分重叠：切掉悬空部分使其坠落 ——
      const ks = curSize - ad;
      const kc = prevC + delta / 2;
      const cc = kc + Math.sign(delta) * (ks / 2 + ad / 2);
      const dx0 = a === 'x' ? cc - ad / 2 : mCx - w.mover.w / 2;
      const dx1 = a === 'x' ? cc + ad / 2 : mCx + w.mover.w / 2;
      const dz0 = a === 'z' ? cc - ad / 2 : mCz - w.mover.d / 2;
      const dz1 = a === 'z' ? cc + ad / 2 : mCz + w.mover.d / 2;
      w.debris.push({
        x0: dx0,
        x1: dx1,
        y0,
        y1,
        z0: dz0,
        z1: dz1,
        vx: a === 'x' ? Math.sign(delta) * 1.1 : 0,
        vz: a === 'z' ? Math.sign(delta) * 1.1 : 0,
        vy: 0,
      });
      if (a === 'x') {
        nx = kc;
        nw = ks;
      } else {
        nz = kc;
        nd = ks;
      }
      w.combo = 0;
      sfx.drop();
    }

    w.tower.push({ x: nx, z: nz, w: nw, d: nd });
    w.side = -w.side;
    w.axis = a === 'x' ? 'z' : 'x';
    w.speed = Math.min(VMAX, V0 + (w.tower.length - 1) * ACC);
    w.mover = { pos: -w.side * AMP, dir: w.side, w: nw, d: nd };

    const sc = w.tower.length - 1;
    setScore(sc);
    setBestCombo(w.bestCombo);
    if (sc % 10 === 0) {
      toast(`🗼 已堆到 ${sc} 层！`, 'success');
      sfx.clear();
    }
  };

  const placeRef = useRef(placeBlock);
  placeRef.current = placeBlock;

  // ============ 键盘 ============

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.code;
      if (e.key.startsWith('Arrow') || e.key === ' ') e.preventDefault();
      if (k === 'KeyP') togglePause();
      else if (k === 'Enter') {
        const s = statusRef.current;
        if (s === 'ready' || s === 'over') start();
        else if (!e.repeat) placeRef.current();
      } else if ((k === 'Space' || k === 'ArrowDown') && !e.repeat) {
        if (statusRef.current === 'ready' || statusRef.current === 'over') start();
        else placeRef.current();
      }
    };
    // 失焦自动暂停
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
  }, [start, togglePause]);

  // ============ 主循环（常驻 rAF：ready/over 也渲染塔身作背景） ============

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // HiDPI 按 DPR 放大 backing store（封顶 2 控性能），逻辑坐标仍用 RW×RH
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = RW * dpr;
    canvas.height = RH * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /**
     * 世界坐标 → 屏幕：先绕 Y 轴偏航，再绕 X 轴俯视，最后透视除法。
     * 相机位于注视点后上方（视图空间 (0,0,-CAMD)，fy 为注视高度）。
     */
    const rot = (x: number, y: number, z: number, fy: number) => {
      const rx = x * COSY - z * SINY;
      const rz = x * SINY + z * COSY;
      const dy = y - fy;
      return { rx, vy: dy * COSP + rz * SINP, vz: -dy * SINP + rz * COSP };
    };
    const proj = (x: number, y: number, z: number, fy: number) => {
      const r = rot(x, y, z, fy);
      const s = FOCAL / (r.vz + CAMD);
      return { x: CX + r.rx * s, y: CY - r.vy * s, s };
    };

    interface Face {
      depth: number;
      pts: Array<[number, number]>;
      style: string;
    }

    /** 绘制一个轴对齐盒子：背面剔除 + 可见面按深度排序 */
    // 角点深度缓存（drawBox 每次绘制时填充，供可见面按深度排序）
    const depths = new Array<number>(8).fill(0);
    const drawBox = (
      x0: number,
      x1: number,
      y0: number,
      y1: number,
      z0: number,
      z1: number,
      fy: number,
      h: number,
      sat: number,
      lig: number,
      alpha = 1,
    ) => {
      // 8 个角点投影（同时记录深度供面排序）
      const px: number[] = [];
      const py: number[] = [];
      CORNERS.forEach(([bxx, byy, bzz], i) => {
        const cx = bxx ? x1 : x0;
        const cy = byy ? y1 : y0;
        const cz = bzz ? z1 : z0;
        const r = rot(cx, cy, cz, fy);
        const s = FOCAL / (r.vz + CAMD);
        px.push(CX + r.rx * s);
        py.push(CY - r.vy * s);
        depths[i] = r.vz + CAMD;
      });
      // 面心与视线（相机在视图空间 (0,0,-CAMD)）
      const ctr = rot((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, fy);
      const faces: Face[] = [];
      for (const f of FACES) {
        const nr = rot(f.n[0], f.n[1], f.n[2], 0);
        const vv = ctr.vz + CAMD;
        if (nr.rx * ctr.rx + nr.vy * ctr.vy + nr.vz * vv >= 0) continue;
        const [i0, i1, i2, i3] = f.idx;
        const pts: Array<[number, number]> = [
          [px[i0], py[i0]],
          [px[i1], py[i1]],
          [px[i2], py[i2]],
          [px[i3], py[i3]],
        ];
        faces.push({
          depth: (depths[i0] + depths[i1] + depths[i2] + depths[i3]) / 4,
          pts,
          style: `hsl(${h} ${sat}% ${Math.round(lig * f.sh)}%)`,
        });
      }
      faces.sort((a, b) => b.depth - a.depth);
      ctx.globalAlpha = alpha;
      for (const f of faces) {
        ctx.fillStyle = f.style;
        ctx.beginPath();
        ctx.moveTo(f.pts[0][0], f.pts[0][1]);
        for (let i = 1; i < 4; i++) ctx.lineTo(f.pts[i][0], f.pts[i][1]);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(15,20,35,0.22)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    let raf = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const w = worldRef.current;
      const playing = statusRef.current === 'playing';
      const t = now / 1000;
      const sc = w.tower.length - 1;
      const nightK = clamp((sc - 22) / 16, 0, 1);

      // ---- 更新 ----
      if (playing) {
        // 注视点平滑追随塔顶
        const targetY = (w.tower.length - 1) * LAYER_H;
        w.focusY += (targetY - w.focusY) * Math.min(1, dt * 3.2);

        // 滑动块往返
        const m = w.mover;
        m.pos += m.dir * w.speed * dt;
        if (m.pos > AMP) {
          m.pos = AMP;
          m.dir = -1;
        } else if (m.pos < -AMP) {
          m.pos = -AMP;
          m.dir = 1;
        }
      }

      // ---- 坠落碎块物理与光环清理（结束瞬间也要继续坠落；暂停时冻结） ----
      if (playing || statusRef.current === 'over') {
        for (let i = w.debris.length - 1; i >= 0; i--) {
          const db = w.debris[i];
          db.vy -= GRAV * dt;
          db.y0 += db.vy * dt;
          db.y1 += db.vy * dt;
          db.x0 += db.vx * dt;
          db.x1 += db.vx * dt;
          db.z0 += db.vz * dt;
          db.z1 += db.vz * dt;
          if (db.y1 < w.focusY - 9) w.debris.splice(i, 1);
        }
        w.rings = w.rings.filter((r) => t - r.t0 < 0.55);
      }

      // ---- 渲染 ----
      const fy = w.focusY;
      const shakeK = Math.max(0, 1 - (t - w.shakeAt) * 3);
      ctx.save();
      if (shakeK > 0) ctx.translate((Math.random() - 0.5) * 8 * shakeK, (Math.random() - 0.5) * 6 * shakeK);

      // 天空渐变
      const [ctop, cbot] = skyColors(sc);
      const sky = ctx.createLinearGradient(0, 0, 0, RH);
      sky.addColorStop(0, ctop);
      sky.addColorStop(1, cbot);
      ctx.fillStyle = sky;
      ctx.fillRect(-8, -8, RW + 16, RH + 16);

      // 星星（夜晚淡入）
      if (nightK > 0.02) {
        for (const st of w.stars) {
          const a = nightK * (0.45 + 0.55 * Math.abs(Math.sin(t * st.tw + st.ph)));
          ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 太阳（昼）/ 月亮（夜）交叉淡化
      const sx = RW * 0.79;
      const sy = RH * 0.18;
      if (nightK < 0.98) {
        const glow = ctx.createRadialGradient(sx, sy, 4, sx, sy, 44);
        glow.addColorStop(0, `rgba(255,246,214,${(0.9 * (1 - nightK)).toFixed(3)})`);
        glow.addColorStop(1, 'rgba(255,246,214,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(sx - 44, sy - 44, 88, 88);
      }
      if (nightK > 0.02) {
        ctx.globalAlpha = nightK;
        ctx.fillStyle = '#e8ecf5';
        ctx.beginPath();
        ctx.arc(sx, sy, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = ctop;
        ctx.beginPath();
        ctx.arc(sx + 6, sy - 4, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // 云（夜晚淡出；相机上升时缓缓下移形成爬升感）
      const cloudA = 0.75 * (1 - nightK * 0.92);
      if (cloudA > 0.03) {
        ctx.fillStyle = `rgba(255,255,255,${cloudA.toFixed(3)})`;
        for (const c of w.clouds) {
          const cxp = ((c.x + t * c.v) % (RW + 120)) - 60;
          const cyp = (((c.y - fy * 7) % (RH + 90)) + RH + 90) % (RH + 90) - 45;
          for (const [ox, oy, rr] of [
            [-16, 3, 11],
            [0, -3, 14],
            [15, 4, 10],
          ] as const) {
            ctx.beginPath();
            ctx.arc(cxp + ox * c.s, cyp + oy * c.s, rr * c.s, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // ---- 塔身：底 → 顶画家序 ----
      const top = w.tower[w.tower.length - 1];
      const drawLayer = (ly: Layer, lvl: number, isBase: boolean) => {
        // 数组下标 i 的物理占位是 [(i-1)·LAYER_H, i·LAYER_H]（基座顶面 y=0 向下延伸），
        // 与 placeBlock 的 y0/y1、滑块 my0、光环与碎块的 y 一致，错一层就会视觉穿插
        const y1 = lvl * LAYER_H;
        const y0 = isBase ? -7 : y1 - LAYER_H;
        if (y1 < fy - 10 || y0 > fy + 6) return;
        const grow = isBase ? 0.5 : 0;
        const hue = isBase ? 218 : (lvl * 14 + 165) % 360;
        const sat = isBase ? 16 : 62;
        const lig = isBase ? 56 : 57;
        drawBox(ly.x - ly.w / 2 - grow, ly.x + ly.w / 2 + grow, y0, y1, ly.z - ly.d / 2 - grow, ly.z + ly.d / 2 + grow, fy, hue, sat, lig);
      };
      const from = Math.max(0, w.tower.length - 26);
      for (let i = 0; i < w.tower.length; i++) {
        if (i < from && i !== 0) continue;
        drawLayer(w.tower[i], i, i === 0);
      }

      // ---- 落点引导影（移动块与塔顶的重叠区投影在顶面上） ----
      if (playing) {
        const gy = (w.tower.length - 1) * LAYER_H + 0.012;
        const a = w.axis;
        const curSize = a === 'x' ? w.mover.w : w.mover.d;
        const pc = a === 'x' ? top.x : top.z;
        const lo = Math.max(w.mover.pos - curSize / 2, pc - curSize / 2);
        const hi = Math.min(w.mover.pos + curSize / 2, pc + curSize / 2);
        if (hi > lo) {
          const ox0 = a === 'x' ? lo : top.x - top.w / 2;
          const ox1 = a === 'x' ? hi : top.x + top.w / 2;
          const oz0 = a === 'z' ? lo : top.z - top.d / 2;
          const oz1 = a === 'z' ? hi : top.z + top.d / 2;
          const q = [proj(ox0, gy, oz0, fy), proj(ox1, gy, oz0, fy), proj(ox1, gy, oz1, fy), proj(ox0, gy, oz1, fy)];
          ctx.fillStyle = 'rgba(10,16,32,0.32)';
          ctx.beginPath();
          ctx.moveTo(q[0].x, q[0].y);
          for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // ---- 坠落碎块 ----
      const dbs = [...w.debris].sort((a, b) => {
        const ca = rot((a.x0 + a.x1) / 2, 0, (a.z0 + a.z1) / 2, fy);
        const cb = rot((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2, fy);
        return cb.vz - ca.vz;
      });
      for (const db of dbs) {
        const fade = clamp((db.y1 - (fy - 9)) / 4, 0.25, 1);
        drawBox(db.x0, db.x1, db.y0, db.y1, db.z0, db.z1, fy, 210, 30, 52, fade);
      }

      // ---- 移动中的方块（最高层，最后绘制） ----
      if (statusRef.current !== 'over') {
        const my0 = (w.tower.length - 1) * LAYER_H;
        const mhue = (w.tower.length * 14 + 165) % 360;
        drawBox(
          (w.axis === 'x' ? w.mover.pos : top.x) - w.mover.w / 2,
          (w.axis === 'x' ? w.mover.pos : top.x) + w.mover.w / 2,
          my0,
          my0 + LAYER_H,
          (w.axis === 'z' ? w.mover.pos : top.z) - w.mover.d / 2,
          (w.axis === 'z' ? w.mover.pos : top.z) + w.mover.d / 2,
          fy,
          mhue,
          68,
          60,
        );
      }

      // ---- 完美光环 ----
      for (const r of w.rings) {
        const p = (t - r.t0) / 0.55;
        const g = 1 + 0.55 * p;
        const q = [
          proj(r.x - (r.w / 2) * g, r.y + 0.02, r.z - (r.d / 2) * g, fy),
          proj(r.x + (r.w / 2) * g, r.y + 0.02, r.z - (r.d / 2) * g, fy),
          proj(r.x + (r.w / 2) * g, r.y + 0.02, r.z + (r.d / 2) * g, fy),
          proj(r.x - (r.w / 2) * g, r.y + 0.02, r.z + (r.d / 2) * g, fy),
        ];
        ctx.strokeStyle = `rgba(255,255,255,${(0.9 * (1 - p)).toFixed(3)})`;
        ctx.lineWidth = 1 + 2.5 * (1 - p);
        ctx.beginPath();
        ctx.moveTo(q[0].x, q[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
        ctx.closePath();
        ctx.stroke();
      }

      // 完美提示字
      const pk = Math.max(0, 1 - (t - w.perfectAt) * 2.6);
      if (pk > 0) {
        ctx.font = '700 19px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = `rgba(255,255,255,${pk.toFixed(3)})`;
        ctx.fillText('完美!', CX, CY - 66 - (1 - pk) * 16);
      }

      // 画布内 HUD（ready 态隐藏）
      if (statusRef.current !== 'ready') {
        ctx.textAlign = 'left';
        ctx.font = '700 15px system-ui, sans-serif';
        ctx.fillStyle = nightK > 0.5 ? 'rgba(255,255,255,0.92)' : 'rgba(20,32,60,0.85)';
        ctx.fillText(`🗼 ${sc} 层`, 12, 24);
        if (w.combo > 1) {
          ctx.fillStyle = '#ffb020';
          ctx.fillText(`🔥 连击 ×${w.combo}`, 12, 43);
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
    const sc = worldRef.current.tower.length - 1;
    const isNew = sc > 0 && best.updateBest(sc, (a, b) => a > b);
    setNewRecord(isNew);
    if (isNew) {
      sfx.record();
      toast(`🏆 新纪录！${sc} 层`, 'record');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <GameShell
      meta={metaStack3D}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>层数</span>
            <strong>{score}</strong>
          </div>
          <div className="stat-box">
            <span>连击</span>
            <strong>{bestCombo > 0 ? `×${bestCombo}` : '—'}</strong>
          </div>
          <div className="stat-box">
            <span>{metaStack3D.bestScoreLabel}</span>
            <strong>{best.value != null ? best.value : '—'}</strong>
          </div>
        </>
      }
    >
      <div className="stk">
        <div className="stk-stage">
          <canvas
            ref={canvasRef}
            className="stk-canvas"
            role="img"
            aria-label="3D 层层叠游戏画面"
            onPointerDown={() => {
              if (statusRef.current === 'playing') placeRef.current();
            }}
          />
          {status === 'ready' && (
            <div className="stk-overlay" onClick={start}>
              <h2>🗼 3D 层层叠</h2>
              <p>
                方块在高空来回滑行，看准时机把它放下——
                <br />
                超出下层的部分会被切落，对齐越准塔越稳！
                <br />
                完美对齐触发连击，连击还会让方块逐渐回涨。
              </p>
              <p className="stk-keys">点击画面 / 空格 落下方块 · P 暂停</p>
              <button className="btn btn-primary" onClick={start}>
                开始堆塔
              </button>
            </div>
          )}
          {status === 'paused' && (
            <div className="stk-overlay">
              <h2>⏸ 已暂停</h2>
              <button className="btn btn-primary" onClick={togglePause}>
                继续
              </button>
            </div>
          )}
          {status === 'over' && (
            <div className="stk-overlay" onClick={start}>
              <h2>🏁 塔倒了</h2>
              <p>
                最终 {score} 层 · 最高连击 ×{bestCombo}
                {newRecord ? ' · 🏆 新纪录！' : best.value != null ? ` · 最佳 ${best.value} 层` : ''}
              </p>
              <button className="btn btn-primary" onClick={start}>
                再来一次
              </button>
            </div>
          )}
        </div>
        <div className="stk-actions">
          <button className="btn btn-ghost" onClick={togglePause} disabled={status !== 'playing' && status !== 'paused'}>
            {status === 'paused' ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button className="btn btn-ghost" onClick={start}>
            🔄 重新开始
          </button>
        </div>
        <p className="hint">白色引导框显示当前重叠区 · 完美对齐（连击≥2）会让方块慢慢长回来</p>
      </div>
    </GameShell>
  );
}
