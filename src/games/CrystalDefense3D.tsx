import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { CSSProperties } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { metaCrystalDefense } from '../core/gameMetas';
import {
  CORE_MAX_HP,
  CORE_POS,
  DECOR_LIST,
  ENEMY_DEFS,
  GRID_H,
  GRID_W,
  PAD_LIST,
  ROUTE_LEN,
  SPAWN_POS,
  TOWER_DEFS,
  TOWER_ORDER,
  WAVE_COUNT,
  aliveBosses,
  buildCost,
  callWave,
  createGame,
  drainEvents,
  earlyBonus,
  isPad,
  pathPos,
  placeTower,
  sellTower,
  sellValue,
  towerAt,
  towerStat,
  upgradeCost,
  upgradeTower,
  update,
  waveRemaining,
} from './towerDefenseCore';
import type { DecorKind, Enemy, Fx, GameState, Phase, Tower, TowerKind } from './towerDefenseCore';

/**
 * 3D 晶核防线 —— 等距视角塔防。
 *
 * 与仓库其他 3D 游戏的约定一致：零依赖，Canvas 2D 手写软 3D。
 * 这一款用「静态浮空岛离屏缓存 + 按 x+y 深度排序的动态实体」：
 * 岛面、路径、塔座只画一次，每帧只重绘会动的东西；
 * 塔身、兽群、晶核全部按格子深度远→近排序，因此前排会正确遮挡后排。
 */

// ============ 画面常量 ============

const RW = 820;
const RH = 560;
const TW = 68;
const TH = 34;
const OX = 342;
const OY = 118;
/** 浮空岛侧壁厚度（像素） */
const PLATE = 42;

const STATUS_READY = 'ready';
const STATUS_PLAYING = 'playing';
const STATUS_WON = 'won';
const STATUS_LOST = 'lost';
type Status = typeof STATUS_READY | typeof STATUS_PLAYING | typeof STATUS_WON | typeof STATUS_LOST;

interface View {
  build: TowerKind | null;
  sel: number | null;
  hover: [number, number] | null;
}

interface Hud {
  gold: number;
  score: number;
  coreHp: number;
  wave: number;
  phase: Phase;
  prep: number;
  remaining: number;
  kills: number;
}

function snapshot(w: GameState): Hud {
  return {
    gold: w.gold,
    score: w.score,
    coreHp: w.coreHp,
    wave: w.wave,
    phase: w.phase,
    prep: w.prepT,
    remaining: waveRemaining(w),
    kills: w.kills,
  };
}

// ============ 绘图工具 ============

function isoX(gx: number, gy: number): number {
  return OX + (gx - gy) * (TW / 2);
}

function isoY(gx: number, gy: number, h = 0): number {
  return OY + (gx + gy) * (TH / 2) - h;
}

function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 确定性哈希：同一个格子的细节每次构建都一致 */
function hash2(x: number, y: number): number {
  let n = Math.imul(x + 11, 374761393) + Math.imul(y + 29, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function diamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, tw: number, th: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - th / 2);
  ctx.lineTo(cx + tw / 2, cy);
  ctx.lineTo(cx, cy + th / 2);
  ctx.lineTo(cx - tw / 2, cy);
  ctx.closePath();
}

function fillDiamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, tw: number, th: number, fill: string): void {
  diamond(ctx, cx, cy, tw, th);
  ctx.fillStyle = fill;
  ctx.fill();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const glowCache = new Map<string, HTMLCanvasElement>();

function glowSprite(color: string): HTMLCanvasElement {
  const hit = glowCache.get(color);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 96;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(48, 48, 0, 48, 48, 48);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.22, rgba(color, 0.72));
  grad.addColorStop(0.55, rgba(color, 0.26));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 96, 96);
  glowCache.set(color, c);
  return c;
}

function drawGlow(
  ctx: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  r: number,
  alpha = 1,
): void {
  if (r <= 0 || alpha <= 0) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = Math.min(1, prev * alpha);
  ctx.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = prev;
}

function groundShadow(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, alpha = 0.4): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, rx * 0.42, 0, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(2,6,12,${alpha})`;
  ctx.fill();
}

function rangeEllipse(
  ctx: CanvasRenderingContext2D,
  gx: number,
  gy: number,
  range: number,
  color: string,
  filled: boolean,
): void {
  const x = isoX(gx, gy);
  const y = isoY(gx, gy);
  const rx = range * TW * 0.7071;
  const ry = range * TH * 0.7071;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  if (filled) {
    ctx.fillStyle = rgba(color, 0.1);
    ctx.fill();
  }
  ctx.strokeStyle = rgba(color, 0.72);
  ctx.lineWidth = 1.7;
  ctx.setLineDash([6, 6]);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ============ 静态场景（浮空岛离屏缓存） ============

const CUT_CORNERS = new Set(['0,0', '12,0', '0,8', '12,8']);

function isGroundCell(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H && !CUT_CORNERS.has(`${x},${y}`);
}

function buildScenery(dpr: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(RW * dpr);
  c.height = Math.round(RH * dpr);
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);

  // ---- 深空背景 ----
  const bg = g.createLinearGradient(0, 0, 0, RH);
  bg.addColorStop(0, '#04070f');
  bg.addColorStop(0.5, '#071022');
  bg.addColorStop(1, '#04080f');
  g.fillStyle = bg;
  g.fillRect(0, 0, RW, RH);

  let neb = g.createRadialGradient(RW * 0.72, RH * 0.24, 10, RW * 0.72, RH * 0.24, 260);
  neb.addColorStop(0, 'rgba(42,88,138,0.18)');
  neb.addColorStop(0.6, 'rgba(28,52,92,0.07)');
  neb.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = neb;
  g.fillRect(0, 0, RW, RH);
  neb = g.createRadialGradient(RW * 0.22, RH * 0.7, 10, RW * 0.22, RH * 0.7, 230);
  neb.addColorStop(0, 'rgba(82,52,132,0.12)');
  neb.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = neb;
  g.fillRect(0, 0, RW, RH);

  const rnd = makeRng(20261017);
  for (let i = 0; i < 150; i++) {
    const x = rnd() * RW;
    const y = rnd() * RH;
    const s = rnd() < 0.88 ? 1 : 2;
    g.globalAlpha = 0.12 + rnd() * 0.5;
    g.fillStyle = rnd() < 0.22 ? '#9fd8ff' : rnd() < 0.25 ? '#ffd2a0' : '#e9efff';
    g.fillRect(x, y, s, s);
  }
  g.globalAlpha = 1;

  // 远处淡行星与环
  g.save();
  g.translate(RW * 0.84, 150);
  g.rotate(-0.26);
  g.strokeStyle = 'rgba(126,166,220,0.10)';
  g.lineWidth = 2;
  g.beginPath();
  g.ellipse(0, 0, 92, 22, 0, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.ellipse(0, 0, 104, 26, 0, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(126,166,220,0.05)';
  g.stroke();
  const pg = g.createRadialGradient(-14, -14, 4, 0, 0, 56);
  pg.addColorStop(0, 'rgba(92,130,180,0.22)');
  pg.addColorStop(1, 'rgba(20,30,52,0.05)');
  g.fillStyle = pg;
  g.beginPath();
  g.arc(0, 0, 56, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // 漂浮碎石（远景，静态）
  const shards: Array<[number, number, number]> = [
    [154, 300, 18],
    [688, 372, 22],
    [136, 430, 12],
    [742, 468, 14],
    [684, 94, 9],
  ];
  for (const [sx, sy, r] of shards) {
    g.save();
    g.translate(sx, sy);
    g.fillStyle = 'rgba(16,28,38,0.9)';
    g.beginPath();
    g.moveTo(0, -r * 0.5);
    g.lineTo(r, 0);
    g.lineTo(r * 0.3, r * 0.7);
    g.lineTo(-r * 0.8, r * 0.2);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(96,168,190,0.18)';
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = 'rgba(96,168,190,0.10)';
    g.beginPath();
    g.moveTo(0, -r * 0.15);
    g.lineTo(r * 0.6, 0);
    g.lineTo(-r * 0.1, r * 0.22);
    g.closePath();
    g.fill();
    g.restore();
  }

  // 岛底光晕
  const under = g.createRadialGradient(RW * 0.6, RH * 0.82, 20, RW * 0.6, RH * 0.82, 250);
  under.addColorStop(0, 'rgba(52,186,182,0.14)');
  under.addColorStop(1, 'rgba(20,80,90,0)');
  g.fillStyle = under;
  g.fillRect(0, RH * 0.45, RW, RH * 0.55);

  // ---- 浮空岛侧壁与悬垂岩 ----
  let sum = 0;
  for (sum = 0; sum <= GRID_W + GRID_H - 2; sum++) {
    for (let x = 0; x < GRID_W; x++) {
      const y = sum - x;
      if (!isGroundCell(x, y)) continue;
      const cx = isoX(x, y);
      const cy = isoY(x, y);
      const depth = PLATE + 6 + Math.floor(hash2(x, y) * 16);
      const faces: Array<{ edge: [number, number, number, number]; shade: string; side: number }> = [];
      if (!isGroundCell(x + 1, y)) {
        faces.push({
          edge: [cx, cy + TH / 2, cx + TW / 2, cy],
          shade: '#0c1a22',
          side: 1,
        });
      }
      if (!isGroundCell(x, y + 1)) {
        faces.push({
          edge: [cx - TW / 2, cy, cx, cy + TH / 2],
          shade: '#08131a',
          side: -1,
        });
      }
      for (const face of faces) {
        const [x1, y1, x2, y2] = face.edge;
        // 悬垂岩尖
        for (let s = 0; s < 2; s++) {
          const t = 0.3 + s * 0.36;
          const mx = x1 + (x2 - x1) * t;
          const my = y1 + (y2 - y1) * t + depth;
          const tipW = 5 + hash2(x + s, y + 3) * 9;
          const tipH = 12 + hash2(x + 9, y + s) * 24;
          g.fillStyle = s % 2 === 0 ? '#050c11' : '#071017';
          g.beginPath();
          g.moveTo(mx - tipW, my - 1);
          g.lineTo(mx + tipW, my - 1);
          g.lineTo(mx + (hash2(x, y + s) - 0.5) * 8, my + tipH);
          g.closePath();
          g.fill();
        }
        const grad = g.createLinearGradient(0, Math.min(y1, y2), 0, Math.max(y1, y2) + depth);
        grad.addColorStop(0, face.shade);
        grad.addColorStop(0.45, face.side > 0 ? '#0a151c' : '#071017');
        grad.addColorStop(1, '#03080c');
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.lineTo(x2 + 0, y2 + depth);
        g.lineTo(x1 + 0, y1 + depth);
        g.closePath();
        g.fill();
        // 岩层
        g.strokeStyle = 'rgba(110,168,178,0.055)';
        g.lineWidth = 1;
        for (const k of [0.35, 0.7]) {
          g.beginPath();
          g.moveTo(x1, y1 + depth * k);
          g.lineTo(x2, y2 + depth * k);
          g.stroke();
        }
        g.strokeStyle = 'rgba(126,206,214,0.22)';
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
      }
      // 垂下的冷光晶簇
      if (hash2(x + 4, y + 8) > 0.87) {
        const mx = cx + (hash2(x, y) - 0.5) * TW * 0.5;
        const my = cy + TH / 2 + 10;
        g.fillStyle = 'rgba(96,230,220,0.55)';
        g.beginPath();
        g.moveTo(mx - 3, my);
        g.lineTo(mx + 3, my);
        g.lineTo(mx, my + 18 + hash2(x, y) * 10);
        g.closePath();
        g.fill();
      }
    }
  }

  // ---- 岛面 ----
  for (sum = 0; sum <= GRID_W + GRID_H - 2; sum++) {
    for (let x = 0; x < GRID_W; x++) {
      const y = sum - x;
      if (!isGroundCell(x, y)) continue;
      const cx = isoX(x, y);
      const cy = isoY(x, y);
      const n = hash2(x, y);
      let fill = (x + y) % 2 === 0 ? '#172a32' : '#14242b';
      if (n > 0.82) fill = (x + y) % 2 === 0 ? '#1a2f37' : '#162830';
      fillDiamond(g, cx, cy, TW - 1, TH - 1, fill);
      g.strokeStyle = 'rgba(140,210,216,0.05)';
      g.lineWidth = 1;
      diamond(g, cx, cy, TW - 1, TH - 1);
      g.stroke();
      // 碎裂纹理
      if (n > 0.74) {
        g.strokeStyle = 'rgba(4,12,16,0.55)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(cx - TW * 0.16, cy - TH * 0.06);
        g.lineTo(cx - TW * 0.03, cy + TH * 0.04);
        g.lineTo(cx + TW * 0.1, cy + TH * 0.02);
        g.stroke();
      }
      // 草簇 / 碎石
      if (n < 0.13) {
        g.strokeStyle = 'rgba(66,124,118,0.65)';
        g.lineWidth = 1.2;
        for (let k = 0; k < 3; k++) {
          g.beginPath();
          g.moveTo(cx - 6 + k * 5, cy + 3);
          g.lineTo(cx - 8 + k * 5, cy - 4 - (k % 2) * 3);
          g.stroke();
        }
      }
    }
  }

  // ---- 兽潮路径（圆角折线带） ----
  const pts: Array<[number, number]> = [];
  for (let d = 0; d <= ROUTE_LEN; d++) {
    const [px, py] = pathPos(d);
    pts.push([isoX(px, py), isoY(px, py)]);
  }
  const strokePath = (color: string, width: number, dash?: number[]): void => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (dash) g.setLineDash(dash);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.stroke();
    if (dash) g.setLineDash([]);
  };
  strokePath('rgba(255,170,88,0.055)', 46);
  strokePath('#0e1417', 36);
  strokePath('#33261c', 30);
  strokePath('#453222', 24);
  strokePath('rgba(255,190,116,0.13)', 20);
  strokePath('rgba(255,210,150,0.32)', 1.4, [5, 9]);

  // 路径上的静态符文
  for (let d = 2; d < ROUTE_LEN - 1; d += 4.2) {
    const [px, py] = pathPos(d);
    const x = isoX(px, py);
    const y = isoY(px, py);
    g.save();
    g.translate(x, y);
    g.rotate(Math.PI / 4);
    g.strokeStyle = 'rgba(255,198,128,0.3)';
    g.lineWidth = 1;
    g.strokeRect(-2.2, -2.2, 4.4, 4.4);
    g.restore();
  }

  // ---- 塔座 ----
  for (const [x, y] of PAD_LIST) {
    const cx = isoX(x, y);
    const cy = isoY(x, y);
    fillDiamond(g, cx, cy + 1.5, TW * 0.7, TH * 0.7, 'rgba(3,8,11,0.55)');
    fillDiamond(g, cx, cy, TW * 0.62, TH * 0.62, '#20323a');
    g.strokeStyle = 'rgba(99,230,255,0.24)';
    g.lineWidth = 1.2;
    diamond(g, cx, cy, TW * 0.62, TH * 0.62);
    g.stroke();
    fillDiamond(g, cx, cy, TW * 0.4, TH * 0.4, '#0d1a20');
    g.strokeStyle = 'rgba(99,230,255,0.38)';
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    diamond(g, cx, cy, TW * 0.4, TH * 0.4);
    g.stroke();
    g.setLineDash([]);
    // 四枚铆钉
    g.fillStyle = 'rgba(132,224,238,0.4)';
    for (const [sx, sy] of [
      [0, -TH * 0.28],
      [TW * 0.28, 0],
      [0, TH * 0.28],
      [-TW * 0.28, 0],
    ]) {
      g.beginPath();
      g.arc(cx + sx, cy + sy, 1.4, 0, Math.PI * 2);
      g.fill();
    }
    drawGlow(g, '#63e6ff', cx, cy, 16, 0.1);
  }

  // ---- 岛缘高光 ----
  g.lineWidth = 1.5;
  g.strokeStyle = 'rgba(126,206,214,0.3)';
  for (let x = 0; x < GRID_W; x++) {
    for (let y = 0; y < GRID_H; y++) {
      if (!isGroundCell(x, y)) continue;
      const cx = isoX(x, y);
      const cy = isoY(x, y);
      if (!isGroundCell(x + 1, y)) {
        g.beginPath();
        g.moveTo(cx, cy + TH / 2);
        g.lineTo(cx + TW / 2, cy);
        g.stroke();
      }
      if (!isGroundCell(x, y + 1)) {
        g.beginPath();
        g.moveTo(cx - TW / 2, cy);
        g.lineTo(cx, cy + TH / 2);
        g.stroke();
      }
    }
  }

  return c;
}

function makeVignette(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = RW;
  c.height = RH;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(RW / 2, RH / 2, RH * 0.24, RW / 2, RH / 2, RH * 0.78);
  grad.addColorStop(0, 'rgba(255,40,64,0)');
  grad.addColorStop(0.7, 'rgba(255,40,64,0.10)');
  grad.addColorStop(1, 'rgba(255,32,56,0.42)');
  g.fillStyle = grad;
  g.fillRect(0, 0, RW, RH);
  return c;
}

// ============ 场景中的静态遗迹 ============

function drawDecor(ctx: CanvasRenderingContext2D, x: number, y: number, kind: DecorKind, time: number): void {
  const cx = isoX(x, y);
  const cy = isoY(x, y);
  groundShadow(ctx, cx, cy + 4, 20, 0.32);
  ctx.save();
  ctx.translate(cx, cy);
  if (kind === 'crystal') {
    drawGlow(ctx, '#63e6ff', 0, -18, 34, 0.35);
    const spikes: Array<[number, number, number, string]> = [
      [-10, 26, 9, '#1c5b66'],
      [2, 0, 17, '#2d8b96'],
      [12, 20, 7, '#1a4c5a'],
    ];
    for (const [sx, top, w, col] of spikes) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(sx, 2);
      ctx.lineTo(sx - w / 2, 2);
      ctx.lineTo(sx, top);
      ctx.lineTo(sx + w / 2, 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(163,255,246,0.55)';
      ctx.beginPath();
      ctx.moveTo(sx, top);
      ctx.lineTo(sx + w / 2, 2);
      ctx.lineTo(sx + w * 0.12, -2);
      ctx.closePath();
      ctx.fill();
    }
    drawGlow(ctx, '#9ffcf1', 2, 4 + Math.sin(time * 1.6) * 2, 18, 0.35);
  } else if (kind === 'pillar') {
    ctx.fillStyle = '#20323a';
    ctx.fillRect(-8, -32, 16, 34);
    ctx.fillStyle = '#2d4650';
    ctx.fillRect(-8, -32, 5, 34);
    ctx.fillStyle = '#0c171d';
    ctx.beginPath();
    ctx.moveTo(-10, -32);
    ctx.lineTo(10, -32);
    ctx.lineTo(6, -38);
    ctx.lineTo(-2, -34);
    ctx.lineTo(-10, -39);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(73,132,124,0.5)';
    ctx.fillRect(-8, -20, 16, 2);
    ctx.fillRect(-8, -9, 16, 1.5);
    ctx.fillStyle = 'rgba(106,214,190,0.16)';
    ctx.fillRect(-8, -26, 16, 3);
  } else if (kind === 'tree') {
    ctx.strokeStyle = '#314850';
    ctx.lineCap = 'round';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 2);
    ctx.lineTo(-2, -22);
    ctx.stroke();
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-2, -14);
    ctx.lineTo(-14, -22);
    ctx.moveTo(-1, -19);
    ctx.lineTo(10, -28);
    ctx.moveTo(9, -27);
    ctx.lineTo(15, -24);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(92,172,140,0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-13, -22);
    ctx.lineTo(-17, -26);
    ctx.moveTo(10, -28);
    ctx.lineTo(7, -32);
    ctx.moveTo(1, -6);
    ctx.lineTo(7, -10);
    ctx.stroke();
  } else if (kind === 'obelisk') {
    drawGlow(ctx, '#c56bff', 0, -26, 40, 0.28);
    ctx.fillStyle = '#231b35';
    ctx.beginPath();
    ctx.moveTo(-7, 2);
    ctx.lineTo(5, 2);
    ctx.lineTo(6, -44);
    ctx.lineTo(-4, -40);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(156,99,244,0.55)';
    ctx.beginPath();
    ctx.moveTo(-4, -40);
    ctx.lineTo(6, -44);
    ctx.lineTo(2, -31);
    ctx.lineTo(-4, -27);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(225,194,255,0.65)';
    ctx.fillRect(-2, -30, 2, 9);
    ctx.fillRect(-3, -26, 4, 1.5);
  } else {
    ctx.fillStyle = '#182830';
    for (const [sx, sy, rx] of [
      [-10, -2, 9],
      [3, 1, 12],
      [12, -4, 7],
    ]) {
      ctx.beginPath();
      ctx.ellipse(sx, sy, rx, rx * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(84,152,158,0.18)';
    ctx.beginPath();
    ctx.ellipse(-2, -6, 10, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    drawGlow(ctx, '#63e6ff', 13, -8, 12, 0.25);
  }
  ctx.restore();
}

// ============ 单位绘制 ============

function drawPortal(ctx: CanvasRenderingContext2D, time: number): void {
  const x = isoX(SPAWN_POS[0], SPAWN_POS[1]);
  const y = isoY(SPAWN_POS[0], SPAWN_POS[1]);
  const pulse = 0.78 + Math.sin(time * 2.4) * 0.12;
  groundShadow(ctx, x, y + 6, 18, 0.4);
  drawGlow(ctx, '#ff6bc8', x, y - 26, 52 * pulse, 0.34);
  ctx.save();
  ctx.translate(x, y - 28);
  // 竖直的裂隙
  const grad = ctx.createLinearGradient(0, -24, 0, 26);
  grad.addColorStop(0, 'rgba(255,150,220,0)');
  grad.addColorStop(0.35, 'rgba(255,92,190,0.55)');
  grad.addColorStop(0.7, 'rgba(118,70,255,0.5)');
  grad.addColorStop(1, 'rgba(80,30,140,0)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 3.4;
  ctx.beginPath();
  ctx.ellipse(0, 0, 15, 28, -0.08, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,180,240,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(0, 0, 10, 24, 0.1, 0.2, Math.PI * 1.7);
  ctx.stroke();
  ctx.fillStyle = 'rgba(12,5,24,0.82)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 12, 25, 0, 0, Math.PI * 2);
  ctx.fill();
  // 环绕的碎光
  for (let i = 0; i < 4; i++) {
    const a = time * 1.6 + (i * Math.PI) / 2;
    const rx = 16 + Math.sin(a * 2) * 2;
    const px = Math.cos(a) * rx;
    const py = Math.sin(a) * 12;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,144,223,0.85)' : 'rgba(164,124,255,0.8)';
    ctx.beginPath();
    ctx.arc(px, py, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  // 地面法阵
  ctx.save();
  ctx.translate(x, y + 2);
  ctx.strokeStyle = 'rgba(255,110,202,0.4)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 5]);
  ctx.beginPath();
  ctx.ellipse(0, 0, 24, 10, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawCore(ctx: CanvasRenderingContext2D, w: GameState, time: number): void {
  const x = isoX(CORE_POS[0], CORE_POS[1]);
  const y = isoY(CORE_POS[0], CORE_POS[1]);
  const low = w.coreHp / CORE_MAX_HP;
  const hurt = w.shakeT > 0 ? Math.min(1, w.shakeT / 0.45) : 0;
  const pulse = 0.8 + Math.sin(time * (low < 0.3 ? 6 : 2.1)) * 0.15;
  const bob = Math.sin(time * 1.4) * 3;

  groundShadow(ctx, x, y + 6, 32, 0.5);
  drawGlow(ctx, low < 0.3 ? '#ff6a7a' : '#63e6ff', x, y - 58, 88 * pulse, 0.26);
  // 光束
  const beam = ctx.createLinearGradient(0, y - 170, 0, y - 34);
  beam.addColorStop(0, 'rgba(99,230,255,0)');
  beam.addColorStop(0.55, low < 0.3 ? 'rgba(255,110,130,0.08)' : 'rgba(99,230,255,0.08)');
  beam.addColorStop(1, low < 0.3 ? 'rgba(255,110,130,0.2)' : 'rgba(99,230,255,0.17)');
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(x - 16, y - 34);
  ctx.lineTo(x + 16, y - 34);
  ctx.lineTo(x + 6, y - 168);
  ctx.lineTo(x - 6, y - 168);
  ctx.closePath();
  ctx.fill();

  // 基座
  fillDiamond(ctx, x, y + 2, 56, 28, '#101d24');
  fillDiamond(ctx, x, y - 4, 44, 22, '#1c3038');
  ctx.strokeStyle = 'rgba(99,230,255,0.3)';
  ctx.lineWidth = 1.2;
  diamond(ctx, x, y - 4, 44, 22);
  ctx.stroke();
  // 四根晶柱
  for (const [dx, hgt] of [
    [-26, 18],
    [26, 15],
    [0, 26],
  ]) {
    ctx.fillStyle = dx === 0 ? '#1f4a52' : '#183b44';
    ctx.beginPath();
    ctx.moveTo(x + dx - 4, y - 3);
    ctx.lineTo(x + dx + 4, y - 3);
    ctx.lineTo(x + dx + 2, y - 3 - hgt);
    ctx.lineTo(x + dx - 2, y - 3 - hgt);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(147,250,240,0.65)';
    ctx.fillRect(x + dx - 1, y - 3 - hgt, 2, 3);
  }
  // 悬浮主晶
  const cy = y - 62 + bob;
  ctx.save();
  ctx.translate(x, cy);
  ctx.rotate(Math.sin(time * 0.8) * 0.04);
  const crystalGrad = ctx.createLinearGradient(-18, -28, 22, 30);
  crystalGrad.addColorStop(0, low < 0.3 ? '#ff9aa8' : '#bffef5');
  crystalGrad.addColorStop(0.45, low < 0.3 ? '#ff5d75' : '#5ff0de');
  crystalGrad.addColorStop(1, low < 0.3 ? '#9d2038' : '#137b80');
  ctx.fillStyle = crystalGrad;
  ctx.beginPath();
  ctx.moveTo(0, -32);
  ctx.lineTo(17, -8);
  ctx.lineTo(10, 22);
  ctx.lineTo(0, 32);
  ctx.lineTo(-11, 21);
  ctx.lineTo(-18, -7);
  ctx.closePath();
  ctx.fill();
  // 切面
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.beginPath();
  ctx.moveTo(0, -32);
  ctx.lineTo(-18, -7);
  ctx.lineTo(-11, 21);
  ctx.lineTo(0, 10);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(6,60,68,0.35)';
  ctx.beginPath();
  ctx.moveTo(0, -32);
  ctx.lineTo(17, -8);
  ctx.lineTo(10, 22);
  ctx.lineTo(0, 10);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = `rgba(255,255,255,${0.28 + hurt * 0.4})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -32);
  ctx.lineTo(0, 32);
  ctx.moveTo(-18, -7);
  ctx.lineTo(10, 22);
  ctx.stroke();
  ctx.restore();

  // 光环
  ctx.save();
  ctx.translate(x, cy);
  ctx.rotate(-time * 0.55);
  ctx.strokeStyle = low < 0.3 ? 'rgba(255,106,122,0.65)' : 'rgba(126,255,240,0.55)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([8, 12]);
  ctx.beginPath();
  ctx.ellipse(0, 6, 34, 12, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  // 核心血条
  const bw = 70;
  const bx = x - bw / 2;
  const by = y - 118;
  ctx.fillStyle = 'rgba(4,10,14,0.72)';
  roundRect(ctx, bx - 2, by - 2, bw + 4, 10, 4);
  ctx.fill();
  const ratio = Math.max(0, w.coreHp / CORE_MAX_HP);
  if (ratio > 0) {
    ctx.fillStyle = ratio < 0.3 ? '#ff5d75' : ratio < 0.6 ? '#ffca6b' : '#63e6c8';
    roundRect(ctx, bx, by, bw * ratio, 6, 3);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(190,240,240,0.25)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(bx + (bw / 4) * i, by - 1);
    ctx.lineTo(bx + (bw / 4) * i, by + 7);
    ctx.stroke();
  }
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(214,248,248,0.82)';
  ctx.fillText(`晶核 ${w.coreHp}/${CORE_MAX_HP}`, x, by - 7);
}

function drawTower(ctx: CanvasRenderingContext2D, t: Tower, time: number, selected: boolean): void {
  const def = TOWER_DEFS[t.kind];
  const x = isoX(t.gx, t.gy);
  const y = isoY(t.gx, t.gy);
  const accent = def.color;
  const flash = t.flashT > 0 ? t.flashT / 0.3 : 0;
  const aimX = isoX(t.aimX, t.aimY);
  const aimY = isoY(t.aimX, t.aimY) - 14;
  let angle = Math.atan2(aimY - (y - 40), aimX - x);
  if (!Number.isFinite(angle) || Math.abs(aimX - x) < 0.01) angle = -Math.PI / 2;

  groundShadow(ctx, x, y + 4, 24, 0.42);
  if (selected) {
    ctx.save();
    ctx.translate(x, y + 2);
    ctx.strokeStyle = 'rgba(255,224,150,0.75)';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.ellipse(0, 0, 30, 13, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
  drawGlow(ctx, accent, x, y - 40, 32, 0.2 + flash * 0.25);

  // 台座
  fillDiamond(ctx, x, y + 2, 42, 21, '#0a1217');
  const baseGrad = ctx.createLinearGradient(0, y - 10, 0, y + 8);
  baseGrad.addColorStop(0, '#2c3f47');
  baseGrad.addColorStop(1, '#111d23');
  fillDiamond(ctx, x, y - 4, 38, 19, '#1a2b32');
  ctx.fillStyle = baseGrad;
  ctx.beginPath();
  ctx.moveTo(x - 19, y - 4);
  ctx.lineTo(x, y + 5.5);
  ctx.lineTo(x + 19, y - 4);
  ctx.lineTo(x + 19, y - 2);
  ctx.lineTo(x, y + 8);
  ctx.lineTo(x - 19, y - 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.72);
  ctx.lineWidth = 1.2;
  diamond(ctx, x, y - 8, 34, 17);
  ctx.stroke();

  // 立柱
  const colTop = y - 34;
  const column = ctx.createLinearGradient(x - 7, 0, x + 7, 0);
  column.addColorStop(0, '#0d181d');
  column.addColorStop(0.45, '#31454f');
  column.addColorStop(1, '#101c22');
  ctx.fillStyle = column;
  ctx.beginPath();
  ctx.moveTo(x - 7, y - 8);
  ctx.lineTo(x + 7, y - 8);
  ctx.lineTo(x + 5, colTop);
  ctx.lineTo(x - 5, colTop);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = rgba(accent, 0.55);
  ctx.fillRect(x - 1, y - 24, 2, 11);

  const headY = y - 44;
  const recoil = flash * 3;
  const hx = x - Math.cos(angle) * recoil;
  const hy = headY - Math.sin(angle) * recoil;

  if (t.kind === 'pulse') {
    // 两侧聚焦叉
    ctx.strokeStyle = '#2f5560';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hx - 12, headY + 4);
    ctx.lineTo(hx - 7, headY - 6);
    ctx.moveTo(hx + 12, headY + 4);
    ctx.lineTo(hx + 7, headY - 6);
    ctx.stroke();
    // 炮管
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(angle);
    ctx.strokeStyle = rgba(accent, 0.85);
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(2, 0);
    ctx.lineTo(17, 0);
    ctx.stroke();
    if (flash > 0) drawGlow(ctx, accent, 18, 0, 9 + flash * 8, 0.85);
    ctx.restore();
    // 晶核
    const bob = Math.sin(time * 2.2 + t.id) * 1.2;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(hx, headY - 17 + bob);
    ctx.lineTo(hx + 6, headY - 9 + bob);
    ctx.lineTo(hx, headY - 1 + bob);
    ctx.lineTo(hx - 6, headY - 9 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.moveTo(hx - 1, headY - 14 + bob);
    ctx.lineTo(hx + 2, headY - 9 + bob);
    ctx.lineTo(hx - 2, headY - 5 + bob);
    ctx.closePath();
    ctx.fill();
  } else if (t.kind === 'frost') {
    // 环形浮冰
    const spin = time * 0.9 + t.id;
    for (let i = 0; i < 3; i++) {
      const a = spin + (i * Math.PI * 2) / 3;
      const px = hx + Math.cos(a) * 13;
      const py = headY - 7 + Math.sin(a) * 5;
      ctx.fillStyle = i === 0 ? 'rgba(218,241,255,0.92)' : 'rgba(143,184,255,0.8)';
      ctx.beginPath();
      ctx.moveTo(px, py - 5);
      ctx.lineTo(px + 3.4, py);
      ctx.lineTo(px, py + 5);
      ctx.lineTo(px - 3.4, py);
      ctx.closePath();
      ctx.fill();
    }
    // 中心冰晶
    const bob = Math.sin(time * 1.8 + t.id) * 1.4;
    ctx.fillStyle = '#b8dcff';
    ctx.beginPath();
    ctx.moveTo(hx, headY - 18 + bob);
    ctx.lineTo(hx + 5, headY - 9 + bob);
    ctx.lineTo(hx, headY + bob);
    ctx.lineTo(hx - 5, headY - 9 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(220,245,255,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (flash > 0) {
      ctx.strokeStyle = rgba('#9fd0ff', flash * 0.8);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(hx, headY - 6, 20 + (1 - flash) * 12, 8 + (1 - flash) * 5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    // 裂地炮：短粗炮管
    ctx.fillStyle = '#26353c';
    ctx.beginPath();
    ctx.ellipse(hx, headY + 2, 10, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(angle);
    const barrel = ctx.createLinearGradient(0, -4, 0, 5);
    barrel.addColorStop(0, '#6d4a2d');
    barrel.addColorStop(0.5, '#b4763c');
    barrel.addColorStop(1, '#3a2516');
    ctx.fillStyle = barrel;
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(21, -6);
    ctx.lineTo(23, 0);
    ctx.lineTo(21, 6);
    ctx.lineTo(0, 5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = flash > 0 ? '#ffe0a8' : '#2c1c10';
    ctx.beginPath();
    ctx.ellipse(22, 0, 2.2, 5.4, 0, 0, Math.PI * 2);
    ctx.fill();
    if (flash > 0) drawGlow(ctx, '#ffb066', 24, 0, 12 + flash * 10, 0.8);
    ctx.restore();
    // 支撑架
    ctx.strokeStyle = '#41545c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hx - 9, headY + 8);
    ctx.lineTo(hx - 3, headY - 2);
    ctx.moveTo(hx + 9, headY + 8);
    ctx.lineTo(hx + 3, headY - 2);
    ctx.stroke();
  }

  // 等级宝石
  for (let i = 0; i < 3; i++) {
    const px = x - 10 + i * 10;
    const py = y + 4;
    ctx.fillStyle = i < t.level ? accent : 'rgba(70,95,104,0.55)';
    ctx.beginPath();
    ctx.moveTo(px, py - 3);
    ctx.lineTo(px + 3, py);
    ctx.lineTo(px, py + 3);
    ctx.lineTo(px - 3, py);
    ctx.closePath();
    ctx.fill();
  }
}

function drawEnemy(ctx: CanvasRenderingContext2D, e: Enemy, time: number): void {
  const x = isoX(e.x, e.y);
  const y = isoY(e.x, e.y);
  const [nx, ny] = pathPos(Math.min(ROUTE_LEN, e.dist + 0.3));
  const face = isoX(nx, ny) - x >= 0 ? 1 : -1;
  const slow = e.slowT > 0;
  const hit = e.hitT > 0;
  groundShadow(ctx, x, y + 3, e.boss ? 34 : e.kind === 'shell' ? 19 : 13, 0.42);

  if (e.kind === 'wisp') {
    const hover = 15 + Math.sin(time * 4 + e.id) * 2.5;
    drawGlow(ctx, slow ? '#8fd4ff' : '#ff7ad9', x, y - hover - 8, 28, 0.32);
    ctx.save();
    ctx.translate(x, y - hover);
    // 尾焰
    for (let i = 0; i < 2; i++) {
      const tail = Math.sin(time * 7 + e.id + i) * 2;
      ctx.fillStyle = i === 0 ? 'rgba(255,122,217,0.38)' : 'rgba(178,120,255,0.28)';
      ctx.beginPath();
      ctx.moveTo(-4 + i * 5, 2);
      ctx.quadraticCurveTo(-7 + i * 8 + tail, 13, -1 + i * 6, 22 + i * 4);
      ctx.quadraticCurveTo(4 + i * 4, 12, 3 + i * 3, 3);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = slow ? '#bfe6ff' : '#ff8fe2';
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.beginPath();
    ctx.arc(-2.5, -2.5, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2a0d2a';
    for (const ex of [-3.6, 3.2]) {
      ctx.beginPath();
      ctx.ellipse(ex, 0.8, 1.2, 2.1, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (slow) {
      ctx.strokeStyle = 'rgba(172,226,255,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0.4, 2.3);
      ctx.stroke();
    }
    if (hit) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  if (e.kind === 'crawler') {
    const phase = time * 11 + e.id;
    const bob = Math.sin(phase) * 1.2;
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = '#3b101c';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const off = -6 + i * 6;
      const swing = Math.sin(phase + i * 1.7) * 3;
      ctx.beginPath();
      ctx.moveTo(off * 0.7, -8 + bob);
      ctx.lineTo(off - 4 + face * swing, 0);
      ctx.moveTo(off * 0.7, -8 + bob);
      ctx.lineTo(off + 5 - face * swing, 1);
      ctx.stroke();
    }
    ctx.fillStyle = hit ? '#ffd7de' : slow ? '#7f8fb8' : '#b63a4e';
    ctx.beginPath();
    ctx.ellipse(0, -10 + bob, 12, 7.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = slow ? '#a9bde0' : '#e2606e';
    ctx.beginPath();
    ctx.ellipse(-1, -12 + bob, 8, 4.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4b1520';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.ellipse(-6 + i * 6, -14 + bob, 2, 1.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // 头与角
    const hxx = face * 9;
    ctx.fillStyle = slow ? '#8aa0cc' : '#c44759';
    ctx.beginPath();
    ctx.arc(hxx, -11 + bob, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#e1c8a8';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(hxx + face * 2, -15 + bob);
    ctx.quadraticCurveTo(hxx + face * 5, -21 + bob, hxx + face * 9, -18 + bob);
    ctx.moveTo(hxx - face * 2, -15 + bob);
    ctx.quadraticCurveTo(hxx - face * 5, -20 + bob, hxx - face * 8, -17 + bob);
    ctx.stroke();
    ctx.fillStyle = '#ffd27a';
    ctx.beginPath();
    ctx.arc(hxx + face * 2.5, -12 + bob, 1.5, 0, Math.PI * 2);
    ctx.fill();
    if (slow) {
      ctx.strokeStyle = 'rgba(172,226,255,0.8)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        const a = time * 2 + i * 2.1;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 13, -10 + Math.sin(a) * 5);
        ctx.lineTo(Math.cos(a) * 16, -10 + Math.sin(a) * 6);
        ctx.stroke();
      }
    }
    if (hit) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.ellipse(0, -10 + bob, 14, 9, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  if (e.kind === 'shell') {
    const phase = time * 5 + e.id;
    const bob = Math.sin(phase) * 0.8;
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = '#1f262c';
    ctx.lineWidth = 2.4;
    for (let i = 0; i < 3; i++) {
      const off = -9 + i * 9;
      ctx.beginPath();
      ctx.moveTo(off, -7 + bob);
      ctx.lineTo(off - 2, 0);
      ctx.moveTo(off, -7 + bob);
      ctx.lineTo(off + 2, 1);
      ctx.stroke();
    }
    ctx.fillStyle = hit ? '#f5fbff' : slow ? '#768fa5' : '#4b5b67';
    ctx.beginPath();
    ctx.ellipse(0, -11 + bob, 18, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = slow ? '#93aec9' : '#637784';
    ctx.beginPath();
    ctx.ellipse(-2, -14 + bob, 14, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2c3942';
    ctx.lineWidth = 1.4;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 8, -19 + bob);
      ctx.quadraticCurveTo(i * 8 + 4, -12 + bob, i * 8, -5 + bob);
      ctx.stroke();
    }
    // 甲壳脊刺
    ctx.fillStyle = '#c47a48';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 8 - 3, -18 + bob);
      ctx.lineTo(i * 8, -25 + bob - Math.abs(i) * 2);
      ctx.lineTo(i * 8 + 3, -18 + bob);
      ctx.closePath();
      ctx.fill();
    }
    const fxx = face * 15;
    ctx.fillStyle = '#2b3339';
    ctx.beginPath();
    ctx.ellipse(fxx, -9 + bob, 6, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffb066';
    ctx.fillRect(fxx - 1.5, -10.5 + bob, 3, 1.6);
    if (slow) {
      ctx.strokeStyle = 'rgba(172,226,255,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(0, -12 + bob, 21, 11, 0, 0.2, 2.4);
      ctx.stroke();
    }
    if (hit) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      ctx.ellipse(0, -12 + bob, 19, 11, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  // ---- Boss ----
  const phase = time * 4 + e.id;
  const bob = Math.sin(phase) * 2.2;
  const aura = 0.8 + Math.sin(time * 3) * 0.18;
  drawGlow(ctx, slow ? '#7cc3ff' : '#ff5f8e', x, y - 38, 62, 0.28 * aura);
  // 地面魔环
  ctx.save();
  ctx.translate(x, y + 4);
  ctx.strokeStyle = rgba('#ff5f8e', 0.4);
  ctx.lineWidth = 1.2;
  ctx.setLineDash([7, 6]);
  ctx.beginPath();
  ctx.ellipse(0, 0, 31, 13, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  ctx.save();
  ctx.translate(x, y);
  // 腿
  ctx.strokeStyle = '#2a101c';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  for (let i = 0; i < 2; i++) {
    const swing = Math.sin(phase + i * Math.PI) * 4;
    ctx.beginPath();
    ctx.moveTo(-11 + i * 22, -14 + bob);
    ctx.lineTo(-16 + i * 32 + swing, 0);
    ctx.stroke();
  }
  // 躯干
  const bodyGrad = ctx.createLinearGradient(0, -54 + bob, 0, -8 + bob);
  bodyGrad.addColorStop(0, slow ? '#6b7596' : '#5c2334');
  bodyGrad.addColorStop(0.55, slow ? '#465068' : '#3b1521');
  bodyGrad.addColorStop(1, '#180a10');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.moveTo(-16, -12 + bob);
  ctx.lineTo(-23, -34 + bob);
  ctx.lineTo(-10, -48 + bob);
  ctx.lineTo(10, -48 + bob);
  ctx.lineTo(23, -34 + bob);
  ctx.lineTo(16, -12 + bob);
  ctx.closePath();
  ctx.fill();
  // 肩甲与尖刺
  ctx.fillStyle = slow ? '#8fa4c6' : '#7a3348';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(s * 19, -36 + bob, 8, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d8b48a';
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.moveTo(s * (16 + i * 5), -40 + bob);
      ctx.lineTo(s * (18 + i * 5), -48 + bob - i * 3);
      ctx.lineTo(s * (21 + i * 5), -38 + bob);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = slow ? '#8fa4c6' : '#7a3348';
  }
  // 头
  ctx.fillStyle = slow ? '#9fb4d4' : '#82394d';
  ctx.beginPath();
  ctx.ellipse(0, -51 + bob, 13, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#d8b48a';
  ctx.beginPath();
  ctx.moveTo(-12, -55 + bob);
  ctx.quadraticCurveTo(-23, -62 + bob, -24, -69 + bob);
  ctx.quadraticCurveTo(-16, -62 + bob, -7, -58 + bob);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(12, -55 + bob);
  ctx.quadraticCurveTo(23, -62 + bob, 24, -69 + bob);
  ctx.quadraticCurveTo(16, -62 + bob, 7, -58 + bob);
  ctx.fill();
  // 三只眼
  ctx.fillStyle = '#ffd07a';
  for (const ex of [-5, 0, 5]) {
    ctx.beginPath();
    ctx.ellipse(ex, -51 + bob, 1.6, ex === 0 ? 2.6 : 1.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // 胸前核心
  const corePulse = 0.75 + Math.sin(time * 5) * 0.25;
  ctx.fillStyle = slow ? '#bfe6ff' : '#ff6a94';
  ctx.beginPath();
  ctx.moveTo(0, -38 + bob);
  ctx.lineTo(6, -32 + bob);
  ctx.lineTo(0, -25 + bob);
  ctx.lineTo(-6, -32 + bob);
  ctx.closePath();
  ctx.fill();
  drawGlow(ctx, slow ? '#9fd8ff' : '#ff6a94', 0, -32 + bob, 22 * corePulse, 0.55);
  // 环绕碎晶
  for (let i = 0; i < 3; i++) {
    const a = time * 0.9 + (i * Math.PI * 2) / 3;
    const px = Math.cos(a) * 28;
    const py = -30 + Math.sin(a) * 8;
    ctx.fillStyle = 'rgba(255,132,176,0.65)';
    ctx.beginPath();
    ctx.moveTo(px, py - 3);
    ctx.lineTo(px + 2.5, py);
    ctx.lineTo(px, py + 3);
    ctx.lineTo(px - 2.5, py);
    ctx.closePath();
    ctx.fill();
  }
  if (hit) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, -32 + bob, 26, 25, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawShell(ctx: CanvasRenderingContext2D, s: { sx: number; sy: number; tx: number; ty: number; t: number; dur: number }): void {
  const k = Math.min(1, s.t / s.dur);
  const x = isoX(s.sx, s.sy);
  const y = isoY(s.sx, s.sy) - 38;
  const tx = isoX(s.tx, s.ty);
  const ty = isoY(s.tx, s.ty);
  const px = x + (tx - x) * k;
  const py = y + (ty - y) * k - Math.sin(k * Math.PI) * 72;
  const gy = y + (ty - y) * k;
  ctx.beginPath();
  ctx.ellipse(px, gy + 2, 7, 3, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(2,6,10,0.4)';
  ctx.fill();
  // 尾迹
  for (let i = 1; i <= 3; i++) {
    const kk = Math.max(0, k - i * 0.05);
    const qx = x + (tx - x) * kk;
    const qy = y + (ty - y) * kk - Math.sin(kk * Math.PI) * 72;
    ctx.fillStyle = `rgba(255,164,94,${0.32 / i})`;
    ctx.beginPath();
    ctx.arc(qx, qy, 3 - i * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  drawGlow(ctx, '#ffb066', px, py, 14, 0.6);
  ctx.fillStyle = '#ffe1b5';
  ctx.beginPath();
  ctx.arc(px, py, 3.4, 0, Math.PI * 2);
  ctx.fill();
}

function drawFx(ctx: CanvasRenderingContext2D, fx: Fx, time: number): void {
  const k = Math.min(1, Math.max(0, (time - fx.t0) / fx.dur));
  if (k >= 1) return;
  const x = isoX(fx.x, fx.y);
  const y = isoY(fx.x, fx.y);
  if (fx.kind === 'tracer') {
    const x2 = isoX(fx.x2 ?? fx.x, fx.y2 ?? fx.y);
    const y2 = isoY(fx.x2 ?? fx.x, fx.y2 ?? fx.y) - 15;
    const a = 1 - k;
    ctx.strokeStyle = rgba(fx.color ?? '#63e6ff', 0.22 * a);
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(x, y - 40);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.strokeStyle = rgba(fx.color ?? '#63e6ff', 0.9 * a);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y - 40);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    drawGlow(ctx, fx.color ?? '#63e6ff', x2, y2, 12 * a + 4, a);
  } else if (fx.kind === 'nova') {
    const rr = 8 + k * (fx.size ?? 2.6) * TW * 0.7071;
    ctx.strokeStyle = rgba(fx.color ?? '#8fb8ff', 0.5 * (1 - k));
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, y, rr, rr * (TH / TW), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = rgba('#d8ecff', 0.24 * (1 - k));
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x, y, rr * 0.7, rr * 0.7 * (TH / TW), 0, 0, Math.PI * 2);
    ctx.stroke();
    drawGlow(ctx, fx.color ?? '#8fb8ff', x, y - 12, 30 * (1 - k) + 8, 0.25 * (1 - k));
  } else if (fx.kind === 'blast') {
    const rr = 6 + k * (fx.size ?? 1) * TW * 0.8;
    drawGlow(ctx, '#ffb066', x, y - 6, 26 * (1 - k) + 8, 0.7 * (1 - k));
    ctx.strokeStyle = `rgba(255,196,122,${0.7 * (1 - k)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, y, rr, rr * 0.45, 0, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 7; i++) {
      const a = i * 0.9 + fx.t0;
      const r = k * (14 + i * 2);
      ctx.fillStyle = `rgba(255,${160 + i * 8},90,${0.8 * (1 - k)})`;
      ctx.fillRect(x + Math.cos(a) * r, y - 10 + Math.sin(a) * r * 0.5, 2, 2);
    }
  } else if (fx.kind === 'death') {
    const big = fx.boss ? 1.7 : 1;
    drawGlow(ctx, fx.boss ? '#ff6a94' : '#e2606e', x, y - 14, (fx.boss ? 48 : 24) * (1 - k) + 4, 0.5 * (1 - k));
    for (let i = 0; i < (fx.boss ? 14 : 7); i++) {
      const a = i * 2.1 + fx.t0 * 3;
      const r = k * (fx.boss ? 44 : 22);
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.fillStyle = i % 2 === 0 ? '#ffd0b0' : '#ff6f86';
      ctx.fillRect(x + Math.cos(a) * r - 1, y - 14 + Math.sin(a) * r * 0.5 - k * 12, 2.4 * big, 2.4 * big);
    }
    ctx.globalAlpha = 1;
  } else if (fx.kind === 'gold') {
    const a = 1 - k;
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.strokeStyle = `rgba(6,12,18,${0.7 * a})`;
    ctx.lineWidth = 3;
    const ty = y - 30 - k * 20;
    ctx.strokeText(fx.text ?? '', x, ty);
    ctx.fillStyle = `rgba(255,214,132,${a})`;
    ctx.fillText(fx.text ?? '', x, ty);
  } else if (fx.kind === 'core') {
    drawGlow(ctx, '#ff5d75', x, y - 64, 62 * (1 - k) + 20, 0.55 * (1 - k));
    ctx.font = '800 17px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.strokeStyle = `rgba(30,0,8,${0.8 * (1 - k)})`;
    ctx.lineWidth = 4;
    const ty = y - 96 - k * 16;
    ctx.strokeText(fx.text ?? '', x, ty);
    ctx.fillStyle = `rgba(255,110,130,${1 - k})`;
    ctx.fillText(fx.text ?? '', x, ty);
  } else if (fx.kind === 'spawn') {
    const rr = 8 + k * 22;
    ctx.strokeStyle = `rgba(255,120,210,${0.6 * (1 - k)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(x, y, rr, rr * 0.45, 0, 0, Math.PI * 2);
    ctx.stroke();
    drawGlow(ctx, '#ff6bc8', x, y - 10, 20 * (1 - k) + 5, 0.35 * (1 - k));
  } else if (fx.kind === 'build' || fx.kind === 'upgrade') {
    const rr = 10 + k * 20;
    ctx.strokeStyle = rgba(fx.color ?? '#63e6ff', 0.65 * (1 - k));
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, y, rr, rr * 0.45, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (fx.kind === 'upgrade') {
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * 0.32;
        ctx.fillStyle = rgba(fx.color ?? '#63e6ff', 0.8 * (1 - k));
        ctx.fillRect(x + Math.cos(a) * (12 + k * 12), y - 30 + Math.sin(a) * 16 - k * 18, 2, 2);
      }
    }
  }
}

// ============ 一帧内动态层 ============

function drawEnemyBars(ctx: CanvasRenderingContext2D, w: GameState): void {
  for (const e of w.enemies) {
    if (e.dead) continue;
    const x = isoX(e.x, e.y);
    const base = isoY(e.x, e.y);
    const top = base - (e.boss ? 78 : e.kind === 'shell' ? 33 : e.kind === 'wisp' ? 34 : 30);
    if (e.hp >= e.maxHp && !e.boss) continue;
    const bw = e.boss ? 58 : e.kind === 'shell' ? 32 : 26;
    ctx.fillStyle = 'rgba(3,7,11,0.72)';
    ctx.fillRect(x - bw / 2 - 1, top - 1, bw + 2, 6);
    const ratio = e.hp / e.maxHp;
    ctx.fillStyle = ratio > 0.55 ? '#6ee7a8' : ratio > 0.25 ? '#ffd166' : '#ff6b7a';
    ctx.fillRect(x - bw / 2, top, bw * ratio, 4);
    if (e.slowT > 0) {
      ctx.fillStyle = '#9fd8ff';
      ctx.fillRect(x - bw / 2 - 2, top, 1.5, 4);
    }
  }
}

function drawForeground(
  ctx: CanvasRenderingContext2D,
  w: GameState,
  view: View,
  time: number,
): void {
  const selected = view.sel != null ? w.towers.find((t) => t.id === view.sel) : undefined;
  if (selected) {
    rangeEllipse(ctx, selected.gx, selected.gy, towerStat(selected).range, TOWER_DEFS[selected.kind].color, true);
  }

  // 建塔模式：所有空塔座呼吸提示
  if (view.build) {
    const color = TOWER_DEFS[view.build].color;
    PAD_LIST.forEach(([x, y], i) => {
      if (towerAt(w, x, y)) return;
      const cx = isoX(x, y);
      const cy = isoY(x, y);
      const pulse = 0.18 + Math.max(0, Math.sin(time * 2.2 + i * 0.7)) * 0.22;
      ctx.strokeStyle = rgba(color, pulse);
      ctx.lineWidth = 1;
      diamond(ctx, cx, cy, TW * 0.5, TH * 0.5);
      ctx.stroke();
    });
    if (view.hover) {
      const [hx, hy] = view.hover;
      const valid = isPad(hx, hy) && !towerAt(w, hx, hy) && w.gold >= buildCost(view.build);
      const cx = isoX(hx, hy);
      const cy = isoY(hx, hy);
      fillDiamond(ctx, cx, cy, TW * 0.66, TH * 0.66, valid ? rgba('#6ee7b8', 0.16) : rgba('#ff6b7a', 0.14));
      ctx.strokeStyle = valid ? 'rgba(110,231,184,0.9)' : 'rgba(255,107,122,0.8)';
      ctx.lineWidth = 1.5;
      diamond(ctx, cx, cy, TW * 0.66, TH * 0.66);
      ctx.stroke();
      if (valid) {
        rangeEllipse(ctx, hx, hy, TOWER_DEFS[view.build].levels[0].range, TOWER_DEFS[view.build].color, true);
      }
    }
  }

  // 兽潮路径流动光点
  for (let i = 0; i < 4; i++) {
    const d = (time * 2.1 + (i * ROUTE_LEN) / 4) % ROUTE_LEN;
    const [px, py] = pathPos(d);
    const x = isoX(px, py);
    const y = isoY(px, py) - 1;
    drawGlow(ctx, '#ffbf7a', x, y, 7, 0.25);
    ctx.fillStyle = 'rgba(255,222,168,0.8)';
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  type Item = { d: number; draw: () => void };
  const items: Item[] = [];
  // 遗迹
  for (const d of DECOR_LIST) {
    items.push({
      d: d.x + d.y + 0.02,
      draw: () => drawDecor(ctx, d.x, d.y, d.kind, time),
    });
  }
  // 出生裂隙
  items.push({ d: SPAWN_POS[0] + SPAWN_POS[1] - 0.1, draw: () => drawPortal(ctx, time) });
  // 晶核
  items.push({ d: CORE_POS[0] + CORE_POS[1] + 0.4, draw: () => drawCore(ctx, w, time) });
  // 塔（整体放大一点：等距远景里塔身是玩家最需要一眼认出的东西）
  for (const t of w.towers) {
    const tx = isoX(t.gx, t.gy);
    const ty = isoY(t.gx, t.gy);
    items.push({
      d: t.gx + t.gy + 0.3,
      draw: () => {
        ctx.save();
        ctx.translate(tx, ty);
        ctx.scale(1.24, 1.24);
        ctx.translate(-tx, -ty);
        drawTower(ctx, t, time, view.sel === t.id);
        ctx.restore();
      },
    });
  }
  // 兽群
  for (const e of w.enemies) {
    if (e.dead) continue;
    const ex = isoX(e.x, e.y);
    const ey = isoY(e.x, e.y);
    const es = e.boss ? 1.12 : e.kind === 'crawler' || e.kind === 'wisp' ? 1.4 : 1.24;
    items.push({
      d: e.x + e.y,
      draw: () => {
        ctx.save();
        ctx.translate(ex, ey);
        ctx.scale(es, es);
        ctx.translate(-ex, -ey);
        drawEnemy(ctx, e, time);
        ctx.restore();
      },
    });
  }
  // 建塔幽灵
  if (view.build && view.hover) {
    const [hx, hy] = view.hover;
    if (isPad(hx, hy) && !towerAt(w, hx, hy) && w.gold >= buildCost(view.build)) {
      const ghost: Tower = {
        id: -1,
        kind: view.build,
        gx: hx,
        gy: hy,
        level: 1,
        cd: 0,
        aimX: hx + 1,
        aimY: hy,
        flashT: 0,
        invested: 0,
      };
      items.push({
        d: hx + hy + 0.3,
        draw: () => {
          const gx = isoX(hx, hy);
          const gy = isoY(hx, hy);
          const prev = ctx.globalAlpha;
          ctx.globalAlpha = 0.52;
          ctx.save();
          ctx.translate(gx, gy);
          ctx.scale(1.24, 1.24);
          ctx.translate(-gx, -gy);
          drawTower(ctx, ghost, time, false);
          ctx.restore();
          ctx.globalAlpha = prev;
        },
      });
    }
  }
  items.sort((a, b) => a.d - b.d);
  for (const item of items) item.draw();

  // 炮弹与尾迹在实体之上
  for (const s of w.shells) drawShell(ctx, s);

  // 特效
  for (const fx of w.fx) drawFx(ctx, fx, time);

  // 血条置顶，避免被前排塔遮挡
  drawEnemyBars(ctx, w);
}

// ============ 画布 HUD ============

function drawBossBar(ctx: CanvasRenderingContext2D, w: GameState): void {
  const bosses = aliveBosses(w);
  if (bosses.length === 0) return;
  const totalHp = bosses.reduce((s, e) => s + e.hp, 0);
  const totalMax = bosses.reduce((s, e) => s + e.maxHp, 0);
  const ratio = totalMax > 0 ? totalHp / totalMax : 0;
  const bw = 300;
  const bx = (RW - bw) / 2;
  const by = 22;
  ctx.textAlign = 'center';
  ctx.font = '700 16px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,198,214,0.92)';
  ctx.fillText(`裂界巨兽${bosses.length > 1 ? ` ×${bosses.length}` : ''}`, RW / 2, by - 1);
  ctx.font = '500 11px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(196,214,226,0.6)';
  ctx.fillText(`护甲 ${ENEMY_DEFS.boss.armor} · 霜华无视护甲 · 减速抗性 ${Math.round(ENEMY_DEFS.boss.slowResist * 100)}%`, RW / 2, by + 34);
  ctx.fillStyle = 'rgba(5,9,15,0.8)';
  roundRect(ctx, bx - 2, by + 5, bw + 4, 13, 6);
  ctx.fill();
  if (ratio > 0) {
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    grad.addColorStop(0, '#ff456e');
    grad.addColorStop(0.6, '#ff7aa2');
    grad.addColorStop(1, '#ffb1c5');
    ctx.fillStyle = grad;
    roundRect(ctx, bx, by + 7, bw * ratio, 9, 4);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(255,160,190,0.25)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    ctx.beginPath();
    ctx.moveTo(bx + (bw / 10) * i, by + 6);
    ctx.lineTo(bx + (bw / 10) * i, by + 16);
    ctx.stroke();
  }
}

function drawAnnounce(ctx: CanvasRenderingContext2D, w: GameState, time: number): void {
  const a = w.announce;
  if (!a) return;
  const p = (time - a.t0) / a.dur;
  if (p < 0 || p >= 1) return;
  const fadeIn = Math.min(1, p / 0.12);
  const fadeOut = Math.min(1, (1 - p) / 0.3);
  const alpha = Math.min(fadeIn, fadeOut);
  ctx.textAlign = 'center';
  ctx.font = '800 25px system-ui, sans-serif';
  const tw = Math.max(ctx.measureText(a.text).width, 280);
  const bx = RW / 2 - tw / 2 - 20;
  const by = 98;
  ctx.fillStyle = `rgba(6,12,20,${0.7 * alpha})`;
  roundRect(ctx, bx, by - 25, tw + 40, 54, 13);
  ctx.fill();
  ctx.strokeStyle = `rgba(130,220,230,${0.24 * alpha})`;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = `rgba(235,250,252,${alpha})`;
  ctx.fillText(a.text, RW / 2, by + 3);
  ctx.font = '500 12.5px system-ui, sans-serif';
  ctx.fillStyle = `rgba(182,208,218,${0.82 * alpha})`;
  ctx.fillText(a.sub, RW / 2, by + 22);
}

// ============ 主组件 ============

/** 晶塔图标：用型色描线，比不同平台的 emoji 更可控 */
function TowerGlyph({ kind }: { kind: TowerKind }) {
  if (kind === 'pulse') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M13.4 2.5 5.6 13.2h5.1l-1 8.3 8.1-12h-5.1l.7-7z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="0.8"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'frost') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M12 3v18" />
          <path d="M4.2 7.5l15.6 9" />
          <path d="M4.2 16.5l15.6-9" />
          <path d="M9 4.5 12 7l3-2.5" />
          <path d="M9 19.5 12 17l3 2.5" />
        </g>
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3.5 18.5C6 9.5 18 9.5 20.5 18.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeDasharray="2.4 3"
      />
      <circle cx="6.4" cy="16.8" r="2.6" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M17.5 6.5 19 4.5" />
        <path d="M19.8 9.2 22 8.6" />
        <path d="M14.8 4.3 15.2 2" />
      </g>
    </svg>
  );
}

function statLine(t: Tower): string {
  const st = towerStat(t);
  if (t.kind === 'pulse') return `伤害 ${st.dmg} · ${st.rate.toFixed(1)} 次/秒`;
  if (t.kind === 'frost') return `光环 ${st.dmg} 伤害（无视护甲）· 减速 ${Math.round((st.slow ?? 0) * 100)}%`;
  return `溅射 ${st.dmg} · 爆炸半径 ${st.splash ?? 1} 格`;
}

export default function CrystalDefense3D() {
  const best = useBestScore(metaCrystalDefense.id);
  const { toast } = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 懒初始化：首帧就要有可绘制/可读的战局，不必等玩家点开始
  const worldRef = useRef<GameState>(null as unknown as GameState);
  if (!worldRef.current) worldRef.current = createGame();

  const [status, setStatus] = useState<Status>(STATUS_READY);
  const statusRef = useRef<Status>(STATUS_READY);
  const [hud, setHud] = useState<Hud>(() => snapshot(worldRef.current));
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(1);
  const [buildKind, setBuildKind] = useState<TowerKind | null>(null);
  const [selId, setSelId] = useState<number | null>(null);
  const [newRecord, setNewRecord] = useState(false);
  const uiRef = useRef<View>({ build: null, sel: null, hover: null });
  const endHandledRef = useRef(false);
  /** 结算遮罩出现时刻：终局瞬间连点的第二下不能把遮罩一闪点掉 */
  const overlayAtRef = useRef(0);
  const actionsRef = useRef({
    start: () => {},
    build: (_kind: TowerKind) => {},
    cancel: () => {},
    pause: () => {},
    restart: () => {},
  });

  const start = () => {
    // 结算面板出现后的 450ms 内忽略重开（狂点屏幕的玩家会连点两下）
    if (
      statusRef.current !== STATUS_READY &&
      performance.now() - overlayAtRef.current < 450
    ) {
      return;
    }
    worldRef.current = createGame();
    uiRef.current = { build: null, sel: null, hover: null };
    setBuildKind(null);
    setSelId(null);
    setNewRecord(false);
    endHandledRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    speedRef.current = 1;
    setSpeed(1);
    statusRef.current = STATUS_PLAYING;
    setStatus(STATUS_PLAYING);
    setHud(snapshot(worldRef.current));
    sfx.click();
  };

  const togglePause = () => {
    if (statusRef.current !== STATUS_PLAYING) return;
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    sfx.click();
  };

  const toggleSpeed = () => {
    if (statusRef.current !== STATUS_PLAYING || pausedRef.current) return;
    speedRef.current = speedRef.current === 1 ? 2 : 1;
    setSpeed(speedRef.current);
    sfx.click();
  };

  const toggleBuild = (kind: TowerKind) => {
    if (statusRef.current !== STATUS_PLAYING || pausedRef.current) return;
    const w = worldRef.current;
    if (uiRef.current.build === kind) {
      uiRef.current = { ...uiRef.current, build: null, hover: null };
      setBuildKind(null);
      sfx.click();
      return;
    }
    if (w.gold < buildCost(kind)) return;
    uiRef.current = { build: kind, sel: null, hover: null };
    setBuildKind(kind);
    setSelId(null);
    sfx.click();
  };

  const cancel = () => {
    if (uiRef.current.build == null && uiRef.current.sel == null) return;
    uiRef.current = { build: null, sel: null, hover: null };
    setBuildKind(null);
    setSelId(null);
    sfx.click();
  };

  const selectTower = (id: number | null) => {
    uiRef.current = { build: null, sel: id, hover: null };
    setSelId(id);
    setBuildKind(null);
  };

  const callNext = () => {
    if (statusRef.current !== STATUS_PLAYING || pausedRef.current) return;
    const w = worldRef.current;
    if (w.phase !== 'prep') return;
    if (callWave(w)) {
      setHud(snapshot(w));
      sfx.click();
    }
  };

  const upgradeSelected = () => {
    if (statusRef.current !== STATUS_PLAYING || pausedRef.current) return;
    const id = uiRef.current.sel;
    if (id == null) return;
    const res = upgradeTower(worldRef.current, id);
    if (res === 'ok') {
      setHud(snapshot(worldRef.current));
      sfx.match();
    } else if (res === 'gold') {
      sfx.mismatch();
    }
  };

  const sellSelected = () => {
    if (statusRef.current !== STATUS_PLAYING || pausedRef.current) return;
    const id = uiRef.current.sel;
    if (id == null) return;
    const refund = sellTower(worldRef.current, id);
    if (refund > 0) {
      uiRef.current = { build: null, sel: null, hover: null };
      setSelId(null);
      setHud(snapshot(worldRef.current));
      sfx.move();
    }
  };

  actionsRef.current = {
    start,
    build: toggleBuild,
    cancel,
    pause: togglePause,
    restart: start,
  };

  // ============ 模拟 + 渲染主循环（只挂载一次） ============

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(RW * dpr);
    canvas.height = Math.round(RH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const scenery = buildScenery(dpr);
    const vignette = makeVignette();
    let raf = 0;
    let last = performance.now();
    let lastHud = 0;
    let lastDraw = 0;
    let lastKillSfx = 0;

    const pauseIfPlaying = () => {
      if (statusRef.current === STATUS_PLAYING && !pausedRef.current) {
        pausedRef.current = true;
        setPaused(true);
      }
    };
    const onVis = () => {
      // 切后台时 rAF 本就停了；顺手暂停，回来不会看到兽群已经越过塔阵
      if (document.hidden) pauseIfPlaying();
    };
    const onBlur = () => pauseIfPlaying();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onBlur);

    const loop = (now: number) => {
      const w = worldRef.current;
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const active = statusRef.current === STATUS_PLAYING && !pausedRef.current;

      if (active) {
        update(w, dt * speedRef.current);
        for (const ev of drainEvents(w)) {
          if (ev.type === 'kill') {
            if (ev.boss) sfx.thud();
            else if (now - lastKillSfx > 110) {
              lastKillSfx = now;
              sfx.hit();
            }
          } else if (ev.type === 'leak') {
            sfx.thud();
          } else if (ev.type === 'wave') {
            sfx.drop();
          } else if (ev.type === 'clear') {
            sfx.clear();
          }
        }
        if ((w.phase === 'won' || w.phase === 'lost') && statusRef.current !== w.phase) {
          statusRef.current = w.phase;
          setStatus(w.phase);
          overlayAtRef.current = performance.now();
          setHud(snapshot(w));
        } else if (now - lastHud > 110) {
          lastHud = now;
          setHud(snapshot(w));
        }
      }

      const shouldDraw = active || now - lastDraw > 120;
      if (shouldDraw) {
        lastDraw = now;
        ctx.drawImage(scenery, 0, 0, RW, RH);
        ctx.save();
        if (w.shakeT > 0) {
          const amp = Math.min(1, w.shakeT / 0.45);
          ctx.translate(Math.sin(w.time * 101) * 6 * amp, Math.cos(w.time * 87) * 4 * amp);
        }
        drawForeground(ctx, w, uiRef.current, w.time);
        ctx.restore();
        if (w.shakeT > 0) {
          ctx.save();
          ctx.globalAlpha = Math.min(1, w.shakeT * 2);
          ctx.drawImage(vignette, 0, 0, RW, RH);
          ctx.restore();
        }
        drawBossBar(ctx, w);
        drawAnnounce(ctx, w, w.time);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // ============ 键盘 ============

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Digit1') {
        e.preventDefault();
        actionsRef.current.build('pulse');
      } else if (e.code === 'Digit2') {
        e.preventDefault();
        actionsRef.current.build('frost');
      } else if (e.code === 'Digit3') {
        e.preventDefault();
        actionsRef.current.build('mortar');
      } else if (e.code === 'Escape') {
        actionsRef.current.cancel();
      } else if (e.code === 'Space' || e.code === 'KeyP') {
        e.preventDefault();
        if (statusRef.current === STATUS_PLAYING) actionsRef.current.pause();
      } else if (e.code === 'Enter') {
        if (statusRef.current === STATUS_READY) actionsRef.current.start();
        else if (statusRef.current === STATUS_WON || statusRef.current === STATUS_LOST) {
          actionsRef.current.restart();
        }
      }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);

  // ============ 结算存档 ============

  useEffect(() => {
    if (status !== STATUS_WON && status !== STATUS_LOST) return;
    if (endHandledRef.current) return;
    endHandledRef.current = true;
    overlayAtRef.current = performance.now();
    const w = worldRef.current;
    // 0 击杀的"记录"只是白拿了一波清场分，不写进排行榜
    const isNew = w.score > 0 && w.kills > 0 && best.updateBest(w.score, (a, b) => a > b);
    setNewRecord(isNew);
    if (isNew) {
      sfx.record();
      toast(`🏆 新纪录！${w.score} 分`, 'record');
    } else if (status === STATUS_WON) {
      sfx.win();
    } else {
      sfx.lose();
    }
    setHud(snapshot(w));
  }, [status, best, toast]);

  // ============ 指针 ============

  const screenPoint = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) / rect.width) * RW,
      ((e.clientY - rect.top) / rect.height) * RH,
    ];
  };

  const cellAt = (mx: number, my: number): [number, number] | null => {
    const u = (mx - OX) / (TW / 2);
    const v = (my - OY) / (TH / 2);
    const gx = Math.round((u + v) / 2);
    const gy = Math.round((v - u) / 2);
    if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return null;
    return [gx, gy];
  };

  const towerHit = (mx: number, my: number): Tower | null => {
    let hit: Tower | null = null;
    let bestD = Infinity;
    for (const t of worldRef.current.towers) {
      const x = isoX(t.gx, t.gy);
      const y = isoY(t.gx, t.gy);
      if (my < y - 62 || my > y + 12) continue;
      const dx = Math.abs(mx - x);
      if (dx > 26) continue;
      const d = dx + Math.abs(my - (y - 30)) * 0.4;
      if (d < bestD) {
        bestD = d;
        hit = t;
      }
    }
    return hit;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (statusRef.current !== STATUS_PLAYING || pausedRef.current || uiRef.current.build == null) {
      uiRef.current.hover = null;
      return;
    }
    const [mx, my] = screenPoint(e);
    uiRef.current.hover = cellAt(mx, my);
  };

  const onPointerLeave = () => {
    uiRef.current.hover = null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (statusRef.current !== STATUS_PLAYING || pausedRef.current) return;
    const w = worldRef.current;
    const [mx, my] = screenPoint(e);
    uiRef.current.hover = null;
    const cell = cellAt(mx, my);
    const kind = uiRef.current.build;

    // 建造模式优先按格子判定：相邻塔座的间距不大，
    // 先做"塔身屏幕命中"会把想放在邻座上的点击误判成选中了旁边的塔
    if (kind) {
      if (!cell) return;
      const existing = towerAt(w, cell[0], cell[1]);
      if (existing) {
        selectTower(existing.id);
        sfx.click();
        return;
      }
      const res = placeTower(w, kind, cell[0], cell[1]);
      if (res === 'ok') {
        sfx.merge();
        setHud(snapshot(w));
        if (w.gold < buildCost(kind)) {
          uiRef.current.build = null;
          setBuildKind(null);
        }
      } else if (res === 'gold') {
        sfx.mismatch();
      }
      return;
    }

    const tower = towerHit(mx, my);
    if (tower) {
      selectTower(tower.id);
      sfx.click();
      return;
    }
    if (!cell) {
      selectTower(null);
      return;
    }
    const existing = towerAt(w, cell[0], cell[1]);
    if (existing) {
      selectTower(existing.id);
      sfx.click();
      return;
    }
    selectTower(null);
  };

  // ============ HUD 派生 ============

  const w = worldRef.current;
  const selTower = selId != null ? w.towers.find((t) => t.id === selId) : undefined;
  const canAct = status === STATUS_PLAYING && !paused;
  const waveHeading =
    hud.phase === 'prep' ? `第 ${hud.wave} / ${WAVE_COUNT} 波准备` : hud.phase === 'wave' ? `第 ${hud.wave} / ${WAVE_COUNT} 波进攻中` : '战局结束';
  const waveSub =
    hud.phase === 'prep'
      ? `${Math.ceil(hud.prep)} 秒后自动开战`
      : hud.phase === 'wave'
        ? `本波剩余 ${hud.remaining} 只`
        : '查看结算';
  const bonus = earlyBonus(hud.wave);

  return (
    <GameShell
      meta={metaCrystalDefense}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>分数</span>
            <strong>{hud.score}</strong>
          </div>
          <div className="stat-box">
            <span>晶能</span>
            <strong className="td3d-gold">◆ {hud.gold}</strong>
          </div>
          <div className="stat-box">
            <span>晶核</span>
            <strong className={hud.coreHp <= 6 ? 'td3d-danger' : undefined}>
              {hud.coreHp}/{CORE_MAX_HP}
            </strong>
          </div>
          <div className="stat-box">
            <span>波次</span>
            <strong>
              {hud.wave}/{WAVE_COUNT}
            </strong>
          </div>
          <div className="stat-box td3d-best-stat">
            <span>{metaCrystalDefense.bestScoreLabel}</span>
            <strong>{best.value != null ? best.value : '—'}</strong>
          </div>
        </>
      }
    >
      <div className="td3d">
        <div className="td3d-stage">
          <canvas
            ref={canvasRef}
            className="td3d-canvas"
            aria-label="3D 晶核防线战场：点击塔座建造晶塔"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerLeave={onPointerLeave}
          />

          {status === STATUS_READY && (
            <div className="td3d-overlay">
              <h2>🏰 3D 晶核防线</h2>
              <p className="td3d-lead">虚空兽潮沿遗迹古道涌向晶核。在发光塔座上布防，撑过十二波。</p>
              <div className="td3d-guide">
                <div>
                  <b>⚡ 脉冲塔</b>
                  高频单体，但会被重甲吃掉伤害
                </div>
                <div>
                  <b>❄️ 霜华塔</b>
                  光环减速，霜伤无视护甲
                </div>
                <div>
                  <b>💣 裂地炮</b>
                  曲射溅射，专治成群的虫潮
                </div>
              </div>
              <p className="td3d-keys">点塔座建造 · 点晶塔升级 / 出售 · 提前出击有晶能奖励</p>
              <p className="td3d-keys td3d-mobile-roles">⚡单体速射 · ❄️减速破甲 · 💣范围溅射</p>
              <button className="btn btn-primary" onClick={start}>
                开始防守
              </button>
            </div>
          )}

          {status === STATUS_WON && (
            <div className="td3d-overlay">
              <h2>🏆 晶核守住了！</h2>
              <p>
                十二波兽潮尽数溃散 · 剩余晶核 {hud.coreHp}/{CORE_MAX_HP}
              </p>
              <div className="td3d-scoreline">
                最终得分 <strong>{hud.score}</strong>
                {newRecord && <span className="td3d-newrecord">新纪录</span>}
              </div>
              <p className="td3d-keys">
                击杀 {hud.kills} · 最高分 {best.value ?? hud.score}
              </p>
              <button className="btn btn-primary" onClick={start}>
                再守一局
              </button>
            </div>
          )}

          {status === STATUS_LOST && (
            <div className="td3d-overlay">
              <h2>💥 晶核破碎…</h2>
              <p>
                防线在第 {hud.wave} 波失守 · 击杀 {hud.kills}
              </p>
              <div className="td3d-scoreline">
                得分 <strong>{hud.score}</strong>
                {newRecord && <span className="td3d-newrecord">新纪录</span>}
              </div>
              <p className="td3d-keys">最高分 {best.value ?? '—'} · 重甲怪需要霜华或裂地炮</p>
              <button className="btn btn-primary" onClick={start}>
                重整防线
              </button>
            </div>
          )}

          {paused && status === STATUS_PLAYING && (
            <div className="td3d-overlay td3d-pause">
              <h2>⏸ 已暂停</h2>
              <p>兽群停在原地。整理一下建塔思路，再继续。</p>
              <button className="btn btn-primary" onClick={togglePause}>
                继续战斗
              </button>
            </div>
          )}
        </div>

        <div className="td3d-top">
          <div className="td3d-wave">
            <div className="td3d-wave-text">
              <strong>{waveHeading}</strong>
              <span>{waveSub}</span>
            </div>
            {hud.phase === 'prep' ? (
              <button className="btn btn-primary" disabled={!canAct} onClick={callNext}>
                提前出击 <span className="td3d-bonus">+◆{bonus}</span>
              </button>
            ) : (
              <button className="btn btn-ghost" disabled>
                {hud.phase === 'wave' ? '兽潮进行中' : '战局已结束'}
              </button>
            )}
          </div>
          <div className="td3d-tools">
            <button className="btn btn-ghost" disabled={!canAct} onClick={toggleSpeed} title="切换模拟速度">
              ×{speed} 速度
            </button>
            <button
              className="btn btn-ghost"
              disabled={status !== STATUS_PLAYING}
              onClick={togglePause}
              title="暂停（空格）"
            >
              {paused ? '▶ 继续' : '⏸ 暂停'}
            </button>
          </div>
        </div>

        <div className="td3d-build">
          {TOWER_ORDER.map((kind) => {
            const def = TOWER_DEFS[kind];
            const cost = buildCost(kind);
            const disabled = !canAct || hud.gold < cost;
            return (
              <button
                key={kind}
                className={`td3d-card${buildKind === kind ? ' on' : ''}`}
                style={{ '--tc': def.color } as CSSProperties}
                disabled={disabled}
                onClick={() => toggleBuild(kind)}
                title={`${def.name}：${def.blurb}（快捷键 ${TOWER_ORDER.indexOf(kind) + 1}）`}
              >
                <span className="td3d-card-icon">
                  <TowerGlyph kind={kind} />
                </span>
                <span className="td3d-card-text">
                  <strong>{def.name}</strong>
                  <small>{def.blurb}</small>
                </span>
                <span className="td3d-card-cost">◆{cost}</span>
              </button>
            );
          })}
        </div>

        {selTower ? (
          <div className="td3d-sel" style={{ '--tc': TOWER_DEFS[selTower.kind].color } as CSSProperties}>
            <div className="td3d-sel-info">
              <strong>
                {TOWER_DEFS[selTower.kind].name} · Lv.{selTower.level}
              </strong>
              <span>
                {statLine(selTower)} · 射程 {towerStat(selTower).range}
              </span>
            </div>
            <div className="td3d-sel-actions">
              <button
                className="btn btn-primary"
                disabled={!canAct || selTower.level >= 3 || hud.gold < upgradeCost(selTower)}
                onClick={upgradeSelected}
              >
                {selTower.level >= 3 ? '已满级' : `升级 ◆${upgradeCost(selTower)}`}
              </button>
              <button className="btn btn-ghost" disabled={!canAct} onClick={sellSelected}>
                出售 +◆{sellValue(selTower)}
              </button>
              <button className="td3d-close" onClick={() => selectTower(null)} aria-label="取消选中">
                ×
              </button>
            </div>
          </div>
        ) : (
          <div className="td3d-info">
            {buildKind
              ? `正在建造 ${TOWER_DEFS[buildKind].name} —— 点击发光塔座放置 · 再点卡片取消`
              : '点击发光塔座建塔 · 点击晶塔查看射程与升级 · 重甲单位靠霜华 / 裂地炮处理'}
          </div>
        )}

        <p className="hint">提前出击奖励晶能 · 1/2/3 选塔 · 空格暂停 · 塔可出售回收 60% 投入</p>
      </div>
    </GameShell>
  );
}

