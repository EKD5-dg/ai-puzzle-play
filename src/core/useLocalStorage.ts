import { useCallback, useState } from 'react';

/**
 * localStorage 封装：统一的成绩持久化。
 * 所有游戏通过 useBestScore(meta.id) 读写最佳成绩。
 */
export function useLocalStorage<T extends number>(key: string, initial: T | null = null) {
  const read = useCallback((): T | null => {
    try {
      const raw = localStorage.getItem(`pp:${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  }, [key, initial]);

  const [value, setValue] = useState<T | null>(read);

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

  return { value, set, updateBest };
}
