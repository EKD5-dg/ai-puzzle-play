import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { GameShell } from '../../core/GameShell';
import { metaLabyrinth3D } from '../../core/gameMetas';
import { notifyScoresUpdated, readBestKey } from '../../core/useLocalStorage';
import { sfx } from '../../core/sound';
import { useBestScore } from '../../core/sync';
import { useToast } from '../../core/Toast';
import { controlTilt, createControl, isTiltKey, reduceControl } from './input.ts';
import type { ControlState } from './input.ts';
import { LEVELS } from './levels.ts';
import { GEM_VALUE, advance, createRun, drainEvents, isTerminal, levelScore, useHint } from './physics.ts';
import type { ScoreBreakdown } from './physics.ts';
import { drawScene, makeCamera } from './render3d.ts';
import type { Camera } from './render3d.ts';
import { findRoute } from './route.ts';
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

const STAR_KEY = (index: number) => `labyrinth:star:${index}`;

function readStars(index: number): number {
  return readBestKey(STAR_KEY(index)) ?? 0;
}

function writeStars(index: number, stars: number): void {
  if (stars <= readStars(index)) return;
  try {
    localStorage.setItem(`pp:${STAR_KEY(index)}`, JSON.stringify(stars));
    notifyScoresUpdated();
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

  const beginLevel = useCallback((index: number, carry: number) => {
    const next = LEVELS[index];
    levelRef.current = next;
    runRef.current = createRun(next);
    controlRef.current = createControl();
    hintRef.current = null;
    settledRef.current = false;
    cameraRef.current = null;
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
    const record = bestRef.current.updateBest(finalScore, (a, b) => a > b);
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
    const record = bestRef.current.updateBest(carry, (a, b) => a > b);
    if (record) {
      sfx.record();
      toast(`新纪录：${carry} 分`, 'record');
    } else {
      sfx.win();
    }
    setMode(LEVELS.indexOf(current) === LEVELS.length - 1 ? 'allclear' : 'cleared');
  }, [toast]);

  const restartLevel = useCallback(() => {
    beginLevel(LEVELS.indexOf(levelRef.current), 0);
  }, [beginLevel]);

  const togglePause = useCallback(() => {
    setMode((m) => (m === 'playing' ? 'paused' : m === 'paused' ? 'playing' : m));
  }, []);

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
      if (document.hidden) {
        clear();
        setMode((m) => (m === 'playing' ? 'paused' : m));
      }
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', hidden);
      clear();
    };
  }, [beginLevel, restartLevel, showHint, togglePause]);

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
                  onClick={() => beginLevel(index, 0)}
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