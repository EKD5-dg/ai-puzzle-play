import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaDigit } from '../core/gameMetas';



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
  /** 通关后进入下一轮的过渡定时器（重开/卸载时清除） */
  const transitionRef = useRef<number | null>(null);
  const best = useBestScore(metaDigit.id);
  const { toast } = useToast();

  const clearTransition = () => {
    if (transitionRef.current !== null) {
      window.clearTimeout(transitionRef.current);
      transitionRef.current = null;
    }
  };

  // 卸载时清理过渡定时器
  useEffect(
    () => () => {
      if (transitionRef.current !== null) window.clearTimeout(transitionRef.current);
    },
    [],
  );

  const startGame = useCallback(() => {
    clearTransition();
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

  /** 输入完成后的统一判定（数字键输满自动触发，✓ 按钮手动触发） */
  const finishInput = (next: string) => {
    // 过渡定时器挂起期间拦截重复提交（连点 ✓ / 自动判定后手点）
    if (transitionRef.current !== null) return;
    if (next === answer) {
      sfx.merge();
      const nl = len + 1;
      transitionRef.current = window.setTimeout(() => {
        transitionRef.current = null;
        setLen(nl);
        setAnswer(genNumber(nl));
        setInput('');
        setPhase('show');
      }, 400);
    } else {
      // 错误分支：清掉可能挂起的过渡定时器，避免旧 timer 把失败"复活"到下一轮
      clearTransition();
      sfx.lose();
      setPhase('over');
      const isNew = best.updateBest(len - 1, (a, b) => a > b);
      if (isNew) {
        sfx.record();
        toast(`新纪录！记住 ${len - 1} 位数字`, 'record');
      }
    }
  };

  const pressDigit = (d: string) => {
    if (phase !== 'input') return;
    if (input.length >= answer.length) return;
    sfx.click();
    const next = input + d;
    setInput(next);
    if (next.length === answer.length) finishInput(next);
  };

  /** 确认当前输入（输满时可用） */
  const submit = () => {
    if (phase !== 'input') return;
    if (input.length === answer.length) finishInput(input);
  };

  const backspace = () => {
    if (phase !== 'input') return;
    setInput((s) => s.slice(0, -1));
  };

  // 实体键盘支持（不设依赖数组：每次渲染重绑保证读到最新 input/phase 闭包）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        pressDigit(e.key);
      }
      if (e.key === 'Backspace') {
        e.preventDefault(); // 阻止页面后退
        backspace();
      }
      if (e.key === 'Enter' && (phase === 'start' || phase === 'over')) {
        e.preventDefault();
        startGame();
      }
      if (e.key === ' ') {
        e.preventDefault(); // 阻止页面滚动（所有阶段）
        if (phase === 'start' || phase === 'over') startGame();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <GameShell
      meta={metaDigit}
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
            <span>{metaDigit.bestScoreLabel}</span>
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
                onClick={() => (k === '⌫' ? backspace() : k === '✓' ? submit() : pressDigit(k))}
                disabled={k === '✓' && input.length !== answer.length}
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
