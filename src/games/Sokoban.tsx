import { useCallback, useEffect, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { TouchDpad } from '../core/TouchControls';
import type { GameMeta } from '../core/types';

export const meta: GameMeta = {
  id: 'sokoban',
  title: '推箱子',
  description: '把箱子推到目标点，规划路线步步为营！',
  icon: '📦',
  difficulty: '中等',
  category: '逻辑',
  tags: ['推箱', '关卡'],
  bestScoreLabel: '最少步数',
};

/** 关卡（#墙 $箱子 .目标 @人 *箱子在目标 +人在目标）已用 BFS 求解器验证可解且箱子互不相邻 */
const LEVELS: string[][] = [
  ['#####', '#.  #', '# $ #', '#  @#', '#####'],
  ['######', '#    #', '#  $ #', '# .@ #', '#  $.#', '######'],
  ['#######', '#     #', '#  $  #', '# . @ #', '#  $ .#', '#     #', '#######'],
  ['########', '#   .  #', '#  $   #', '#   @$ #', '# .    #', '#  $ . #', '########'],
  ['##########', '#        #', '#  .     #', '#  $     #', '#    $ @ #', '#    .   #', '#   $  . #', '##########'],
  ['##########', '#        #', '#  .     #', '# .$     #', '#    $@  #', '#    .   #', '#  .$    #', '##########'],
  ['###########', '#         #', '#  .      #', '#  $   .  #', '#    $  @ #', '#  .      #', '#  .$     #', '###########'],
  ['############', '#          #', '#  .   .   #', '#  $   $   #', '#    $  @  #', '#   .      #', '############'],
];

type Cell = 'wall' | 'floor' | 'box' | 'goal' | 'boxOnGoal' | 'player' | 'playerOnGoal';

interface LevelState {
  grid: Cell[][];
  rows: number;
  cols: number;
}

function parseLevel(map: string[]): LevelState {
  const grid: Cell[][] = map.map((row) =>
    [...row].map((ch): Cell => {
      switch (ch) {
        case '#':
          return 'wall';
        case '$':
          return 'box';
        case '.':
          return 'goal';
        case '*':
          return 'boxOnGoal';
        case '@':
          return 'player';
        case '+':
          return 'playerOnGoal';
        default:
          return 'floor';
      }
    }),
  );
  return { grid, rows: grid.length, cols: Math.max(...grid.map((r) => r.length)) };
}

export default function Sokoban() {
  const [levelIdx, setLevelIdx] = useState(0);
  const [state, setState] = useState<LevelState>(() => parseLevel(LEVELS[0]));
  const [moves, setMoves] = useState(0);
  const [pushes, setPushes] = useState(0);
  const [history, setHistory] = useState<LevelState[]>([]);
  const [won, setWon] = useState(false);
  const best = useBestScore(meta.id);
  const { toast } = useToast();

  const totalMoves = (lv: LevelState) => {
    let boxes = 0;
    let goals = 0;
    lv.grid.forEach((row) =>
      row.forEach((c) => {
        if (c === 'box' || c === 'boxOnGoal') boxes++;
        if (c === 'goal' || c === 'boxOnGoal' || c === 'playerOnGoal') goals++;
      }),
    );
    return { boxes, goals };
  };

  const loadLevel = (idx: number) => {
    const s = parseLevel(LEVELS[idx]);
    setLevelIdx(idx);
    setState(s);
    setMoves(0);
    setPushes(0);
    setHistory([]);
    setWon(false);
    sfx.flip();
  };

  const move = useCallback(
    (dir: 'up' | 'down' | 'left' | 'right') => {
      if (won) return;
      setState((prev) => {
        const { grid, rows, cols } = prev;
        // 找人
        let py = -1;
        let px = -1;
        for (let y = 0; y < rows && py < 0; y++)
          for (let x = 0; x < cols; x++)
            if (grid[y][x] === 'player' || grid[y][x] === 'playerOnGoal') {
              py = y;
              px = x;
              break;
            }
        if (py < 0) return prev;
        const [dy, dx] =
          dir === 'up' ? [-1, 0] : dir === 'down' ? [1, 0] : dir === 'left' ? [0, -1] : [0, 1];
        const ny = py + dy;
        const nx = px + dx;
        if (ny < 0 || ny >= rows || nx < 0 || nx >= cols) return prev;
        const target = grid[ny][nx];
        if (target === 'wall') return prev;
        const next = grid.map((row) => [...row]);
        // 当前格恢复为 floor 或 goal
        next[py][px] = grid[py][px] === 'playerOnGoal' ? 'goal' : 'floor';
        let pushed = false;
        if (target === 'box' || target === 'boxOnGoal') {
          const by = ny + dy;
          const bx = nx + dx;
          if (by < 0 || by >= rows || bx < 0 || bx >= cols) return prev;
          const behind = grid[by][bx];
          if (behind === 'wall' || behind === 'box' || behind === 'boxOnGoal') return prev;
          next[by][bx] = behind === 'goal' ? 'boxOnGoal' : 'box';
          next[ny][nx] = target === 'boxOnGoal' ? 'playerOnGoal' : 'player';
          pushed = true;
        } else if (target === 'floor' || target === 'goal') {
          next[ny][nx] = target === 'goal' ? 'playerOnGoal' : 'player';
        } else {
          return prev;
        }
        setHistory((h) => [...h.slice(-200), prev]);
        setMoves((m) => m + 1);
        if (pushed) setPushes((p) => p + 1);
        if (pushed) sfx.move();
        else sfx.click();
        // 胜利判定
        let remaining = 0;
        next.forEach((row) =>
          row.forEach((c) => {
            if (c === 'box') remaining++;
          }),
        );
        if (remaining === 0) {
          setWon(true);
          sfx.win();
          window.setTimeout(() => {
            const isNew = best.updateBest(moves + 1, (a, b) => a < b);
            if (isNew) {
              sfx.record();
              toast(`新纪录！${moves + 1} 步完成`, 'record');
            }
            if (levelIdx < LEVELS.length - 1) {
              toast(`第 ${levelIdx + 1} 关完成！进入下一关`, 'success');
              window.setTimeout(() => loadLevel(levelIdx + 1), 900);
            } else {
              toast('🏆 全部关卡通关！', 'success');
            }
          }, 500);
        }
        return { grid: next, rows, cols };
      });
    },
    [won, levelIdx, best, toast],
  );

  // 键盘控制
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, 'up' | 'down' | 'left' | 'right'> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
        w: 'up',
        s: 'down',
        a: 'left',
        d: 'right',
        W: 'up',
        S: 'down',
        A: 'left',
        D: 'right',
      };
      const dir = map[e.key];
      if (dir) {
        e.preventDefault();
        move(dir);
      } else if (e.key === 'z' || e.key === 'Z') {
        setState((prev) => {
          const last = history[history.length - 1];
          if (!last) return prev;
          setHistory((h) => h.slice(0, -1));
          setMoves((m) => Math.max(0, m - 1));
          return last;
        });
      } else if (e.key === 'r' || e.key === 'R') {
        loadLevel(levelIdx);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const undo = () => {
    setState((prev) => {
      const last = history[history.length - 1];
      if (!last) return prev;
      setHistory((h) => h.slice(0, -1));
      setMoves((m) => Math.max(0, m - 1));
      sfx.flip();
      return last;
    });
  };

  const { boxes: totalBoxes, goals: totalGoals } = totalMoves(state);
  const cell = 52;

  return (
    <GameShell
      meta={meta}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>关卡</span>
            <strong>{levelIdx + 1}/{LEVELS.length}</strong>
          </div>
          <div className="stat-box">
            <span>步数</span>
            <strong>{moves}</strong>
          </div>
          <div className="stat-box">
            <span>剩余</span>
            <strong>{totalBoxes}/{totalGoals}</strong>
          </div>
          <div className="stat-box">
            <span>{meta.bestScoreLabel}</span>
            <strong>{best.value ?? '--'}</strong>
          </div>
          <button className="btn btn-primary" onClick={() => loadLevel(levelIdx)}>
            🔄 重开
          </button>
          <button className="btn btn-ghost" onClick={undo} disabled={history.length === 0}>
            ↩ 撤销
          </button>
        </>
      }
    >
      <div className="soko">
        <div className="level-bar">
          {LEVELS.map((_, i) => (
            <button
              key={i}
              className={`btn ${i === levelIdx ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => loadLevel(i)}
            >
              {i + 1}
            </button>
          ))}
        </div>
        {won && (
          <div className="banner won">
            🎉 第 {levelIdx + 1} 关完成！用了 {moves} 步
          </div>
        )}
        <div
          className="soko-board"
          style={{
            gridTemplateColumns: `repeat(${state.cols}, ${cell}px)`,
          }}
        >
          {state.grid.map((row, y) =>
            row.map((c, x) => (
              <div
                key={`${y}-${x}`}
                className={`soko-cell ${c}`}
                style={{ width: cell, height: cell }}
              >
                {c === 'box' && <span className="soko-box">📦</span>}
                {c === 'boxOnGoal' && <span className="soko-box on">📦</span>}
                {c === 'player' && <span className="soko-player">🧑</span>}
                {c === 'playerOnGoal' && <span className="soko-player">🧑</span>}
                {c === 'goal' && <span className="soko-goal" />}
              </div>
            )),
          )}
        </div>
        <p className="hint">方向键 / WASD 移动 · Z 撤销 · R 重开 · 推箱数 {pushes}</p>
        <div className="tc-row">
          <TouchDpad onDir={(d) => move(d)} />
        </div>
      </div>
    </GameShell>
  );
}
