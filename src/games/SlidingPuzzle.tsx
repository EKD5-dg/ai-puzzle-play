import { useEffect, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import type { GameMeta } from '../core/types';

export const meta: GameMeta = {
  id: 'sliding-puzzle',
  title: '数字华容道',
  description: '滑动方块，按顺序还原数字！',
  icon: '🧩',
  difficulty: '中等',
  category: '逻辑',
  tags: ['滑块', '排序'],
  bestScoreLabel: '最少步数',
};

const LEVELS = [
  { label: '3×3', size: 3 },
  { label: '4×4', size: 4 },
  { label: '5×5', size: 5 },
];

type Board = number[]; // 0 代表空格

/** 通过多次合法滑动生成可解局面 */
function shuffleBoard(size: number): Board {
  const total = size * size;
  const board: Board = Array.from({ length: total }, (_, i) => i);
  let blank = total - 1;
  let lastDir = '';
  for (let step = 0; step < total * 60; step++) {
    const dirs: Array<[number, string]> = [];
    const r = Math.floor(blank / size);
    const c = blank % size;
    if (r > 0) dirs.push([blank - size, 'u']);
    if (r < size - 1) dirs.push([blank + size, 'd']);
    if (c > 0) dirs.push([blank - 1, 'l']);
    if (c < size - 1) dirs.push([blank + 1, 'r']);
    const choices = dirs.filter(([, d]) => d !== (lastDir === 'u' ? 'd' : lastDir === 'd' ? 'u' : lastDir === 'l' ? 'r' : lastDir === 'r' ? 'l' : ''));
    const [target, d] = choices[Math.floor(Math.random() * choices.length)] ?? dirs[0];
    [board[blank], board[target]] = [board[target], board[blank]];
    blank = target;
    lastDir = d;
  }
  return board;
}

function isSolved(board: Board): boolean {
  return board.every((v, i) => v === i);
}

export default function SlidingPuzzle() {
  const [sizeIdx, setSizeIdx] = useState(1);
  const size = LEVELS[sizeIdx].size;
  const [board, setBoard] = useState<Board>(() => shuffleBoard(LEVELS[1].size));
  const [moves, setMoves] = useState(0);
  const [won, setWon] = useState(false);
  const best = useBestScore(meta.id);
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
      const isNew = best.updateBest(moves + 1, (a, b) => a < b);
      if (isNew) {
        sfx.record();
        toast(`新纪录！${moves + 1} 步完成`, 'record');
      }
    }
  };

  // 通关后记录最佳步数（兜底，move 内已处理）
  useEffect(() => {
    if (won && moves > 0) best.updateBest(moves, (a, b) => a < b);
  }, [won, moves, best]);

  const tileSize = size === 5 ? 72 : size === 4 ? 92 : 108;
  const pad = 3; // 内边距偏移

  return (
    <GameShell
      meta={meta}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>步数</span>
            <strong>{moves}</strong>
          </div>
          <div className="stat-box">
            <span>{meta.bestScoreLabel}</span>
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
        <p className="hint">点击空格旁边的数字方块进行滑动</p>
      </div>
    </GameShell>
  );
}
