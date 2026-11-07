import { useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaMatch3 } from '../core/gameMetas';
import {
  CELLS,
  MOVES_PER_LEVEL,
  SIZE,
  areAdjacent,
  colOf,
  createEngine,
  ensureMove,
  findValidMove,
  hasReachedTarget,
  idx,
  rowOf,
  targetForLevel,
  trySwap,
} from './match3Core';
import type { EngineState, Gem, Step } from './match3Core';

const RW = 480;
const RH = 480;
const PAD = 16;
const CELL = (RW - PAD * 2) / SIZE;

const COLORS = ['#ff5a6e', '#ffa940', '#ffd93d', '#4ade80', '#60a5fa', '#c084fc'];
const SPECIAL_NAMES = { row: '火箭！', col: '火箭！', bomb: '炸弹！', star: '星钻！' } as const;

type Status = 'ready' | 'playing' | 'clear' | 'over';
type Phase = 'idle' | 'deal' | 'swap' | 'swapBack' | 'clear' | 'fall' | 'shuffle';

interface Anim {
  phase: Phase;
  t0: number;
  dur: number;
  step: Step | null;
  queue: Step[];
  a: number;
  b: number;
  valid: boolean;
}

/** 视觉宝石：从 (x0,y0) 补间到 (x1,y1)，缩放/透明度同步补间 */
interface VG {
  gem: Gem;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t0: number;
  dur: number;
  ease: 'in' | 'out';
  s0: number;
  s1: number;
  a0: number;
  a1: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t0: number;
  life: number;
  color: string;
  size: number;
}

interface Popup {
  x: number;
  y: number;
  text: string;
  sub: string | null;
  t0: number;
  color: string;
}

const cellX = (i: number) => PAD + colOf(i) * CELL + CELL / 2;
const cellY = (i: number) => PAD + rowOf(i) * CELL + CELL / 2;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function vgPos(v: VG, now: number): { x: number; y: number; s: number; a: number } {
  const p = v.dur <= 0 ? 1 : clamp01((now - v.t0) / v.dur);
  const e = v.ease === 'in' ? p * p : 1 - (1 - p) * (1 - p);
  return {
    x: v.x0 + (v.x1 - v.x0) * e,
    y: v.y0 + (v.y1 - v.y0) * e,
    s: v.s0 + (v.s1 - v.s0) * e,
    a: v.a0 + (v.a1 - v.a0) * e,
  };
}

function retarget(v: VG, x: number, y: number, now: number, dur: number, ease: 'in' | 'out') {
  const p = vgPos(v, now);
  v.x0 = p.x;
  v.y0 = p.y;
  v.x1 = x;
  v.y1 = y;
  v.t0 = now;
  v.dur = dur;
  v.ease = ease;
  v.s0 = p.s;
  v.s1 = 1;
  v.a0 = p.a;
  v.a1 = 1;
}

function makeVG(gem: Gem, x: number, y: number, now: number): VG {
  return { gem, x0: x, y0: y, x1: x, y1: y, t0: now, dur: 0, ease: 'out', s0: 1, s1: 1, a0: 1, a1: 1 };
}

export default function Match3() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<Status>('ready');
  const [score, setScore] = useState(0);
  const [level, setLevel] = useState(1);
  const [moves, setMoves] = useState(MOVES_PER_LEVEL);
  const best = useBestScore(metaMatch3.id);
  const { toast } = useToast();

  const statusRef = useRef<Status>('ready');
  const scoreRef = useRef(0);
  /** 进入本关时的累计分：目标按"本关增量"判定，避免上一关溢出分直接抬过下一关 */
  const levelStartRef = useRef(0);
  const levelRef = useRef(1);
  const movesRef = useRef(MOVES_PER_LEVEL);
  const bestRef = useRef(best);
  bestRef.current = best;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const engineRef = useRef<EngineState | null>(null);
  const cellsRef = useRef<(Gem | null)[]>(Array(CELLS).fill(null));
  const visRef = useRef<Map<number, VG>>(new Map());
  const animRef = useRef<Anim>({ phase: 'idle', t0: 0, dur: 0, step: null, queue: [], a: -1, b: -1, valid: false });
  const particlesRef = useRef<Particle[]>([]);
  const popupsRef = useRef<Popup[]>([]);
  const inputRef = useRef<{ id: number; x: number; y: number; cell: number; dragged: boolean } | null>(null);
  const selectedRef = useRef<number | null>(null);
  const cursorRef = useRef({ cell: idx(3, 3), visible: false });
  const hintRef = useRef<[number, number] | null>(null);
  const hintUntilRef = useRef(0);
  const lastActionRef = useRef(0);
  const controlsRef = useRef<{ start: () => void; next: () => void; restart: () => void } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(RW * dpr);
    canvas.height = Math.round(RH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const setGame = (patch: Partial<{ status: Status; score: number; level: number; moves: number }>) => {
      if (patch.status !== undefined) {
        statusRef.current = patch.status;
        setStatus(patch.status);
      }
      if (patch.score !== undefined) {
        scoreRef.current = patch.score;
        setScore(patch.score);
      }
      if (patch.level !== undefined) {
        levelRef.current = patch.level;
        setLevel(patch.level);
      }
      if (patch.moves !== undefined) {
        movesRef.current = patch.moves;
        setMoves(patch.moves);
      }
    };

    const settle = () => {
      if (scoreRef.current <= 0) return;
      const isNew = bestRef.current.updateBest(scoreRef.current, (a, b) => a > b);
      if (isNew) {
        sfx.record();
        toastRef.current(`新纪录！最高分 ${scoreRef.current}`, 'record');
      }
    };

    const spawnParticles = (x: number, y: number, color: string, now: number) => {
      const list = particlesRef.current;
      for (let k = 0; k < 8; k++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 60 + Math.random() * 160;
        list.push({
          x,
          y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp - 60,
          t0: now,
          life: 380 + Math.random() * 220,
          color,
          size: 2.5 + Math.random() * 3,
        });
      }
      if (list.length > 320) list.splice(0, list.length - 320);
    };

    /** 把 vis 同步到 cells：存在的补间回格位，新出现的直接落位，消失的移除 */
    const syncVis = (now: number) => {
      const vis = visRef.current;
      const alive = new Set<number>();
      cellsRef.current.forEach((g, i) => {
        if (!g) return;
        alive.add(g.id);
        const v = vis.get(g.id);
        if (v) {
          v.gem = g;
          retarget(v, cellX(i), cellY(i), now, 0, 'out');
        } else {
          vis.set(g.id, makeVG(g, cellX(i), cellY(i), now));
        }
      });
      for (const id of vis.keys()) if (!alive.has(id)) vis.delete(id);
    };

    const beginClear = (step: Step, queue: Step[], now: number) => {
      cellsRef.current = step.beforeClear;
      syncVis(now);
      let cx = 0;
      let cy = 0;
      for (const i of step.cleared) {
        const g = step.beforeClear[i];
        if (!g) continue;
        const v = visRef.current.get(g.id);
        if (v) {
          const p = vgPos(v, now);
          v.s0 = p.s;
          v.s1 = 0;
          v.a0 = p.a;
          v.a1 = 0;
          v.t0 = now;
          v.dur = 220;
          v.ease = 'out';
          spawnParticles(p.x, p.y, g.special === 'star' ? '#ffffff' : COLORS[g.type], now);
        }
        cx += cellX(i);
        cy += cellY(i);
      }
      if (step.cleared.length > 0) {
        popupsRef.current.push({
          x: cx / step.cleared.length,
          y: cy / step.cleared.length,
          text: `+${step.score}`,
          sub: step.cascade > 1 ? `连锁 ×${step.cascade}` : null,
          t0: now,
          color: step.cascade > 1 ? '#ffd93d' : '#ffffff',
        });
      }
      for (const t of step.transform) {
        popupsRef.current.push({ x: cellX(t.index), y: cellY(t.index) - CELL * 0.5, text: SPECIAL_NAMES[t.special as keyof typeof SPECIAL_NAMES], sub: null, t0: now, color: '#7dd3fc' });
      }
      if (step.cascade === 1) sfx.merge();
      else sfx.clear();
      animRef.current = { phase: 'clear', t0: now, dur: 250, step, queue, a: -1, b: -1, valid: true };
    };

    const setupFall = (step: Step, now: number) => {
      const oldVis = visRef.current;
      cellsRef.current = step.afterGravity;
      const newVis = new Map<number, VG>();
      // 每列新宝石数量决定它们从屏幕外多高处落下
      const newCountPerCol = Array(SIZE).fill(0);
      step.afterGravity.forEach((g, i) => {
        if (g && !oldVis.has(g.id)) newCountPerCol[colOf(i)]++;
      });
      let maxDur = 0;
      step.afterGravity.forEach((g, i) => {
        if (!g) return;
        const tx = cellX(i);
        const ty = cellY(i);
        const old = oldVis.get(g.id);
        let v: VG;
        if (old) {
          v = old;
          v.gem = g;
          const fallCells = Math.abs(ty - vgPos(old, now).y) / CELL;
          retarget(v, tx, ty, now, Math.min(460, 130 + fallCells * 60), 'in');
        } else {
          const startRow = rowOf(i) - newCountPerCol[colOf(i)];
          v = makeVG(g, tx, PAD + startRow * CELL + CELL / 2, now);
          const fallCells = rowOf(i) - startRow;
          v.y1 = ty;
          v.dur = Math.min(460, 130 + fallCells * 60);
          v.ease = 'in';
        }
        maxDur = Math.max(maxDur, v.dur);
        newVis.set(g.id, v);
      });
      visRef.current = newVis;
      animRef.current = { phase: 'fall', t0: now, dur: maxDur + 30, step, queue: animRef.current.queue, a: -1, b: -1, valid: true };
    };

    const finishTurn = (now: number) => {
      const engine = engineRef.current!;
      cellsRef.current = engine.board.map((g) => (g ? { ...g } : null));
      if (hasReachedTarget(scoreRef.current, levelStartRef.current, levelRef.current)) {
        syncVis(now);
        animRef.current = { ...animRef.current, phase: 'idle' };
        setGame({ status: 'clear' });
        sfx.win();
        settle();
        return;
      }
      if (movesRef.current <= 0) {
        syncVis(now);
        animRef.current = { ...animRef.current, phase: 'idle' };
        setGame({ status: 'over' });
        sfx.lose();
        settle();
        return;
      }
      const reshuffled = ensureMove(engine);
      if (reshuffled) {
        cellsRef.current = engine.board.map((g) => (g ? { ...g } : null));
        const vis = visRef.current;
        const alive = new Set<number>();
        cellsRef.current.forEach((g, i) => {
          if (!g) return;
          alive.add(g.id);
          const v = vis.get(g.id);
          if (v) {
            v.gem = g;
            retarget(v, cellX(i), cellY(i), now, 380, 'out');
          } else {
            const nv = makeVG(g, cellX(i), cellY(i), now);
            nv.s0 = 0;
            nv.s1 = 1;
            nv.dur = 200;
            vis.set(g.id, nv);
          }
        });
        for (const id of vis.keys()) if (!alive.has(id)) vis.delete(id);
        toastRef.current('没有可消除的组合，重新洗牌', 'info');
        animRef.current = { ...animRef.current, phase: 'shuffle', t0: now, dur: 400 };
      } else {
        syncVis(now);
        animRef.current = { ...animRef.current, phase: 'idle' };
      }
      hintRef.current = findValidMove(engine);
      lastActionRef.current = now;
    };

    const deal = (now: number) => {
      const engine = engineRef.current!;
      cellsRef.current = engine.board.map((g) => (g ? { ...g } : null));
      const vis = new Map<number, VG>();
      cellsRef.current.forEach((g, i) => {
        if (!g) return;
        const ty = cellY(i);
        const v = makeVG(g, cellX(i), ty - RH - CELL * 2, now + rowOf(i) * 28);
        v.y1 = ty;
        v.dur = 420;
        v.ease = 'in';
        vis.set(g.id, v);
      });
      visRef.current = vis;
      hintRef.current = findValidMove(engine);
      lastActionRef.current = now;
      animRef.current = { phase: 'deal', t0: now, dur: 420 + 7 * 28 + 40, step: null, queue: [], a: -1, b: -1, valid: true };
    };

    const startRun = (now: number) => {
      engineRef.current = createEngine();
      selectedRef.current = null;
      popupsRef.current = [];
      particlesRef.current = [];
      levelStartRef.current = 0;
      setGame({ score: 0, level: 1, moves: MOVES_PER_LEVEL, status: 'playing' });
      deal(now);
    };

    const nextLevel = (now: number) => {
      engineRef.current = createEngine();
      selectedRef.current = null;
      popupsRef.current = [];
      // 分数继续携带，但下一关目标从当前总分重新起算
      levelStartRef.current = scoreRef.current;
      setGame({ level: levelRef.current + 1, moves: MOVES_PER_LEVEL, status: 'playing' });
      deal(now);
    };

    controlsRef.current = {
      start: () => startRun(performance.now()),
      next: () => nextLevel(performance.now()),
      restart: () => startRun(performance.now()),
    };

    const attemptSwap = (a: number, b: number) => {
      const engine = engineRef.current;
      const anim = animRef.current;
      if (!engine || anim.phase !== 'idle' || statusRef.current !== 'playing') return;
      if (!areAdjacent(a, b)) return;
      const ga = engine.board[a];
      const gb = engine.board[b];
      if (!ga || !gb) return;
      const now = performance.now();
      const starSwap = ga.special === 'star' || gb.special === 'star';
      const steps = trySwap(engine, a, b);
      selectedRef.current = null;
      hintUntilRef.current = 0;
      lastActionRef.current = now;
      sfx.move();
      if (!starSwap) {
        const va = visRef.current.get(ga.id);
        const vb = visRef.current.get(gb.id);
        if (va) retarget(va, cellX(b), cellY(b), now, 150, 'out');
        if (vb) retarget(vb, cellX(a), cellY(a), now, 150, 'out');
        const swapped = [...cellsRef.current];
        swapped[a] = gb;
        swapped[b] = ga;
        cellsRef.current = swapped;
      }
      animRef.current = {
        phase: 'swap',
        t0: now,
        dur: starSwap ? 100 : 160,
        step: steps ? steps[0] : null,
        queue: steps ? steps.slice(1) : [],
        a,
        b,
        valid: steps !== null,
      };
    };

    const advancePhase = (now: number) => {
      const anim = animRef.current;
      switch (anim.phase) {
        case 'swap': {
          if (!anim.valid || !anim.step) {
            // 无效交换：弹回。此时 cellsRef[a] 是原来 b 格的宝石，要回 b 格
            const gemAtA = cellsRef.current[anim.a];
            const gemAtB = cellsRef.current[anim.b];
            const va = gemAtA && visRef.current.get(gemAtA.id);
            const vb = gemAtB && visRef.current.get(gemAtB.id);
            if (va) retarget(va, cellX(anim.b), cellY(anim.b), now, 150, 'out');
            if (vb) retarget(vb, cellX(anim.a), cellY(anim.a), now, 150, 'out');
            const swapped = [...cellsRef.current];
            swapped[anim.a] = gemAtB;
            swapped[anim.b] = gemAtA;
            cellsRef.current = swapped;
            sfx.mismatch();
            animRef.current = { ...anim, phase: 'swapBack', t0: now, dur: 160 };
          } else {
            setGame({ moves: movesRef.current - 1 });
            beginClear(anim.step, anim.queue, now);
          }
          break;
        }
        case 'swapBack':
          animRef.current = { ...anim, phase: 'idle' };
          lastActionRef.current = now;
          break;
        case 'clear': {
          const step = anim.step!;
          setGame({ score: scoreRef.current + step.score });
          for (const t of step.transform) {
            const g = cellsRef.current[t.index];
            if (g) g.special = t.special;
          }
          setupFall(step, now);
          break;
        }
        case 'fall': {
          sfx.drop();
          if (anim.queue.length > 0) {
            beginClear(anim.queue[0], anim.queue.slice(1), now);
          } else {
            finishTurn(now);
          }
          break;
        }
        case 'shuffle':
          animRef.current = { ...anim, phase: 'idle' };
          break;
        case 'deal':
          sfx.drop();
          animRef.current = { ...anim, phase: 'idle' };
          break;
      }
    };

    // ============ 渲染 ============

    const gemPath = (type: number, x: number, y: number, r: number) => {
      ctx.beginPath();
      if (type === 0) {
        ctx.arc(x, y, r, 0, Math.PI * 2);
      } else if (type === 1) {
        ctx.roundRect(x - r, y - r, r * 2, r * 2, r * 0.35);
      } else {
        const sides = type === 2 ? 3 : type === 3 ? 4 : type === 4 ? 5 : 6;
        const rot = type === 2 ? -Math.PI / 2 : type === 3 ? 0 : -Math.PI / 2;
        for (let k = 0; k < sides; k++) {
          const ang = rot + (k * Math.PI * 2) / sides;
          const px = x + Math.cos(ang) * r;
          const py = y + Math.sin(ang) * r;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
    };

    const drawGem = (g: Gem, x: number, y: number, scale: number, alpha: number, now: number) => {
      if (scale <= 0.01 || alpha <= 0.01) return;
      let r = CELL * 0.36 * scale;
      if (g.special === 'star') r *= 1 + 0.06 * Math.sin(now / 180);
      ctx.save();
      ctx.globalAlpha = alpha;
      if (g.special === 'star') {
        const grad = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
        COLORS.forEach((c, k) => grad.addColorStop(k / (COLORS.length - 1), c));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 2;
        ctx.stroke();
        // 白色四角星
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        for (let k = 0; k < 8; k++) {
          const ang = (k * Math.PI) / 4 - Math.PI / 2;
          const rr = k % 2 === 0 ? r * 0.62 : r * 0.2;
          const px = x + Math.cos(ang) * rr;
          const py = y + Math.sin(ang) * rr;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        const base = COLORS[g.type];
        const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r * 1.15);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.25, base);
        grad.addColorStop(1, base);
        gemPath(g.type, x, y, r);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.28)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // 高光
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.ellipse(x - r * 0.3, y - r * 0.38, r * 0.32, r * 0.18, -0.6, 0, Math.PI * 2);
        ctx.fill();
        if (g.special === 'row' || g.special === 'col') {
          ctx.strokeStyle = 'rgba(255,255,255,0.95)';
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          const horiz = g.special === 'row';
          const len = r * 0.62;
          const head = r * 0.22;
          ctx.beginPath();
          if (horiz) {
            ctx.moveTo(x - len, y);
            ctx.lineTo(x + len, y);
            ctx.moveTo(x - len + head, y - head);
            ctx.lineTo(x - len, y);
            ctx.lineTo(x - len + head, y + head);
            ctx.moveTo(x + len - head, y - head);
            ctx.lineTo(x + len, y);
            ctx.lineTo(x + len - head, y + head);
          } else {
            ctx.moveTo(x, y - len);
            ctx.lineTo(x, y + len);
            ctx.moveTo(x - head, y - len + head);
            ctx.lineTo(x, y - len);
            ctx.lineTo(x + head, y - len + head);
            ctx.moveTo(x - head, y + len - head);
            ctx.lineTo(x, y + len);
            ctx.lineTo(x + head, y + len - head);
          }
          ctx.stroke();
        } else if (g.special === 'bomb') {
          ctx.fillStyle = '#1f2937';
          ctx.beginPath();
          ctx.arc(x, y, r * 0.58, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.7)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          const pulse = 0.5 + 0.5 * Math.sin(now / 150);
          ctx.fillStyle = `rgba(255,${Math.round(120 + 100 * pulse)},60,${0.6 + 0.4 * pulse})`;
          ctx.beginPath();
          ctx.arc(x, y, r * (0.16 + 0.06 * pulse), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    };

    const ringCell = (i: number, color: string, alpha: number, now: number, dashed: boolean) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      if (dashed) {
        ctx.setLineDash([7, 5]);
        ctx.lineDashOffset = -now / 60;
      }
      ctx.beginPath();
      ctx.roundRect(PAD + colOf(i) * CELL + 2.5, PAD + rowOf(i) * CELL + 2.5, CELL - 5, CELL - 5, 9);
      ctx.stroke();
      ctx.restore();
    };

    const draw = (now: number, dt: number) => {
      ctx.clearRect(0, 0, RW, RH);
      // 棋盘格
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          ctx.fillStyle = (r + c) % 2 === 0 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.02)';
          ctx.beginPath();
          ctx.roundRect(PAD + c * CELL + 1, PAD + r * CELL + 1, CELL - 2, CELL - 2, 7);
          ctx.fill();
        }
      }
      const playing = statusRef.current === 'playing';
      const idle = animRef.current.phase === 'idle';
      // 提示（闲置 6 秒或按 H）
      if (playing && idle && hintRef.current) {
        const show = now - lastActionRef.current > 6000 || now < hintUntilRef.current;
        if (show) {
          const pulse = 0.45 + 0.35 * Math.sin(now / 220);
          ringCell(hintRef.current[0], '#ffd93d', pulse, now, false);
          ringCell(hintRef.current[1], '#ffd93d', pulse, now, false);
        }
      }
      if (playing && selectedRef.current !== null) {
        ringCell(selectedRef.current, '#ffffff', 0.9, now, false);
      }
      if (playing && cursorRef.current.visible) {
        ringCell(cursorRef.current.cell, '#7dd3fc', 0.85, now, true);
      }
      // 宝石（裁剪到棋盘内，补给宝石从顶部进入）
      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD, PAD, RW - PAD * 2, RH - PAD * 2);
      ctx.clip();
      for (const v of visRef.current.values()) {
        const p = vgPos(v, now);
        drawGem(v.gem, p.x, p.y, p.s, p.a, now);
      }
      ctx.restore();
      // 粒子
      const ps = particlesRef.current;
      for (let k = ps.length - 1; k >= 0; k--) {
        const p = ps[k];
        const t = (now - p.t0) / p.life;
        if (t >= 1) {
          ps.splice(k, 1);
          continue;
        }
        p.vy += 900 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1;
      // 分数浮字
      const pops = popupsRef.current;
      for (let k = pops.length - 1; k >= 0; k--) {
        const p = pops[k];
        const t = (now - p.t0) / 900;
        if (t >= 1) {
          pops.splice(k, 1);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
        ctx.textAlign = 'center';
        ctx.font = 'bold 22px system-ui, sans-serif';
        ctx.fillStyle = p.color;
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 6;
        ctx.fillText(p.text, p.x, p.y - t * 36);
        if (p.sub) {
          ctx.font = 'bold 14px system-ui, sans-serif';
          ctx.fillStyle = '#ffd93d';
          ctx.fillText(p.sub, p.x, p.y - t * 36 + 18);
        }
        ctx.restore();
      }
    };

    // ============ 输入 ============

    const toLogical = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * RW,
        y: ((e.clientY - rect.top) / rect.height) * RH,
      };
    };
    const cellAt = (x: number, y: number) => {
      const c = Math.floor((x - PAD) / CELL);
      const r = Math.floor((y - PAD) / CELL);
      return r >= 0 && r < SIZE && c >= 0 && c < SIZE ? idx(r, c) : -1;
    };

    const clickCell = (cell: number) => {
      const sel = selectedRef.current;
      if (sel === null) {
        selectedRef.current = cell;
        sfx.click();
      } else if (sel === cell) {
        selectedRef.current = null;
      } else if (areAdjacent(sel, cell)) {
        attemptSwap(sel, cell);
      } else {
        selectedRef.current = cell;
        sfx.click();
      }
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (statusRef.current !== 'playing' || animRef.current.phase !== 'idle') return;
      const p = toLogical(e);
      const cell = cellAt(p.x, p.y);
      if (cell < 0) {
        selectedRef.current = null;
        return;
      }
      inputRef.current = { id: e.pointerId, x: p.x, y: p.y, cell, dragged: false };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // 合成事件或指针已释放时捕获会失败，不影响拖拽判定
      }
      cursorRef.current.visible = false;
      lastActionRef.current = performance.now();
      hintUntilRef.current = 0;
    };

    const onMove = (e: PointerEvent) => {
      const input = inputRef.current;
      if (!input || e.pointerId !== input.id || input.dragged) return;
      const p = toLogical(e);
      const dx = p.x - input.x;
      const dy = p.y - input.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < CELL * 0.35) return;
      input.dragged = true;
      const r = rowOf(input.cell);
      const c = colOf(input.cell);
      let nr = r;
      let nc = c;
      if (Math.abs(dx) > Math.abs(dy)) nc += dx > 0 ? 1 : -1;
      else nr += dy > 0 ? 1 : -1;
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) {
        selectedRef.current = null;
        attemptSwap(input.cell, idx(nr, nc));
      }
    };

    const onUp = (e: PointerEvent) => {
      const input = inputRef.current;
      if (!input || e.pointerId !== input.id) return;
      inputRef.current = null;
      if (!input.dragged && statusRef.current === 'playing' && animRef.current.phase === 'idle') {
        clickCell(input.cell);
      }
    };

    const onCancel = (e: PointerEvent) => {
      if (inputRef.current?.id === e.pointerId) inputRef.current = null;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key;
      // Enter/空格在按钮/链接焦点下交给原生点击，避免"返回大厅"被当成开始游戏
      const target = e.target as Element | null;
      if ((key === 'Enter' || key === ' ') && target?.closest?.('button,a,input,textarea,select')) return;
      const st = statusRef.current;
      if (st === 'ready' && (key === 'Enter' || key === ' ')) {
        e.preventDefault();
        startRun(performance.now());
        return;
      }
      if (st === 'clear' && (key === 'Enter' || key === 'n' || key === 'N')) {
        e.preventDefault();
        nextLevel(performance.now());
        return;
      }
      if (st === 'over' && (key === 'Enter' || key === 'r' || key === 'R')) {
        e.preventDefault();
        startRun(performance.now());
        return;
      }
      if (key === 'r' || key === 'R') {
        e.preventDefault();
        startRun(performance.now());
        return;
      }
      if (st !== 'playing') return;
      const dirs: Record<string, [number, number]> = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      };
      const dir = dirs[key];
      if (dir) {
        e.preventDefault();
        const cursor = cursorRef.current;
        cursor.visible = true;
        lastActionRef.current = performance.now();
        hintUntilRef.current = 0;
        const sel = selectedRef.current;
        if (sel !== null && animRef.current.phase === 'idle') {
          const nr = rowOf(sel) + dir[0];
          const nc = colOf(sel) + dir[1];
          selectedRef.current = null;
          if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) {
            cursor.cell = idx(nr, nc);
            attemptSwap(sel, cursor.cell);
          }
        } else if (sel === null) {
          const nr = Math.max(0, Math.min(SIZE - 1, rowOf(cursor.cell) + dir[0]));
          const nc = Math.max(0, Math.min(SIZE - 1, colOf(cursor.cell) + dir[1]));
          cursor.cell = idx(nr, nc);
        }
        return;
      }
      if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        if (animRef.current.phase !== 'idle') return;
        cursorRef.current.visible = true;
        lastActionRef.current = performance.now();
        clickCell(cursorRef.current.cell);
        return;
      }
      if (key === 'Escape') {
        selectedRef.current = null;
        return;
      }
      if (key === 'h' || key === 'H') {
        const engine = engineRef.current;
        if (engine && animRef.current.phase === 'idle') {
          hintRef.current = findValidMove(engine);
          hintUntilRef.current = performance.now() + 2500;
        }
      }
    };

    const onIdleInput = () => {
      inputRef.current = null;
      selectedRef.current = null;
      cursorRef.current.visible = false;
    };
    const onVis = () => {
      if (document.hidden) onIdleInput();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onIdleInput);
    document.addEventListener('visibilitychange', onVis);

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      const anim = animRef.current;
      if (anim.phase !== 'idle' && now - anim.t0 >= anim.dur) advancePhase(now);
      draw(now, dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onIdleInput);
      document.removeEventListener('visibilitychange', onVis);
      controlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const target = targetForLevel(level);
  const levelScore = Math.max(0, score - levelStartRef.current);
  const progress = Math.min(100, (levelScore / target) * 100);

  return (
    <GameShell
      meta={metaMatch3}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>关卡</span>
            <strong>{level}</strong>
          </div>
          <div className="stat-box">
            <span>本关分数 / 目标</span>
            <strong>
              {levelScore}
              <small className="m3-target"> / {target}</small>
            </strong>
          </div>
          <div className="stat-box">
            <span>步数</span>
            <strong className={moves <= 5 && status === 'playing' ? 'm3-low' : ''}>{moves}</strong>
          </div>
          <div className="stat-box">
            <span>{metaMatch3.bestScoreLabel}</span>
            <strong>{best.value ?? '—'}</strong>
          </div>
          <button className="btn btn-primary" onClick={() => controlsRef.current?.restart()}>
            重新开始
          </button>
        </>
      }
    >
      <div className="m3">
        <div className="m3-stage">
          <div className="m3-progress" aria-hidden>
            <div style={{ width: `${progress}%` }} />
          </div>
          <canvas
            ref={canvasRef}
            className="m3-canvas"
            aria-label="宝石三消棋盘：拖动或点选两颗相邻宝石交换"
          />
          {status === 'ready' && (
            <div className="m3-overlay">
              <h2>💎 宝石三消</h2>
              <p className="m3-rules">
                交换相邻宝石，三连即消除；步数内达到目标分就过关。
                <br />
                4 连 → 火箭（清整行/列）；L/T 形 → 炸弹（3×3）；5 连 → 星钻（与任意宝石交换消同色）。
                <br />
                连锁越深倍率越高，善用特殊宝石冲高分！
              </p>
              <button className="btn btn-primary" onClick={() => controlsRef.current?.start()}>
                开始游戏
              </button>
            </div>
          )}
          {status === 'clear' && (
            <div className="m3-overlay">
              <h2>🎉 第 {level} 关完成！</h2>
              <p>
                本关得分 {levelScore} · 当前总分 {score} · 下一关目标 {targetForLevel(level + 1)}
              </p>
              <button className="btn btn-primary" onClick={() => controlsRef.current?.next()}>
                下一关（Enter）
              </button>
            </div>
          )}
          {status === 'over' && (
            <div className="m3-overlay">
              <h2>💀 步数用完</h2>
              <p>
                总分 {score} · 本关 {levelScore} / {target}
                <br />
                最高纪录 {best.value ?? score}
              </p>
              <button className="btn btn-primary" onClick={() => controlsRef.current?.restart()}>
                重新开始（Enter）
              </button>
            </div>
          )}
        </div>
        <p className="hint">操作：拖动宝石，或点选两颗相邻宝石交换；连锁消除不耗步数</p>
        <p className="hint">键盘：方向键移动光标，空格选中后按方向键交换，H 提示，R 重开</p>
      </div>
    </GameShell>
  );
}