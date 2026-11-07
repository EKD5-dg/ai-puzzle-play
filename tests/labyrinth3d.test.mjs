import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BALL_R, HOLE_R, LEVELS, LEVEL_DEFS, SIZE, WALL_H, cellAt, cellCenter, parseLevel, terrainAt,
} from '../src/games/labyrinth3d/levels.ts';
import { ICE, SAND, WALL } from '../src/games/labyrinth3d/types.ts';
import {
  CAPTURE, DAMPING, FALL_TIME, G, GEM_VALUE, HINT_COST, ICE_MUL, LIVES, MAX_SPEED, MAX_TILT,
  RESTITUTION, SAND_MUL, SUBSTEP, TILT_RATE, advance, createRun, dampingAt, drainEvents,
  isFalling, isTerminal, levelScore, planeGravity, respawn, starsFor, sweeperEnds, tiltTarget, useHint,
} from '../src/games/labyrinth3d/physics.ts';
import {
  autoPlay, autoSolve, findRoute, inputForAccel, passable, routeLength, simplify,
} from '../src/games/labyrinth3d/route.ts';
import {
  controlTilt, createControl, isTiltKey, keyTilt, pointerTilt, reduceControl,
} from '../src/games/labyrinth3d/input.ts';
import { boardWorld, drawScene, makeCamera, project } from '../src/games/labyrinth3d/render3d.ts';

const L1 = LEVELS[0];
const DT = 1 / 60;
const ZERO = { x: 0, z: 0 };

function pump(level, run, input, seconds) {
  for (let i = 0; i < Math.round(seconds / DT); i++) advance(level, run, input, DT);
}

/** 把球摆到指定位置并清掉重生豁免，方便定点验判定 */
function place(level, x, z) {
  const run = createRun(level);
  run.ball.x = x;
  run.ball.z = z;
  run.respawn = { x, z };
  run.grace = 0;
  return run;
}

function trapOf(level) {
  return level.holes.find((h) => !h.goal);
}

// ============ 重力与倾斜 ============

test('重力投影：向右倾 → +x 加速，向近端倾 → +z 加速', () => {
  const right = planeGravity(0, -MAX_TILT);
  assert.ok(right.ax > 0, 'input.x=+1 对应 roll 为负，ax 必须为正');
  assert.equal(right.az, 0);
  const down = planeGravity(MAX_TILT, 0);
  assert.ok(down.az > 0);
  assert.equal(Math.abs(down.ax), 0);
  assert.ok(Math.abs(right.ax - G * Math.sin(MAX_TILT)) < 1e-12);
});

test('重力投影用的是精确旋转而非小角度近似', () => {
  const p = 0.3;
  const r = -0.2;
  const g = planeGravity(p, r);
  assert.ok(Math.abs(g.ax - -G * Math.sin(r)) < 1e-12);
  assert.ok(Math.abs(g.az - G * Math.sin(p) * Math.cos(r)) < 1e-12);
  // 小角度近似会漏掉 cos(roll) 这一项，两者必须真的不同
  assert.ok(Math.abs(g.az - G * Math.sin(p)) > 1e-3);
});

test('tiltTarget 夹到 ±1 并映射到正确的倾角符号', () => {
  assert.deepEqual(tiltTarget({ x: 5, z: -9 }), { pitch: -MAX_TILT, roll: -MAX_TILT });
  assert.deepEqual(tiltTarget({ x: 1, z: 1 }), { pitch: MAX_TILT, roll: -MAX_TILT });
});

test('倾斜有速率上限，不会瞬间打满', () => {
  const run = createRun(L1);
  run.grace = 0;
  advance(L1, run, { x: 1, z: 1 }, SUBSTEP);
  assert.ok(Math.abs(run.roll) <= TILT_RATE * SUBSTEP + 1e-12);
  pump(L1, run, { x: 1, z: 1 }, 1);
  assert.ok(Math.abs(run.roll + MAX_TILT) < 1e-9, '一秒后应当打满并夹住');
  assert.ok(Math.abs(run.pitch - MAX_TILT) < 1e-9);
});

test('重生豁免期内输入被冻结，盘面保持水平', () => {
  const run = createRun(L1);
  assert.ok(run.grace > 0);
  pump(L1, run, { x: 1, z: 1 }, run.grace * 0.6);
  assert.equal(run.pitch, 0);
  assert.equal(run.roll, 0);
  assert.equal(run.ball.vx, 0);
});

// ============ 阻尼与地形 ============

test('冰面与沙地真的改变阻尼，且方向正确', () => {
  const iceCell = (() => {
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        const c = cellCenter(col, row);
        if (terrainAt(LEVELS[2], c.x, c.z) === ICE) return c;
      }
    }
    throw new Error('第三关应当有冰面');
  })();
  const sandCell = (() => {
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        const c = cellCenter(col, row);
        if (terrainAt(LEVELS[3], c.x, c.z) === SAND) return c;
      }
    }
    throw new Error('第四关应当有沙地');
  })();
  assert.ok(Math.abs(dampingAt(LEVELS[2], iceCell.x, iceCell.z) - DAMPING * ICE_MUL) < 1e-12);
  assert.ok(Math.abs(dampingAt(LEVELS[3], sandCell.x, sandCell.z) - DAMPING * SAND_MUL) < 1e-12);
  assert.ok(dampingAt(LEVELS[2], iceCell.x, iceCell.z) < DAMPING);
  assert.ok(dampingAt(LEVELS[3], sandCell.x, sandCell.z) > DAMPING);
});

test('同一初速度下冰面滑得最远、沙地最快停下（零倾斜滑行，隔离阻尼）', () => {
  const corridor = (ch) => parseLevel({
    id: `probe-${ch}`, name: 'probe', subtitle: '', par: 30, sweepers: [],
    rows: [
      '##########',
      '#........#',
      '#........#',
      '#........#',
      `#S${ch.repeat(6)}G#`,
      '#........#',
      '#........#',
      '#........#',
      '#........#',
      '##########',
    ],
  });
  const coast = (ch) => {
    const level = corridor(ch);
    const run = place(level, level.start.x, level.start.z);
    run.ball.vx = 2;
    pump(level, run, ZERO, 1);
    return { v: run.ball.vx, dx: run.ball.x - level.start.x };
  };
  const ice = coast('~');
  const floor = coast('.');
  const sand = coast(':');
  assert.ok(ice.v > floor.v * 1.5, `冰面 ${ice.v} 应当远快于地面 ${floor.v}`);
  assert.ok(sand.v < floor.v * 0.6, `沙地 ${sand.v} 应当远慢于地面 ${floor.v}`);
  assert.ok(ice.dx > floor.dx && floor.dx > sand.dx, '滑行距离应当同序');
  assert.ok(ice.dx < 7, '球不该撞到走廊尽头的墙');
});

// ============ 碰撞 ============

test('墙：四个方向都推不出穿透，且法向速度按恢复系数反弹', () => {
  const wall = cellCenter(3, 2);
  assert.equal(terrainAt(L1, wall.x, wall.z), WALL);
  for (const [dx, dz, ix, iz] of [[-1, 0, 1, 0], [1, 0, -1, 0], [0, -1, 0, 1], [0, 1, 0, -1]]) {
    const run = place(L1, wall.x + dx * 1.1, wall.z + dz * 1.1);
    run.ball.vx = ix * 4;
    run.ball.vz = iz * 4;
    let minDist = Infinity;
    let bounced = false;
    for (let i = 0; i < 90; i++) {
      advance(L1, run, ZERO, DT);
      const nx = Math.max(wall.x - 0.5, Math.min(wall.x + 0.5, run.ball.x));
      const nz = Math.max(wall.z - 0.5, Math.min(wall.z + 0.5, run.ball.z));
      minDist = Math.min(minDist, Math.hypot(run.ball.x - nx, run.ball.z - nz));
      if (run.ball.vx * ix < 0 || run.ball.vz * iz < 0) bounced = true;
    }
    assert.ok(minDist >= BALL_R - 1e-6, `方向 ${dx},${dz} 穿透了：${minDist}`);
    assert.ok(bounced, `方向 ${dx},${dz} 没有反弹`);
  }
});

test('极限速度下不隧穿墙体', () => {
  const wall = cellCenter(3, 2);
  const run = place(L1, wall.x - 2.2, wall.z);
  run.ball.vx = MAX_SPEED;
  for (let i = 0; i < 60; i++) {
    advance(L1, run, ZERO, DT);
    assert.ok(run.ball.x <= wall.x - 0.5 + BALL_R + 1e-6, `第 ${i} 帧穿墙到 ${run.ball.x}`);
  }
  assert.ok(MAX_SPEED * SUBSTEP < 0.05, '单子步位移必须远小于墙厚');
});

test(' restitution 常数确实生效：撞墙后法向速度约为入射的 0.34 倍', () => {
  const wall = cellCenter(3, 2);
  const run = place(L1, wall.x - 0.5 - BALL_R - 0.005, wall.z);
  run.ball.vx = 3;
  advance(L1, run, ZERO, SUBSTEP * 2);
  const ratio = -run.ball.vx / 3;
  assert.ok(Math.abs(ratio - RESTITUTION) < 0.06, `反弹比 ${ratio} 应接近 ${RESTITUTION}`);
});

// ============ 洞 ============

test('洞：球心进捕获阈值才掉，碾过边缘安全', () => {
  const trap = trapOf(L1);
  const inside = place(L1, trap.x - HOLE_R * CAPTURE * 0.5, trap.z);
  advance(L1, inside, ZERO, DT);
  assert.ok(isFalling(inside), '阈值内必须掉下去');
  const rim = place(L1, trap.x - 2, trap.z + HOLE_R * CAPTURE + 0.07);
  pump(L1, rim, { x: 1, z: 0 }, 4);
  assert.equal(rim.falls, 0, '碾过洞缘不该掉');
});

test('掉陷阱洞：扣一条命、回到起点、有掉落动画时长', () => {
  const trap = trapOf(L1);
  const run = place(L1, trap.x, trap.z);
  run.respawn = { x: L1.start.x, z: L1.start.z };
  advance(L1, run, ZERO, DT);
  assert.ok(isFalling(run));
  const events = drainEvents(run);
  assert.deepEqual(events.map((e) => e.type), ['fall']);
  assert.equal(events[0].goal, false);
  pump(L1, run, ZERO, FALL_TIME + 0.05);
  assert.equal(run.lives, LIVES - 1);
  assert.equal(run.falls, 1);
  assert.equal(run.phase, 'rolling');
  assert.ok(Math.hypot(run.ball.x - L1.start.x, run.ball.z - L1.start.z) < 1e-9);
  assert.ok(run.grace > 0, '重生后要有豁免');
});

test('掉进终点洞 → cleared，不扣命', () => {
  const run = place(L1, L1.goal.x, L1.goal.z);
  pump(L1, run, ZERO, FALL_TIME + 0.1);
  assert.equal(run.phase, 'cleared');
  assert.equal(run.lives, LIVES);
  assert.equal(run.falls, 0);
  assert.ok(drainEvents(run).some((e) => e.type === 'cleared'));
  const before = run.elapsed;
  pump(L1, run, { x: 1, z: 1 }, 1);
  assert.equal(run.elapsed, before, '终局后计时必须停');
});

test('三条命耗尽 → over 并广播事件', () => {
  const trap = trapOf(L1);
  const run = createRun(L1);
  run.respawn = { x: trap.x, z: trap.z };
  run.ball.x = trap.x;
  run.ball.z = trap.z;
  run.grace = 0;
  for (let i = 0; i < 4000 && !isTerminal(run); i++) advance(L1, run, ZERO, DT);
  assert.equal(run.phase, 'over');
  assert.equal(run.lives, 0);
  assert.equal(run.falls, LIVES);
  assert.ok(drainEvents(run).some((e) => e.type === 'over'));
});

test('检查点改变重生位置', () => {
  const level = LEVELS[3];
  assert.ok(level.checkpoints.length > 0);
  const cp = level.checkpoints[0];
  const run = place(level, cp.x, cp.z);
  advance(level, run, ZERO, DT);
  assert.equal(run.checkpoint, 0);
  assert.deepEqual(run.respawn, { x: cp.x, z: cp.z });
  const trap = trapOf(level);
  run.ball.x = trap.x;
  run.ball.z = trap.z;
  run.phase = 'rolling';
  pump(level, run, ZERO, FALL_TIME + 0.1);
  assert.ok(Math.hypot(run.ball.x - cp.x, run.ball.z - cp.z) < 1e-9, '应当回到检查点而不是起点');
});

// ============ 宝石与摆杆 ============

test('宝石只吃一次', () => {
  const gem = L1.gems[0];
  const run = place(L1, gem.x, gem.z);
  advance(L1, run, ZERO, DT);
  assert.equal(run.taken[0], true);
  assert.equal(drainEvents(run).filter((e) => e.type === 'gem').length, 1);
  run.ball.x = gem.x - 1;
  advance(L1, run, ZERO, DT);
  run.ball.x = gem.x;
  advance(L1, run, ZERO, DT);
  assert.equal(drainEvents(run).filter((e) => e.type === 'gem').length, 0);
});

test('摆杆把杆面线速度传给球：接触后球速被抬起来', () => {
  const level = LEVELS[4];
  assert.equal(level.sweepers.length, 2);
  const s = level.sweepers[0];
  const run = createRun(level);
  run.grace = 0;
  // 站在杆端扫过的位置上，等杆扫过来
  run.ball.x = s.x + s.arm * 0.8;
  run.ball.z = s.z;
  run.ball.vx = 0;
  run.ball.vz = 0;
  let maxSpeed = 0;
  let bumped = false;
  for (let i = 0; i < 600; i++) {
    advance(level, run, ZERO, DT);
    maxSpeed = Math.max(maxSpeed, Math.hypot(run.ball.vx, run.ball.vz));
    if (drainEvents(run).some((e) => e.type === 'bump')) bumped = true;
    if (bumped && maxSpeed > 0.6) break;
  }
  assert.ok(bumped, '摆杆应当撞到球');
  assert.ok(maxSpeed > 0.6, `摆杆应当把球甩出去，实测峰值 ${maxSpeed}`);
});

test('摆杆不会刹停正在逃离杆面的球（只处理相对接近）', () => {
  const base = LEVELS[4];
  const s = base.sweepers[0];
  // phase=0 让杆沿 x 轴，球放在中点右侧、深入接触区 0.05；
  // 一个 SUBSTEP 只会前进约 0.017，碰撞检查时仍在 reach 内，保证真的进入该分支。
  const level = { ...base, sweepers: [{ ...s, omega: 0, phase: 0 }], holes: [], gems: [], checkpoints: [] };
  const run = createRun(level);
  run.grace = 0;
  const reach = s.r + BALL_R;
  run.ball.x = s.x + reach - 0.05;
  run.ball.z = s.z;
  run.ball.vx = 4;
  run.ball.vz = 0;
  drainEvents(run);
  advance(level, run, ZERO, SUBSTEP);
  assert.ok(run.ball.vx > 3.5, `逃离中的球不应被刹停，实测 vx=${run.ball.vx}`);
  assert.equal(
    drainEvents(run).some((e) => e.type === 'bump'),
    false,
    '远离杆面的球不应触发 bump',
  );
});

test('sweeperEnds 与当前角度一致，长度等于两倍半臂长', () => {
  const level = LEVELS[4];
  const run = createRun(level);
  pump(level, run, ZERO, 1.3);
  const e = sweeperEnds(level, run, 0);
  const len = Math.hypot(e.bx - e.ax, e.bz - e.az);
  assert.ok(Math.abs(len - level.sweepers[0].arm * 2) < 1e-9);
  assert.ok(Math.abs((e.ax + e.bx) / 2 - level.sweepers[0].x) < 1e-9);
});

// ============ 积分与决定性 ============

test('同一输入序列完全决定同一结果', () => {
  const script = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: -1 }, ZERO];
  const play = () => {
    const run = createRun(L1);
    script.forEach((input, i) => pump(L1, run, input, 0.4 + i * 0.1));
    return run;
  };
  const a = play();
  const b = play();
  assert.equal(a.ball.x, b.ball.x);
  assert.equal(a.ball.z, b.ball.z);
  assert.equal(a.ball.vx, b.ball.vx);
  assert.equal(a.elapsed, b.elapsed);
  assert.equal(a.phase, b.phase);
});

test('固定子步累加器：帧率不同但总时长相同 ⇒ 状态逐位一致', () => {
  const a = createRun(L1);
  const b = createRun(L1);
  a.grace = 0;
  b.grace = 0;
  for (let i = 0; i < 60; i++) advance(L1, a, { x: 0.7, z: -0.4 }, 1 / 60);
  for (let i = 0; i < 144; i++) advance(L1, b, { x: 0.7, z: -0.4 }, 1 / 144);
  assert.equal(a.ball.x, b.ball.x);
  assert.equal(a.ball.z, b.ball.z);
  assert.equal(a.ball.vx, b.ball.vx);
  assert.equal(a.ball.vz, b.ball.vz);
});

test('帧 dt 被夹到 0.05，切后台回来不会一步跨越整张盘', () => {
  const run = createRun(L1);
  run.grace = 0;
  advance(L1, run, { x: 1, z: 1 }, 5);
  assert.ok(run.elapsed <= 0.05 + 1e-9);
  assert.ok(Math.hypot(run.ball.x - L1.start.x, run.ball.z - L1.start.z) < 0.1);
});

// ============ 路径与可解性门禁 ============

test('inputForAccel 在可达集内是 planeGravity 的精确逆，超出则饱和', () => {
  const limit = G * Math.sin(MAX_TILT);
  // az 的上限被 cos(roll) 压低，所以可达集不是正方形
  const feasible = [[1.2, -0.8], [0, 0], [-2.4, 0.4], [2.0, 1.6], [-1.1, -2.0]];
  for (const [ax, az] of feasible) {
    const t = tiltTarget(inputForAccel(ax, az));
    const g = planeGravity(t.pitch, t.roll);
    assert.ok(Math.abs(g.ax - ax) < 1e-6, `ax ${g.ax} != ${ax}`);
    assert.ok(Math.abs(g.az - az) < 1e-6, `az ${g.az} != ${az}`);
  }
  for (const [ax, az] of [[99, 99], [-99, 99], [2.8, 2.8]]) {
    const input = inputForAccel(ax, az);
    assert.ok(Math.abs(input.x) <= 1 && Math.abs(input.z) <= 1, '输入必须夹在 ±1');
    assert.equal(Math.sign(input.x), Math.sign(ax));
    assert.equal(Math.sign(input.z), Math.sign(az));
    const g = planeGravity(tiltTarget(input).pitch, tiltTarget(input).roll);
    assert.ok(Math.abs(g.ax) <= limit + 1e-9 && Math.abs(g.az) <= limit + 1e-9);
    assert.ok(Math.abs(g.ax) > limit * 0.9, '不可达请求应当顶到接近满舵');
  }
});

test('八关都有 BFS 可行路线，且每一步不是墙就是终点洞', () => {
  for (const level of LEVELS) {
    const route = findRoute(level);
    assert.ok(route, `${level.def.id} 找不到路线`);
    assert.deepEqual(route[0], level.start);
    assert.ok(Math.hypot(route[route.length - 1].x - level.goal.x, route[route.length - 1].z - level.goal.z) < 1e-9);
    for (let i = 0; i < route.length; i++) {
      const { col, row } = cellAt(route[i].x, route[i].z);
      const isGoal = Math.hypot(route[i].x - level.goal.x, route[i].z - level.goal.z) < 1e-9;
      assert.ok(isGoal || passable(level, col, row), `${level.def.id} 第 ${i} 步不可通行`);
      if (i > 0) {
        const step = Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
        assert.ok(Math.abs(step - 1) < 1e-9, '只允许四邻域轴对齐移动');
      }
    }
  }
});

test('后两关的蛇形墙障真的迫使绕路（最短路远超曼哈顿距离）', () => {
  for (const index of [6, 7]) {
    const level = LEVELS[index];
    const route = findRoute(level);
    const manhattan = Math.abs(level.goal.x - level.start.x) + Math.abs(level.goal.z - level.start.z);
    assert.ok(routeLength(route) > manhattan * 1.7, `${level.def.id} 路线 ${routeLength(route)} 应远大于曼哈顿 ${manhattan}`);
  }
});

test('simplify 保留起终点与所有拐点，且点数不多于原路线', () => {
  const route = findRoute(LEVELS[1]);
  const wp = simplify(route);
  assert.deepEqual(wp[0], route[0]);
  assert.deepEqual(wp[wp.length - 1], route[route.length - 1]);
  assert.ok(wp.length <= route.length);
  assert.ok(wp.length >= 3, '第二关有十个拐点，化简后不该只剩两个');
});

test('可解性门禁：自动驾驶真实跑通全部八关且不掉洞', () => {
  for (const level of LEVELS) {
    const result = autoSolve(level, 16);
    assert.ok(result.cleared, `${level.def.id} ${level.def.name} 自动驾驶没能过关`);
    assert.equal(result.falls, 0, `${level.def.id} 自动驾驶掉了 ${result.falls} 次`);
    assert.ok(result.elapsed > 3 && result.elapsed < 120, `${level.def.id} 用时异常 ${result.elapsed}`);
  }
});

test('par 是校准值：不低于自动驾驶用时，也不至于松到没有意义', () => {
  for (const level of LEVELS) {
    const result = autoSolve(level, 16);
    assert.ok(level.def.par >= result.elapsed, `${level.def.id} par ${level.def.par} 比自动驾驶 ${result.elapsed} 还紧`);
    assert.ok(level.def.par <= result.elapsed * 4, `${level.def.id} par 过松`);
  }
});

test('关卡图合法：尺寸、起终点、摆杆配置数量一致', () => {
  assert.equal(LEVEL_DEFS.length, 8);
  for (const def of LEVEL_DEFS) {
    assert.equal(def.rows.length, SIZE);
    assert.ok(def.rows.every((r) => r.length === SIZE));
    const level = parseLevel(def);
    assert.ok(level.start && level.goal);
    assert.equal(level.sweepers.length, def.sweepers.length);
    assert.ok(level.def.par > 0);
  }
  assert.throws(() => parseLevel({ ...LEVEL_DEFS[0], rows: ['##########'] }), /10×10/);
  assert.throws(() => parseLevel({ ...LEVEL_DEFS[4], sweepers: [] }), /摆杆/);
});

test('每关的宝石与检查点都不在墙里或洞里', () => {
  for (const level of LEVELS) {
    for (const point of [...level.gems, ...level.checkpoints]) {
      const { col, row } = cellAt(point.x, point.z);
      assert.notEqual(terrainAt(level, point.x, point.z), WALL, `${level.def.id} 有道具落在墙里`);
      assert.ok(passable(level, col, row), `${level.def.id} 有道具落在洞里`);
    }
  }
});

// ============ 计分 ============

test('星级按 par 与 par×1.6 分档', () => {
  assert.equal(starsFor(10, 20), 3);
  assert.equal(starsFor(20, 20), 3);
  assert.equal(starsFor(20.1, 20), 2);
  assert.equal(starsFor(32, 20), 2);
  assert.equal(starsFor(32.1, 20), 1);
});

test('单关计分：基础 + 宝石 + 时间奖励 − 掉洞 − 提示，且不为负', () => {
  const run = createRun(L1);
  run.elapsed = 10;
  run.taken = [true, true, false];
  run.falls = 1;
  run.hints = 2;
  const s = levelScore(L1, run);
  assert.equal(s.base, 600);
  assert.equal(s.gems, 2 * GEM_VALUE);
  assert.equal(s.timeBonus, Math.max(0, Math.round((L1.def.par * 1.6 - 10) * 20)));
  assert.equal(s.fallPenalty, 120);
  assert.equal(s.hintPenalty, 2 * HINT_COST);
  assert.equal(s.total, Math.max(0, 600 + 240 + s.timeBonus - 120 - 100));
  assert.equal(s.stars, 3);
  const bad = createRun(L1);
  bad.elapsed = 999;
  bad.falls = 99;
  bad.hints = 99;
  assert.equal(levelScore(L1, bad).total, 0);
});

test('提示只在滚动阶段计数', () => {
  const run = createRun(L1);
  useHint(run);
  useHint(run);
  assert.equal(run.hints, 2);
  run.phase = 'cleared';
  useHint(run);
  assert.equal(run.hints, 2);
});

// ============ 输入状态机 ============

const VIEW = { width: 800, height: 500 };

test('指针：只接受主键，第二个手指被忽略', () => {
  let s = createControl();
  s = reduceControl(s, { type: 'down', id: 1, x: 100, y: 100, button: 2 }).state;
  assert.equal(s.pointerId, null, '右键不该接管');
  s = reduceControl(s, { type: 'down', id: 1, x: 100, y: 100, button: 0 }).state;
  assert.equal(s.pointerId, 1);
  s = reduceControl(s, { type: 'down', id: 2, x: 400, y: 400, button: 0 }).state;
  assert.equal(s.pointerId, 1);
  assert.deepEqual(s.origin, { x: 100, y: 100 });
});

test('指针：只跟踪活动指针，别的 id 的 move/up 不生效', () => {
  let s = reduceControl(createControl(), { type: 'down', id: 7, x: 100, y: 100, button: 0 }).state;
  s = reduceControl(s, { type: 'move', id: 8, x: 500, y: 500 }).state;
  assert.deepEqual(s.current, { x: 100, y: 100 });
  s = reduceControl(s, { type: 'up', id: 8 }).state;
  assert.equal(s.pointerId, 7);
  s = reduceControl(s, { type: 'move', id: 7, x: 300, y: 250 }).state;
  const tilt = pointerTilt(s, VIEW);
  assert.ok(tilt.x > 0.9 && tilt.z > 0.9);
});

test('拖拽不泄漏：松手后倾斜立刻归零', () => {
  let s = reduceControl(createControl(), { type: 'down', id: 1, x: 100, y: 100, button: 0 }).state;
  s = reduceControl(s, { type: 'move', id: 1, x: 400, y: 400 }).state;
  assert.ok(controlTilt(s, VIEW).x > 0);
  s = reduceControl(s, { type: 'up', id: 1 }).state;
  assert.deepEqual(controlTilt(s, VIEW), ZERO);
  assert.equal(s.origin, null);
});

test('死区与夹取：小幅拖动不倾斜，大幅拖动封顶 ±1', () => {
  let s = reduceControl(createControl(), { type: 'down', id: 1, x: 200, y: 200, button: 0 }).state;
  s = reduceControl(s, { type: 'move', id: 1, x: 205, y: 203 }).state;
  assert.deepEqual(pointerTilt(s, VIEW), ZERO);
  s = reduceControl(s, { type: 'move', id: 1, x: 2000, y: -2000 }).state;
  assert.deepEqual(pointerTilt(s, VIEW), { x: 1, z: -1 });
});

test('pointercancel 与 clear 都能复位', () => {
  let s = reduceControl(createControl(), { type: 'down', id: 3, x: 10, y: 10, button: 0 }).state;
  s = reduceControl(s, { type: 'key', key: 'ArrowRight', down: true }).state;
  s = reduceControl(s, { type: 'cancel', id: 3 }).state;
  assert.equal(s.pointerId, null);
  assert.deepEqual(keyTilt(s), { x: 1, z: 0 });
  s = reduceControl(s, { type: 'clear' }).state;
  assert.deepEqual(controlTilt(s, VIEW), ZERO);
  assert.deepEqual(s.keys, []);
});

test('键盘：方向键与 WASD 都映射，反向抵消，同方向两种写法不互相误清', () => {
  let s = createControl();
  assert.ok(isTiltKey('w') && isTiltKey('ArrowLeft') && !isTiltKey('Enter'));
  s = reduceControl(s, { type: 'key', key: 'ArrowRight', down: true }).state;
  assert.deepEqual(keyTilt(s), { x: 1, z: 0 });
  s = reduceControl(s, { type: 'key', key: 'd', down: true }).state;
  assert.deepEqual(keyTilt(s), { x: 1, z: 0 });
  s = reduceControl(s, { type: 'key', key: 'ArrowRight', down: false }).state;
  assert.deepEqual(keyTilt(s), { x: 1, z: 0 }, '松开方向键不该把还按着的 d 一起清掉');
  s = reduceControl(s, { type: 'key', key: 'a', down: true }).state;
  assert.deepEqual(keyTilt(s), { x: 0, z: 0 });
  s = reduceControl(s, { type: 'key', key: 'ArrowUp', down: true }).state;
  s = reduceControl(s, { type: 'key', key: 's', down: true }).state;
  assert.deepEqual(keyTilt(s), { x: 0, z: 0 });
});

test('指针优先于键盘，拖着时按键不叠加', () => {
  let s = reduceControl(createControl(), { type: 'key', key: 'ArrowLeft', down: true }).state;
  assert.deepEqual(controlTilt(s, VIEW), { x: -1, z: 0 });
  s = reduceControl(s, { type: 'down', id: 1, x: 100, y: 100, button: 0 }).state;
  s = reduceControl(s, { type: 'move', id: 1, x: 500, y: 100 }).state;
  assert.ok(controlTilt(s, VIEW).x > 0, '拖动应当压过反向按键');
});

test('重复 keydown 不改变状态，非游戏键被忽略', () => {
  let s = reduceControl(createControl(), { type: 'key', key: 'ArrowDown', down: true }).state;
  const again = reduceControl(s, { type: 'key', key: 'ArrowDown', down: true });
  assert.equal(again.changed, false);
  assert.equal(again.state, s);
  const other = reduceControl(s, { type: 'key', key: 'Enter', down: true });
  assert.equal(other.changed, false);
});

// ============ 渲染 ============

test('boardWorld 与物理同一组角：向右倾时右缘下沉，向近端倾时近缘下沉', () => {
  const t = tiltTarget({ x: 1, z: 0 });
  const right = boardWorld(t, 4.5, 0, 0);
  assert.ok(right.y < 0, '右缘必须下沉，球才会向右滚');
  const t2 = tiltTarget({ x: 0, z: 1 });
  const near = boardWorld(t2, 0, 0, 4.5);
  assert.ok(near.y < 0, '近缘必须下沉');
  const up = boardWorld({ pitch: 0, roll: 0 }, 0, 1, 0);
  assert.deepEqual(up, { x: 0, y: 1, z: 0 });
});

test('投影深度恒为正，近处放大远处缩小', () => {
  const cam = makeCamera(L1, { width: 800, height: 500 });
  const near = project(cam, { x: 0, y: 0, z: 4.5 });
  const far = project(cam, { x: 0, y: 0, z: -4.5 });
  assert.ok(near.depth > 0 && far.depth > 0);
  assert.ok(near.depth < far.depth);
  assert.ok(near.scale > far.scale);
  assert.ok(near.y > far.y, '近端应当落在画面更下方');
});

test('相机拟合：最大倾角包络下盘面所有角点都留在视口内', () => {
  for (const viewport of [{ width: 900, height: 562 }, { width: 320, height: 240 }, { width: 1400, height: 875 }]) {
    const level = LEVELS[7];
    const cam = makeCamera(level, viewport);
    const edge = level.half + 0.5;
    for (const pitch of [-MAX_TILT, 0, MAX_TILT]) {
      for (const roll of [-MAX_TILT, 0, MAX_TILT]) {
        for (const x of [-edge, edge]) {
          for (const z of [-edge, edge]) {
            for (const y of [-0.55, WALL_H]) {
              const p = project(cam, boardWorld({ pitch, roll }, x, y, z));
              assert.ok(p.x >= -1 && p.x <= viewport.width + 1, `x 出框 ${p.x} @${viewport.width}`);
              assert.ok(p.y >= -1 && p.y <= viewport.height + 1, `y 出框 ${p.y} @${viewport.height}`);
            }
          }
        }
      }
    }
  }
});

test('320px 窄屏下球与洞仍然有可辨认的像素尺寸', () => {
  const cam = makeCamera(L1, { width: 304, height: 228 });
  const c = project(cam, { x: 0, y: BALL_R, z: 0 });
  assert.ok(BALL_R * c.scale >= 4, `球半径只有 ${BALL_R * c.scale}px`);
  assert.ok(HOLE_R * c.scale >= 5, `洞半径只有 ${HOLE_R * c.scale}px`);
});

/** 记录绘制序列的假 canvas：用来钉住"每个面只画一次"和球的深度插入位置 */
function fakeCtx() {
  const ops = [];
  let path = [];
  const grad = { addColorStop() {} };
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    setTransform() {}, setLineDash() {}, save() {}, restore() {}, clip() {},
    fillRect() { ops.push({ op: 'rect' }); },
    beginPath() { path = []; },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    closePath() {},
    arc(x, y, r) { path.push(['arc', x, y, r]); },
    ellipse(x, y, rx, ry) { path.push(['ellipse', x, y, rx, ry]); },
    fill() { ops.push({ op: 'fill', style: ctx.fillStyle, path: path.slice() }); },
    stroke() { ops.push({ op: 'stroke', path: path.slice() }); },
  };
  return { ctx, ops };
}

function sceneOps(level = L1, viewport = { width: 800, height: 500 }) {
  const run = createRun(level);
  run.grace = 0;
  const { ctx, ops } = fakeCtx();
  drawScene(ctx, {
    level, run, camera: makeCamera(level, viewport), viewport,
    time: 1.5, hint: null, drag: null, showTilt: true,
  });
  return ops;
}

test(' standing 面不重复绘制（回归：曾经排序后又整表重画一遍）', () => {
  const ops = sceneOps(LEVELS[1]);
  const polys = ops.filter((o) => o.op === 'fill' && o.path.length >= 3 && o.path.every((p) => Array.isArray(p) && p.length === 2 && typeof o.style === 'string' && o.style.startsWith('rgb(')));
  const keys = polys.map((p) => `${p.style}|${p.path.map((q) => q.map((n) => n.toFixed(3)).join(',')).join(';')}`);
  assert.ok(keys.length > 20, `应当画出足够多的墙面，实测 ${keys.length}`);
  assert.equal(new Set(keys).size, keys.length, '有面被画了两遍');
});

test('球只画一次，且按深度插在墙面之间而不是无条件最后画', () => {
  const level = LEVELS[1];
  const run = createRun(level);
  run.grace = 0;
  // 把球放到远端：如果球被无条件最后画，就会浮在近处的墙面上
  run.ball.x = 0.5;
  run.ball.z = -3.5;
  const viewport = { width: 800, height: 500 };
  const cam = makeCamera(level, viewport);
  const { ctx, ops } = fakeCtx();
  drawScene(ctx, { level, run, camera: cam, viewport, time: 0, hint: null, drag: null, showTilt: false });
  const bp = project(cam, boardWorld(run, run.ball.x, BALL_R + run.ball.y, run.ball.z));
  const br = BALL_R * bp.scale;
  const ballFills = ops.filter((o) => o.op === 'fill' && o.path.length === 1 && o.path[0][0] === 'arc'
    && Math.abs(o.path[0][1] - bp.x) < 1e-6 && Math.abs(o.path[0][2] - bp.y) < 1e-6
    && Math.abs(o.path[0][3] - br) < 1e-6);
  assert.equal(ballFills.length, 1, '球应当只画一次');
  const ballIndex = ops.indexOf(ballFills[0]);
  const after = ops.slice(ballIndex + 1).filter((o) => o.op === 'fill' && typeof o.style === 'string' && o.style.startsWith('rgb('));
  assert.ok(after.length > 0, '球在远端时，近处的墙必须画在球之后');
});

test('提示线与拖拽指示按需出现', () => {
  const level = L1;
  const run = createRun(level);
  const cam = makeCamera(level, { width: 800, height: 500 });
  const base = fakeCtx();
  drawScene(base.ctx, { level, run, camera: cam, viewport: { width: 800, height: 500 }, time: 0, hint: null, drag: null, showTilt: false });
  const withHint = fakeCtx();
  drawScene(withHint.ctx, { level, run, camera: cam, viewport: { width: 800, height: 500 }, time: 0, hint: findRoute(level), drag: { ox: 10, oy: 10, x: 60, y: 40 }, showTilt: true });
  assert.ok(withHint.ops.length > base.ops.length, '提示与摇杆指示应当产生额外绘制');
});

test('respawn 保留已吃宝石与已踩检查点，只复位球与倾角', () => {
  const run = createRun(LEVELS[3]);
  run.taken[0] = true;
  run.checkpoint = 0;
  run.respawn = { x: 1.5, z: 2.5 };
  run.ball.vx = 3;
  run.pitch = 0.2;
  run.roll = -0.2;
  run.phase = 'falling';
  respawn(run);
  assert.equal(run.taken[0], true);
  assert.equal(run.checkpoint, 0);
  assert.equal(run.ball.vx, 0);
  assert.equal(run.pitch, 0);
  assert.equal(run.roll, 0);
  assert.equal(run.phase, 'rolling');
  assert.deepEqual({ x: run.ball.x, z: run.ball.z }, { x: 1.5, z: 2.5 });
});