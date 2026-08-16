import { useCallback, useEffect, useMemo, useState } from 'react';

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
