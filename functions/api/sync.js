// PuzzlePlay 成绩云同步 API（Pages Functions + KV）
// GET  /api/sync?code=XXXXXX  → 拉取该码下全部成绩 + 进度 + 偏好
// POST /api/sync { code, scores?, progress?, prefs? } → 合并写入（成绩取最优，存档取更优，偏好覆盖）
//
// 设计说明：
// - 成绩合并方向由本文件的内置白名单决定（权威，不信任客户端声明，防止恶意降级）；
//   与 src/core/gameMetas.tsx 的 HIGHER_IS_BETTER 保持一致，新增"成绩取小"的游戏需两处同步。
// - KV 读改写非原子，并发 push 存在 lost update 风险（低流量可接受，设备再次 push 可自愈）。
// - 同步码的"5 分钟有效期"只约束配对（join），配对成功后数据访问持续有效，直到重新生成码。
// - 成绩/进度/偏好写入带一年 TTL 并在每次写入续期：活跃码不过期，弃用的码由 KV 自动回收。
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** 成绩取小的游戏白名单（步数/时间类，权威方向表；按基础 id 匹配，支持 `id:后缀` 细分键） */
const LOWER_BETTER = new Set(['minesweeper', 'memory-match', 'sliding-puzzle', 'sudoku', 'sokoban', 'rubiks-cube', 'maze-3d', 'tactics-3d']);

/**
 * 数据保留一年：每次写入都会续期，因此活跃同步码永不过期，
 * 而不再使用的码（换码、弃用）会被 KV 自动回收，不会永久堆积。
 */
const DATA_TTL = 60 * 60 * 24 * 365;
/** POST 体上限：一个同步码最多几十条成绩 + 一份存档，64KB 足够富余，挡掉超大负载 */
const MAX_BODY = 64 * 1024;
/** 单条成绩的合理上限（防误写/恶意超大数把展示与合并逻辑带偏） */
const MAX_SCORE = 1e9;
/** 每个同步码最多允许的成绩 key 数：挡住“64 条/请求 × 多次请求”把 KV 刷爆 */
const MAX_KEYS = 128;

/** 与 src/core/dqSave.ts 同一组上下界（服务端权威校验，不信任客户端） */
const DQ_MAX_FLOOR = 10;
const DQ_XP_PER_LEVEL = 22;
const DQ_MAX_LEVEL = 99;

/** 缺字段用默认值；出现非数字/越界值直接判脏（不能把 floor999 夹成 10 后压过真实进度） */
function readInt(v, def, min, max) {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n < min || n > max) return null;
  return n;
}

/**
 * 清洗勇者斗恶龙存档：缺字段按默认值补齐，越界/NaN 直接拒绝。
 * 上界是必需的：`xp: 1e308` 会让客户端升级循环近乎无限，`floor: 999` 会压过真实进度。
 */
export function sanitizeDqProgress(raw) {
  if (!raw || typeof raw !== 'object' || !raw.player || typeof raw.player !== 'object') return null;
  const src = raw.player;
  const level = readInt(src.level, 1, 1, DQ_MAX_LEVEL);
  const xpCap = level === null ? 0 : Math.max(0, level * DQ_XP_PER_LEVEL - 1);
  const maxHp = readInt(src.maxHp, 60, 1, 9999);
  const maxMp = readInt(src.maxMp, 10, 0, 9999);
  const xp = readInt(src.xp, 0, 0, xpCap);
  const hp = maxHp === null ? null : readInt(src.hp, maxHp, 1, maxHp);
  const mp = maxMp === null ? null : readInt(src.mp, maxMp, 0, maxMp);
  const atk = readInt(src.atk, 8, 1, 999);
  const def = readInt(src.def, 3, 0, 999);
  const gold = readInt(src.gold, 0, 0, 1_000_000);
  const kills = readInt(src.kills, 0, 0, 1_000_000);
  const floor = readInt(raw.floor, 1, 1, DQ_MAX_FLOOR);
  if ([level, xp, maxHp, maxMp, hp, mp, atk, def, gold, kills, floor].includes(null)) return null;
  return {
    floor,
    player: { level, xp, hp, maxHp, mp, maxMp, atk, def, gold, kills },
  };
}

function isLowerBetter(gameId) {
  return LOWER_BETTER.has(gameId.split(':')[0]);
}

/** 成绩值必须是有限的正数 */
function scoreValue(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_SCORE ? v : null;
}

/** gameId 白名单格式（防 KV key 注入，允许 `id:后缀` 细分键） */
const GAME_ID_RE = /^[a-z0-9-]{1,40}(:[a-z0-9-]{1,20})?$/;

function codeValid(code) {
  return typeof code === 'string' && /^[A-Z0-9]{6}$/.test(code);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').toUpperCase();
  if (!codeValid(code)) {
    return new Response(JSON.stringify({ error: 'invalid code' }), { status: 400, headers: CORS_HEADERS });
  }
  const scores = {};
  const list = await env.SYNC_KV.list({ prefix: `score:${code}:` });
  // 并行读：一个码下的键数量很小（每游戏至多几条分档键），但仍不该串行等 N 次 KV
  const values = await Promise.all(list.keys.map((k) => env.SYNC_KV.get(k.name)));
  const prefix = `score:${code}:`;
  list.keys.forEach((k, i) => {
    // 0/非有限值一律不外传：客户端按方向合并时，"0" 对取小的成绩是必胜值，会把本地真纪录冲掉
    if (values[i] === null) return;
    const v = Number(values[i]);
    if (Number.isFinite(v) && v > 0) scores[k.name.slice(prefix.length)] = v;
  });
  // 进度与偏好
  const progressRaw = await env.SYNC_KV.get(`progress:${code}`);
  const prefsRaw = await env.SYNC_KV.get(`prefs:${code}`);
  let progress;
  let prefs;
  try {
    progress = progressRaw ? JSON.parse(progressRaw) : undefined;
  } catch { /* ignore */ }
  try {
    prefs = prefsRaw ? JSON.parse(prefsRaw) : undefined;
  } catch { /* ignore */ }
  return new Response(JSON.stringify({ code, scores, progress, prefs }), { status: 200, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    // 先看 Content-Length，避免把超大请求体完整读入内存；没有该头再按实际文本长度兜底
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_BODY) {
      return new Response(JSON.stringify({ error: 'payload too large' }), { status: 413, headers: CORS_HEADERS });
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY) {
      return new Response(JSON.stringify({ error: 'payload too large' }), { status: 413, headers: CORS_HEADERS });
    }
    body = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: CORS_HEADERS });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return new Response(JSON.stringify({ error: 'invalid payload' }), { status: 400, headers: CORS_HEADERS });
  }
  const code = String(body.code || '').toUpperCase();
  const scores = body.scores;
  if (!codeValid(code)) {
    return new Response(JSON.stringify({ error: 'invalid payload' }), { status: 400, headers: CORS_HEADERS });
  }
  const writes = [];

  // 1. 成绩合并（按权威方向表取最优；gameId 白名单防 KV key 注入，未知游戏默认取大）
  if (scores && typeof scores === 'object' && !Array.isArray(scores)) {
    const entries = Object.entries(scores);
    // 37 款游戏 + 全部分档 + 迷宫 8 颗星约 66 条，上限与 MAX_KEYS 对齐，避免全量上传被整批拒绝
    if (entries.length > MAX_KEYS) {
      return new Response(JSON.stringify({ error: 'too many scores' }), { status: 400, headers: CORS_HEADERS });
    }
    const valid = entries.filter(([gameId, raw]) => scoreValue(raw) !== null && GAME_ID_RE.test(gameId));
    // 每码 key 上限：先看已有 key 集合，避免分多次请求无限堆积
    const existingKeys = await env.SYNC_KV.list({ prefix: `score:${code}:`, limit: MAX_KEYS + 1 });
    const allKeys = new Set(existingKeys.keys.map((k) => k.name));
    for (const [gameId] of valid) allKeys.add(`score:${code}:${gameId}`);
    if (allKeys.size > MAX_KEYS) {
      return new Response(JSON.stringify({ error: 'too many keys for this code' }), { status: 413, headers: CORS_HEADERS });
    }
    for (const [gameId, raw] of valid) {
      let value = scoreValue(raw);
      // 迷宫星级合法范围是 0..3；夹住越界值，避免脏云端值让客户端渲染崩溃
      if (/:star-/.test(gameId)) value = Math.min(3, value);
      const key = `score:${code}:${gameId}`;
      const existing = await env.SYNC_KV.get(key);
      const prev = existing === null ? null : Number(existing);
      let merged;
      if (prev === null || !Number.isFinite(prev) || prev <= 0) {
        merged = value;
      } else if (isLowerBetter(gameId)) {
        merged = Math.min(prev, value);
      } else {
        merged = Math.max(prev, value);
      }
      writes.push(env.SYNC_KV.put(key, String(merged), { expirationTtl: DATA_TTL }));
    }
  }

  // 2. 进度合并：勇者斗恶龙存档按优劣（楼层高者优，同层等级高者优）
  if (body.progress && typeof body.progress === 'object' && 'dqSave' in body.progress) {
    const incoming = body.progress.dqSave;
    const key = `progress:${code}`;
    const existingRaw = await env.SYNC_KV.get(key);
    let existing = null;
    try {
      existing = existingRaw ? JSON.parse(existingRaw) : null;
    } catch { /* ignore */ }
    if (incoming !== null) {
      // 结构校验 + 上下界夹取：脏存档不能让整次上传失败，也不能把 1e308/floor999 落库
      const cleaned = sanitizeDqProgress(incoming);
      if (cleaned) {
        let merged;
        if (!existing || !existing.dqSave) {
          merged = cleaned;
        } else {
          const b = sanitizeDqProgress(existing.dqSave);
          const a = cleaned;
          merged = !b
            ? a
            : a.floor !== b.floor
              ? (a.floor > b.floor ? a : b)
              : a.player.level !== b.player.level
                ? (a.player.level > b.player.level ? a : b)
                : a.player.xp !== b.player.xp
                  ? (a.player.xp > b.player.xp ? a : b)
                  : (a.player.gold > b.player.gold ? a : b);
        }
        writes.push(env.SYNC_KV.put(key, JSON.stringify({ dqSave: merged }), { expirationTtl: DATA_TTL }));
      }
    }
    // incoming === null：视为"该设备无存档"，不删除云端已有存档，
    // 避免未玩过的设备/新开局的设备抹掉共享进度（显式清空由更优存档合并自然覆盖）
  }

  // 3. 偏好直接覆盖（音效开关等轻量设置）：只认白名单字段，避免公开写接口把任意大对象塞进 KV
  if (body.prefs && typeof body.prefs === 'object' && !Array.isArray(body.prefs)) {
    const prefs = { soundMuted: body.prefs.soundMuted === true };
    writes.push(env.SYNC_KV.put(`prefs:${code}`, JSON.stringify(prefs), { expirationTtl: DATA_TTL }));
  }

  await Promise.all(writes);
  return new Response(JSON.stringify({ ok: true, written: writes.length }), { status: 200, headers: CORS_HEADERS });
}
