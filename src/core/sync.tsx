import { useCallback, useEffect, useRef } from 'react';
import { useLocalStorage } from './useLocalStorage';
import { HIGHER_IS_BETTER } from './gameMetas';
import { setMuted as applySoundMuted } from './sound';

/**
 * 跨设备成绩云同步（Cloudflare Pages Functions + KV）
 * 用法：const best = useBestScore(meta.id) → { value, updateBest }（与 useLocalStorage 兼容）
 */
const API = 'https://puzzle-play.pages.dev/api/sync';
const PAIR_API = 'https://puzzle-play.pages.dev/api/pair';
const CODE_KEY = 'pp:sync-code';

/** 取 gameId 的基础 id（支持 `id:后缀` 形式，如扫雷按难度细分 `minesweeper:0`，方向判断只看基础 id） */
function baseGameId(gameId: string): string {
  const i = gameId.indexOf(':');
  return i >= 0 ? gameId.slice(0, i) : gameId;
}

/** 按游戏比较方向判断 next 是否优于 prev（方向表来自 gameMetas 权威定义） */
export function isBetterScore(gameId: string, next: number, prev: number): boolean {
  return HIGHER_IS_BETTER[baseGameId(gameId)] === false ? next < prev : next > prev;
}

/** 勇者斗恶龙存档（楼层 + 勇者状态），跨设备同步用 */
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

/** 云同步负载：成绩 + 进度 + 偏好 */
export interface SyncPayload {
  scores?: Record<string, number>;
  progress?: { dqSave?: DqSave | null };
  prefs?: { soundMuted?: boolean };
}

const DQ_SAVE_KEY = 'pp:dq:save';
const SOUND_MUTE_KEY = 'pp:sound-muted';
/** 读取本机勇者斗恶龙存档 */
export function readDqSave(): DqSave | null {
  try {
    const raw = localStorage.getItem(DQ_SAVE_KEY);
    return raw ? (JSON.parse(raw) as DqSave) : null;
  } catch {
    return null;
  }
}

/** 写入本机勇者斗恶龙存档 */
export function writeDqSave(save: DqSave | null): void {
  try {
    if (save) localStorage.setItem(DQ_SAVE_KEY, JSON.stringify(save));
    else localStorage.removeItem(DQ_SAVE_KEY);
  } catch {
    /* ignore */
  }
}

/** 读取本机音效开关 */
export function readSoundMuted(): boolean {
  try {
    return localStorage.getItem(SOUND_MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 写入本机音效开关（委托 sound.ts 的 setMuted：同时更新内存态，避免按钮显示与实际发声不一致） */
export function writeSoundMuted(muted: boolean): void {
  applySoundMuted(muted);
}

/** 比较两份存档优劣：楼层高者优；同层则勇者等级高者优 */
export function isBetterDqSave(a: DqSave, b: DqSave): boolean {
  if (a.floor !== b.floor) return a.floor > b.floor;
  return a.player.level > b.player.level;
}

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

/** 生成 6 位同步码（大写字母 + 数字，去易混字符；crypto 强随机，避免可预测码被枚举） */
export function generateSyncCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const rand = new Uint32Array(6);
  try {
    crypto.getRandomValues(rand);
  } catch {
    for (let i = 0; i < 6; i++) rand[i] = Math.floor(Math.random() * 0xffffffff);
  }
  for (let i = 0; i < 6; i++) code += chars[rand[i] % chars.length];
  return code;
}

async function fetchCloud(code: string): Promise<SyncPayload> {
  const res = await fetch(`${API}?code=${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error('fetch failed');
  const data = (await res.json()) as SyncPayload;
  return data;
}

/** 上传负载到云端（成绩合并方向由服务端权威白名单决定，客户端不再声明） */
async function pushCloud(code: string, payload: SyncPayload): Promise<void> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, ...payload }),
  });
  if (!res.ok) throw new Error('push failed');
}

/** 上传本机进度与偏好到云端（存档按优劣合并，偏好直接覆盖） */
export async function pushProgress(code: string): Promise<void> {
  const payload: SyncPayload = {
    progress: { dqSave: readDqSave() },
    prefs: { soundMuted: readSoundMuted() },
  };
  await pushCloud(code, payload);
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

  // 最新本地值的 ref 镜像：云端拉取回调里读取，避免切换 key（如扫雷切难度）时闭包过期
  const valueRef = useRef(local.value);
  valueRef.current = local.value;

  // 挂载时从云端拉取并合并（云端更优才覆盖本地）
  useEffect(() => {
    const code = getSyncCode();
    if (!code) return;
    let cancelled = false;
    fetchCloud(code)
      .then((cloud) => {
        if (cancelled) return;
        const cloudBest = cloud.scores?.[gameId];
        if (cloudBest == null) return;
        const localBest = valueRef.current;
        if (localBest == null || isBetterScore(gameId, cloudBest, localBest)) {
          setLocal(cloudBest);
        }
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
          pushCloud(code, { scores: { [gameId]: next } }).catch(() => {
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
