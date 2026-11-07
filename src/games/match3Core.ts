/**
 * 宝石三消核心规则 —— 无 DOM，组件与 Node 测试共用同一份。
 * 8×8 棋盘、6 色宝石；4 连生成火箭（整行/列）、L/T 形生成炸弹（3×3）、5 连生成星钻（换色全消）。
 * 交换产生消除才合法；消除→重力→补给逐步连锁， cascade 越深倍率越高。
 */

export const SIZE = 8;
export const CELLS = SIZE * SIZE;
export const COLOR_COUNT = 6;

export type Special = 'none' | 'row' | 'col' | 'bomb' | 'star';

export interface Gem {
  id: number;
  type: number;
  special: Special;
}

/** null 只出现在结算中间态；对外棋盘总是满的 */
export type Board = (Gem | null)[];

export interface EngineState {
  board: Board;
  nextId: number;
  rng: () => number;
}

export interface Transform {
  index: number;
  special: Special;
}

/** 一步连锁：清除 → 变形 → 重力补给。快照供渲染层按 id 追踪下落 */
export interface Step {
  cleared: number[];
  transform: Transform[];
  beforeClear: Board;
  afterGravity: Board;
  score: number;
  cascade: number;
}

interface Run {
  cells: number[];
  dir: 'h' | 'v';
}

export interface Cluster {
  cells: number[];
  special: Special;
  spawn: number;
}

export const idx = (r: number, c: number) => r * SIZE + c;
export const rowOf = (i: number) => Math.floor(i / SIZE);
export const colOf = (i: number) => i % SIZE;

export function areAdjacent(a: number, b: number): boolean {
  return Math.abs(rowOf(a) - rowOf(b)) + Math.abs(colOf(a) - colOf(b)) === 1;
}

function matchable(g: Gem | null): g is Gem {
  return g !== null && g.special !== 'star';
}

/** 扫描所有 ≥3 的横/竖连段 */
function findRuns(board: Board): Run[] {
  const runs: Run[] = [];
  for (let r = 0; r < SIZE; r++) {
    let c = 0;
    while (c < SIZE) {
      const g = board[idx(r, c)];
      if (!matchable(g)) {
        c++;
        continue;
      }
      let end = c + 1;
      while (end < SIZE) {
        const n = board[idx(r, end)];
        if (!matchable(n) || n.type !== g.type) break;
        end++;
      }
      if (end - c >= 3) runs.push({ cells: Array.from({ length: end - c }, (_, k) => idx(r, c + k)), dir: 'h' });
      c = end;
    }
  }
  for (let c = 0; c < SIZE; c++) {
    let r = 0;
    while (r < SIZE) {
      const g = board[idx(r, c)];
      if (!matchable(g)) {
        r++;
        continue;
      }
      let end = r + 1;
      while (end < SIZE) {
        const n = board[idx(end, c)];
        if (!matchable(n) || n.type !== g.type) break;
        end++;
      }
      if (end - r >= 3) runs.push({ cells: Array.from({ length: end - r }, (_, k) => idx(r + k, c)), dir: 'v' });
      r = end;
    }
  }
  return runs;
}

/** 把共享格子的连段并成簇：L/T 形是一个簇，可能同时含横竖连段 */
export function findClusters(board: Board, prefer: number[] = []): Cluster[] {
  const runs = findRuns(board);
  if (runs.length === 0) return [];
  const parent = runs.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const byCell = new Map<number, number>();
  runs.forEach((run, i) => {
    for (const cell of run.cells) {
      const other = byCell.get(cell);
      if (other !== undefined) parent[root(i)] = root(other);
      else byCell.set(cell, i);
    }
  });
  const groups = new Map<number, Run[]>();
  runs.forEach((run, i) => {
    const r = root(i);
    const list = groups.get(r) ?? [];
    list.push(run);
    groups.set(r, list);
  });

  const clusters: Cluster[] = [];
  for (const group of groups.values()) {
    const cellSet = new Set<number>();
    let maxLen = 0;
    let hasH = false;
    let hasV = false;
    let longest: Run = group[0];
    for (const run of group) {
      run.cells.forEach((c) => cellSet.add(c));
      if (run.dir === 'h') hasH = true;
      else hasV = true;
      if (run.cells.length > maxLen) {
        maxLen = run.cells.length;
        longest = run;
      }
    }
    let special: Special = 'none';
    if (maxLen >= 5) special = 'star';
    else if (hasH && hasV) special = 'bomb';
    else if (maxLen === 4) special = longest.dir === 'h' ? 'row' : 'col';

    const cells = [...cellSet];
    // 生成位：优先玩家换进来的格子，其次横竖交叉点，再次最长连段中点；已有特殊宝石的格子不作为生成位
    let spawn = -1;
    const candidates: number[] = [];
    for (const p of prefer) if (cellSet.has(p)) candidates.push(p);
    if (hasH && hasV) {
      const hCells = new Set(group.filter((r) => r.dir === 'h').flatMap((r) => r.cells));
      for (const run of group) {
        if (run.dir === 'v') for (const c of run.cells) if (hCells.has(c)) candidates.push(c);
      }
    }
    candidates.push(longest.cells[Math.floor(longest.cells.length / 2)]);
    candidates.push(...cells);
    for (const c of candidates) {
      const g = board[c];
      if (g && g.special === 'none') {
        spawn = c;
        break;
      }
    }
    if (spawn === -1) special = 'none';
    clusters.push({ cells, special, spawn });
  }
  return clusters;
}

function randomGem(state: EngineState): Gem {
  return { id: state.nextId++, type: Math.floor(state.rng() * COLOR_COUNT), special: 'none' };
}

/** 重力压实 + 顶部补给（原地修改 board） */
function applyGravity(state: EngineState): void {
  for (let c = 0; c < SIZE; c++) {
    let write = SIZE - 1;
    for (let r = SIZE - 1; r >= 0; r--) {
      const g = boardAt(state.board, r, c);
      if (g) {
        state.board[idx(write, c)] = g;
        if (write !== r) state.board[idx(r, c)] = null;
        write--;
      }
    }
    for (let r = write; r >= 0; r--) state.board[idx(r, c)] = randomGem(state);
  }
}

function boardAt(board: Board, r: number, c: number): Gem | null {
  return board[idx(r, c)];
}

/** 特殊宝石被引爆时的波及范围；星钻被引爆消掉场上最多的一种颜色 */
function blastCells(state: EngineState, index: number, triggered: Set<number>): number[] {
  const g = state.board[index];
  if (!g || triggered.has(index)) return [];
  triggered.add(index);
  const r = rowOf(index);
  const c = colOf(index);
  const out: number[] = [];
  if (g.special === 'row') for (let k = 0; k < SIZE; k++) out.push(idx(r, k));
  else if (g.special === 'col') for (let k = 0; k < SIZE; k++) out.push(idx(k, c));
  else if (g.special === 'bomb') {
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) out.push(idx(nr, nc));
      }
  } else if (g.special === 'star') {
    const counts = new Map<number, number>();
    for (const cell of state.board) {
      if (cell && cell.special !== 'star') counts.set(cell.type, (counts.get(cell.type) ?? 0) + 1);
    }
    let bestType = -1;
    let bestCount = 0;
    for (const [t, n] of counts) {
      if (n > bestCount) {
        bestCount = n;
        bestType = t;
      }
    }
    state.board.forEach((cell, i) => {
      if (cell && cell.special !== 'star' && cell.type === bestType) out.push(i);
    });
  }
  return out;
}

/**
 * 从一组初始清除格开始，链式引爆特殊宝石，返回最终清除集。
 * 生成位（transform）不在清除集里，新特殊宝石当步不引爆。
 */
function chainClear(state: EngineState, initial: number[], protectedCells: Set<number>): number[] {
  const clear = new Set<number>();
  const queue: number[] = [];
  const triggered = new Set<number>();
  const push = (i: number) => {
    if (protectedCells.has(i) || clear.has(i) || !state.board[i]) return;
    clear.add(i);
    queue.push(i);
  };
  initial.forEach(push);
  while (queue.length) {
    const i = queue.shift()!;
    const g = state.board[i];
    if (g && g.special !== 'none') {
      for (const j of blastCells(state, i, triggered)) push(j);
    }
  }
  return [...clear];
}

function snapshot(board: Board): Board {
  return board.map((g) => (g ? { ...g } : null));
}

/** 执行一步：清除 + 变形 + 重力补给，返回渲染快照 */
function makeStep(state: EngineState, cleared: number[], transform: Transform[], cascade: number): Step {
  const beforeClear = snapshot(state.board);
  for (const i of cleared) state.board[i] = null;
  for (const t of transform) {
    const g = state.board[t.index];
    if (g) g.special = t.special;
  }
  applyGravity(state);
  return {
    cleared,
    transform,
    beforeClear,
    afterGravity: snapshot(state.board),
    score: cleared.length * 10 * cascade,
    cascade,
  };
}

/** 交换后（或星钻引爆后）的完整连锁结算，原地推进 state.board */
function resolve(state: EngineState, prefer: number[], first?: { cleared: number[] }): Step[] {
  const steps: Step[] = [];
  let cascade = 1;
  if (first) {
    const cleared = chainClear(state, first.cleared, new Set());
    steps.push(makeStep(state, cleared, [], cascade++));
  }
  for (;;) {
    const clusters = findClusters(state.board, prefer);
    if (clusters.length === 0) break;
    const transform: Transform[] = [];
    const protectedCells = new Set<number>();
    const initial: number[] = [];
    for (const cl of clusters) {
      if (cl.special !== 'none') {
        transform.push({ index: cl.spawn, special: cl.special });
        protectedCells.add(cl.spawn);
      }
      initial.push(...cl.cells);
    }
    const cleared = chainClear(state, initial, protectedCells);
    steps.push(makeStep(state, cleared, transform, cascade++));
    prefer = [];
  }
  return steps;
}

/** 星钻交换：星钻+普通=消同色；星钻+星钻=清屏；星钻+特殊=消同色并引爆该特殊 */
function resolveStar(state: EngineState, a: number, b: number): Step[] {
  const ga = state.board[a]!;
  const star = ga.special === 'star' ? a : b;
  const other = star === a ? b : a;
  const target = state.board[other]!;
  const initial: number[] = [star, other];
  if (target.special === 'star') {
    state.board.forEach((g, i) => {
      if (g) initial.push(i);
    });
  } else {
    state.board.forEach((g, i) => {
      if (g && g.special !== 'star' && g.type === target.type) initial.push(i);
    });
  }
  return resolve(state, [], { cleared: initial });
}

/**
 * 尝试交换相邻两格。不产生消除（且不含星钻）则回滚并返回 null。
 * 合法则完成全部连锁；结算后若无有效步会自动重排（见 ensureMove）。
 */
export function trySwap(state: EngineState, a: number, b: number): Step[] | null {
  if (!areAdjacent(a, b)) return null;
  const ga = state.board[a];
  const gb = state.board[b];
  if (!ga || !gb) return null;
  if (ga.special === 'star' || gb.special === 'star') return resolveStar(state, a, b);
  state.board[a] = gb;
  state.board[b] = ga;
  if (findClusters(state.board).length === 0) {
    state.board[a] = ga;
    state.board[b] = gb;
    return null;
  }
  return resolve(state, [b, a]);
}

/** 找一个有效交换（含星钻交换），供提示与死局检测 */
export function findValidMove(state: EngineState): [number, number] | null {
  for (let i = 0; i < CELLS; i++) {
    const g = state.board[i];
    if (!g) continue;
    for (const j of [colOf(i) < SIZE - 1 ? i + 1 : -1, rowOf(i) < SIZE - 1 ? i + SIZE : -1]) {
      if (j < 0) continue;
      const n = state.board[j];
      if (!n) continue;
      if (g.special === 'star' || n.special === 'star') return [i, j];
      state.board[i] = n;
      state.board[j] = g;
      const ok = findClusters(state.board).length > 0;
      state.board[i] = g;
      state.board[j] = n;
      if (ok) return [i, j];
    }
  }
  return null;
}

/** 无-match 填充：每个格子避开左两格/上两格同色 */
function fillNoMatch(state: EngineState): void {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      let type = Math.floor(state.rng() * COLOR_COUNT);
      for (;;) {
        const h = c >= 2 && boardAt(state.board, r, c - 1)?.type === type && boardAt(state.board, r, c - 2)?.type === type;
        const v = r >= 2 && boardAt(state.board, r - 1, c)?.type === type && boardAt(state.board, r - 2, c)?.type === type;
        if (!h && !v) break;
        type = (type + 1) % COLOR_COUNT;
      }
      state.board[idx(r, c)] = { id: state.nextId++, type, special: 'none' };
    }
  }
}

/** 死局重排：只洗普通宝石，特殊宝石留在原位；保证无预置消除且存在有效步 */
export function reshuffle(state: EngineState): void {
  const normalIdx: number[] = [];
  state.board.forEach((g, i) => {
    if (g && g.special === 'none') normalIdx.push(i);
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const gems = normalIdx.map((i) => state.board[i]!);
    for (let i = gems.length - 1; i > 0; i--) {
      const j = Math.floor(state.rng() * (i + 1));
      [gems[i], gems[j]] = [gems[j], gems[i]];
    }
    normalIdx.forEach((pos, k) => {
      state.board[pos] = gems[k];
    });
    if (findClusters(state.board).length === 0 && findValidMove(state)) return;
  }
  // 兜底：普通格按行序重生成，避开与已填格（含固定的特殊宝石）成三连
  for (let attempt = 0; attempt < 200; attempt++) {
    for (const i of normalIdx) state.board[i] = null;
    for (const i of normalIdx) {
      const r = rowOf(i);
      const c = colOf(i);
      let type = Math.floor(state.rng() * COLOR_COUNT);
      for (;;) {
        const h = c >= 2 && boardAt(state.board, r, c - 1)?.type === type && boardAt(state.board, r, c - 2)?.type === type;
        const v = r >= 2 && boardAt(state.board, r - 1, c)?.type === type && boardAt(state.board, r - 2, c)?.type === type;
        if (!h && !v) break;
        type = (type + 1) % COLOR_COUNT;
      }
      state.board[i] = { id: state.nextId++, type, special: 'none' };
    }
    if (findClusters(state.board).length === 0 && findValidMove(state)) return;
  }
}

export function ensureMove(state: EngineState): boolean {
  if (findValidMove(state)) return false;
  for (let k = 0; k < 10; k++) {
    reshuffle(state);
    if (findValidMove(state)) return true;
  }
  return true;
}

export function createEngine(rng: () => number = Math.random): EngineState {
  const state: EngineState = { board: Array(CELLS).fill(null), nextId: 1, rng };
  fillNoMatch(state);
  ensureMove(state);
  return state;
}

/** 每关步数 */
export const MOVES_PER_LEVEL = 20;

/** 关卡目标分：随关卡线性增长（数值由随机对局模拟校准，见测试） */
export function targetForLevel(level: number): number {
  return 900 + (level - 1) * 500;
}