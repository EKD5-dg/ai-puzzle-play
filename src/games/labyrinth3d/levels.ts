import { FLOOR, ICE, SAND, WALL } from './types.ts';
import type { Hole, Level, LevelDef, Sweeper, Vec2 } from './types.ts';

export const SIZE = 10;
export const BALL_R = 0.3;
export const HOLE_R = 0.38;
export const WALL_H = 0.46;

/**
 * 图例：# 墙 · . 地面 · ~ 冰面 · : 沙地 · O 陷阱洞 · G 终点洞
 *       S 起点 · C 检查点 · * 宝石 · P 摆杆轴心
 * 外圈一律是墙，内部 8×8 为 playable 区域。
 */
export const LEVEL_DEFS: LevelDef[] = [
  {
    id: 'l1',
    name: '初推',
    subtitle: '拖动画面倾斜星盘，让钢珠滚进金色终点。松手盘面自动回正。',
    rows: [
      '##########',
      '#S.......#',
      '#..##....#',
      '#..##.*..#',
      '#...*....#',
      '#...O....#',
      '#.*....O.#',
      '#....##..#',
      '#.......G#',
      '##########',
    ],
    sweepers: [],
    par: 26,
  },
  {
    id: 'l2',
    name: '回廊',
    subtitle: '窄廊里球会带着惯性撞墙。提前反打盘面刹车，别一路满舵。',
    rows: [
      '##########',
      '#S...#...#',
      '###.##.#.#',
      '#.*..#.#.#',
      '#.##.#.#.#',
      '#.#..O.#.#',
      '#.#.####.#',
      '#.#....*.#',
      '#.O...#..G',
      '##########',
    ],
    sweepers: [],
    par: 38,
  },
  {
    id: 'l3',
    name: '冰原',
    subtitle: '淡蓝冰面几乎没有摩擦，球会一直滑。想停下就得提前很久反向倾斜。',
    rows: [
      '##########',
      '#S..~~~~.#',
      '#.*.~~~~.#',
      '#...~~~~.#',
      '#.##....O#',
      '#..~~~...#',
      '#O.~~~.*.#',
      '#..~~~..##',
      '#....O..G#',
      '##########',
    ],
    sweepers: [],
    par: 28,
  },
  {
    id: 'l4',
    name: '沙洲',
    subtitle: '琥珀沙地会把球拖住，洞却不会。踩上检查点，掉命后从那里重来。',
    rows: [
      '##########',
      '#S..O...C#',
      '#.:::..#.#',
      '#.*::O.#.#',
      '#.:::..#.#',
      '#O...::..#',
      '#.##.::*.#',
      '#..O.::..#',
      '#....O..G#',
      '##########',
    ],
    sweepers: [],
    par: 36,
  },
  {
    id: 'l5',
    name: '摆杆',
    subtitle: '铜杆不停横扫，碰到会把球甩出去。等它扫过再走，别硬闯。',
    rows: [
      '##########',
      '#S..*....#',
      '#........#',
      '#...P....#',
      '#........#',
      '#.O....O.#',
      '#........#',
      '#..*..P..#',
      '#C......G#',
      '##########',
    ],
    sweepers: [
      { arm: 1.5, omega: 1.05, phase: 0.4 },
      { arm: 1.5, omega: -1.32, phase: 2.1 },
    ],
    par: 32,
  },
  {
    id: 'l6',
    name: '双摆冰带',
    subtitle: '冰带上两把摆杆。两侧有摩擦的地面是活路，中间是近道也是险路。',
    rows: [
      '##########',
      '#S..~~~..#',
      '#.*.~~~.O#',
      '#...~P~..#',
      '#.O.~~~..#',
      '#...~~~*.#',
      '#C..~P~..#',
      '#...~~~.O#',
      '#.......G#',
      '##########',
    ],
    sweepers: [
      { arm: 1.5, omega: 1.24, phase: 1.1 },
      { arm: 1.5, omega: -0.94, phase: 3.6 },
    ],
    par: 36,
  },
  {
    id: 'l7',
    name: '险径',
    subtitle: '墙障只留一个缺口，得先右、再左、再右。廊口的洞等着你刹不住。',
    rows: [
      '##########',
      '#S...*...#',
      '#..O...O.#',
      '########.#',
      '#.*....O.#',
      '#.O..:...#',
      '#.########',
      '#..O...*.#',
      '#.......G#',
      '##########',
    ],
    sweepers: [],
    par: 58,
  },
  {
    id: 'l8',
    name: '星盘',
    subtitle: '冰、沙、洞、双摆全在这张盘上。先踩右上角检查点，再沿右缘南下。',
    rows: [
      '##########',
      '#S.~~~..C#',
      '#.*~P~.O.#',
      '########.#',
      '#.O~~~:..#',
      '#..:*~O..#',
      '#.########',
      '#..O~P~*.#',
      '#..~~~..G#',
      '##########',
    ],
    sweepers: [
      { arm: 1.4, omega: 1.42, phase: 0.2 },
      { arm: 1.4, omega: -1.13, phase: 2.8 },
    ],
    par: 68,
  },
];

const CHAR_TERRAIN: Record<string, number> = {
  '#': WALL,
  '.': FLOOR,
  '~': ICE,
  ':': SAND,
};

/** 格子中心的世界坐标（盘面局部，x 右、z 向屏幕近端） */
export function cellCenter(col: number, row: number, size = SIZE): Vec2 {
  const half = (size - 1) / 2;
  return { x: col - half, z: row - half };
}

export function cellAt(x: number, z: number, size = SIZE): { col: number; row: number } {
  const half = (size - 1) / 2;
  return { col: Math.round(x + half), row: Math.round(z + half) };
}

export function parseLevel(def: LevelDef): Level {
  const size = def.rows.length;
  if (size !== SIZE || def.rows.some((row) => row.length !== SIZE)) {
    throw new Error(`关卡 ${def.id} 必须是 ${SIZE}×${SIZE}`);
  }
  const terrain = new Uint8Array(size * size);
  const holes: Hole[] = [];
  const checkpoints: Vec2[] = [];
  const gems: Vec2[] = [];
  const pivots: Vec2[] = [];
  let start: Vec2 | null = null;
  let goal: Hole | null = null;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const ch = def.rows[row][col];
      const center = cellCenter(col, row, size);
      terrain[row * size + col] = CHAR_TERRAIN[ch] ?? FLOOR;
      if (ch === 'O' || ch === 'G') {
        const hole: Hole = { x: center.x, z: center.z, r: HOLE_R, goal: ch === 'G' };
        holes.push(hole);
        if (hole.goal) goal = hole;
      } else if (ch === 'S') {
        start = center;
      } else if (ch === 'C') {
        checkpoints.push(center);
      } else if (ch === '*') {
        gems.push(center);
      } else if (ch === 'P') {
        pivots.push(center);
      }
    }
  }

  if (!start) throw new Error(`关卡 ${def.id} 缺少起点 S`);
  if (!goal) throw new Error(`关卡 ${def.id} 缺少终点 G`);
  if (pivots.length !== def.sweepers.length) {
    throw new Error(`关卡 ${def.id} 有 ${pivots.length} 个 P 但只配了 ${def.sweepers.length} 条摆杆`);
  }

  const sweepers: Sweeper[] = pivots.map((p, i) => ({
    x: p.x,
    z: p.z,
    arm: def.sweepers[i].arm,
    omega: def.sweepers[i].omega,
    phase: def.sweepers[i].phase,
    r: 0.13,
  }));

  return { def, size, half: (size - 1) / 2, terrain, holes, goal, start, checkpoints, gems, sweepers };
}

export const LEVELS: Level[] = LEVEL_DEFS.map(parseLevel);

export function terrainAt(level: Level, x: number, z: number): number {
  const { col, row } = cellAt(x, z, level.size);
  if (col < 0 || row < 0 || col >= level.size || row >= level.size) return WALL;
  return level.terrain[row * level.size + col];
}