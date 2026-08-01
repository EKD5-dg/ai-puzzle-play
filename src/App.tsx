import { useEffect, useState } from 'react';
import { games, findGame } from './core/registry';
import { useLocalStorage } from './core/useLocalStorage';
import type { GameMeta } from './core/types';

/** 读取当前 hash 路由（如 #/game/game-2048） */
function routeFromHash(): string {
  const m = window.location.hash.match(/^#\/game\/([\w-]+)/);
  return m ? m[1] : '';
}

function GameCard({ meta }: { meta: GameMeta }) {
  const best = useLocalStorage<number>(`best:${meta.id}`);
  return (
    <a href={`#/game/${meta.id}`} className="game-card">
      <div className="game-card-icon">{meta.icon}</div>
      <div className="game-card-info">
        <div className="game-card-title">
          <h3>{meta.title}</h3>
          <span className={`badge badge-${meta.difficulty}`}>{meta.difficulty}</span>
        </div>
        <p className="game-card-desc">{meta.description}</p>
        <div className="game-card-meta">
          <span className="chip">{meta.category}</span>
          {meta.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
          <span className="best">
            {meta.bestScoreLabel}：{best.value ?? '--'}
          </span>
        </div>
      </div>
      <span className="game-card-play">开始 ▶</span>
    </a>
  );
}

export default function App() {
  const [currentId, setCurrentId] = useState(routeFromHash);

  useEffect(() => {
    const onHash = () => {
      setCurrentId(routeFromHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const current = findGame(currentId);
  const CurrentGame = current?.component;

  return (
    <div className="app">
      {current && CurrentGame ? (
        <CurrentGame />
      ) : (
        <div className="lobby">
          <header className="lobby-header">
            <div className="logo">
              <span className="logo-icon">🧩</span>
              <div>
                <h1>PuzzlePlay 益智乐园</h1>
                <p>六款经典益智游戏 · 一触即玩 · 成绩永久保存</p>
              </div>
            </div>
            <div className="lobby-stats">
              <span className="chip chip-lg">{games.length} 款游戏</span>
              <span className="chip chip-lg">🎮 全部免费</span>
            </div>
          </header>

          <div className="game-grid">
            {games.map((g) => (
              <GameCard key={g.meta.id} meta={g.meta} />
            ))}
          </div>

          <footer className="lobby-footer">
            <h3>🛠 开发者指南：如何新增游戏？</h3>
            <p>
              在 <code>src/games/</code> 下新建组件文件，导出 <code>meta</code> 与默认组件，
              再到 <code>src/core/registry.tsx</code> 注册一行即可，大厅、路由、成绩存档自动生效。
            </p>
          </footer>
        </div>
      )}
    </div>
  );
}
