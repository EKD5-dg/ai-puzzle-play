import { useCallback, useEffect } from 'react';
import { useLocalStorage } from './useLocalStorage';

/**
 * 跨设备成绩云同步（Cloudflare Pages Functions + KV）
 * 用法：const best = useBestScore(meta.id) → { value, updateBest }（与 useLocalStorage 兼容）
 */
const API = 'https://puzzle-play.pages.dev/api/sync';
const PAIR_API = 'https://puzzle-play.pages.dev/api/pair';
const CODE_KEY = 'pp:sync-code';

export function getSyncCode(): string | null {
  try {
    return localStorage.getItem(CODE_KEY);
  } catch {
    return null;
  }
}

export function setSyncCode(code: string | null): void {
  try {
    if (code) localStorage.setItem(CODE_KEY, code);
    else localStorage.removeItem(CODE_KEY);
  } catch {
    /* ignore */
  }
}

/** 生成 6 位同步码（大写字母 + 数字，去易混字符） */
export function generateSyncCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function fetchCloud(code: string): Promise<Record<string, number>> {
  const res = await fetch(`${API}?code=${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error('fetch failed');
  const data = (await res.json()) as { scores?: Record<string, number> };
  return data.scores ?? {};
}

async function pushCloud(code: string, scores: Record<string, number>): Promise<void> {
  await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, scores }),
  });
}

/** 创建配对码（云端记录创建时间，5 分钟有效） */
export async function createPair(code: string): Promise<boolean> {
  try {
    const res = await fetch(PAIR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 加入配对（校验 5 分钟有效期） */
export async function joinPair(code: string): Promise<'ok' | 'expired' | 'invalid' | 'error'> {
  try {
    const res = await fetch(PAIR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, join: true }),
    });
    if (res.status === 410) return 'expired';
    if (res.status === 404) return 'invalid';
    return res.ok ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

/** 成绩 hook：本地优先 + 云端合并（拉取取最大，写入双写） */
export function useBestScore(gameId: string) {
  const local = useLocalStorage<number>(`best:${gameId}`);

  const setLocal = (v: number) => {
    local.set(v);
  };

  // 挂载时从云端拉取并合并（云端更大则覆盖本地）
  useEffect(() => {
    const code = getSyncCode();
    if (!code) return;
    let cancelled = false;
    fetchCloud(code)
      .then((cloud) => {
        if (cancelled) return;
        const cloudBest = cloud[gameId];
        if (cloudBest == null) return;
        setLocal(cloudBest);
      })
      .catch(() => {
        /* 离线时静默 */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  const updateBest = useCallback(
    (next: number, better: (a: number, b: number) => boolean) => {
      const isNew = local.updateBest(next, better);
      if (isNew) {
        const code = getSyncCode();
        if (code) {
          pushCloud(code, { [gameId]: next }).catch(() => {
            /* 云端失败不影响本地 */
          });
        }
      }
      return isNew;
    },
    [local, gameId],
  );

  return { value: local.value, set: setLocal, updateBest };
}
