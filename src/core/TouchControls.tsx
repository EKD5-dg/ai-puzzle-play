/**
 * 触屏控件：虚拟方向键 + 动作按钮组。
 * 仅在触屏设备（pointer: coarse）显示，桌面自动隐藏。
 */
import type { CSSProperties } from 'react';

interface DpadProps {
  onDir: (dir: 'up' | 'down' | 'left' | 'right') => void;
  /** 按钮大小（px），默认 56 */
  size?: number;
}

export function TouchDpad({ onDir, size = 56 }: DpadProps) {
  const btn = (label: string, dir: 'up' | 'down' | 'left' | 'right', style: CSSProperties) => (
    <button
      className="tc-btn"
      style={{ width: size, height: size, ...style }}
      onPointerDown={(e) => {
        e.preventDefault();
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
