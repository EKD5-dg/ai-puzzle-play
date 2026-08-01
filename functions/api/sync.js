// PuzzlePlay 成绩云同步 API（Pages Functions + KV）
// GET  /api/sync?code=XXXXXX  → 拉取该码下全部成绩
// POST /api/sync { code, scores: { gameId: number } } → 合并写入（取最大值）
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
  return new Response(JSON.stringify({ code, scores }), { status: 200, headers: CORS_HEADERS });
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
  if (!codeValid(code) || !scores || typeof scores !== 'object') {
    return new Response(JSON.stringify({ error: 'invalid payload' }), { status: 400, headers: CORS_HEADERS });
  }
  const writes = [];
  for (const [gameId, value] of Object.entries(scores)) {
    if (typeof value !== 'number' || value <= 0) continue;
    const key = `score:${code}:${gameId}`;
    const existing = await env.SYNC_KV.get(key);
    const merged = Math.max(Number(existing || 0), value);
    writes.push(env.SYNC_KV.put(key, String(merged)));
  }
  await Promise.all(writes);
  return new Response(JSON.stringify({ ok: true, written: writes.length }), { status: 200, headers: CORS_HEADERS });
}
