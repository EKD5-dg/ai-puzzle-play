/** 盘面地形：0 地面、1 墙、2 冰面、3 沙地 */
export const FLOOR = 0;
export const WALL = 1;
export const ICE = 2;
export const SAND = 3;
export type Terrain = typeof FLOOR | typeof WALL | typeof ICE | typeof SAND;

export interface Vec2 {
  x: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Hole {
  x: number;
  z: number;
  r: number;
  goal: boolean;
}

export interface Gem {
  x: number;
  z: number;
}

export interface Sweeper {
  x: number;
  z: number;
  /** 半臂长 */
  arm: number;
  /** 角速度 rad/s，正负决定转向 */
  omega: number;
  /** 初始角 */
  phase: number;
  /** 杆半径（胶囊粗细） */
  r: number;
}

export interface SweeperDef {
  arm: number;
  omega: number;
  phase: number;
}

export interface LevelDef {
  id: string;
  name: string;
  subtitle: string;
  rows: string[];
  /** 按图中 P 出现顺序（行优先）配置 */
  sweepers: SweeperDef[];
  /** 三星基准秒数，由自动驾驶实测校准后写回 */
  par: number;
}

export interface Level {
  def: LevelDef;
  size: number;
  half: number;
  terrain: Uint8Array;
  holes: Hole[];
  goal: Hole;
  start: Vec2;
  checkpoints: Vec2[];
  gems: Gem[];
  sweepers: Sweeper[];
}

export type RunPhase = 'rolling' | 'falling' | 'cleared' | 'over';

export interface Ball {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** 出盘面的高度，掉落时为负 */
  y: number;
  /** 累计滚动角，渲染高光用 */
  spin: number;
}

export type GameEvent =
  | { type: 'gem'; index: number }
  | { type: 'checkpoint'; index: number }
  | { type: 'bump'; speed: number }
  | { type: 'fall'; goal: boolean }
  | { type: 'cleared' }
  | { type: 'over' };

export interface RunState {
  phase: RunPhase;
  ball: Ball;
  pitch: number;
  roll: number;
  lives: number;
  elapsed: number;
  taken: boolean[];
  falls: number;
  hints: number;
  respawn: Vec2;
  checkpoint: number;
  /** 掉落动画已推进秒数 */
  fallT: number;
  fallGoal: boolean;
  fallX: number;
  fallZ: number;
  /** 重生后的短暂豁免，避免原地连续掉洞 */
  grace: number;
  sweeperAngles: number[];
  bumpLock: number;
  /** 固定子步累加器：保证积分步长与帧率无关 */
  acc: number;
  events: GameEvent[];
}

/** 归一化倾斜输入：x=+1 向右倾，z=+1 向屏幕近端倾 */
export interface TiltInput {
  x: number;
  z: number;
}

export interface Viewport {
  width: number;
  height: number;
}