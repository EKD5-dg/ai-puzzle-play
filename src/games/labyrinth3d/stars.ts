/**
 * 迷宫星级的键与取值规则（纯函数，供组件与 Node 测试共用）。
 * 本地键在 `best:` 命名空间下以便复用现有成绩同步；云端 gameId 不能带
 * `best:` 前缀（服务端 gameId 只允许一个冒号），所以两者必须分开生成。
 */

/** 云端成绩 id：`labyrinth-3d:star-l1` */
export function starId(baseId: string, levelId: string): string {
  return `${baseId}:star-${levelId}`;
}

/** localStorage 键（不含 `pp:` 前缀）：`best:labyrinth-3d:star-l1` */
export function starKey(baseId: string, levelId: string): string {
  return `best:${starId(baseId, levelId)}`;
}

/** 星级只允许 0..3；脏值/NaN/负数一律归零，避免渲染 `'☆'.repeat(-1)` 崩溃 */
export function clampStars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(3, Math.floor(value)));
}
