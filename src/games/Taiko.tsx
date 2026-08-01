import { useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useLocalStorage } from '../core/useLocalStorage';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import type { GameMeta } from '../core/types';

export const meta: GameMeta = {
  id: 'taiko',
  title: '太鼓达人',
  description: '跟随鼓点敲击！咚（红）咔（蓝）！',
  icon: '🥁',
  difficulty: '中等',
  category: '反应',
  tags: ['日系', '节奏'],
  bestScoreLabel: '最高分',
};

const W = 520;
const H = 220;
const JUDGE_X = 100;
const TRAVEL_SEC = 3.2;

type NoteType = 'red' | 'blue';
interface Note {
  type: NoteType;
  time: number;
  judged: 0 | 1 | 2; // 0 未判定 1 良 2 可
  missed?: boolean;
}

interface SongDef {
  name: string;
  level: string;
  bpm: number;
  seconds: number;
  spacing: number;
  blueChance: number;
}

const SONGS: SongDef[] = [
  { name: '风之鼓动', level: '简单', bpm: 92, seconds: 26, spacing: 2, blueChance: 0.12 },
  { name: '武士之舞', level: '中等', bpm: 132, seconds: 30, spacing: 1, blueChance: 0.28 },
  { name: '鬼之太鼓', level: '困难', bpm: 172, seconds: 32, spacing: 0.5, blueChance: 0.42 },
];

/** 固定种子谱面生成（同一曲目每次一致） */
function makeChart(song: SongDef): Note[] {
  const beat = 60 / song.bpm;
  const notes: Note[] = [];
  let seed = song.bpm * 1000 + song.spacing * 97;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let t = 2.2;
  while (t < song.seconds - 0.5) {
    const type: NoteType = rand() < song.blueChance ? 'blue' : 'red';
    notes.push({ type, time: t, judged: 0 });
    t += beat * song.spacing * (0.9 + rand() * 0.25);
  }
  return notes;
}

export default function Taiko() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'select' | 'playing' | 'result'>('select');
  const [songIdx, setSongIdx] = useState(0);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [maxCombo, setMaxCombo] = useState(0);
  const [result, setResult] = useState<{ good: number; ok: number; miss: number }>({ good: 0, ok: 0, miss: 0 });
  const best = useLocalStorage<number>(`best:${meta.id}`);
  const { toast } = useToast();

  const gameRef = useRef({
    song: SONGS[0],
    notes: [] as Note[],
    elapsed: 0,
    startTime: 0,
    running: false,
    fx: [] as Array<{ x: number; text: string; color: string; t: number }>,
  });

  const startSong = (idx: number) => {
    const song = SONGS[idx];
    setSongIdx(idx);
    gameRef.current.song = song;
    gameRef.current.notes = makeChart(song);
    gameRef.current.elapsed = 0;
    gameRef.current.startTime = performance.now();
    gameRef.current.running = true;
    gameRef.current.fx = [];
    setScore(0);
    setCombo(0);
    setMaxCombo(0);
    setResult({ good: 0, ok: 0, miss: 0 });
    setStatus('playing');
  };

  /** 击打判定 */
  const hit = (type: NoteType) => {
    const g = gameRef.current;
    if (!g.running) return;
    const elapsed = (performance.now() - g.startTime) / 1000;
    // 找最近的未判定同类型音符
    let bestNote: Note | null = null;
    let bestDist = Infinity;
    for (const n of g.notes) {
      if (n.type !== type || n.judged !== 0 || n.missed) continue;
      const d = Math.abs(n.time - elapsed);
      if (d < bestDist) {
        bestDist = d;
        bestNote = n;
      }
    }
    if (!bestNote || bestDist > 0.15) {
      // 空打（没有音符却击鼓）：不算 miss，但打断连击？太鼓达人不扣。提示
      sfx.mismatch();
      return;
    }
    const isGood = bestDist <= 0.06;
    bestNote.judged = isGood ? 1 : 2;
    const gained = isGood ? 100 + Math.min(combo, 50) : 50;
    setScore((s) => s + gained);
    setCombo((c) => {
      const nc = c + 1;
      setMaxCombo((m) => Math.max(m, nc));
      return nc;
    });
    setResult((r) => ({ ...r, good: r.good + (isGood ? 1 : 0), ok: r.ok + (isGood ? 0 : 1) }));
    if (isGood) {
      sfx.merge();
      g.fx.push({ x: JUDGE_X, text: '良', color: '#ffd54f', t: 0 });
    } else {
      sfx.clear();
      g.fx.push({ x: JUDGE_X, text: '可', color: '#81c784', t: 0 });
    }
  };

  // 主循环
  useEffect(() => {
    if (status !== 'playing') return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      const g = gameRef.current;
      const cv = canvasRef.current;
      const ctx = cv?.getContext('2d');
      if (!cv || !ctx) return;
      const elapsed = (now - g.startTime) / 1000;
      g.elapsed = elapsed;

      // Miss 检测
      for (const n of g.notes) {
        if (n.judged === 0 && !n.missed && n.time < elapsed - 0.15) {
          n.missed = true;
          setCombo(0);
          setResult((r) => ({ ...r, miss: r.miss + 1 }));
          g.fx.push({ x: JUDGE_X, text: '不可', color: '#ef5350', t: 0 });
        }
      }

      // 曲目结束
      if (elapsed > g.song.seconds) {
        g.running = false;
        const final = result;
        const grade = final.miss === 0 && final.good / Math.max(1, final.good + final.ok) >= 0.9 ? 'S' : final.good / Math.max(1, final.good + final.ok) >= 0.75 ? 'A' : final.good / Math.max(1, final.good + final.ok) >= 0.5 ? 'B' : 'C';
        void grade;
        sfx.win();
        setStatus('result');
        return;
      }

      // 渲染
      ctx.fillStyle = '#151028';
      ctx.fillRect(0, 0, W, H);
      // 轨道背景
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, '#2a2040');
      grad.addColorStop(1, '#1a1430');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      // 轨道线
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      for (let x = JUDGE_X; x < W; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 30);
        ctx.lineTo(x, H - 30);
        ctx.stroke();
      }
      // 判定圈（左红右蓝半圆）
      ctx.save();
      ctx.translate(JUDGE_X, H / 2);
      ctx.beginPath();
      ctx.arc(0, 0, 46, -Math.PI / 2, Math.PI / 2);
      ctx.closePath();
      ctx.fillStyle = '#e53935';
      ctx.fill();
      ctx.strokeStyle = '#ff8a80';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 46, Math.PI / 2, -Math.PI / 2);
      ctx.closePath();
      ctx.fillStyle = '#1e88e5';
      ctx.fill();
      ctx.strokeStyle = '#90caf9';
      ctx.stroke();
      ctx.restore();

      // 音符
      for (const n of g.notes) {
        if (n.judged !== 0 || n.missed) continue;
        const x = JUDGE_X + ((n.time - elapsed) / TRAVEL_SEC) * (W - JUDGE_X);
        if (x > W + 40) continue;
        if (x < JUDGE_X - 60) continue;
        ctx.fillStyle = n.type === 'red' ? '#ef5350' : '#42a5f5';
        ctx.beginPath();
        ctx.arc(x, H / 2, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 15px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(n.type === 'red' ? '咚' : '咔', x, H / 2 + 5);
      }

      // 判定特效
      g.fx = g.fx.filter((f) => {
        f.t += dt;
        return f.t < 500;
      });
      g.fx.forEach((f) => {
        ctx.globalAlpha = 1 - f.t / 500;
        ctx.fillStyle = f.color;
        ctx.font = 'bold 26px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(f.text, f.x, H / 2 - 60 - f.t * 0.08);
        ctx.globalAlpha = 1;
      });

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [status]);

  // 键盘控制
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'f' || e.key === 'F' || e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        hit('red');
      }
      if (e.key === 'd' || e.key === 'D' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        hit('blue');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 最高分
  useEffect(() => {
    if (status === 'result' && score > 0) {
      const isNew = best.updateBest(score, (a, b) => a > b);
      if (isNew) {
        sfx.record();
        toast(`新纪录！${score} 分`, 'record');
      }
    }
  }, [status, score, best, toast]);

  const grade =
    result.miss === 0 && result.good / Math.max(1, result.good + result.ok) >= 0.9
      ? 'S'
      : result.good / Math.max(1, result.good + result.ok) >= 0.75
        ? 'A'
        : result.good / Math.max(1, result.good + result.ok) >= 0.5
          ? 'B'
          : 'C';

  return (
    <GameShell
      meta={meta}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>分数</span>
            <strong>{score}</strong>
          </div>
          <div className="stat-box">
            <span>连击</span>
            <strong>{combo > 1 ? `${combo}×` : '-'}</strong>
          </div>
          <div className="stat-box">
            <span>良/可/不可</span>
            <strong>{result.good}/{result.ok}/{result.miss}</strong>
          </div>
          <div className="stat-box">
            <span>{meta.bestScoreLabel}</span>
            <strong>{best.value ?? 0}</strong>
          </div>
        </>
      }
    >
      <div className="arcade">
        <div className="arcade-canvas-wrap taiko-wrap">
          <canvas ref={canvasRef} width={W} height={H} />
          {status === 'select' && (
            <div className="arcade-overlay">
              <h2>🥁 太鼓达人</h2>
              <p>按 F/J 敲红鼓（咚）· D/K 敲蓝鼓（咔）· 音符到达判定圈时击打</p>
              <div className="taiko-songs">
                {SONGS.map((s, i) => (
                  <button key={s.name} className="btn taiko-song" onClick={() => startSong(i)}>
                    <span className="taiko-song-name">{s.name}</span>
                    <span className="taiko-song-level">{s.level} · {s.bpm} BPM</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {status === 'playing' && (
            <div className="taiko-hud">
              <span className="taiko-song-title">{SONGS[songIdx].name}</span>
            </div>
          )}
          {status === 'result' && (
            <div className="arcade-overlay">
              <h2 className="taiko-grade">{grade}</h2>
              <p>
                得分 {score} · 最大连击 {maxCombo}× · 良 {result.good} / 可 {result.ok} / 不可 {result.miss}
              </p>
              <button className="btn btn-primary" onClick={() => startSong(songIdx)}>
                再来一次
              </button>
              <button className="btn btn-ghost" onClick={() => setStatus('select')}>
                选择曲目
              </button>
            </div>
          )}
        </div>
        <p className="hint">
          🥁 F/J = 咚（红） · D/K = 咔（蓝） · 良 ±0.06s / 可 ±0.15s
        </p>
      </div>
    </GameShell>
  );
}
