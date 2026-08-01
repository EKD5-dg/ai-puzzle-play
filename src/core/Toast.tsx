import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type ToastType = 'info' | 'success' | 'record';

interface Toast {
  id: number;
  msg: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (msg: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => undefined });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Set<number>>(new Set());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    timers.current.delete(id);
  }, []);

  const toast = useCallback(
    (msg: string, type: ToastType = 'info') => {
      const id = nextId++;
      setToasts((prev) => [...prev.slice(-3), { id, msg, type }]);
      const timer = window.setTimeout(() => dismiss(id), 2600);
      timers.current.add(timer);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.type}`}
            onClick={() => dismiss(t.id)}
            role="status"
          >
            {t.type === 'record' && '🏆 '}
            {t.type === 'success' && '🎉 '}
            {t.type === 'info' && '💡 '}
            {t.msg}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
