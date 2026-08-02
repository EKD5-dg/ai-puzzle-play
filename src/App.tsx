import { Suspense, useEffect, useMemo, useState } from 'react';
import { games, findGame } from './core/registry';
import { useLocalStorage } from './core/useLocalStorage';
import { isMuted, setMuted, sfx } from './core/sound';
import { getSyncCode, setSyncCode, generateSyncCode, createPair, joinPair } from './core/sync';
import type { GameMeta } from './core/types';

/** 读取当前 hash 路由（如 #/game/game-2048） */
function routeFromHash(): string {
  const m = window.location.hash.match(/^#\/game\/([\w-]+)/);
  return m ? m[1] : '';
}

const CATEGORIES = ['全部', '逻辑', '记忆', '策略', '反应', '经典'] as const;
const DIFFICULTIES = ['全部', '简单', '中等', '困难'] as const;

function GameCard({ meta }: { meta: GameMeta }) {
  const best = useLocalStorage<number>(`best:${meta.id}`);
  const played = best.value !== null;
  return (
    <a href={`#/game/${meta.id}`} className="game-card">
      <div className="game-card-icon" aria-hidden>
        {meta.icon}
      </div>
      <div className="game-card-info">
        <div className="game-card-title">
          <h3>{meta.title}</h3>
          <span className={`badge badge-${meta.difficulty}`}>{meta.difficulty}</span>
          {played && <span className="played-dot" title="已游玩">✔</span>}
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
      <span className="game-card-play">{played ? '继续 ▶' : '开始 ▶'}</span>
    </a>
  );
}

export default function App() {
  const [currentId, setCurrentId] = useState(routeFromHash);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('全部');
  const [difficulty, setDifficulty] = useState<(typeof DIFFICULTIES)[number]>('全部');
  const [soundOn, setSoundOn] = useState(!isMuted());
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncCode, setSyncCodeState] = useState(getSyncCode());
  const [syncInput, setSyncInput] = useState('');
  const [syncMsg, setSyncMsg] = useState('');

  useEffect(() => {
    const onHash = () => {
      setCurrentId(routeFromHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 大厅统计：已游玩 / 已通关（有最佳成绩）
  const stats = useMemo(() => {
    let played = 0;
    let cleared = 0;
    for (const g of games) {
      try {
        const v = localStorage.getItem(`pp:best:${g.meta.id}`);
        if (v !== null) {
          played++;
          cleared++;
        }
      } catch {
        /* ignore */
      }
    }
    return { played, cleared };
  }, [currentId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return games.filter((g) => {
      if (category !== '全部' && g.meta.category !== category) return false;
      if (difficulty !== '全部' && g.meta.difficulty !== difficulty) return false;
      if (q && !`${g.meta.title}${g.meta.description}${g.meta.tags.join('')}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [query, category, difficulty]);

  const current = findGame(currentId);
  const CurrentGame = current?.component;

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    setMuted(!next);
    if (next) sfx.click();
  };

  const joinSync = async () => {
    const code = syncInput.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      setSyncMsg('请输入 6 位同步码（大写字母/数字）');
      return;
    }
    // 校验配对码有效性（5 分钟有效期）
    const pair = await joinPair(code);
    if (pair === 'expired') {
      setSyncMsg('⚠️ 同步码已过期（生成后 5 分钟内有效），请让对方重新生成');
      return;
    }
    if (pair === 'invalid') {
      setSyncMsg('⚠️ 同步码不存在，请确认对方已生成同步码');
      return;
    }
    if (pair === 'error') {
      setSyncMsg('连接云端失败（离线？），请稍后重试');
      return;
    }
    setSyncCode(code);
    setSyncCodeState(code);
    setSyncInput('');
    setSyncMsg(`已加入同步码 ${code}，正在拉取云端成绩…`);
    sfx.merge();
    // 拉取并合并全部游戏成绩到本地
    try {
      const res = await fetch(`https://puzzle-play.pages.dev/api/sync?code=${encodeURIComponent(code)}`);
      const data = (await res.json()) as { scores?: Record<string, number> };
      const cloud = data.scores ?? {};
      let merged = 0;
      for (const g of games) {
        const cv = cloud[g.meta.id];
        if (cv == null) continue;
        const lv = Number(localStorage.getItem(`pp:best:${g.meta.id}`));
        if (Number.isNaN(lv) || cv > lv) {
          localStorage.setItem(`pp:best:${g.meta.id}`, String(cv));
          merged++;
        }
      }
      setSyncMsg(merged > 0 ? `同步完成！合并了 ${merged} 条云端成绩` : '已连接，云端与本地一致');
    } catch {
      setSyncMsg('连接云端失败（离线？），稍后自动重试');
    }
  };

  const newSyncCode = async () => {
    const code = generateSyncCode();
    // 云端登记配对（5 分钟有效）
    const created = await createPair(code);
    if (!created) {
      setSyncMsg('⚠️ 需要联网生成同步码，请检查网络后重试');
      return;
    }
    setSyncCode(code);
    setSyncCodeState(code);
    setSyncMsg(`已生成同步码 ${code}（5 分钟内有效），在另一台设备输入即可同步`);
    sfx.record();
  };

  const disconnectSync = () => {
    setSyncCode(null);
    setSyncCodeState(null);
    setSyncMsg('已断开云同步');
  };

  /** 重新生成同步码：自动把旧码云端成绩 + 本地成绩迁移到新码 */
  const regenerateSync = async () => {
    const oldCode = syncCode;
    const newCode = generateSyncCode();
    const created = await createPair(newCode);
    if (!created) {
      setSyncMsg('⚠️ 需要联网生成同步码，请检查网络后重试');
      return;
    }
    // 1. 拉取旧码云端成绩
    const merged: Record<string, number> = {};
    try {
      const res = await fetch(`https://puzzle-play.pages.dev/api/sync?code=${encodeURIComponent(oldCode ?? '')}`);
      const data = (await res.json()) as { scores?: Record<string, number> };
      Object.assign(merged, data.scores ?? {});
    } catch {
      /* 旧码云端不可达则跳过 */
    }
    // 2. 合并本地成绩
    for (const g of games) {
      const lv = Number(localStorage.getItem(`pp:best:${g.meta.id}`));
      if (!Number.isNaN(lv) && lv > 0) merged[g.meta.id] = Math.max(merged[g.meta.id] ?? 0, lv);
    }
    // 3. 写入新码
    try {
      await fetch('https://puzzle-play.pages.dev/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: newCode, scores: merged }),
      });
    } catch {
      /* ignore */
    }
    setSyncCode(newCode);
    setSyncCodeState(newCode);
    setSyncMsg(`已生成新同步码 ${newCode}（5 分钟内有效），旧码成绩已迁移`);
    sfx.record();
  };

  return (
    <div className="app">
      <div className="bg-decor" aria-hidden>
        <span className="blob blob-1" />
        <span className="blob blob-2" />
        <span className="blob blob-3" />
      </div>
      {current && CurrentGame ? (
        <Suspense fallback={<div className="game-loading">⏳ 加载中…</div>}>
          <CurrentGame />
        </Suspense>
      ) : (
        <div className="lobby">
          <header className="lobby-header">
            <div className="logo">
              <span className="logo-icon" aria-hidden>
                🧩
              </span>
              <div>
                <h1>PuzzlePlay 益智乐园</h1>
                <p>十五款经典益智游戏 · 一触即玩 · 成绩永久保存</p>
              </div>
            </div>
            <div className="lobby-stats">
              <span className="chip chip-lg">
                🎮 {games.length} 款游戏 · 已玩 {stats.played} · 通关 {stats.cleared}
              </span>
              <button
                className={`btn sound-toggle ${syncCode ? 'on' : ''}`}
                onClick={() => setSyncOpen(true)}
                title={syncCode ? `云同步中（${syncCode}）` : '云同步'}
                aria-label="云同步设置"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.5 1.5A4 4 0 0 0 6 19h11.5z" />
                  <path d="M12 12v4" />
                  <path d="m9 14 3-3 3 3" />
                </svg>
              </button>
              <button
                className={`btn sound-toggle ${soundOn ? 'on' : ''}`}
                onClick={toggleSound}
                title={soundOn ? '关闭音效' : '开启音效'}
                aria-label={soundOn ? '关闭音效' : '开启音效'}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  {soundOn ? (
                    <>
                      <path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor" stroke="none" />
                      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
                    </>
                  ) : (
                    <>
                      <path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor" stroke="none" />
                      <path d="M16 9l6 6" />
                      <path d="M22 9l-6 6" />
                    </>
                  )}
                </svg>
              </button>
            </div>
          </header>

          <div className="lobby-toolbar">
            <div className="search-box">
              <span aria-hidden>🔍</span>
              <input
                type="search"
                placeholder="搜索游戏…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="filter-row">
              <div className="filter-group">
                <span className="filter-label">分类</span>
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    className={`filter-chip ${category === c ? 'active' : ''}`}
                    onClick={() => setCategory(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <div className="filter-group">
                <span className="filter-label">难度</span>
                {DIFFICULTIES.map((d) => (
                  <button
                    key={d}
                    className={`filter-chip ${difficulty === d ? 'active' : ''}`}
                    onClick={() => setDifficulty(d)}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state">
              <span aria-hidden>🔍</span>
              <p>没有找到匹配的游戏，换个关键词试试？</p>
            </div>
          ) : (
            <div className="game-grid">
              {filtered.map((g) => (
                <GameCard key={g.meta.id} meta={g.meta} />
              ))}
            </div>
          )}

          {syncOpen && (
            <div className="sync-modal-mask" onClick={() => setSyncOpen(false)}>
              <div className="sync-modal" onClick={(e) => e.stopPropagation()}>
                <h3>☁ 成绩云同步</h3>
                <p className="sync-desc">同步码连接您的所有设备，成绩自动合并（取最高）。</p>
                {syncCode ? (
                  <div className="sync-current">
                    <span>当前同步码</span>
                    <strong>{syncCode}</strong>
                    <button className="btn btn-ghost" onClick={regenerateSync}>
                      🔄 重新生成
                    </button>
                    <button className="btn btn-ghost" onClick={disconnectSync}>
                      断开
                    </button>
                  </div>
                ) : (
                  <div className="sync-join">
                    <input
                      value={syncInput}
                      onChange={(e) => setSyncInput(e.target.value.toUpperCase())}
                      placeholder="输入 6 位同步码"
                      maxLength={6}
                    />
                    <button className="btn btn-primary" onClick={joinSync}>
                      加入同步
                    </button>
                  </div>
                )}
                {!syncCode && (
                  <button className="btn btn-ghost sync-new" onClick={newSyncCode}>
                    ✨ 生成新同步码（在另一台设备输入）
                  </button>
                )}
                {syncMsg && <p className="sync-msg">{syncMsg}</p>}
              </div>
            </div>
          )}

          <footer className="lobby-footer">
            <details className="dev-guide">
              <summary>🛠 开发者指南：如何新增游戏？</summary>
              <p>
                在 <code>src/games/</code> 下新建组件文件，导出 <code>meta</code> 与默认组件，
                再到 <code>src/core/registry.tsx</code> 注册一行即可，大厅、路由、成绩存档自动生效。
              </p>
            </details>
          </footer>
        </div>
      )}
    </div>
  );
}
