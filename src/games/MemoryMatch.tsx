import { useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaMemory } from '../core/gameMetas';



const EMOJIS = ['🍎', '🍌', '🍇', '🍉', '🍒', '🍓', '🥝', '🍍', '🥑', '🍑', '🥥', '🍋'];

interface Level {
  label: string;
  pairs: number;
}

const LEVELS: Level[] = [
  { label: '简单 4×3', pairs: 6 },
  { label: '中等 4×4', pairs: 8 },
  { label: '困难 6×4', pairs: 12 },
];

interface Card {
  id: number;
  emoji: string;
  matched: boolean;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck(pairs: number): Card[] {
  const emojis = shuffle(EMOJIS).slice(0, pairs);
  const cards: Card[] = shuffle(
    [...emojis, ...emojis].map((emoji, i) => ({ id: i, emoji, matched: false })),
  );
  return cards;
}

export default function MemoryMatch() {
  const [levelIdx, setLevelIdx] = useState(1);
  const [deck, setDeck] = useState<Card[]>(() => buildDeck(LEVELS[1].pairs));
  const [flipped, setFlipped] = useState<number[]>([]); // 当前翻开（未配对）的卡 id
  const [moves, setMoves] = useState(0);
  const [time, setTime] = useState(0);
  const [won, setWon] = useState(false);
  const [mismatchIds, setMismatchIds] = useState<number[]>([]); // 配对失败的卡（抖动）
  /** 是否已开始（首次翻牌起计时，含翻牌过程） */
  const [started, setStarted] = useState(false);
  const lockRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  /** 计时起点时间戳（首次翻牌写入）：用真实时间差算用时，避免 setInterval 被后台节流少计 */
  const startRef = useRef<number | null>(null);
  const mismatchTimerRef = useRef<number | null>(null);
  /** flipped 的实时镜像：连点第三张卡的防御守卫 */
  const flippedRef = useRef<number[]>([]);
  flippedRef.current = flipped;
  const best = useBestScore(`${metaMemory.id}:${levelIdx}`);
  const { toast } = useToast();

  // 计时（首次翻牌开始，胜利停止）
  useEffect(() => {
    if (!started || won) return;
    if (startRef.current === null) startRef.current = Date.now();
    const start = startRef.current;
    const tick = () => setTime(Math.floor((Date.now() - start) / 1000));
    tick();
    timerRef.current = window.setInterval(tick, 500);
    return () => {
      tick(); // 停止瞬间补一次，避免显示滞后一个刷新周期
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [started, won]);

  // 翻牌配对检测
  useEffect(() => {
    if (flipped.length !== 2) return;
    lockRef.current = true;
    const [a, b] = flipped;
    const cardA = deck.find((c) => c.id === a);
    const cardB = deck.find((c) => c.id === b);
    if (cardA && cardB && cardA.emoji === cardB.emoji) {
      sfx.match();
      setDeck((prev) =>
        prev.map((c) => (c.id === a || c.id === b ? { ...c, matched: true } : c)),
      );
      setFlipped([]);
      lockRef.current = false;
    } else {
      sfx.mismatch();
      setMismatchIds([a, b]);
      // 定时器受 ref 管理：重开/卸载时清除，避免旧定时器强制合上新一局的牌
      mismatchTimerRef.current = window.setTimeout(() => {
        mismatchTimerRef.current = null;
        setFlipped([]);
        setMismatchIds([]);
        lockRef.current = false;
      }, 900);
    }
  }, [flipped, deck]);

  // 卸载时清理所有定时器
  useEffect(
    () => () => {
      if (mismatchTimerRef.current !== null) window.clearTimeout(mismatchTimerRef.current);
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    },
    [],
  );

  // 胜利判定
  useEffect(() => {
    if (deck.length > 0 && deck.every((c) => c.matched) && !won) {
      setWon(true);
      sfx.win();
      const isNew = best.updateBest(moves, (a, b) => a < b);
      if (isNew) {
        sfx.record();
        toast(`新纪录！${moves} 步完成`, 'record');
      }
    }
  }, [deck, won, moves, best, toast]);

  const startNew = (idx: number) => {
    // 对局中途切换难度会清空当前盘面，先二次确认
    if (started && !won && !window.confirm(`当前对局进行中，切换到${LEVELS[idx].label}将重新开始，确定吗？`)) return;
    if (mismatchTimerRef.current !== null) {
      window.clearTimeout(mismatchTimerRef.current);
      mismatchTimerRef.current = null;
    }
    setLevelIdx(idx);
    setDeck(buildDeck(LEVELS[idx].pairs));
    setFlipped([]);
    flippedRef.current = [];
    setMoves(0);
    setTime(0);
    startRef.current = null;
    setWon(false);
    setStarted(false);
    lockRef.current = false;
  };

  const flip = (card: Card) => {
    if (lockRef.current || won || card.matched) return;
    // 用实时镜像守卫，连点不会出现第三张卡或重复计数
    const cur = flippedRef.current;
    if (cur.includes(card.id) || cur.length >= 2) return;
    sfx.flip();
    const next = [...cur, card.id];
    flippedRef.current = next;
    setFlipped(next);
    if (cur.length === 1) setMoves((m) => m + 1);
    if (!started) setStarted(true);
  };

  const cols = LEVELS[levelIdx].pairs === 12 ? 6 : 4;

  return (
    <GameShell
      meta={metaMemory}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>步数</span>
            <strong>{moves}</strong>
          </div>
          <div className="stat-box">
            <span>时间</span>
            <strong>{time}s</strong>
          </div>
          <div className="stat-box">
            <span>{metaMemory.bestScoreLabel}</span>
            <strong>{best.value ?? '--'}</strong>
          </div>
        </>
      }
    >
      <div className="memory">
        <div className="level-bar">
          {LEVELS.map((lv, i) => (
            <button
              key={lv.label}
              className={`btn ${i === levelIdx ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => startNew(i)}
            >
              {lv.label}
            </button>
          ))}
        </div>
        {won && (
          <div className="banner won">
            🎉 全部配对成功！用了 {moves} 步，{time}s
          </div>
        )}
        <div
          className="memory-grid"
          style={{ gridTemplateColumns: `repeat(${cols}, var(--card, 88px))` }}
        >
          {deck.map((card) => {
            const isUp = card.matched || flipped.includes(card.id);
            return (
              <button
                key={card.id}
                className={`memory-card ${isUp ? 'up' : ''} ${card.matched ? 'matched' : ''} ${mismatchIds.includes(card.id) ? 'mismatch' : ''}`}
                onClick={() => flip(card)}
                disabled={isUp || lockRef.current || won}
                aria-label={isUp ? `${card.emoji}，已${card.matched ? '配对' : '翻开'}` : '未翻开的牌'}
              >
                <span className="memory-face memory-back">❓</span>
                <span className="memory-face memory-front">{card.emoji}</span>
              </button>
            );
          })}
        </div>
        <p className="hint">翻出相同图案即配对 · 步数越少纪录越好 · 三个难度分别保存纪录</p>
      </div>
    </GameShell>
  );
}
