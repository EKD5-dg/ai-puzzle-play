/**
 * 勇者斗恶龙存档的纯数据校验，供客户端/云同步共用。
 * 放在独立模块里是为了让 Node 测试能直接导入（sync.tsx 含 React，无法被纯逻辑测试加载）。
 */

export interface DqSave {
  floor: number;
  player: {
    level: number;
    xp: number;
    hp: number;
    maxHp: number;
    mp: number;
    maxMp: number;
    atk: number;
    def: number;
    gold: number;
    kills: number;
  };
}

/** 与游戏内 FLOORS 一致；服务端也按这个上限校验 */
export const DQ_MAX_FLOOR = 10;
/** 与游戏内 xpNeed(level) 一致：升到下一级所需经验 */
export const DQ_XP_PER_LEVEL = 22;
export const DQ_MAX_LEVEL = 99;

/** 存档字段兜底值（与勇者斗恶龙 PLAYER_START 一致） */
export const DQ_START: DqSave['player'] = {
  level: 1,
  xp: 0,
  hp: 60,
  maxHp: 60,
  mp: 10,
  maxMp: 10,
  atk: 8,
  def: 3,
  gold: 0,
  kills: 0,
};

/**
 * 缺字段按默认值补齐（兼容旧版存档）；出现非数字/越界值直接判为脏档。
 * 不能“越界就夹到边界”：floor 999 夹成 10 会在合并时压过真实的第 9 层，
 * xp 1e308 夹成上限也会把脏档洗成高等级存档。
 */
function readInt(v: unknown, def: number, min: number, max: number): number | null {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n < min || n > max) return null;
  return n;
}

/** 存档结构校验：合法返回清洗后的副本，脏档/越界档返回 null。 */
export function sanitizeDqSave(raw: unknown): DqSave | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { floor?: unknown; player?: unknown };
  if (!o.player || typeof o.player !== 'object') return null;
  const src = o.player as Record<string, unknown>;

  const level = readInt(src.level, DQ_START.level, 1, DQ_MAX_LEVEL);
  if (level === null) return null;
  const xpCap = Math.max(0, level * DQ_XP_PER_LEVEL - 1);
  const xp = readInt(src.xp, DQ_START.xp, 0, xpCap);
  if (xp === null) return null;

  const maxHp = readInt(src.maxHp, DQ_START.maxHp, 1, 9999);
  const maxMp = readInt(src.maxMp, DQ_START.maxMp, 0, 9999);
  const atk = readInt(src.atk, DQ_START.atk, 1, 999);
  const def = readInt(src.def, DQ_START.def, 0, 999);
  const gold = readInt(src.gold, DQ_START.gold, 0, 1_000_000);
  const kills = readInt(src.kills, DQ_START.kills, 0, 1_000_000);
  if (maxHp === null || maxMp === null || atk === null || def === null || gold === null || kills === null) {
    return null;
  }
  const hp = readInt(src.hp, maxHp, 1, maxHp);
  const mp = readInt(src.mp, maxMp, 0, maxMp);
  if (hp === null || mp === null) return null;
  const floor = readInt(o.floor, 1, 1, DQ_MAX_FLOOR);
  if (floor === null) return null;

  return {
    floor,
    player: { level, xp, hp, maxHp, mp, maxMp, atk, def, gold, kills },
  };
}

/** 比较两份存档优劣：楼层 → 等级 → 经验 → 金币；同层同级不再让"先到者"随便覆盖 */
export function isBetterDqSave(a: DqSave, b: DqSave): boolean {
  if (a.floor !== b.floor) return a.floor > b.floor;
  if (a.player.level !== b.player.level) return a.player.level > b.player.level;
  if (a.player.xp !== b.player.xp) return a.player.xp > b.player.xp;
  return a.player.gold > b.player.gold;
}
