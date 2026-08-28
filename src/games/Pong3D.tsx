import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaPong3D } from '../core/gameMetas';

// ============ 常量 ============

/** 内部渲染分辨率（4:3，隧道透视构图） */
const RW = 480;
const RH = 360;
/** 隧道截面半宽 / 半高 / 长度（AI 挡板在尽头 z=D） */
const HX = 1.6;
const HY = 1.0;
const D = 12;
/** 相机位于玩家挡板平面（z=0）后方 3 个单位 */
const CAM = 3.0;
const FOCAL = RH * 0.95;
const BALL_R = 0.2;
/** 挡板半宽/半高（AI 略小，给高级别留 human 优势） */
const PHX = 0.58;
const PHY = 0.36;
const AI_HX = 0.52;
const AI_HY = 0.33;
const LIVES = 3;
/** 回击 +10，AI 漏接 +100 */
const HIT_SCORE = 10;
const MISS_SCORE = 100;
/** 方向键移动速度（世界单位/秒） */
const KEY_SPEED = 3.6;

/** 当前等级球速（z 向，单位/秒），逐级 +0.55，封顶 10.5 */
const levelSpeed = (lv: number) => Math.min(10.5, 4.6 + (lv - 1) * 0.55);
/** 当前等级 AI 挡板最大速度（封顶 5.6，低于球速上限保证可战胜） */
const aiMaxSpeed = (lv: number) => Math.min(5.6, 3.3 + lv * 0.3);

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 镜像折叠：把超出 [lo,hi] 的值按墙面反射折回（AI 预判反弹落点用） */
function fold(v: number, lo: number, hi: number): number {
  const w = hi - lo;
  let m = (v - lo) % (2 * w);
  if (m < 0) m += 2 * w;
  return m <= w ? lo + m : hi - (m - w);
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  color: string;
}

interface World {
  ball: { x: number; y: number; z: number; vx: number; vy: number; vz: number };
  /** 侧旋：玩家挥拍瞬间的位移赋予，飞行中持续掰弯轨迹并指数衰减 */
  spin: { x: number; y: number };
  paddle: { x: number; y: number; tx: number; ty: number; vx: number; vy: number };
  /** AI 挡板：thinkAt 之前沿用旧目标（120ms 反应延迟，模拟人类） */
  ai: { x: number; y: number; tx: number; ty: number; thinkAt: number };
  phase: 'serve' | 'play';
  /** 自动发球时刻（performance.now ms），点击/空格可立即发 */
  serveAt: number;
  level: number;
  lives: number;
  score: number;
  /** 各闪光效果的触发时刻（秒），渲染时按衰减系数画叠加层 */
  hitFlash: number;
  aiFlash: number;
  scoreFlash: number;
  hurtFlash: number;
  particles: Particle[];
  trail: { x: number; y: number; z: number }[];
}

function newWorld(): World {
  return {
    ball: { x: 0, y: 0, z: 0.6, vx: 0, vy: 0, vz: 0 },
    spin: { x: 0, y: 0 },
    paddle: { x: 0, y: 0, tx: 0, ty: 0, vx: 0, vy: 0 },
    ai: { x: 0, y: 0, tx: 0, ty: 0, thinkAt: 0 },
    phase: 'serve',
    serveAt: 0,
    level: 1,
    lives: LIVES,
    score: 0,
    hitFlash: -9,
    aiFlash: -9,
    scoreFlash: -9,
    hurtFlash: -9,
    particles: [],
    trail: [],
  };
}

/** 发球：球从挡板前方射向 AI，带小幅随机横向分量 */
function doServe(w: World) {
  const b = w.ball;
  b.x = clamp(w.paddle.x * 0.5, -0.6, 0.6);
  b.y = clamp(w.paddle.y * 0.5, -0.4, 0.4);
  b.z = 0.6;
  const s = levelSpeed(w.level);
  b.vz = s;
  b.vx = (Math.random() * 2 - 1) * s * 0.16;
  b.vy = (Math.random() * 2 - 1) * s * 0.12;
  w.spin.x = 0;
  w.spin.y = 0;
  w.phase = 'play';
  w.trail.length = 0;
  sfx.flip();
}

/** 击中反馈粒子：球形喷射 + 阻尼，z 向随隧道透视 */
function burst(w: World, x: number, y: number, z: number, color: string, n: number) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const e = (Math.random() - 0.5) * Math.PI;
    const sp = 0.8 + Math.random() * 1.6;
    w.particles.push({
      x,
      y,
      z,
      vx: Math.cos(a) * Math.cos(e) * sp,
      vy: Math.sin(e) * sp,
      vz: Math.sin(a) * Math.cos(e) * sp,
      life: 0.3 + Math.random() * 0.25,
      max: 0.55,
      color,
    });
  }
  if (w.particles.length > 120) w.particles.splice(0, w.particles.length - 120);
}

/** 圆角矩形路径（部分老浏览器无 ctx.roundRect） */
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ============ 主组件 ============

type Status = 'ready' | 'playing' | 'paused' | 'over';

export default function Pong3D() {
  const [status, setStatus] = useState<Status>('ready');
  const [score, setScore] = useState(0);
  const [level, setLevel] = useState(1);
  const [lives, setLives] = useState(LIVES);
  const [newRecord, setNewRecord] = useState(false);
  const best = useBestScore(metaPong3D.id);
  const { toast } = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(newWorld());
  const statusRef = useRef<Status>('ready');
  /** 键盘输入态（帧循环读取，避免重渲染） */
  const keysRef = useRef({ l: false, r: false, u: false, d: false });
  /** 结算守卫：over 只结算一次 */
  const overHandledRef = useRef(false);
  /** 多点触控只跟随第一根手指（pointerdown 记录，抬手释放；鼠标悬停不受限） */
  const activePtrRef = useRef<number | null>(null);

  statusRef.current = status;

  const start = useCallback(() => {
    worldRef.current = newWorld();
    worldRef.current.serveAt = performance.now() + 1200;
    overHandledRef.current = false;
    setScore(0);
    setLevel(1);
    setLives(LIVES);
    setNewRecord(false);
    setStatus('playing');
  }, []);

  /** 恢复时重置自动发球计时，避免暂停期间墙钟流逝导致一恢复就发球 */
  const resume = useCallback(() => {
    const w = worldRef.current;
    if (w.phase === 'serve') w.serveAt = performance.now() + 700;
    w.ai.thinkAt = performance.now();
    setStatus('playing');
  }, []);

  const togglePause = useCallback(() => {
    const s = statusRef.current;
    if (s === 'playing') setStatus('paused');
    else if (s === 'paused') resume();
  }, [resume]);

  // ============ 键盘 ============

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.code;
      if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault();
      const keys = keysRef.current;
      if (k === 'ArrowLeft' || k === 'KeyA') keys.l = true;
      else if (k === 'ArrowRight' || k === 'KeyD') keys.r = true;
      else if (k === 'ArrowUp' || k === 'KeyW') keys.u = true;
      else if (k === 'ArrowDown' || k === 'KeyS') keys.d = true;
      else if (k === 'KeyP') togglePause();
      else if (k === 'Space') {
        const w = worldRef.current;
        if (statusRef.current === 'playing' && w.phase === 'serve') doServe(w);
      } else if (k === 'Enter') {
        const s = statusRef.current;
        if (s === 'ready' || s === 'over') start();
      }
    };
    const up = (e: KeyboardEvent) => {
      const keys = keysRef.current;
      const k = e.code;
      if (k === 'ArrowLeft' || k === 'KeyA') keys.l = false;
      else if (k === 'ArrowRight' || k === 'KeyD') keys.r = false;
      else if (k === 'ArrowUp' || k === 'KeyW') keys.u = false;
      else if (k === 'ArrowDown' || k === 'KeyS') keys.d = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    // 失焦清空按键并自动暂停，避免"按住方向键切窗口后挡板一直跑"；
    // 移动端锁屏/切 App 只发 visibilitychange 不发 blur，需单独兜底
    const clear = () => {
      keysRef.current = { l: false, r: false, u: false, d: false };
      if (statusRef.current === 'playing') setStatus('paused');
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') clear();
    };
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [start, togglePause]);

  // ============ 指针（鼠标悬停 / 触屏拖动直接控制挡板） ============

  /** 屏幕坐标 → 画布内部坐标 */
  const toCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * RW, y: ((e.clientY - rect.top) / rect.height) * RH };
  };

  /** 指针位置逆投影到 z=0 平面 = 挡板目标位 */
  const updateTarget = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (statusRef.current !== 'playing') return;
    if (activePtrRef.current != null && e.pointerId !== activePtrRef.current) return;
    const p = toCanvas(e);
    const s0 = FOCAL / CAM;
    const pad = worldRef.current.paddle;
    pad.tx = clamp((p.x - RW / 2) / s0, -(HX - PHX), HX - PHX);
    pad.ty = clamp((RH / 2 - p.y) / s0, -(HY - PHY), HY - PHY);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (statusRef.current !== 'playing') return;
    if (activePtrRef.current == null) activePtrRef.current = e.pointerId;
    updateTarget(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const w = worldRef.current;
    if (w.phase === 'serve') doServe(w);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePtrRef.current === e.pointerId) activePtrRef.current = null;
  };

  // ============ 主循环（常驻 rAF：ready/over 状态也渲染隧道作背景） ============

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 矢量霓虹风格在 HiDPI 屏上按 DPR 放大 backing store（封顶 2 控性能），逻辑坐标仍用 RW×RH
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = RW * dpr;
    canvas.height = RH * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 深空背景（每帧复用）
    const bg = ctx.createRadialGradient(RW / 2, RH / 2, 40, RW / 2, RH / 2, RW * 0.72);
    bg.addColorStop(0, '#131a36');
    bg.addColorStop(1, '#05070f');

    /** 世界坐标 → 屏幕投影（相机在 z=-CAM 看向 +z） */
    const proj = (x: number, y: number, z: number) => {
      const s = FOCAL / (z + CAM);
      return { x: RW / 2 + x * s, y: RH / 2 - y * s, s };
    };
    const line = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };
    const quad = (pts: { x: number; y: number }[], fill: string) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };

    let raf = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const w = worldRef.current;
      const playing = statusRef.current === 'playing';
      const t = now / 1000;

      // ---- 更新 ----
      if (playing) {
        const p = w.paddle;
        // 键盘微调目标位（指针移动时直接改写 tx/ty）
        const keys = keysRef.current;
        p.tx = clamp(p.tx + ((keys.r ? 1 : 0) - (keys.l ? 1 : 0)) * KEY_SPEED * dt, -(HX - PHX), HX - PHX);
        p.ty = clamp(p.ty + ((keys.u ? 1 : 0) - (keys.d ? 1 : 0)) * KEY_SPEED * dt, -(HY - PHY), HY - PHY);
        // 挡板平滑趋近目标 + 指数平滑的速度估计（挥拍速度 → 侧旋）
        const follow = 1 - Math.exp(-22 * dt);
        const px0 = p.x;
        const py0 = p.y;
        p.x += (p.tx - p.x) * follow;
        p.y += (p.ty - p.y) * follow;
        // 速度估计的平滑系数按 dt 归一（0.45 ≈ 60Hz 每帧系数，不归一会让高刷屏手感漂移）
        const smooth = 1 - Math.exp(-36 * dt);
        p.vx += ((p.x - px0) / Math.max(dt, 1e-4) - p.vx) * smooth;
        p.vy += ((p.y - py0) / Math.max(dt, 1e-4) - p.vy) * smooth;

        const b = w.ball;
        if (w.phase === 'serve') {
          // 待发：球吸附在挡板前半幅处，到点自动发出
          b.x += (p.x * 0.5 - b.x) * follow;
          b.y += (p.y * 0.5 - b.y) * follow;
          b.z = 0.6;
          if (now >= w.serveAt) doServe(w);
        } else {
          // 侧旋（马格努斯简化）：持续掰弯横向速度并指数衰减
          b.vx += w.spin.x * dt;
          b.vy += w.spin.y * dt;
          const decay = Math.exp(-1.9 * dt);
          w.spin.x *= decay;
          w.spin.y *= decay;
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          b.z += b.vz * dt;

          // 墙面反弹
          if (b.x > HX - BALL_R) {
            b.x = HX - BALL_R;
            b.vx = -Math.abs(b.vx);
            w.spin.x *= 0.5;
            sfx.click();
            burst(w, b.x, b.y, b.z, '#7ce7ff', 8);
          } else if (b.x < -(HX - BALL_R)) {
            b.x = -(HX - BALL_R);
            b.vx = Math.abs(b.vx);
            w.spin.x *= 0.5;
            sfx.click();
            burst(w, b.x, b.y, b.z, '#7ce7ff', 8);
          }
          if (b.y > HY - BALL_R) {
            b.y = HY - BALL_R;
            b.vy = -Math.abs(b.vy);
            w.spin.y *= 0.5;
            sfx.click();
            burst(w, b.x, b.y, b.z, '#7ce7ff', 8);
          } else if (b.y < -(HY - BALL_R)) {
            b.y = -(HY - BALL_R);
            b.vy = Math.abs(b.vy);
            w.spin.y *= 0.5;
            sfx.click();
            burst(w, b.x, b.y, b.z, '#7ce7ff', 8);
          }

          // 玩家平面（z=0）：球心越过平面少许仍可视作击中（宽容判定）
          if (b.vz < 0 && b.z <= BALL_R) {
            const inX = Math.abs(b.x - p.x) <= PHX + BALL_R * 0.7;
            const inY = Math.abs(b.y - p.y) <= PHY + BALL_R * 0.7;
            if (inX && inY) {
              // 回击：越回击越快（封顶为当前等级速度 +1.8）
              const sNext = Math.min(levelSpeed(w.level) + 1.8, Math.abs(b.vz) * 1.02 + 0.05);
              b.z = BALL_R + 0.001;
              b.vz = sNext;
              // 落点偏离挡板中心 → 角度回击；挥拍速度 → 横向速度 + 侧旋
              b.vx = b.vx * 0.25 + (b.x - p.x) * 1.5 + p.vx * 0.5;
              b.vy = b.vy * 0.25 + (b.y - p.y) * 1.3 + p.vy * 0.5;
              const lat = sNext * 0.6;
              b.vx = clamp(b.vx, -lat, lat);
              b.vy = clamp(b.vy, -lat, lat);
              w.spin.x = clamp(p.vx * 1.1, -2.4, 2.4);
              w.spin.y = clamp(p.vy * 1.1, -2.4, 2.4);
              w.hitFlash = t;
              burst(w, b.x, b.y, 0.1, '#8ff2ff', 14);
              sfx.move();
              w.score += HIT_SCORE;
              setScore(w.score);
            } else if (b.z < -0.55) {
              // 漏接
              w.lives -= 1;
              setLives(w.lives);
              w.hurtFlash = t;
              burst(w, clamp(b.x, -HX, HX), clamp(b.y, -HY, HY), 0.2, '#ff6b81', 18);
              if (w.lives <= 0) {
                sfx.lose();
                // 立即同步 statusRef：重渲染完成前的帧不再重复更新
                statusRef.current = 'over';
                setStatus('over');
              } else {
                sfx.mismatch();
                toast(`💔 漏球！剩余 ${w.lives} 条命`, 'info');
                w.phase = 'serve';
                w.serveAt = now + 1100;
                w.trail.length = 0;
              }
            }
          }

          // AI 平面（z=D）
          if (b.vz > 0 && b.z >= D - BALL_R) {
            const inX = Math.abs(b.x - w.ai.x) <= AI_HX + BALL_R * 0.7;
            const inY = Math.abs(b.y - w.ai.y) <= AI_HY + BALL_R * 0.7;
            if (inX && inY) {
              b.z = D - BALL_R - 0.001;
              b.vz = -Math.abs(b.vz);
              b.vx = b.vx * 0.3 + (b.x - w.ai.x) * 0.9;
              b.vy = b.vy * 0.3 + (b.y - w.ai.y) * 0.9;
              const lat = Math.abs(b.vz) * 0.55;
              b.vx = clamp(b.vx, -lat, lat);
              b.vy = clamp(b.vy, -lat, lat);
              w.spin.x *= 0.4;
              w.spin.y *= 0.4;
              w.aiFlash = t;
              burst(w, b.x, b.y, D - 0.1, '#ff8d9e', 12);
              sfx.drop();
            } else if (b.z > D + 0.55) {
              // AI 漏接：得分 + 升级加速
              w.score += MISS_SCORE;
              w.level += 1;
              setScore(w.score);
              setLevel(w.level);
              w.scoreFlash = t;
              sfx.match();
              toast(`⚡ 第 ${w.level} 级 · 球速提升！`, 'success');
              burst(w, clamp(b.x, -HX, HX), clamp(b.y, -HY, HY), D - 0.2, '#7dffb0', 22);
              w.phase = 'serve';
              w.serveAt = now + 1000;
              w.trail.length = 0;
            }
          }

          // 拖尾
          w.trail.push({ x: b.x, y: b.y, z: b.z });
          if (w.trail.length > 12) w.trail.shift();
        }

        // ---- AI：120ms 反应一次，预判落点含一次墙面反弹折叠 + 低级误差 ----
        const ai = w.ai;
        if (now >= ai.thinkAt) {
          ai.thinkAt = now + 120;
          if (w.phase === 'play' && b.vz > 0) {
            const tt = (D - b.z) / b.vz;
            ai.tx = fold(b.x + b.vx * tt, -(HX - BALL_R), HX - BALL_R);
            ai.ty = fold(b.y + b.vy * tt, -(HY - BALL_R), HY - BALL_R);
            const err = Math.max(0.02, 0.16 - w.level * 0.012);
            ai.tx += (Math.random() * 2 - 1) * err;
            ai.ty += (Math.random() * 2 - 1) * err;
          } else {
            // 球飞向玩家时回防中路偏球侧
            ai.tx = b.x * 0.3;
            ai.ty = b.y * 0.3;
          }
          ai.tx = clamp(ai.tx, -(HX - AI_HX), HX - AI_HX);
          ai.ty = clamp(ai.ty, -(HY - AI_HY), HY - AI_HY);
        }
        const asp = aiMaxSpeed(w.level);
        const adx = ai.tx - ai.x;
        const ady = ai.ty - ai.y;
        const ad = Math.hypot(adx, ady);
        if (ad > 1e-4) {
          const step = Math.min(ad, asp * dt);
          ai.x += (adx / ad) * step;
          ai.y += (ady / ad) * step;
        }
      }

      // ---- 粒子（不受 playing 门控：暂停/结算时余烬继续飘散，纯装饰且有 120 上限） ----
      for (let i = w.particles.length - 1; i >= 0; i--) {
        const pt = w.particles[i];
        pt.life -= dt;
        if (pt.life <= 0) {
          w.particles.splice(i, 1);
          continue;
        }
        const drag = Math.exp(-2.6 * dt);
        pt.vx *= drag;
        pt.vy *= drag;
        pt.vz *= drag;
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        pt.z += pt.vz * dt;
      }

      // ---- 渲染 ----
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, RW, RH);

      const n1 = proj(-HX, -HY, 0);
      const n2 = proj(HX, HY, 0);
      const f1 = proj(-HX, -HY, D);
      const f2 = proj(HX, HY, D);

      // 尽头端墙（AI 侧，红色呼吸框）
      ctx.fillStyle = '#0c1126';
      ctx.fillRect(f1.x, f2.y, f2.x - f1.x, f1.y - f2.y);
      const aiPulse = Math.max(0, 1 - (t - w.aiFlash) * 3);
      ctx.strokeStyle = `rgba(255,110,135,${0.45 + 0.15 * Math.sin(t * 2.2) + aiPulse * 0.5})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(f1.x, f2.y, f2.x - f1.x, f1.y - f2.y);

      // 四面隧道壁（近深远浅的蓝灰，营造纵深）
      quad([{ x: n1.x, y: n2.y }, { x: n2.x, y: n2.y }, { x: f2.x, y: f2.y }, { x: f1.x, y: f2.y }], 'rgba(13,18,42,0.88)'); // 顶
      quad([n1, n2, f2, f1], 'rgba(24,32,66,0.88)'); // 底
      quad([{ x: n1.x, y: n2.y }, n1, f1, { x: f1.x, y: f2.y }], 'rgba(17,23,50,0.88)'); // 左
      quad([{ x: n2.x, y: n2.y }, n2, f2, { x: f2.x, y: f2.y }], 'rgba(21,27,56,0.88)'); // 右

      // 横向网格环：随深度衰减；球所在的环增亮 = 击球时机提示
      for (let z = 1; z < D; z++) {
        const boost = w.phase === 'play' ? Math.max(0, 1 - Math.abs(z - w.ball.z) / 1.3) : 0;
        const a = 0.3 * (1 - z / 14) + boost * 0.5;
        const p1 = proj(-HX, -HY, z);
        const p2 = proj(HX, HY, z);
        ctx.strokeStyle = `rgba(86,225,255,${a.toFixed(3)})`;
        ctx.lineWidth = boost > 0.1 ? 2 : 1;
        ctx.strokeRect(p1.x, p2.y, p2.x - p1.x, p1.y - p2.y);
      }
      // 四条棱线（亮）+ 墙面中线（暗）
      ctx.strokeStyle = 'rgba(120,240,255,0.5)';
      ctx.lineWidth = 1.5;
      for (const [cx, cy] of [
        [-HX, -HY],
        [HX, -HY],
        [-HX, HY],
        [HX, HY],
      ] as const) {
        line(proj(cx, cy, 0), proj(cx, cy, D));
      }
      ctx.strokeStyle = 'rgba(86,225,255,0.13)';
      ctx.lineWidth = 1;
      for (const x of [-HX / 2, 0, HX / 2]) {
        line(proj(x, -HY, 0), proj(x, -HY, D));
        line(proj(x, HY, 0), proj(x, HY, D));
      }
      for (const y of [-HY / 2, 0, HY / 2]) {
        line(proj(-HX, y, 0), proj(-HX, y, D));
        line(proj(HX, y, 0), proj(HX, y, D));
      }
      // 近端框（屏幕内的隧道口）
      ctx.strokeStyle = 'rgba(140,245,255,0.8)';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(n1.x, n2.y, n2.x - n1.x, n1.y - n2.y);

      // 球的地面投影（深度/高度线索，辅助预判落点）
      const b = w.ball;
      const sh = proj(b.x, -HY, b.z);
      const sr = Math.max(1, BALL_R * sh.s);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(sh.x, sh.y, sr * 1.15, sr * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();

      // 球色随速度由青转橙红
      const spd = Math.abs(b.vz);
      const hue = Math.round(192 - 176 * clamp((spd - 4.6) / 5.9, 0, 1));
      // 拖尾（近实远虚）
      for (let i = 0; i < w.trail.length; i++) {
        const tp = w.trail[i];
        const pr = proj(tp.x, tp.y, tp.z);
        const k = i / w.trail.length;
        ctx.fillStyle = `hsla(${hue},95%,68%,${(k * 0.32).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, Math.max(0.5, BALL_R * pr.s * (0.4 + 0.6 * k)), 0, Math.PI * 2);
        ctx.fill();
      }
      // 球体：光晕 + 径向渐变 + 高光
      const bp = proj(b.x, b.y, b.z);
      const br = Math.max(1.5, BALL_R * bp.s);
      const glow = ctx.createRadialGradient(bp.x, bp.y, br * 0.2, bp.x, bp.y, br * 2.6);
      glow.addColorStop(0, `hsla(${hue},100%,70%,0.5)`);
      glow.addColorStop(1, `hsla(${hue},100%,60%,0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, br * 2.6, 0, Math.PI * 2);
      ctx.fill();
      const body = ctx.createRadialGradient(bp.x - br * 0.35, bp.y - br * 0.35, br * 0.1, bp.x, bp.y, br);
      body.addColorStop(0, '#ffffff');
      body.addColorStop(0.35, `hsl(${hue},95%,72%)`);
      body.addColorStop(1, `hsl(${hue},90%,42%)`);
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, br, 0, Math.PI * 2);
      ctx.fill();

      // AI 挡板（尽头，红色实心）
      const ap = proj(w.ai.x, w.ai.y, D);
      const aw = AI_HX * ap.s;
      const ah = AI_HY * ap.s;
      rr(ctx, ap.x - aw, ap.y - ah, aw * 2, ah * 2, 3);
      ctx.fillStyle = `rgba(255,${Math.round(70 + aiPulse * 60)},${Math.round(90 + aiPulse * 60)},0.85)`;
      ctx.fill();
      ctx.strokeStyle = `rgba(255,150,165,${0.7 + aiPulse * 0.3})`;
      ctx.lineWidth = 1.5 + aiPulse * 2;
      ctx.stroke();

      // 粒子
      for (const pt of w.particles) {
        if (pt.z + CAM < 0.6) continue; // 飞到相机后方则不画
        const pr = proj(pt.x, pt.y, pt.z);
        ctx.globalAlpha = Math.max(0, pt.life / pt.max) * 0.85;
        ctx.fillStyle = pt.color;
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, Math.max(0.6, 0.035 * pr.s), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 玩家挡板（近端，青色描边 + 准星，击中瞬间增亮）
      const hit = Math.max(0, 1 - (t - w.hitFlash) * 4);
      const pp = proj(w.paddle.x, w.paddle.y, 0);
      const pw = PHX * pp.s;
      const ph = PHY * pp.s;
      rr(ctx, pp.x - pw, pp.y - ph, pw * 2, ph * 2, 8);
      ctx.fillStyle = `rgba(90,225,255,${0.07 + hit * 0.18})`;
      ctx.fill();
      ctx.lineWidth = 2.5 + hit * 1.5;
      ctx.strokeStyle = `rgba(${Math.round(140 + hit * 115)},240,255,0.85)`;
      ctx.stroke();
      ctx.strokeStyle = `rgba(160,245,255,${0.35 + hit * 0.4})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pp.x - pw * 0.4, pp.y);
      ctx.lineTo(pp.x + pw * 0.4, pp.y);
      ctx.moveTo(pp.x, pp.y - ph * 0.4);
      ctx.lineTo(pp.x, pp.y + ph * 0.4);
      ctx.stroke();

      // 待发提示：文字 + 球周脉冲环
      if (statusRef.current === 'playing' && w.phase === 'serve') {
        const pulse = 0.55 + 0.45 * Math.sin(t * 6);
        ctx.fillStyle = `rgba(220,250,255,${0.55 + 0.3 * pulse})`;
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('点击画面 / 空格 立即发球', RW / 2, RH - 22);
        ctx.strokeStyle = `rgba(150,240,255,${0.8 - pulse * 0.4})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bp.x, bp.y, br * (1.6 + 0.5 * pulse), 0, Math.PI * 2);
        ctx.stroke();
      }

      // 得分绿闪 / 失命红闪
      const sf = Math.max(0, 1 - (t - w.scoreFlash) * 2.4);
      if (sf > 0) {
        ctx.fillStyle = `rgba(60,255,160,${sf * 0.16})`;
        ctx.fillRect(0, 0, RW, RH);
      }
      const hf = Math.max(0, 1 - (t - w.hurtFlash) * 2);
      if (hf > 0) {
        ctx.fillStyle = `rgba(255,50,80,${hf * 0.22})`;
        ctx.fillRect(0, 0, RW, RH);
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============ 结算 ============

  useEffect(() => {
    if (status !== 'over') return;
    if (overHandledRef.current) return;
    overHandledRef.current = true;
    const sc = worldRef.current.score;
    // 0 分不入档，避免大厅显示"最高分 0"
    const isNew = sc > 0 && best.updateBest(sc, (a, b) => a > b);
    setNewRecord(isNew);
    if (isNew) {
      sfx.record();
      toast(`🏆 新纪录！${sc} 分`, 'record');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <GameShell
      meta={metaPong3D}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>得分</span>
            <strong>{score}</strong>
          </div>
          <div className="stat-box">
            <span>等级</span>
            <strong>{level}</strong>
          </div>
          <div className="stat-box">
            <span>生命</span>
            <strong className="p3d-lives">
              {'♥'.repeat(lives)}
              {'♡'.repeat(Math.max(0, LIVES - lives))}
            </strong>
          </div>
          <div className="stat-box">
            <span>{metaPong3D.bestScoreLabel}</span>
            <strong>{best.value != null ? best.value : '—'}</strong>
          </div>
        </>
      }
    >
      <div className="p3d">
        <div className="p3d-stage">
          <canvas
            ref={canvasRef}
            className="p3d-canvas"
            role="img"
            aria-label="3D 乒乓球游戏画面"
            onPointerDown={onPointerDown}
            onPointerMove={updateTarget}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {status === 'ready' && (
            <div className="p3d-overlay">
              <h2>🏓 3D 乒乓球</h2>
              <p>
                在霓虹隧道中迎战 AI：移动挡板回击来球，
                <br />
                击球瞬间挥动挡板还能给球加上侧旋！
                <br />
                让 AI 漏接得分，每次得分后球速提升。
              </p>
              <p className="p3d-keys">🖱 鼠标悬停 / 触屏拖动移动挡板 · 方向键微调 · 空格发球 · P 暂停</p>
              <button className="btn btn-primary" onClick={start}>
                开始游戏
              </button>
            </div>
          )}
          {status === 'paused' && (
            <div className="p3d-overlay">
              <h2>⏸ 已暂停</h2>
              <button className="btn btn-primary" onClick={resume}>
                继续
              </button>
            </div>
          )}
          {status === 'over' && (
            <div className="p3d-overlay">
              <h2>🏁 比赛结束</h2>
              <p>
                得分 {score} · 打到第 {level} 级
                {newRecord ? ' · 🏆 新纪录！' : best.value != null ? ` · 最佳 ${best.value}` : ''}
              </p>
              <button className="btn btn-primary" onClick={start}>
                再来一局
              </button>
            </div>
          )}
        </div>
        <div className="p3d-actions">
          <button
            className="btn btn-ghost"
            onClick={togglePause}
            disabled={status !== 'playing' && status !== 'paused'}
          >
            {status === 'paused' ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button className="btn btn-ghost" onClick={start}>
            🔄 重新开始
          </button>
        </div>
        <p className="hint">球飞到的光环会增亮提示击球时机 · 挥拍越快旋转越强</p>
      </div>
    </GameShell>
  );
}
