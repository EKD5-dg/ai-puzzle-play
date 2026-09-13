import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { TouchButtons } from '../core/TouchControls';
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
const OFFROAD_DECEL = -MAX_SPEED / 2.6;
/** 冲出路面后的巡航速度上限（约 100 km/h，够回到路面不至于寸步难行） */
const OFFROAD_LIMIT = MAX_SPEED * 0.42;
/** 转向角速度（路宽/秒，低速时保留下限以便微调） */
const STEER_RATE = 3.4;
/** 横向可达极限（路宽倍数，1=路面边缘） */
const PLAYER_X_MAX = 1.7;
/** 弯道离心力（把玩家往外甩的强度）：满速最急弯(6)时约等于转向能力的 90%，靠转向可守住线 */
const CENTRIFUGAL = 0.15;

/** 车流：初始数量 / 每 700m 加一辆 / 上限 / 速度范围（相对最高速）/ 生成距离（段，略远于视距免在地平线闪现） */
const CARS0 = 6;
const CARS_MAX = 14;
const CAR_ADD_DIST = 700;
const CAR_SPEED_MIN = 0.32;
const CAR_SPEED_MAX = 0.58;
const CAR_SPAWN_SEG = DRAW_DIST * 1.15;
/** 车距（前后碰撞判定）/ 横向碰撞半径 / 近失横向判定上限（略小于两倍车道半宽，只算真正贴身） */
const CAR_LEN = 105;
const CAR_HIT_X = 0.5;
const NEAR_MISS_X = 0.85;
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
    p1: { world: { y: y1, z: index * SEG_LEN }, screen: { x: 0, y: 0, w: 0, scale: 0 } },
    p2: { world: { y: y2, z: (index + 1) * SEG_LEN }, screen: { x: 0, y: 0, w: 0, scale: 0 } },
  };
}

/** 生成一段 enter/hold/leave 的弯道或坡道，返回本段持有的弯道值 */
function addRoad(segs: Segment[], enter: number, hold: number, leave: number, curve: number, dy: number): number {
  const startY = segs.length ? segs[segs.length - 1].p2.world.y : 0;
  const endY = startY + dy * SEG_LEN;
  const total = enter + hold + leave;
  for (let n = 0; n < enter; n++)
    segs.push(makeSegment(segs.length, easeIn(0, curve, n / enter), easeInOut(startY, endY, n / total), easeInOut(startY, endY, (n + 1) / total)));
  for (let n = 0; n < hold; n++)
    segs.push(makeSegment(segs.length, curve, easeInOut(startY, endY, (enter + n) / total), easeInOut(startY, endY, (enter + n + 1) / total)));
  for (let n = 0; n < leave; n++)
    segs.push(makeSegment(segs.length, easeInOut(curve, 0, n / leave), easeInOut(startY, endY, (enter + hold + n) / total), easeInOut(startY, endY, (enter + hold + n + 1) / total)));
  return curve;
}

/** 弯道外侧立指示牌（右弯在左侧，箭头指向弯道方向） */
function addSigns(segs: Segment[], from: number, to: number, curve: number) {
  const side = curve > 0 ? -1 : 1;
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
    let curve = 0;
    if (r < 0.3) curve = addRoad(segs, 10, 20 + Math.random() * 30, 10, 0, rand(-4, 4));
    else if (r < 0.55) curve = addRoad(segs, 18, 26 + Math.random() * 26, 18, Math.random() < 0.5 ? 2.4 : -2.4, rand(-5, 5));
    else if (r < 0.78) curve = addRoad(segs, 22, 30 + Math.random() * 24, 22, Math.random() < 0.5 ? 4.2 : -4.2, rand(-6, 6));
    else curve = addRoad(segs, 26, 26 + Math.random() * 22, 26, Math.random() < 0.5 ? 6 : -6, rand(-3, 3));
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
  /** 车型：轿车 / 面包车 / 货车，比例与尾部细节各不相同 */
  kind: 'sedan' | 'van' | 'truck';
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

const CAR_COLORS = ['#c8393f', '#2f6bb0', '#c98a1e', '#2e8b57', '#7a4fc0', '#c9cdd8', '#c05a22', '#3f4652'];
const CAR_KINDS: Array<'sedan' | 'van' | 'truck'> = ['sedan', 'sedan', 'sedan', 'van', 'van', 'truck'];

function rollCar(): { color: string; kind: 'sedan' | 'van' | 'truck' } {
  return { color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)], kind: CAR_KINDS[Math.floor(Math.random() * CAR_KINDS.length)] };
}

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
  const { color, kind } = rollCar();
  return {
    offset: lane,
    z: aheadZ,
    speed: MAX_SPEED * carSpeedFrac(kind) * (1 + Math.min(0.35, w.meters / 6000)),
    color,
    kind,
    passed: false,
  };
}

/** 车型巡航速度区间（货车最慢，面包车次之） */
function carSpeedFrac(kind: Car['kind']): number {
  if (kind === 'truck') return rand(0.26, 0.4);
  if (kind === 'van') return rand(0.32, 0.48);
  return rand(CAR_SPEED_MIN, CAR_SPEED_MAX);
}

// ============ 物理 ============

function step(w: World, dt: number, tNow: number) {
  const playerSegment = findSegment(w, w.position + PLAYER_Z);
  const speedPercent = w.speed / MAX_SPEED;
  const dx = dt * STEER_RATE * Math.max(speedPercent, 0.3);

  // 转向输入
  if (w.steer < 0) w.playerX -= dx;
  else if (w.steer > 0) w.playerX += dx;
  // 弯道离心力：与速度平方同阶，满速急弯略强于转向，需提前靠内侧
  w.playerX -= dx * speedPercent * playerSegment.curve * CENTRIFUGAL;
  w.playerX = clamp(w.playerX, -PLAYER_X_MAX, PLAYER_X_MAX);

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
    w.cars.push(spawnCar(w, w.position + PLAYER_Z + rand(CAR_SPAWN_SEG, DRAW_DIST * 2.4) * SEG_LEN));
  }
  for (const c of w.cars) c.z += c.speed * dt;
  for (let i = w.cars.length - 1; i >= 0; i--) {
    const c = w.cars[i];
    if (c.z < w.position - SEG_LEN * 4 || c.z > w.position + w.trackLen * 0.75) {
      if (w.cars.length > want) w.cars.splice(i, 1);
      else {
        const next = rollCar();
        c.z = w.position + PLAYER_Z + rand(CAR_SPAWN_SEG, DRAW_DIST * 2.4) * SEG_LEN;
        c.offset = LANES[Math.floor(Math.random() * 3)] + rand(-0.06, 0.06);
        c.speed = MAX_SPEED * carSpeedFrac(next.kind) * (1 + Math.min(0.35, w.meters / 6000));
        c.color = next.color;
        c.kind = next.kind;
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

/** 黄昏配色（低饱和写实向） */
const COL = {
  sky0: '#0d1230',
  sky1: '#2b2354',
  sky2: '#8d3f63',
  sky3: '#e08a5a',
  grassA: '#376339',
  grassB: '#2f5832',
  rumbleA: '#eceef5',
  rumbleB: '#c23a46',
  roadA: '#3e3e4a',
  roadB: '#393944',
  crown: '#4a4a58',
  wear: '#32323c',
  lane: '#eef0f6',
  edge: '#d5d8e3',
  fog: '#a86f6b',
  rail: '#aeb6c4',
  railDark: '#585f70',
};

/** 星空与城市剪影固定生成，避免每帧抖动 */
const STARS = Array.from({ length: 56 }, () => ({
  x: Math.random() * RW,
  y: Math.random() * (HORIZON - 56),
  r: 0.35 + Math.random() * 0.8,
  p: Math.random() * 6.283,
}));
const CITY = Array.from({ length: 30 }, (_, i) => ({
  x: i * 21 + Math.random() * 7,
  w: 9 + Math.random() * 15,
  h: 7 + Math.random() * 27,
}));

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

/** 简易调明暗 */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(((n >> 16) & 255) * (1 + k), 0, 255);
  const g = clamp(((n >> 8) & 255) * (1 + k), 0, 255);
  const b = clamp((n & 255) * (1 + k), 0, 255);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/** 车身渐变缓存（渐变按局部坐标定义，绘制前统一 translate 到车底中心） */
const gradCache = new Map<string, CanvasGradient>();
function cachedGrad(key: string, make: () => CanvasGradient): CanvasGradient {
  let g = gradCache.get(key);
  if (!g) {
    g = make();
    if (gradCache.size > 240) gradCache.clear();
    gradCache.set(key, g);
  }
  return g;
}

/** 山脊线（返回顶点以便在峰顶补雪冠） */
function ridgePoints(baseY: number, amp: number, seed: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let x = -14; x <= RW + 14; x += 14) {
    const yy = baseY - Math.abs(Math.sin(x * 0.0165 + seed) * amp + Math.sin(x * 0.0413 + seed * 2.3) * amp * 0.4);
    pts.push([x, yy]);
  }
  return pts;
}

function drawRidge(ctx: CanvasRenderingContext2D, pts: Array<[number, number]>, baseY: number, color: string, snow: boolean) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], baseY + 80);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.lineTo(pts[pts.length - 1][0], baseY + 80);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  if (!snow) return;
  // 峰顶雪冠：局部最高点且足够高时补一小片
  ctx.fillStyle = 'rgba(226,232,248,0.72)';
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    if (y < pts[i - 1][1] && y < pts[i + 1][1] && baseY - y > 15) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 5.5, y + 6.5);
      ctx.lineTo(x + 2, y + 5);
      ctx.lineTo(x - 1.5, y + 7);
      ctx.lineTo(x - 5, y + 5.5);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/** 远景：星点、落日体积光、云带、城市剪影、三层山 */
function drawSky(ctx: CanvasRenderingContext2D, t: number, parallax: number) {
  const g = ctx.createLinearGradient(0, 0, 0, HORIZON + 12);
  g.addColorStop(0, COL.sky0);
  g.addColorStop(0.4, COL.sky1);
  g.addColorStop(0.76, COL.sky2);
  g.addColorStop(1, COL.sky3);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, RW, HORIZON + 12);

  for (const s of STARS) {
    const a = (0.2 + 0.5 * Math.abs(Math.sin(t * 0.8 + s.p))) * clamp(1 - s.y / (HORIZON - 46), 0.15, 1);
    ctx.fillStyle = `rgba(255,252,240,${a.toFixed(3)})`;
    ctx.fillRect(s.x, s.y, s.r, s.r);
  }

  const sunY = HORIZON - 58;
  const halo = ctx.createRadialGradient(CX, sunY, 5, CX, sunY, 158);
  halo.addColorStop(0, 'rgba(255,222,152,0.9)');
  halo.addColorStop(0.16, 'rgba(255,163,108,0.38)');
  halo.addColorStop(0.5, 'rgba(226,116,112,0.14)');
  halo.addColorStop(1, 'rgba(200,110,120,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(CX - 158, sunY - 158, 316, 200);
  const disc = ctx.createLinearGradient(0, sunY - 22, 0, sunY + 22);
  disc.addColorStop(0, '#fff3cc');
  disc.addColorStop(0.55, '#ffcd84');
  disc.addColorStop(1, '#ff8f57');
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(CX, sunY, 20, 0, Math.PI * 2);
  ctx.fill();

  for (let i = 0; i < 3; i++) {
    const cy = 28 + i * 26;
    const drift = (t * (1.4 + i * 0.8) + i * 130) % (RW + 260);
    for (const [ex, ey, rx, ry] of [
      [drift - 130, cy, 98 - i * 15, 5.5 + i * 2.2],
      [RW - drift + 110, cy + 10, 72 - i * 11, 4.2 + i * 1.7],
    ] as Array<[number, number, number, number]>) {
      const cg = ctx.createLinearGradient(0, ey - ry, 0, ey + ry);
      cg.addColorStop(0, `rgba(${246 - i * 22},${196 - i * 26},${196 - i * 18},${(0.2 + i * 0.05).toFixed(3)})`);
      cg.addColorStop(1, `rgba(${150 - i * 20},${92 - i * 12},${116 - i * 8},${(0.16 + i * 0.04).toFixed(3)})`);
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 城市剪影（在最远层山之前，随弯道视差）
  ctx.save();
  ctx.translate(-(((parallax * 34) % 630) + 630) % 630, 0);
  for (let rep = 0; rep < 2; rep++) {
    for (const b of CITY) {
      const x = b.x + rep * 630;
      if (x > RW + 16) continue;
      ctx.fillStyle = '#1e2440';
      ctx.fillRect(x, HORIZON - 3 - b.h, b.w, b.h + 3);
      if (b.h > 18) {
        ctx.fillStyle = 'rgba(255,198,128,0.5)';
        ctx.fillRect(x + 2, HORIZON - b.h + 4, 1.4, 1.4);
        ctx.fillRect(x + b.w - 3.4, HORIZON - b.h + 9, 1.4, 1.4);
      }
    }
  }
  ctx.restore();

  drawRidge(ctx, ridgePoints(HORIZON - 40, 30, 0.7 + parallax * 0.22), HORIZON - 40, '#33315e', true);
  drawRidge(ctx, ridgePoints(HORIZON - 22, 22, 2.4 + parallax * 0.34), HORIZON - 22, '#282548', false);
  drawRidge(ctx, ridgePoints(HORIZON - 6, 14, 4.1 + parallax * 0.5), HORIZON - 6, '#1f1d3a', false);
}

/** 路侧物：针叶树（分枝受光）、砾岩（带高光与投影）、弯道指示牌 */
function drawSprite(ctx: CanvasRenderingContext2D, sp: Sprite, x: number, y: number, scale: number) {
  const px = scale * (RW / 2);
  if (sp.type === 'tree') {
    const h = 950 * px;
    if (h < 2.5) return;
    const w = h * 0.4;
    // 落地影
    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    ctx.beginPath();
    ctx.ellipse(x + h * 0.06, y, h * 0.2, h * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
    // 树干
    const tg = ctx.createLinearGradient(x - h * 0.04, 0, x + h * 0.04, 0);
    tg.addColorStop(0, '#241609');
    tg.addColorStop(0.55, '#59391f');
    tg.addColorStop(1, '#2d1c0d');
    ctx.fillStyle = tg;
    ctx.fillRect(x - h * 0.032, y - h * 0.2, h * 0.064, h * 0.2);
    // 三层树冠：暗底 + 右侧受光
    for (let i = 0; i < 3; i++) {
      const ty = y - h * (0.17 + i * 0.26);
      const tw = w * (1 - i * 0.23);
      const th = h * 0.35;
      ctx.fillStyle = '#153520';
      ctx.beginPath();
      ctx.moveTo(x, ty - th);
      ctx.lineTo(x - tw, ty);
      ctx.lineTo(x + tw, ty);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = i === 2 ? '#2f6b3a' : '#22512c';
      ctx.beginPath();
      ctx.moveTo(x, ty - th);
      ctx.lineTo(x + tw * 0.86, ty);
      ctx.lineTo(x + tw * 0.12, ty);
      ctx.closePath();
      ctx.fill();
    }
    return;
  }
  if (sp.type === 'rock') {
    const h = 250 * px;
    if (h < 2) return;
    ctx.fillStyle = 'rgba(0,0,0,0.24)';
    ctx.beginPath();
    ctx.ellipse(x + h * 0.1, y, h * 0.66, h * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
    const rg = ctx.createLinearGradient(x - h * 0.5, y - h * 0.8, x + h * 0.5, y);
    rg.addColorStop(0, '#8b8fa0');
    rg.addColorStop(0.5, '#666b7d');
    rg.addColorStop(1, '#3e4252');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.moveTo(x - h * 0.62, y);
    ctx.lineTo(x - h * 0.34, y - h * 0.62);
    ctx.lineTo(x + h * 0.08, y - h * 0.78);
    ctx.lineTo(x + h * 0.5, y - h * 0.4);
    ctx.lineTo(x + h * 0.6, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,236,214,0.22)';
    ctx.beginPath();
    ctx.moveTo(x - h * 0.34, y - h * 0.62);
    ctx.lineTo(x + h * 0.08, y - h * 0.78);
    ctx.lineTo(x + h * 0.02, y - h * 0.5);
    ctx.closePath();
    ctx.fill();
    return;
  }
  // 弯道指示牌
  const h = 620 * px;
  if (h < 3.5) return;
  const pg = ctx.createLinearGradient(x - h * 0.05, 0, x + h * 0.05, 0);
  pg.addColorStop(0, '#2c3040');
  pg.addColorStop(0.5, '#7d8494');
  pg.addColorStop(1, '#3a3f4f');
  ctx.fillStyle = pg;
  ctx.fillRect(x - h * 0.035, y - h * 0.62, h * 0.07, h * 0.62);
  ctx.save();
  ctx.translate(x, y - h * 0.74);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.roundRect(-h * 0.31, -h * 0.2, h * 0.62, h * 0.42, h * 0.06);
  ctx.fill();
  const bg = ctx.createLinearGradient(0, -h * 0.24, 0, h * 0.22);
  bg.addColorStop(0, '#ffe08a');
  bg.addColorStop(1, '#e0a63c');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(-h * 0.32, -h * 0.24, h * 0.64, h * 0.44, h * 0.06);
  ctx.fill();
  ctx.strokeStyle = '#20233a';
  ctx.lineWidth = Math.max(1, h * 0.026);
  ctx.stroke();
  ctx.fillStyle = '#20233a';
  const dir = sp.offset > 0 ? -1 : 1; // 牌立在弯道外侧，箭头指向弯道方向
  for (let i = -1; i <= 1; i++) {
    const bx = i * h * 0.17;
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

/** 车轮（含轮拱阴影与高光） */
function tire(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = '#0d0e14';
  ctx.beginPath();
  ctx.roundRect(x, y - h, w, h, w * 0.3);
  ctx.fill();
  ctx.fillStyle = 'rgba(150,158,180,0.35)';
  ctx.beginPath();
  ctx.roundRect(x + w * 0.24, y - h * 0.72, w * 0.5, h * 0.24, w * 0.12);
  ctx.fill();
}

/** 尾灯（含灯罩辉光） */
function tailLight(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, lit: number) {
  const g = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) * 1.5);
  g.addColorStop(0, `rgba(255,${(70 + lit * 90) | 0},60,${(0.9 + lit * 0.1).toFixed(2)})`);
  g.addColorStop(0.45, `rgba(230,40,50,${(0.55 + lit * 0.3).toFixed(2)})`);
  g.addColorStop(1, 'rgba(200,30,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - w, y - h, w * 3, h * 3);
  ctx.fillStyle = lit > 0.4 ? '#ffdede' : '#e8484f';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.35);
  ctx.fill();
}

/** 车流通用的落地软阴影 */
function carShadow(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.85);
  g.addColorStop(0, 'rgba(0,0,0,0.5)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.22)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.82, h * 0.16 + 1, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** 车流尾部建模：轿车 / 面包车 / 货车三种轮廓 */
function drawTrafficCar(ctx: CanvasRenderingContext2D, cx: number, baseY: number, wPx: number, c: Car) {
  if (wPx < 4) return;
  const w = wPx;
  const tall = c.kind === 'truck' ? 1.5 : c.kind === 'van' ? 1.02 : 0.72;
  const h = w * tall;
  ctx.save();
  ctx.translate(cx, baseY);
  carShadow(ctx, w, h);
  // 轮胎
  const tw = w * 0.15;
  tire(ctx, -w * 0.5, 0, tw, h * (c.kind === 'truck' ? 0.2 : 0.17));
  tire(ctx, w * 0.5 - tw, 0, tw, h * (c.kind === 'truck' ? 0.2 : 0.17));
  if (c.kind === 'truck') {
    tire(ctx, -w * 0.36, 0, tw, h * 0.18);
    tire(ctx, w * 0.36 - tw, 0, tw, h * 0.18);
  }
  const body = cachedGrad(`tb${c.color}${c.kind}${Math.round(w)}`, () => {
    const g = ctx.createLinearGradient(0, -h, 0, 0);
    g.addColorStop(0, shade(c.color, c.kind === 'truck' ? 0.16 : 0.22));
    g.addColorStop(0.55, c.color);
    g.addColorStop(1, shade(c.color, -0.5));
    return g;
  });
  ctx.fillStyle = c.kind === 'truck' ? '#b9bec9' : body;
  ctx.beginPath();
  if (c.kind === 'sedan') {
    ctx.roundRect(-w * 0.47, -h * 0.62, w * 0.94, h * 0.56, w * 0.1);
    ctx.fill();
    // 座舱
    ctx.beginPath();
    ctx.moveTo(-w * 0.34, -h * 0.6);
    ctx.lineTo(-w * 0.24, -h * 0.95);
    ctx.lineTo(w * 0.24, -h * 0.95);
    ctx.lineTo(w * 0.34, -h * 0.6);
    ctx.closePath();
    ctx.fill();
    // 后窗
    const gg = ctx.createLinearGradient(0, -h * 0.95, 0, -h * 0.62);
    gg.addColorStop(0, 'rgba(120,150,190,0.55)');
    gg.addColorStop(1, 'rgba(12,16,32,0.95)');
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.moveTo(-w * 0.27, -h * 0.63);
    ctx.lineTo(-w * 0.2, -h * 0.9);
    ctx.lineTo(w * 0.2, -h * 0.9);
    ctx.lineTo(w * 0.27, -h * 0.63);
    ctx.closePath();
    ctx.fill();
  } else {
    // 面包车 / 货车：高箱体
    ctx.roundRect(-w * 0.48, -h * (c.kind === 'truck' ? 0.98 : 0.95), w * 0.96, h * (c.kind === 'truck' ? 0.9 : 0.88), w * (c.kind === 'truck' ? 0.05 : 0.12));
    ctx.fill();
    ctx.strokeStyle = 'rgba(30,34,48,0.4)';
    ctx.lineWidth = Math.max(0.6, w * 0.02);
    if (c.kind === 'truck') {
      // 货厢横筋
      for (let i = 1; i <= 4; i++) {
        const yy = -h * (0.98 - i * 0.18);
        ctx.beginPath();
        ctx.moveTo(-w * 0.45, yy);
        ctx.lineTo(w * 0.45, yy);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(0, -h * 0.96);
      ctx.lineTo(0, -h * 0.1);
      ctx.stroke();
    } else {
      // 对开门缝 + 后窗
      ctx.beginPath();
      ctx.moveTo(0, -h * 0.9);
      ctx.lineTo(0, -h * 0.12);
      ctx.stroke();
      ctx.fillStyle = 'rgba(14,18,34,0.9)';
      ctx.beginPath();
      ctx.roundRect(-w * 0.36, -h * 0.88, w * 0.72, h * 0.26, w * 0.04);
      ctx.fill();
    }
  }
  // 侧面暗部与顶部高光
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(-w * 0.48, -h * 0.2, w * 0.1, h * 0.14);
  ctx.fillRect(w * 0.38, -h * 0.2, w * 0.1, h * 0.14);
  ctx.fillStyle = 'rgba(255,240,220,0.14)';
  ctx.fillRect(-w * 0.4, -h * (c.kind === 'sedan' ? 0.61 : 0.95), w * 0.8, Math.max(0.7, h * 0.02));
  // 保险杠
  ctx.fillStyle = 'rgba(24,26,38,0.85)';
  ctx.beginPath();
  ctx.roundRect(-w * 0.48, -h * 0.16, w * 0.96, h * 0.1, w * 0.02);
  ctx.fill();
  // 尾灯
  const lit = 0.55;
  tailLight(ctx, -w * 0.44, -h * 0.3, w * 0.15, h * 0.09, lit);
  tailLight(ctx, w * 0.29, -h * 0.3, w * 0.15, h * 0.09, lit);
  // 车牌
  ctx.fillStyle = 'rgba(226,228,236,0.85)';
  ctx.fillRect(-w * 0.09, -h * 0.24, w * 0.18, h * 0.06);
  ctx.restore();
}

/** 玩家车：低趴跑车尾部（尾翼/扩散器/双出排气/刹车灯/高光） */
function drawPlayerCar(ctx: CanvasRenderingContext2D, cx: number, baseY: number, wPx: number, o: { tilt: number; brake: boolean; boost: number; bob: number; color: string }) {
  const w = wPx;
  const h = w * 0.5;
  ctx.save();
  ctx.translate(cx, baseY + o.bob);
  ctx.rotate(o.tilt * 0.05);
  carShadow(ctx, w, h * 1.4);
  // 轮胎（转向时前后错开一点）
  const tw = w * 0.19;
  const th = h * 0.42;
  tire(ctx, -w * 0.52 + o.tilt * w * 0.02, 0, tw, th);
  tire(ctx, w * 0.33 + o.tilt * w * 0.02, 0, tw, th);
  const body = cachedGrad(`pb${o.color}${Math.round(w / 4)}`, () => {
    const g = ctx.createLinearGradient(0, -h * 1.15, 0, 0);
    g.addColorStop(0, shade(o.color, 0.42));
    g.addColorStop(0.34, o.color);
    g.addColorStop(0.72, shade(o.color, -0.28));
    g.addColorStop(1, shade(o.color, -0.62));
    return g;
  });
  // 主车身
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-w * 0.5, -h * 0.14);
  ctx.quadraticCurveTo(-w * 0.52, -h * 0.62, -w * 0.3, -h * 0.68);
  ctx.lineTo(w * 0.3, -h * 0.68);
  ctx.quadraticCurveTo(w * 0.52, -h * 0.62, w * 0.5, -h * 0.14);
  ctx.closePath();
  ctx.fill();
  // 座舱与后窗
  ctx.fillStyle = shade(o.color, -0.42);
  ctx.beginPath();
  ctx.moveTo(-w * 0.31, -h * 0.66);
  ctx.lineTo(-w * 0.21, -h * 1.0);
  ctx.lineTo(w * 0.21, -h * 1.0);
  ctx.lineTo(w * 0.31, -h * 0.66);
  ctx.closePath();
  ctx.fill();
  const glass = ctx.createLinearGradient(0, -h * 1.0, 0, -h * 0.68);
  glass.addColorStop(0, 'rgba(150,178,214,0.6)');
  glass.addColorStop(0.5, 'rgba(24,30,54,0.95)');
  glass.addColorStop(1, 'rgba(10,12,26,0.96)');
  ctx.fillStyle = glass;
  ctx.beginPath();
  ctx.moveTo(-w * 0.25, -h * 0.7);
  ctx.lineTo(-w * 0.17, -h * 0.96);
  ctx.lineTo(w * 0.17, -h * 0.96);
  ctx.lineTo(w * 0.25, -h * 0.7);
  ctx.closePath();
  ctx.fill();
  // 防滚架两道竖杠
  ctx.strokeStyle = 'rgba(200,206,224,0.28)';
  ctx.lineWidth = Math.max(0.8, w * 0.018);
  ctx.beginPath();
  ctx.moveTo(-w * 0.08, -h * 0.95);
  ctx.lineTo(-w * 0.09, -h * 0.71);
  ctx.moveTo(w * 0.08, -h * 0.95);
  ctx.lineTo(w * 0.09, -h * 0.71);
  ctx.stroke();
  // 尾部贯穿式刹车灯
  const lit = o.brake ? 1 : 0.42;
  ctx.fillStyle = `rgba(${(190 + lit * 65) | 0},${(30 + lit * 60) | 0},44,0.95)`;
  ctx.beginPath();
  ctx.roundRect(-w * 0.42, -h * 0.5, w * 0.84, h * 0.11, h * 0.05);
  ctx.fill();
  if (lit > 0.6) {
    const glow = ctx.createRadialGradient(0, -h * 0.45, 0, 0, -h * 0.45, w * 0.6);
    glow.addColorStop(0, 'rgba(255,80,70,0.5)');
    glow.addColorStop(1, 'rgba(255,60,60,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(-w * 0.62, -h * 0.85, w * 1.24, h * 0.8);
  }
  // 扩散器与双出排气
  ctx.fillStyle = '#14151d';
  ctx.beginPath();
  ctx.roundRect(-w * 0.44, -h * 0.24, w * 0.88, h * 0.2, h * 0.03);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,128,150,0.5)';
  ctx.lineWidth = Math.max(0.6, w * 0.012);
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(i * w * 0.11, -h * 0.22);
    ctx.lineTo(i * w * 0.11, -h * 0.06);
    ctx.stroke();
  }
  ctx.fillStyle = '#0a0b10';
  ctx.beginPath();
  ctx.ellipse(-w * 0.2, -h * 0.1, w * 0.055, h * 0.05, 0, 0, Math.PI * 2);
  ctx.ellipse(w * 0.2, -h * 0.1, w * 0.055, h * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
  if (o.boost > 0) {
    const f = 0.5 + Math.random() * 0.5;
    for (const ex of [-w * 0.2, w * 0.2]) {
      const fg = ctx.createRadialGradient(ex, -h * 0.1, 0, ex, -h * 0.1, w * 0.12 * f);
      fg.addColorStop(0, 'rgba(255,240,200,0.95)');
      fg.addColorStop(0.4, 'rgba(255,150,70,0.6)');
      fg.addColorStop(1, 'rgba(255,90,40,0)');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(ex, -h * 0.1, w * 0.12 * f, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 尾翼（含端板与支架）
  ctx.fillStyle = shade(o.color, -0.66);
  ctx.fillRect(-w * 0.3, -h * 1.06, w * 0.05, h * 0.16);
  ctx.fillRect(w * 0.25, -h * 1.06, w * 0.05, h * 0.16);
  const wg = ctx.createLinearGradient(0, -h * 1.16, 0, -h * 1.04);
  wg.addColorStop(0, shade(o.color, 0.2));
  wg.addColorStop(1, shade(o.color, -0.6));
  ctx.fillStyle = wg;
  ctx.beginPath();
  ctx.roundRect(-w * 0.46, -h * 1.16, w * 0.92, h * 0.1, h * 0.02);
  ctx.fill();
  ctx.fillStyle = shade(o.color, -0.72);
  ctx.fillRect(-w * 0.49, -h * 1.2, w * 0.05, h * 0.2);
  ctx.fillRect(w * 0.44, -h * 1.2, w * 0.05, h * 0.2);
  // 车身高光与轮拱阴影
  ctx.fillStyle = 'rgba(255,236,210,0.2)';
  ctx.beginPath();
  ctx.roundRect(-w * 0.34, -h * 0.66, w * 0.68, h * 0.05, h * 0.02);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  for (const ax of [-w * 0.42, w * 0.24]) {
    ctx.beginPath();
    ctx.ellipse(ax + w * 0.09, -h * 0.2, w * 0.13, h * 0.14, 0, Math.PI, 0);
    ctx.fill();
  }
  ctx.restore();
}

/** 护栏点：路面侧向偏移 off 倍路宽、离地 hgt 世界单位的屏幕坐标 */
function railPt(p: Pt, side: number, off: number, hgt: number): readonly [number, number] {
  return [p.screen.x + side * off * p.screen.w, p.screen.y - hgt * p.screen.scale * (RW / 2)] as const;
}

const RAIL_H = 430;

function render(ctx: CanvasRenderingContext2D, w: World, t: number) {
  ctx.clearRect(0, 0, RW, RH);
  /** 相机位置取赛道模：多圈后仍与段号同域，否则 dz 会变成负数被钳成近景 */
  const posMod = ((w.position % w.trackLen) + w.trackLen) % w.trackLen;
  const playerSegment = findSegment(w, w.position + PLAYER_Z);
  const playerPercent = ((posMod + PLAYER_Z) % SEG_LEN) / SEG_LEN;
  const playerY = lerp(playerSegment.p1.world.y, playerSegment.p2.world.y, playerPercent);
  const baseIndex = Math.floor(posMod / SEG_LEN) % w.segs.length;
  const speedPct = clamp(w.speed / MAX_SPEED, 0, 1.4);
  const offroad = Math.abs(w.playerX) > 1;

  // 相机抖动：出路面更明显，高速带轻微颠簸
  const shake = (offroad ? 1.7 : 0) + speedPct * 0.7;
  ctx.save();
  if (shake > 0.05) {
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake * 0.7);
    ctx.rotate((Math.random() - 0.5) * shake * 0.0016);
  }

  drawSky(ctx, t, w.position * 0.0004 + playerSegment.curve * 0.2);

  // 第一遍：由近及远投影并记录（供第二遍由远及近绘制）
  let x = 0;
  let dx = -(w.segs[baseIndex].curve * ((posMod % SEG_LEN) / SEG_LEN));
  for (let n = 0; n < DRAW_DIST; n++) {
    const seg = w.segs[(baseIndex + n) % w.segs.length];
    const looped = seg.index < baseIndex;
    const camZ = posMod - (looped ? w.trackLen : 0);
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

    const alt = Math.floor(seg.index / 3) % 2 === 0;
    const fogA = Math.pow(n / DRAW_DIST, 2.2) * 0.72;
    const bandH = p1.y - p2.y + 1;
    // 草地（全宽横带，路面随后叠加）
    ctx.fillStyle = alt ? COL.grassA : COL.grassB;
    ctx.fillRect(0, p2.y, RW, bandH);
    // 草地受光带（靠路面一侧稍亮，模拟路肩反光）
    if (p1.w > 24) {
      ctx.fillStyle = 'rgba(255,214,150,0.05)';
      poly(ctx, p1.x, p1.y, p2.x, p2.y, p1.w * 1.5, p2.w * 1.5, 'rgba(255,214,150,0.05)');
    }
    if (fogA > 0.02) {
      ctx.fillStyle = rgba(COL.fog, fogA);
      ctx.fillRect(0, p2.y, RW, bandH);
    }
    // 路缘（红白相间）
    const r1 = Math.max(1, p1.w * 0.11);
    const r2 = Math.max(1, p2.w * 0.11);
    const rumble = Math.floor(seg.index / 2) % 2 === 0;
    poly(ctx, p1.x, p1.y, p2.x, p2.y, p1.w + r1, p2.w + r2, rumble ? COL.rumbleA : COL.rumbleB);
    // 路面
    poly(ctx, p1.x, p1.y, p2.x, p2.y, p1.w, p2.w, alt ? COL.roadA : COL.roadB);
    if (p1.w > 26) {
      // 路拱受光 + 两条轮辙暗带
      poly(ctx, p1.x, p1.y, p2.x, p2.y, p1.w * 0.3, p2.w * 0.3, COL.crown);
      for (const t2 of [-0.62, 0.62]) {
        poly(ctx, p1.x + p1.w * t2, p1.y, p2.x + p2.w * t2, p2.y, p1.w * 0.13, p2.w * 0.13, COL.wear);
      }
      // 沥青补丁与检查井
      if (seg.index % 41 === 7) {
        poly(ctx, p1.x - p1.w * 0.3, p1.y, p2.x - p2.w * 0.3, p2.y, p1.w * 0.2, p2.w * 0.2, 'rgba(22,22,28,0.5)');
      }
      if (seg.index % 67 === 13) {
        ctx.fillStyle = 'rgba(18,18,24,0.62)';
        ctx.beginPath();
        ctx.ellipse(p1.x + p1.w * 0.2, p1.y, p1.w * 0.075, Math.max(1, p1.w * 0.026), 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 边线（实线）与车道虚线
    if (p1.w > 18) {
      const ew1 = Math.max(0.8, p1.w * 0.022);
      const ew2 = Math.max(0.8, p2.w * 0.022);
      for (const e of [-0.93, 0.93]) {
        poly(ctx, p1.x + p1.w * e, p1.y, p2.x + p2.w * e, p2.y, ew1, ew2, rgba(COL.edge, 0.82));
      }
      if (Math.floor(seg.index / 3) % 2 === 0) {
        const lw1 = Math.max(1, p1.w * 0.018);
        const lw2 = Math.max(1, p2.w * 0.018);
        for (const lane of [-1 / 3, 1 / 3]) {
          poly(ctx, p1.x + p1.w * lane, p1.y, p2.x + p2.w * lane, p2.y, lw1, lw2, COL.lane);
        }
      }
    }
    if (fogA > 0.02) poly(ctx, p1.x, p1.y, p2.x, p2.y, p1.w + r1, p2.w + r2, rgba(COL.fog, fogA * 0.9));

    // 护栏（两侧，横梁沿路面延伸，立柱隔段设置）
    if (n > 1) {
      for (const side of [-1, 1]) {
        const [ax, ay] = railPt(seg.p1, side, 1.16, RAIL_H);
        const [bx, by] = railPt(seg.p2, side, 1.16, RAIL_H);
        if ((ax < -80 && bx < -80) || (ax > RW + 80 && bx > RW + 80)) continue;
        const th = Math.max(0.7, seg.p1.screen.scale * (RW / 2) * 110);
        ctx.strokeStyle = COL.railDark;
        ctx.lineWidth = th * 1.8;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.strokeStyle = rgba(COL.rail, 0.92);
        ctx.lineWidth = th * 0.62;
        ctx.beginPath();
        ctx.moveTo(ax, ay - th * 0.5);
        ctx.lineTo(bx, by - th * 0.5);
        ctx.stroke();
        if (seg.index % 3 === 0) {
          ctx.strokeStyle = 'rgba(40,44,56,0.9)';
          ctx.lineWidth = Math.max(0.7, th * 0.7);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(ax, seg.p1.screen.y);
          ctx.stroke();
        }
      }
    }

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
        const cw = lerp(p1.w, p2.w, cz) * (c.kind === 'truck' ? 0.44 : c.kind === 'van' ? 0.48 : 0.46);
        drawTrafficCar(ctx, cx, cy, cw, c);
      }
    }
  }

  // 玩家车：投影到所在段的实际路面位置（横向随 playerX，撞后闪烁）
  const blink = w.invincible > 0 && Math.floor(t * 10) % 2 === 0;
  if (!blink) {
    const roadX = lerp(playerSegment.p1.screen.x, playerSegment.p2.screen.x, playerPercent);
    const roadY = lerp(playerSegment.p1.screen.y, playerSegment.p2.screen.y, playerPercent);
    const roadW = lerp(playerSegment.p1.screen.w, playerSegment.p2.screen.w, playerPercent);
    drawPlayerCar(ctx, roadX + w.playerX * roadW, Math.min(roadY, RH - 6), roadW * 0.62, {
      tilt: w.tilt,
      brake: w.brake,
      boost: w.boostT > 0 ? 1 : 0,
      bob: Math.sin(t * 26) * (0.4 + speedPct * 1.3) + (offroad ? Math.sin(t * 44) * 1.7 : 0),
      color: '#7c5cff',
    });
  }

  // 结束相机抖动，后处理与 HUD 走屏幕坐标
  ctx.restore();

  // 暗角
  const vg = ctx.createRadialGradient(CX, RH * 0.56, RH * 0.34, CX, RH * 0.56, RH * 0.98);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(4,5,14,0.52)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, RW, RH);

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

  // 径向速度线：冲刺时最强，接近极速时渐显
  const streak = clamp((w.boostT > 0 ? 0.85 : 0) + (speedPct - 0.74) * 1.6, 0, 1);
  if (streak > 0.04) {
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${(0.1 + streak * 0.22).toFixed(3)})`;
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + t * 1.7;
      const r0 = RW * (0.34 + ((i * 37) % 11) * 0.012);
      const x0 = CX + Math.cos(a) * r0;
      const y0 = RH * 0.55 + Math.sin(a) * r0 * 0.66;
      const len = 18 + streak * 34;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + Math.cos(a) * len, y0 + Math.sin(a) * len * 0.66);
      ctx.stroke();
    }
    ctx.restore();
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

  // 触屏按住式操控
  const touchSteer = useCallback((dir: -1 | 1, on: boolean) => {
    const w = worldRef.current;
    if (on) w.steer = dir;
    else if (w.steer === dir) w.steer = 0;
  }, []);
  const touchHold = useCallback((key: 'accel' | 'brake', on: boolean) => {
    worldRef.current[key] = on;
  }, []);

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
                触屏：按住 ◀ ▶ 转向，⛽ 油门 / 🛑 刹车
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
          <TouchButtons
            items={[
              { label: '◀', onPress: () => touchSteer(-1, true), onRelease: () => touchSteer(-1, false) },
              { label: '▶', onPress: () => touchSteer(1, true), onRelease: () => touchSteer(1, false) },
            ]}
          />
          <div className="rc3d-actions">
            <button className="btn btn-ghost" onClick={togglePause} disabled={status !== 'playing' && status !== 'paused'}>
              {status === 'paused' ? '▶ 继续' : '⏸ 暂停'}
            </button>
            <button className="btn btn-ghost" onClick={start}>
              🔄 重新开始
            </button>
          </div>
          <TouchButtons
            items={[
              { label: '🛑 刹车', onPress: () => touchHold('brake', true), onRelease: () => touchHold('brake', false) },
              { label: '⛽ 油门', primary: true, onPress: () => touchHold('accel', true), onRelease: () => touchHold('accel', false) },
            ]}
          />
        </div>
        <p className="hint">
          弯道上会被离心力向外甩，提前靠内侧；冲出路面会大幅减速；近失超车有 {NEAR_MISS_SCORE} 分奖励和短暂提速。
        </p>
      </div>
    </GameShell>
  );
}
