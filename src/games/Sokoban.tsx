import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { TouchDpad } from '../core/TouchControls';
import { metaSokoban } from '../core/gameMetas';



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
  /** 撤销历史：记录每步局面与该步是否推箱（撤销时同步回退 pushes） */
  const [history, setHistory] = useState<Array<{ state: LevelState; pushed: boolean }>>([]);
  const [won, setWon] = useState(false);
  /** 通关后延迟切关的定时器句柄（手动切关/撤销/卸载时需清除，防止竞态跳关） */
  const winTimerRef = useRef<number | null>(null);
  const best = useBestScore(metaSokoban.id);
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
    if (winTimerRef.current !== null) {
      window.clearTimeout(winTimerRef.current);
      winTimerRef.current = null;
    }
    const s = parseLevel(LEVELS[idx]);
    setLevelIdx(idx);
    setState(s);
    setMoves(0);
    setPushes(0);
    setHistory([]);
    setWon(false);
    sfx.flip();
  };

  // 卸载时清理切关定时器
  useEffect(
    () => () => {
      if (winTimerRef.current !== null) window.clearTimeout(winTimerRef.current);
    },
    [],
  );

  const move = useCallback(
    (dir: 'up' | 'down' | 'left' | 'right') => {
      if (won) return;
      const { grid, rows, cols } = state;
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
      if (py < 0) return;
      const [dy, dx] =
        dir === 'up' ? [-1, 0] : dir === 'down' ? [1, 0] : dir === 'left' ? [0, -1] : [0, 1];
      const ny = py + dy;
      const nx = px + dx;
      if (ny < 0 || ny >= rows || nx < 0 || nx >= cols) return;
      const target = grid[ny][nx];
      if (target === 'wall') return;
      const next = grid.map((row) => [...row]);
      // 当前格恢复为 floor 或 goal
      next[py][px] = grid[py][px] === 'playerOnGoal' ? 'goal' : 'floor';
      let pushed = false;
      if (target === 'box' || target === 'boxOnGoal') {
        const by = ny + dy;
        const bx = nx + dx;
        if (by < 0 || by >= rows || bx < 0 || bx >= cols) return;
        const behind = grid[by][bx];
        if (behind === 'wall' || behind === 'box' || behind === 'boxOnGoal') return;
        next[by][bx] = behind === 'goal' ? 'boxOnGoal' : 'box';
        next[ny][nx] = target === 'boxOnGoal' ? 'playerOnGoal' : 'player';
        pushed = true;
      } else if (target === 'floor' || target === 'goal') {
        next[ny][nx] = target === 'goal' ? 'playerOnGoal' : 'player';
      } else {
        return;
      }
      // 胜利判定
      let remaining = 0;
      next.forEach((row) =>
        row.forEach((c) => {
          if (c === 'box') remaining++;
        }),
      );
      // 计算并统一提交状态（副作用全部放在 updater 之外，避免 StrictMode 双执行）
      setHistory((h) => [...h.slice(-200), { state, pushed }]);
      setState({ grid: next, rows, cols });
      setMoves((m) => m + 1);
      if (pushed) setPushes((p) => p + 1);
      if (pushed) sfx.move();
      else sfx.click();
      if (remaining === 0) {
        const finalMoves = moves + 1;
        setWon(true);
        sfx.win();
        winTimerRef.current = window.setTimeout(() => {
          winTimerRef.current = null;
          const isNew = best.updateBest(finalMoves, (a, b) => a < b);
          if (isNew) {
            sfx.record();
            toast(`新纪录！${finalMoves} 步完成`, 'record');
          }
          if (levelIdx < LEVELS.length - 1) {
            toast(`第 ${levelIdx + 1} 关完成！进入下一关`, 'success');
            winTimerRef.current = window.setTimeout(() => loadLevel(levelIdx + 1), 900);
          } else {
            toast('🏆 全部关卡通关！', 'success');
          }
        }, 500);
      }
    },
    [state, won, levelIdx, best, toast],
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
        e.preventDefault();
        undo();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        loadLevel(levelIdx);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [move, levelIdx]);

  const undo = () => {
    const entry = history[history.length - 1];
    if (!entry) return;
    setHistory((h) => h.slice(0, -1));
    setState(entry.state);
    setMoves((m) => Math.max(0, m - 1));
    if (entry.pushed) setPushes((p) => Math.max(0, p - 1));
    // 从终局局面撤销：清除胜利态与待执行的切关定时器
    if (won) {
      setWon(false);
      if (winTimerRef.current !== null) {
        window.clearTimeout(winTimerRef.current);
        winTimerRef.current = null;
      }
    }
    sfx.flip();
  };

  const { boxes: totalBoxes, goals: totalGoals } = totalMoves(state);
  const cell = 52;

  return (
    <GameShell
      meta={metaSokoban}
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
            <span>{metaSokoban.bestScoreLabel}</span>
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
            gridTemplateColumns: `repeat(${state.cols}, var(--soko-cell, ${cell}px))`,
          }}
        >
          {state.grid.map((row, y) =>
            row.map((c, x) => (
              <div
                key={`${y}-${x}`}
                className={`soko-cell ${c}`}
                style={{ width: 'var(--soko-cell, 52px)', height: 'var(--soko-cell, 52px)' }}
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
