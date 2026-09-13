import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { TouchDpad } from '../core/TouchControls';
import { metaRacing3D } from '../core/gameMetas';

// ============ 常量 ============

/** 内部渲染分辨率（4:3） */
const RW = 480;
const RH = 360;
const CX = RW / 2;
const HORIZON = RH * 0.5;

/** 伪 3D 投影参数（世界单位） */
const ROAD_W = 2100;
const SEG_LEN = 100;
const CAM_H = 1150;
const CAM_DEPTH = 1 / Math.tan(((100 / 2) * Math.PI) / 180);
/** 玩家车相对相机的距离 */
const PLAYER_Z = CAM_H / CAM_DEPTH;
/** 同屏渲染段数 */
const DRAW_DIST = 80;
/** 赛道主体目标段数（收尾回平段另加，总长以建成赛道为准） */
const SEG_TARGET = 360;

/** 车道中心（路宽归一化 -1..1，共三车道） */
const LANES = [-0.62, 0, 0.62];

/** 速度（世界单位/秒） */
const MAX_SPEED = SEG_LEN * 62;
const ACCEL = MAX_SPEED / 4.5;
const BRAKE = -MAX_SPEED * 0.9;
const DECEL = -MAX_SPEED / 6;
const OFFROAD_DECEL = -MAX_SPEED / 1.6;
const OFFROAD_LIMIT = MAX_SPEED / 4.5;
/** 弯道离心力（把玩家往外甩的强度） */
const CENTRIFUGAL = 0.31;

/** 车流：初始数量 / 每 700m 加一辆 / 上限 / 速度范围（相对最高速） */
const CARS0 = 6;
const CARS_MAX = 14;
const CAR_ADD_DIST = 700;
const CAR_SPEED_MIN = 0.32;
const CAR_SPEED_MAX = 0.58;
/** 车距（前后碰撞判定）/ 横向碰撞半径 / 近失横向判定上限 */
const CAR_LEN = 105;
const CAR_HIT_X = 0.5;
const NEAR_MISS_X = 1.0;
/** 近失奖励分 / 近失后短暂冲刺提速 */
const NEAR_MISS_SCORE = 50;
const NEAR_MISS_BOOST_T = 1.4;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const easeIn = (a: number, b: number, t: number) => a + (b - a) * t * t;
const easeInOut = (a: number, b: number, t: number) => a + (b - a) * (-Math.cos(t * Math.PI) / 2 + 0.5);

// ============ 赛道与投影 ============

interface Pt {
  world: { y: number; z: number };
  camera: { z: number };
  screen: { x: number; y: number; w: number; scale: number };
}

interface Sprite {
  type: 'tree' | 'rock' | 'sign';
  /** 路侧位置（路宽倍数，负左正右） */
  offset: number;
}

interface Segment {
  index: number;
  p1: Pt;
  p2: Pt;
  curve: number;
  sprites: Sprite[];
}

function makeSegment(index: number, curve: number, y1: number, y2: number): Segment {
  return {
    index,
    curve,
    sprites: [],
    p1: { world: { y: y1, z: index * SEG_LEN }, camera: { z: 0 }, screen: { x: 0, y: 0, w: 0, scale: 0 } },
    p2: { world: { y: y2, z: (index + 1) * SEG_LEN }, camera: { z: 0 }, screen: { x: 0, y: 0, w: 0, scale: 0 } },
  };
}

/** 生成一段 enter/hold/leave 的弯道或坡道 */
function addRoad(segs: Segment[], enter: number, hold: number, leave: number, curve: number, dy: number) {
  const startY = segs.length ? segs[segs.length - 1].p2.world.y : 0;
  const endY = startY + dy * SEG_LEN;
  const total = enter + hold + leave;
  for (let n = 0; n < enter; n++)
    segs.push(makeSegment(segs.length, easeIn(0, curve, n / enter), easeInOut(startY, endY, n / total), easeInOut(startY, endY, (n + 1) / total)));
  for (let n = 0; n < hold; n++)
    segs.push(makeSegment(segs.length, curve, easeInOut(startY, endY, (enter + n) / total), easeInOut(startY, endY, (enter + n + 1) / total)));
  for (let n = 0; n < leave; n++)
    segs.push(makeSegment(segs.length, easeInOut(curve, 0, n / leave), easeInOut(startY, endY, (enter + hold + n) / total), easeInOut(startY, endY, (enter + hold + n + 1) / total)));
}

/** 弯道外侧立指示牌 */
function addSigns(segs: Segment[], from: number, to: number, curve: number) {
  const side = curve > 0 ? 1 : -1;
  for (let i = from + 2; i < to - 2; i += 4) {
    segs[i % segs.length].sprites.push({ type: 'sign', offset: side * 1.35 });
  }
}

/** 生成赛道：直道与弯道交替，坡度小幅起伏，路旁随机树木/岩石。
 *  每局随机总长，收尾段自动回到 0 高度保证循环无缝。 */
function buildTrack(): Segment[] {
  const segs: Segment[] = [];
  segs.push(makeSegment(0, 0, 0, 0));
  while (segs.length < SEG_TARGET) {
    const r = Math.random();
    const from = segs.length;
    if (r < 0.3) addRoad(segs, 10, 20 + Math.random() * 30, 10, 0, rand(-4, 4));
    else if (r < 0.55) addRoad(segs, 18, 26 + Math.random() * 26, 18, Math.random() < 0.5 ? 2.4 : -2.4, rand(-5, 5));
    else if (r < 0.78) addRoad(segs, 22, 30 + Math.random() * 24, 22, Math.random() < 0.5 ? 4.2 : -4.2, rand(-6, 6));
    else addRoad(segs, 26, 26 + Math.random() * 22, 26, Math.random() < 0.5 ? 6 : -6, rand(-3, 3));
    const curve = segs[Math.min(segs.length - 2, segs.length - 1)].curve;
    if (Math.abs(curve) > 1.5) addSigns(segs, from, segs.length, curve);
  }
  // 收尾回到起点高度，保证循环无跳变
  addRoad(segs, 20, 30, 20, 0, -(segs[segs.length - 1].p2.world.y / SEG_LEN));

  for (let i = 4; i < segs.length; i += 2) {
    if (Math.random() < 0.62) {
      const side = Math.random() < 0.5 ? -1 : 1;
      segs[i].sprites.push({
        type: Math.random() < 0.78 ? 'tree' : 'rock',
        offset: side * rand(1.35, 2.6),
      });
      if (Math.random() < 0.35) {
        segs[i].sprites.push({
          type: 'tree',
          offset: -side * rand(1.45, 2.7),
        });
      }
    }
  }
  return segs;
}

/** 世界 → 屏幕；dz 下限避免相机脚下的段爆掉多边形；scale 上限防止巨大路径拖垮光栅 */
function project(p: Pt, camX: number, camY: number, camZ: number) {
  const dz = Math.max(20, p.world.z - camZ);
  p.camera.z = dz;
  const scale = Math.min(CAM_DEPTH / dz, 0.0052);
  p.screen.scale = scale;
  p.screen.x = Math.round(clamp(RW / 2 + scale * -camX * (RW / 2), -4000, 4000));
  p.screen.y = Math.round(RH / 2 - scale * (p.world.y - camY) * (RH / 2));
  p.screen.w = Math.round(scale * ROAD_W * (RW / 2));
}

// ============ 类型 ============

interface Car {
  offset: number;
  z: number;
  speed: number;
  color: string;
  /** 是否已被本圈玩家超过（近失判定用） */
  passed: boolean;
}

interface World {
  segs: Segment[];
  /** 赛道总长（世界单位），= 段数 × 段长 */
  trackLen: number;
  cars: Car[];
  position: number;
  playerX: number;
  speed: number;
  steer: number;
  accel: boolean;
  brake: boolean;
  lives: number;
  invincible: number;
  boostT: number;
  /** 近失次数（结算加分用） */
  nearMiss: number;
  /** 撞车红光闪 */
  crashAt: number;
  /** 近失提示语 */
  msg: string;
  msgAt: number;
  msgGood: boolean;
  /** 车身倾斜（-1..1，随转向） */
  tilt: number;
  meters: number;
  over: boolean;
}

const CAR_COLORS = ['#e5484d', '#3b82f6', '#f59e0b', '#22c55e', '#a855f7', '#e2e8f0', '#f97316'];

function newWorld(): World {
  const segs = buildTrack();
  return {
    segs,
    trackLen: segs.length * SEG_LEN,
    cars: [],
    position: 0,
    playerX: 0,
    speed: 0,
    steer: 0,
    accel: false,
    brake: false,
    lives: 3,
    invincible: 0,
    boostT: 0,
    nearMiss: 0,
    crashAt: -9,
    msg: '',
    msgAt: -9,
    msgGood: true,
    tilt: 0,
    meters: 0,
    over: false,
  };
}

function findSegment(w: World, z: number): Segment {
  const zz = ((z % w.trackLen) + w.trackLen) % w.trackLen;
  return w.segs[Math.floor(zz / SEG_LEN) % w.segs.length];
}

function targetCars(meters: number): number {
  return Math.min(CARS_MAX, CARS0 + Math.floor(meters / CAR_ADD_DIST));
}

function spawnCar(w: World, aheadZ: number): Car {
  const lane = LANES[Math.floor(Math.random() * 3)] + rand(-0.06, 0.06);
  const frac = rand(CAR_SPEED_MIN, CAR_SPEED_MAX);
  return {
    offset: lane,
    z: aheadZ,
    speed: MAX_SPEED * frac * (1 + Math.min(0.35, w.meters / 6000)),
    color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
    passed: false,
  };
}

// ============ 物理 ============

function step(w: World, dt: number, tNow: number) {
  const playerSegment = findSegment(w, w.position + PLAYER_Z);
  const speedPercent = w.speed / MAX_SPEED;
  const dx = dt * 2.4 * speedPercent;

  // 转向输入
  if (w.steer < 0) w.playerX -= dx;
  else if (w.steer > 0) w.playerX += dx;
  // 弯道离心力
  w.playerX -= dx * speedPercent * playerSegment.curve * CENTRIFUGAL * 3.2;
  w.playerX = clamp(w.playerX, -2.3, 2.3);

  // 加减速
  const offroad = Math.abs(w.playerX) > 1;
  const maxSpeed = MAX_SPEED + Math.min(MAX_SPEED * 0.45, w.meters * 2.2);
  const boost = w.boostT > 0 ? 1.18 : 1;
  if (w.accel) w.speed += ACCEL * dt;
  else w.speed += DECEL * dt;
  if (w.brake) w.speed += BRAKE * dt;
  if (offroad) {
    if (w.speed > OFFROAD_LIMIT) w.speed += OFFROAD_DECEL * dt;
  }
  w.speed = clamp(w.speed, 0, maxSpeed * boost);
  if (w.boostT > 0) w.boostT -= dt;
  if (w.invincible > 0) w.invincible -= dt;

  w.position += w.speed * dt;
  w.meters = w.position / 55;

  // 车身倾斜：随转向与弯道
  const targetTilt = clamp(w.steer * 0.7 - playerSegment.curve * speedPercent * 0.08, -1, 1);
  w.tilt += (targetTilt - w.tilt) * (1 - Math.exp(-10 * dt));

  // 车流：补充 / 回收
  const want = targetCars(w.meters);
  while (w.cars.length < want) {
    w.cars.push(spawnCar(w, w.position + PLAYER_Z + rand(DRAW_DIST, DRAW_DIST * 2.4) * SEG_LEN));
  }
  for (const c of w.cars) c.z += c.speed * dt;
  for (let i = w.cars.length - 1; i >= 0; i--) {
    const c = w.cars[i];
    if (c.z < w.position - SEG_LEN * 4 || c.z > w.position + w.trackLen * 0.75) {
      if (w.cars.length > want) w.cars.splice(i, 1);
      else {
        c.z = w.position + PLAYER_Z + rand(DRAW_DIST, DRAW_DIST * 2.4) * SEG_LEN;
        c.offset = LANES[Math.floor(Math.random() * 3)] + rand(-0.06, 0.06);
        c.speed = MAX_SPEED * rand(CAR_SPEED_MIN, CAR_SPEED_MAX) * (1 + Math.min(0.35, w.meters / 6000));
        c.passed = false;
      }
    }
  }

  // 碰撞 / 近失
  if (w.invincible <= 0) {
    for (const c of w.cars) {
      const relZ = c.z - (w.position + PLAYER_Z);
      if (Math.abs(relZ) < CAR_LEN && Math.abs(w.playerX - c.offset) < CAR_HIT_X) {
        w.lives -= 1;
        w.invincible = 1.6;
        w.speed = Math.min(w.speed, MAX_SPEED * 0.12);
        w.crashAt = tNow;
        w.nearMiss = Math.max(0, w.nearMiss); // 不变，撞车不加分
        if (w.lives <= 0) w.over = true;
        else {
          sfx.lose();
          w.msg = '撞车！';
          w.msgAt = tNow;
          w.msgGood = false;
        }
        break;
      }
    }
  }
  for (const c of w.cars) {
    const relZ = c.z - (w.position + PLAYER_Z);
    if (!c.passed && relZ < -CAR_LEN * 1.4) {
      c.passed = true;
      if (w.invincible <= 0 && Math.abs(w.playerX - c.offset) < NEAR_MISS_X) {
        w.nearMiss += 1;
        w.boostT = NEAR_MISS_BOOST_T;
        w.msg = '贴身超车 +50';
        w.msgAt = tNow;
        w.msgGood = true;
        sfx.match();
      }
    }
  }
}

// ============ 渲染 ============

/** 黄昏配色 */
const COL = {
  sky0: '#1b2350',
  sky1: '#3b2a63',
  sky2: '#c2506a',
  grassA: '#3f7a44',
  grassB: '#39703d',
  rumbleA: '#e8e8f0',
  rumbleB: '#d94f5c',
  roadA: '#4a4a58',
  roadB: '#454552',
  lane: '#e8e8f0',
  fog: '#c97a6d',
};

function poly(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, w1: number, w2: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1 - w1, y1);
  ctx.lineTo(x2 - w2, y2);
  ctx.lineTo(x2 + w2, y2);
  ctx.lineTo(x1 + w1, y1);
  ctx.closePath();
  ctx.fill();
}

/** 远处山影（两层，按弯道轻微视差） */
function drawMountains(ctx: CanvasRenderingContext2D, parallax: number) {
  const layers = [
    { y: HORIZON - 34, amp: 26, color: '#2c2a55', seed: 0.9 },
    { y: HORIZON - 12, amp: 20, color: '#241f45', seed: 2.1 },
  ];
  for (const L of layers) {
    ctx.fillStyle = L.color;
    ctx.beginPath();
    ctx.moveTo(0, L.y + 60);
    for (let x = 0; x <= RW; x += 24) {
      const yy = L.y - Math.abs(Math.sin(x * 0.021 + L.seed + parallax * 0.35)) * L.amp - Math.sin(x * 0.047 + L.seed * 2) * 8;
      ctx.lineTo(x, yy);
    }
    ctx.lineTo(RW, L.y + 60);
    ctx.closePath();
    ctx.fill();
  }
}

function drawSky(ctx: CanvasRenderingContext2D) {
  const g = ctx.createLinearGradient(0, 0, 0, HORIZON + 10);
  g.addColorStop(0, COL.sky0);
  g.addColorStop(0.55, COL.sky1);
  g.addColorStop(0.88, COL.sky2);
  g.addColorStop(1, '#e88a5c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, RW, HORIZON + 10);
  // 落日
  const sg = ctx.createRadialGradient(CX, HORIZON - 6, 4, CX, HORIZON - 6, 90);
  sg.addColorStop(0, 'rgba(255,214,140,0.95)');
  sg.addColorStop(0.25, 'rgba(255,170,110,0.5)');
  sg.addColorStop(1, 'rgba(255,150,100,0)');
  ctx.fillStyle = sg;
  ctx.fillRect(CX - 90, HORIZON - 96, 180, 180);
  ctx.fillStyle = '#ffd9a0';
  ctx.beginPath();
  ctx.arc(CX, HORIZON - 8, 17, Math.PI, 0);
  ctx.fill();
}

function drawSprite(ctx: CanvasRenderingContext2D, sp: Sprite, x: number, y: number, scale: number) {
  const px = scale * (RW / 2);
  if (sp.type === 'tree') {
    const h = 950 * px;
    if (h < 2) return;
    const w = h * 0.42;
    ctx.fillStyle = '#4a3220';
    ctx.fillRect(x - h * 0.03, y - h * 0.18, h * 0.06, h * 0.18);
    ctx.fillStyle = '#1f4d2e';
    for (let i = 0; i < 3; i++) {
      const ty = y - h * (0.16 + i * 0.26);
      const tw = w * (1 - i * 0.26);
      ctx.beginPath();
      ctx.moveTo(x, ty - h * 0.34);
      ctx.lineTo(x - tw, ty);
      ctx.lineTo(x + tw, ty);
      ctx.closePath();
      ctx.fill();
    }
  } else if (sp.type === 'rock') {
    const h = 260 * px;
    if (h < 1.5) return;
    ctx.fillStyle = '#6b6f80';
    ctx.beginPath();
    ctx.ellipse(x, y - h * 0.4, h * 0.7, h * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.ellipse(x - h * 0.2, y - h * 0.55, h * 0.3, h * 0.16, -0.4, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // 弯道指示牌（箭头朝弯道方向）
    const h = 620 * px;
    if (h < 2.5) return;
    ctx.fillStyle = '#3a3f55';
    ctx.fillRect(x - h * 0.04, y - h * 0.6, h * 0.08, h * 0.6);
    ctx.save();
    ctx.translate(x, y - h * 0.72);
    ctx.fillStyle = '#ffd166';
    ctx.strokeStyle = '#20233a';
    ctx.lineWidth = Math.max(1, h * 0.03);
    ctx.beginPath();
    ctx.roundRect(-h * 0.32, -h * 0.22, h * 0.64, h * 0.44, h * 0.06);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#20233a';
    const dir = sp.offset > 0 ? 1 : -1;
    for (let i = -1; i <= 1; i++) {
      const bx = i * h * 0.16;
      ctx.beginPath();
      ctx.moveTo(bx - dir * h * 0.05, -h * 0.1);
      ctx.lineTo(bx + dir * h * 0.06, 0);
      ctx.lineTo(bx - dir * h * 0.05, h * 0.1);
      ctx.lineTo(bx - dir * h * 0.01, h * 0.1);
      ctx.lineTo(bx + dir * h * 0.1, 0);
      ctx.lineTo(bx - dir * h * 0.01, -h * 0.1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}

/** 车尾视角的车（玩家与车流共用；tilt 仅玩家用） */
function drawCar(ctx: CanvasRenderingContext2D, cx: number, baseY: number, wPx: number, color: string, tilt: number, isPlayer: boolean) {
  const h = wPx * 0.62;
  ctx.save();
  ctx.translate(cx, baseY);
  if (tilt !== 0) ctx.transform(1, 0, tilt * 0.14, 1, 0, 0);
  // 阴影
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, 0, wPx * 0.58, h * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  // 车轮
  ctx.fillStyle = '#15151d';
  const ww = wPx * 0.16;
  const wh = h * 0.3;
  ctx.fillRect(-wPx * 0.5, -wh * 0.85, ww, wh);
  ctx.fillRect(wPx * 0.5 - ww, -wh * 0.85, ww, wh);
  // 车身
  const grad = ctx.createLinearGradient(0, -h, 0, 0);
  grad.addColorStop(0, color);
  grad.addColorStop(1, shade(color, -0.35));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(-wPx * 0.48, -h * 0.88, wPx * 0.96, h * 0.72, wPx * 0.08);
  ctx.fill();
  // 座舱（后窗）
  ctx.fillStyle = 'rgba(16,20,38,0.92)';
  ctx.beginPath();
  ctx.roundRect(-wPx * 0.32, -h * 0.86, wPx * 0.64, h * 0.3, wPx * 0.05);
  ctx.fill();
  // 尾翼（玩家车）
  if (isPlayer) {
    ctx.fillStyle = shade(color, -0.55);
    ctx.fillRect(-wPx * 0.42, -h * 1.02, wPx * 0.84, h * 0.08);
    ctx.fillRect(-wPx * 0.4, -h * 0.98, wPx * 0.05, h * 0.14);
    ctx.fillRect(wPx * 0.35, -h * 0.98, wPx * 0.05, h * 0.14);
  }
  // 车尾灯
  ctx.fillStyle = '#ff5252';
  ctx.fillRect(-wPx * 0.44, -h * 0.3, wPx * 0.16, h * 0.1);
  ctx.fillRect(wPx * 0.28, -h * 0.3, wPx * 0.16, h * 0.1);
  ctx.restore();
}

/** 简易调明暗 */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(((n >> 16) & 255) * (1 + k), 0, 255);
  const g = clamp(((n >> 8) & 255) * (1 + k), 0, 255);
  const b = clamp((n & 255) * (1 + k), 0, 255);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function render(ctx: CanvasRenderingContext2D, w: World, t: number) {
  ctx.clearRect(0, 0, RW, RH);
  const playerSegment = findSegment(w, w.position + PLAYER_Z);
  const playerPercent = ((w.position + PLAYER_Z) % SEG_LEN) / SEG_LEN;
  const playerY = lerp(playerSegment.p1.world.y, playerSegment.p2.world.y, playerPercent);
  const baseIndex = Math.floor(w.position / SEG_LEN) % w.segs.length;

  drawSky(ctx);
  drawMountains(ctx, w.position * 0.0004 + playerSegment.curve * 0.2);

  // 第一遍：由近及远投影并记录（供第二遍由远及近绘制）
  let x = 0;
  let dx = -(w.segs[baseIndex].curve * ((w.position % SEG_LEN) / SEG_LEN));
  for (let n = 0; n < DRAW_DIST; n++) {
    const seg = w.segs[(baseIndex + n) % w.segs.length];
    const looped = seg.index < baseIndex;
    const camZ = w.position - (looped ? w.trackLen : 0);
    project(seg.p1, w.playerX * ROAD_W - x, playerY + CAM_H, camZ);
    project(seg.p2, w.playerX * ROAD_W - x - dx, playerY + CAM_H, camZ);
    x += dx;
    dx += seg.curve;
  }

  // 车辆按所在段分组（远→近绘制时同段内再按 z 排）
  const carBySeg = new Map<number, Car[]>();
  for (const c of w.cars) {
    let relZ = c.z - w.position;
    if (relZ < -w.trackLen / 2) relZ += w.trackLen;
    else if (relZ > w.trackLen / 2) relZ -= w.trackLen;
    if (relZ < -SEG_LEN * 2 || relZ > DRAW_DIST * SEG_LEN) continue;
    const worldZ = w.position + relZ;
    const segIdx = Math.floor(((worldZ % w.trackLen) + w.trackLen) % w.trackLen / SEG_LEN) % w.segs.length;
    const arr = carBySeg.get(segIdx);
    if (arr) arr.push(c);
    else carBySeg.set(segIdx, [c]);
  }

  // 第二遍：由远及近画路面、路侧物、车流
  for (let n = DRAW_DIST - 1; n >= 0; n--) {
    const seg = w.segs[(baseIndex + n) % w.segs.length];
    const p1 = seg.p1.screen;
    const p2 = seg.p2.screen;
    if (seg.p1.camera.z <= CAM_DEPTH) continue;

    const alt = Math.floor(seg.index / 3) % 2 === 0;
    const fogA = Math.pow(n / DRAW_DIST, 2.2) * 0.75;
    // 草地（全宽横带，路面随后叠加）
    ctx.fillStyle = alt ? COL.grassA : COL.grassB;
    ctx.fillRect(0, p2.y, RW, p1.y - p2.y + 1);
    if (fogA > 0.02) {
      ctx.fillStyle = rgba(COL.fog, fogA);
      ctx.fillRect(0, p2.y, RW, p1.y - p2.y + 1);
    }
    // 路缘（红白相间）
    const r1 = Math.max(1, p1.w * 0.12);
    const r2 = Math.max(1, p2.w * 0.12);
    const rumble = Math.floor(seg.index / 2) % 2 === 0;
    poly(ctx, p1.x, p1.y, p2.x, p2.y, p1.w + r1, p2.w + r2, rumble ? COL.rumbleA : COL.rumbleB);
    // 路面
    poly(ctx, p1.x, p1.y, p2.x, p2.y, p1.w, p2.w, alt ? COL.roadA : COL.roadB);
    // 车道虚线（三车道两条分隔线）
    if (Math.floor(seg.index / 3) % 2 === 0) {
      const lw1 = Math.max(1, p1.w * 0.018);
      const lw2 = Math.max(1, p2.w * 0.018);
      for (const lane of [-1 / 3, 1 / 3]) {
        poly(ctx, p1.x + p1.w * lane, p1.y, p2.x + p2.w * lane, p2.y, lw1, lw2, COL.lane);
      }
    }
    if (fogA > 0.02) poly(ctx, p1.x, p1.y, p2.x, p2.y, p1.w + r1, p2.w + r2, rgba(COL.fog, fogA * 0.9));

    // 路侧物
    for (const sp of seg.sprites) {
      const sx = lerp(p1.x, p2.x, 0.5) + sp.offset * lerp(p1.w, p2.w, 0.5);
      const sy = lerp(p1.y, p2.y, 0.5);
      drawSprite(ctx, sp, sx, sy, lerp(p1.scale, p2.scale, 0.5));
    }

    // 车流
    const cars = carBySeg.get(seg.index);
    if (cars) {
      for (const c of cars) {
        let relZ = c.z - w.position;
        if (relZ < -w.trackLen / 2) relZ += w.trackLen;
        else if (relZ > w.trackLen / 2) relZ -= w.trackLen;
        const worldZ = w.position + relZ;
        const cz = ((worldZ % SEG_LEN) + SEG_LEN) % SEG_LEN / SEG_LEN;
        const cx = lerp(p1.x, p2.x, cz) + c.offset * lerp(p1.w, p2.w, cz);
        const cy = lerp(p1.y, p2.y, cz);
        const cw = lerp(p1.w, p2.w, cz) * 0.55;
        drawCar(ctx, cx, cy, cw, c.color, 0, false);
      }
    }
  }

  // 玩家车：投影到所在段的实际路面位置（横向随 playerX，撞后闪烁）
  const blink = w.invincible > 0 && Math.floor(t * 10) % 2 === 0;
  if (!blink) {
    const ps = playerSegment;
    const roadX = lerp(ps.p1.screen.x, ps.p2.screen.x, playerPercent);
    const roadY = lerp(ps.p1.screen.y, ps.p2.screen.y, playerPercent);
    const roadW = lerp(ps.p1.screen.w, ps.p2.screen.w, playerPercent);
    drawCar(ctx, roadX + w.playerX * roadW, Math.min(roadY, RH - 8), roadW * 0.58, '#7c5cff', w.tilt, true);
  }

  // ============ HUD ============
  const kmh = Math.round(w.speed * 0.036);
  ctx.font = '700 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(8,10,24,0.55)';
  ctx.beginPath();
  ctx.roundRect(8, 8, 118, 46, 8);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(`${kmh} km/h`, 16, 26);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.fillText(`${Math.floor(w.meters)} m`, 16, 44);

  // 生命
  ctx.textAlign = 'right';
  ctx.font = '14px system-ui, sans-serif';
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i < w.lives ? '#ff5d73' : 'rgba(255,255,255,0.22)';
    ctx.fillText('♥', RW - 14 - i * 18, 24);
  }
  if (w.nearMiss > 0) {
    ctx.fillStyle = '#ffd166';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillText(`近失 ×${w.nearMiss}`, RW - 14, 42);
  }

  // 提升中的速度线
  if (w.boostT > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + t * 2;
      const x0 = RW / 2 + Math.cos(a) * RW * 0.42;
      const y0 = RH / 2 + Math.sin(a) * RH * 0.42;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + Math.cos(a) * 26, y0 + Math.sin(a) * 26);
      ctx.stroke();
    }
  }

  // 提示语
  const mk = Math.max(0, 1 - (t - w.msgAt) * 0.9);
  if (mk > 0 && w.msg) {
    ctx.save();
    ctx.font = '800 21px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 5;
    ctx.strokeStyle = `rgba(8,10,24,${(0.75 * mk).toFixed(3)})`;
    ctx.strokeText(w.msg, RW / 2, RH * 0.3);
    ctx.fillStyle = w.msgGood ? `rgba(255,209,102,${mk.toFixed(3)})` : `rgba(255,110,110,${mk.toFixed(3)})`;
    ctx.fillText(w.msg, RW / 2, RH * 0.3);
    ctx.restore();
  }

  // 撞车红光
  const ck = Math.max(0, 1 - (t - w.crashAt) * 2.2);
  if (ck > 0) {
    ctx.fillStyle = `rgba(255,60,60,${(0.25 * ck).toFixed(3)})`;
    ctx.fillRect(0, 0, RW, RH);
  }
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
}

// ============ 主组件 ============

type Status = 'ready' | 'playing' | 'paused' | 'over';

export default function Racing3D() {
  const [status, setStatus] = useState<Status>('ready');
  const [hud, setHud] = useState({ kmh: 0, meters: 0, lives: 3, nearMiss: 0, score: 0 });
  const [newRecord, setNewRecord] = useState(false);
  const best = useBestScore(metaRacing3D.id);
  const { toast } = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(newWorld());
  const statusRef = useRef<Status>('ready');
  const overHandledRef = useRef(false);
  statusRef.current = status;

  const start = useCallback(() => {
    worldRef.current = newWorld();
    overHandledRef.current = false;
    setNewRecord(false);
    setHud({ kmh: 0, meters: 0, lives: 3, nearMiss: 0, score: 0 });
    setStatus('playing');
  }, []);

  const togglePause = useCallback(() => {
    const s = statusRef.current;
    if (s === 'playing') setStatus('paused');
    else if (s === 'paused') setStatus('playing');
  }, []);

  const startRef = useRef(start);
  startRef.current = start;
  const togglePauseRef = useRef(togglePause);
  togglePauseRef.current = togglePause;

  // 触屏方向盘
  const onDir = useCallback((dir: 'up' | 'down' | 'left' | 'right') => {
    const w = worldRef.current;
    if (dir === 'left') {
      w.steer = -1;
      w.accel = true;
    } else if (dir === 'right') {
      w.steer = 1;
      w.accel = true;
    } else if (dir === 'up') {
      w.accel = true;
    } else {
      w.brake = true;
      w.accel = false;
    }
  }, []);
  const onDirRef = useRef(onDir);
  onDirRef.current = onDir;

  // 主循环
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = RW * dpr;
    canvas.height = RH * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    let last = performance.now();
    let hudT = 0;

    const loop = (nowMs: number) => {
      const dt = Math.min(0.05, (nowMs - last) / 1000);
      last = nowMs;
      const t = nowMs / 1000;
      const w = worldRef.current;

      if (statusRef.current === 'playing') {
        step(w, dt, t);
        if (w.over) {
          statusRef.current = 'over';
          setStatus('over');
        }
        hudT += dt;
        if (hudT > 0.12) {
          hudT = 0;
          setHud({
            kmh: Math.round(w.speed * 0.036),
            meters: Math.floor(w.meters),
            lives: w.lives,
            nearMiss: w.nearMiss,
            score: Math.floor(w.meters) + w.nearMiss * NEAR_MISS_SCORE,
          });
        }
      }

      render(ctx, w, t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 结算纪录
  useEffect(() => {
    if (status !== 'over' || overHandledRef.current) return;
    overHandledRef.current = true;
    const w = worldRef.current;
    const sc = Math.floor(w.meters) + w.nearMiss * NEAR_MISS_SCORE;
    setHud((h) => ({ ...h, score: sc }));
    const isNew = sc > 0 && best.updateBest(sc, (a, b) => a > b);
    setNewRecord(isNew);
    if (isNew) {
      sfx.record();
      toast(`🏆 新纪录！${sc} 分`, 'record');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // 键盘
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.code;
      if (k.startsWith('Arrow') || k === 'Space') e.preventDefault();
      const w = worldRef.current;
      if (k === 'KeyP' && !e.repeat) {
        togglePauseRef.current();
        return;
      }
      if (k === 'Enter' || (k === 'Space' && !e.repeat)) {
        const s = statusRef.current;
        if (s === 'ready' || s === 'over') startRef.current();
        else if (s === 'paused') togglePauseRef.current();
        return;
      }
      if (statusRef.current !== 'playing') return;
      if (k === 'ArrowLeft' || k === 'KeyA') w.steer = -1;
      else if (k === 'ArrowRight' || k === 'KeyD') w.steer = 1;
      else if (k === 'ArrowUp' || k === 'KeyW') w.accel = true;
      else if (k === 'ArrowDown' || k === 'KeyS') w.brake = true;
    };
    const up = (e: KeyboardEvent) => {
      const w = worldRef.current;
      const k = e.code;
      if ((k === 'ArrowLeft' || k === 'KeyA') && w.steer < 0) w.steer = 0;
      else if ((k === 'ArrowRight' || k === 'KeyD') && w.steer > 0) w.steer = 0;
      else if (k === 'ArrowUp' || k === 'KeyW') w.accel = false;
      else if (k === 'ArrowDown' || k === 'KeyS') w.brake = false;
    };
    const clear = () => {
      const w = worldRef.current;
      w.steer = 0;
      w.accel = false;
      w.brake = false;
      if (statusRef.current === 'playing') setStatus('paused');
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') clear();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return (
    <GameShell
      meta={metaRacing3D}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>当前得分</span>
            <strong>{hud.score}</strong>
          </div>
          <div className="stat-box">
            <span>里程</span>
            <strong>{hud.meters} m</strong>
          </div>
          <div className="stat-box">
            <span>车速</span>
            <strong>{hud.kmh}</strong>
          </div>
          <div className="stat-box">
            <span>生命</span>
            <strong>{'♥'.repeat(hud.lives) || '—'}</strong>
          </div>
          <div className="stat-box">
            <span>{metaRacing3D.bestScoreLabel}</span>
            <strong>{best.value != null ? best.value : '—'}</strong>
          </div>
        </>
      }
    >
      <div className="rc3d">
        <div className="rc3d-stage">
          <canvas ref={canvasRef} className="rc3d-canvas" role="img" aria-label="3D 极速赛车游戏画面" />
          {status === 'ready' && (
            <div className="rc3d-overlay">
              <h2>🏎️ 3D 极速赛车</h2>
              <p>
                黄昏山路无限狂飙：速度越来越快，车流越来越密。
                <br />
                撞车损失一条生命（共 3 条），贴身超车有近失加分与短暂冲刺！
              </p>
              <p className="rc3d-keys">
                ←→/AD 转向 · ↑/W 油门 · ↓/S 刹车 · P 暂停
                <br />
                触屏：左侧方向盘 ↑ 油门 ↓ 刹车
              </p>
              <button className="btn btn-primary" onClick={start}>
                出发
              </button>
            </div>
          )}
          {status === 'paused' && (
            <div className="rc3d-overlay">
              <h2>⏸ 已暂停</h2>
              <button className="btn btn-primary" onClick={togglePause}>
                继续
              </button>
            </div>
          )}
          {status === 'over' && (
            <div className="rc3d-overlay" onClick={start}>
              <h2>🏁 比赛结束</h2>
              <p>
                得分 {hud.score}（里程 {hud.meters} m + 近失 ×{hud.nearMiss}）
                {newRecord ? ' · 🏆 新纪录！' : best.value != null ? ` · 最佳 ${best.value}` : ''}
              </p>
              <button
                className="btn btn-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  start();
                }}
              >
                再来一局
              </button>
            </div>
          )}
        </div>

        <div className="rc3d-controls">
          <TouchDpad
            onDir={(dir) => {
              const w = worldRef.current;
              if (statusRef.current !== 'playing') return;
              onDirRef.current(dir);
              sfx.move();
              // 方向键松开后复位（dpad 无 up 事件，按下即冲，短按够用）
              window.setTimeout(() => {
                if (dir === 'left' || dir === 'right') w.steer = 0;
                if (dir === 'up') w.accel = false;
                if (dir === 'down') w.brake = false;
              }, 260);
            }}
          />
          <div className="rc3d-actions">
            <button className="btn btn-ghost" onClick={togglePause} disabled={status !== 'playing' && status !== 'paused'}>
              {status === 'paused' ? '▶ 继续' : '⏸ 暂停'}
            </button>
            <button className="btn btn-ghost" onClick={start}>
              🔄 重新开始
            </button>
          </div>
        </div>
        <p className="hint">
          弯道上会被离心力向外甩，提前靠内侧；冲出路面会大幅减速；近失超车有 {NEAR_MISS_SCORE} 分奖励和短暂提速。
        </p>
      </div>
    </GameShell>
  );
}
