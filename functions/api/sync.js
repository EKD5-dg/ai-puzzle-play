// PuzzlePlay 成绩云同步 API（Pages Functions + KV）
// GET  /api/sync?code=XXXXXX  → 拉取该码下全部成绩 + 进度 + 偏好
// POST /api/sync { code, scores?, progress?, prefs? } → 合并写入（成绩取最优，存档取更优，偏好覆盖）
//
// 设计说明：
// - 成绩合并方向由本文件的内置白名单决定（权威，不信任客户端声明，防止恶意降级）；
//   与 src/core/gameMetas.tsx 的 HIGHER_IS_BETTER 保持一致，新增"成绩取小"的游戏需两处同步。
// - KV 读改写非原子，并发 push 存在 lost update 风险（低流量可接受，设备再次 push 可自愈）。
// - 同步码的"5 分钟有效期"只约束配对（join），配对成功后数据访问持续有效，直到重新生成码。
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

/** 成绩取小的游戏白名单（步数/时间类，权威方向表；按基础 id 匹配，支持 `id:后缀` 细分键） */
const LOWER_BETTER = new Set(['minesweeper', 'memory-match', 'sliding-puzzle', 'sudoku', 'sokoban', 'rubiks-cube']);

function isLowerBetter(gameId) {
  return LOWER_BETTER.has(gameId.split(':')[0]);
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
  for (const key of list.keys) {
    const gameId = key.name.slice(`score:${code}:`.length);
    const value = await env.SYNC_KV.get(key.name);
    if (value !== null) scores[gameId] = Number(value);
  }
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
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: CORS_HEADERS });
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
    if (entries.length > 64) {
      return new Response(JSON.stringify({ error: 'too many scores' }), { status: 400, headers: CORS_HEADERS });
    }
    for (const [gameId, value] of entries) {
      if (typeof value !== 'number' || value <= 0 || !GAME_ID_RE.test(gameId)) continue;
      const key = `score:${code}:${gameId}`;
      const existing = await env.SYNC_KV.get(key);
      let merged;
      if (existing === null) {
        merged = value;
      } else if (isLowerBetter(gameId)) {
        merged = Math.min(Number(existing), value);
      } else {
        merged = Math.max(Number(existing), value);
      }
      writes.push(env.SYNC_KV.put(key, String(merged)));
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
      let merged;
      if (!existing || !existing.dqSave) {
        merged = incoming;
      } else {
        const a = incoming;
        const b = existing.dqSave;
        merged = a.floor !== b.floor ? (a.floor > b.floor ? a : b) : (a.player.level >= b.player.level ? a : b);
      }
      writes.push(env.SYNC_KV.put(key, JSON.stringify({ dqSave: merged })));
    }
    // incoming === null：视为"该设备无存档"，不删除云端已有存档，
    // 避免未玩过的设备/新开局的设备抹掉共享进度（显式清空由更优存档合并自然覆盖）
  }

  // 3. 偏好直接覆盖（音效开关等轻量设置）
  if (body.prefs && typeof body.prefs === 'object') {
    writes.push(env.SYNC_KV.put(`prefs:${code}`, JSON.stringify(body.prefs)));
  }

  await Promise.all(writes);
  return new Response(JSON.stringify({ ok: true, written: writes.length }), { status: 200, headers: CORS_HEADERS });
}
