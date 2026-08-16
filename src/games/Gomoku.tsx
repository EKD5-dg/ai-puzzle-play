import { useCallback, useEffect, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { useBestScore } from '../core/sync';
import { metaGomoku } from '../core/gameMetas';



const SIZE = 15;
type Cell = 0 | 1 | 2; // 0 空 1 黑(玩家) 2 白(AI)
type Board = Cell[];

const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

/** 沿方向数 (x,y) 处棋子 p 的连子数与开放端，返回 [连子数, 开放端数]（调用前需保证 (x,y) 是 p） */
function lineCount(board: Board, x: number, y: number, dx: number, dy: number, p: 1 | 2): [number, number] {
  if (board[y * SIZE + x] !== p) return [0, 0]; // (x,y) 不是 p（如防守评估时该点已被对方占用）
  let count = 1;
  let openEnds = 0;
  for (const sign of [1, -1]) {
    let n = 0;
    for (let k = 1; k <= 4; k++) {
      const nx = x + dx * k * sign;
      const ny = y + dy * k * sign;
      if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) break;
      const v = board[ny * SIZE + nx];
      if (v === p) n++;
      else {
        if (v === 0) openEnds++;
        break;
      }
    }
    count += n;
  }
  return [Math.min(count, 5), openEnds];
}

/** 连子数+开放端 → 分值（进攻/防守共用同一张表） */
const LINE_WEIGHTS: Record<number, Record<number, number>> = {
  5: { 0: 100000, 1: 100000, 2: 100000 },
  4: { 2: 50000, 1: 10000 }, // 活四 / 冲四
  3: { 2: 5000, 1: 500 }, // 活三 / 眠三
  2: { 2: 300, 1: 50 }, // 活二 / 眠二
  1: { 2: 10, 1: 2 },
};

/** 评估在 (x,y) 落 me 一子后的局面价值（进攻 + 0.9 倍防守，双向评分） */
function evaluate(board: Board, x: number, y: number, me: 1 | 2): number {
  const opp = me === 1 ? 2 : 1;
  // 进攻：模拟己方在此落子
  const b1 = [...board];
  b1[y * SIZE + x] = me;
  let s = 0;
  for (const [dx, dy] of DIRECTIONS) {
    const [cnt, open] = lineCount(b1, x, y, dx, dy, me);
    s += LINE_WEIGHTS[cnt]?.[open] ?? 0;
  }
  // 防守：模拟对方在此落子（堵住该点的价值，0.45 倍权重——预防性防守低于主动进攻）
  const b2 = [...board];
  b2[y * SIZE + x] = opp;
  for (const [dx, dy] of DIRECTIONS) {
    const [ocnt, oopen] = lineCount(b2, x, y, dx, dy, opp);
    s += (LINE_WEIGHTS[ocnt]?.[oopen] ?? 0) * 0.45;
  }
  // 位置偏好：靠近中心更好
  const center = (SIZE - 1) / 2;
  s += (12 - Math.abs(x - center) - Math.abs(y - center)) * 5;
  return s;
}

function emptyBoard(): Board {
  return Array(SIZE * SIZE).fill(0) as Board;
}

function findBestMove(board: Board, me: 1 | 2): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (board[i] !== 0) continue;
    const s = evaluate(board, i % SIZE, Math.floor(i / SIZE), me);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

function checkWin(board: Board, last: number): boolean {
  const me = board[last];
  if (me === 0) return false;
  const x = last % SIZE;
  const y = Math.floor(last / SIZE);
  for (const [dx, dy] of DIRECTIONS) {
    let count = 1;
    for (let k = 1; k < 5; k++) {
      const nx = x + dx * k;
      const ny = y + dy * k;
      if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE || board[ny * SIZE + nx] !== me) break;
      count++;
    }
    for (let k = 1; k < 5; k++) {
      const nx = x - dx * k;
      const ny = y - dy * k;
      if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE || board[ny * SIZE + nx] !== me) break;
      count++;
    }
    if (count >= 5) return true;
  }
  return false;
}

export default function Gomoku() {
  const [board, setBoard] = useState<Board>(emptyBoard);
  const [turn, setTurn] = useState<'player' | 'ai'>('player');
  const [winner, setWinner] = useState<0 | 1 | 2 | 3>(0);
  /** 最后一手下标：胜负判定只检查这一手（此前按最大下标检查会漏判） */
  const [lastMove, setLastMove] = useState(-1);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [streak, setStreak] = useState(0);
  const [thinking, setThinking] = useState(false);
  const { toast } = useToast();
  const best = useBestScore(metaGomoku.id);

  const reset = useCallback(() => {
    setBoard(emptyBoard());
    setTurn('player');
    setWinner(0);
    setLastMove(-1);
    setThinking(false);
  }, []);

  // AI 回合
  useEffect(() => {
    if (turn !== 'ai' || winner !== 0) return;
    setThinking(true);
    const t = window.setTimeout(() => {
      const move = findBestMove(board, 2);
      if (move < 0) {
        setThinking(false);
        return;
      }
      sfx.drop();
      setBoard((prev) => {
        const next = [...prev];
        next[move] = 2;
        return next;
      });
      setLastMove(move);
      setTurn('player');
      setThinking(false);
    }, 350);
    return () => window.clearTimeout(t);
  }, [turn, winner, board]);

  // 落子后胜负判定（只检查最后一手，任何位置连五都能命中）
  useEffect(() => {
    if (winner !== 0 || lastMove < 0) return;
    if (checkWin(board, lastMove)) {
      const w = board[lastMove];
      setWinner(w);
      if (w === 1) {
        sfx.win();
        const newStreak = streak + 1;
        setWins((v) => v + 1);
        setStreak(newStreak);
        best.updateBest(newStreak, (a, b) => a > b);
        toast(`你赢了！当前 ${newStreak} 连胜`, 'success');
      } else {
        sfx.lose();
        setLosses((v) => v + 1);
        setStreak(0);
        toast('电脑获胜，再来一局！', 'info');
      }
    } else if (board.every((c) => c !== 0)) {
      setWinner(3);
      toast('平局！', 'info');
    }
  }, [board, winner, lastMove, streak, toast, best]);

  const place = (i: number) => {
    if (winner !== 0 || turn !== 'player' || thinking) return;
    if (board[i] !== 0) return;
    sfx.move();
    setBoard((prev) => {
      const next = [...prev];
      next[i] = 1;
      return next;
    });
    setLastMove(i);
    setTurn('ai');
  };

  const total = wins + losses;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

  return (
    <GameShell
      meta={metaGomoku}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>总胜场</span>
            <strong>{wins}</strong>
          </div>
          <div className="stat-box">
            <span>连胜</span>
            <strong>{streak}</strong>
          </div>
          <div className="stat-box">
            <span>胜率</span>
            <strong>{winRate}%</strong>
          </div>
          <div className="stat-box">
            <span>{metaGomoku.bestScoreLabel}</span>
            <strong>{best.value ?? '--'}</strong>
          </div>
          <button className="btn btn-primary" onClick={reset}>
            🔄 新一局
          </button>
        </>
      }
    >
      <div className="gomoku">
        <div className={`gomoku-status ${thinking ? 'thinking' : ''}`}>
          {winner === 0 &&
            (thinking ? '🤖 电脑思考中…' : turn === 'player' ? '⚫ 轮到你落子' : '🤖 电脑回合')}
          {winner === 1 && '🎉 你赢了！'}
          {winner === 2 && '💀 电脑赢了'}
          {winner === 3 && '🤝 平局'}
        </div>
        <div
          className="gomoku-board"
          style={{ gridTemplateColumns: `repeat(${SIZE}, var(--g-cell, 30px))` }}
        >
          {board.map((c, i) => (
            <button
              key={i}
              className={`gomoku-cell ${c === 1 ? 'black' : ''} ${c === 2 ? 'white' : ''}`}
              onClick={() => place(i)}
              disabled={c !== 0 || turn !== 'player' || thinking || winner !== 0}
              aria-label={`第 ${Math.floor(i / SIZE) + 1} 行第 ${(i % SIZE) + 1} 列`}
              style={{ width: 'var(--g-cell, 30px)', height: 'var(--g-cell, 30px)' }}
            >
              {c !== 0 && <span className="gomoku-stone" />}
            </button>
          ))}
        </div>
        <p className="hint">黑子先行（你）· 五子连珠获胜 · 电脑 AI 会防守和进攻</p>
      </div>
    </GameShell>
  );
}
