import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GameMeta } from './types';

/** 同页签内成绩变更广播事件（云同步合并写入后触发，驱动各组件自动刷新） */
export const SCORES_UPDATED_EVENT = 'pp:scores-updated';

/** 广播成绩已变更 */
export function notifyScoresUpdated(): void {
  try {
    window.dispatchEvent(new Event(SCORES_UPDATED_EVENT));
  } catch {
    /* ignore */
  }
}

/**
 * localStorage 封装：统一的成绩持久化。
 * 所有游戏通过 useBestScore(meta.id) 读写最佳成绩。
 */
export function useLocalStorage<T extends number>(key: string, initial: T | null = null) {
  const read = useCallback((): T | null => {
    try {
      const raw = localStorage.getItem(`pp:${key}`);
      if (raw === null) return initial;
      const parsed = JSON.parse(raw) as unknown;
      // 类型校验：历史脏数据（字符串等）一律回退初始值
      if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return initial;
      return parsed as T;
    } catch {
      return initial;
    }
  }, [key, initial]);

  const [value, setValue] = useState<T | null>(read);

  // key 变化（如扫雷按难度细分记录）时重新读取；同页签广播与跨页签 storage 事件也触发刷新
  useEffect(() => {
    setValue(read());
  }, [read]);

  // 监听同页签广播与跨页签 storage 事件，外部写入后自动刷新
  useEffect(() => {
    const refresh = () => setValue(read());
    window.addEventListener(SCORES_UPDATED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(SCORES_UPDATED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [read]);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(`pp:${key}`, JSON.stringify(next));
      } catch {
        /* 忽略隐私模式等异常 */
      }
    },
    [key],
  );

  /** 更新最佳成绩：比历史更好才写入，返回是否刷新 */
  const updateBest = useCallback(
    (next: T, better: (a: T, b: T) => boolean) => {
      const current = read();
      if (current === null || better(next, current)) {
        set(next);
        return true;
      }
      return false;
    },
    [read, set],
  );

  // 返回稳定对象：value 不变时引用不变，避免消费方（useBestScore/游戏 effect）每渲染重跑
  return useMemo(() => ({ value, set, updateBest }), [value, set, updateBest]);
}

/** 读取单个成绩存储键（`best:...`，不含 pp: 前缀），非数值/非有限值视为无记录 */
export function readBestKey(storeKey: string): number | null {
  try {
    const raw = localStorage.getItem(`pp:${storeKey}`);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 某游戏的全部成绩键：基础键 + meta.bestVariants 声明的分档键 */
export function bestKeysOf(meta: GameMeta): string[] {
  const keys = [`best:${meta.id}`];
  for (const v of meta.bestVariants ?? []) keys.push(`best:${meta.id}:${v}`);
  return keys;
}

/** 跨档聚合的最佳成绩（方向按 higherIsBetter）：所有键都无记录时返回 null */
export function readBestSummary(meta: GameMeta): number | null {
  let best: number | null = null;
  for (const key of bestKeysOf(meta)) {
    const v = readBestKey(key);
    if (v === null) continue;
    if (best === null || (meta.higherIsBetter ? v > best : v < best)) best = v;
  }
  return best;
}

/** 该游戏是否有任何成绩记录（大厅"已玩"统计，需覆盖分档键） */
export function hasAnyBest(meta: GameMeta): boolean {
  return bestKeysOf(meta).some((key) => readBestKey(key) !== null);
}

/**
 * 把改造前"多档共用基础键"的旧纪录迁到第一档，避免玩家纪录凭空消失。
 * 仅在基础键有值且第一档为空时搬移，幂等。
 */
export function migrateLegacyBest(meta: GameMeta): void {
  const first = meta.bestVariants?.[0];
  if (!first) return;
  const legacy = readBestKey(`best:${meta.id}`);
  if (legacy === null) return;
  if (readBestKey(`best:${meta.id}:${first}`) !== null) return;
  try {
    localStorage.setItem(`pp:best:${meta.id}:${first}`, JSON.stringify(legacy));
    localStorage.removeItem(`pp:best:${meta.id}`);
    notifyScoresUpdated();
  } catch {
    /* 隐私模式等跳过 */
  }
}

/** 成绩展示文案：按 meta.bestUnit 换算单位（毫秒→秒），无记录显示 -- */
export function formatBest(meta: GameMeta, value: number | null): string {
  if (value === null) return '--';
  if (meta.bestUnit === 'ms') return `${(value / 1000).toFixed(1)} 秒`;
  if (meta.bestUnit === 's') return `${value} 秒`;
  return String(value);
}

/** 大厅卡片用：订阅成绩变更事件，跨档返回聚合最佳成绩（meta 是模块级常量，引用稳定） */
export function useBestSummary(meta: GameMeta): number | null {
  const [value, setValue] = useState<number | null>(() => readBestSummary(meta));
  useEffect(() => {
    const refresh = () => setValue(readBestSummary(meta));
    refresh();
    window.addEventListener(SCORES_UPDATED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(SCORES_UPDATED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [meta]);
  return value;
}
