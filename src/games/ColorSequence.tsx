import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useLocalStorage } from '../core/useLocalStorage';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import type { GameMeta } from '../core/types';

export const meta: GameMeta = {
  id: 'color-sequence',
  title: '颜色序列',
  description: '记住颜色块的闪烁顺序！',
  icon: '🎨',
  difficulty: '简单',
  category: '记忆',
  tags: ['序列', '颜色'],
  bestScoreLabel: '最高轮数',
};

const COLORS = [
  { name: '红', color: '#e53935' },
  { name: '橙', color: '#fb8c00' },
  { name: '黄', color: '#fdd835' },
  { name: '绿', color: '#43a047' },
  { name: '蓝', color: '#1e88e5' },
  { name: '紫', color: '#8e24aa' },
];

const SOUNDS = [sfx.click, sfx.flip, sfx.merge, sfx.clear, sfx.move, sfx.drop];

export default function ColorSequence() {
  const [phase, setPhase] = useState<'start' | 'show' | 'input' | 'over'>('start');
  const [sequence, setSequence] = useState<number[]>([]);
  const [inputIdx, setInputIdx] = useState(0);
  const [litIdx, setLitIdx] = useState(-1);
  const [round, setRound] = useState(1);
  const best = useLocalStorage<number>(`best:${meta.id}`);
  const { toast } = useToast();
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  const startGame = useCallback(() => {
    clearTimers();
    setSequence([Math.floor(Math.random() * 6)]);
    setRound(1);
    setPhase('show');
  }, []);

  // 播放序列
  useEffect(() => {
    if (phase !== 'show') return;
    const seq = sequence;
    setLitIdx(-1);
    const delay = Math.max(260, 520 - round * 12);
    seq.forEach((idx, i) => {
      timers.current.push(
        window.setTimeout(() => {
          setLitIdx(idx);
          SOUNDS[idx % SOUNDS.length]();
          timers.current.push(
            window.setTimeout(() => {
              setLitIdx(-1);
              if (i === seq.length - 1) {
                setPhase('input');
                setInputIdx(0);
              }
            }, delay * 0.5),
          );
        }, delay * 1.3 * i + 500),
      );
    });
    return clearTimers;
  }, [phase, sequence, round]);

  const press = (idx: number) => {
    if (phase !== 'input') return;
    SOUNDS[idx % SOUNDS.length]();
    setLitIdx(idx);
    window.setTimeout(() => setLitIdx(-1), 200);
    if (sequence[inputIdx] !== idx) {
      sfx.lose();
      setPhase('over');
      const isNew = best.updateBest(round, (a, b) => a > b);
      if (isNew) {
        sfx.record();
        toast(`新纪录！${round} 轮`, 'record');
      }
      return;
    }
    const next = inputIdx + 1;
    if (next >= sequence.length) {
      const nr = round + 1;
      setRound(nr);
      setSequence((s) => [...s, Math.floor(Math.random() * 6)]);
      setPhase('show');
    } else {
      setInputIdx(next);
    }
  };

  return (
    <GameShell
      meta={meta}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>轮数</span>
            <strong>{round}</strong>
          </div>
          <div className="stat-box">
            <span>进度</span>
            <strong>{phase === 'input' ? `${inputIdx}/${sequence.length}` : phase === 'show' ? '观看中' : '-'}</strong>
          </div>
          <div className="stat-box">
            <span>{meta.bestScoreLabel}</span>
            <strong>{best.value ?? '--'}</strong>
          </div>
        </>
      }
    >
      <div className="cseq">
        <div className="cseq-board">
          {COLORS.map((c, i) => (
            <button
              key={c.name}
              className={`cseq-key ${litIdx === i ? 'lit' : ''}`}
              style={{
                background: c.color,
                boxShadow: litIdx === i ? `0 0 24px ${c.color}` : 'none',
                filter: litIdx === i ? 'brightness(1.5)' : 'brightness(0.9)',
              }}
              onClick={() => press(i)}
              aria-label={c.name}
            />
          ))}
          {phase === 'start' && (
            <div className="arcade-overlay cseq-overlay">
              <h2>🎨 颜色序列</h2>
              <p>记住闪烁顺序并复述，每轮加长！</p>
              <button className="btn btn-primary" onClick={startGame}>
                开始游戏
              </button>
            </div>
          )}
          {phase === 'over' && (
            <div className="arcade-overlay cseq-overlay">
              <h2>💀 记错了！</h2>
              <p>
                坚持了 {round} 轮 · 最佳 {best.value ?? '--'} 轮
              </p>
              <button className="btn btn-primary" onClick={startGame}>
                再来一局
              </button>
            </div>
          )}
        </div>
        <p className="hint">六色块各有音效 · 逐轮加快节奏</p>
      </div>
    </GameShell>
  );
}
