import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { GameShell } from '../../core/GameShell';
import { metaLabyrinth3D } from '../../core/gameMetas';
import { notifyScoresUpdated, readBestKey } from '../../core/useLocalStorage';
import { sfx } from '../../core/sound';
import { fetchCloud, getSyncCode, pushCloud, useBestScore } from '../../core/sync';
import { useToast } from '../../core/Toast';
import { controlTilt, createControl, isTiltKey, reduceControl } from './input.ts';
import type { ControlState } from './input.ts';
import { LEVELS } from './levels.ts';
import { GEM_VALUE, advance, createRun, drainEvents, isTerminal, levelScore, useHint } from './physics.ts';
import type { ScoreBreakdown } from './physics.ts';
import { drawScene, makeCamera } from './render3d.ts';
import type { Camera } from './render3d.ts';
import { findRoute } from './route.ts';
import { clampStars, starId, starKey } from './stars.ts';
import type { RunState, Vec2 } from './types.ts';
import './Labyrinth3D.css';

type Mode = 'intro' | 'playing' | 'paused' | 'cleared' | 'over' | 'allclear';

interface Hud {
  lives: number;
  elapsed: number;
  gems: number;
  falls: number;
  hints: number;
}

/**
 * 星级放进 `pp:best:` 命名空间：这样现有的全量成绩上传/云同步/加入合并会自动带上，
 * 又因为 meta 没声明 bestVariants，不会污染大厅的“最高分”聚合。
 * 用稳定关卡 id 而不是数组下标，未来调整关卡顺序不会把星星错配。
 */
const STAR_ID = (index: number) => starId(metaLabyrinth3D.id, LEVELS[index].def.id);
const STAR_KEY = (index: number) => starKey(metaLabyrinth3D.id, LEVELS[index].def.id);

function readStars(index: number): number {
  // 云端/手改的 4、3.1、NaN 都可能进本地；夹取后再参与渲染与解锁
  return clampStars(readBestKey(STAR_KEY(index)));
}

/** 把旧版 `pp:labyrinth:star:<index>` 迁移到新键；返回是否有变更 */
function migrateLegacyStars(): boolean {
  let changed = false;
  for (let i = 0; i < LEVELS.length; i++) {
    const oldKey = `pp:labyrinth:star:${i}`;
    try {
      const raw = localStorage.getItem(oldKey);
      if (raw !== null) {
        const v = clampStars(JSON.parse(raw));
        if (v > 0) {
          const key = STAR_KEY(i);
          const cur = readBestKey(key);
          if (cur === null || v > cur) {
            localStorage.setItem(`pp:${key}`, JSON.stringify(v));
            changed = true;
          }
        }
        localStorage.removeItem(oldKey);
      }
    } catch {
      /* 隐私模式/脏数据跳过 */
    }
  }
  if (changed) notifyScoresUpdated();
  return changed;
}

function writeStars(index: number, stars: number): void {
  const value = clampStars(stars);
  if (value <= readStars(index)) return;
  const key = STAR_KEY(index);
  try {
    localStorage.setItem(`pp:${key}`, JSON.stringify(value));
    notifyScoresUpdated();
    // 本地 key 带 best: 前缀，云端 gameId 不能带；分开生成
    const code = getSyncCode();
    if (code) pushCloud(code, { scores: { [STAR_ID(index)]: value } }).catch(() => { /* 离线静默 */ });
  } catch {
    /* 隐私模式跳过 */
  }
}

function levelUnlocked(index: number): boolean {
  return index === 0 || readStars(index - 1) > 0;
}

export default function Labyrinth3D() {
  const [levelIndex, setLevelIndex] = useState(0);
  const [mode, setMode] = useState<Mode>('intro');
  const [totalScore, setTotalScore] = useState(0);
  const [result, setResult] = useState<ScoreBreakdown | null>(null);
  const [hud, setHud] = useState<Hud>({ lives: 3, elapsed: 0, gems: 0, falls: 0, hints: 0 });
  const [starVersion, setStarVersion] = useState(0);
  const [notice, setNotice] = useState(LEVELS[0].def.subtitle);
  const best = useBestScore(metaLabyrinth3D.id);
  const { toast } = useToast();

  const level = LEVELS[levelIndex];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<RunState>(createRun(LEVELS[0]));
  const controlRef = useRef<ControlState>(createControl());
  const cameraRef = useRef<Camera | null>(null);
  const sizeRef = useRef({ width: 640, height: 400, dpr: 1 });
  const modeRef = useRef<Mode>('intro');
  const levelRef = useRef(level);
  const totalRef = useRef(0);
  /** 进入当前关时的累计分：重开本关保留它，不再把整局分数清零 */
  const levelStartTotalRef = useRef(0);
  const bestRef = useRef(best);
  const hintRef = useRef<{ path: Vec2[]; until: number } | null>(null);
  const hudClockRef = useRef(0);
  const settledRef = useRef(false);

  modeRef.current = mode;
  levelRef.current = level;
  totalRef.current = totalScore;
  bestRef.current = best;

  const gemTotal = level.gems.length;
  const totalStars = useMemo(
    () => LEVELS.reduce((sum, _unused, i) => sum + readStars(i), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [starVersion],
  );

  // 迁移旧下标键，并从云端补拉星级（已配同步码时）；本地更优则补推
  useEffect(() => {
    const migrated = migrateLegacyStars();
    const code = getSyncCode();
    if (!code) {
      if (migrated) setStarVersion((v) => v + 1);
      return;
    }
    let cancelled = false;
    fetchCloud(code)
      .then((data) => {
        if (cancelled) return;
        let changed = migrated;
        const toPush: Record<string, number> = {};
        for (let i = 0; i < LEVELS.length; i++) {
          const key = STAR_KEY(i);
          const id = STAR_ID(i);
          const cloud = data.scores?.[id];
          const local = clampStars(readBestKey(key));
          if (typeof cloud === 'number' && Number.isFinite(cloud) && cloud > 0 && cloud <= 3) {
            if (local < cloud) {
              try {
                localStorage.setItem(`pp:${key}`, JSON.stringify(clampStars(cloud)));
                changed = true;
              } catch {
                /* 配额满等 */
              }
            } else if (local > cloud) {
              toPush[id] = local;
            }
          } else if (local > 0) {
            toPush[id] = local;
          }
        }
        if (Object.keys(toPush).length > 0) {
          pushCloud(code, { scores: toPush }).catch(() => { /* 离线静默 */ });
        }
        if (changed) {
          notifyScoresUpdated();
          setStarVersion((v) => v + 1);
        }
      })
      .catch(() => {
        if (!cancelled && migrated) setStarVersion((v) => v + 1);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const beginLevel = useCallback((index: number, carry: number) => {
    const next = LEVELS[index];
    levelRef.current = next;
    runRef.current = createRun(next);
    controlRef.current = createControl();
    hintRef.current = null;
    settledRef.current = false;
    cameraRef.current = null;
    levelStartTotalRef.current = carry;
    totalRef.current = carry;
    setLevelIndex(index);
    setTotalScore(carry);
    setResult(null);
    setNotice(next.def.subtitle);
    setHud({ lives: runRef.current.lives, elapsed: 0, gems: 0, falls: 0, hints: 0 });
    setMode('playing');
  }, []);

  const settle = useCallback((finalScore: number) => {
    if (settledRef.current) return;
    settledRef.current = true;
    // 0 分不是有效纪录：新档第一关掉光命或扣分扣到 0 时不应显示"新纪录 0 分"
    const record = finalScore > 0 && bestRef.current.updateBest(finalScore, (a, b) => a > b);
    if (record) {
      sfx.record();
      toast(`新纪录：${finalScore} 分`, 'record');
    }
  }, [toast]);

  const finishLevel = useCallback(() => {
    if (settledRef.current) return;
    const current = levelRef.current;
    const run = runRef.current;
    const breakdown = levelScore(current, run);
    const carry = totalRef.current + breakdown.total;
    settledRef.current = true;
    writeStars(LEVELS.indexOf(current), breakdown.stars);
    setStarVersion((v) => v + 1);
    totalRef.current = carry;
    setTotalScore(carry);
    setResult(breakdown);
    const record = carry > 0 && bestRef.current.updateBest(carry, (a, b) => a > b);
    if (record) {
      sfx.record();
      toast(`新纪录：${carry} 分`, 'record');
    } else {
      sfx.win();
    }
    setMode(LEVELS.indexOf(current) === LEVELS.length - 1 ? 'allclear' : 'cleared');
  }, [toast]);

  const restartLevel = useCallback(() => {
    // 保留进入本关时的累计分：重开本关不等于重开整局
    beginLevel(LEVELS.indexOf(levelRef.current), levelStartTotalRef.current);
  }, [beginLevel]);

  /** 暂停时把盘面回正并清空输入，避免恢复后带着旧倾角直接滑出去 */
  const pauseGame = useCallback(() => {
    if (modeRef.current !== 'playing') return;
    const run = runRef.current;
    run.pitch = 0;
    run.roll = 0;
    controlRef.current = createControl();
    setMode('paused');
  }, []);

  const togglePause = useCallback(() => {
    if (modeRef.current === 'playing') pauseGame();
    else if (modeRef.current === 'paused') setMode('playing');
  }, [pauseGame]);

  /** 游玩中切关会丢弃当前局：先确认，避免侧栏误触 */
  const selectLevel = useCallback(
    (index: number) => {
      if (modeRef.current !== 'intro') {
        if (!window.confirm('当前关卡进度将丢失，确定切换关卡吗？')) return;
      }
      beginLevel(index, 0);
    },
    [beginLevel],
  );

  const showHint = useCallback(() => {
    if (modeRef.current !== 'playing') return;
    const path = findRoute(levelRef.current, runRef.current.ball);
    if (!path) {
      setNotice('这里已经找不到通往终点的可行路线了。');
      return;
    }
    useHint(runRef.current);
    hintRef.current = { path, until: performance.now() + 3200 };
    setNotice('绿线是可行路线（本关结算 −50 分，不影响星级）。');
    sfx.click();
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const measure = () => {
      const width = Math.max(1, stage.clientWidth);
      const height = Math.max(1, stage.clientHeight);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      sizeRef.current = { width, height, dpr };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      cameraRef.current = null;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let animation = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - previous) / 1000));
      previous = now;
      const current = levelRef.current;
      const run = runRef.current;
      const size = sizeRef.current;
      const viewport = { width: size.width, height: size.height };
      if (!cameraRef.current) cameraRef.current = makeCamera(current, viewport);

      if (modeRef.current === 'playing') {
        advance(current, run, controlTilt(controlRef.current, viewport), dt);
        for (const event of drainEvents(run)) {
          if (event.type === 'gem') {
            sfx.match();
          } else if (event.type === 'checkpoint') {
            sfx.flip();
            setNotice('检查点已激活：掉命后从这里重来。');
          } else if (event.type === 'bump') {
            if (event.speed > 1.1) sfx.move();
          } else if (event.type === 'fall') {
            if (event.goal) sfx.win();
            else {
              sfx.thud();
              setNotice(run.lives > 1 ? `掉进陷阱洞，还剩 ${run.lives - 1} 条命。` : '最后一次机会了。');
            }
          } else if (event.type === 'cleared') {
            finishLevel();
          } else if (event.type === 'over') {
            sfx.lose();
            settle(totalRef.current);
            setMode('over');
          }
        }
        if (isTerminal(run)) {
          setHud({
            lives: run.lives,
            elapsed: run.elapsed,
            gems: run.taken.filter(Boolean).length,
            falls: run.falls,
            hints: run.hints,
          });
        }
        hudClockRef.current += dt;
        if (hudClockRef.current > 0.1) {
          hudClockRef.current = 0;
          setHud({
            lives: run.lives,
            elapsed: run.elapsed,
            gems: run.taken.filter(Boolean).length,
            falls: run.falls,
            hints: run.hints,
          });
        }
      }

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx && cameraRef.current) {
        ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
        const hint = hintRef.current;
        const control = controlRef.current;
        drawScene(ctx, {
          level: current,
          run,
          camera: cameraRef.current,
          viewport,
          time: now / 1000,
          hint: hint && hint.until > now ? hint.path : null,
          drag: control.origin && control.current
            ? { ox: control.origin.x, oy: control.origin.y, x: control.current.x, y: control.current.y }
            : null,
          showTilt: modeRef.current === 'playing' || modeRef.current === 'paused',
        });
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [finishLevel, settle]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input,textarea,select')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTiltKey(event.key)) {
        event.preventDefault();
        controlRef.current = reduceControl(controlRef.current, { type: 'key', key: event.key, down: true }).state;
        return;
      }
      if (event.repeat) return;
      if (event.key === 'Enter') {
        if (target?.closest('button,a')) return;
        event.preventDefault();
        const m = modeRef.current;
        if (m === 'intro') beginLevel(LEVELS.indexOf(levelRef.current), 0);
        else if (m === 'cleared') beginLevel(LEVELS.indexOf(levelRef.current) + 1, totalRef.current);
        else if (m === 'over' || m === 'allclear') beginLevel(0, 0);
        else if (m === 'paused') setMode('playing');
      } else if (event.key === 'Escape' || event.key.toLowerCase() === 'p') {
        event.preventDefault();
        togglePause();
      } else if (event.key.toLowerCase() === 'r') {
        if (modeRef.current === 'playing' || modeRef.current === 'paused') restartLevel();
      } else if (event.key.toLowerCase() === 'h') {
        showHint();
      }
    };
    const keyup = (event: KeyboardEvent) => {
      controlRef.current = reduceControl(controlRef.current, { type: 'key', key: event.key, down: false }).state;
    };
    const clear = () => { controlRef.current = reduceControl(controlRef.current, { type: 'clear' }).state; };
    const hidden = () => {
      if (document.hidden) pauseGame();
    };
    const blur = () => {
      clear();
      // 窗口失焦但仍可见（并排窗口/开发者工具）时也要暂停，否则物理继续跑
      pauseGame();
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', hidden);
      clear();
    };
  }, [beginLevel, restartLevel, showHint, togglePause, pauseGame]);

  const pointOf = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const starList = useMemo(
    () => LEVELS.map((_unused, i) => readStars(i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [starVersion],
  );

  return (
    <GameShell
      meta={metaLabyrinth3D}
      onBack={() => { window.location.hash = '#/'; }}
      stats={(
        <>
          <div className="stat-box"><span>最高分</span><strong>{best.value === null ? '--' : best.value}</strong></div>
          <div className="stat-box"><span>本局累计</span><strong>{totalScore}</strong></div>
          <div className="stat-box"><span>总星数</span><strong>{totalStars} / {LEVELS.length * 3}</strong></div>
          <div className="stat-box"><span>三星基准</span><strong>{level.def.par} 秒</strong></div>
        </>
      )}
    >
      <div className="lab-game">
        <div className="lab-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            className="lab-canvas"
            tabIndex={0}
            role="application"
            aria-label="3D 滚球迷宫。按住并拖动倾斜盘面，或用方向键与 WASD。R 重开，H 提示，Esc 暂停。"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              if (modeRef.current !== 'playing') return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              const p = pointOf(event);
              controlRef.current = reduceControl(controlRef.current, {
                type: 'down', id: event.pointerId, x: p.x, y: p.y, button: event.button,
              }).state;
            }}
            onPointerMove={(event) => {
              const p = pointOf(event);
              controlRef.current = reduceControl(controlRef.current, { type: 'move', id: event.pointerId, x: p.x, y: p.y }).state;
            }}
            onPointerUp={(event) => {
              controlRef.current = reduceControl(controlRef.current, { type: 'up', id: event.pointerId }).state;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={(event) => {
              controlRef.current = reduceControl(controlRef.current, { type: 'cancel', id: event.pointerId }).state;
            }}
            onContextMenu={(event) => event.preventDefault()}
          />

          <div className="lab-hud" aria-hidden>
            <span>{levelIndex + 1} / {LEVELS.length} · {level.def.name}</span>
            <span className="lab-lives">{'●'.repeat(Math.max(0, hud.lives))}<i>{'○'.repeat(Math.max(0, 3 - hud.lives))}</i></span>
            <span>{hud.elapsed.toFixed(1)}s / {level.def.par}s</span>
            <span>◆ {hud.gems} / {gemTotal}</span>
          </div>

          {mode === 'intro' && (
            <div className="lab-overlay" role="dialog" aria-label="玩法说明">
              <div className="lab-card">
                <p className="lab-kicker">倾斜星盘 · 滚珠入洞</p>
                <h2>{level.def.name}</h2>
                <p className="lab-rules">
                  按住画面拖动即可倾斜盘面，钢珠会顺着重力滚动；松手盘面自动回正。
                  躲开<span className="lab-trap">红色陷阱洞</span>，滚进<span className="lab-goal">金色终点洞</span>。
                  每关 3 条命，掉光即结算。方向键 / WASD 同样能倾斜。
                </p>
                <div className="lab-actions">
                  <button className="btn btn-primary" onClick={() => beginLevel(levelIndex, 0)}>开始</button>
                </div>
              </div>
            </div>
          )}

          {mode === 'paused' && (
            <div className="lab-overlay" role="dialog" aria-label="已暂停">
              <div className="lab-card">
                <p className="lab-kicker">盘面已回正</p>
                <h2>暂停</h2>
                <div className="lab-actions">
                  <button className="btn btn-primary" onClick={() => setMode('playing')}>继续</button>
                  <button className="btn btn-ghost" onClick={restartLevel}>重开本关</button>
                </div>
              </div>
            </div>
          )}

          {(mode === 'cleared' || mode === 'allclear') && result && (
            <div className="lab-overlay" role="dialog" aria-label="关卡完成">
              <div className="lab-card">
                <p className="lab-kicker">{mode === 'allclear' ? '八张星盘全部征服' : '钢珠归位'}</p>
                <h2>{'★'.repeat(result.stars)}{'☆'.repeat(3 - result.stars)} {level.def.name}</h2>
                <p className="lab-rules">
                  用时 {runRef.current.elapsed.toFixed(1)} 秒（三星 {level.def.par} 秒）· 宝石 {result.gems / GEM_VALUE} 枚
                  <br />
                  基础 {result.base} + 宝石 {result.gems} + 时间 {result.timeBonus} − 掉洞 {result.fallPenalty} − 提示 {result.hintPenalty}
                  <br />
                  本关 <strong>{result.total}</strong> 分 · 本局累计 <strong>{totalScore}</strong> 分
                </p>
                <div className="lab-actions">
                  {mode === 'cleared' ? (
                    <button className="btn btn-primary" onClick={() => beginLevel(levelIndex + 1, totalScore)}>下一关</button>
                  ) : (
                    <button className="btn btn-primary" onClick={() => beginLevel(0, 0)}>再开一局</button>
                  )}
                  <button className="btn btn-ghost" onClick={restartLevel}>重玩本关</button>
                </div>
              </div>
            </div>
          )}

          {mode === 'over' && (
            <div className="lab-overlay" role="dialog" aria-label="游戏结束">
              <div className="lab-card">
                <p className="lab-kicker">三条命都掉进洞里了</p>
                <h2>本局结束</h2>
                <p className="lab-rules">
                  停在第 {levelIndex + 1} 关「{level.def.name}」· 本局累计 <strong>{totalScore}</strong> 分
                  <br />
                  最高分 {best.value === null ? '--' : best.value}
                </p>
                <div className="lab-actions">
                  <button className="btn btn-primary" onClick={() => beginLevel(0, 0)}>从头再来</button>
                  <button className="btn btn-ghost" onClick={restartLevel}>重玩本关</button>
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="lab-panel">
          <div className="lab-levels" aria-label="选择关卡">
            {LEVELS.map((item, index) => {
              const unlocked = levelUnlocked(index);
              const stars = starList[index];
              return (
                <button
                  key={item.def.id}
                  className={`lab-level ${index === levelIndex ? 'active' : ''}`}
                  disabled={!unlocked}
                  onClick={(e) => {
                    // 移除焦点：否则 Enter 会再次触发本按钮，反复弹确认框
                    e.currentTarget.blur();
                    selectLevel(index);
                  }}
                  title={unlocked ? `${item.def.name}（选中即从这一关开新局）` : '上一关拿到至少一星后解锁'}
                >
                  <span>{index + 1}. {unlocked ? item.def.name : '尚未解锁'}</span>
                  <small>{stars === 0 ? '未完成' : `${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}`}</small>
                </button>
              );
            })}
          </div>

          <div className="lab-objective">
            <span className="lab-panel-label">当前目标</span>
            <strong>滚进金色终点洞{gemTotal > 0 ? `，顺路吃 ${gemTotal} 枚宝石` : ''}</strong>
            <p>{notice}</p>
          </div>

          <div className="lab-tools">
            <button className="btn btn-ghost" onClick={togglePause} disabled={mode !== 'playing' && mode !== 'paused'}>
              {mode === 'paused' ? '继续' : '暂停'}
            </button>
            <button className="btn btn-ghost" onClick={showHint} disabled={mode !== 'playing'}>提示 −50</button>
            <button className="btn btn-ghost" onClick={restartLevel} disabled={mode === 'intro'}>重开本关</button>
          </div>

          <div className="lab-help">
            <span>按住拖动倾斜盘面 · 松手回正 · 右下角水平仪显示当前倾角</span>
            <span>方向键 / WASD 倾斜 · Enter 开始或下一关 · Esc 暂停 · R 重开 · H 提示</span>
            <span>冰面打滑、沙地减速、铜杆会甩球；踩亮紫环检查点可保住进度</span>
          </div>
        </aside>
      </div>
    </GameShell>
  );
}