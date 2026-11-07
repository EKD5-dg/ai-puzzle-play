/**
 * 3D 晶核防线 —— 纯逻辑核心（无 DOM，可直接在 Node 里跑平衡模拟）。
 *
 * 地图是一块 13×9 的浮空遗迹：兽潮从左侧裂隙沿唯一路径走向右下角的晶核，
 * 玩家只能在固定晶塔位建造。塔不参与寻路，因此不存在"堵路"软锁。
 * 与渲染完全解耦：渲染读状态，模拟只吃 dt。
 */

export const GRID_W = 13;
export const GRID_H = 9;
export const CORE_MAX_HP = 20;
export const WAVE_COUNT = 12;
/** 开局建造时间（秒）与波间修整时间 */
export const PREP_FIRST = 18;
export const PREP_BETWEEN = 12;
export const START_GOLD = 240;

export type TowerKind = 'pulse' | 'frost' | 'mortar';
export type EnemyKind = 'crawler' | 'wisp' | 'shell' | 'boss';
export type Phase = 'prep' | 'wave' | 'won' | 'lost';

// ============ 地图 ============

/** 路径拐点（格坐标） */
export const PATH_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0, 2],
  [3, 2],
  [3, 6],
  [7, 6],
  [7, 2],
  [10, 2],
  [10, 7],
  [12, 7],
];

function expandPath(): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let i = 0; i < PATH_CORNERS.length - 1; i++) {
    const [ax, ay] = PATH_CORNERS[i];
    const [bx, by] = PATH_CORNERS[i + 1];
    const dx = Math.sign(bx - ax);
    const dy = Math.sign(by - ay);
    let x = ax;
    let y = ay;
    while (x !== bx || y !== by) {
      cells.push([x, y]);
      x += dx;
      y += dy;
    }
  }
  const last = PATH_CORNERS[PATH_CORNERS.length - 1];
  cells.push([last[0], last[1]]);
  return cells;
}

/** 逐格路径（相邻两点均为四邻域，长度即格距） */
export const PATH_CELLS: ReadonlyArray<readonly [number, number]> = expandPath();
/** 路径总长（格） */
export const ROUTE_LEN = PATH_CELLS.length - 1;
export const SPAWN_POS = PATH_CELLS[0];
export const CORE_POS = PATH_CELLS[PATH_CELLS.length - 1];

/** 固定晶塔位：只在遗迹的塔座上建造，避免把整张图铺满塔 */
export const PAD_LIST: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [4, 1],
  [1, 5],
  [4, 4],
  [2, 6],
  [1, 7],
  [4, 7],
  [5, 4],
  [6, 3],
  [8, 4],
  [8, 1],
  [9, 3],
  [11, 3],
  [9, 8],
  [11, 6],
  [12, 5],
];

export const PATH_KEY = (x: number, y: number) => y * GRID_W + x;
export const PATH_SET = new Set(PATH_CELLS.map(([x, y]) => PATH_KEY(x, y)));
export const PAD_SET = new Set(PAD_LIST.map(([x, y]) => PATH_KEY(x, y)));

export type DecorKind = 'crystal' | 'pillar' | 'tree' | 'obelisk' | 'rubble';

/** 路径外的遗迹装饰（不可建造、不影响寻路） */
export const DECOR_LIST: ReadonlyArray<{ x: number; y: number; kind: DecorKind }> = [
  { x: 1, y: 6, kind: 'crystal' },
  { x: 5, y: 1, kind: 'pillar' },
  { x: 6, y: 8, kind: 'rubble' },
  { x: 11, y: 4, kind: 'obelisk' },
  { x: 2, y: 4, kind: 'tree' },
];

/** 从路径起点走 dist 格后的浮点坐标 */
export function pathPos(dist: number): [number, number] {
  const d = Math.max(0, Math.min(ROUTE_LEN, dist));
  const i = Math.max(0, Math.min(PATH_CELLS.length - 2, Math.floor(d)));
  const a = PATH_CELLS[i];
  const b = PATH_CELLS[i + 1];
  const f = Math.min(1, d - i);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

// ============ 数值表 ============

export interface TowerLevelStat {
  /** 0 级（建造）与 1/2 级升级的费用 */
  cost: number;
  dmg: number;
  /** 格 */
  range: number;
  /** 次/秒 */
  rate: number;
  slow?: number;
  slowT?: number;
  splash?: number;
}

export interface TowerDef {
  name: string;
  blurb: string;
  color: string;
  levels: [TowerLevelStat, TowerLevelStat, TowerLevelStat];
}

export const TOWER_DEFS: Record<TowerKind, TowerDef> = {
  pulse: {
    name: '脉冲塔',
    blurb: '高频单体 · 被护甲克制',
    color: '#63e6ff',
    levels: [
      { cost: 60, dmg: 10, range: 2.9, rate: 1.8 },
      { cost: 70, dmg: 17, range: 3.1, rate: 2.0 },
      { cost: 110, dmg: 27, range: 3.4, rate: 2.2 },
    ],
  },
  frost: {
    name: '霜华塔',
    blurb: '光环减速 · 伤害无视护甲',
    color: '#8fb8ff',
    levels: [
      { cost: 80, dmg: 4, range: 2.5, rate: 1.0, slow: 0.4, slowT: 1.3 },
      { cost: 90, dmg: 7, range: 2.7, rate: 1.05, slow: 0.48, slowT: 1.4 },
      { cost: 130, dmg: 11, range: 3.0, rate: 1.1, slow: 0.55, slowT: 1.5 },
    ],
  },
  mortar: {
    name: '裂地炮',
    blurb: '曲射溅射 · 克制成群',
    color: '#ffb066',
    levels: [
      { cost: 110, dmg: 30, range: 3.5, rate: 0.5, splash: 0.95 },
      { cost: 120, dmg: 48, range: 3.7, rate: 0.55, splash: 1.1 },
      { cost: 160, dmg: 72, range: 4.0, rate: 0.6, splash: 1.25 },
    ],
  },
};

export const TOWER_ORDER: TowerKind[] = ['pulse', 'frost', 'mortar'];

export interface EnemyDef {
  name: string;
  hp: number;
  /** 格/秒 */
  speed: number;
  armor: number;
  gold: number;
  score: number;
  coreDmg: number;
  /** 慢速抗性 0~1（Boss / 幽萤天然抗霜） */
  slowResist: number;
  boss: boolean;
}

export const ENEMY_DEFS: Record<EnemyKind, EnemyDef> = {
  crawler: { name: '蚀行者', hp: 34, speed: 1.15, armor: 0, gold: 6, score: 8, coreDmg: 1, slowResist: 0, boss: false },
  wisp: { name: '幽萤', hp: 26, speed: 1.9, armor: 1, gold: 7, score: 10, coreDmg: 1, slowResist: 0.4, boss: false },
  shell: { name: '甲壳兽', hp: 150, speed: 0.75, armor: 7, gold: 16, score: 26, coreDmg: 2, slowResist: 0, boss: false },
  boss: { name: '裂界巨兽', hp: 900, speed: 0.6, armor: 12, gold: 100, score: 300, coreDmg: 8, slowResist: 0.5, boss: true },
};

export interface WaveGroup {
  kind: EnemyKind;
  count: number;
  /** 同组内出怪间隔（秒） */
  gap: number;
  /** 相对本波开始的延迟（秒） */
  delay: number;
}

export interface WaveDef {
  groups: WaveGroup[];
  title?: string;
}

export const WAVES: readonly WaveDef[] = [
  { groups: [{ kind: 'crawler', count: 8, gap: 0.9, delay: 0.4 }] },
  { groups: [{ kind: 'crawler', count: 12, gap: 0.72, delay: 0.4 }] },
  {
    groups: [
      { kind: 'crawler', count: 8, gap: 0.8, delay: 0.3 },
      { kind: 'wisp', count: 5, gap: 0.6, delay: 4.0 },
    ],
  },
  {
    groups: [
      { kind: 'shell', count: 4, gap: 2.0, delay: 0.5 },
      { kind: 'crawler', count: 10, gap: 0.7, delay: 1.2 },
    ],
  },
  {
    groups: [
      { kind: 'wisp', count: 12, gap: 0.5, delay: 0.3 },
      { kind: 'shell', count: 3, gap: 1.8, delay: 2.5 },
    ],
  },
  {
    title: '首领苏醒',
    groups: [
      { kind: 'boss', count: 1, gap: 1, delay: 0.8 },
      { kind: 'crawler', count: 12, gap: 0.6, delay: 1.6 },
    ],
  },
  {
    groups: [
      { kind: 'shell', count: 8, gap: 1.35, delay: 0.3 },
      { kind: 'wisp', count: 8, gap: 0.55, delay: 1.0 },
    ],
  },
  {
    groups: [
      { kind: 'crawler', count: 16, gap: 0.48, delay: 0.2 },
      { kind: 'wisp', count: 10, gap: 0.5, delay: 2.2 },
    ],
  },
  {
    groups: [
      { kind: 'shell', count: 10, gap: 1.25, delay: 0.3 },
      { kind: 'wisp', count: 10, gap: 0.5, delay: 1.0 },
    ],
  },
  {
    title: '双生巨兽',
    groups: [
      { kind: 'boss', count: 2, gap: 4.0, delay: 0.5 },
      { kind: 'shell', count: 8, gap: 1.2, delay: 2.0 },
      { kind: 'wisp', count: 10, gap: 0.5, delay: 3.0 },
    ],
  },
  {
    groups: [
      { kind: 'shell', count: 12, gap: 1.05, delay: 0.3 },
      { kind: 'wisp', count: 16, gap: 0.42, delay: 0.8 },
      { kind: 'crawler', count: 12, gap: 0.5, delay: 2.0 },
    ],
  },
  {
    title: '终焉之潮',
    groups: [
      { kind: 'boss', count: 1, gap: 1, delay: 0.5 },
      { kind: 'shell', count: 10, gap: 1.1, delay: 1.5 },
      { kind: 'wisp', count: 12, gap: 0.45, delay: 2.5 },
      { kind: 'crawler', count: 12, gap: 0.5, delay: 3.5 },
    ],
  },
];

/** 波次生命成长：第 12 波约为开局的 2 倍；终局 Boss 额外 ×1.8 */
export function hpScale(wave: number): number {
  return 1 + 0.09 * (wave - 1);
}

export function earlyBonus(wave: number): number {
  return 8 + wave * 2;
}

export function waveGold(wave: number): number {
  return 18 + wave * 5;
}

export function waveScore(wave: number): number {
  return 40 + wave * 10;
}

// ============ 状态 ============

export interface Enemy {
  id: number;
  kind: EnemyKind;
  hp: number;
  maxHp: number;
  dist: number;
  x: number;
  y: number;
  speed: number;
  armor: number;
  gold: number;
  scoreValue: number;
  coreDmg: number;
  slowResist: number;
  slowT: number;
  slowK: number;
  hitT: number;
  boss: boolean;
  dead: boolean;
}

export interface Tower {
  id: number;
  kind: TowerKind;
  gx: number;
  gy: number;
  level: 1 | 2 | 3;
  cd: number;
  aimX: number;
  aimY: number;
  flashT: number;
  invested: number;
}

export interface Shell {
  id: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  t: number;
  dur: number;
  dmg: number;
  splash: number;
}

export type FxKind =
  | 'tracer'
  | 'nova'
  | 'blast'
  | 'death'
  | 'gold'
  | 'core'
  | 'spawn'
  | 'build'
  | 'upgrade';

export interface Fx {
  kind: FxKind;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  t0: number;
  dur: number;
  text?: string;
  color?: string;
  size?: number;
  boss?: boolean;
}

export type GameEvent =
  | { type: 'wave'; wave: number; boss: boolean }
  | { type: 'clear' }
  | { type: 'kill'; boss: boolean }
  | { type: 'leak' }
  | { type: 'win' }
  | { type: 'lose' }
  | { type: 'build' }
  | { type: 'upgrade' }
  | { type: 'sell' };

export interface Announce {
  text: string;
  sub: string;
  t0: number;
  dur: number;
}

export interface GameState {
  time: number;
  phase: Phase;
  wave: number;
  prepT: number;
  prepTotal: number;
  waveT: number;
  gold: number;
  score: number;
  coreHp: number;
  towers: Tower[];
  enemies: Enemy[];
  shells: Shell[];
  fx: Fx[];
  spawnQueue: Array<{ kind: EnemyKind; at: number; hpMult: number }>;
  nextId: number;
  shakeT: number;
  announce: Announce | null;
  events: GameEvent[];
  kills: number;
}

export function createGame(): GameState {
  return {
    time: 0,
    phase: 'prep',
    wave: 1,
    prepT: PREP_FIRST,
    prepTotal: PREP_FIRST,
    waveT: 0,
    gold: START_GOLD,
    score: 0,
    coreHp: CORE_MAX_HP,
    towers: [],
    enemies: [],
    shells: [],
    fx: [],
    spawnQueue: [],
    nextId: 1,
    shakeT: 0,
    announce: { text: '守住晶核', sub: '在塔座上布防 · 撑过 12 波', t0: 0, dur: 2.6 },
    events: [],
    kills: 0,
  };
}

// ============ 查询 ============

export function towerStat(t: Tower): TowerLevelStat {
  return TOWER_DEFS[t.kind].levels[t.level - 1];
}

export function buildCost(kind: TowerKind): number {
  return TOWER_DEFS[kind].levels[0].cost;
}

export function upgradeCost(t: Tower): number {
  const levels = TOWER_DEFS[t.kind].levels;
  if (t.level === 1) return levels[1].cost;
  if (t.level === 2) return levels[2].cost;
  return 0;
}

export function sellValue(t: Tower): number {
  return Math.floor(t.invested * 0.6);
}

export function towerAt(w: GameState, x: number, y: number): Tower | undefined {
  return w.towers.find((t) => t.gx === x && t.gy === y);
}

export function isPad(x: number, y: number): boolean {
  return PAD_SET.has(PATH_KEY(x, y));
}

export function waveRemaining(w: GameState): number {
  return w.spawnQueue.length + w.enemies.filter((e) => !e.dead).length;
}

export function aliveBosses(w: GameState): Enemy[] {
  return w.enemies.filter((e) => e.boss && !e.dead);
}

// ============ 操作 ============

export type PlaceResult = 'ok' | 'terrain' | 'occupied' | 'gold' | 'phase';

export function placeTower(w: GameState, kind: TowerKind, x: number, y: number): PlaceResult {
  if (w.phase !== 'prep' && w.phase !== 'wave') return 'phase';
  if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return 'terrain';
  if (!isPad(x, y) || PATH_SET.has(PATH_KEY(x, y))) return 'terrain';
  if (towerAt(w, x, y)) return 'occupied';
  const cost = buildCost(kind);
  if (w.gold < cost) return 'gold';
  w.gold -= cost;
  const tower: Tower = {
    id: w.nextId++,
    kind,
    gx: x,
    gy: y,
    level: 1,
    cd: 0.25,
    aimX: x + 1,
    aimY: y + 1,
    flashT: 0,
    invested: cost,
  };
  w.towers.push(tower);
  w.fx.push({ kind: 'build', x, y, t0: w.time, dur: 0.5, color: TOWER_DEFS[kind].color });
  w.events.push({ type: 'build' });
  return 'ok';
}

export function upgradeTower(w: GameState, id: number): 'ok' | 'gold' | 'max' | 'none' {
  if (w.phase !== 'prep' && w.phase !== 'wave') return 'none';
  const t = w.towers.find((v) => v.id === id);
  if (!t) return 'none';
  if (t.level >= 3) return 'max';
  const cost = upgradeCost(t);
  if (w.gold < cost) return 'gold';
  w.gold -= cost;
  t.invested += cost;
  t.level = (t.level + 1) as 2 | 3;
  w.fx.push({ kind: 'upgrade', x: t.gx, y: t.gy, t0: w.time, dur: 0.6, color: TOWER_DEFS[t.kind].color });
  w.events.push({ type: 'upgrade' });
  return 'ok';
}

export function sellTower(w: GameState, id: number): number {
  const i = w.towers.findIndex((v) => v.id === id);
  if (i < 0) return 0;
  const refund = sellValue(w.towers[i]);
  w.gold += refund;
  w.towers.splice(i, 1);
  w.events.push({ type: 'sell' });
  return refund;
}

export function callWave(w: GameState): boolean {
  if (w.phase !== 'prep') return false;
  const bonus = earlyBonus(w.wave);
  w.gold += bonus;
  w.fx.push({ kind: 'gold', x: CORE_POS[0], y: CORE_POS[1], t0: w.time, dur: 1.0, text: `提前出击 +${bonus}` });
  startWave(w);
  return true;
}

function startWave(w: GameState): void {
  if (w.phase !== 'prep') return;
  const def = WAVES[w.wave - 1];
  const queue: GameState['spawnQueue'] = [];
  let boss = false;
  for (const g of def.groups) {
    for (let i = 0; i < g.count; i++) {
      const isFinalBoss = g.kind === 'boss' && w.wave === WAVE_COUNT;
      if (g.kind === 'boss') boss = true;
      queue.push({
        kind: g.kind,
        at: g.delay + i * g.gap,
        hpMult: isFinalBoss ? 1.8 : 1,
      });
    }
  }
  queue.sort((a, b) => a.at - b.at);
  w.spawnQueue = queue;
  w.waveT = 0;
  w.phase = 'wave';
  w.prepT = 0;
  const title = def.title ? `${def.title} · ` : '';
  w.announce = {
    text: `第 ${w.wave} 波 · ${title}${boss ? '首领来袭' : '兽潮来袭'}`,
    sub: boss ? '重甲 · 脉冲乏力：改用霜华 / 裂地炮破甲' : '清空这一波即可获得晶能与修整时间',
    t0: w.time,
    dur: 2.2,
  };
  w.events.push({ type: 'wave', wave: w.wave, boss });
}

// ============ 模拟 ============

function damage(w: GameState, e: Enemy, raw: number, ignoreArmor: boolean): void {
  if (e.dead) return;
  const dmg = Math.max(1, ignoreArmor ? raw : raw - e.armor);
  e.hp -= dmg;
  e.hitT = 0.16;
  if (e.hp > 0) return;
  e.hp = 0;
  e.dead = true;
  w.gold += e.gold;
  w.score += e.scoreValue;
  w.kills++;
  w.fx.push({ kind: 'death', x: e.x, y: e.y, t0: w.time, dur: e.boss ? 1.0 : 0.45, boss: e.boss });
  w.fx.push({
    kind: 'gold',
    x: e.x,
    y: e.y,
    t0: w.time,
    dur: 0.85,
    text: `+${e.gold}`,
  });
  w.events.push({ type: 'kill', boss: e.boss });
}

function pickTarget(w: GameState, t: Tower, range: number): Enemy | null {
  let best: Enemy | null = null;
  for (const e of w.enemies) {
    if (e.dead) continue;
    const dx = e.x - t.gx;
    const dy = e.y - t.gy;
    if (dx * dx + dy * dy > range * range) continue;
    if (!best || e.dist > best.dist) best = e;
  }
  return best;
}

function spawnEnemy(w: GameState, kind: EnemyKind, hpMult: number): void {
  const def = ENEMY_DEFS[kind];
  const hp = Math.round(def.hp * hpScale(w.wave) * hpMult);
  const [x, y] = pathPos(0);
  w.enemies.push({
    id: w.nextId++,
    kind,
    hp,
    maxHp: hp,
    dist: 0,
    x,
    y,
    speed: def.speed,
    armor: def.armor,
    gold: def.gold,
    scoreValue: def.score,
    coreDmg: def.coreDmg,
    slowResist: def.slowResist,
    slowT: 0,
    slowK: 0,
    hitT: 0,
    boss: def.boss,
    dead: false,
  });
  w.fx.push({ kind: 'spawn', x, y, t0: w.time, dur: 0.5, boss: def.boss });
}

function updateTowers(w: GameState, dt: number): void {
  for (const t of w.towers) {
    t.cd -= dt;
    if (t.flashT > 0) t.flashT = Math.max(0, t.flashT - dt);
    const st = towerStat(t);
    if (t.cd > 0) continue;

    if (t.kind === 'frost') {
      let any = false;
      for (const e of w.enemies) {
        if (e.dead) continue;
        const dx = e.x - t.gx;
        const dy = e.y - t.gy;
        if (dx * dx + dy * dy > st.range * st.range) continue;
        any = true;
        const slow = (st.slow ?? 0) * (1 - e.slowResist);
        // 只有同级或更强的减速才能刷新计时；否则低级霜塔会无限续上高级塔的强减速
        if (e.slowT <= 0 || slow >= e.slowK) {
          e.slowK = slow;
          e.slowT = Math.max(e.slowT, st.slowT ?? 0);
        }
        damage(w, e, st.dmg, true);
      }
      if (!any) continue;
      t.cd = 1 / st.rate;
      t.flashT = 0.3;
      w.fx.push({ kind: 'nova', x: t.gx, y: t.gy, t0: w.time, dur: 0.55, color: TOWER_DEFS.frost.color, size: st.range });
      continue;
    }

    const target = pickTarget(w, t, st.range);
    if (!target) continue;
    t.aimX = target.x;
    t.aimY = target.y;
    t.flashT = 0.14;
    t.cd = 1 / st.rate;

    if (t.kind === 'pulse') {
      w.fx.push({
        kind: 'tracer',
        x: t.gx,
        y: t.gy,
        x2: target.x,
        y2: target.y,
        t0: w.time,
        dur: 0.16,
        color: TOWER_DEFS.pulse.color,
      });
      damage(w, target, st.dmg, false);
    } else {
      const flight = 0.5 + 0.05 * Math.abs(target.x - t.gx) + 0.05 * Math.abs(target.y - t.gy);
      const effSpeed = target.slowT > 0 ? target.speed * (1 - target.slowK) : target.speed;
      const [tx, ty] = pathPos(Math.min(ROUTE_LEN, target.dist + effSpeed * flight));
      w.shells.push({
        id: w.nextId++,
        sx: t.gx,
        sy: t.gy,
        tx,
        ty,
        t: 0,
        dur: flight,
        dmg: st.dmg,
        splash: st.splash ?? 0.9,
      });
      w.fx.push({
        kind: 'tracer',
        x: t.gx,
        y: t.gy,
        x2: (t.gx + tx) / 2,
        y2: (t.gy + ty) / 2,
        t0: w.time,
        dur: 0.1,
        color: '#ffd08a',
      });
    }
  }
}

function updateShells(w: GameState, dt: number): void {
  for (const s of w.shells) {
    s.t += dt;
    if (s.t < s.dur) continue;
    s.t = s.dur;
    w.fx.push({ kind: 'blast', x: s.tx, y: s.ty, t0: w.time, dur: 0.55, size: s.splash });
    for (const e of w.enemies) {
      if (e.dead) continue;
      const dx = e.x - s.tx;
      const dy = e.y - s.ty;
      if (dx * dx + dy * dy <= s.splash * s.splash) damage(w, e, s.dmg, false);
    }
  }
  w.shells = w.shells.filter((s) => s.t < s.dur);
}

function completeWave(w: GameState): void {
  const gold = waveGold(w.wave);
  const sc = waveScore(w.wave);
  w.gold += gold;
  w.score += sc;
  w.events.push({ type: 'clear' });
  if (w.wave >= WAVE_COUNT) {
    w.phase = 'won';
    w.score += w.coreHp * 80;
    w.announce = {
      text: '晶核守住了！',
      sub: `十二波兽潮尽数溃散 · 晶核剩余 ${w.coreHp}/${CORE_MAX_HP}`,
      t0: w.time,
      dur: 4,
    };
    w.events.push({ type: 'win' });
    return;
  }
  w.wave += 1;
  w.phase = 'prep';
  w.prepT = PREP_BETWEEN;
  w.prepTotal = PREP_BETWEEN;
  w.announce = {
    text: `第 ${w.wave - 1} 波肃清`,
    sub: `+${gold} 晶能 · 第 ${w.wave} 波即将来袭`,
    t0: w.time,
    dur: 2.4,
  };
}

/** 推进模拟。dt 会被夹紧，调用方无需担心切后台回来的大跳。 */
export function update(w: GameState, dtRaw: number): void {
  const dt = Math.max(0, Math.min(0.1, dtRaw));
  if (dt === 0 || w.phase === 'won' || w.phase === 'lost') return;
  w.time += dt;
  w.shakeT = Math.max(0, w.shakeT - dt);

  if (w.phase === 'prep') {
    w.prepT -= dt;
    // 波间没有目标：清掉上一波仍在空中的炮弹，否则它们会冻在半空、下一波再落下
    w.shells.length = 0;
    w.fx = w.fx.filter((f) => w.time - f.t0 < f.dur);
    if (w.prepT <= 0) {
      w.prepT = 0;
      startWave(w);
    }
    return;
  }

  w.waveT += dt;

  // 出怪
  while (w.spawnQueue.length > 0 && w.spawnQueue[0].at <= w.waveT) {
    const s = w.spawnQueue.shift()!;
    spawnEnemy(w, s.kind, s.hpMult);
  }

  // 移动与减速计时
  for (const e of w.enemies) {
    if (e.dead) continue;
    if (e.slowT > 0) e.slowT = Math.max(0, e.slowT - dt);
    if (e.hitT > 0) e.hitT = Math.max(0, e.hitT - dt);
    const k = e.slowT > 0 ? 1 - e.slowK : 1;
    e.dist += e.speed * k * dt;
    const [x, y] = pathPos(e.dist);
    e.x = x;
    e.y = y;
  }

  updateTowers(w, dt);
  updateShells(w, dt);

  // 漏怪撞核
  let leaked = 0;
  for (const e of w.enemies) {
    if (e.dead || e.dist < ROUTE_LEN) continue;
    e.dead = true;
    leaked++;
    w.coreHp = Math.max(0, w.coreHp - e.coreDmg);
    w.shakeT = Math.max(w.shakeT, 0.45);
    w.fx.push({
      kind: 'core',
      x: CORE_POS[0],
      y: CORE_POS[1],
      t0: w.time,
      dur: 0.75,
      text: `-${e.coreDmg}`,
    });
    w.events.push({ type: 'leak' });
  }

  if (leaked > 0 && w.coreHp <= 0) {
    w.phase = 'lost';
    w.announce = null;
    w.events.push({ type: 'lose' });
    return;
  }

  w.enemies = w.enemies.filter((e) => !e.dead);
  w.fx = w.fx.filter((f) => w.time - f.t0 < f.dur);

  if (w.phase === 'wave' && w.spawnQueue.length === 0 && w.enemies.length === 0) completeWave(w);
}

/** 模拟用：把一帧事件取走 */
export function drainEvents(w: GameState): GameEvent[] {
  if (w.events.length === 0) return [];
  const out = w.events;
  w.events = [];
  return out;
}
