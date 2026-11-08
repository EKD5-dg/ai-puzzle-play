import { useEffect, useMemo, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { migrateLegacyBest } from '../core/useLocalStorage';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaSudoku } from '../core/gameMetas';
import { generatePuzzle } from './sudokuCore';
import type { Grid, SudokuPuzzle } from './sudokuCore';


const LEVELS = [
  { label: '简单', blanks: 36 },
  { label: '中等', blanks: 48 },
  { label: '困难', blanks: 58 },
];


export default function Sudoku() {
  const [levelIdx, setLevelIdx] = useState(1);
  const [puzzle, setPuzzle] = useState<Grid>(() => Array(81).fill(0));
  const [solution, setSolution] = useState<Grid>(() => Array(81).fill(0));
  const [current, setCurrent] = useState<Grid>(() => Array(81).fill(0));
  const [selected, setSelected] = useState<number | null>(null);
  const [mistakes, setMistakes] = useState(0);
  const [showMistakes, setShowMistakes] = useState(true);
  const [time, setTime] = useState(0);
  const [won, setWon] = useState(false);
  const [generating, setGenerating] = useState(false);
  /** 生成任务编号：快速连点新一局时丢弃过期任务 */
  const genRef = useRef(0);
  /** 当前这一局唯一的生成任务：新局直接终止旧 Worker，避免任务排队与过期结果 */
  const jobRef = useRef<{ worker: Worker | null; timer: number; gen: number } | null>(null);
  /** 最佳时间按难度细分（简单档记录不再压住困难档），云端键同步带后缀 */
  const best = useBestScore(`${metaSudoku.id}:${levelIdx}`);

  // 改造前三档共用基础键，把旧纪录搬到首档（与其他分档游戏一致；否则大厅能聚合到旧值、游戏页却显示 --）
  useEffect(() => {
    migrateLegacyBest(metaSudoku);
  }, []);
  const { toast } = useToast();

  const cancelJob = () => {
    const job = jobRef.current;
    if (job) {
      window.clearTimeout(job.timer);
      job.worker?.terminate();
      jobRef.current = null;
    }
  };

  // 卸载时终止当前 Worker 并作废所有迟到结果
  useEffect(() => {
    return () => {
      genRef.current += 1;
      cancelJob();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startNew = (idx: number) => {
    const gen = ++genRef.current;
    cancelJob();
    setGenerating(true);
    const blanks = LEVELS[idx].blanks;
    const finish = (result: SudokuPuzzle) => {
      if (gen !== genRef.current) return;
      jobRef.current = null;
      setLevelIdx(idx);
      setPuzzle(result.puzzle);
      setSolution(result.solution);
      setCurrent([...result.puzzle]);
      setSelected(null);
      setMistakes(0);
      setTime(0);
      setWon(false);
      setGenerating(false);
    };
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./sudokuWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      worker = null;
    }
    if (!worker) {
      // Worker 不可用：让出一帧再同步生成，至少让"生成中"提示先绘制
      const timer = window.setTimeout(() => {
        jobRef.current = null;
        if (gen === genRef.current) finish(generatePuzzle(blanks));
      }, 0);
      jobRef.current = { worker: null, timer, gen };
      return;
    }
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      worker?.terminate();
      // Worker 8s 无响应：先让出一帧再同步兜底，避免在深层调用栈里冻结
      window.setTimeout(() => {
        if (gen === genRef.current) finish(generatePuzzle(blanks));
      }, 0);
    }, 8000);
    const settle = (result: SudokuPuzzle) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      worker?.terminate();
      if (jobRef.current?.gen === gen) jobRef.current = null;
      finish(result);
    };
    worker.onmessage = (ev: MessageEvent<SudokuPuzzle>) => settle(ev.data);
    worker.onerror = () => {
      // Worker 起不来/运行时异常：立即兜底，不再空等 8 秒
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      worker?.terminate();
      if (jobRef.current?.gen === gen) jobRef.current = null;
      window.setTimeout(() => {
        if (gen === genRef.current) finish(generatePuzzle(blanks));
      }, 0);
    };
    jobRef.current = { worker, timer, gen };
    worker.postMessage({ id: gen, blanks });
  };

  // 首次进入生成一局
  useEffect(() => {
    startNew(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 计时（切后台/锁屏时暂停：计时排行游戏后台照跑既不公平，后台节流还会让计时漂移）
  useEffect(() => {
    if (won) return;
    let timer: number | null = window.setInterval(() => setTime((s) => s + 1), 1000);
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        if (timer != null) window.clearInterval(timer);
        timer = null;
      } else if (timer == null) {
        timer = window.setInterval(() => setTime((s) => s + 1), 1000);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (timer != null) window.clearInterval(timer);
    };
  }, [won]);

  const inputNumber = (v: number) => {
    if (won || selected === null) return;
    if (puzzle[selected] !== 0) return;
    if (v !== 0 && v === current[selected]) return;
    const next = [...current];
    next[selected] = v;
    if (v !== 0 && v !== solution[selected]) {
      setMistakes((m) => m + 1);
      sfx.mismatch();
    } else if (v !== 0) {
      sfx.flip();
    }
    setCurrent(next);
    // 完成判定
    if (next.every((x) => x !== 0)) {
      if (next.every((x, i) => x === solution[i])) {
        setWon(true);
        sfx.win();
        const isNew = best.updateBest(time, (a, b) => a < b);
        if (isNew) {
          sfx.record();
          toast(`新纪录！${time}s 完成`, 'record');
        } else {
          toast('数独完成，太棒了！', 'success');
        }
      } else {
        // 填满但有错：给出明确反馈，否则玩家看到"满了却没结束"会以为游戏坏了
        const wrong = next.reduce((n, x, i) => n + (x !== solution[i] ? 1 : 0), 0);
        sfx.mismatch();
        toast(`棋盘填满了，但还有 ${wrong} 格是错的（开「错误提示」会标红），改对即通关`, 'info');
      }
    }
  };

  // 键盘支持：1-9 填入、Delete/Backspace 清除、方向键移动选中
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (won) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return; // Ctrl+1~9 切浏览器标签页不应误填
      if (e.key >= '1' && e.key <= '9') {
        inputNumber(Number(e.key));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault(); // 阻止 Firefox 页面后退
        inputNumber(0);
      } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && selected !== null) {
        e.preventDefault();
        const r = Math.floor(selected / 9);
        const c = selected % 9;
        const nr =
          e.key === 'ArrowUp' ? (r - 1 + 9) % 9 : e.key === 'ArrowDown' ? (r + 1) % 9 : r;
        const nc =
          e.key === 'ArrowLeft' ? (c - 1 + 9) % 9 : e.key === 'ArrowRight' ? (c + 1) % 9 : c;
        setSelected(nr * 9 + nc);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // 每次渲染都重新绑定，确保闭包内 state 最新

  const sameNumberCells = useMemo(() => {
    if (selected === null) return new Set<number>();
    const v = current[selected];
    if (v === 0) return new Set<number>();
    return new Set(current.map((x, i) => (x === v ? i : -1)).filter((i) => i >= 0));
  }, [current, selected]);

  const highlightCells = useMemo(() => {
    if (selected === null) return new Set<number>();
    const r = Math.floor(selected / 9);
    const c = selected % 9;
    const set = new Set<number>();
    for (let i = 0; i < 9; i++) {
      set.add(r * 9 + i);
      set.add(i * 9 + c);
    }
    const br = Math.floor(r / 3) * 3;
    const bc = Math.floor(c / 3) * 3;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) set.add((br + i) * 9 + bc + j);
    return set;
  }, [selected]);

  const isWrong = (i: number) =>
    showMistakes && current[i] !== 0 && puzzle[i] === 0 && current[i] !== solution[i];

  const wrongCells = new Set(current.map((_, i) => (isWrong(i) ? i : -1)).filter((i) => i >= 0));

  return (
    <GameShell
      meta={metaSudoku}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>时间</span>
            <strong>{time}s</strong>
          </div>
          <div className="stat-box">
            <span>错误</span>
            <strong>{mistakes}</strong>
          </div>
          <div className="stat-box">
            <span>{metaSudoku.bestScoreLabel}</span>
            <strong>{best.value ? `${best.value}s` : '--'}</strong>
          </div>
          <button className="btn btn-primary" onClick={() => startNew(levelIdx)}>
            🔄 新一局
          </button>
        </>
      }
    >
      <div className="sudoku">
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
          <label className="sudoku-toggle">
            <input
              type="checkbox"
              checked={showMistakes}
              onChange={(e) => setShowMistakes(e.target.checked)}
            />
            错误提示
          </label>
        </div>
        {won && (
          <div className="banner won">
            🎉 数独完成！用时 {time}s，错误 {mistakes} 次
          </div>
        )}
        {generating && <div className="banner">⏳ 正在生成谜题…</div>}
        <div className="sudoku-grid">
          {current.map((v, i) => {
            const isGiven = puzzle[i] !== 0;
            const r = Math.floor(i / 9);
            const c = i % 9;
            const isSel = selected === i;
            const cls = [
              'sudoku-cell',
              isGiven ? 'given' : 'filled',
              isSel ? 'selected' : '',
              highlightCells.has(i) ? 'hl' : '',
              sameNumberCells.has(i) ? 'same' : '',
              wrongCells.has(i) ? 'wrong' : '',
              r % 3 === 2 && r < 8 ? 'rb' : '',
              c % 3 === 2 && c < 8 ? 'cb' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                key={i}
                className={cls}
                onClick={() => setSelected(isSel ? null : i)}
              >
                {v === 0 ? '' : v}
              </button>
            );
          })}
        </div>
        <div className="num-pad">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <button key={n} className="btn num-btn" onClick={() => inputNumber(n)}>
              {n}
            </button>
          ))}
          <button className="btn num-btn" onClick={() => inputNumber(0)}>
            ✕
          </button>
        </div>
        <p className="hint">先点击棋盘选中格子，再点数字填入</p>
      </div>
    </GameShell>
  );
}
