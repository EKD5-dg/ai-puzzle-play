import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaMaze3D } from '../core/gameMetas';

// ============ 常量 ============

/** 迷宫格数（奇数：房间在奇数坐标，偶数坐标是墙/被打通的隔断） */
const GRID = 21;
/** 宝石数量（集齐后传送门开启） */
const GEM_COUNT = 4;
/** 内部渲染分辨率（低分辨率像素风，性能友好） */
const RW = 480;
const RH = 300;
/** 相机平面长度（≈66° 视场角） */
const FOV = 0.66;
/** 玩家半径与移动速度 */
const RADIUS = 0.22;
const SPEED = 3.4;
/** 键盘转向速度 rad/s */
const TURN_SPEED = 2.6;
/** 迷雾：超过该距离的墙面逐渐变暗 */
const FOG_START = 1.5;
const FOG_END = 11;
/** 小地图每格像素 */
const MAP_CELL = 5;

// ============ 迷宫生成（递归回溯，完美迷宫） ============

/** 生成 GRID×GRID 迷宫：1=墙 0=通路；入口 (1,1)，出口 (GRID-2,GRID-2) */
function genMaze(): Uint8Array {
  const g = new Uint8Array(GRID * GRID).fill(1);
  const stack: number[] = [1 * GRID + 1];
  g[1 * GRID + 1] = 0;
  while (stack.length > 0) {
    const cur = stack[stack.length - 1];
    const cx = cur % GRID;
    const cy = (cur / GRID) | 0;
    // 四个方向的邻房间（距离 2），随机挑选未访问者
    const dirs = [
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ].sort(() => Math.random() - 0.5);
    let moved = false;
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx <= 0 || ny <= 0 || nx >= GRID - 1 || ny >= GRID - 1) continue;
      if (g[ny * GRID + nx] === 0) continue;
      g[ny * GRID + nx] = 0;
      g[(cy + dy / 2) * GRID + (cx + dx / 2)] = 0; // 打通中间隔断
      stack.push(ny * GRID + nx);
      moved = true;
      break;
    }
    if (!moved) stack.pop();
  }
  return g;
}

/** 从起点做 BFS，返回每个房间格的步距（用于把宝石放得离起点足够远） */
function bfsDist(g: Uint8Array): Int16Array {
  const d = new Int16Array(GRID * GRID).fill(-1);
  const q: number[] = [1 * GRID + 1];
  d[1 * GRID + 1] = 0;
  for (let head = 0; head < q.length; head++) {
    const cur = q[head];
    const cx = cur % GRID;
    const cy = (cur / GRID) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
      const idx = ny * GRID + nx;
      if (g[idx] === 1 || d[idx] >= 0) continue;
      d[idx] = d[cur] + 1;
      q.push(idx);
    }
  }
  return d;
}

interface Gem {
  x: number;
  y: number;
  taken: boolean;
}

interface World {
  grid: Uint8Array;
  /** 战争迷雾：0 未探索 1 已探索 */
  seen: Uint8Array;
  gems: Gem[];
  portalX: number;
  portalY: number;
  open: boolean;
  px: number;
  py: number;
  ang: number;
  /** 累计用时 ms */
  elapsed: number;
}

/** 生成新一局世界：迷宫 + 远处散布的宝石 + 出口传送门 */
function newWorld(): World {
  const grid = genMaze();
  const exitIdx = (GRID - 2) * GRID + (GRID - 2);
  const dist = bfsDist(grid);
  // 候选：离起点 ≥8 步的房间格（奇数坐标），排除出口
  const cand: number[] = [];
  for (let y = 1; y < GRID; y += 2)
    for (let x = 1; x < GRID; x += 2) {
      const idx = y * GRID + x;
      if (idx === exitIdx) continue;
      if (dist[idx] >= 8) cand.push(idx);
    }
  // 洗牌后尽量挑彼此曼哈顿距离 ≥5 的 4 个，保证分散在全图
  cand.sort(() => Math.random() - 0.5);
  const picked: number[] = [];
  for (const idx of cand) {
    if (picked.length >= GEM_COUNT) break;
    const x = idx % GRID;
    const y = (idx / GRID) | 0;
    if (picked.every((p) => Math.abs((p % GRID) - x) + Math.abs(((p / GRID) | 0) - y) >= 5)) {
      picked.push(idx);
    }
  }
  for (const idx of cand) {
    if (picked.length >= GEM_COUNT) break;
    if (!picked.includes(idx)) picked.push(idx);
  }
  return {
    grid,
    seen: new Uint8Array(GRID * GRID),
    gems: picked.map((idx) => ({ x: (idx % GRID) + 0.5, y: ((idx / GRID) | 0) + 0.5, taken: false })),
    portalX: GRID - 1.5,
    portalY: GRID - 1.5,
    open: false,
    px: 1.5,
    py: 1.5,
    ang: 0,
    elapsed: 0,
  };
}

// ============ 程序化贴图 / 精灵 ============

type RGB = [number, number, number];

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** 程序化砖墙贴图 64×64：错缝砖 + 灰浆缝 + 颗粒噪点 */
function brickTexture(base: RGB, mortar: RGB): HTMLCanvasElement {
  const S = 64;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = `rgb(${mortar[0]},${mortar[1]},${mortar[2]})`;
  ctx.fillRect(0, 0, S, S);
  const BH = 8; // 砖高
  const BW = 16; // 砖宽
  for (let row = 0; row * BH < S; row++) {
    const offset = row % 2 === 0 ? 0 : BW / 2;
    for (let bx = -BW; bx < S + BW; bx += BW) {
      const x = bx + offset;
      const shade = 0.86 + Math.random() * 0.24;
      const col = base.map((v) => Math.min(255, Math.round(v * shade))) as RGB;
      ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      ctx.fillRect(x + 1, row * BH + 1, BW - 2, BH - 2);
      // 砖块上缘高光、下缘阴影（立体感）
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(x + 1, row * BH + 1, BW - 2, 1);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(x + 1, row * BH + BH - 2, BW - 2, 1);
    }
  }
  // 颗粒噪点
  for (let i = 0; i < 130; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.07)';
    ctx.fillRect(Math.random() * S, Math.random() * S, 1, 1);
  }
  return c;
}

/** 把贴图压暗（y 侧面用），返回新画布 */
function darken(src: HTMLCanvasElement, k: number): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = `rgba(4,6,14,${k})`;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/** 宝石精灵 48×48：青色钻石 + 亮边 + 光晕 */
function gemSprite(): HTMLCanvasElement {
  const S = 48;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d')!;
  const glow = ctx.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
  glow.addColorStop(0, 'rgba(120,240,255,0.55)');
  glow.addColorStop(1, 'rgba(120,240,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, S, S);
  const pts: Array<[number, number]> = [
    [24, 7],
    [38, 24],
    [24, 41],
    [10, 24],
  ];
  const grad = ctx.createLinearGradient(10, 7, 38, 41);
  grad.addColorStop(0, '#9ff5ff');
  grad.addColorStop(0.5, '#22c3f5');
  grad.addColorStop(1, '#0a6cf0');
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(230,252,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // 内部切面线
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(24, 7);
  ctx.lineTo(24, 41);
  ctx.moveTo(10, 24);
  ctx.lineTo(38, 24);
  ctx.stroke();
  // 高光十字
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillRect(18, 16, 2, 6);
  ctx.fillRect(16, 18, 6, 2);
  return c;
}

/** 传送门精灵帧序列（旋转的椭圆环）：open=青绿，locked=紫红 */
function portalFrames(open: boolean): HTMLCanvasElement[] {
  const W = 64;
  const H = 96;
  const FRAMES = 24;
  const frames: HTMLCanvasElement[] = [];
  for (let f = 0; f < FRAMES; f++) {
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d')!;
    const rot = (f / FRAMES) * Math.PI * 2;
    // 光晕
    const glow = ctx.createRadialGradient(W / 2, H / 2, 4, W / 2, H / 2, W * 0.62);
    if (open) {
      glow.addColorStop(0, 'rgba(80,255,190,0.5)');
      glow.addColorStop(1, 'rgba(80,255,190,0)');
    } else {
      glow.addColorStop(0, 'rgba(255,90,140,0.42)');
      glow.addColorStop(1, 'rgba(255,90,140,0)');
    }
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    // 三圈椭圆虚线环，随帧旋转
    const rings = [
      { rx: 24, ry: 38, lw: 4 },
      { rx: 17, ry: 28, lw: 3 },
      { rx: 10, ry: 17, lw: 2.5 },
    ];
    rings.forEach((r, i) => {
      const spin = rot * (i % 2 === 0 ? 1 : -1.6);
      const hue = open ? 155 + 30 * Math.sin(rot + i) : 320 + 30 * Math.sin(rot + i);
      ctx.strokeStyle = `hsl(${hue} 90% ${62 - i * 6}%)`;
      ctx.lineWidth = r.lw;
      // 用多段小椭圆弧模拟旋转的环（伪 3D 涡旋）
      for (let seg = 0; seg < 5; seg++) {
        const a0 = spin + (seg / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(W / 2, H / 2, r.rx * (0.55 + 0.45 * Math.abs(Math.cos(a0))), r.ry, 0, a0, a0 + 1.05);
        ctx.stroke();
      }
    });
    // 中心黑洞
    ctx.fillStyle = 'rgba(6,8,18,0.92)';
    ctx.beginPath();
    ctx.ellipse(W / 2, H / 2, 8, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    frames.push(c);
  }
  return frames;
}

// ============ 主组件 ============

type Status = 'ready' | 'playing' | 'paused' | 'won';

/** 毫秒 → 展示文案：<60s 保留 1 位小数，否则 m 分 s 秒 */
function fmtTime(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`;
}

export default function Maze3D() {
  const [status, setStatus] = useState<Status>('ready');
  const [gemsTaken, setGemsTaken] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [mapOn, setMapOn] = useState(true);
  const best = useBestScore(metaMaze3D.id);
  const { toast } = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(newWorld());
  const statusRef = useRef<Status>('ready');
  const mapOnRef = useRef(true);
  /** 键盘输入态（帧循环读取，避免重渲染） */
  const keysRef = useRef({ fwd: false, back: false, strafeL: false, strafeR: false, turnL: false, turnR: false });
  /** 触控输入：左侧虚拟摇杆（移动）+ 右侧拖拽（转向） */
  const stickRef = useRef<{ id: number; ox: number; oy: number; dx: number; dy: number } | null>(null);
  const lookRef = useRef<{ id: number; lastX: number } | null>(null);
  /** 脚步计步（走够一段距离播一次脚步声） */
  const stepAccRef = useRef(0);
  /** 传送门未开启的提示节流 */
  const lockHintAtRef = useRef(0);
  /** 结算守卫：won 只结算一次 */
  const wonHandledRef = useRef(false);

  statusRef.current = status;
  mapOnRef.current = mapOn;

  const start = useCallback(() => {
    worldRef.current = newWorld();
    stepAccRef.current = 0;
    lockHintAtRef.current = 0;
    wonHandledRef.current = false;
    setGemsTaken(0);
    setElapsed(0);
    setStatus('playing');
  }, []);

  // ============ 键盘 ============

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.code;
      if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault();
      const keys = keysRef.current;
      if (k === 'KeyW' || k === 'ArrowUp') keys.fwd = true;
      else if (k === 'KeyS' || k === 'ArrowDown') keys.back = true;
      else if (k === 'KeyA') keys.strafeL = true;
      else if (k === 'KeyD') keys.strafeR = true;
      else if (k === 'ArrowLeft' || k === 'KeyQ') keys.turnL = true;
      else if (k === 'ArrowRight' || k === 'KeyE') keys.turnR = true;
      else if (k === 'KeyM') setMapOn((v) => !v);
      else if (k === 'KeyP' || k === 'Space') {
        const s = statusRef.current;
        if (s === 'playing') setStatus('paused');
        else if (s === 'paused') setStatus('playing');
      } else if (k === 'Enter') {
        const s = statusRef.current;
        if (s === 'ready' || s === 'won') start();
      }
    };
    const up = (e: KeyboardEvent) => {
      const keys = keysRef.current;
      const k = e.code;
      if (k === 'KeyW' || k === 'ArrowUp') keys.fwd = false;
      else if (k === 'KeyS' || k === 'ArrowDown') keys.back = false;
      else if (k === 'KeyA') keys.strafeL = false;
      else if (k === 'KeyD') keys.strafeR = false;
      else if (k === 'ArrowLeft' || k === 'KeyQ') keys.turnL = false;
      else if (k === 'ArrowRight' || k === 'KeyE') keys.turnR = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    // 窗口失焦时清空按键状态，避免"按住 W 切窗口后一直前进"
    const clear = () => {
      keysRef.current = { fwd: false, back: false, strafeL: false, strafeR: false, turnL: false, turnR: false };
    };
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, [start]);

  // ============ 触控 / 鼠标 ============

  /** 屏幕坐标 → 画布内部坐标 */
  const toCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const kx = RW / rect.width;
    const ky = RH / rect.height;
    return { x: (e.clientX - rect.left) * kx, y: (e.clientY - rect.top) * ky, w: rect.width };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (statusRef.current !== 'playing') return;
    const p = toCanvas(e);
    // 触屏左 45% 区域 = 虚拟摇杆（移动）；其余（含鼠标）= 拖拽转向
    if (e.pointerType === 'touch' && p.x < RW * 0.45) {
      stickRef.current = { id: e.pointerId, ox: p.x, oy: p.y, dx: 0, dy: 0 };
    } else {
      lookRef.current = { id: e.pointerId, lastX: p.x };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const stick = stickRef.current;
    if (stick && e.pointerId === stick.id) {
      const p = toCanvas(e);
      const dx = p.x - stick.ox;
      const dy = p.y - stick.oy;
      const len = Math.hypot(dx, dy);
      const R = 56; // 摇杆最大行程（内部像素）
      if (len > R) {
        stick.dx = (dx / len) * R;
        stick.dy = (dy / len) * R;
      } else {
        stick.dx = dx;
        stick.dy = dy;
      }
      return;
    }
    const look = lookRef.current;
    if (look && e.pointerId === look.id) {
      const p = toCanvas(e);
      const dx = p.x - look.lastX;
      look.lastX = p.x;
      // 拖过整幅画布 ≈ 转 130°
      worldRef.current.ang += (dx / p.w) * 2.3;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (stickRef.current?.id === e.pointerId) stickRef.current = null;
    if (lookRef.current?.id === e.pointerId) lookRef.current = null;
  };

  // ============ 碰撞 ============

  const solid = (grid: Uint8Array, x: number, y: number): boolean =>
    grid[Math.floor(y) * GRID + Math.floor(x)] === 1;

  /** 分轴移动（贴墙滑动）：先试 x 再试 y */
  const tryMove = (w: World, nx: number, ny: number) => {
    if (
      !solid(w.grid, nx - RADIUS, w.py - RADIUS) &&
      !solid(w.grid, nx + RADIUS, w.py - RADIUS) &&
      !solid(w.grid, nx - RADIUS, w.py + RADIUS) &&
      !solid(w.grid, nx + RADIUS, w.py + RADIUS)
    ) {
      w.px = nx;
    }
    if (
      !solid(w.grid, w.px - RADIUS, ny - RADIUS) &&
      !solid(w.grid, w.px + RADIUS, ny - RADIUS) &&
      !solid(w.grid, w.px - RADIUS, ny + RADIUS) &&
      !solid(w.grid, w.px + RADIUS, ny + RADIUS)
    ) {
      w.py = ny;
    }
  };

  // ============ 主循环（常驻 rAF：ready/won 状态也渲染场景作背景） ============

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = RW;
    canvas.height = RH;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    // 天花板 / 地板的纵向渐变（每帧复用）
    const ceil = ctx.createLinearGradient(0, 0, 0, RH / 2);
    ceil.addColorStop(0, '#05060d');
    ceil.addColorStop(1, '#151d3a');
    const floor = ctx.createLinearGradient(0, RH / 2, 0, RH);
    floor.addColorStop(0, '#1d1710');
    floor.addColorStop(1, '#0a0805');

    // 贴图：两种砖 + 各自的 y 侧面压暗版
    const texA = brickTexture([122, 138, 178], [52, 58, 82]);
    const texB = brickTexture([160, 138, 108], [66, 56, 44]);
    const darkA = darken(texA, 0.34);
    const darkB = darken(texB, 0.34);
    const texes = [texA, texB, darkA, darkB];

    const gem = gemSprite();
    const portalOpen = portalFrames(true);
    const portalLock = portalFrames(false);
    const zbuf = new Float64Array(RW);

    let raf = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const w = worldRef.current;
      const playing = statusRef.current === 'playing';
      const t = now / 1000;

      // ---- 更新 ----
      if (playing) {
        // 转向：键盘持续转向
        const keys = keysRef.current;
        w.ang += ((keys.turnL ? -1 : 0) + (keys.turnR ? 1 : 0)) * TURN_SPEED * dt;

        // 移动：键盘 + 摇杆合成（各自 [-1,1]，合成后限幅）
        let mf = (keys.fwd ? 1 : 0) - (keys.back ? 1 : 0);
        let ms = (keys.strafeR ? 1 : 0) - (keys.strafeL ? 1 : 0);
        const stick = stickRef.current;
        if (stick) {
          const mag = Math.hypot(stick.dx, stick.dy) / 56;
          if (mag > 0.14) {
            mf += -stick.dy / 56; // 上推 = 前进
            ms += stick.dx / 56; // 右推 = 右移
          }
        }
        mf = Math.max(-1, Math.min(1, mf));
        ms = Math.max(-1, Math.min(1, ms));
        const mag = Math.hypot(mf, ms);
        const k = mag > 1 ? 1 / mag : 1;
        if (mag > 0.01) {
          const cos = Math.cos(w.ang);
          const sin = Math.sin(w.ang);
          // 前向 = (cos,sin)，右向 = 相机平面方向 (-sin,cos)
          const vx = (cos * mf - sin * ms) * k * SPEED;
          const vy = (sin * mf + cos * ms) * k * SPEED;
          const ox = w.px;
          const oy = w.py;
          tryMove(w, w.px + vx * dt, w.py + vy * dt);
          const moved = Math.hypot(w.px - ox, w.py - oy);
          stepAccRef.current += moved;
          if (stepAccRef.current > 0.85) {
            stepAccRef.current = 0;
            sfx.move();
          }
        }

        // 计时 & 探索迷雾（周围一圈直接点亮）
        w.elapsed += dt * 1000;
        const cx = Math.floor(w.px);
        const cy = Math.floor(w.py);
        for (let y = cy - 1; y <= cy + 1; y++)
          for (let x = cx - 1; x <= cx + 1; x++)
            if (x >= 0 && y >= 0 && x < GRID && y < GRID) w.seen[y * GRID + x] = 1;

        // 拾取宝石
        for (const g of w.gems) {
          if (g.taken) continue;
          if (Math.hypot(g.x - w.px, g.y - w.py) < 0.55) {
            g.taken = true;
            const n = w.gems.filter((v) => v.taken).length;
            setGemsTaken(n);
            if (n >= w.gems.length) {
              w.open = true;
              sfx.clear();
              toast('🌀 传送门已开启！去迷宫深处找到它', 'success');
            } else {
              sfx.match();
              toast(`💎 宝石 ${n}/${w.gems.length}`, 'info');
            }
          }
        }

        // 抵达传送门（立即同步 statusRef：重渲染完成前的帧不再重复结算）
        const pd = Math.hypot(w.portalX - w.px, w.portalY - w.py);
        if (w.open && pd < 0.6) {
          sfx.win();
          statusRef.current = 'won';
          setStatus('won');
        } else if (!w.open && pd < 1.1 && t - lockHintAtRef.current > 3) {
          lockHintAtRef.current = t;
          toast('传送门尚未开启：先集齐全部宝石', 'info');
        }
      }

      // ---- 渲染：光线投射 ----
      ctx.fillStyle = ceil;
      ctx.fillRect(0, 0, RW, RH / 2);
      ctx.fillStyle = floor;
      ctx.fillRect(0, RH / 2, RW, RH / 2);

      const dirX = Math.cos(w.ang);
      const dirY = Math.sin(w.ang);
      const planeX = -dirY * FOV;
      const planeY = dirX * FOV;

      for (let x = 0; x < RW; x++) {
        const camX = (2 * x) / RW - 1;
        const rdx = dirX + planeX * camX;
        const rdy = dirY + planeY * camX;
        // DDA 网格步进
        let mapX = Math.floor(w.px);
        let mapY = Math.floor(w.py);
        const ddx = Math.abs(1 / (rdx || 1e-9));
        const ddy = Math.abs(1 / (rdy || 1e-9));
        const stepX = rdx < 0 ? -1 : 1;
        const stepY = rdy < 0 ? -1 : 1;
        let sdx = rdx < 0 ? (w.px - mapX) * ddx : (mapX + 1 - w.px) * ddx;
        let sdy = rdy < 0 ? (w.py - mapY) * ddy : (mapY + 1 - w.py) * ddy;
        let side = 0;
        let hit = false;
        let guard = 0;
        while (!hit && guard++ < 64) {
          if (sdx < sdy) {
            sdx += ddx;
            mapX += stepX;
            side = 0;
          } else {
            sdy += ddy;
            mapY += stepY;
            side = 1;
          }
          if (mapX < 0 || mapY < 0 || mapX >= GRID || mapY >= GRID) break;
          const cell = mapY * GRID + mapX;
          w.seen[cell] = 1; // 视线扫过的格子计入已探索
          if (w.grid[cell] === 1) hit = true;
        }
        if (!hit) {
          zbuf[x] = 1e9;
          continue;
        }
        // 垂直距离（鱼眼校正）
        const dist = side === 0 ? sdx - ddx : sdy - ddy;
        zbuf[x] = dist;
        const lineH = RH / dist;
        const y0 = (RH - lineH) / 2;
        // 命中点在墙面上的横向分数 → 贴图列
        let wallX = side === 0 ? w.py + dist * rdy : w.px + dist * rdx;
        wallX -= Math.floor(wallX);
        let texX = Math.floor(wallX * 64);
        if ((side === 0 && rdx > 0) || (side === 1 && rdy < 0)) texX = 63 - texX;
        const variant = (mapX * 7 + mapY * 13) % 2;
        const tex = texes[variant + (side === 1 ? 2 : 0)];
        ctx.drawImage(tex, texX, 0, 1, 64, x, y0, 1, lineH);
        // 距离迷雾
        const fog = Math.min(0.94, Math.max(0, (dist - FOG_START) / (FOG_END - FOG_START)) * 0.94);
        if (fog > 0.02) {
          ctx.fillStyle = `rgba(5,7,15,${fog})`;
          ctx.fillRect(x, y0, 1, lineH);
        }
      }

      // ---- 渲染：精灵（宝石 + 传送门，按远近排序，zbuffer 逐列遮挡，连续段合并绘制） ----
      type Spr = { x: number; y: number; img: HTMLCanvasElement; scale: number; lift: number };
      const sprs: Spr[] = [];
      for (const g of w.gems)
        if (!g.taken)
          sprs.push({ x: g.x, y: g.y, img: gem, scale: 0.5, lift: 0.28 + 0.06 * Math.sin(t * 2.4 + g.x * 3) });
      const frames = w.open ? portalOpen : portalLock;
      sprs.push({
        x: w.portalX,
        y: w.portalY,
        img: frames[Math.floor(t * 14) % frames.length],
        scale: 0.7,
        lift: 0.02,
      });

      const invDet = 1 / (planeX * dirY - dirX * planeY);
      // 先变换到相机空间拿到深度再排序
      const drawn = sprs
        .map((s) => {
          const rx = s.x - w.px;
          const ry = s.y - w.py;
          return {
            s,
            tx: invDet * (dirY * rx - dirX * ry),
            ty: invDet * (-planeY * rx + planeX * ry),
          };
        })
        .filter((d) => d.ty > 0.12)
        .sort((a, b) => b.ty - a.ty);

      for (const d of drawn) {
        const { s, tx, ty } = d;
        const screenX = (RW / 2) * (1 + tx / ty);
        const sw = (RH / ty) * s.scale;
        const sh = sw * (s.img.height / s.img.width);
        const floorY = RH / 2 + RH / ty / 2; // 地面投影线
        const y0 = floorY - sh - s.lift * (RH / ty);
        const x0 = Math.floor(screenX - sw / 2);
        const x1 = Math.ceil(screenX + sw / 2);
        // 距离淡出（与墙面迷雾一致）
        const fog = Math.min(0.94, Math.max(0, (ty - FOG_START) / (FOG_END - FOG_START)) * 0.94);
        ctx.globalAlpha = 1 - fog;
        // 逐列检查 zbuffer，把连续可见列合并成一次 drawImage
        let run = -1;
        for (let x = Math.max(0, x0); x <= Math.min(RW - 1, x1); x++) {
          const vis = x <= x1 - 1 && zbuf[x] > ty;
          if (vis && run < 0) run = x;
          if ((!vis || x === Math.min(RW - 1, x1)) && run >= 0) {
            const end = vis ? x : x - 1;
            if (end >= run) {
              const u0 = ((run - x0) / (x1 - x0)) * s.img.width;
              const u1 = ((end + 1 - x0) / (x1 - x0)) * s.img.width;
              ctx.drawImage(s.img, u0, 0, Math.max(0.01, u1 - u0), s.img.height, run, y0, end - run + 1, sh);
            }
            run = -1;
          }
        }
        ctx.globalAlpha = 1;
      }

      // ---- 小地图（战争迷雾，只显示看过的区域） ----
      if (mapOnRef.current) {
        const mx = RW - GRID * MAP_CELL - 10;
        const my = 10;
        ctx.fillStyle = 'rgba(8,10,20,0.62)';
        ctx.fillRect(mx - 3, my - 3, GRID * MAP_CELL + 6, GRID * MAP_CELL + 6);
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 1;
        ctx.strokeRect(mx - 3.5, my - 3.5, GRID * MAP_CELL + 7, GRID * MAP_CELL + 7);
        for (let y = 0; y < GRID; y++)
          for (let x = 0; x < GRID; x++) {
            const idx = y * GRID + x;
            if (!w.seen[idx]) continue;
            ctx.fillStyle = w.grid[idx] === 1 ? '#5b6b9e' : '#232c4b';
            ctx.fillRect(mx + x * MAP_CELL, my + y * MAP_CELL, MAP_CELL, MAP_CELL);
          }
        // 宝石（已探索格子里未拾取的）
        for (const g of w.gems) {
          if (g.taken || !w.seen[Math.floor(g.y) * GRID + Math.floor(g.x)]) continue;
          ctx.fillStyle = '#ffd75e';
          ctx.fillRect(mx + Math.floor(g.x) * MAP_CELL + 1, my + Math.floor(g.y) * MAP_CELL + 1, MAP_CELL - 2, MAP_CELL - 2);
        }
        // 传送门
        if (w.seen[Math.floor(w.portalY) * GRID + Math.floor(w.portalX)]) {
          ctx.fillStyle = w.open ? '#3ef0a2' : '#ff6285';
          const pulse = 1 + 0.3 * Math.sin(t * 5);
          const cxp = mx + Math.floor(w.portalX) * MAP_CELL + MAP_CELL / 2;
          const cyp = my + Math.floor(w.portalY) * MAP_CELL + MAP_CELL / 2;
          ctx.beginPath();
          ctx.arc(cxp, cyp, (MAP_CELL / 2) * pulse, 0, Math.PI * 2);
          ctx.fill();
        }
        // 玩家箭头
        ctx.save();
        ctx.translate(mx + w.px * MAP_CELL, my + w.py * MAP_CELL);
        ctx.rotate(w.ang);
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(4, 0);
        ctx.lineTo(-3, 2.6);
        ctx.lineTo(-3, -2.6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      // ---- 虚拟摇杆指示 ----
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

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============ HUD 计时刷新（10Hz，避免每帧 setState） ============

  useEffect(() => {
    if (status !== 'playing') return;
    const t = window.setInterval(() => setElapsed(worldRef.current.elapsed), 100);
    return () => window.clearInterval(t);
  }, [status]);

  // ============ 结算 ============

  useEffect(() => {
    if (status !== 'won') return;
    if (wonHandledRef.current) return;
    wonHandledRef.current = true;
    const ms = Math.round(worldRef.current.elapsed / 100) * 100; // 保留 0.1s 精度
    setElapsed(ms);
    const isNew = best.updateBest(ms, (a, b) => a < b);
    if (isNew) {
      sfx.record();
      toast(`🏆 新纪录！最快逃脱 ${fmtTime(ms)}`, 'record');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const w = worldRef.current;

  return (
    <GameShell
      meta={metaMaze3D}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>用时</span>
            <strong>{fmtTime(elapsed)}</strong>
          </div>
          <div className="stat-box">
            <span>宝石</span>
            <strong>
              {gemsTaken}/{w.gems.length}
            </strong>
          </div>
          <div className="stat-box">
            <span>传送门</span>
            <strong className={w.open ? 'm3d-open' : 'm3d-locked'}>{w.open ? '已开启' : '未开启'}</strong>
          </div>
          <div className="stat-box">
            <span>{metaMaze3D.bestScoreLabel}</span>
            <strong>{best.value != null ? fmtTime(best.value) : '—'}</strong>
          </div>
        </>
      }
    >
      <div className="m3d">
        <div className="m3d-stage">
          <canvas
            ref={canvasRef}
            className="m3d-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {status === 'ready' && (
            <div className="m3d-overlay">
              <h2>🌀 3D 迷宫</h2>
              <p>
                第一人称视角探索迷宫，收集全部 {GEM_COUNT} 颗宝石
                <br />
                开启传送门，逃出生天！
              </p>
              <p className="m3d-keys">W/S 前进后退 · A/D 平移 · ←/→ 或拖拽转向 · M 地图 · P 暂停</p>
              <p className="m3d-keys">📱 左半屏拖动 = 移动摇杆，右半屏拖动 = 转向</p>
              <button className="btn btn-primary" onClick={start}>
                开始游戏
              </button>
            </div>
          )}
          {status === 'paused' && (
            <div className="m3d-overlay">
              <h2>⏸ 已暂停</h2>
              <button className="btn btn-primary" onClick={() => setStatus('playing')}>
                继续
              </button>
            </div>
          )}
          {status === 'won' && (
            <div className="m3d-overlay">
              <h2>🌀 逃脱成功！</h2>
              <p>
                用时 {fmtTime(elapsed)}
                {best.value != null && ` · 最佳 ${fmtTime(best.value)}`}
              </p>
              <button className="btn btn-primary" onClick={start}>
                再来一局
              </button>
            </div>
          )}
        </div>
        <div className="m3d-actions">
          <button
            className="btn btn-ghost"
            onClick={() => setStatus((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s))}
          >
            {status === 'paused' ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button className="btn btn-ghost" onClick={() => setMapOn((v) => !v)}>
            {mapOn ? '🗺 隐藏地图' : '🗺 显示地图'}
          </button>
          <button className="btn btn-ghost" onClick={start}>
            🎲 换一座迷宫
          </button>
        </div>
        <p className="hint">集齐宝石开启传送门 · 小地图只显示你探索过的区域</p>
      </div>
    </GameShell>
  );
}
