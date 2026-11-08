/**
 * 台球自由球（手中球）落点规则：白球既不能压库/压球，也不能直接放进袋口
 * ——袋口捕获半径大于白球半径，落在捕获圈内下一杆必洗袋，等于白送一条命。
 * 单独成模块以便用 Node 黄金表覆盖边界。
 */

export interface CueHandBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  pocketR: number;
  ballR: number;
  pockets: ReadonlyArray<readonly [number, number]>;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 白球中心离袋心的最小安全距离：捕获半径 + 半个球半径的余量 */
export const cuePocketClearance = (pocketR: number, ballR: number) => pocketR + ballR * 0.5;

export function isCueSpotSafe(x: number, z: number, b: CueHandBounds): boolean {
  if (x < b.minX - 1e-9 || x > b.maxX + 1e-9 || z < b.minZ - 1e-9 || z > b.maxZ + 1e-9) return false;
  const clear = cuePocketClearance(b.pocketR, b.ballR);
  return b.pockets.every(([px, pz]) => Math.hypot(x - px, z - pz) >= clear - 1e-9);
}

/**
 * 把指针位置钳进可放置区，并躲开袋口捕获圈。
 * 若钳制后的点落在袋口里，沿该袋口的安全圆采样，取离目标最近的可落点。
 */
export function safeHandSpot(x: number, z: number, b: CueHandBounds): [number, number] {
  const cx = clamp(x, b.minX, b.maxX);
  const cz = clamp(z, b.minZ, b.maxZ);
  if (isCueSpotSafe(cx, cz, b)) return [cx, cz];

  const r = cuePocketClearance(b.pocketR, b.ballR) + 0.02;
  let best: [number, number] = [cx, cz];
  let bestD = Infinity;
  for (const [px, pz] of b.pockets) {
    // 只处理与当前点相交的袋口；16 向采样足以覆盖被库边裁掉的圆弧
    if (Math.hypot(cx - px, cz - pz) >= r) continue;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const nx = clamp(px + Math.cos(a) * r, b.minX, b.maxX);
      const nz = clamp(pz + Math.sin(a) * r, b.minZ, b.maxZ);
      if (!isCueSpotSafe(nx, nz, b)) continue;
      const d = Math.hypot(nx - cx, nz - cz);
      if (d < bestD) {
        bestD = d;
        best = [nx, nz];
      }
    }
  }
  if (bestD === Infinity) {
    // 圆周采样全被库边裁掉时，再做一次网格兜底（仅失败路径执行）
    const step = Math.max(0.02, Math.min(0.1, (b.maxX - b.minX) / 60, (b.maxZ - b.minZ) / 60));
    search: for (let z = b.minZ; z <= b.maxZ + 1e-9; z += step) {
      for (let x = b.minX; x <= b.maxX + 1e-9; x += step) {
        if (isCueSpotSafe(x, z, b)) {
          best = [x, z];
          break search;
        }
      }
    }
  }
  return best;
}
