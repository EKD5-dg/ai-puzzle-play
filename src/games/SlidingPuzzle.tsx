import { useEffect, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaSliding } from '../core/gameMetas';



const LEVELS = [
  { label: '3×3', size: 3 },
  { label: '4×4', size: 4 },
  { label: '5×5', size: 5 },
];

type Board = number[]; // 0 代表空格

/** 目标布局：1..N-1 顺序排列，空格在右下角（玩家常识布局） */
function goalBoard(size: number): Board {
  const total = size * size;
  return Array.from({ length: total }, (_, i) => (i + 1) % total);
}

/** 从目标态沿真实空格做随机合法滑动打乱——每步都是可逆的合法移动，生成的局面必然可解 */
function shuffleBoard(size: number): Board {
  const total = size * size;
  const board = goalBoard(size);
  let blank = total - 1;
  let lastBlank = -1;
  for (let step = 0; step < total * 60; step++) {
    const r = Math.floor(blank / size);
    const c = blank % size;
    const neighbors: number[] = [];
    if (r > 0) neighbors.push(blank - size);
    if (r < size - 1) neighbors.push(blank + size);
    if (c > 0) neighbors.push(blank - 1);
    if (c < size - 1) neighbors.push(blank + 1);
    const choices = neighbors.filter((n) => n !== lastBlank);
    const target = choices[Math.floor(Math.random() * choices.length)];
    [board[blank], board[target]] = [board[target], board[blank]];
    lastBlank = blank;
    blank = target;
  }
  // 极小概率洗回原样时重洗一次
  if (isSolved(board)) return shuffleBoard(size);
  return board;
}

function isSolved(board: Board): boolean {
  return board.every((v, i) => v === goalBoard(Math.round(Math.sqrt(board.length)))[i]);
}

export default function SlidingPuzzle() {
  const [sizeIdx, setSizeIdx] = useState(1);
  const size = LEVELS[sizeIdx].size;
  const [board, setBoard] = useState<Board>(() => shuffleBoard(LEVELS[1].size));
  const [moves, setMoves] = useState(0);
  const [won, setWon] = useState(false);
  // 窄屏（≤640px）缩小方块尺寸，避免棋盘溢出 375px 视口
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 640);
  const best = useBestScore(metaSliding.id);
  const { toast } = useToast();

  const startNew = (idx: number) => {
    setSizeIdx(idx);
    setBoard(shuffleBoard(LEVELS[idx].size));
    setMoves(0);
    setWon(false);
  };

  const move = (index: number) => {
    if (won) return;
    const blank = board.indexOf(0);
    const r1 = Math.floor(index / size);
    const c1 = index % size;
    const r2 = Math.floor(blank / size);
    const c2 = blank % size;
    const adjacent = Math.abs(r1 - r2) + Math.abs(c1 - c2) === 1;
    if (!adjacent) return;
    sfx.move();
    const next = [...board];
    [next[index], next[blank]] = [next[blank], next[index]];
    setBoard(next);
    setMoves((m) => m + 1);
    if (isSolved(next)) {
      setWon(true);
      sfx.win();
    }
  };

  // 通关后结算一次最佳步数（won 翻转时 moves 已是最新值，避免与 move 内双通道重复）
  useEffect(() => {
    if (!won) return;
    const isNew = best.updateBest(moves, (a, b) => a < b);
    if (isNew) {
      sfx.record();
      toast(`新纪录！${moves} 步完成`, 'record');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [won]);

  // 转屏/改窗口只动视口不动状态，需订阅 resize 重新计算 narrow
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const tileSize = size === 5 ? (narrow ? 58 : 72) : size === 4 ? (narrow ? 78 : 92) : narrow ? 94 : 108;
  const pad = 3; // 内边距偏移

  return (
    <GameShell
      meta={metaSliding}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>步数</span>
            <strong>{moves}</strong>
          </div>
          <div className="stat-box">
            <span>{metaSliding.bestScoreLabel}</span>
            <strong>{best.value ?? '--'}</strong>
          </div>
          <button className="btn btn-primary" onClick={() => startNew(sizeIdx)}>
            🔀 重新洗牌
          </button>
        </>
      }
    >
      <div className="sliding">
        <div className="level-bar">
          {LEVELS.map((lv, i) => (
            <button
              key={lv.label}
              className={`btn ${i === sizeIdx ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => startNew(i)}
            >
              {lv.label}
            </button>
          ))}
        </div>
        {won && (
          <div className="banner won">🎉 恭喜还原！用了 {moves} 步</div>
        )}
        <div
          className="sliding-board"
          style={{ width: size * tileSize + pad * 2, height: size * tileSize + pad * 2 }}
        >
          {board.map((v, i) =>
            v !== 0 ? (
              <button
                key={v}
                className={`sliding-tile ${won ? 'done' : ''}`}
                style={{
                  width: tileSize - 6,
                  height: tileSize - 6,
                  fontSize: tileSize * 0.38,
                  transform: `translate(${(i % size) * tileSize + pad}px, ${Math.floor(i / size) * tileSize + pad}px)`,
                }}
                onClick={() => move(i)}
              >
                {v}
              </button>
            ) : null,
          )}
        </div>
        <p className="hint">玩法：点击空格旁边的数字方块滑动它，把 1~{size * size - 1} 按顺序排好、空格回到右下角即通关</p>
      </div>
    </GameShell>
  );
}
