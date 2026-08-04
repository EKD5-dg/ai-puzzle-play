// PuzzlePlay 成绩云同步 API（Pages Functions + KV）
// GET  /api/sync?code=XXXXXX  → 拉取该码下全部成绩 + 进度 + 偏好
// POST /api/sync { code, scores?, progress?, prefs?, lowerBetter? } → 合并写入（成绩取最优，存档取更优，偏好覆盖）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

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

  // 1. 成绩合并（按比较方向取最优）
  if (scores && typeof scores === 'object') {
    const lowerBetter = new Set(Array.isArray(body.lowerBetter) ? body.lowerBetter : []);
    for (const [gameId, value] of Object.entries(scores)) {
      if (typeof value !== 'number' || value <= 0) continue;
      const key = `score:${code}:${gameId}`;
      const existing = await env.SYNC_KV.get(key);
      let merged;
      if (existing === null) {
        merged = value;
      } else if (lowerBetter.has(gameId)) {
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
    let merged;
    if (incoming === null) {
      // 显式清除（通关/死亡/新开局）
      merged = null;
    } else if (!existing || !existing.dqSave) {
      merged = incoming;
    } else {
      const a = incoming;
      const b = existing.dqSave;
      merged = a.floor !== b.floor ? (a.floor > b.floor ? a : b) : (a.player.level >= b.player.level ? a : b);
    }
    if (merged) {
      writes.push(env.SYNC_KV.put(key, JSON.stringify({ dqSave: merged })));
    } else {
      writes.push(env.SYNC_KV.delete(key));
    }
  }

  // 3. 偏好直接覆盖（音效开关等轻量设置）
  if (body.prefs && typeof body.prefs === 'object') {
    writes.push(env.SYNC_KV.put(`prefs:${code}`, JSON.stringify(body.prefs)));
  }

  await Promise.all(writes);
  return new Response(JSON.stringify({ ok: true, written: writes.length }), { status: 200, headers: CORS_HEADERS });
}
