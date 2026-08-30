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
  /** 消失时刻（performance.now 时间戳）：tick 计数在浏览器节流时会被拉长 */
  until: number;
}

function emptyMoles(): MoleState[] {
  // Array.from 生成独立对象（fill 会让 9 个洞共享同一引用）
  return Array.from({ length: HOLES }, () => ({ visible: false, kind: 'normal' as const, until: 0 }));
}

export default function WhackMole() {
  const [status, setStatus] = useState<'ready' | 'playing' | 'paused' | 'over'>('ready');
  const [score, setScore] = useState(0);
  const [time, setTime] = useState(30);
  const [combo, setCombo] = useState(0);
  const [maxCombo, setMaxCombo] = useState(0);
  const [moles, setMoles] = useState<MoleState[]>(emptyMoles);
  const best = useBestScore(metaMole.id);
  const { toast } = useToast();
  const comboRef = useRef(0);
  const maxComboRef = useRef(0);
  const timeRef = useRef(30);
  /** 本轮截止时刻（performance.now）：倒计时以墙钟为准，不靠 tick 累减 */
  const endTimeRef = useRef(0);

  timeRef.current = time;

  // 切后台自动暂停：限时游戏后台照跑倒计时，切回时间已大量流逝
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') setStatus((s) => (s === 'playing' ? 'paused' : s));
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

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

  // 倒计时（按真实时间计算：setInterval 被节流时 tick 累减会与墙钟漂移）
  useEffect(() => {
    if (status !== 'playing') return;
    // 暂停恢复后从剩余秒数续算（time 是整秒，误差 <1s）
    endTimeRef.current = performance.now() + timeRef.current * 1000;
    const t = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((endTimeRef.current - performance.now()) / 1000));
      if (left === timeRef.current) return;
      timeRef.current = left;
      setTime(left);
      if (left <= 0) {
        setStatus('over');
        sfx.win();
      }
    }, 200);
    return () => window.clearInterval(t);
  }, [status]);

  // 地鼠生成
  useEffect(() => {
    if (status !== 'playing') return;
    const spawn = () => {
      // now 在 updater 外取一次：updater 需保持纯函数（StrictMode 下会双执行）
      const now = performance.now();
      setMoles((prev) => {
        const next = [...prev];
        // 消失（按到期时间戳判定，存活时长不再受 tick 节流影响）
        next.forEach((m, i) => {
          if (m.visible && m.until <= now) next[i] = { visible: false, kind: 'normal', until: 0 };
        });
        // 生成新地鼠（最多同时 2 只）；存活时长：普通 ≈4.2s / 金 ≈3.1s / 炸弹 ≈4.7s
        const visibleCount = next.filter((m) => m.visible).length;
        if (visibleCount < 2) {
          const empty = next.map((m, i) => (m.visible ? -1 : i)).filter((i) => i >= 0);
          if (empty.length > 0) {
            const idx = empty[Math.floor(Math.random() * empty.length)];
            const roll = Math.random();
            const kind = roll < 0.08 ? 'gold' : roll < 0.14 ? 'bomb' : 'normal';
            const life = kind === 'normal' ? 4160 : kind === 'gold' ? 3120 : 4680;
            next[idx] = { visible: true, kind, until: now + life };
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
      next[i] = { visible: false, kind: 'normal', until: 0 };
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
          {/* 游玩中变身"暂停"：常驻的开始按钮会误点清分（重开入口在 ready/over 覆盖层） */}
          <button
            className="btn btn-primary"
            onClick={() => (status === 'playing' ? setStatus('paused') : start())}
          >
            {status === 'playing' ? '⏸ 暂停' : '🔄 开始'}
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
          {status === 'paused' && (
            <div className="arcade-overlay mole-overlay">
              <h2>⏸ 已暂停</h2>
              <button className="btn btn-primary" onClick={() => setStatus('playing')}>
                继续
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
