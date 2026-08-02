import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaBirds } from '../core/gameMetas';

const W = 480;
const H = 400;
const GROUND = 350;
const GRAVITY = 0.3;
const PULL_K = 0.14;
const MAX_PULL = 95;
const SLING_X = 95;
const SLING_Y = 300;
const BIRD_R = 13;

interface Pig {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  alive: boolean;
  flying: boolean;
}

interface Crate {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  rot: number;
  alive: boolean;
  flying: boolean;
  /** 已被鸟撞过：落地后不再与鸟碰撞，避免卡在木块里反复弹跳 */
  bounced: boolean;
}

interface Floater {
  x: number;
  y: number;
  text: string;
  t: number;
}

interface GameState {
  status: 'ready' | 'playing' | 'over';
  level: number;
  score: number;
  birds: number;
  pullX: number;
  pullY: number;
  aiming: boolean;
  bird: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    rot: number;
    state: 'idle' | 'flying' | 'grounded' | 'gone';
  };
  pigs: Pig[];
  crates: Crate[];
  floaters: Floater[];
  endTimer: number;
}

/** 关卡模板：crates=[x,y,w,h] pigs=[x,y,r] */
const TEMPLATES: Array<{
  crates: Array<[number, number, number, number]>;
  pigs: Array<[number, number, number]>;
}> = [
  {
    crates: [
      [348, 280, 16, 70],
      [368, 280, 16, 70],
      [350, 266, 52, 14],
    ],
    pigs: [
      [356, 248, 18],
      [305, 330, 20],
    ],
  },
  {
    crates: [
      [310, 290, 16, 60],
      [330, 290, 16, 60],
      [312, 276, 52, 14],
      [400, 310, 16, 40],
      [420, 310, 16, 40],
      [402, 296, 52, 14],
    ],
    pigs: [
      [318, 258, 18],
      [408, 278, 16],
      [455, 330, 20],
    ],
  },
  {
    crates: [
      [300, 290, 16, 60],
      [320, 290, 16, 60],
      [302, 276, 52, 14],
      [370, 320, 16, 30],
      [390, 320, 16, 30],
      [372, 306, 52, 14],
      [440, 300, 16, 50],
      [460, 300, 16, 50],
      [442, 286, 52, 14],
    ],
    pigs: [
      [308, 258, 18],
      [378, 288, 16],
      [448, 268, 16],
      [270, 330, 20],
    ],
  },
  {
    crates: [
      [300, 290, 16, 60],
      [320, 290, 16, 60],
      [302, 276, 52, 14],
      [370, 320, 16, 30],
      [390, 320, 16, 30],
      [372, 306, 52, 14],
      [440, 300, 16, 50],
      [460, 300, 16, 50],
      [442, 286, 52, 14],
      [350, 320, 16, 30],
    ],
    pigs: [
      [308, 258, 18],
      [378, 288, 16],
      [448, 268, 16],
      [270, 330, 20],
      [240, 332, 18],
    ],
  },
];

const CLOUDS = [
  { x: 60, y: 44, s: 1 },
  { x: 236, y: 28, s: 0.8 },
  { x: 385, y: 76, s: 0.62 },
];

function buildLevel(lv: number) {
  const t = TEMPLATES[Math.min(lv - 1, TEMPLATES.length - 1)];
  const pigs = [...t.pigs];
  const extra = Math.max(0, lv - TEMPLATES.length);
  for (let i = 0; i < extra && pigs.length < 8; i++) {
    pigs.push([245 - i * 30, GROUND - 18, 18]);
  }
  return { crates: t.crates, pigs, birds: Math.max(3, pigs.length + 2) };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export default function AngryBirds() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'ready' | 'playing' | 'over'>('ready');
  const [level, setLevel] = useState(1);
  const [score, setScore] = useState(0);
  const [birdsLeft, setBirdsLeft] = useState(0);
  const best = useBestScore(metaBirds.id);
  const { toast } = useToast();
  const bestRef = useRef(best);
  bestRef.current = best;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const g = useRef<GameState>({
    status: 'ready',
    level: 1,
    score: 0,
    birds: 0,
    pullX: 0,
    pullY: 0,
    aiming: false,
    bird: { x: SLING_X, y: SLING_Y - BIRD_R, vx: 0, vy: 0, rot: 0, state: 'idle' },
    pigs: [],
    crates: [],
    floaters: [],
    endTimer: 0,
  });

  const loadLevel = useCallback((lv: number) => {
    const { crates, pigs, birds } = buildLevel(lv);
    const gg = g.current;
    gg.level = lv;
    gg.birds = birds;
    gg.pigs = pigs.map(([x, y, r]) => ({ x, y, r, vx: 0, vy: 0, alive: true, flying: false }));
    gg.crates = crates.map(([x, y, w, h]) => ({ x, y, w, h, vx: 0, vy: 0, rot: 0, alive: true, flying: false, bounced: false }));
    gg.bird = { x: SLING_X, y: SLING_Y - BIRD_R, vx: 0, vy: 0, rot: 0, state: 'idle' };
    gg.pullX = 0;
    gg.pullY = 0;
    gg.aiming = false;
    gg.floaters = [];
    gg.endTimer = 0;
    setBirdsLeft(birds);
  }, []);

  const start = useCallback(() => {
    const gg = g.current;
    gg.score = 0;
    loadLevel(1);
    setScore(0);
    setLevel(1);
    gg.status = 'playing';
    setStatus('playing');
  }, [loadLevel]);

  const restart = useCallback(() => {
    const gg = g.current;
    loadLevel(gg.level);
    gg.status = 'playing';
    setStatus('playing');
  }, [loadLevel]);

  const finishTurn = useCallback(() => {
    const gg = g.current;
    const pigsAlive = gg.pigs.filter((p) => p.alive).length;
    if (pigsAlive === 0) {
      gg.score += 50;
      gg.endTimer = 0;
      const isNew = bestRef.current.updateBest(gg.level, (a, b) => a > b);
      toastRef.current(`🎉 第 ${gg.level} 关通过！+50`, isNew ? 'record' : 'success');
      if (isNew) sfx.record();
      else sfx.win();
      loadLevel(gg.level + 1);
      setScore(gg.score);
      setLevel(gg.level);
    } else {
      gg.birds -= 1;
      gg.endTimer = 0;
      setBirdsLeft(gg.birds);
      if (gg.birds <= 0) {
        gg.status = 'over';
        setStatus('over');
        sfx.lose();
      } else {
        gg.bird = { x: SLING_X, y: SLING_Y - BIRD_R, vx: 0, vy: 0, rot: 0, state: 'idle' };
        gg.pullX = 0;
        gg.pullY = 0;
        gg.aiming = false;
        sfx.flip();
      }
    }
  }, [loadLevel]);

  const update = useCallback(() => {
    const gg = g.current;
    if (gg.status !== 'playing') return;
    const b = gg.bird;

    // 鸟飞行
    if (b.state === 'flying') {
      b.vy += GRAVITY;
      b.vx *= 0.996;
      b.x += b.vx;
      b.y += b.vy;
      b.rot = Math.atan2(b.vy, b.vx);
      if (b.y >= GROUND - BIRD_R) {
        b.y = GROUND - BIRD_R;
        if (Math.abs(b.vx) < 0.6) {
          b.vx = 0;
          b.vy = 0;
          b.state = 'grounded';
        } else {
          b.vy = 0;
          b.vx *= 0.86;
        }
      }
      if (b.x < -80 || b.x > W + 80 || b.y > H + 40) b.state = 'gone';
      if (b.state === 'flying') collideBird();
    }

    // 飞行的木块
    for (const c of gg.crates) {
      if (!c.alive || !c.flying) continue;
      c.vy += GRAVITY;
      c.x += c.vx;
      c.y += c.vy;
      c.rot += c.vx * 0.02;
      if (c.y + c.h >= GROUND) {
        c.y = GROUND - c.h;
        if (Math.abs(c.vx) < 0.6) {
          c.vx = 0;
          c.vy = 0;
          c.flying = false;
          c.rot = 0;
        } else {
          c.vy = 0;
          c.vx *= 0.85;
        }
      }
      if (c.x < -120 || c.x > W + 120 || c.y > H + 60) {
        c.alive = false;
        c.flying = false;
      }
    }

    // 飞行的猪
    for (const p of gg.pigs) {
      if (!p.alive || !p.flying) continue;
      p.vy += GRAVITY;
      p.x += p.vx;
      p.y += p.vy;
      if (p.y >= GROUND - p.r) {
        p.y = GROUND - p.r;
        if (Math.abs(p.vx) < 0.6) {
          p.vx = 0;
          p.vy = 0;
          p.flying = false;
        } else {
          p.vy = 0;
          p.vx *= 0.85;
        }
      }
      if (p.x < -100 || p.x > W + 100 || p.y > H + 60) {
        p.alive = false;
        p.flying = false;
      }
    }

    // 飞木块连锁（撞猪 / 撞静止木块）
    for (const c of gg.crates) {
      if (!c.alive || !c.flying) continue;
      for (const p of gg.pigs) {
        if (!p.alive) continue;
        const nx = Math.max(c.x, Math.min(p.x, c.x + c.w));
        const ny = Math.max(c.y, Math.min(p.y, c.y + c.h));
        const dx = p.x - nx;
        const dy = p.y - ny;
        if (dx * dx + dy * dy < p.r * p.r) {
          p.alive = false;
          p.flying = true;
          p.vx = c.vx * 0.5;
          p.vy = c.vy * 0.4 - 1.5;
          c.vx *= 0.55;
          c.vy *= 0.55;
          gg.score += 10;
          setScore(gg.score);
          gg.floaters.push({ x: p.x, y: p.y - 10, text: '+10', t: 0 });
          sfx.clear();
        }
      }
      for (const d of gg.crates) {
        if (!d.alive || d === c || d.flying) continue;
        if (c.x < d.x + d.w && c.x + c.w > d.x && c.y < d.y + d.h && c.y + c.h > d.y) {
          d.flying = true;
          d.vx = c.vx * 0.5;
          d.vy = c.vy * 0.4;
          c.vx *= 0.5;
          c.vy *= 0.4;
          sfx.drop();
        }
      }
    }

    // 飘字
    for (let i = gg.floaters.length - 1; i >= 0; i--) {
      const f = gg.floaters[i];
      f.t += 1;
      f.y -= 0.8;
      if (f.t > 45) gg.floaters.splice(i, 1);
    }

    // 回合结束判定
    if (b.state === 'grounded' || b.state === 'gone') {
      const moving = gg.crates.some((c) => c.flying && c.alive) || gg.pigs.some((p) => p.flying && p.alive);
      if (!moving) {
        gg.endTimer += 1;
        if (gg.endTimer > 50) finishTurn();
      } else gg.endTimer = 0;
    } else gg.endTimer = 0;
  }, [finishTurn]);

  function collideBird() {
    const gg = g.current;
    const b = gg.bird;
    for (const p of gg.pigs) {
      if (!p.alive) continue;
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      const rr = p.r + BIRD_R;
      if (dx * dx + dy * dy < rr * rr) {
        p.alive = false;
        p.flying = true;
        p.vx = b.vx * 0.5 + (Math.random() - 0.5) * 2;
        p.vy = b.vy * 0.4 - 2;
        b.vx *= 0.55;
        b.vy *= 0.55;
        gg.score += 10;
        setScore(gg.score);
        gg.floaters.push({ x: p.x, y: p.y - 10, text: '+10', t: 0 });
        sfx.clear();
      }
    }
    for (const c of gg.crates) {
      if (!c.alive || c.flying || c.bounced) continue;
      const nx = Math.max(c.x, Math.min(b.x, c.x + c.w));
      const ny = Math.max(c.y, Math.min(b.y, c.y + c.h));
      const dx = b.x - nx;
      const dy = b.y - ny;
      if (dx * dx + dy * dy < BIRD_R * BIRD_R) {
        c.flying = true;
        c.bounced = true;
        c.vx = b.vx * 0.75;
        c.vy = b.vy * 0.55;
        // 把鸟推出木块，避免卡在木块里反复碰撞导致永不落地
        const dist = Math.hypot(dx, dy) || 1;
        b.x = nx + (dx / dist) * (BIRD_R + 1);
        b.y = ny + (dy / dist) * (BIRD_R + 1);
        b.vx *= 0.5;
        b.vy *= 0.45;
        sfx.drop();
      }
    }
  }

  function draw(ctx: CanvasRenderingContext2D) {
    const gg = g.current;

    // 天空
    const sky = ctx.createLinearGradient(0, 0, 0, GROUND);
    sky.addColorStop(0, '#8ecbff');
    sky.addColorStop(1, '#ddf2ff');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // 太阳
    ctx.fillStyle = 'rgba(255,227,107,0.35)';
    ctx.beginPath();
    ctx.arc(422, 54, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffe36b';
    ctx.beginPath();
    ctx.arc(422, 54, 22, 0, Math.PI * 2);
    ctx.fill();

    // 云
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const c of CLOUDS) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 16 * c.s, 0, Math.PI * 2);
      ctx.arc(c.x + 16 * c.s, c.y + 4 * c.s, 12 * c.s, 0, Math.PI * 2);
      ctx.arc(c.x - 15 * c.s, c.y + 5 * c.s, 11 * c.s, 0, Math.PI * 2);
      ctx.fill();
    }

    // 远山
    ctx.fillStyle = '#a5d073';
    ctx.beginPath();
    ctx.moveTo(0, GROUND);
    ctx.quadraticCurveTo(60, 250, 130, GROUND);
    ctx.quadraticCurveTo(210, 210, 300, GROUND);
    ctx.quadraticCurveTo(390, 255, 480, GROUND);
    ctx.lineTo(480, GROUND);
    ctx.closePath();
    ctx.fill();

    // 地面
    const gd = ctx.createLinearGradient(0, GROUND, 0, H);
    gd.addColorStop(0, '#7cc24a');
    gd.addColorStop(1, '#589c34');
    ctx.fillStyle = gd;
    ctx.fillRect(0, GROUND, W, H - GROUND);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 26; i++) {
      const gx = (i * 19 + 7) % W;
      ctx.beginPath();
      ctx.moveTo(gx, GROUND + 3);
      ctx.lineTo(gx + 4, GROUND + 9);
      ctx.stroke();
    }

    // 弹弓（后叉 + 后皮筋）
    drawSlingBack(ctx, gg);
    // 鸟
    if (gg.bird.state !== 'gone') drawBird(ctx, gg);
    // 弹弓（前皮筋 + 前叉）
    drawSlingFront(ctx, gg);

    // 木块
    for (const c of gg.crates) if (c.alive) drawCrate(ctx, c);
    // 猪
    for (const p of gg.pigs) if (p.alive) drawPig(ctx, p);

    // 飘字
    for (const f of gg.floaters) {
      ctx.fillStyle = '#ffe066';
      ctx.font = 'bold 17px sans-serif';
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 3;
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillText(f.text, f.x, f.y);
    }
  }

  function drawSlingBack(ctx: CanvasRenderingContext2D, gg: GameState) {
    ctx.lineCap = 'round';
    // 底座
    ctx.strokeStyle = '#5c3a1e';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(SLING_X - 12, GROUND - 4);
    ctx.lineTo(SLING_X + 12, GROUND - 4);
    ctx.stroke();
    // 主杆 + 后叉（鸟后方）
    ctx.strokeStyle = '#7a4f28';
    ctx.beginPath();
    ctx.moveTo(SLING_X, GROUND - 6);
    ctx.lineTo(SLING_X - 2, SLING_Y - 46);
    ctx.stroke();
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(SLING_X - 2, SLING_Y - 46);
    ctx.lineTo(SLING_X - 18, SLING_Y - 58);
    ctx.stroke();
    // 后皮筋（后叉 → 鸟）
    if (gg.bird.state !== 'gone') {
      ctx.strokeStyle = '#4a1f0d';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(SLING_X - 18, SLING_Y - 58);
      ctx.lineTo(gg.bird.x, gg.bird.y);
      ctx.stroke();
    }
  }

  function drawSlingFront(ctx: CanvasRenderingContext2D, gg: GameState) {
    ctx.lineCap = 'round';
    // 前皮筋（鸟 → 前叉）
    if (gg.bird.state !== 'gone') {
      ctx.strokeStyle = '#4a1f0d';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(gg.bird.x, gg.bird.y);
      ctx.lineTo(SLING_X + 12, SLING_Y - 52);
      ctx.stroke();
    }
    // 前叉
    ctx.strokeStyle = '#8a5a2e';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(SLING_X, GROUND - 6);
    ctx.lineTo(SLING_X + 12, SLING_Y - 52);
    ctx.stroke();
    // 皮筋结
    ctx.fillStyle = '#4a1f0d';
    ctx.beginPath();
    ctx.arc(SLING_X + 12, SLING_Y - 52, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(SLING_X - 18, SLING_Y - 58, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBird(ctx: CanvasRenderingContext2D, gg: GameState) {
    const b = gg.bird;
    ctx.save();
    ctx.translate(b.x, b.y);
    if (!gg.aiming && b.state === 'flying') ctx.rotate(b.rot);
    // 尾羽
    ctx.fillStyle = '#232323';
    ctx.beginPath();
    ctx.moveTo(-12, -2);
    ctx.lineTo(-20, -7);
    ctx.lineTo(-17, 2);
    ctx.closePath();
    ctx.fill();
    // 身体
    ctx.fillStyle = '#e8382c';
    ctx.beginPath();
    ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
    ctx.fill();
    // 肚皮
    ctx.fillStyle = '#ffd9a0';
    ctx.beginPath();
    ctx.arc(3, 6, 7, 0, Math.PI * 2);
    ctx.fill();
    // 眼睛
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(5, -4, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(6.5, -4, 2.2, 0, Math.PI * 2);
    ctx.fill();
    // 愤怒眉毛
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(1, -9);
    ctx.lineTo(9.5, -5);
    ctx.stroke();
    // 嘴
    ctx.fillStyle = '#f7a72a';
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(19, 2.5);
    ctx.lineTo(9, 5.5);
    ctx.closePath();
    ctx.fill();
    // 头顶羽毛
    ctx.fillStyle = '#232323';
    ctx.beginPath();
    ctx.moveTo(-3, -12);
    ctx.lineTo(-1, -19);
    ctx.lineTo(1.5, -12);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(3, -17);
    ctx.lineTo(4.5, -11);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawPig(ctx: CanvasRenderingContext2D, p: Pig) {
    ctx.save();
    ctx.translate(p.x, p.y);
    if (p.flying) ctx.rotate(Math.atan2(p.vy, p.vx));
    // 耳朵
    ctx.fillStyle = '#4f8f2f';
    ctx.beginPath();
    ctx.arc(-p.r * 0.8, -p.r * 0.72, p.r * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.r * 0.8, -p.r * 0.72, p.r * 0.3, 0, Math.PI * 2);
    ctx.fill();
    // 身体
    ctx.fillStyle = '#6bb53d';
    ctx.beginPath();
    ctx.arc(0, 0, p.r, 0, Math.PI * 2);
    ctx.fill();
    // 鼻子
    ctx.fillStyle = '#8fd05f';
    ctx.beginPath();
    ctx.ellipse(0, p.r * 0.15, p.r * 0.45, p.r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4f8f2f';
    ctx.beginPath();
    ctx.arc(-p.r * 0.18, p.r * 0.15, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.r * 0.18, p.r * 0.15, 2.2, 0, Math.PI * 2);
    ctx.fill();
    // 眼睛
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(-p.r * 0.45, -p.r * 0.28, p.r * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.r * 0.45, -p.r * 0.28, p.r * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(-p.r * 0.45, -p.r * 0.28, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.r * 0.45, -p.r * 0.28, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawCrate(ctx: CanvasRenderingContext2D, c: Crate) {
    ctx.save();
    ctx.translate(c.x + c.w / 2, c.y + c.h / 2);
    if (c.flying) ctx.rotate(c.rot);
    ctx.fillStyle = '#b0793a';
    roundRect(ctx, -c.w / 2, -c.h / 2, c.w, c.h, 3);
    ctx.fill();
    ctx.strokeStyle = '#7d5222';
    ctx.lineWidth = 2;
    roundRect(ctx, -c.w / 2, -c.h / 2, c.w, c.h, 3);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(125,82,34,0.55)';
    ctx.lineWidth = 1.5;
    if (c.w > c.h) {
      ctx.beginPath();
      ctx.moveTo(-c.w / 2 + 4, 0);
      ctx.lineTo(c.w / 2 - 4, 0);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(0, -c.h / 2 + 4);
      ctx.lineTo(0, c.h / 2 - 4);
      ctx.stroke();
    }
    ctx.restore();
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const loop = () => {
      update();
      draw(ctx);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [update]);

  const toLocal = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * W) / rect.width,
      y: ((e.clientY - rect.top) * H) / rect.height,
    };
  };

  const onDown = (e: React.PointerEvent) => {
    const gg = g.current;
    if (gg.status !== 'playing' || gg.bird.state !== 'idle') return;
    const pos = toLocal(e);
    const dx = pos.x - gg.bird.x;
    const dy = pos.y - gg.bird.y;
    if (dx * dx + dy * dy > 70 * 70) return;
    gg.aiming = true;
    canvasRef.current?.setPointerCapture(e.pointerId);
    sfx.click();
  };

  const onMove = (e: React.PointerEvent) => {
    const gg = g.current;
    if (!gg.aiming) return;
    const pos = toLocal(e);
    let px = pos.x - SLING_X;
    let py = pos.y - (SLING_Y - BIRD_R);
    const len = Math.hypot(px, py);
    if (len > MAX_PULL) {
      px = (px / len) * MAX_PULL;
      py = (py / len) * MAX_PULL;
    }
    // 只能向弹弓后方/下方拉（发射方向始终朝右前上方）
    if (px > 20) px = 20;
    if (py < -20) py = -20;
    // 不能拖到地面以下：否则发射瞬间即触发落地分支，竖直速度被清零只剩贴地滚动
    const MAX_PY = GROUND - BIRD_R - (SLING_Y - BIRD_R);
    if (py > MAX_PY) py = MAX_PY;
    gg.pullX = px;
    gg.pullY = py;
    gg.bird.x = SLING_X + px;
    gg.bird.y = SLING_Y - BIRD_R + py;
  };

  const onUp = () => {
    const gg = g.current;
    if (!gg.aiming) return;
    gg.aiming = false;
    const len = Math.hypot(gg.pullX, gg.pullY);
    if (len < 15) {
      gg.bird.x = SLING_X;
      gg.bird.y = SLING_Y - BIRD_R;
      gg.pullX = 0;
      gg.pullY = 0;
      return;
    }
    const b = gg.bird;
    b.vx = -gg.pullX * PULL_K;
    b.vy = -gg.pullY * PULL_K;
    b.state = 'flying';
    gg.pullX = 0;
    gg.pullY = 0;
    sfx.flip();
  };

  return (
    <GameShell
      meta={metaBirds}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>关卡</span>
            <strong>{level}</strong>
          </div>
          <div className="stat-box">
            <span>分数</span>
            <strong>{score}</strong>
          </div>
          <div className="stat-box">
            <span>小鸟</span>
            <strong>🐦×{birdsLeft}</strong>
          </div>
          <div className="stat-box">
            <span>{metaBirds.bestScoreLabel}</span>
            <strong>{best.value ?? 0}</strong>
          </div>
          <button className="btn btn-primary" onClick={status === 'ready' ? start : restart}>
            🔄 {status === 'ready' ? '开始' : '重来'}
          </button>
        </>
      }
    >
      <div className="ab">
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          className="ab-canvas"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        {status === 'ready' && (
          <div className="arcade-overlay ab-overlay">
            <h2>🐦 愤怒的小鸟</h2>
            <p>拖住小鸟向后拉，松手发射！<br />砸毁所有猪猪的堡垒过关</p>
            <button className="btn btn-primary" onClick={start}>
              开始游戏
            </button>
          </div>
        )}
        {status === 'over' && (
          <div className="arcade-overlay ab-overlay">
            <h2>😵 小鸟用完了！</h2>
            <p>
              卡在第 {level} 关 · 得分 {score}
            </p>
            <button className="btn btn-primary" onClick={restart}>
              再来一次
            </button>
          </div>
        )}
        <p className="hint">拖拽弹弓瞄准 · 松手发射 · 木块可连锁砸落猪猪 🐷</p>
      </div>
    </GameShell>
  );
}
