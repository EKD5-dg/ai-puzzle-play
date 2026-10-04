import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaColorSeq } from '../core/gameMetas';



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
  const best = useBestScore(metaColorSeq.id);
  const { toast } = useToast();
  const timers = useRef<number[]>([]);
  /** inputIdx 的实时镜像：同一 tick 内连点时渲染闭包里的 inputIdx 已过期，判定必须读 ref
   *  （Simon 早有这道守卫，这里漏了：旧值会把序列长度多追加一条、轮数与长度永久错位） */
  const inputIdxRef = useRef(0);
  /** phase 的实时镜像：visibilitychange 回调里要读当前阶段 */
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  /** 重播计数：切后台回来时自增，让播放 effect 从头重放这一轮 */
  const [replayNonce, setReplayNonce] = useState(0);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  // 切后台/锁屏时播放链会被定时器节流吞掉，回来时已进入输入阶段、玩家没见过序列只能盲按：
  // 隐藏时停播，回到前台把这一轮从头重播
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') clearTimers();
      else if (phaseRef.current === 'show') setReplayNonce((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

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
                inputIdxRef.current = 0;
              }
            }, delay * 0.5),
          );
        }, delay * 1.3 * i + 500),
      );
    });
    return clearTimers;
  }, [phase, sequence, round, replayNonce]);

  const press = (idx: number) => {
    if (phase !== 'input') return;
    SOUNDS[idx % SOUNDS.length]();
    setLitIdx(idx);
    timers.current.push(window.setTimeout(() => setLitIdx(-1), 200));
    const cur = inputIdxRef.current;
    if (sequence[cur] !== idx) {
      sfx.lose();
      setPhase('over');
      // round 在完成本轮时才 +1，失败时已完成轮数为 round - 1；首轮即败不写纪录
      const cleared = round - 1;
      if (cleared > 0) {
        const isNew = best.updateBest(cleared, (a, b) => a > b);
        if (isNew) {
          sfx.record();
          toast(`新纪录！${cleared} 轮`, 'record');
        }
      }
      return;
    }
    const next = cur + 1;
    inputIdxRef.current = next;
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
      meta={metaColorSeq}
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
            <span>{metaColorSeq.bestScoreLabel}</span>
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
                完成 {round - 1} 轮 · 最佳 {best.value ?? '--'} 轮
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
