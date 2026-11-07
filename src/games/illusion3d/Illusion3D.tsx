import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameShell } from '../../core/GameShell';
import { metaIllusion3D } from '../../core/gameMetas';
import { readBestKey } from '../../core/useLocalStorage';
import { sfx } from '../../core/sound';
import { useBestScore } from '../../core/sync';
import { useToast } from '../../core/Toast';
import { buildLevelMesh, isPointVisibleWithFrame, projectMesh } from './geometry.ts';
import { applyOrbit, createGesture, reduceGesture, selectTapTarget, walkPosition, wheelZoomFactor, zoomCamera } from './input.ts';
import { LEVELS } from './levels.ts';
import { makeCameraFrame } from './projection.ts';
import {
  advanceWalk,
  createSession,
  findPath,
  getHint,
  parMoves,
  reachableNodes,
  starsFor,
  unlockIllusion,
} from './logic.ts';
import { findAlignableEdge, makeCamera, runeAnchor, stepAlignment } from './projection.ts';
import type { AlignmentState } from './projection.ts';
import { drawScene } from './renderer.ts';
import type { NodeHit } from './renderer.ts';
import type { IllusionHint, IllusionSession, Vec3 } from './types.ts';
import './Illusion3D.css';

interface WalkState {
  path: string[];
  segment: number;
  progress: number;
  phase: number;
}

function bestKey(index: number): string {
  return `best:${metaIllusion3D.id}:${index}`;
}

function levelUnlocked(index: number): boolean {
  return index === 0 || (readBestKey(bestKey(index - 1)) ?? 0) > 0;
}

export default function Illusion3D() {
  const [levelIndex, setLevelIndex] = useState(0);
  const level = LEVELS[levelIndex];
  const [session, setSession] = useState<IllusionSession>(() => createSession(level));
  const [selected, setSelected] = useState<string | null>(null);
  const [hint, setHint] = useState<IllusionHint | null>(null);
  const [notice, setNotice] = useState(level.subtitle);
  const best = useBestScore(`${metaIllusion3D.id}:${levelIndex}`);
  const { toast } = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const levelRef = useRef(level);
  const sessionRef = useRef(session);
  const selectedRef = useRef(selected);
  const bestRef = useRef(best);
  const cameraRef = useRef(makeCamera(level));
  const meshRef = useRef(buildLevelMesh(level, new Set()));
  const alignmentRef = useRef<AlignmentState>({ edgeId: null, charge: 0 });
  const gestureRef = useRef(createGesture());
  const walkRef = useRef<WalkState | null>(null);
  const hitsRef = useRef<NodeHit[]>([]);
  const keysRef = useRef(new Set<string>());
  const sizeRef = useRef({ width: 640, height: 400, dpr: 1 });

  levelRef.current = level;
  sessionRef.current = session;
  selectedRef.current = selected;
  bestRef.current = best;

  const par = useMemo(() => parMoves(level), [level]);
  const reachable = useMemo(() => new Set(reachableNodes(level, session)), [level, session]);
  const reachableRef = useRef(reachable);
  reachableRef.current = reachable;
  const totalStars = LEVELS.reduce((sum, _, index) => sum + (readBestKey(bestKey(index)) ?? 0), 0);
  const coreTotal = level.nodes.filter((node) => node.core).length;
  const earnedStars = session.complete ? starsFor(session.moves, par) : 0;

  const commitSession = useCallback((next: IllusionSession) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const resetLevel = useCallback(() => {
    const current = levelRef.current;
    const initial = createSession(current);
    walkRef.current = null;
    cameraRef.current = makeCamera(current);
    meshRef.current = buildLevelMesh(current, new Set());
    alignmentRef.current = { edgeId: null, charge: 0 };
    gestureRef.current = createGesture();
    keysRef.current.clear();
    setSelected(null);
    setHint(null);
    setNotice(current.subtitle);
    commitSession(initial);
  }, [commitSession]);

  useEffect(() => {
    resetLevel();
  }, [levelIndex, resetLevel]);

  const completeLevel = useCallback((finished: IllusionSession) => {
    const current = levelRef.current;
    const stars = starsFor(finished.moves, parMoves(current));
    const record = bestRef.current.updateBest(stars, (a, b) => a > b);
    if (record) {
      sfx.record();
      toast(`新纪录：本关 ${stars} 星`, 'record');
    } else {
      sfx.win();
      toast(`关卡完成：本关 ${stars} 星`, 'success');
    }
  }, [toast]);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const measure = () => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      const dpr = Math.min(1.75, window.devicePixelRatio || 1);
      sizeRef.current = { width: Math.max(1, width), height: Math.max(1, height), dpr };
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraRef.current = zoomCamera(
        cameraRef.current,
        wheelZoomFactor(event.deltaY, event.deltaMode, sizeRef.current.height),
      );
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    let animation = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - previous) / 1000));
      previous = now;
      const current = levelRef.current;
      const camera = cameraRef.current;
      const keys = keysRef.current;
      let orbited = camera;
      if (keys.has('ArrowLeft')) orbited = applyOrbit(orbited, -120 * dt, 0);
      if (keys.has('ArrowRight')) orbited = applyOrbit(orbited, 120 * dt, 0);
      if (keys.has('ArrowUp')) orbited = applyOrbit(orbited, 0, -100 * dt);
      if (keys.has('ArrowDown')) orbited = applyOrbit(orbited, 0, 100 * dt);
      cameraRef.current = orbited;

      const walk = walkRef.current;
      if (walk) {
        const from = current.nodes.find((node) => node.id === walk.path[walk.segment]);
        const to = current.nodes.find((node) => node.id === walk.path[walk.segment + 1]);
        if (from && to) {
          const length = Math.hypot(to.p[0] - from.p[0], to.p[1] - from.p[1], to.p[2] - from.p[2]);
          walk.progress += dt * 2.5 / Math.max(0.2, length);
          walk.phase = (walk.phase + dt * 3.2) % 1;
          if (walk.progress >= 1) {
            const before = sessionRef.current;
            const advanced = advanceWalk(current, before, walk.path, walk.segment);
            commitSession(advanced.session);
            if (advanced.session.collected.length > before.collected.length) sfx.match();
            if (advanced.done) {
              walkRef.current = null;
              if (advanced.session.complete) completeLevel(advanced.session);
            } else {
              walk.segment = advanced.segment;
              walk.progress = 0;
            }
          }
        } else {
          walkRef.current = null;
        }
      }

      const size = sizeRef.current;
      const viewport = { width: size.width, height: size.height };
      // 每帧只算一次相机基和全部三角形投影，避免每个节点各自重投影 376 个三角形
      const cameraFrame = makeCameraFrame(orbited, viewport);
      const screenMesh = projectMesh(meshRef.current, cameraFrame);
      const visibleNodes = new Set(
        current.nodes
          .filter((node) => isPointVisibleWithFrame(runeAnchor(node.p), screenMesh, cameraFrame))
          .map((node) => node.id),
      );
      const activeSession = sessionRef.current;
      const candidate = !walkRef.current && !activeSession.complete
        ? findAlignableEdge(current, activeSession, orbited, viewport, (id) => visibleNodes.has(id))
        : null;
      const alignment = stepAlignment(alignmentRef.current, candidate, dt, viewport);
      alignmentRef.current = alignment.state;
      if (alignment.locked) {
        const next = unlockIllusion(current, activeSession, alignment.locked);
        if (next !== activeSession) {
          commitSession(next);
          // 本帧 screenMesh/visibleNodes 仍基于旧网格，最多延迟一帧显示新桥；下一帧自动重建
          meshRef.current = buildLevelMesh(current, new Set(next.unlocked));
          setHint(null);
          setNotice('光桥已固定。现在可以自由转动视角，并点按发光平台前往。');
          sfx.match();
        }
      }

      const activeWalk = walkRef.current;
      const travelerPosition: Vec3 = activeWalk
        ? walkPosition(current, activeWalk.path, activeWalk.segment, activeWalk.progress)
        : current.nodes.find((node) => node.id === sessionRef.current.node)?.p ?? current.nodes[0].p;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
        hitsRef.current = drawScene(ctx, {
          level: current,
          session: sessionRef.current,
          mesh: meshRef.current,
          camera: orbited,
          viewport,
          cameraFrame,
          screenMesh,
          traveler: {
            position: travelerPosition,
            moving: Boolean(activeWalk),
            phase: activeWalk?.phase ?? 0,
          },
          visibleNodes,
          reachable: reachableRef.current,
          candidate,
          alignment: alignmentRef.current,
          hint,
          selected,
          time: now / 1000,
        });
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [commitSession, completeLevel, hint, selected]);

  const startWalk = useCallback((destination: string) => {
    const current = levelRef.current;
    const active = sessionRef.current;
    if (walkRef.current || active.complete) return;
    const path = findPath(current, active.node, destination, new Set(active.unlocked));
    if (!path || path.length < 2) {
      setNotice('从这里还没有可用通路。先寻找断口，让光环重合。');
      return;
    }
    walkRef.current = { path, segment: 0, progress: 0, phase: 0 };
    setSelected(null);
    setHint(null);
    setNotice(`沿 ${path.length - 1} 段道路前往「${current.nodes.find((node) => node.id === destination)?.label}」。`);
    sfx.click();
  }, []);

  const showHint = useCallback(() => {
    if (walkRef.current || sessionRef.current.complete) return;
    const current = levelRef.current;
    const nextHint = getHint(current, sessionRef.current);
    setHint(nextHint);
    if (!nextHint) return;
    if (nextHint.type === 'align') {
      const edge = current.illusions.find((item) => item.id === nextHint.illusion);
      const other = edge?.a === sessionRef.current.node ? edge.b : edge?.a;
      setSelected(other ?? null);
      setNotice('寻找被标出的两枚符文。拖动遗迹，让它们在画面中重合并保持片刻。');
    } else {
      const node = current.nodes.find((item) => item.id === nextHint.node);
      setSelected(nextHint.node);
      setNotice(`下一步可以前往「${node?.label}」。提示不会扣星。`);
    }
  }, []);

  const cycleTarget = useCallback(() => {
    const current = levelRef.current;
    const active = sessionRef.current;
    const targets = current.nodes
      .map((node) => node.id)
      .filter((id) => id !== active.node && reachableRef.current.has(id));
    if (targets.length === 0) {
      setNotice('当前没有已连通的其他平台，先完成一次错视共鸣。');
      return;
    }
    const index = selectedRef.current ? targets.indexOf(selectedRef.current) : -1;
    setSelected(targets[(index + 1) % targets.length]);
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input,textarea,select')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Enter' && target?.closest('button,a')) return;
      if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        keysRef.current.add(event.key);
        return;
      }
      if (event.repeat) return;
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        cycleTarget();
      } else if (event.key === 'Enter' && selectedRef.current) {
        event.preventDefault();
        startWalk(selectedRef.current);
      } else if (event.key.toLowerCase() === 'h') {
        showHint();
      } else if (event.key.toLowerCase() === 'r') {
        resetLevel();
      } else if (event.key === '+' || event.key === '=') {
        cameraRef.current = zoomCamera(cameraRef.current, 1.12);
      } else if (event.key === '-') {
        cameraRef.current = zoomCamera(cameraRef.current, 1 / 1.12);
      }
    };
    const keyup = (event: KeyboardEvent) => keysRef.current.delete(event.key);
    const clearKeys = () => keysRef.current.clear();
    const pauseKeys = () => {
      if (document.hidden) clearKeys();
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', clearKeys);
    document.addEventListener('visibilitychange', pauseKeys);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', clearKeys);
      document.removeEventListener('visibilitychange', pauseKeys);
      keysRef.current.clear();
    };
  }, [cycleTarget, resetLevel, showHint, startWalk]);

  const handleTap = (x: number, y: number) => {
    if (walkRef.current || sessionRef.current.complete) return;
    const id = selectTapTarget(hitsRef.current, x, y, sessionRef.current.node, reachableRef.current);
    if (!id) {
      setSelected(null);
      return;
    }
    setSelected(id);
    if (id === sessionRef.current.node) {
      const node = levelRef.current.nodes.find((item) => item.id === id);
      setNotice(`旅人正在「${node?.label}」。选择另一处发光平台，或转动寻找断口。`);
    } else {
      startWalk(id);
    }
  };

  const pointerPosition = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  return (
    <GameShell
      meta={metaIllusion3D}
      onBack={() => { window.location.hash = '#/'; }}
      stats={(
        <>
          <div className="stat-box"><span>总星数</span><strong>{totalStars} / {LEVELS.length * 3}</strong></div>
          <div className="stat-box"><span>本关最佳</span><strong>{best.value === null ? '--' : `${best.value} 星`}</strong></div>
          <div className="stat-box"><span>移动</span><strong>{session.moves}</strong></div>
          <div className="stat-box"><span>最短路线</span><strong>{par} 段</strong></div>
        </>
      )}
    >
      <div className="illusion-game">
        <div className="illusion-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            className="illusion-canvas"
            tabIndex={0}
            role="application"
            aria-label="3D 错视遗迹。拖动旋转，点按平台移动，方向键转视角，N 选目标，回车前往。"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              const point = pointerPosition(event);
              gestureRef.current = reduceGesture(gestureRef.current, {
                type: 'down', id: event.pointerId, x: point.x, y: point.y, pointerType: event.pointerType,
              }).state;
            }}
            onPointerMove={(event) => {
              const point = pointerPosition(event);
              const result = reduceGesture(gestureRef.current, {
                type: 'move', id: event.pointerId, x: point.x, y: point.y,
              });
              gestureRef.current = result.state;
              if (result.orbit) cameraRef.current = applyOrbit(cameraRef.current, result.orbit.dx, result.orbit.dy);
              if (result.zoom !== null) cameraRef.current = zoomCamera(cameraRef.current, result.zoom);
              if (gestureRef.current.pointers.length === 0) {
                const hover = selectTapTarget(hitsRef.current, point.x, point.y, sessionRef.current.node, reachableRef.current);
                event.currentTarget.style.cursor = hover ? 'pointer' : 'grab';
              }
            }}
            onPointerLeave={(event) => {
              event.currentTarget.style.cursor = 'grab';
            }}
            onPointerUp={(event) => {
              const point = pointerPosition(event);
              const result = reduceGesture(gestureRef.current, {
                type: 'up', id: event.pointerId, x: point.x, y: point.y,
              });
              gestureRef.current = result.state;
              if (result.tap) handleTap(result.tap.x, result.tap.y);
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={(event) => {
              gestureRef.current = reduceGesture(gestureRef.current, { type: 'cancel', id: event.pointerId }).state;
            }}
            onContextMenu={(event) => event.preventDefault()}
          />
          <div className="illusion-hud" aria-hidden>
            <span>{levelIndex + 1} / {LEVELS.length} · {level.name}</span>
            <span>星核 {session.collected.length} / {coreTotal} · 移动 {session.moves}</span>
          </div>
          {session.complete && (
            <div className="illusion-complete" role="dialog" aria-label="关卡完成">
              <div className="illusion-complete-card">
                <p className="illusion-complete-kicker">{levelIndex === LEVELS.length - 1 ? '群星已经归位' : '遗迹完成共鸣'}</p>
                <h2>{level.name}</h2>
                <p>本关 {earnedStars} / 3 星 · {session.moves} 段移动 · 最短 {par} 段</p>
                <div className="illusion-complete-actions">
                  <button className="btn btn-ghost" onClick={resetLevel}>再走一次</button>
                  {levelIndex < LEVELS.length - 1 && (
                    <button className="btn btn-primary" onClick={() => setLevelIndex(levelIndex + 1)}>下一座遗迹</button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="illusion-panel">
          <div className="illusion-levels" aria-label="选择关卡">
            {LEVELS.map((item, index) => {
              const unlocked = levelUnlocked(index);
              const stars = readBestKey(bestKey(index));
              return (
                <button
                  key={item.id}
                  className={`illusion-level ${index === levelIndex ? 'active' : ''}`}
                  disabled={!unlocked}
                  onClick={() => setLevelIndex(index)}
                  title={unlocked ? item.name : '完成上一关后解锁'}
                >
                  <span>{index + 1}. {unlocked ? item.name : '尚未解锁'}</span>
                  <small>{stars === null ? '未完成' : `${stars} / 3 星`}</small>
                </button>
              );
            })}
          </div>

          <div className="illusion-objective">
            <span className="illusion-panel-label">当前目标</span>
            <strong>{session.collected.length === coreTotal ? '星核已集齐，前往星门' : `收集 ${coreTotal} 枚星核，再抵达星门`}</strong>
            <p>{notice}</p>
          </div>

          <div className="illusion-tools">
            <button className="btn btn-ghost" onClick={showHint} disabled={session.complete}>提示</button>
            <button className="btn btn-ghost" onClick={() => {
              cameraRef.current = makeCamera(levelRef.current);
              setNotice('视角已复位。光桥和行走进度保持不变。');
            }}>视角复位</button>
            <button className="btn btn-ghost" onClick={resetLevel}>重开本关</button>
          </div>

          <div className="illusion-help" id="illusion-help">
            <span>拖动旋转 · 点按移动 · 滚轮 / 双指缩放</span>
            <span>方向键转视角 · N 选目标 · 回车前往 · H 提示 · R 重开</span>
          </div>
        </aside>
      </div>
    </GameShell>
  );
}
