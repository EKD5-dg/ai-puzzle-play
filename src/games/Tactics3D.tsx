import { useEffect, useReducer, useRef, useState } from 'react';
import type React from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaTactics3D } from '../core/gameMetas';

// ============ 常量 ============

/** 棋盘边长（9×9 格） */
const N = 9;
/** 等距渲染：菱形瓦片宽/高、格高像素、内部画布分辨率与原点 */
const TW = 64;
const TH = 32;
const TW2 = TW / 2;
const TH2 = TH / 2;
const BH = 24; // 每层格高的像素高度
const SKIRT = 6; // 底座裙边厚度（棋盘悬浮感）
const RW = 640;
const RH = 530;
const OX = RW / 2;
const OY = 150;
/** 每格步行动画时长 ms */
const WALK_MS = 130;
/** 突刺动画时长 ms */
const LUNGE_MS = 240;
/** 进入更高地形时的额外移动力消耗 */
const CLIMB_COST = 2;
/** 高地伤害加成（每层高度差 ±25%） */
const HEIGHT_BONUS = 0.25;
/** 反击伤害倍率 */
const COUNTER_MULT = 0.75;
/** 地形类型 */
const T_PLAIN = 0;
const T_HILL = 1;
const T_TOP = 2;
const T_ROCK = 3;
const DIRS4: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// ============ 兵种 ============

interface KindDef {
  name: string;
  hp: number;
  atk: number;
  def: number;
  mov: number;
  rng: number;
  side: 0 | 1;
}

const KINDS: Record<string, KindDef> = {
  knight: { name: '骑士罗兰', hp: 34, atk: 12, def: 7, mov: 3, rng: 1, side: 0 },
  archer: { name: '游侠艾文', hp: 22, atk: 11, def: 4, mov: 3, rng: 3, side: 0 },
  mage: { name: '法师莉拉', hp: 18, atk: 15, def: 3, mov: 2, rng: 2, side: 0 },
  gob: { name: '哥布林战士', hp: 20, atk: 9, def: 3, mov: 3, rng: 1, side: 1 },
  gobA: { name: '哥布林射手', hp: 16, atk: 8, def: 2, mov: 3, rng: 2, side: 1 },
  chief: { name: '兽人酋长', hp: 40, atk: 13, def: 6, mov: 2, rng: 1, side: 1 },
};

type Kind = keyof typeof KINDS;

interface Unit {
  id: number;
  kind: Kind;
  side: 0 | 1;
  name: string;
  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  mov: number;
  rng: number;
  gx: number;
  gy: number;
  acted: boolean;
  defending: boolean;
  dead: boolean;
  deadT: number;
  walk: { path: Array<[number, number]>; t0: number } | null;
  lunge: { tx: number; ty: number; t0: number } | null;
}

interface Effect {
  kind: 'dmg' | 'poof' | 'hit' | 'text';
  x: number;
  y: number;
  unitId?: number;
  text?: string;
  color?: string;
  t0: number;
  dur: number;
}

type SchedType = 'walkEnd' | 'moveDone' | 'dmg' | 'afterAct' | 'enemyGo' | 'nextEnemy' | 'enemyAct' | 'endEnemy' | 'checkEnd';

interface Sched {
  at: number;
  type: SchedType;
  id?: number;
  attId?: number;
  defId?: number;
  /** 原始先手单位：反击链中 attId 会换成反击者，收尾必须回到先手身上 */
  origin?: number;
  counter?: boolean;
  done?: 'playerAct' | 'enemyNext';
}

interface Sel {
  id: number;
  from: [number, number];
  moved: boolean;
}

interface World {
  t: Uint8Array;
  units: Unit[];
  turn: number;
  phase: 'player' | 'enemy';
  rot: number;
  sel: Sel | null;
  inspect: number | null;
  moveMap: Map<number, { cost: number; parent: number }> | null;
  danger: Set<number> | null;
  attackSet: Set<number>;
  effects: Effect[];
  queue: Sched[];
  enemyQueue: number[];
  busy: boolean;
  over: boolean;
  hiTip: boolean;
}

// ============ 工具 ============

const idx = (x: number, y: number) => y * N + x;
const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N;
const cheby = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
const terrainH = (t: number) => (t === T_HILL ? 1 : t === T_TOP || t === T_ROCK ? 2 : 0);

/** 网格 → 视图坐标（90° 整数旋转之一，格心与整格通用） */
function rotPt(x: number, y: number, r: number): [number, number] {
  switch (r & 3) {
    case 1:
      return [y, N - 1 - x];
    case 2:
      return [N - 1 - x, N - 1 - y];
    case 3:
      return [N - 1 - y, x];
    default:
      return [x, y];
  }
}

// ============ 地形生成 ============

const SPAWNS: Array<[number, number]> = [
  [0, 3],
  [1, 4],
  [0, 5],
  [8, 2],
  [8, 4],
  [8, 6],
  [7, 4],
];

/** 兜底地图（生成 60 次都失败时使用，已验证出生点全通） */
const FIELD_FALLBACK = [
  '.........',
  '..1....3.',
  '.11......',
  '.........',
  '....22...',
  '....2....',
  '3....1...',
  '.........',
  '.........',
];

function validField(t: Uint8Array): boolean {
  for (const [sx, sy] of SPAWNS) if (t[idx(sx, sy)] !== T_PLAIN) return false;
  const seen = new Uint8Array(N * N);
  const q = [idx(1, 4)];
  seen[q[0]] = 1;
  for (let head = 0; head < q.length; head++) {
    const cur = q[head];
    const cx = cur % N;
    const cy = (cur / N) | 0;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inb(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (seen[ni] || t[ni] === T_ROCK) continue;
      seen[ni] = 1;
      q.push(ni);
    }
  }
  return SPAWNS.every(([sx, sy]) => seen[idx(sx, sy)] === 1);
}

function genField(): Uint8Array {
  const nearSpawn = (x: number, y: number) => SPAWNS.some(([sx, sy]) => cheby(x, y, sx, sy) <= 1);
  const t = new Uint8Array(N * N);
  for (let attempt = 0; attempt < 60; attempt++) {
    t.fill(T_PLAIN);
    // 两簇山丘（可攀爬，高地加成）
    for (let c = 0; c < 2; c++) {
      const cx = 2 + ((Math.random() * 5) | 0);
      const cy = 1 + ((Math.random() * 7) | 0);
      if (nearSpawn(cx, cy)) continue;
      t[idx(cx, cy)] = T_HILL;
      for (const [dx, dy] of DIRS4) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (inb(nx, ny) && !nearSpawn(nx, ny) && t[idx(nx, ny)] === T_PLAIN && Math.random() < 0.6) t[idx(nx, ny)] = T_HILL;
      }
    }
    // 一处高地平台（两层，巨岩级掩体）
    const px = 2 + ((Math.random() * 5) | 0);
    const py = 1 + ((Math.random() * 7) | 0);
    if (!nearSpawn(px, py) && t[idx(px, py)] === T_PLAIN) {
      t[idx(px, py)] = T_TOP;
      const dirs = [...DIRS4].sort(() => Math.random() - 0.5);
      for (const [dx, dy] of dirs) {
        const nx = px + dx;
        const ny = py + dy;
        if (inb(nx, ny) && !nearSpawn(nx, ny) && t[idx(nx, ny)] === T_PLAIN) {
          t[idx(nx, ny)] = T_TOP;
          break;
        }
      }
    }
    // 散布巨岩（不可通行、挡远程）
    let rocks = 0;
    for (let i = 0; i < 40 && rocks < 6; i++) {
      const rx = (Math.random() * N) | 0;
      const ry = (Math.random() * N) | 0;
      if (t[idx(rx, ry)] !== T_PLAIN || nearSpawn(rx, ry)) continue;
      t[idx(rx, ry)] = T_ROCK;
      rocks++;
    }
    if (validField(t)) return t;
  }
  const fb = new Uint8Array(N * N);
  FIELD_FALLBACK.forEach((row, y) => {
    for (let x = 0; x < N; x++) {
      const ch = row[x];
      fb[idx(x, y)] = ch === '1' ? T_HILL : ch === '2' ? T_TOP : ch === '3' ? T_ROCK : T_PLAIN;
    }
  });
  return fb;
}

// ============ 世界 ============

function mkUnit(id: number, kind: Kind, gx: number, gy: number): Unit {
  const d = KINDS[kind];
  return {
    id,
    kind,
    side: d.side,
    name: d.name,
    hp: d.hp,
    maxHp: d.hp,
    atk: d.atk,
    def: d.def,
    mov: d.mov,
    rng: d.rng,
    gx,
    gy,
    acted: false,
    defending: false,
    dead: false,
    deadT: 0,
    walk: null,
    lunge: null,
  };
}

function newWorld(): World {
  const t = genField();
  const units: Unit[] = [
    mkUnit(1, 'knight', 1, 4),
    mkUnit(2, 'archer', 0, 3),
    mkUnit(3, 'mage', 0, 5),
    mkUnit(4, 'gob', 8, 2),
    mkUnit(5, 'gob', 8, 6),
    mkUnit(6, 'gobA', 7, 4),
    mkUnit(7, 'chief', 8, 4),
  ];
  return {
    t,
    units,
    turn: 1,
    phase: 'player',
    rot: 0,
    sel: null,
    inspect: null,
    moveMap: null,
    danger: null,
    attackSet: new Set<number>(),
    effects: [],
    queue: [],
    enemyQueue: [],
    busy: false,
    over: false,
    hiTip: false,
  };
}

/** 单位实时绘制位置（含步行动画插值与跳跃弧线、突刺位移） */
function unitPos(w: World, u: Unit, now: number): { x: number; y: number; h: number; z: number } {
  let x = u.gx + 0.5;
  let y = u.gy + 0.5;
  let h = terrainH(w.t[idx(u.gx, u.gy)]);
  let z = 0;
  if (u.walk) {
    const p = (now - u.walk.t0) / WALK_MS;
    const i = Math.min(u.walk.path.length - 1, Math.max(0, Math.floor(p)));
    const f = Math.min(1, Math.max(0, p - i));
    const [ax, ay] = i === 0 ? [u.gx, u.gy] : u.walk.path[i - 1];
    const [bx, by] = u.walk.path[i];
    x = ax + 0.5 + (bx - ax) * f;
    y = ay + 0.5 + (by - ay) * f;
    const hA = terrainH(w.t[idx(ax, ay)]);
    const hB = terrainH(w.t[idx(bx, by)]);
    h = hA + (hB - hA) * f;
    z = Math.sin(f * Math.PI) * 0.22;
  }
  if (u.lunge) {
    const p = (now - u.lunge.t0) / LUNGE_MS;
    if (p >= 1) u.lunge = null;
    else {
      const k = Math.sin(p * Math.PI) * 0.34;
      x += (u.lunge.tx - u.gx) * k;
      y += (u.lunge.ty - u.gy) * k;
    }
  }
  return { x, y, h, z };
}

// ============ 程序化贴图 / 精灵 ============

function mkCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** 瓦片顶面 64×32（菱形内缩 1px 留描边） */
function tileTop(type: number, variant: number): HTMLCanvasElement {
  const c = mkCanvas(TW, TH);
  const g = c.getContext('2d')!;
  const dia = (inset: number) => {
    g.beginPath();
    g.moveTo(TW2, inset);
    g.lineTo(TW - 1 - inset, TH2);
    g.lineTo(TW2, TH - 1 - inset);
    g.lineTo(1 + inset, TH2);
    g.closePath();
  };
  const speck = (col: string, n: number) => {
    g.fillStyle = col;
    for (let i = 0; i < n; i++) {
      const x = 8 + Math.random() * (TW - 16);
      const y = 8 + Math.random() * (TH - 16);
      if (Math.abs((x - TW2) / TW2) + Math.abs((y - TH2) / (TH2 - 1)) > 0.92) continue;
      g.fillRect(x, y, 1.6, 1.6);
    }
  };
  if (type === T_PLAIN || type === T_HILL) {
    dia(0);
    g.fillStyle = type === T_PLAIN ? (variant === 0 ? '#3e7c3a' : '#448542') : '#5aa14c';
    g.fill();
    g.save();
    dia(0);
    g.clip();
    speck(type === T_PLAIN ? '#346d31' : '#4b8f40', 16);
    speck(type === T_PLAIN ? '#58a04e' : '#79c25e', 14);
    if (type === T_HILL) {
      g.fillStyle = '#ffd75e';
      g.fillRect(22 + variant * 14, 12, 2, 2);
      g.fillRect(38, 20, 2, 2);
    }
    g.restore();
  } else if (type === T_TOP) {
    dia(0);
    g.fillStyle = '#9a968c';
    g.fill();
    g.save();
    dia(0);
    g.clip();
    speck('#8a867c', 12);
    speck('#aaa69c', 10);
    g.strokeStyle = '#7b776c';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(14, 18);
    g.lineTo(26, 12);
    g.lineTo(34, 18);
    g.moveTo(38, 22);
    g.lineTo(46, 16);
    g.stroke();
    g.restore();
    dia(0);
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 1;
    g.stroke();
  } else {
    // 巨岩：石面 + 丘状岩石
    dia(0);
    g.fillStyle = '#7c7466';
    g.fill();
    g.save();
    dia(0);
    g.clip();
    const boulders: Array<[number, number, number]> = [
      [22, 13, 8],
      [40, 17, 7],
      [31, 20, 5.5],
    ];
    for (const [bx, by, r] of boulders) {
      const grad = g.createRadialGradient(bx - r * 0.4, by - r * 0.5, 1, bx, by, r);
      grad.addColorStop(0, '#a89d8a');
      grad.addColorStop(1, '#665e50');
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(bx, by, r, r * 0.78, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(40,34,26,0.55)';
      g.lineWidth = 1;
      g.stroke();
    }
    speck('#5e574a', 10);
    g.restore();
  }
  dia(0);
  g.strokeStyle = 'rgba(18,24,16,0.4)';
  g.lineWidth = 1;
  g.stroke();
  return c;
}

/** 单位精灵：一律面朝右绘制（敌军在渲染时水平镜像） */
function unitSprite(kind: Kind): HTMLCanvasElement {
  const W = kind === 'chief' ? 60 : 48;
  const H = kind === 'chief' ? 72 : kind === 'mage' ? 62 : kind === 'gob' ? 50 : kind === 'gobA' ? 48 : 60;
  const c = mkCanvas(W, H);
  const g = c.getContext('2d')!;
  const cx = W / 2;
  const poly = (pts: Array<[number, number]>, fill: string | CanvasGradient, stroke?: string) => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = 1.5;
      g.stroke();
    }
  };
  const vgrad = (y0: number, y1: number, c0: string, c1: string) => {
    const gr = g.createLinearGradient(0, y0, 0, y1);
    gr.addColorStop(0, c0);
    gr.addColorStop(1, c1);
    return gr;
  };
  if (kind === 'knight') {
    g.fillStyle = '#2f3646';
    g.fillRect(cx - 5, 46, 4, 11);
    g.fillRect(cx + 2, 46, 4, 11);
    g.fillStyle = '#232838';
    g.fillRect(cx - 6, 54, 6, 4);
    g.fillRect(cx + 1, 54, 6, 4);
    rr(g, cx - 9, 24, 18, 23, 5);
    g.fillStyle = vgrad(24, 47, '#c7d2e6', '#8a96b0');
    g.fill();
    g.strokeStyle = 'rgba(30,36,52,0.8)';
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = '#5c4326';
    g.fillRect(cx - 9, 40, 18, 4);
    g.fillStyle = '#e0b64f';
    g.fillRect(cx - 2, 40, 4, 4);
    g.fillStyle = '#9fb0c8';
    g.beginPath();
    g.arc(cx - 9, 27, 4.5, 0, Math.PI * 2);
    g.arc(cx + 9, 27, 4.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ecc49c';
    g.beginPath();
    g.arc(cx, 16, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#aab6cc';
    g.beginPath();
    g.arc(cx, 15, 6.8, Math.PI, Math.PI * 2);
    g.fill();
    g.fillRect(cx - 7, 14, 14, 2.5);
    g.fillRect(cx - 1, 16, 2, 6);
    poly(
      [
        [cx, 2],
        [cx - 4, 9],
        [cx + 4, 9],
      ],
      '#d24a52',
    );
    poly(
      [
        [cx - 16, 26],
        [cx - 21, 34],
        [cx - 16, 46],
        [cx - 11, 34],
      ],
      vgrad(26, 46, '#3f6fd8', '#2a4fa8'),
      '#e0b64f',
    );
    g.fillStyle = '#e0b64f';
    g.beginPath();
    g.arc(cx - 16, 35, 2, 0, Math.PI * 2);
    g.fill();
    poly(
      [
        [cx + 12, 28],
        [cx + 20, 10],
        [cx + 22, 12],
        [cx + 14, 30],
      ],
      '#e8eef8',
      '#9fb0c8',
    );
    g.strokeStyle = '#e0b64f';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx + 9, 27);
    g.lineTo(cx + 15, 32);
    g.stroke();
    g.fillStyle = '#ecc49c';
    g.beginPath();
    g.arc(cx + 12, 29, 2.5, 0, Math.PI * 2);
    g.fill();
  } else if (kind === 'archer') {
    g.fillStyle = '#3d4a33';
    g.fillRect(cx - 5, 45, 4, 11);
    g.fillRect(cx + 2, 45, 4, 11);
    g.fillStyle = '#2b3524';
    g.fillRect(cx - 6, 53, 6, 4);
    g.fillRect(cx + 1, 53, 6, 4);
    rr(g, cx - 8, 24, 16, 22, 5);
    g.fillStyle = vgrad(24, 46, '#4e8f4a', '#315d33');
    g.fill();
    g.strokeStyle = 'rgba(20,30,18,0.75)';
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = '#6b4a2a';
    g.fillRect(cx - 8, 38, 16, 3);
    g.fillStyle = '#ecc49c';
    g.beginPath();
    g.arc(cx, 16, 5.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3a6e38';
    g.beginPath();
    g.arc(cx, 14, 6.6, Math.PI * 0.85, Math.PI * 2.2);
    g.fill();
    poly(
      [
        [cx - 7, 6],
        [cx - 10, 12],
        [cx - 5, 10],
      ],
      '#e0b64f',
    );
    g.strokeStyle = '#8a5a2b';
    g.lineWidth = 2.5;
    g.beginPath();
    g.arc(cx - 12, 30, 11, -Math.PI / 2.1, Math.PI / 2.1);
    g.stroke();
    g.strokeStyle = '#ddd8c8';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx - 12, 19.3);
    g.lineTo(cx - 12, 40.7);
    g.stroke();
    g.strokeStyle = '#9a6b33';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx - 12, 30);
    g.lineTo(cx - 2, 30);
    g.stroke();
    g.fillStyle = '#6b4a2a';
    g.fillRect(cx + 7, 24, 5, 12);
    g.fillStyle = '#ddd8c8';
    g.fillRect(cx + 8, 22, 1.5, 4);
    g.fillRect(cx + 10.5, 22, 1.5, 4);
  } else if (kind === 'mage') {
    poly(
      [
        [cx, 24],
        [cx - 11, 54],
        [cx + 11, 54],
      ],
      vgrad(24, 54, '#7b4fc9', '#452b86'),
      'rgba(40,24,80,0.8)',
    );
    g.strokeStyle = '#e0b64f';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(cx - 8, 38);
    g.lineTo(cx + 8, 38);
    g.stroke();
    g.fillStyle = '#ecc49c';
    g.beginPath();
    g.arc(cx, 17, 5.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#e8e8e8';
    g.beginPath();
    g.arc(cx, 21, 3.2, 0, Math.PI);
    g.fill();
    g.fillStyle = '#3a2a55';
    g.fillRect(cx - 3, 16, 1.6, 1.6);
    g.fillRect(cx + 1.5, 16, 1.6, 1.6);
    g.fillStyle = vgrad(0, 12, '#8a5cd9', '#6a3fb8');
    g.beginPath();
    g.ellipse(cx, 11, 9.5, 2.6, 0, 0, Math.PI * 2);
    g.fill();
    poly(
      [
        [cx, -1],
        [cx - 6.5, 11],
        [cx + 6.5, 11],
      ],
      vgrad(0, 11, '#8a5cd9', '#6a3fb8'),
    );
    g.fillStyle = '#ffd75e';
    g.fillRect(cx - 1, 4, 2, 2);
    g.fillStyle = '#6b4423';
    g.fillRect(cx + 13, 14, 2.5, 40);
    const glow = g.createRadialGradient(cx + 14.2, 11, 1, cx + 14.2, 11, 7);
    glow.addColorStop(0, 'rgba(140,235,255,0.9)');
    glow.addColorStop(1, 'rgba(140,235,255,0)');
    g.fillStyle = glow;
    g.fillRect(cx + 6, 3, 17, 17);
    g.fillStyle = '#6fe3ff';
    g.beginPath();
    g.arc(cx + 14.2, 11, 4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath();
    g.arc(cx + 12.8, 9.6, 1.2, 0, Math.PI * 2);
    g.fill();
  } else if (kind === 'gob' || kind === 'gobA') {
    const small = kind === 'gobA';
    const bodyTop = small ? 26 : 22;
    g.fillStyle = '#4e7a38';
    g.fillRect(cx - 5, small ? 38 : 40, 4, small ? 8 : 8);
    g.fillRect(cx + 2, small ? 38 : 40, 4, 8);
    rr(g, cx - 8, bodyTop, 16, small ? 16 : 20, 6);
    g.fillStyle = vgrad(bodyTop, bodyTop + 20, '#6fae4e', '#4e8438');
    g.fill();
    g.strokeStyle = 'rgba(24,40,16,0.8)';
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = '#7a4a2a';
    g.fillRect(cx - 7, bodyTop + (small ? 11 : 14), 14, 5);
    const hy = small ? 15 : 18;
    g.fillStyle = small ? '#6da24c' : '#7cb95a';
    g.beginPath();
    g.arc(cx, hy, small ? 6.5 : 8, 0, Math.PI * 2);
    g.fill();
    poly(
      [
        [cx - 7, hy - 2],
        [cx - 14, hy - 5],
        [cx - 6, hy + 3],
      ],
      small ? '#6da24c' : '#7cb95a',
    );
    poly(
      [
        [cx + 7, hy - 2],
        [cx + 14, hy - 5],
        [cx + 6, hy + 3],
      ],
      small ? '#6da24c' : '#7cb95a',
    );
    if (small) {
      g.fillStyle = '#3a5e2e';
      g.beginPath();
      g.arc(cx, hy - 2, 6.8, Math.PI * 0.9, Math.PI * 2.15);
      g.fill();
    }
    g.fillStyle = '#ff5a4a';
    g.fillRect(cx - 3.6, hy - 1, 2.2, 2.2);
    g.fillRect(cx + 1.4, hy - 1, 2.2, 2.2);
    g.strokeStyle = '#2c4a1e';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(cx - 3, hy + 4);
    g.lineTo(cx + 3, hy + 4);
    g.stroke();
    if (small) {
      g.strokeStyle = '#8a5a2b';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(cx - 11, hy + 12, 9, -Math.PI / 2.1, Math.PI / 2.1);
      g.stroke();
      g.strokeStyle = '#ddd8c8';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(cx - 11, hy + 3.4);
      g.lineTo(cx - 11, hy + 20.6);
      g.stroke();
    } else {
      poly(
        [
          [cx + 7, bodyTop + 4],
          [cx + 14, bodyTop - 2],
          [cx + 15, bodyTop],
          [cx + 8, bodyTop + 6],
        ],
        '#cdd6e4',
        '#8a96b0',
      );
      g.fillStyle = '#5c4326';
      g.fillRect(cx + 6, bodyTop + 5, 3, 3);
    }
  } else {
    // 兽人酋长
    g.fillStyle = '#3a3f4c';
    g.fillRect(cx - 9, 56, 6, 13);
    g.fillRect(cx + 4, 56, 6, 13);
    g.fillStyle = '#262b36';
    g.fillRect(cx - 11, 66, 9, 5);
    g.fillRect(cx + 3, 66, 9, 5);
    rr(g, cx - 12, 28, 24, 30, 6);
    g.fillStyle = vgrad(28, 58, '#4a5060', '#2e3340');
    g.fill();
    g.strokeStyle = 'rgba(16,20,30,0.85)';
    g.lineWidth = 1.5;
    g.stroke();
    g.strokeStyle = '#5d6478';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(cx - 8, 36);
    g.lineTo(cx + 8, 36);
    g.moveTo(cx - 8, 44);
    g.lineTo(cx + 8, 44);
    g.stroke();
    g.fillStyle = '#a83a44';
    g.fillRect(cx - 12, 50, 24, 6);
    g.fillStyle = '#e0b64f';
    g.fillRect(cx - 2, 50, 4, 6);
    g.fillStyle = '#6b4a2a';
    g.beginPath();
    g.arc(cx - 12, 31, 6, 0, Math.PI * 2);
    g.arc(cx + 12, 31, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#7cb95a';
    g.beginPath();
    g.arc(cx, 18, 8, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#5d6478';
    g.beginPath();
    g.arc(cx, 17, 8.6, Math.PI, Math.PI * 2);
    g.fill();
    g.fillRect(cx - 9, 16, 18, 3);
    poly(
      [
        [cx - 8, 12],
        [cx - 14, 4],
        [cx - 5, 9],
      ],
      '#e8e2d2',
    );
    poly(
      [
        [cx + 8, 12],
        [cx + 14, 4],
        [cx + 5, 9],
      ],
      '#e8e2d2',
    );
    g.fillStyle = '#ff5a4a';
    g.fillRect(cx - 4, 18, 2.4, 2.4);
    g.fillRect(cx + 2, 18, 2.4, 2.4);
    poly(
      [
        [cx - 4, 24],
        [cx - 3, 27],
        [cx - 2, 24],
      ],
      '#f0ead8',
    );
    poly(
      [
        [cx + 2, 24],
        [cx + 3, 27],
        [cx + 4, 24],
      ],
      '#f0ead8',
    );
    g.fillStyle = '#6b4423';
    g.fillRect(cx + 16, 16, 3.5, 44);
    poly(
      [
        [cx + 12, 14],
        [cx + 27, 9],
        [cx + 27, 24],
        [cx + 12, 21],
      ],
      vgrad(9, 24, '#b9c2d2', '#7d8698'),
      'rgba(30,36,50,0.8)',
    );
  }
  return c;
}

// ============ 主组件 ============

type Status = 'ready' | 'playing' | 'won' | 'lost';

interface Handlers {
  tap: (x: number, y: number) => void;
  rotate: () => void;
  cancel: () => void;
  defend: () => void;
  wait: () => void;
  endTurn: () => void;
}

export default function Tactics3D() {
  const [status, setStatus] = useState<Status>('ready');
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const best = useBestScore(metaTactics3D.id);
  const { toast } = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 懒初始化：避免每次渲染白建地图 + 校验 BFS
  const worldRef = useRef<World>(null as unknown as World);
  if (!worldRef.current) worldRef.current = newWorld();
  const statusRef = useRef<Status>('ready');
  statusRef.current = status;
  const handlersRef = useRef<Handlers | null>(null);
  const bestRef = useRef(best);
  bestRef.current = best;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const start = () => {
    worldRef.current = newWorld();
    setStatus('playing');
    sfx.click();
    bump();
  };

  // ============ 逻辑 + 渲染循环（一次性挂载） ============

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = RW;
    canvas.height = RH;
    const ctx = canvas.getContext('2d')!;
    const wq = () => worldRef.current;

    const tops = [0, 1, 2, 3].flatMap((t) => [tileTop(t, 0), tileTop(t, 1)]);
    const sprites: Record<string, HTMLCanvasElement> = {
      knight: unitSprite('knight'),
      archer: unitSprite('archer'),
      mage: unitSprite('mage'),
      gob: unitSprite('gob'),
      gobA: unitSprite('gobA'),
      chief: unitSprite('chief'),
    };

    // 背景：夜空渐变 + 星点（一次性离屏）
    const bg = mkCanvas(RW, RH);
    {
      const b = bg.getContext('2d')!;
      const grad = b.createLinearGradient(0, 0, 0, RH);
      grad.addColorStop(0, '#0e1428');
      grad.addColorStop(1, '#070a14');
      b.fillStyle = grad;
      b.fillRect(0, 0, RW, RH);
      for (let i = 0; i < 110; i++) {
        b.globalAlpha = 0.1 + Math.random() * 0.4;
        b.fillStyle = Math.random() < 0.25 ? '#9fc4ff' : '#e8eeff';
        b.fillRect(Math.random() * RW, Math.random() * RH * 0.9, Math.random() < 0.2 ? 2 : 1, 1);
      }
      b.globalAlpha = 1;
    }

    // ---- 查询 ----

    const byId = (id: number) => wq().units.find((u) => u.id === id);
    const alive = (side: 0 | 1) => wq().units.filter((u) => u.side === side && !u.dead);
    const unitAt = (x: number, y: number) => wq().units.find((u) => !u.dead && u.gx === x && u.gy === y);

    /** 可达格：Dijkstra，上坡耗 2 移动力，岩不可行，任何单位占据格不可穿越 */
    function reachable(u: Unit, budget: number): Map<number, { cost: number; parent: number }> {
      const w = wq();
      const res = new Map<number, { cost: number; parent: number }>();
      res.set(idx(u.gx, u.gy), { cost: 0, parent: -1 });
      const open = [idx(u.gx, u.gy)];
      while (open.length > 0) {
        let bi = 0;
        for (let i = 1; i < open.length; i++) if (res.get(open[i])!.cost < res.get(open[bi])!.cost) bi = i;
        const cur = open.splice(bi, 1)[0];
        const cc = res.get(cur)!.cost;
        if (cc >= budget) continue;
        const cx = cur % N;
        const cy = (cur / N) | 0;
        const ch = terrainH(w.t[cur]);
        for (const [dx, dy] of DIRS4) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!inb(nx, ny)) continue;
          const ni = idx(nx, ny);
          const tt = w.t[ni];
          if (tt === T_ROCK || unitAt(nx, ny)) continue;
          const ncost = cc + (terrainH(tt) > ch ? CLIMB_COST : 1);
          if (ncost > budget) continue;
          const prev = res.get(ni);
          if (!prev || ncost < prev.cost) {
            res.set(ni, { cost: ncost, parent: cur });
            open.push(ni);
          }
        }
      }
      return res;
    }

    /** 回溯父链 → 步行路径（不含起点） */
    function chainTo(reach: Map<number, { cost: number; parent: number }>, target: number): Array<[number, number]> {
      const path: Array<[number, number]> = [];
      let cur = target;
      while (cur !== -1 && reach.get(cur)!.cost > 0) {
        path.push([cur % N, (cur / N) | 0]);
        cur = reach.get(cur)!.parent;
      }
      return path.reverse();
    }

    /** 远程视线是否被挡（巨岩恒挡；高地平台挡低于它的射手） */
    function losBlocked(x0: number, y0: number, h0: number, x1: number, y1: number): boolean {
      const w = wq();
      const d = cheby(x0, y0, x1, y1);
      if (d <= 1) return false;
      const h1 = terrainH(w.t[idx(x1, y1)]);
      const steps = Math.ceil(d * 3);
      for (let i = 1; i < steps; i++) {
        const p = i / steps;
        const tx = Math.floor(x0 + (x1 - x0) * p);
        const ty = Math.floor(y0 + (y1 - y0) * p);
        if ((tx === x0 && ty === y0) || (tx === x1 && ty === y1)) continue;
        const c = w.t[idx(tx, ty)];
        if (c === T_ROCK) return true;
        if (c === T_TOP && Math.max(h0, h1) < 2) return true;
      }
      return false;
    }

    /** (fx,fy) 处 u 可攻击的敌人 */
    function foesInRange(u: Unit, fx: number, fy: number): Unit[] {
      const w = wq();
      const fh = terrainH(w.t[idx(fx, fy)]);
      return alive(u.side === 0 ? 1 : 0).filter((e) => {
        const d = cheby(fx, fy, e.gx, e.gy);
        if (d > u.rng) return false;
        if (d > 1 && losBlocked(fx, fy, fh, e.gx, e.gy)) return false;
        return true;
      });
    }

    function canCounter(def: Unit, att: Unit): boolean {
      const w = wq();
      const d = cheby(def.gx, def.gy, att.gx, att.gy);
      if (d > def.rng) return false;
      if (d > 1 && losBlocked(def.gx, def.gy, terrainH(w.t[idx(def.gx, def.gy)]), att.gx, att.gy)) return false;
      return true;
    }

    function calcDmg(att: Unit, def: Unit, counter: boolean): { dmg: number; hi: boolean } {
      const w = wq();
      const hA = terrainH(w.t[idx(att.gx, att.gy)]);
      const hD = terrainH(w.t[idx(def.gx, def.gy)]);
      const mult = Math.max(0.75, Math.min(1.5, 1 + HEIGHT_BONUS * (hA - hD)));
      const raw = att.atk * (counter ? COUNTER_MULT : 1) * mult * (counter ? 1 : 0.92 + Math.random() * 0.16);
      const guard = def.def * (def.defending ? 1.5 : 1);
      return { dmg: Math.max(1, Math.round(raw - guard)), hi: mult > 1.05 };
    }

    /** 多源 BFS：每格到最近英雄的步距（岩与被占格不可穿越） */
    function heroDistMap(): Int16Array {
      const w = wq();
      const d = new Int16Array(N * N).fill(-1);
      const q: number[] = [];
      for (const h of alive(0)) {
        d[idx(h.gx, h.gy)] = 0;
        q.push(idx(h.gx, h.gy));
      }
      for (let head = 0; head < q.length; head++) {
        const cur = q[head];
        const cx = cur % N;
        const cy = (cur / N) | 0;
        for (const [dx, dy] of DIRS4) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!inb(nx, ny)) continue;
          const ni = idx(nx, ny);
          if (d[ni] >= 0 || w.t[ni] === T_ROCK || unitAt(nx, ny)) continue;
          d[ni] = d[cur] + 1;
          q.push(ni);
        }
      }
      return d;
    }

    // ---- 玩家指令 ----

    function select(u: Unit) {
      const w = wq();
      w.sel = { id: u.id, from: [u.gx, u.gy], moved: false };
      w.inspect = null;
      w.danger = null;
      w.moveMap = reachable(u, u.mov);
      w.attackSet = new Set(foesInRange(u, u.gx, u.gy).map((e) => e.id));
      sfx.click();
      bump();
    }

    function clearSel(revert: boolean) {
      const w = wq();
      if (w.sel && revert) {
        const u = byId(w.sel.id);
        if (u && !u.dead) {
          u.gx = w.sel.from[0];
          u.gy = w.sel.from[1];
        }
      }
      w.sel = null;
      w.moveMap = null;
      w.attackSet = new Set();
      bump();
    }

    /** 敌方威胁范围：可达格（含原地）∪ 攻击范围（计视线） */
    function dangerZone(u: Unit): Set<number> {
      const w = wq();
      const set = new Set<number>();
      const reach = reachable(u, u.mov);
      for (const [ti] of reach) {
        const tx = ti % N;
        const ty = (ti / N) | 0;
        const th = terrainH(w.t[ti]);
        for (let y = Math.max(0, ty - u.rng); y <= Math.min(N - 1, ty + u.rng); y++) {
          for (let x = Math.max(0, tx - u.rng); x <= Math.min(N - 1, tx + u.rng); x++) {
            const d = cheby(tx, ty, x, y);
            if (d > u.rng) continue;
            if (d > 1 && losBlocked(tx, ty, th, x, y)) continue;
            set.add(idx(x, y));
          }
        }
      }
      return set;
    }

    function inspectEnemy(u: Unit) {
      const w = wq();
      w.inspect = u.id;
      w.danger = dangerZone(u);
      w.sel = null;
      w.moveMap = null;
      w.attackSet = new Set();
      sfx.click();
      bump();
    }

    function startWalk(u: Unit, path: Array<[number, number]>, after: Omit<Sched, 'at'> | null) {
      const w = wq();
      const now = performance.now();
      u.walk = { path, t0: now };
      const end = now + path.length * WALK_MS + 20;
      w.queue.push({ at: end, type: 'walkEnd', id: u.id });
      if (after) w.queue.push({ ...after, at: end + 30 });
    }

    function startMove(u: Unit, x: number, y: number) {
      const w = wq();
      const path = chainTo(w.moveMap!, idx(x, y));
      if (path.length === 0) return;
      w.busy = true;
      w.moveMap = null;
      startWalk(u, path, { type: 'moveDone', id: u.id });
      sfx.move();
      bump();
    }

    /** 通用攻击流程：突刺 → 结算伤害 → 反击链 → 收尾 */
    function strike(att: Unit, def: Unit, counter: boolean, done: 'playerAct' | 'enemyNext') {
      const w = wq();
      const now = performance.now();
      if (w.over || att.dead || def.dead) {
        finish(done, att.id, now);
        return;
      }
      if (!counter) {
        if (done === 'playerAct') w.busy = true;
        w.attackSet = new Set();
      }
      att.lunge = { tx: def.gx, ty: def.gy, t0: now };
      w.queue.push({ at: now + 120, type: 'dmg', attId: att.id, defId: def.id, origin: att.id, counter, done });
      bump();
    }

    function finish(done: 'playerAct' | 'enemyNext', attId: number, now: number) {
      const w = wq();
      if (done === 'playerAct') w.queue.push({ at: now + 40, type: 'afterAct', id: attId });
      else w.queue.push({ at: now + 40, type: 'nextEnemy' });
    }

    function tap(mx: number, my: number) {
      const w = wq();
      if (statusRef.current !== 'playing' || w.over || w.phase !== 'player' || w.busy) return;
      const hit = hitTest(mx, my);
      if (!hit) {
        if (w.sel) clearSel(false);
        else if (w.inspect != null) {
          w.inspect = null;
          w.danger = null;
          bump();
        }
        return;
      }
      const [x, y] = hit;
      const u = unitAt(x, y);
      if (w.sel) {
        const su = byId(w.sel.id)!;
        if (w.sel.moved) {
          // 移动后必须了结行动：只认攻击目标
          if (u && u.side === 1 && w.attackSet.has(u.id)) strike(su, u, false, 'playerAct');
          return;
        }
        if (u && u.side === 0) {
          if (u.id === su.id) {
            clearSel(false);
          } else if (u.acted) {
            toastRef.current('该单位本回合已行动', 'info');
          } else {
            select(u);
          }
          return;
        }
        if (u && u.side === 1) {
          if (w.attackSet.has(u.id)) strike(su, u, false, 'playerAct');
          else toastRef.current('超出攻击范围：先移动到射程之内', 'info');
          return;
        }
        if (w.moveMap && w.moveMap.has(idx(x, y))) {
          startMove(su, x, y);
          return;
        }
        clearSel(false);
        return;
      }
      if (u && u.side === 0) {
        if (u.acted) toastRef.current('该单位本回合已行动', 'info');
        else select(u);
        return;
      }
      if (u && u.side === 1) {
        inspectEnemy(u);
        return;
      }
      if (w.inspect != null) {
        w.inspect = null;
        w.danger = null;
        bump();
      }
    }

    function rotate() {
      const w = wq();
      if (statusRef.current !== 'playing') return;
      w.rot = (w.rot + 1) & 3;
      sfx.click();
      bump();
    }

    function actDefend() {
      const w = wq();
      if (statusRef.current !== 'playing' || w.phase !== 'player' || w.busy || !w.sel) return;
      const u = byId(w.sel.id)!;
      u.defending = true;
      u.acted = true;
      const now = performance.now();
      w.effects.push({ kind: 'text', x: u.gx, y: u.gy, text: '防御', color: '#8fd0ff', t0: now, dur: 800 });
      w.sel = null;
      w.moveMap = null;
      w.attackSet = new Set();
      sfx.flip();
      bump();
    }

    function actWait() {
      const w = wq();
      if (statusRef.current !== 'playing' || w.phase !== 'player' || w.busy || !w.sel) return;
      const u = byId(w.sel.id)!;
      u.acted = true;
      w.sel = null;
      w.moveMap = null;
      w.attackSet = new Set();
      sfx.click();
      bump();
    }

    function actCancel() {
      const w = wq();
      if (statusRef.current !== 'playing' || w.phase !== 'player' || w.busy || !w.sel) return;
      clearSel(true);
      sfx.click();
    }

    function endTurn() {
      const w = wq();
      if (statusRef.current !== 'playing' || w.over || w.phase !== 'player' || w.busy) return;
      w.sel = null;
      w.inspect = null;
      w.danger = null;
      w.moveMap = null;
      w.attackSet = new Set();
      w.phase = 'enemy';
      w.busy = false;
      w.enemyQueue = w.units.filter((u) => u.side === 1 && !u.dead).map((u) => u.id);
      sfx.click();
      w.queue.push({ at: performance.now() + 320, type: 'enemyAct' });
      bump();
    }

    handlersRef.current = { tap, rotate, cancel: actCancel, defend: actDefend, wait: actWait, endTurn };

    // ---- 敌方 AI ----

    function planEnemy(u: Unit): { path: Array<[number, number]>; target: Unit | null } {
      const w = wq();
      const heroes = alive(0);
      if (heroes.length === 0) return { path: [], target: null };
      const reach = reachable(u, u.mov);
      let best: { score: number; ti: number; target: Unit } | null = null;
      for (const h of heroes) {
        const hH = terrainH(w.t[idx(h.gx, h.gy)]);
        for (const [ti, info] of reach) {
          const tx = ti % N;
          const ty = (ti / N) | 0;
          const th = terrainH(w.t[ti]);
          const d = cheby(tx, ty, h.gx, h.gy);
          if (d > u.rng) continue;
          if (d > 1 && losBlocked(tx, ty, th, h.gx, h.gy)) continue;
          const mult = Math.max(0.75, Math.min(1.5, 1 + HEIGHT_BONUS * (th - hH)));
          const dmg = Math.max(1, Math.round(u.atk * mult) - Math.round(h.def * (h.defending ? 1.5 : 1)));
          const canCtr = cheby(tx, ty, h.gx, h.gy) <= h.rng && (h.rng === 1 || !losBlocked(h.gx, h.gy, hH, tx, ty));
          const cMult = Math.max(0.75, Math.min(1.5, 1 + HEIGHT_BONUS * (hH - th)));
          const ctr = canCtr ? Math.max(1, Math.round(h.atk * COUNTER_MULT * cMult) - Math.round(u.def)) : 0;
          const score = dmg * 1.2 - ctr * 0.8 + (dmg >= h.hp ? 45 : 0) - info.cost * 0.3;
          if (!best || score > best.score) best = { score, ti, target: h };
        }
      }
      if (best) return { path: chainTo(reach, best.ti), target: best.target };
      const dmap = heroDistMap();
      let bt: { score: number; ti: number } | null = null;
      for (const [ti, info] of reach) {
        const d = dmap[ti] < 0 ? 99 : dmap[ti];
        const score = d * 2 + info.cost * 0.5 - terrainH(wq().t[ti]) * 1.2;
        if (!bt || score < bt.score) bt = { score, ti };
      }
      return { path: chainTo(reach, bt ? bt.ti : idx(u.gx, u.gy)), target: null };
    }

    // ---- 定时队列 ----

    function processQueue(now: number) {
      const w = wq();
      if (w.queue.length > 1) w.queue.sort((a, b) => a.at - b.at);
      while (w.queue.length > 0 && w.queue[0].at <= now) {
        const s = w.queue.shift()!;
        switch (s.type) {
          case 'walkEnd': {
            const u = s.id != null ? byId(s.id) : undefined;
            if (u && u.walk) {
              const last = u.walk.path[u.walk.path.length - 1];
              u.gx = last[0];
              u.gy = last[1];
              u.walk = null;
              bump();
            }
            break;
          }
          case 'moveDone': {
            const u = s.id != null ? byId(s.id) : undefined;
            if (u && w.sel && w.sel.id === u.id) {
              w.sel.moved = true;
              w.attackSet = new Set(foesInRange(u, u.gx, u.gy).map((e) => e.id));
              w.busy = false;
              bump();
            }
            break;
          }
          case 'dmg': {
            const att = s.attId != null ? byId(s.attId) : undefined;
            const def = s.defId != null ? byId(s.defId) : undefined;
            if (!att || !def || att.dead || def.dead || w.over) {
              finish(s.done ?? 'playerAct', s.origin ?? s.attId ?? 0, now);
              break;
            }
            const { dmg, hi } = calcDmg(att, def, !!s.counter);
            def.hp = Math.max(0, def.hp - dmg);
            w.effects.push({
              kind: 'dmg',
              x: def.gx,
              y: def.gy,
              text: `${dmg}`,
              color: def.side === 0 ? '#ff7080' : '#ffd75e',
              t0: now,
              dur: 850,
            });
            w.effects.push({ kind: 'hit', x: def.gx, y: def.gy, unitId: def.id, t0: now, dur: 260 });
            sfx.drop();
            if (hi && !w.hiTip) {
              w.hiTip = true;
              toastRef.current('⛰ 高地加成：站位比目标每高一层，伤害 +25%', 'info');
            }
            if (def.hp <= 0) {
              def.dead = true;
              def.deadT = now;
              w.effects.push({ kind: 'poof', x: def.gx, y: def.gy, t0: now, dur: 620 });
              sfx.mismatch();
              if (def.side === 1) toastRef.current(`⚔ 击败 ${def.name}！`, 'success');
              else toastRef.current(`💀 ${def.name} 倒下了…`, 'info');
              w.queue.push({ at: now + 560, type: 'checkEnd' });
              finish(s.done ?? 'playerAct', s.origin ?? s.attId ?? 0, now + 120);
            } else if (!s.counter && canCounter(def, att)) {
              w.queue.push({ at: now + 360, type: 'dmg', attId: def.id, defId: att.id, origin: s.origin ?? s.attId, counter: true, done: s.done });
            } else {
              finish(s.done ?? 'playerAct', s.origin ?? s.attId ?? 0, now + 140);
            }
            bump();
            break;
          }
          case 'afterAct': {
            const u = s.id != null ? byId(s.id) : undefined;
            if (u) u.acted = true;
            w.sel = null;
            w.moveMap = null;
            w.attackSet = new Set();
            w.busy = false;
            bump();
            break;
          }
          case 'enemyGo': {
            const u = s.attId != null ? byId(s.attId) : undefined;
            const t = s.defId != null ? byId(s.defId) : undefined;
            if (u && !u.dead && t && !t.dead) w.queue.push({ at: now + 40, type: 'dmg', attId: u.id, defId: t.id, counter: false, done: 'enemyNext' });
            else w.queue.push({ at: now + 80, type: 'nextEnemy' });
            break;
          }
          case 'enemyAct': {
            if (w.phase !== 'enemy' || w.over) break;
            const u = w.enemyQueue.length > 0 ? byId(w.enemyQueue.shift()!) : undefined;
            if (!u || u.dead) {
              w.queue.push({ at: now + 60, type: 'enemyAct' });
              break;
            }
            const plan = planEnemy(u);
            if (plan.path.length > 0) {
              startWalk(u, plan.path, { type: 'enemyGo', attId: u.id, defId: plan.target?.id });
              sfx.move();
            } else if (plan.target) {
              w.queue.push({ at: now + 80, type: 'enemyGo', attId: u.id, defId: plan.target.id });
            } else {
              w.queue.push({ at: now + 160, type: 'nextEnemy' });
            }
            break;
          }
          case 'nextEnemy': {
            if (w.phase !== 'enemy' || w.over) break;
            if (w.enemyQueue.length > 0) w.queue.push({ at: now + 120, type: 'enemyAct' });
            else w.queue.push({ at: now + 220, type: 'endEnemy' });
            break;
          }
          case 'endEnemy': {
            if (w.phase !== 'enemy' || w.over) break;
            w.phase = 'player';
            w.turn++;
            for (const h of alive(0)) {
              h.acted = false;
              h.defending = false;
            }
            w.busy = false;
            bump();
            break;
          }
          case 'checkEnd': {
            if (w.over) break;
            if (alive(1).length === 0) {
              w.over = true;
              sfx.win();
              const isNew = bestRef.current.updateBest(w.turn, (a, b) => a < b);
              setStatus('won');
              if (isNew) {
                sfx.record();
                toastRef.current(`🏆 新纪录！仅 ${w.turn} 回合全歼敌军`, 'record');
              } else {
                toastRef.current(`🏆 大获全胜！用时 ${w.turn} 回合`, 'success');
              }
            } else if (alive(0).length === 0) {
              w.over = true;
              sfx.lose();
              setStatus('lost');
              toastRef.current('💀 全军覆没……调整战术再来一局', 'info');
            }
            bump();
            break;
          }
        }
      }
    }

    // ---- 命中检测 ----

    function inPoly(px: number, py: number, poly: Array<[number, number]>): boolean {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }

    function hitTest(mx: number, my: number): [number, number] | null {
      const w = wq();
      const now = performance.now();
      const cells: Array<{ vx: number; vy: number; hpx: number; x: number; y: number }> = [];
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const [vx, vy] = rotPt(x, y, w.rot);
          cells.push({ vx, vy, hpx: terrainH(w.t[idx(x, y)]) * BH + SKIRT, x, y });
        }
      cells.sort((a, b) => b.vx + b.vy - (a.vx + a.vy));
      // 单位精灵与瓦片按深度统一竞争：站在巨岩后的单位，露出的头部仍可点选；
      // 被前景块盖住的身体部分则让位给瓦片（与画家算法渲染一致）
      const cands: Array<{ d: number; x: number; y: number }> = [];
      for (const c of cells) {
        const sx = OX + (c.vx - c.vy) * TW2;
        const sy = OY + (c.vx + c.vy) * TH2 - (c.hpx - SKIRT);
        const poly: Array<[number, number]> = [
          [sx, sy - TH2],
          [sx + TW2, sy],
          [sx + TW2, sy + c.hpx],
          [sx, sy + TH2 + c.hpx],
          [sx - TW2, sy + c.hpx],
          [sx - TW2, sy],
        ];
        if (inPoly(mx, my, poly)) cands.push({ d: c.vx + c.vy, x: c.x, y: c.y });
      }
      for (const u of w.units) {
        if (u.dead) continue;
        const pos = unitPos(w, u, now);
        const [vx, vy] = rotPt(pos.x, pos.y, w.rot);
        const sx = OX + (vx - vy) * TW2;
        const sy = OY + (vx + vy) * TH2 - (pos.h + pos.z) * BH;
        const img = sprites[u.kind];
        if (mx >= sx - img.width / 2 && mx <= sx + img.width / 2 && my >= sy - img.height + 2 && my <= sy + 2)
          cands.push({ d: vx + vy + 0.5, x: u.gx, y: u.gy });
      }
      if (cands.length > 0) {
        cands.sort((a, b) => b.d - a.d);
        return [cands[0].x, cands[0].y];
      }
      let bd = 22;
      let bx = -1;
      let by = -1;
      for (const c of cells) {
        const sx = OX + (c.vx - c.vy) * TW2;
        const sy = OY + (c.vx + c.vy) * TH2 - (c.hpx - SKIRT);
        const d = Math.hypot(mx - sx, my - sy);
        if (d < bd) {
          bd = d;
          bx = c.x;
          by = c.y;
        }
      }
      return bx >= 0 ? [bx, by] : null;
    }

    // ---- 渲染 ----

    function fillDiamond(cx: number, cy: number, fill: string, stroke?: string) {
      ctx.beginPath();
      ctx.moveTo(cx, cy - TH2 + 4);
      ctx.lineTo(cx + TW2 - 5, cy);
      ctx.lineTo(cx, cy + TH2 - 4);
      ctx.lineTo(cx - TW2 + 5, cy);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    function drawTile(x: number, y: number, vx: number, vy: number, w: World) {
      const tt = w.t[idx(x, y)];
      const h = terrainH(tt);
      const hpx = h * BH;
      const sx = OX + (vx - vy) * TW2;
      const sy = OY + (vx + vy) * TH2 - hpx;
      const total = hpx + SKIRT;
      if (total > 0) {
        const stone = tt === T_TOP || tt === T_ROCK;
        const sl = stone ? '#565b64' : '#4a3526';
        const sr = stone ? '#676c76' : '#5d4534';
        const lip = stone ? '#9a968c' : '#3e7c3a';
        ctx.fillStyle = sl;
        ctx.beginPath();
        ctx.moveTo(sx - TW2, sy);
        ctx.lineTo(sx, sy + TH2);
        ctx.lineTo(sx, sy + TH2 + total);
        ctx.lineTo(sx - TW2, sy + total);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = sr;
        ctx.beginPath();
        ctx.moveTo(sx + TW2, sy);
        ctx.lineTo(sx, sy + TH2);
        ctx.lineTo(sx, sy + TH2 + total);
        ctx.lineTo(sx + TW2, sy + total);
        ctx.closePath();
        ctx.fill();
        if (hpx > 0) {
          ctx.fillStyle = lip;
          ctx.beginPath();
          ctx.moveTo(sx - TW2, sy);
          ctx.lineTo(sx, sy + TH2);
          ctx.lineTo(sx, sy + TH2 + 3);
          ctx.lineTo(sx - TW2, sy + 3);
          ctx.closePath();
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(sx + TW2, sy);
          ctx.lineTo(sx, sy + TH2);
          ctx.lineTo(sx, sy + TH2 + 3);
          ctx.lineTo(sx + TW2, sy + 3);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.drawImage(tops[tt * 2 + ((x * 7 + y * 13) % 2)], sx - TW2, sy - TH2);
      const ti = idx(x, y);
      if (w.moveMap && w.sel) {
        const su = w.units.find((u) => u.id === w.sel!.id);
        if (!w.sel.moved && su && ti !== idx(su.gx, su.gy) && w.moveMap.has(ti))
          fillDiamond(sx, sy, 'rgba(90,160,255,0.32)', 'rgba(150,200,255,0.55)');
      }
      if (w.danger && w.danger.has(ti)) fillDiamond(sx, sy, 'rgba(255,80,95,0.20)');
    }

    function drawUnit(u: Unit, now: number, pos: { x: number; y: number; h: number; z: number }, w: World) {
      const [vx, vy] = rotPt(pos.x, pos.y, w.rot);
      const sx = OX + (vx - vy) * TW2;
      const sy = OY + (vx + vy) * TH2 - (pos.h + pos.z) * BH;
      let alpha = 1;
      let sink = 0;
      if (u.dead) {
        const p = Math.min(1, (now - u.deadT) / 600);
        alpha = 1 - p;
        sink = p * 6;
      } else if (u.side === 0 && u.acted && w.phase === 'player') {
        alpha = 0.55;
      }
      // 受击抖动
      let shx = 0;
      const hit = w.effects.find((e) => e.kind === 'hit' && e.unitId === u.id);
      if (hit) {
        const p = (now - hit.t0) / hit.dur;
        shx = Math.sin(p * Math.PI * 6) * 3 * (1 - p);
      }
      // 影子
      ctx.fillStyle = 'rgba(8,10,18,0.35)';
      ctx.beginPath();
      ctx.ellipse(sx, sy + 2 + sink, 20, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      // 攻击目标高亮
      if (w.attackSet.has(u.id)) fillDiamond(sx, sy, 'rgba(255,70,90,0.30)');
      // 队伍/状态环
      const pulse = 2.4 + Math.sin(now / 140) * 0.9;
      ctx.lineWidth = 2;
      if (w.sel?.id === u.id) {
        ctx.strokeStyle = '#ffd75e';
        ctx.lineWidth = pulse;
      } else if (w.attackSet.has(u.id)) {
        ctx.strokeStyle = '#ff5a6e';
        ctx.lineWidth = pulse;
      } else if (w.inspect === u.id) {
        ctx.strokeStyle = '#b48cff';
        ctx.lineWidth = 2.4;
      } else if (u.acted && u.side === 0) {
        ctx.strokeStyle = 'rgba(170,180,200,0.45)';
      } else {
        ctx.strokeStyle = u.side === 0 ? 'rgba(90,160,255,0.75)' : 'rgba(255,95,115,0.75)';
      }
      ctx.beginPath();
      ctx.ellipse(sx, sy + 2 + sink, 23, 10, 0, 0, Math.PI * 2);
      ctx.stroke();
      // 精灵
      const img = sprites[u.kind];
      const bob = !u.walk && !u.lunge && !u.dead ? Math.sin(now / 1000 * 2.6 + u.id * 1.9) * 1.5 : 0;
      const dy = sy - img.height + 2 - bob + sink;
      ctx.globalAlpha = alpha;
      if (u.side === 1) {
        ctx.save();
        ctx.translate(sx, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(img, -img.width / 2 + shx, dy);
        ctx.restore();
      } else {
        ctx.drawImage(img, sx - img.width / 2 + shx, dy);
      }
      ctx.globalAlpha = 1;
      // 血条
      const ratio = u.hp / u.maxHp;
      const bw = 30;
      const bx = sx - bw / 2;
      const by = sy - img.height - 10;
      ctx.fillStyle = 'rgba(10,12,22,0.75)';
      rr(ctx, bx - 1, by - 1, bw + 2, 6, 2);
      ctx.fill();
      ctx.fillStyle = ratio > 0.5 ? '#57df76' : ratio > 0.25 ? '#f2c14e' : '#f25f5f';
      ctx.fillRect(bx, by, Math.max(0, bw * ratio), 4);
      if (u.defending) {
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🛡', sx, by - 4);
      }
    }

    function drawEffects(now: number, w: World) {
      ctx.textAlign = 'center';
      for (const e of w.effects) {
        const p = (now - e.t0) / e.dur;
        const [vx, vy] = rotPt(e.x + 0.5, e.y + 0.5, w.rot);
        const sx = OX + (vx - vy) * TW2;
        const sy = OY + (vx + vy) * TH2 - terrainH(w.t[idx(e.x, e.y)]) * BH;
        if (e.kind === 'dmg' || e.kind === 'text') {
          const big = e.kind === 'dmg';
          ctx.globalAlpha = 1 - p * p;
          ctx.font = `bold ${big ? 16 : 12}px system-ui, sans-serif`;
          ctx.lineWidth = 3.5;
          ctx.strokeStyle = 'rgba(12,10,24,0.9)';
          const ty = sy - (big ? 42 : 34) - p * (big ? 24 : 14);
          ctx.strokeText(e.text!, sx, ty);
          ctx.fillStyle = e.color!;
          ctx.fillText(e.text!, sx, ty);
        } else if (e.kind === 'poof') {
          for (let i = 0; i < 7; i++) {
            const a = (i / 7) * Math.PI * 2 + p * 1.5;
            const r = 4 + p * 16;
            ctx.globalAlpha = (1 - p) * 0.7;
            ctx.fillStyle = '#d7dce8';
            ctx.beginPath();
            ctx.arc(sx + Math.cos(a) * r, sy - 12 + Math.sin(a) * r * 0.6, 2.6 * (1 - p) + 1, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          // 命中火花
          ctx.globalAlpha = 1 - p;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          const cy2 = sy - 24;
          ctx.beginPath();
          ctx.moveTo(sx - 8, cy2);
          ctx.lineTo(sx + 8, cy2);
          ctx.moveTo(sx, cy2 - 8);
          ctx.lineTo(sx, cy2 + 8);
          ctx.moveTo(sx - 5, cy2 - 5);
          ctx.lineTo(sx + 5, cy2 + 5);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }

    let raf = 0;
    const loop = (now: number) => {
      const w = wq();
      processQueue(now);
      w.effects = w.effects.filter((e) => now - e.t0 < e.dur);
      ctx.drawImage(bg, 0, 0);
      // 画家算法：瓦片与单位按视图深度排序，同深度瓦片在前
      const posMap = new Map<number, { x: number; y: number; h: number; z: number }>();
      const items: Array<{ d: number; k: number; u?: Unit; x?: number; y?: number; vx?: number; vy?: number }> = [];
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const [vx, vy] = rotPt(x, y, w.rot);
          items.push({ d: vx + vy, k: 0, x, y, vx, vy });
        }
      for (const u of w.units) {
        if (u.dead && now - u.deadT >= 650) continue;
        const pos = unitPos(w, u, now);
        posMap.set(u.id, pos);
        const [vx, vy] = rotPt(pos.x, pos.y, w.rot);
        items.push({ d: vx + vy, k: 1, u });
      }
      items.sort((a, b) => a.d - b.d || a.k - b.k);
      for (const it of items) {
        if (it.u) drawUnit(it.u, now, posMap.get(it.u.id)!, w);
        else drawTile(it.x!, it.y!, it.vx!, it.vy!, w);
      }
      drawEffects(now, w);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ============ 键盘 ============

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') handlersRef.current?.rotate();
      else if (e.key === 'Escape') handlersRef.current?.cancel();
      else if (e.key === 'Enter') {
        const s = statusRef.current;
        if (s !== 'playing') start();
      }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);

  // ============ 指针 ============

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (RW / rect.width);
    const my = (e.clientY - rect.top) * (RH / rect.height);
    handlersRef.current?.tap(mx, my);
  };

  // ============ HUD（事件驱动刷新，读取 worldRef 快照） ============

  const w = worldRef.current;
  const heroes = w.units.filter((u) => u.side === 0);
  const heroAlive = heroes.filter((u) => !u.dead).length;
  const selUnit = w.sel ? w.units.find((u) => u.id === w.sel!.id) : null;
  const insUnit = w.inspect != null ? w.units.find((u) => u.id === w.inspect && !u.dead) : null;
  const canCmd = status === 'playing' && w.phase === 'player' && !w.busy && !!w.sel;
  const canEnd = status === 'playing' && w.phase === 'player' && !w.busy;

  let info: string;
  if (status !== 'playing') info = '';
  else if (insUnit && !w.sel)
    info = `${insUnit.name}　HP ${insUnit.hp}/${insUnit.maxHp} · 攻 ${insUnit.atk} · 防 ${insUnit.def} · 移 ${insUnit.mov} · 程 ${insUnit.rng} —— ⚠ 红色区域为其威胁范围`;
  else if (selUnit && w.sel)
    info = w.sel.moved
      ? `${selUnit.name} HP ${selUnit.hp}/${selUnit.maxHp} —— 点红圈敌人攻击；或选 防御 / 待机 / 取消`
      : `${selUnit.name} HP ${selUnit.hp}/${selUnit.maxHp} —— 点蓝格移动；红圈敌人可直接攻击`;
  else info = '点选我方英雄下达指令 · 点敌方单位查看威胁范围';

  return (
    <GameShell
      meta={metaTactics3D}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>回合</span>
            <strong>{w.turn}</strong>
          </div>
          <div className="stat-box">
            <span>行动方</span>
            <strong className={w.phase === 'player' ? 'tc3d-us' : 'tc3d-them'}>{w.phase === 'player' ? '我方' : '敌方'}</strong>
          </div>
          <div className="stat-box">
            <span>我方存活</span>
            <strong>
              {heroAlive}/{heroes.length}
            </strong>
          </div>
          <div className="stat-box">
            <span>{metaTactics3D.bestScoreLabel}</span>
            <strong>{best.value != null ? `${best.value} 回合` : '—'}</strong>
          </div>
        </>
      }
    >
      <div className="tc3d">
        <div className="tc3d-stage">
          <canvas ref={canvasRef} className="tc3d-canvas" onPointerDown={onPointerDown} />
          {status === 'ready' && (
            <div className="tc3d-overlay">
              <h2>⚔️ 3D 战棋</h2>
              <p>
                指挥骑士、游侠、法师三位英雄，在等距 3D 战场上全歼兽人军团！
                <br />
                占高地伤害 +25% · 巨岩与高地平台会挡住远程 · 攻击残血敌人会招到反击
              </p>
              <p className="tc3d-keys">点选英雄 → 蓝格移动 → 点红圈敌人攻击 · 点敌方单位可查看威胁范围</p>
              <p className="tc3d-keys">🔄 旋转视角（快捷键 R）· Esc 取消指令 · 全歼敌人，回合越少评价越好</p>
              <button className="btn btn-primary" onClick={start}>
                开始战斗
              </button>
            </div>
          )}
          {status === 'won' && (
            <div className="tc3d-overlay">
              <h2>🏆 大获全胜！</h2>
              <p>
                仅用 {w.turn} 回合全歼兽人军团
                {best.value != null && ` · 最少回合纪录 ${best.value}`}
              </p>
              <button className="btn btn-primary" onClick={start}>
                再战一局
              </button>
            </div>
          )}
          {status === 'lost' && (
            <div className="tc3d-overlay">
              <h2>💀 全军覆没…</h2>
              <p>兽人军团占领了战场，重整旗鼓再来一局！</p>
              <button className="btn btn-primary" onClick={start}>
                重整旗鼓
              </button>
            </div>
          )}
        </div>
        <p className="tc3d-info">{info}</p>
        <div className="tc3d-actions">
          <button className="btn btn-ghost" onClick={() => handlersRef.current?.rotate()}>
            🔄 旋转视角
          </button>
          <button className="btn btn-ghost" disabled={!canCmd} onClick={() => handlersRef.current?.defend()}>
            🛡 防御
          </button>
          <button className="btn btn-ghost" disabled={!canCmd} onClick={() => handlersRef.current?.wait()}>
            ⏳ 待机
          </button>
          <button className="btn btn-ghost" disabled={!canCmd} onClick={() => handlersRef.current?.cancel()}>
            ↩ 取消
          </button>
          <button className="btn btn-primary" disabled={!canEnd} onClick={() => handlersRef.current?.endTurn()}>
            🏁 结束回合
          </button>
        </div>
        <p className="hint">蓝格=可移动（上坡耗 2 移动力）· 点红圈敌人攻击 · 点敌方单位看威胁范围 · 🔄 旋转视角 / R · Esc 取消</p>
      </div>
    </GameShell>
  );
}
