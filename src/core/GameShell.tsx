import type { ReactNode } from 'react';
import type { GameMeta } from './types';
import { AdSlot } from './AdSlot';

interface GameShellProps {
  meta: GameMeta;
  /** 额外统计区（可选，由游戏自行渲染） */
  stats?: ReactNode;
  onBack: () => void;
  children: ReactNode;
}

/**
 * 游戏统一外壳：返回按钮、标题、描述、操作区。
 * 所有游戏共享同一布局，保证合集视觉一致性。
 */
export function GameShell({ meta, stats, onBack, children }: GameShellProps) {
  return (
    <div className="game-page">
      <header className="game-header">
        <button className="btn btn-ghost" onClick={onBack}>
          ← 返回大厅
        </button>
        <div className="game-title-row">
          <span className="game-icon" aria-hidden>
            {meta.icon}
          </span>
          <div>
            <h1>{meta.title}</h1>
            <p className="game-desc">{meta.description}</p>
          </div>
          <span className={`badge badge-${meta.difficulty}`}>{meta.difficulty}</span>
        </div>
        {stats && <div className="game-stats">{stats}</div>}
      </header>
      <main className="game-body">{children}</main>
      {/* 游戏区下方广告位（AdSense 开通后填入 slot） */}
      <AdSlot slot="0000000002" variant="rectangle" />
    </div>
  );
}
