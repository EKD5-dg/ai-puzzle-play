/**
 * 3D 立体井字的棋盘规则与 AI 搜索。
 * 单独成模块是为了能整体放进 Web Worker：困难档一次搜索要跑两万多个节点，
 * 在主线程上同步执行会让渲染循环停摆、触摸与点击被延迟。
 */

// ============ 棋盘常量 ============

/** 4×4×4：64 格、76 条直线，是"自由落子"版 3D 井字最经典也最好读的尺寸 */
export const N = 4;
export const CELLS = N * N * N;
export const HUMAN = 1;
export const AI = 2;

export const idxOf = (x: number, y: number, z: number) => (z * N + y) * N + x;
export const ax = (i: number) => i % N;
export const ay = (i: number) => Math.floor(i / N) % N;
export const az = (i: number) => Math.floor(i / (N * N));
export const emptyBoard = (): number[] => new Array(CELLS).fill(0);
export const oppOf = (p: number) => (p === HUMAN ? AI : HUMAN);

/**
 * 全部 76 条"四子直线"。方向取 [-1,0,1]³ 中首个非零分量为正的 13 个，
 * 起点为该方向上"再退一步就出界"的格子——只登记一次，且必须整条线都在盘内。
 */
export const LINES: number[][] = (() => {
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
export const LINES_THROUGH: number[][] = (() => {
  const t: number[][] = Array.from({ length: CELLS }, () => []);
  LINES.forEach((line, li) => line.forEach((c) => t[c].push(li)));
  return t;
})();

// ============ 规则 ============

/** 落在 i 的这一手是否连成一线，命中则返回该线 */
export function winLineAt(board: number[], i: number): number[] | null {
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
export function winningSquares(board: number[], p: number): number[] {
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
export function enclosedCell(board: number[], i: number): boolean {
  const x = ax(i);
  const y = ay(i);
  const z = az(i);
  if (x === 0 || x === N - 1 || y === 0 || y === N - 1 || z === 0 || z === N - 1) return false;
  return !!board[idxOf(x + 1, y, z)] && !!board[idxOf(x - 1, y, z)] && !!board[idxOf(x, y + 1, z)] && !!board[idxOf(x, y - 1, z)] && !!board[idxOf(x, y, z + 1)] && !!board[idxOf(x, y, z - 1)];
}

// ============ AI：带 alpha-beta 与节点预算的 negamax ============

export const WIN_SCORE = 1_000_000;
/** 自身某条线上 n 子对应的价值（4 子 = 该线全满 = 直接赢，用 WIN_SCORE 量级兜住，
 *  否则 LINE_W[4] 越界成 undefined，排序键变 NaN 会把必胜手挤出候选） */
const LINE_W = [0, 1, 14, 240, 100000];
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
    if (st.mine >= 4) return WIN_SCORE; // 已成四子 = 赢，主导整个估值
    const w = OPEN_W[st.open] ?? 1;
    if (st.mine) s += LINE_W[st.mine] * w;
    if (st.theirs) s -= LINE_W[st.theirs] * w * 1.08; // 堵住对方的危险线略优先于自己铺活线
  }
  return s;
}

/** 走 m 之后的静态估值（只算经过 m 的几条线，用于排序，是搜索里的热点路径） */
function moveScore(board: number[], m: number, p: number): number {
  const opp = p === 1 ? 2 : 1;
  // 进攻：自己落子的收益
  board[m] = p;
  let s = 0;
  for (const li of LINES_THROUGH[m]) {
    const st = lineStat(board, LINES[li], p);
    if (st.mine && st.theirs) continue;
    // 成四手必须排在候选最前（下一步 winLineAt 才会把它认成胜），
    // 不能让它落到 slice 之外
    if (st.mine >= 4) { board[m] = 0; return WIN_SCORE; }
    const w = OPEN_W[st.open] ?? 1;
    if (st.mine) s += LINE_W[st.mine] * w;
    if (st.theirs) s -= LINE_W[st.theirs] * w * 1.08;
  }
  board[m] = 0;
  // 防守：对手若在此落子的威胁值。挡子本身常常"一条线都不成"（评 0 分），
  // 不计入就会被 sort+slice 裁掉，搜索看不到必要的防守手（如提前挡对方的三连）
  board[m] = opp;
  for (const li of LINES_THROUGH[m]) {
    const st = lineStat(board, LINES[li], opp);
    if (st.mine && st.theirs) continue;
    if (st.mine >= 4) { board[m] = 0; return WIN_SCORE; } // 对手在此成四 = 不挡就输
    const w = OPEN_W[st.open] ?? 1;
    if (st.mine) s += LINE_W[st.mine] * w * 1.15;
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

export const LEVELS = [
  { name: '简单', depth: 2, budget: 3000 },
  { name: '困难', depth: 4, budget: 22000 },
] as const;

/** 选一步：先秒解"自己能赢"与"必须堵"，再进搜索 */
export function chooseMove(board: number[], level: number): { move: number; ms: number } {
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
