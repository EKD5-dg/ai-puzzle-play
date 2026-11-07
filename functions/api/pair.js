// 配对码管理：POST /api/pair { code } 创建（5 分钟有效）/ { code, join: true } 加入校验
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** 配对请求体只需要一个 6 位码 + 可选 join 标志 */
const MAX_BODY = 4 * 1024;

function codeValid(code) {
  return typeof code === 'string' && /^[A-Z0-9]{6}$/.test(code);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
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
  if (!codeValid(code)) {
    return new Response(JSON.stringify({ error: 'invalid code' }), { status: 400, headers: CORS_HEADERS });
  }
  if (body.join) {
    // 加入配对：校验存在且未过期（5 分钟）
    const created = await env.SYNC_KV.get(`pair:${code}`);
    if (created === null) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: CORS_HEADERS });
    }
    if (Date.now() - Number(created) > 5 * 60 * 1000) {
      return new Response(JSON.stringify({ error: 'expired' }), { status: 410, headers: CORS_HEADERS });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS });
  }
  // 创建配对（360 秒后 KV 自动清理）
  await env.SYNC_KV.put(`pair:${code}`, String(Date.now()), { expirationTtl: 360 });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS });
}
