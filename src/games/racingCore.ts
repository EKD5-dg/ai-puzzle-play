/**
 * 3D 赛车的车流车道选择：碰撞盒宽于车道间距，三车道同时有车时玩家无法安全通过，
 * 所以生成/回收必须挑一条空道。抽成纯函数以便用 Node 测试覆盖。
 */

export const RACING_LANES = [-0.62, 0, 0.62] as const;
export const RACING_LANE_GAP = 0.62;

export interface LaneCar {
  offset: number;
  z: number;
}

export function nearestLaneIndex(offset: number): number {
  let bi = 0;
  for (let i = 1; i < RACING_LANES.length; i++) {
    if (Math.abs(RACING_LANES[i] - offset) < Math.abs(RACING_LANES[bi] - offset)) bi = i;
  }
  return bi;
}

/**
 * 返回与 z 处车辆重叠窗口内未被占用的车道下标；三条都占用时返回 null。
 * window 应不小于车辆碰撞长度（2×CAR_LEN），否则同车道生成也可能重叠。
 */
export function pickFreeLaneIndex(cars: readonly LaneCar[], z: number, exclude: LaneCar | null, window: number): number | null {
  const used = new Set<number>();
  for (const c of cars) {
    if (c === exclude) continue;
    if (Math.abs(c.z - z) > window) continue;
    used.add(nearestLaneIndex(c.offset));
  }
  const free: number[] = [];
  for (let i = 0; i < RACING_LANES.length; i++) if (!used.has(i)) free.push(i);
  if (free.length === 0) return null;
  return free[Math.floor(Math.random() * free.length)];
}

export interface FollowCar {
  offset: number;
  z: number;
  speed: number;
  cruise: number;
}

/**
 * 同车道跟车：先恢复巡航速度，再按 z 前→后把后车压到前车速度。
 * 必须按空间顺序而不是数组顺序处理，否则后车会先读到前车的巡航值并追尾穿模。
 */
export function applyCarFollowing(cars: FollowCar[], followGap: number, laneTol = 0.3): void {
  for (const c of cars) c.speed = c.cruise;
  const frontToBack = [...cars].sort((a, b) => b.z - a.z);
  for (const c of frontToBack) {
    let lead: FollowCar | null = null;
    let gap = Infinity;
    for (const o of frontToBack) {
      if (o === c || Math.abs(o.offset - c.offset) > laneTol) continue;
      const d = o.z - c.z;
      if (d > 0 && d < gap) {
        gap = d;
        lead = o;
      }
    }
    if (lead && gap < followGap) c.speed = Math.min(c.speed, lead.speed);
  }
}
