import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaSimon } from '../core/gameMetas';



const COLORS = [
  { name: '红', color: '#e53935', glow: '#ff8a80' },
  { name: '蓝', color: '#1e88e5', glow: '#90caf9' },
  { name: '绿', color: '#43a047', glow: '#a5d6a7' },
  { name: '黄', color: '#fdd835', glow: '#fff59d' },
];

const SOUNDS = [sfx.click, sfx.flip, sfx.merge, sfx.clear];

export default function Simon() {
  const [phase, setPhase] = useState<'start' | 'show' | 'input' | 'over'>('start');
  const [sequence, setSequence] = useState<number[]>([]);
  const [inputIdx, setInputIdx] = useState(0);
  const [litIdx, setLitIdx] = useState(-1); // 当前高亮的键
  const [round, setRound] = useState(1);
  const [bestRound, setBestRound] = useState(0);
  const best = useBestScore(metaSimon.id);
  const { toast } = useToast();
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  const startGame = useCallback(() => {
    clearTimers();
    setSequence([Math.floor(Math.random() * 4)]);
    setRound(1);
    setPhase('show');
  }, []);

  /** 播放序列 */
  useEffect(() => {
    if (phase !== 'show') return;
    const seq = sequence;
    setLitIdx(-1);
    const delay = Math.max(300, 620 - round * 20); // 逐轮加快
    seq.forEach((idx, i) => {
      timers.current.push(
        window.setTimeout(() => {
          setLitIdx(idx);
          SOUNDS[idx]();
          timers.current.push(
            window.setTimeout(() => {
              setLitIdx(-1);
              if (i === seq.length - 1) {
                setPhase('input');
                setInputIdx(0);
              }
            }, delay * 0.6),
          );
        }, delay * 1.4 * i + 600),
      );
    });
    return clearTimers;
  }, [phase, sequence, round]);

  const press = (idx: number) => {
    if (phase !== 'input') return;
    SOUNDS[idx]();
    setLitIdx(idx);
    timers.current.push(window.setTimeout(() => setLitIdx(-1), 220));
    if (sequence[inputIdx] !== idx) {
      sfx.lose();
      setPhase('over');
      if (round > bestRound) {
        setBestRound(round);
        best.updateBest(round, (a, b) => a > b);
        sfx.record();
        toast(`新纪录！${round} 轮`, 'record');
      }
      return;
    }
    const next = inputIdx + 1;
    if (next >= sequence.length) {
      // 本轮完成
      const nr = round + 1;
      setRound(nr);
      setSequence((s) => [...s, Math.floor(Math.random() * 4)]);
      setPhase('show');
    } else {
      setInputIdx(next);
    }
  };

  return (
    <GameShell
      meta={metaSimon}
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
            <span>{metaSimon.bestScoreLabel}</span>
            <strong>{best.value ?? '--'}</strong>
          </div>
        </>
      }
    >
      <div className="simon">
        <div className={`simon-board ${phase === 'show' ? 'showing' : ''}`}>
          {COLORS.map((c, i) => (
            <button
              key={c.name}
              className={`simon-key ${litIdx === i ? 'lit' : ''}`}
              style={{
                background: litIdx === i ? c.glow : c.color,
                boxShadow: litIdx === i ? `0 0 30px ${c.glow}` : 'none',
              }}
              onClick={() => press(i)}
              aria-label={c.name}
            />
          ))}
          <div className="simon-center">
            <strong>{phase === 'input' ? sequence.length : round}</strong>
          </div>
          {phase === 'start' && (
            <div className="arcade-overlay simon-overlay">
              <h2>🎛️ 西蒙说</h2>
              <p>记住闪灯顺序并复述，每轮加长！</p>
              <button className="btn btn-primary" onClick={startGame}>
                开始游戏
              </button>
            </div>
          )}
          {phase === 'over' && (
            <div className="arcade-overlay simon-overlay">
              <h2>💀 记错了！</h2>
              <p>
                坚持了 {round} 轮 · 最佳 {bestRound || best.value || '--'} 轮
              </p>
              <button className="btn btn-primary" onClick={startGame}>
                再来一局
              </button>
            </div>
          )}
        </div>
        <p className="hint">四色按键各有专属音效 · 逐轮加快节奏</p>
      </div>
    </GameShell>
  );
}
