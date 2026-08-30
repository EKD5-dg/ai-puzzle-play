/**
 * 触屏控件：虚拟方向键 + 动作按钮组。
 * 仅在存在触屏指针的设备（any-pointer: coarse）显示，纯桌面自动隐藏。
 */
import { useRef } from 'react';
import type { CSSProperties } from 'react';

interface DpadProps {
  onDir: (dir: 'up' | 'down' | 'left' | 'right') => void;
  /** 按钮大小（px），默认 56 */
  size?: number;
}

export function TouchDpad({ onDir, size = 56 }: DpadProps) {
  /** 最近一次 pointerdown 的方向与时刻：用于识别其后的合成 click，避免双触发 */
  const lastPointerRef = useRef<{ dir: string; at: number }>({ dir: '', at: 0 });
  const btn = (label: string, dir: 'up' | 'down' | 'left' | 'right', style: CSSProperties) => (
    <button
      className="tc-btn"
      style={{ width: size, height: size, ...style }}
      onPointerDown={(e) => {
        e.preventDefault();
        lastPointerRef.current = { dir, at: Date.now() };
        onDir(dir);
      }}
      onClick={() => {
        // pointerdown 已处理过的同一方向 click 直接跳过；键盘激活（Enter/空格）只发 click，走这里兜底
        const last = lastPointerRef.current;
        if (last.dir === dir && Date.now() - last.at < 700) return;
        onDir(dir);
      }}
      aria-label={dir}
    >
      {label}
    </button>
  );
  return (
    <div className="tc-dpad" style={{ width: size * 3, height: size * 3 }}>
      {btn('↑', 'up', { gridArea: '1 / 2' })}
      {btn('←', 'left', { gridArea: '2 / 1' })}
      {btn('↓', 'down', { gridArea: '3 / 2' })}
      {btn('→', 'right', { gridArea: '2 / 3' })}
    </div>
  );
}

interface ButtonGroupProps {
  items: Array<{ label: string; onPress: () => void; onRelease?: () => void; primary?: boolean }>;
}

export function TouchButtons({ items }: ButtonGroupProps) {
  return (
    <div className="tc-buttons">
      {items.map((it) => (
        <button
          key={it.label}
          className={`tc-btn tc-action ${it.primary ? 'primary' : ''}`}
          onPointerDown={(e) => {
            e.preventDefault();
            it.onPress();
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            it.onRelease?.();
          }}
          onPointerCancel={() => it.onRelease?.()}
          onLostPointerCapture={() => it.onRelease?.()}
          onPointerLeave={() => it.onRelease?.()}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
