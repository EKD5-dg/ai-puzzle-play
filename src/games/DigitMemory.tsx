import { useCallback, useEffect, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import type { GameMeta } from '../core/types';

export const meta: GameMeta = {
  id: 'digit-memory',
  title: '数字记忆',
  description: '记住数字序列，按顺序点出来！',
  icon: '🔢',
  difficulty: '简单',
  category: '记忆',
  tags: ['数字', '训练'],
  bestScoreLabel: '最高位数',
};

function genNumber(len: number): string {
  // 首位不为 0
  let s = String(Math.floor(Math.random() * 9) + 1);
  for (let i = 1; i < len; i++) s += Math.floor(Math.random() * 10);
  return s;
}

export default function DigitMemory() {
  const [phase, setPhase] = useState<'start' | 'show' | 'input' | 'over'>('start');
  const [answer, setAnswer] = useState('');
  const [input, setInput] = useState('');
  const [len, setLen] = useState(3);
  const best = useBestScore(meta.id);
  const { toast } = useToast();

  const startGame = useCallback(() => {
    const a = genNumber(3);
    setAnswer(a);
    setInput('');
    setLen(3);
    setPhase('show');
  }, []);

  // 显示阶段：2 秒后进入输入
  useEffect(() => {
    if (phase !== 'show') return;
    const t = window.setTimeout(() => {
      sfx.flip();
      setPhase('input');
    }, 2200);
    return () => window.clearTimeout(t);
  }, [phase]);

  const pressDigit = (d: string) => {
    if (phase !== 'input') return;
    if (input.length >= answer.length) return;
    sfx.click();
    const next = input + d;
    setInput(next);
    if (next.length === answer.length) {
      if (next === answer) {
        sfx.merge();
        const nl = len + 1;
        window.setTimeout(() => {
          setLen(nl);
          setAnswer(genNumber(nl));
          setInput('');
          setPhase('show');
        }, 400);
      } else {
        sfx.lose();
        setPhase('over');
        const isNew = best.updateBest(len - 1, (a, b) => a > b);
        if (isNew) {
          sfx.record();
          toast(`新纪录！记住 ${len - 1} 位数字`, 'record');
        }
      }
    }
  };

  const backspace = () => {
    if (phase !== 'input') return;
    setInput((s) => s.slice(0, -1));
  };

  // 实体键盘支持
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') pressDigit(e.key);
      if (e.key === 'Backspace') backspace();
      if (e.key === 'Enter' && (phase === 'start' || phase === 'over')) startGame();
      if (e.key === ' ' && (phase === 'start' || phase === 'over')) startGame();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <GameShell
      meta={meta}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>位数</span>
            <strong>{len}</strong>
          </div>
          <div className="stat-box">
            <span>已输入</span>
            <strong>{input.length}/{answer.length}</strong>
          </div>
          <div className="stat-box">
            <span>{meta.bestScoreLabel}</span>
            <strong>{best.value ?? '--'}</strong>
          </div>
        </>
      }
    >
      <div className="digit">
        <div className="digit-screen">
          {phase === 'show' && (
            <>
              <span className="digit-label">记住这组数字：</span>
              <span className="digit-num">{answer}</span>
            </>
          )}
          {phase === 'input' && (
            <>
              <span className="digit-label">按顺序输入：</span>
              <span className={`digit-num ${input.length === answer.length ? (input === answer ? 'ok' : 'bad') : ''}`}>
                {input.padEnd(answer.length, '·')}
              </span>
            </>
          )}
          {phase === 'start' && (
            <div className="arcade-overlay digit-overlay">
              <h2>🔢 数字记忆</h2>
              <p>从 3 位开始，记住数字并输入，每轮 +1 位</p>
              <button className="btn btn-primary" onClick={startGame}>
                开始游戏
              </button>
            </div>
          )}
          {phase === 'over' && (
            <div className="arcade-overlay digit-overlay">
              <h2>💀 记错了！</h2>
              <p>
                正确答案 {answer} · 你记住了 {len - 1} 位
              </p>
              <button className="btn btn-primary" onClick={startGame}>
                再来一局
              </button>
            </div>
          )}
        </div>
        {phase === 'input' && (
          <div className="digit-pad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].map((k) => (
              <button
                key={k}
                className="btn num-btn digit-key"
                onClick={() => (k === '⌫' ? backspace() : k === '✓' ? undefined : pressDigit(k))}
                disabled={k === '✓'}
              >
                {k}
              </button>
            ))}
          </div>
        )}
        <p className="hint">实体键盘 0-9 也可输入 · 数字显示 2 秒后隐藏</p>
      </div>
    </GameShell>
  );
}
