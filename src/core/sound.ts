/**
 * 轻量音效系统：Web Audio API 合成，无需任何音频文件。
 * 所有游戏通过 sfx.xxx() 播放反馈音，音量开关持久化到 localStorage。
 */

const MUTE_KEY = 'pp:sound-muted';

let ctx: AudioContext | null = null;
let muted = false;

try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
} catch {
  muted = false;
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function ensureCtx(): AudioContext | null {
  if (muted) return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

interface ToneOpts {
  freq: number;
  dur?: number;
  type?: OscillatorType;
  delay?: number;
  vol?: number;
  slideTo?: number;
}

function tone({ freq, dur = 0.08, type = 'sine', delay = 0, vol = 0.16, slideTo }: ToneOpts): void {
  const ac = ensureCtx();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** 上行琶音 */
function arpeggio(base: number, steps: number[], stepDur = 0.07, type: OscillatorType = 'triangle'): void {
  steps.forEach((s, i) => tone({ freq: base * s, dur: stepDur + 0.06, type, delay: i * stepDur, vol: 0.14 }));
}

/** 下行滑音 */
function slideDown(from: number, to: number, dur = 0.28): void {
  tone({ freq: from, dur, type: 'sawtooth', slideTo: to, vol: 0.1 });
}

export const sfx = {
  /** 通用点击 */
  click(): void {
    tone({ freq: 660, dur: 0.045, type: 'triangle', vol: 0.08 });
  },
  /** 翻牌 */
  flip(): void {
    tone({ freq: 520, dur: 0.06, type: 'sine', slideTo: 780, vol: 0.12 });
  },
  /** 配对成功 */
  match(): void {
    arpeggio(523.25, [1, 1.25, 1.5], 0.06);
  },
  /** 配对失败 */
  mismatch(): void {
    slideDown(300, 160, 0.22);
  },
  /** 消除/合并 */
  merge(): void {
    tone({ freq: 392, dur: 0.07, type: 'triangle', vol: 0.12 });
    tone({ freq: 587, dur: 0.09, type: 'triangle', delay: 0.06, vol: 0.12 });
  },
  /** 方块移动 */
  move(): void {
    tone({ freq: 220, dur: 0.035, type: 'square', vol: 0.05 });
  },
  /** 方块落下 */
  drop(): void {
    tone({ freq: 180, dur: 0.05, type: 'square', slideTo: 90, vol: 0.09 });
  },
  /** 消行 */
  clear(): void {
    arpeggio(440, [1, 1.2, 1.5, 2], 0.055);
  },
  /** 踩雷/失败 */
  lose(): void {
    slideDown(440, 80, 0.5);
    tone({ freq: 90, dur: 0.4, type: 'sawtooth', delay: 0.1, vol: 0.12 });
  },
  /** 胜利 */
  win(): void {
    arpeggio(523.25, [1, 1.25, 1.5, 2, 2.5], 0.09);
  },
  /** 新纪录 */
  record(): void {
    arpeggio(660, [1, 1.2, 1.5], 0.08, 'square');
    tone({ freq: 1320, dur: 0.25, type: 'triangle', delay: 0.26, vol: 0.12 });
  },
};
