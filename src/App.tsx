import { Suspense, memo, useEffect, useMemo, useState } from 'react';
import { games, findGame } from './core/registry';
import { useBestSummary, hasAnyBest, formatBest, readBestKey, notifyScoresUpdated } from './core/useLocalStorage';
import { isMuted, setMuted, sfx } from './core/sound';
import { getSyncCode, setSyncCode, generateSyncCode, createPair, joinPair, isBetterScore, readDqSave, writeDqSave, isBetterDqSave, readSoundMuted, writeSoundMuted, sanitizeDqSave, fetchCloud, pushCloud } from './core/sync';
import type { DqSave } from './core/sync';
import type { GameMeta } from './core/types';
import { DonateWidget } from './core/DonateWidget';
import { AdSlot } from './core/AdSlot';

/** 读取当前 hash 路由（如 #/game/game-2048） */
function routeFromHash(): string {
  const m = window.location.hash.match(/^#\/game\/([\w-]+)/);
  return m ? m[1] : '';
}

const CATEGORIES = ['全部', '逻辑', '记忆', '策略', '反应', '经典'] as const;
const DIFFICULTIES = ['全部', '简单', '中等', '困难'] as const;

/** 大厅展示分组（分类 + 3D 专区），顺序即首页展示顺序 */
const LOBBY_GROUPS = [
  { key: '逻辑', label: '逻辑', icon: '🧩' },
  { key: '记忆', label: '记忆', icon: '🧠' },
  { key: '策略', label: '策略', icon: '♟️' },
  { key: '反应', label: '反应', icon: '⚡' },
  { key: '经典', label: '经典', icon: '👾' },
  { key: '3d', label: '3D 专区', icon: '🧊' },
] as const;

type LobbyGroupKey = (typeof LOBBY_GROUPS)[number]['key'];
const COLLAPSE_KEY = 'pp:lobby-collapsed';

/** 已改为分档记录（meta.bestVariants）的游戏：旧基础键是跨档混出来的脏值，不再上传云端 */
const VARIANT_BASE_IDS = new Set(
  games.filter((g) => g.meta.bestVariants).map((g) => g.meta.id),
);

/** 标题或 id 含 3D 的归入「3D 专区」，其余按 meta.category */
function lobbyGroupKey(meta: GameMeta): LobbyGroupKey {
  if (meta.title.includes('3D') || /3d/i.test(meta.id)) return '3d';
  return meta.category as LobbyGroupKey;
}

function readCollapsedMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (!raw) return { '3d': true };
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
  } catch {
    /* ignore */
  }
  return { '3d': true };
}

/** 游戏卡片：memo 化避免输入搜索词/切筛选时几十张卡片全量重渲染 */
const GameCard = memo(function GameCard({ meta }: { meta: GameMeta }) {
  // 分档成绩（难度/关卡各自存键）在此按 higherIsBetter 聚合，无需每游戏特例
  const bestValue = useBestSummary(meta);
  const played = bestValue !== null;
  return (
    <a href={`#/game/${meta.id}`} className="game-card">
      <div className="game-card-icon" aria-hidden>
        {meta.icon}
      </div>
      <div className="game-card-info">
        <div className="game-card-title">
          <h3>{meta.title}</h3>
          <span className={`badge badge-${meta.difficulty}`}>{meta.difficulty}</span>
          {played && <span className="played-dot" aria-hidden title="已游玩">✔</span>}
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
            {meta.bestScoreLabel}：{formatBest(meta, bestValue)}
          </span>
          <span className="game-card-play">{played ? '继续 ▶' : '开始 ▶'}</span>
        </div>
      </div>
    </a>
  );
});

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
  const [syncErr, setSyncErr] = useState(false);
  /** 同步完成后递增，强制游戏卡片重新读取 localStorage 中的成绩 */
  const [syncVersion, setSyncVersion] = useState(0);
  /** 大厅分组折叠态：key=分组 id，true=已折叠；默认折叠 3D 专区 */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsedMap);

  /** 统一设置提示消息（err=true 时红色展示） */
  const showSyncMsg = (text: string, err = false) => {
    setSyncMsg(text);
    setSyncErr(err);
  };

  useEffect(() => {
    const onHash = () => {
      setCurrentId(routeFromHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 大厅统计：已游玩 = 有过成绩记录的游戏数（含分档键；无"通关"这一独立概念，故不再单列）
  const stats = useMemo(() => {
    let played = 0;
    for (const g of games) if (hasAnyBest(g.meta)) played++;
    return { played };
  }, [currentId, syncVersion]);

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

  /** 「全部」分类时按分组区块展示（3D 独立成区）；选定具体分类时保持扁平网格 */
  const grouped = useMemo(() => {
    if (category !== '全部') return null;
    const buckets = new Map<LobbyGroupKey, GameMeta[]>();
    for (const g of filtered) {
      const key = lobbyGroupKey(g.meta);
      const list = buckets.get(key);
      if (list) list.push(g.meta);
      else buckets.set(key, [g.meta]);
    }
    return LOBBY_GROUPS.map((group) => ({
      ...group,
      games: buckets.get(group.key) ?? [],
    })).filter((g) => g.games.length > 0);
  }, [filtered, category]);

  const persistCollapsed = (next: Record<string, boolean>) => {
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const toggleGroup = (key: string) => {
    persistCollapsed({ ...collapsed, [key]: !collapsed[key] });
  };

  const setAllGroups = (fold: boolean) => {
    if (!grouped) return;
    const next: Record<string, boolean> = {};
    for (const g of grouped) next[g.key] = fold;
    persistCollapsed(next);
  };

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
      showSyncMsg('请输入 6 位同步码（大写字母/数字）', true);
      return;
    }
    // 校验配对码有效性（5 分钟有效期）
    const pair = await joinPair(code);
    if (pair === 'expired') {
      showSyncMsg('⚠️ 同步码已过期（生成后 5 分钟内有效），请让对方重新生成', true);
      return;
    }
    if (pair === 'invalid') {
      showSyncMsg('⚠️ 同步码不存在，请确认对方已生成同步码', true);
      return;
    }
    if (pair === 'error') {
      showSyncMsg('连接云端失败（离线？），请稍后重试', true);
      return;
    }
    setSyncCode(code);
    setSyncCodeState(code);
    setSyncInput('');
    showSyncMsg(`已加入同步码 ${code}，正在拉取云端数据…`);
    sfx.merge();
    // 拉取并合并云端成绩 + 进度 + 偏好到本地
    try {
      const data = await fetchCloud(code);
      const cloud = data.scores ?? {};
      let merged = 0;
      // 遍历云端所有成绩键（支持 `id:后缀` 细分键，如扫雷按难度），按各游戏比较方向合并
      for (const [cid, cv] of Object.entries(cloud)) {
        // 云端值必须是有意义的正数：0 对"取小"的成绩是必胜值，会把本地真纪录冲掉
        if (typeof cv !== 'number' || !Number.isFinite(cv) || cv <= 0) continue;
        // 与存储层同源的解析（值是 JSON 序列化的）：Number() 会把脏值当成 0，导致云端小值覆盖本地好成绩
        const lv = readBestKey(`best:${cid}`);
        if (lv === null || isBetterScore(cid, cv, lv)) {
          try {
            localStorage.setItem(`pp:best:${cid}`, JSON.stringify(cv));
            merged++;
          } catch {
            /* 配额满等忽略该条 */
          }
        }
      }
      // 进度合并：勇者斗恶龙存档取更优（先清洗，缺字段的脏存档不能让 isBetterDqSave 读崩）
      let progressMsg = '';
      const cloudSave = sanitizeDqSave(data.progress?.dqSave ?? null);
      const localSave = readDqSave();
      if (cloudSave && (!localSave || isBetterDqSave(cloudSave, localSave))) {
        writeDqSave(cloudSave);
        progressMsg = `，勇者斗恶龙进度已同步（第 ${cloudSave.floor} 层）`;
      }
      // 偏好合并：音效开关跟随云端
      if (typeof data.prefs?.soundMuted === 'boolean') {
        writeSoundMuted(data.prefs.soundMuted);
        setSoundOn(!data.prefs.soundMuted);
      }
      // 回传本机更优成绩到云端（服务端按权威方向表合并，幂等安全），保证第三台设备加入时拿到最新数据
      pushLocalScores(code).catch(() => {
        /* 离线静默：新纪录会自动补传 */
      });
      showSyncMsg(
        merged > 0 || progressMsg
          ? `同步完成！合并了 ${merged} 条云端成绩${progressMsg}`
          : '已连接，云端与本地一致',
      );
      // 广播成绩变更：首页卡片、大厅统计等自动刷新
      notifyScoresUpdated();
      setSyncVersion((v) => v + 1);
    } catch {
      showSyncMsg('连接云端失败（离线？），稍后自动重试', true);
    }
  };

  /** 读取本机全部最佳成绩（含 `id:后缀` 细分键），供上传与迁移 */
  const readAllLocalScores = (): Record<string, number> => {
    const scores: Record<string, number> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('pp:best:')) continue;
        const gameId = key.slice('pp:best:'.length);
        if (!gameId.includes(':') && VARIANT_BASE_IDS.has(gameId)) continue;
        const lv = readBestKey(key.slice('pp:'.length));
        if (lv !== null && lv > 0) scores[gameId] = lv;
      }
    } catch {
      /* 隐私模式等跳过 */
    }
    return scores;
  };

  /** 收集本机全部成绩并上传云端（服务端按权威方向表合并），返回上传条数 */
  const pushLocalScores = async (code: string): Promise<number> => {
    const scores = readAllLocalScores();
    const count = Object.keys(scores).length;
    await pushCloud(code, {
      scores: count > 0 ? scores : undefined,
      progress: { dqSave: readDqSave() },
      prefs: { soundMuted: readSoundMuted() },
    });
    return count;
  };

  const newSyncCode = async () => {
    const code = generateSyncCode();
    // 云端登记配对（5 分钟有效）
    const created = await createPair(code);
    if (!created) {
      showSyncMsg('⚠️ 需要联网生成同步码，请检查网络后重试', true);
      return;
    }
    setSyncCode(code);
    setSyncCodeState(code);
    sfx.record();
    // 生码后立即上传本机存量成绩，否则另一台设备拉不到任何数据
    try {
      const n = await pushLocalScores(code);
      showSyncMsg(
        n > 0
          ? `已生成同步码 ${code}（5 分钟内有效），本机 ${n} 条成绩已上传，在另一台设备输入即可同步`
          : `已生成同步码 ${code}（5 分钟内有效），本机暂无成绩，新纪录会自动上传`,
      );
    } catch {
      showSyncMsg(`已生成同步码 ${code}，但本机成绩上传失败（离线？），新纪录将自动补传`, true);
    }
  };

  const disconnectSync = () => {
    setSyncCode(null);
    setSyncCodeState(null);
    showSyncMsg('已断开云同步');
  };

  /** 重新生成同步码：自动把旧码云端成绩 + 本地成绩迁移到新码 */
  const regenerateSync = async () => {
    const oldCode = syncCode;
    const newCode = generateSyncCode();
    const created = await createPair(newCode);
    if (!created) {
      showSyncMsg('⚠️ 需要联网生成同步码，请检查网络后重试', true);
      return;
    }
    // 1. 拉取旧码云端数据
    const merged: Record<string, number> = {};
    let cloudSave: DqSave | null = null;
    try {
      const data = await fetchCloud(oldCode ?? '');
      for (const [cid, cv] of Object.entries(data.scores ?? {})) {
        if (typeof cv === 'number' && Number.isFinite(cv) && cv > 0) merged[cid] = cv;
      }
      cloudSave = sanitizeDqSave(data.progress?.dqSave ?? null);
    } catch {
      /* 旧码云端不可达则跳过 */
    }
    // 2. 合并本地成绩（按各游戏比较方向取最优）
    const localScores = readAllLocalScores();
    for (const [gameId, lv] of Object.entries(localScores)) {
      const cur = merged[gameId];
      if (cur == null || isBetterScore(gameId, lv, cur)) merged[gameId] = lv;
    }
    // 3. 存档取更优（本地 vs 旧码云端）
    const localSave = readDqSave();
    const bestSave =
      localSave && cloudSave ? (isBetterDqSave(localSave, cloudSave) ? localSave : cloudSave) : (localSave ?? cloudSave);
    // 4. 写入新码
    let migrated = true;
    try {
      await pushCloud(newCode, {
        scores: merged,
        progress: { dqSave: bestSave },
        prefs: { soundMuted: readSoundMuted() },
      });
    } catch {
      migrated = false;
    }
    setSyncCode(newCode);
    setSyncCodeState(newCode);
    showSyncMsg(
      migrated
        ? `已生成新同步码 ${newCode}，旧码成绩已迁移`
        : `已生成新同步码 ${newCode}，但旧码成绩迁移失败（离线？），新纪录将自动补传`,
      !migrated,
    );
    sfx.record();
  };

  return (
    <div className="app">
      <div className="bg-decor" aria-hidden>
        <span className="blob blob-1" />
        <span className="blob blob-2" />
        <span className="blob blob-3" />
      </div>
      <DonateWidget />
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
                <p>{games.length} 款经典益智游戏 · 一触即玩 · 成绩永久保存</p>
              </div>
            </div>
            <div className="lobby-stats">
              <span className="chip chip-lg">
                🎮 {games.length} 款游戏 · 已玩 {stats.played}
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

          {/* 首页顶部横幅广告位（AdSense 开通后填入 slot） */}
          <AdSlot slot="0000000001" variant="leaderboard" />

          <div className="lobby-toolbar">
            <div className="search-box">
              <span aria-hidden>🔍</span>
              <input
                type="search"
                placeholder="搜索游戏…"
                aria-label="搜索游戏"
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
              {grouped && grouped.length > 0 && (
                <div className="filter-group group-actions">
                  <button className="btn btn-ghost group-all-btn" onClick={() => setAllGroups(false)}>
                    全部展开
                  </button>
                  <button className="btn btn-ghost group-all-btn" onClick={() => setAllGroups(true)}>
                    全部折叠
                  </button>
                </div>
              )}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state">
              <span aria-hidden>🔍</span>
              <p>没有找到匹配的游戏，换个关键词试试？</p>
            </div>
          ) : grouped ? (
            <div className="game-groups">
              {grouped.map((group) => {
                const isFolded = !!collapsed[group.key];
                return (
                  <section key={group.key} className={`game-group${isFolded ? ' folded' : ''}`}>
                    <button
                      type="button"
                      className="game-group-header"
                      aria-expanded={!isFolded}
                      onClick={() => toggleGroup(group.key)}
                    >
                      <span className="game-group-chevron" aria-hidden>
                        {isFolded ? '▸' : '▾'}
                      </span>
                      <span className="game-group-icon" aria-hidden>
                        {group.icon}
                      </span>
                      <span className="game-group-title">{group.label}</span>
                      <span className="game-group-count">{group.games.length} 款</span>
                    </button>
                    {!isFolded && (
                      <div className="game-grid">
                        {group.games.map((meta) => (
                          <GameCard key={meta.id} meta={meta} />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
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
                <button className="sync-close" onClick={() => setSyncOpen(false)} aria-label="关闭">
                  ✕
                </button>
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
                      onKeyDown={(e) => e.key === 'Enter' && joinSync()}
                      placeholder="输入 6 位同步码"
                      aria-label="输入 6 位同步码"
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
                {syncMsg && <p className={`sync-msg ${syncErr ? 'err' : ''}`}>{syncMsg}</p>}
              </div>
            </div>
          )}

          <footer className="lobby-footer">
            <div className="footer-actions">
              <button
                className="btn donate-footer-btn"
                onClick={() => window.dispatchEvent(new CustomEvent('pp:donate-open'))}
              >
                ☕ 请作者喝杯咖啡
              </button>
              <a
                className="btn feedback-mail-btn"
                href="mailto:1846460160@qq.com?subject=PuzzlePlay%20%E9%97%AE%E9%A2%98%E5%8F%8D%E9%A6%88"
                title="通过邮件反馈问题或建议"
              >
                ✉ 问题反馈请联系邮箱：1846460160@qq.com
              </a>
            </div>
            <details className="dev-guide">
              <summary>🛠 开发者指南：如何新增游戏？</summary>
              <p>
                先在 <code>src/core/gameMetas.tsx</code> 追加一条 meta（含 <code>higherIsBetter</code>），
                再在 <code>src/games/</code> 下新建默认导出组件、用 <code>useBestScore</code> 存档，
                最后到 <code>src/core/registry.tsx</code> 注册一行 <code>lazy</code> 导入即可，
                大厅、路由、成绩存档自动生效。详见 README「如何新增游戏」。
              </p>
            </details>
          </footer>
        </div>
      )}
    </div>
  );
}
