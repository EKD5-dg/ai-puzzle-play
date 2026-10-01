import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { useBestScore } from '../core/sync';
import { metaQubic3D } from '../core/gameMetas';

// ============ 棋盘常量 ============

/** 4×4×4：64 格、76 条直线，是"自由落子"版 3D 井字最经典也最好读的尺寸 */
const N = 4;
const CELLS = N * N * N;
const HUMAN = 1;
const AI = 2;

const idxOf = (x: number, y: number, z: number) => (z * N + y) * N + x;
const ax = (i: number) => i % N;
const ay = (i: number) => Math.floor(i / N) % N;
const az = (i: number) => Math.floor(i / (N * N));
const emptyBoard = (): number[] => new Array(CELLS).fill(0);
const oppOf = (p: number) => (p === HUMAN ? AI : HUMAN);

/**
 * 全部 76 条"四子直线"。方向取 [-1,0,1]³ 中首个非零分量为正的 13 个，
 * 起点为该方向上"再退一步就出界"的格子——只登记一次，且必须整条线都在盘内。
 */
const LINES: number[][] = (() => {
  const out: number[][] = [];
  for (let a = -1; a <= 1; a++) {
    for (let b = -1; b <= 1; b++) {
      for (let c = -1; c <= 1; c++) {
        const v = [a, b, c];
        const first = v.findIndex((n) => n !== 0);
        if (first < 0 || v[first] < 0) continue;
        for (let z = 0; z < N; z++) {
          for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
              const px = x - a;
              const py = y - b;
              const pz = z - c;
              if (px >= 0 && px < N && py >= 0 && py < N && pz >= 0 && pz < N) continue;
              const cells: number[] = [];
              let ok = true;
              for (let k = 0; k < N; k++) {
                const qx = x + a * k;
                const qy = y + b * k;
                const qz = z + c * k;
                if (qx < 0 || qx >= N || qy < 0 || qy >= N || qz < 0 || qz >= N) {
                  ok = false;
                  break;
                }
                cells.push(idxOf(qx, qy, qz));
              }
              if (ok) out.push(cells);
            }
          }
        }
      }
    }
  }
  return out;
})();

/** 每个格子参与了哪几条线：落子与胜负判定只查这几条，不必扫全部 76 条 */
const LINES_THROUGH: number[][] = (() => {
  const t: number[][] = Array.from({ length: CELLS }, () => []);
  LINES.forEach((line, li) => line.forEach((c) => t[c].push(li)));
  return t;
})();

// ============ 规则 ============

/** 落在 i 的这一手是否连成一线，命中则返回该线 */
function winLineAt(board: number[], i: number): number[] | null {
  const p = board[i];
  if (!p) return null;
  for (const li of LINES_THROUGH[i]) {
    const line = LINES[li];
    let ok = true;
    for (const c of line) {
      if (board[c] !== p) {
        ok = false;
        break;
      }
    }
    if (ok) return line;
  }
  return null;
}

/** p 落下去就能连成四子的格子（即"再下一手即胜"的威胁点） */
function winningSquares(board: number[], p: number): number[] {
  const out = new Set<number>();
  for (const line of LINES) {
    let mine = 0;
    let open = -1;
    let blocked = false;
    for (const c of line) {
      const v = board[c];
      if (v === p) mine++;
      else if (v === 0) open = c;
      else {
        blocked = true;
        break;
      }
    }
    if (!blocked && mine === N - 1 && open >= 0) out.add(open);
  }
  return [...out];
}

/** 空格子是否被六个正交邻居完全包住（渲染时跳过，纯视觉降噪） */
function enclosedCell(board: number[], i: number): boolean {
  const x = ax(i);
  const y = ay(i);
  const z = az(i);
  if (x === 0 || x === N - 1 || y === 0 || y === N - 1 || z === 0 || z === N - 1) return false;
  return !!board[idxOf(x + 1, y, z)] && !!board[idxOf(x - 1, y, z)] && !!board[idxOf(x, y + 1, z)] && !!board[idxOf(x, y - 1, z)] && !!board[idxOf(x, y, z + 1)] && !!board[idxOf(x, y, z - 1)];
}

// ============ AI：带 alpha-beta 与节点预算的 negamax ============

const WIN_SCORE = 1_000_000;
/** 自身某条线上 n 子对应的价值（4 子在搜索里直接判胜，不走这张表） */
const LINE_W = [0, 1, 14, 240];
/** 开放端权重：两端被堵死的组合几乎连不成，只给四成价 */
const OPEN_W = [0.4, 0.7, 1, 1, 1];

function lineStat(board: number[], line: number[], me: number): { mine: number; theirs: number; open: number } {
  let mine = 0;
  let theirs = 0;
  let open = 0;
  for (const c of line) {
    const v = board[c];
    if (v === me) mine++;
    else if (v === 0) open++;
    else theirs++;
  }
  return { mine, theirs, open };
}

function evaluate(board: number[], me: number): number {
  let s = 0;
  for (const line of LINES) {
    const st = lineStat(board, line, me);
    if (st.mine && st.theirs) continue; // 混线：双方都断了，暂不计分
    const w = OPEN_W[st.open] ?? 1;
    if (st.mine) s += LINE_W[st.mine] * w;
    if (st.theirs) s -= LINE_W[st.theirs] * w * 1.08; // 堵住对方的危险线略优先于自己铺活线
  }
  return s;
}

/** 走 m 之后的静态估值（只算经过 m 的几条线，用于排序，是搜索里的热点路径） */
function moveScore(board: number[], m: number, p: number): number {
  board[m] = p;
  let s = 0;
  for (const li of LINES_THROUGH[m]) {
    const st = lineStat(board, LINES[li], p);
    if (st.mine && st.theirs) continue;
    const w = OPEN_W[st.open] ?? 1;
    if (st.mine) s += LINE_W[st.mine] * w;
    if (st.theirs) s -= LINE_W[st.theirs] * w * 1.08;
  }
  board[m] = 0;
  return s;
}

const nearScratch = new Uint8Array(CELLS);

/** 候选步：只考虑已有子的 26 邻域（远处空格子永远不可能连成线），空盘时全盘可选 */
function candidates(board: number[]): number[] {
  nearScratch.fill(0);
  for (let i = 0; i < CELLS; i++) {
    if (!board[i]) continue;
    const x = ax(i);
    const y = ay(i);
    const z = az(i);
    for (let dz = -1; dz <= 1; dz++) {
      const qz = z + dz;
      if (qz < 0 || qz >= N) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const qy = y + dy;
        if (qy < 0 || qy >= N) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const qx = x + dx;
          if (qx < 0 || qx >= N) continue;
          const j = idxOf(qx, qy, qz);
          if (!board[j]) nearScratch[j] = 1;
        }
      }
    }
  }
  const out: number[] = [];
  for (let j = 0; j < CELLS; j++) if (nearScratch[j]) out.push(j);
  if (out.length) return out;
  for (let j = 0; j < CELLS; j++) if (!board[j]) out.push(j);
  return out;
}

interface Ctx {
  nodes: number;
  budget: number;
}

function negamax(board: number[], depth: number, alphaIn: number, beta: number, ctx: Ctx, me: number): number {
  // 节点预算耗尽就地截断：困难档靠预算而非固定深度换算力，思考时间恒定在可接受范围
  if (++ctx.nodes > ctx.budget) return evaluate(board, me);
  const moves = candidates(board)
    .map((m) => ({ m, s: moveScore(board, m, me) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 18);
  if (!moves.length) return 0; // 无子可下 = 满盘和棋
  let alpha = alphaIn;
  let best = -Infinity;
  for (const { m } of moves) {
    board[m] = me;
    let val: number;
    if (winLineAt(board, m)) val = WIN_SCORE;
    else if (depth <= 1) val = -evaluate(board, oppOf(me));
    else val = -negamax(board, depth - 1, -beta, -alpha, ctx, oppOf(me));
    board[m] = 0;
    if (val > best) best = val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

const LEVELS = [
  { name: '简单', depth: 2, budget: 3000 },
  { name: '困难', depth: 4, budget: 22000 },
] as const;

/** 选一步：先秒解"自己能赢"与"必须堵"，再进搜索 */
function chooseMove(board: number[], level: number): { move: number; ms: number } {
  const t0 = performance.now();
  let empty = 0;
  for (let i = 0; i < CELLS; i++) if (!board[i]) empty++;
  if (!empty) return { move: -1, ms: 0 };
  const win = winningSquares(board, AI);
  if (win.length) return { move: win[0], ms: performance.now() - t0 };
  const block = winningSquares(board, HUMAN);
  if (block.length) return { move: block[0], ms: performance.now() - t0 };

  const cfg = LEVELS[level];
  const ctx: Ctx = { nodes: 0, budget: cfg.budget };
  const moves = candidates(board)
    .map((m) => ({ m, s: moveScore(board, m, AI) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 24);
  let best = -Infinity;
  let bestMove = moves.length ? moves[0].m : 0;
  for (const { m } of moves) {
    board[m] = AI;
    const val = winLineAt(board, m)
      ? WIN_SCORE
      : -negamax(board, cfg.depth - 1, -Infinity, -best, ctx, HUMAN);
    board[m] = 0;
    if (val > best) {
      best = val;
      bestMove = m;
    }
    if (ctx.nodes > ctx.budget) break;
  }
  return { move: bestMove, ms: performance.now() - t0 };
}

// ============ 渲染常量 ============

const RW = 560;
const RH = 420;
const CX = RW / 2;
const CY = RH * 0.5;
const FOCAL = 700;
const GAP = 1;
const CUBE = 0.78;
const HALF = (N - 1) / 2;
const PITCH_MIN = -0.35;
const PITCH_MAX = 1.25;
const DIST_MIN = 7;
const DIST_MAX = 15;

/** 盒子六面：法线 + 沿周界的 4 角 + 受光系数（顶最亮、底最暗） */
const FACES: Array<{ n: [number, number, number]; idx: [number, number, number, number]; sh: number }> = [
  { n: [1, 0, 0], idx: [1, 5, 6, 2], sh: 0.86 },
  { n: [-1, 0, 0], idx: [0, 3, 7, 4], sh: 0.6 },
  { n: [0, 1, 0], idx: [3, 2, 6, 7], sh: 1 },
  { n: [0, -1, 0], idx: [0, 1, 5, 4], sh: 0.38 },
  { n: [0, 0, 1], idx: [4, 7, 6, 5], sh: 0.93 },
  { n: [0, 0, -1], idx: [0, 1, 2, 3], sh: 0.52 },
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

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 格子下标 → 世界坐标（棋盘居中，y 为高度轴） */
const cellPos = (i: number): [number, number, number] => [(ax(i) - HALF) * GAP, (ay(i) - HALF) * GAP, (az(i) - HALF) * GAP];

interface Cam {
  yaw: number;
  pitch: number;
  dist: number;
}

const defaultCam = (): Cam => ({ yaw: 0.72, pitch: 0.44, dist: 10.5 });

// ============ 主组件 ============

export default function Qubic3D() {
  const [level, setLevel] = useState(1);
  const [board, setBoard] = useState<number[]>(emptyBoard);
  const [turn, setTurn] = useState<'human' | 'ai'>('human');
  const [winner, setWinner] = useState<0 | 1 | 2 | 3>(0);
  const [lastMove, setLastMove] = useState(-1);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [streak, setStreak] = useState(0);
  const [newRecord, setNewRecord] = useState(false);
  const [thinkMs, setThinkMs] = useState(0);
  const [hintOn, setHintOn] = useState(false);
  const { toast } = useToast();
  const best = useBestScore(`${metaQubic3D.id}:${level}`);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<Cam>(defaultCam());
  // rAF 常驻且闭包为空，逻辑状态统一走 ref 镜像
  const boardRef = useRef<number[]>(board);
  const lastRef = useRef(lastMove);
  const turnRef = useRef(turn);
  const winnerRef = useRef(winner);
  const hoverRef = useRef(-1);
  const hintRef = useRef(hintOn);
  const winRef = useRef<{ line: number[]; at: number; by: number } | null>(null);
  boardRef.current = board;
  lastRef.current = lastMove;
  turnRef.current = turn;
  winnerRef.current = winner;
  hintRef.current = hintOn;

  const reset = useCallback(() => {
    setBoard(emptyBoard());
    setTurn('human');
    setWinner(0);
    setLastMove(-1);
    setThinkMs(0);
    setNewRecord(false);
    winRef.current = null;
  }, []);

  const changeLevel = useCallback(
    (lv: number) => {
      if (lv === level) return;
      setLevel(lv);
      reset();
    },
    [level, reset],
  );

  useEffect(() => {
    if (turn !== 'ai' || winner !== 0) return;
    const snapshot = boardRef.current;
    const t = window.setTimeout(() => {
      const work = snapshot.slice();
      const { move, ms } = chooseMove(work, level);
      setThinkMs(Math.round(ms));
      if (move < 0) {
        setWinner(3);
        return;
      }
      sfx.move();
      setBoard((prev) => {
        const next = [...prev];
        next[move] = AI;
        return next;
      });
      setLastMove(move);
      setTurn('human');
    }, 380);
    return () => window.clearTimeout(t);
  }, [turn, winner, level]);

  // ============ 胜负判定（只看最后一手，任何位置连四都能命中） ============

  useEffect(() => {
    if (winner !== 0 || lastMove < 0) return;
    const line = winLineAt(board, lastMove);
    if (line) {
      const w = board[lastMove] as 1 | 2;
      winRef.current = { line, at: performance.now() / 1000, by: w };
      setWinner(w);
      if (w === HUMAN) {
        sfx.win();
        const next = streak + 1;
        setWins((v) => v + 1);
        setStreak(next);
        const isNew = best.updateBest(next, (a, b) => a > b);
        setNewRecord(isNew);
        toast(isNew ? `🏆 新纪录！${next} 连胜` : `🎉 你赢了！当前 ${next} 连胜`, isNew ? 'record' : 'success');
      } else {
        sfx.lose();
        setLosses((v) => v + 1);
        setStreak(0);
        toast('💀 电脑连成了四子，再来一局！', 'info');
      }
    } else if (board.every((c) => c !== 0)) {
      winRef.current = null;
      setWinner(3);
      toast('🤝 满盘和棋！', 'info');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, lastMove, winner, streak]);

  // ============ 命中测试：取指针下"最靠前"的格子（与画家算法同序） ============

  const hitTest = useCallback((px: number, py: number): number => {
    const cam = camRef.current;
    const cosY = Math.cos(cam.yaw);
    const sinY = Math.sin(cam.yaw);
    const cosP = Math.cos(cam.pitch);
    const sinP = Math.sin(cam.pitch);
    let bestIdx = -1;
    let bestDepth = Infinity;
    for (let i = 0; i < CELLS; i++) {
      const [x, y, z] = cellPos(i);
      const rx = x * cosY - z * sinY;
      const rz = x * sinY + z * cosY;
      const vy = y * cosP + rz * sinP;
      const vz = -y * sinP + rz * cosP;
      const d = vz + cam.dist;
      if (d < 0.6) continue;
      const s = FOCAL / d;
      const sx = CX + rx * s;
      const sy = CY - vy * s;
      // 用半对角做圆近似：方块在屏幕上就是一枚小菱形，圆判定更宽容也更好点
      const rad = CUBE * 0.58 * s;
      if ((px - sx) * (px - sx) + (py - sy) * (py - sy) <= rad * rad && d < bestDepth) {
        bestDepth = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }, []);

  // ============ 鼠标 / 触屏 ============

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let downX = 0;
    let downY = 0;
    let dragging = false;
    // 按下的所有指针：单指拖 = 转视角，双指 = 捏合缩放（触屏上唯一的缩放手势）
    const pts = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;

    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * RW, y: ((e.clientY - r.top) / r.height) * RH };
    };

    const span = () => {
      const it = [...pts.values()];
      return it.length < 2 ? 0 : Math.hypot(it[0].x - it[1].x, it[0].y - it[1].y);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 1) {
        downX = p.x;
        downY = p.y;
        dragging = false;
      } else {
        dragging = true; // 双指期间一律不算点击，避免捏合结束时误落一子
        pinchDist = span();
      }
      canvas.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      const p = local(e);
      if (pts.has(e.pointerId)) pts.set(e.pointerId, p);
      if (pts.size >= 2) {
        const d = span();
        if (pinchDist > 4 && d > 4) {
          const cam = camRef.current;
          // 手指分开 = 拉近：距离比取倒数
          cam.dist = clamp(cam.dist * (pinchDist / d), DIST_MIN, DIST_MAX);
        }
        pinchDist = d;
        return;
      }
      if (pts.size === 1) {
        const dx = p.x - downX;
        const dy = p.y - downY;
        if (!dragging && dx * dx + dy * dy > 30) dragging = true;
        if (dragging) {
          const cam = camRef.current;
          cam.yaw += dx * 0.011;
          cam.pitch = clamp(cam.pitch + dy * 0.009, PITCH_MIN, PITCH_MAX);
          downX = p.x;
          downY = p.y;
        }
      }
      hoverRef.current = turnRef.current === 'human' && winnerRef.current === 0 ? hitTest(p.x, p.y) : -1;
    };

    const onUp = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      const alone = pts.size === 1;
      // 先记下本次手势有没有拖过：dragging 下面会被重置成"下次手势的初始态"，
      // 拿重置后的值判点击，拖拽收手就会被当成一次点击、平白多落一子
      const wasDragging = dragging;
      pts.delete(e.pointerId);
      if (pts.size === 0) dragging = false;
      if (!alone) return;
      const p = local(e);
      const dx = p.x - downX;
      const dy = p.y - downY;
      if (!wasDragging && dx * dx + dy * dy <= 30) {
        const hit = hitTest(p.x, p.y);
        if (hit >= 0 && !boardRef.current[hit] && turnRef.current === 'human' && winnerRef.current === 0) {
          sfx.move();
          setBoard((prev) => {
            const next = [...prev];
            next[hit] = HUMAN;
            return next;
          });
          setLastMove(hit);
          setTurn('ai');
        }
      }
    };

    const onLeave = () => {
      hoverRef.current = -1;
    };

    // 手势被打断（系统手势、窗口切走）时清空按下的指针，否则下一次单指移动会被当成残留的双指捏合
    const onCancel = () => {
      pts.clear();
      dragging = false;
      hoverRef.current = -1;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = camRef.current;
      cam.dist = clamp(cam.dist + e.deltaY * 0.0035, DIST_MIN, DIST_MAX);
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [hitTest]);

  // ============ 键盘 ============

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const cam = camRef.current;
      const k = e.code;
      if (k === 'ArrowLeft') cam.yaw -= 0.18;
      else if (k === 'ArrowRight') cam.yaw += 0.18;
      else if (k === 'ArrowUp') cam.pitch = clamp(cam.pitch - 0.12, PITCH_MIN, PITCH_MAX);
      else if (k === 'ArrowDown') cam.pitch = clamp(cam.pitch + 0.12, PITCH_MIN, PITCH_MAX);
      else if (k === 'KeyR') camRef.current = defaultCam();
      else if (k === 'KeyH') setHintOn((v) => !v);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);

  // ============ 主循环 ============

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = RW * dpr;
    canvas.height = RH * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 漂浮尘埃，给静止画面一点生气
    const motes = Array.from({ length: 34 }, () => ({
      x: Math.random() * RW,
      y: Math.random() * RH,
      r: 0.6 + Math.random() * 1.5,
      v: 3 + Math.random() * 9,
      a: 0.08 + Math.random() * 0.22,
    }));

    const px = new Array<number>(8);
    const py = new Array<number>(8);
    const pd = new Array<number>(8);

    interface Face {
      depth: number;
      pts: Array<[number, number]>;
      fill: string;
      stroke: string | null;
      lw: number;
    }

    let raf = 0;

    const loop = (now: number) => {
      const t = now / 1000;
      const cam = camRef.current;
      const cosY = Math.cos(cam.yaw);
      const sinY = Math.sin(cam.yaw);
      const cosP = Math.cos(cam.pitch);
      const sinP = Math.sin(cam.pitch);
      const D = cam.dist;
      const b = boardRef.current;
      const hover = hoverRef.current;
      const win = winRef.current;

      const rot = (x: number, y: number, z: number) => {
        const rx = x * cosY - z * sinY;
        const rz = x * sinY + z * cosY;
        return { rx, vy: y * cosP + rz * sinP, vz: -y * sinP + rz * cosP };
      };
      const proj = (x: number, y: number, z: number) => {
        const r = rot(x, y, z);
        const d = r.vz + D;
        const s = FOCAL / Math.max(0.05, d);
        return { x: CX + r.rx * s, y: CY - r.vy * s, s, d };
      };

      // ---- 背景 ----
      const bg = ctx.createRadialGradient(CX, CY * 0.86, 20, CX, CY, RW * 0.78);
      bg.addColorStop(0, '#1c2a5e');
      bg.addColorStop(0.55, '#111a3f');
      bg.addColorStop(1, '#070a1a');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, RW, RH);

      for (const m of motes) {
        m.y -= m.v * 0.016;
        if (m.y < -4) m.y = RH + 4;
        ctx.fillStyle = `rgba(180,205,255,${m.a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(m.x + Math.sin(t * 0.4 + m.r * 9) * 6, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // ---- 地面网格（提供纵深参照） ----
      ctx.lineWidth = 1;
      for (let g = -5; g <= 5; g++) {
        const a1 = proj(g * 0.9, -2.6, -4.5);
        const a2 = proj(g * 0.9, -2.6, 4.5);
        const b1 = proj(-4.5, -2.6, g * 0.9);
        const b2 = proj(4.5, -2.6, g * 0.9);
        const fade = clamp(1 - Math.abs(g) / 7, 0.15, 1);
        ctx.strokeStyle = `rgba(120,160,255,${(0.075 * fade).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a1.x, a1.y);
        ctx.lineTo(a2.x, a2.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(b1.x, b1.y);
        ctx.lineTo(b2.x, b2.y);
        ctx.stroke();
      }

      // ---- 4×4×4 晶格笼：6 个面各画 4×4 网格 + 12 条外棱 ----
      // 早先逐格画 64 只空线框盒，内部棱线互相叠加成一团噪点；改为只画"格子骨架"，
      // 每个空位用一枚圆点表示，棋盘一眼就读得懂
      const G = HALF + 0.5;
      ctx.lineWidth = 1;
      const cage: Array<[[number, number, number], [number, number, number]]> = [];
      for (let t = -G + 1; t <= G - 1; t++) {
        cage.push([[-G, t, -G], [G, t, -G]]);
        cage.push([[-G, t, G], [G, t, G]]);
        cage.push([[t, -G, -G], [t, G, -G]]);
        cage.push([[t, -G, G], [t, G, G]]);
        cage.push([[-G, -G, t], [-G, G, t]]);
        cage.push([[G, -G, t], [G, G, t]]);
        cage.push([[-G, t, -G], [-G, t, G]]);
        cage.push([[G, t, -G], [G, t, G]]);
      }
      cage.push(
        [[-G, -G, -G], [G, -G, -G]],
        [[G, -G, -G], [G, G, -G]],
        [[G, G, -G], [-G, G, -G]],
        [[-G, G, -G], [-G, -G, -G]],
        [[-G, -G, G], [G, -G, G]],
        [[G, -G, G], [G, G, G]],
        [[G, G, G], [-G, G, G]],
        [[-G, G, G], [-G, -G, G]],
        [[-G, -G, -G], [-G, -G, G]],
        [[G, -G, -G], [G, -G, G]],
        [[G, G, -G], [G, G, G]],
        [[-G, G, -G], [-G, G, G]],
      );
      for (const [a, b] of cage) {
        const pa = proj(a[0], a[1], a[2]);
        const pb = proj(b[0], b[1], b[2]);
        const fog = clamp(((pa.d + pb.d) / 2 - D * 0.72) / (D * 0.7), 0, 1);
        ctx.strokeStyle = `rgba(140,175,255,${(0.2 - 0.13 * fog).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }

      // ---- 盒子绘制：背面剔除后按面深度排序 ----
      const drawBox = (
        x0: number,
        x1: number,
        y0: number,
        y1: number,
        z0: number,
        z1: number,
        hue: number,
        sat: number,
        lig: number,
        fillA: number,
        stroke: string | null,
        lw: number,
        alpha = 1,
      ) => {
        for (let i = 0; i < 8; i++) {
          const c = CORNERS[i];
          const p = proj(c[0] ? x1 : x0, c[1] ? y1 : y0, c[2] ? z1 : z0);
          px[i] = p.x;
          py[i] = p.y;
          pd[i] = p.d;
        }
        const ctr = rot((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
        const vv = ctr.vz + D;
        const faces: Face[] = [];
        for (const f of FACES) {
          const nr = rot(f.n[0], f.n[1], f.n[2]);
          if (nr.rx * ctr.rx + nr.vy * ctr.vy + nr.vz * vv >= 0) continue; // 背面剔除
          const [i0, i1, i2, i3] = f.idx;
          faces.push({
            depth: (pd[i0] + pd[i1] + pd[i2] + pd[i3]) / 4,
            pts: [
              [px[i0], py[i0]],
              [px[i1], py[i1]],
              [px[i2], py[i2]],
              [px[i3], py[i3]],
            ],
            fill: `hsla(${hue}, ${sat}%, ${Math.round(clamp(lig * f.sh, 0, 100))}%, ${fillA})`,
            stroke,
            lw,
          });
        }
        faces.sort((a, c) => c.depth - a.depth);
        ctx.globalAlpha = alpha;
        for (const f of faces) {
          ctx.beginPath();
          ctx.moveTo(f.pts[0][0], f.pts[0][1]);
          for (let i = 1; i < 4; i++) ctx.lineTo(f.pts[i][0], f.pts[i][1]);
          ctx.closePath();
          ctx.fillStyle = f.fill;
          ctx.fill();
          if (f.stroke) {
            ctx.strokeStyle = f.stroke;
            ctx.lineWidth = f.lw;
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      };

      // ---- 威胁提示：能一手连四的空格子 ----
      const threatMine = hintRef.current ? winningSquares(b, HUMAN) : [];
      const threatTheirs = hintRef.current ? winningSquares(b, AI) : [];
      const threatMineSet = new Set(threatMine);
      const threatTheirsSet = new Set(threatTheirs);
      const winSet = new Set(win ? win.line : []);

      interface Drawable {
        depth: number;
        draw: () => void;
      }
      const items: Drawable[] = [];
      const half = CUBE / 2;

      for (let i = 0; i < CELLS; i++) {
        const [x, y, z] = cellPos(i);
        const depth = rot(x, y, z).vz + D;
        const v = b[i];
        const isHover = i === hover && v === 0;
        const inWin = winSet.has(i);
        // 远端方块压暗一点，给纵深一个明确线索
        const fog = clamp((depth - D * 0.72) / (D * 0.7), 0, 1);
        const lig = (inWin ? 68 : v === HUMAN ? 57 : v === AI ? 59 : 60) * (1 - fog * 0.22);
        // 空格子若六个正交邻居都被占满，就完全被包在里面，画了也只剩一层噪声
        if (v === 0 && !isHover && !threatMineSet.has(i) && !threatTheirsSet.has(i) && enclosedCell(b, i)) continue;

        items.push({
          depth,
          draw: () => {
            // 空格子的线框也吃雾：远处的压到近乎看不见，视觉层次交给前壳
            const emptyA = (0.035 + 0.14 * (1 - fog)).toFixed(3);
            const stroke = inWin
              ? 'rgba(255,228,150,0.95)'
              : threatMineSet.has(i)
                ? 'rgba(96,240,170,0.9)'
                : threatTheirsSet.has(i)
                  ? 'rgba(255,120,140,0.85)'
                  : isHover
                    ? 'rgba(130,235,255,0.95)'
                    : v === 0
                      ? `rgba(150,180,240,${emptyA})`
                      : 'rgba(10,16,32,0.3)';
            const lw = inWin ? 2 : threatMineSet.has(i) || threatTheirsSet.has(i) ? 2 : isHover ? 1.8 : 1;

            if (isHover) {
              // 悬停：半透明实体预览，比空框更像"这一手归你了"
              drawBox(x - half, x + half, y - half, y + half, z - half, z + half, 187, 78, 58, 0.3, stroke, lw);
            }
            if (v === 0) {
              // 空位只留一枚落点圆点（外加悬停时的实体预览），不再画整只线框盒
              if (threatMineSet.has(i) || threatTheirsSet.has(i)) {
                drawBox(x - half, x + half, y - half, y + half, z - half, z + half, 214, 42, 62, 0.05, stroke, lw);
              } else if (!isHover) {
                const p = proj(x, y, z);
                ctx.fillStyle = `rgba(168,196,245,${(0.14 + 0.3 * (1 - fog)).toFixed(3)})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
                ctx.fill();
              }
            } else {
              const hue = inWin ? 45 : v === HUMAN ? 187 : 348;
              const sat = inWin ? 92 : v === HUMAN ? 74 : 70;
              drawBox(x - half, x + half, y - half, y + half, z - half, z + half, hue, sat, lig, 1, stroke, lw);
              // 顶面补一层薄高光，方块不再是一坨平色
              drawBox(x - half, x + half, y + half - 0.001, y + half + 0.012, z - half, z + half, hue, sat, Math.min(96, lig + 22), 0.42, null, 0);
            }

            if (threatMineSet.has(i) || threatTheirsSet.has(i)) {
              const p = proj(x, y, z);
              ctx.fillStyle = threatMineSet.has(i) ? 'rgba(140,255,200,0.95)' : 'rgba(255,150,165,0.9)';
              ctx.beginPath();
              ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
              ctx.fill();
            }
          },
        });
      }
      items.sort((a, c) => c.depth - a.depth);
      for (const it of items) it.draw();

      // ---- 最后一手：呼吸光环 ----
      const lm = lastRef.current;
      if (lm >= 0 && b[lm]) {
        const [x, y, z] = cellPos(lm);
        const p = proj(x, y, z);
        // 环贴着方块顶面走，别糊成一坨盖住棋子
        const r = CUBE * 0.5 * p.s;
        const pulse = 0.35 + 0.4 * Math.abs(Math.sin(t * 3.2));
        ctx.strokeStyle = `rgba(255,255,255,${(0.45 * pulse).toFixed(3)})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y - CUBE * 0.42 * p.s, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // ---- 胜利：一束光贯穿四子 + 扩散光环 ----
      if (win) {
        const pts = win.line.map((i) => {
          const [x, y, z] = cellPos(i);
          return proj(x, y, z);
        });
        const age = t - win.at;
        const k = clamp(age / 0.7, 0, 1);
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // 宽而淡的底光 + 细而亮的芯：光束要盖过棋子，不能细成一根线
        ctx.shadowColor = win.by === HUMAN ? 'rgba(120,245,255,0.95)' : 'rgba(255,150,170,0.95)';
        ctx.shadowBlur = 22;
        ctx.strokeStyle = win.by === HUMAN ? 'rgba(120,235,255,0.32)' : 'rgba(255,140,165,0.32)';
        ctx.lineWidth = 15;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        ctx.strokeStyle = win.by === HUMAN ? 'rgba(190,252,255,0.95)' : 'rgba(255,200,215,0.95)';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.restore();

        // 从连线中心扩散的环
        const mid = pts[Math.floor(pts.length / 2)];
        ctx.strokeStyle = `rgba(255,255,255,${(0.5 * (1 - k)).toFixed(3)})`;
        ctx.lineWidth = 2 * (1 - k) + 0.4;
        ctx.beginPath();
        ctx.arc(mid.x, mid.y, 14 + k * 150, 0, Math.PI * 2);
        ctx.stroke();
      }

      // ---- 画布内 HUD ----
      const emptyCount = b.reduce((n, v) => n + (v === 0 ? 1 : 0), 0);
      ctx.textAlign = 'left';
      ctx.font = '700 14px system-ui, sans-serif';
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(6,10,22,0.6)';
      ctx.fillStyle = 'rgba(235,242,255,0.92)';
      const hud = `空位 ${emptyCount}`;
      ctx.strokeText(hud, 12, 24);
      ctx.fillText(hud, 12, 24);

      if (turnRef.current === 'ai' && winnerRef.current === 0) {
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(190,170,255,0.95)';
        const txt = '电脑思考中…';
        ctx.strokeText(txt, RW - 12, 24);
        ctx.fillText(txt, RW - 12, 24);
        // 三点呼吸提示
        for (let i = 0; i < 3; i++) {
          const a = 0.25 + 0.6 * Math.abs(Math.sin(t * 3 - i * 0.5));
          ctx.fillStyle = `rgba(190,170,255,${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(RW - 128 - i * 9, 46, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emptyCount = board.reduce((n, v) => n + (v === 0 ? 1 : 0), 0);

  return (
    <GameShell
      meta={metaQubic3D}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>当前连胜</span>
            <strong>{streak}</strong>
          </div>
          <div className="stat-box">
            <span>战绩</span>
            <strong>
              {wins} 胜 {losses} 负
            </strong>
          </div>
          <div className="stat-box">
            <span>{LEVELS[level].name}档最佳连胜</span>
            <strong>{best.value ?? '—'}</strong>
          </div>
          <button className="btn btn-primary" onClick={reset}>
            🔄 新一局
          </button>
        </>
      }
    >
      <div className="qb3d">
        <div className={`qb3d-status ${turn === 'ai' && winner === 0 ? 'thinking' : ''}`}>
          {winner === 0 && (turn === 'ai' ? `🤖 电脑思考中…（上一步 ${thinkMs}ms）` : '🟦 轮到你落子')}
          {winner === 1 && '🎉 你赢了！'}
          {winner === 2 && '💀 电脑连成了四子'}
          {winner === 3 && '🤝 满盘和棋'}
        </div>
        <div className="qb3d-stage">
          <canvas
            ref={canvasRef}
            className="qb3d-canvas"
            role="img"
            aria-label="3D 立体井字棋盘"
            onContextMenu={(e) => e.preventDefault()}
          />
          {winner !== 0 && (
            <div className="qb3d-overlay">
              <h2>{winner === 1 ? '🎉 你赢了！' : winner === 2 ? '💀 电脑获胜' : '🤝 和棋'}</h2>
              <p>
                {winner === 1 && <>四子连成一线 · 当前 {streak} 连胜{newRecord ? ' · 🏆 新纪录！' : ''}</>}
                {winner === 2 && `电脑 ${LEVELS[level].name}档 · 再想想哪里漏看了直线`}
                {winner === 3 && `盘面填满也没人连成四子 · 剩 ${emptyCount} 格空位`}
              </p>
              <button className="btn btn-primary" onClick={reset}>
                再来一局
              </button>
            </div>
          )}
        </div>
        <div className="qb3d-actions">
          <button className={`btn ${level === 0 ? 'btn-primary' : 'btn-ghost'}`} onClick={() => changeLevel(0)}>
            简单
          </button>
          <button className={`btn ${level === 1 ? 'btn-primary' : 'btn-ghost'}`} onClick={() => changeLevel(1)}>
            困难
          </button>
          <button className="btn btn-ghost" onClick={() => setHintOn((v) => !v)}>
            {hintOn ? '💡 关闭威胁提示' : '💡 威胁提示'}
          </button>
          <button className="btn btn-ghost" onClick={() => (camRef.current = defaultCam())}>
            ⟲ 复位视角
          </button>
        </div>
        <p className="hint">
          拖拽旋转视角 · 滚轮/双指缩放 · 点击空格落子 · 方向键也能转视角，H 开威胁提示 · <span className="qb3d-you">青色是你</span>，
          <span className="qb3d-ai">红色是电脑</span> · 任意方向四子连珠即胜
        </p>
      </div>
    </GameShell>
  );
}