import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaMole } from '../core/gameMetas';



const HOLES = 9;

interface MoleState {
  visible: boolean;
  kind: 'normal' | 'gold' | 'bomb';
  timer: number;
}

function emptyMoles(): MoleState[] {
  // Array.from 生成独立对象（fill 会让 9 个洞共享同一引用）
  return Array.from({ length: HOLES }, () => ({ visible: false, kind: 'normal' as const, timer: 0 }));
}

export default function WhackMole() {
  const [status, setStatus] = useState<'ready' | 'playing' | 'over'>('ready');
  const [score, setScore] = useState(0);
  const [time, setTime] = useState(30);
  const [combo, setCombo] = useState(0);
  const [maxCombo, setMaxCombo] = useState(0);
  const [moles, setMoles] = useState<MoleState[]>(emptyMoles);
  const best = useBestScore(metaMole.id);
  const { toast } = useToast();
  const comboRef = useRef(0);
  const maxComboRef = useRef(0);
  const statusRef = useRef(status);
  const timeRef = useRef(30);

  statusRef.current = status;
  timeRef.current = time;

  const start = useCallback(() => {
    setScore(0);
    setTime(30);
    setCombo(0);
    setMaxCombo(0);
    comboRef.current = 0;
    maxComboRef.current = 0;
    timeRef.current = 30;
    setMoles(emptyMoles());
    setStatus('playing');
  }, []);

  // 倒计时
  useEffect(() => {
    if (status !== 'playing') return;
    const t = window.setInterval(() => {
      if (timeRef.current <= 1) {
        timeRef.current = 0;
        setTime(0);
        setStatus('over');
        sfx.win();
        return;
      }
      timeRef.current -= 1;
      setTime(timeRef.current);
    }, 1000);
    return () => window.clearInterval(t);
  }, [status]);

  // 地鼠生成
  useEffect(() => {
    if (status !== 'playing') return;
    const spawn = () => {
      setMoles((prev) => {
        const next = prev.map((m) => ({ ...m, timer: m.timer - 1 }));
        // 消失
        next.forEach((m, i) => {
          if (m.visible && m.timer <= 0) next[i] = { visible: false, kind: 'normal', timer: 0 };
        });
        // 生成新地鼠（最多同时 2 只）；存活时长：普通 ≈4.2s / 金 ≈3.1s / 炸弹 ≈4.7s
        const visibleCount = next.filter((m) => m.visible).length;
        if (visibleCount < 2) {
          const empty = next.map((m, i) => (m.visible ? -1 : i)).filter((i) => i >= 0);
          if (empty.length > 0) {
            const idx = empty[Math.floor(Math.random() * empty.length)];
            const roll = Math.random();
            const kind = roll < 0.08 ? 'gold' : roll < 0.14 ? 'bomb' : 'normal';
            next[idx] = { visible: true, kind, timer: kind === 'normal' ? 16 : kind === 'gold' ? 12 : 18 };
          }
        }
        return next;
      });
    };
    const t = window.setInterval(spawn, 260);
    return () => window.clearInterval(t);
  }, [status]);

  const whack = (i: number) => {
    if (status !== 'playing') return;
    const m = moles[i];
    if (!m.visible) return;
    // 状态计算与副作用统一放在 updater 之外（StrictMode 下 updater 双执行会导致双倍结算）
    setMoles((prev) => {
      const next = [...prev];
      next[i] = { visible: false, kind: 'normal', timer: 0 };
      return next;
    });
    if (m.kind === 'normal') {
      comboRef.current += 1;
      maxComboRef.current = Math.max(maxComboRef.current, comboRef.current);
      setCombo(comboRef.current);
      setMaxCombo(maxComboRef.current);
      const pts = 10 * Math.min(comboRef.current, 5);
      setScore((s) => s + pts);
      sfx.clear();
    } else if (m.kind === 'gold') {
      comboRef.current += 1;
      maxComboRef.current = Math.max(maxComboRef.current, comboRef.current);
      setCombo(comboRef.current);
      setMaxCombo(maxComboRef.current); // 金地鼠也计入最高连击
      const pts = 50;
      setScore((s) => s + pts);
      sfx.record();
    } else {
      comboRef.current = 0;
      setCombo(0);
      setScore((s) => Math.max(0, s - 20));
      sfx.lose();
    }
  };

  // 结束记录
  useEffect(() => {
    if (status === 'over' && score > 0) {
      const isNew = best.updateBest(score, (a, b) => a > b);
      if (isNew) {
        sfx.record();
        toast(`新纪录！${score} 分`, 'record');
      }
    }
  }, [status, score, best, toast]);

  return (
    <GameShell
      meta={metaMole}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>分数</span>
            <strong>{score}</strong>
          </div>
          <div className="stat-box">
            <span>时间</span>
            <strong>{time}s</strong>
          </div>
          <div className="stat-box">
            <span>连击</span>
            <strong>{combo > 1 ? `${combo}×` : '-'}</strong>
          </div>
          <div className="stat-box">
            <span>{metaMole.bestScoreLabel}</span>
            <strong>{best.value ?? 0}</strong>
          </div>
          <button className="btn btn-primary" onClick={start}>
            🔄 开始
          </button>
        </>
      }
    >
      <div className="mole">
        <div className="mole-field">
          {moles.map((m, i) => (
            <button
              key={i}
              className={`mole-hole ${m.visible ? `active ${m.kind}` : ''}`}
              onClick={() => whack(i)}
              aria-label="地洞"
            >
              {m.visible && (
                <span className={`mole-creature ${m.kind}`}>
                  {m.kind === 'normal' ? '🐭' : m.kind === 'gold' ? '🌟' : '💣'}
                </span>
              )}
            </button>
          ))}
          {status === 'ready' && (
            <div className="arcade-overlay mole-overlay">
              <h2>🔨 打地鼠</h2>
              <p>敲普通地鼠 +10 · 金地鼠 +50 · 炸弹 -20 · 连击最高 ×5</p>
              <button className="btn btn-primary" onClick={start}>
                开始游戏
              </button>
            </div>
          )}
          {status === 'over' && (
            <div className="arcade-overlay mole-overlay">
              <h2>⏱ 时间到！</h2>
              <p>
                得分 {score} · 最高连击 {maxCombo}×
              </p>
              <button className="btn btn-primary" onClick={start}>
                再来一局
              </button>
            </div>
          )}
        </div>
        <p className="hint">快速点击冒头的地鼠 · 连击加分 · 别敲到炸弹 💣</p>
      </div>
    </GameShell>
  );
}
