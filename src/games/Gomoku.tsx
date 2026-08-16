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

/** 评分表：五连/活四/冲四/活三/眠三/活二 */
const SCORES: Record<string, number> = {
  '11111': 100000,
  '011110': 50000,
  '011112': 10000,
  '211110': 10000,
  '011010': 5000,
  '010110': 5000,
  '001110': 5000,
  '011100': 5000,
  '211100': 1000,
  '001112': 1000,
  '010112': 1000,
  '011012': 1000,
  '001100': 300,
  '010010': 300,
  '010100': 300,
  '100100': 100,
};

function emptyBoard(): Board {
  return Array(SIZE * SIZE).fill(0) as Board;
}

/** 提取经过 (x,y) 的所有方向的线 */
function linesThrough(board: Board, x: number, y: number): string[] {
  const lines: string[] = [];
  for (const [dx, dy] of DIRECTIONS) {
    let s = '';
    for (let k = -4; k <= 4; k++) {
      const nx = x + dx * k;
      const ny = y + dy * k;
      if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) s += 'X';
      else s += String(board[ny * SIZE + nx]);
    }
    lines.push(s);
  }
  return lines;
}

function scoreLine(line: string, me: 1 | 2, opp: 1 | 2): number {
  let total = 0;
  for (let i = 0; i <= line.length - 5; i++) {
    const seg = line.slice(i, i + 5);
    if (seg.includes(String(opp)) || seg.includes('X')) {
      // 若是对手的线，计分给对手视角
      if (seg.includes(String(me))) continue;
      const oppKey = seg.split(String(me)).join('0').split('X').join('2');
      total -= (SCORES[oppKey] ?? 0) * 0.9;
    } else {
      const myKey = seg.split(String(opp)).join('2').split('X').join('2');
      total += SCORES[myKey] ?? 0;
    }
  }
  return total;
}

function evaluate(board: Board, x: number, y: number, me: 1 | 2): number {
  const opp = me === 1 ? 2 : 1;
  const lines = linesThrough(board, x, y);
  let s = 0;
  for (const line of lines) s += scoreLine(line, me, opp);
  // 位置偏好：靠近中心更好
  const center = (SIZE - 1) / 2;
  s += (12 - Math.abs(x - center) - Math.abs(y - center)) * 5;
  return s;
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
          style={{ gridTemplateColumns: `repeat(${SIZE}, 30px)` }}
        >
          {board.map((c, i) => (
            <button
              key={i}
              className={`gomoku-cell ${c === 1 ? 'black' : ''} ${c === 2 ? 'white' : ''}`}
              onClick={() => place(i)}
              disabled={c !== 0 || turn !== 'player' || thinking || winner !== 0}
              style={{ width: 30, height: 30 }}
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
