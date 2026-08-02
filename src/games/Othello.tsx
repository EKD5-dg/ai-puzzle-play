import { useEffect, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaOthello } from '../core/gameMetas';



const SIZE = 8;
type Cell = 0 | 1 | 2; // 0 空 1 黑(玩家) 2 白(AI)
type Board = Cell[];

const DIRS = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

/** 位置权重表（角点/边价值高） */
const WEIGHTS = [
  [120, -20, 20, 5, 5, 20, -20, 120],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [120, -20, 20, 5, 5, 20, -20, 120],
];

function emptyBoard(): Board {
  const b = Array(SIZE * SIZE).fill(0) as Board;
  b[3 * SIZE + 3] = 1;
  b[3 * SIZE + 4] = 2;
  b[4 * SIZE + 3] = 2;
  b[4 * SIZE + 4] = 1;
  return b;
}

/** 计算在 (x,y) 落子 me 后翻转的棋子数量（0 表示非法） */
function flips(board: Board, x: number, y: number, me: 1 | 2): number {
  if (board[y * SIZE + x] !== 0) return 0;
  const opp = me === 1 ? 2 : 1;
  let total = 0;
  for (const [dx, dy] of DIRS) {
    let nx = x + dx;
    let ny = y + dy;
    let count = 0;
    while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[ny * SIZE + nx] === opp) {
      count++;
      nx += dx;
      ny += dy;
    }
    if (count > 0 && nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[ny * SIZE + nx] === me) {
      total += count;
    }
  }
  return total;
}

function legalMoves(board: Board, me: 1 | 2): number[] {
  const moves: number[] = [];
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      if (flips(board, x, y, me) > 0) moves.push(y * SIZE + x);
    }
  return moves;
}

/** 应用落子（返回新棋盘） */
function apply(board: Board, x: number, y: number, me: 1 | 2): Board {
  const next = [...board];
  next[y * SIZE + x] = me;
  const opp = me === 1 ? 2 : 1;
  for (const [dx, dy] of DIRS) {
    let nx = x + dx;
    let ny = y + dy;
    const chain: number[] = [];
    while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && next[ny * SIZE + nx] === opp) {
      chain.push(ny * SIZE + nx);
      nx += dx;
      ny += dy;
    }
    if (chain.length > 0 && nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && next[ny * SIZE + nx] === me) {
      chain.forEach((i) => {
        next[i] = me;
      });
    }
  }
  return next;
}

/** AI：评估每个合法落子的位置权重 + 翻转数 + 行动力 */
function aiMove(board: Board, me: 1 | 2): number {
  const opp = me === 1 ? 2 : 1;
  const moves = legalMoves(board, me);
  if (moves.length === 0) return -1;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const x = m % SIZE;
    const y = Math.floor(m / SIZE);
    const after = apply(board, x, y, me);
    const oppMoves = legalMoves(after, opp).length;
    const score = WEIGHTS[y][x] * 2 + flips(board, x, y, me) * 4 + oppMoves * 3;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

function count(board: Board): [number, number] {
  let b = 0;
  let w = 0;
  board.forEach((c) => {
    if (c === 1) b++;
    if (c === 2) w++;
  });
  return [b, w];
}

export default function Othello() {
  const [board, setBoard] = useState<Board>(emptyBoard);
  const [turn, setTurn] = useState<1 | 2>(1);
  const [gameOver, setGameOver] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const { toast } = useToast();

  const reset = () => {
    setBoard(emptyBoard());
    setTurn(1);
    setGameOver(false);
    setThinking(false);
  };

  // AI 回合
  useEffect(() => {
    if (turn !== 2 || gameOver) return;
    const moves = legalMoves(board, 2);
    if (moves.length === 0) {
      // AI 无子可下，检查游戏是否结束
      if (legalMoves(board, 1).length === 0) {
        finish();
      } else {
        setTurn(1);
        toast('电脑无子可下，轮到你了', 'info');
      }
      return;
    }
    setThinking(true);
    const t = window.setTimeout(() => {
      const m = aiMove(board, 2);
      if (m >= 0) {
        sfx.drop();
        setBoard(apply(board, m % SIZE, Math.floor(m / SIZE), 2));
      }
      setTurn(1);
      setThinking(false);
    }, 380);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn, gameOver]);

  const finish = () => {
    const [b, w] = count(board);
    setGameOver(true);
    sfx.win();
    if (b > w) {
      setWins((v) => v + 1);
      toast(`🎉 你赢了！${b} : ${w}`, 'success');
    } else if (w > b) {
      setLosses((v) => v + 1);
      toast(`💀 电脑赢了 ${w} : ${b}`, 'info');
    } else {
      toast('🤝 平局！', 'info');
    }
  };

  // 玩家回合/终局
  useEffect(() => {
    if (turn !== 1 || gameOver) return;
    const moves = legalMoves(board, 1);
    if (moves.length === 0) {
      if (legalMoves(board, 2).length === 0) {
        finish();
      } else {
        setTurn(2);
        toast('你无子可下，跳过回合', 'info');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn, gameOver]);

  const place = (i: number) => {
    if (turn !== 1 || gameOver || thinking) return;
    if (flips(board, i % SIZE, Math.floor(i / SIZE), 1) === 0) return;
    sfx.move();
    setBoard(apply(board, i % SIZE, Math.floor(i / SIZE), 1));
    setTurn(2);
  };

  const [bCount, wCount] = count(board);
  const legal = turn === 1 && !gameOver ? legalMoves(board, 1) : [];
  const legalSet = new Set(legal);
  const totalGames = wins + losses;
  const winRate = totalGames > 0 ? Math.round((wins / totalGames) * 100) : 0;

  return (
    <GameShell
      meta={metaOthello}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>⚫ 你</span>
            <strong>{bCount}</strong>
          </div>
          <div className="stat-box">
            <span>⚪ 电脑</span>
            <strong>{wCount}</strong>
          </div>
          <div className="stat-box">
            <span>胜率</span>
            <strong>{winRate}%</strong>
          </div>
          <button className="btn btn-primary" onClick={reset}>
            🔄 新一局
          </button>
        </>
      }
    >
      <div className="othello">
        <div className={`gomoku-status ${thinking ? 'thinking' : ''}`}>
          {!gameOver &&
            (thinking ? '🤖 电脑思考中…' : turn === 1 ? '⚫ 轮到你落子' : '🤖 电脑回合')}
          {gameOver && `🏁 终局：你 ${bCount} : ${wCount} 电脑`}
        </div>
        <div
          className="othello-board"
          style={{ gridTemplateColumns: `repeat(${SIZE}, 52px)` }}
        >
          {board.map((c, i) => {
            const legalCell = !gameOver && turn === 1 && legalSet.has(i);
            return (
              <button
                key={i}
                className={`othello-cell ${legalCell ? 'legal' : ''}`}
                onClick={() => place(i)}
                disabled={!legalCell}
                style={{ width: 52, height: 52 }}
              >
                {c !== 0 && <span className={`othello-stone ${c === 1 ? 'black' : 'white'}`} />}
                {c === 0 && legalCell && <span className="othello-hint" />}
              </button>
            );
          })}
        </div>
        <p className="hint">你执黑先行 · 夹住对方棋子即可翻转 · 子多者胜</p>
      </div>
    </GameShell>
  );
}
