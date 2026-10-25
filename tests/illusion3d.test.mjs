import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceSession,
  advanceWalk,
  createSession,
  findPath,
  getHint,
  parMoves,
  reachableNodes,
  solve,
  starsFor,
  unlockIllusion,
} from '../src/games/illusion3d/logic.ts';
import { LEVELS } from '../src/games/illusion3d/levels.ts';

const level = {
  id: 'test',
  name: '测试遗迹',
  subtitle: '',
  start: 'S',
  exit: 'E',
  nodes: [
    { id: 'S', p: [0, 0, 0], label: '起点' },
    { id: 'A', p: [1, 0, 0], label: '断口' },
    { id: 'B', p: [2, 0, 0], label: '星核', core: true },
    { id: 'E', p: [3, 0, 0], label: '星门' },
  ],
  edges: [['S', 'A'], ['A', 'E'], ['B', 'E']],
  illusions: [{ id: 'AB', a: 'A', b: 'B', view: { yaw: 0, pitch: 0.7 } }],
};

test('locked illusions do not participate in routing', () => {
  const bridgeOnly = { ...level, edges: [['S', 'A']] };
  assert.equal(findPath(bridgeOnly, 'S', 'B', new Set()), null);
  assert.deepEqual(findPath(bridgeOnly, 'S', 'B', new Set(['AB'])), ['S', 'A', 'B']);
  assert.deepEqual(reachableNodes(bridgeOnly, createSession(bridgeOnly)).sort(), ['A', 'S']);
});

test('a bridge can only be fixed while the traveler stands at one endpoint', () => {
  const initial = createSession(level);
  assert.equal(unlockIllusion(level, initial, 'AB'), initial);

  const atA = advanceSession(level, initial, 'A');
  const fixed = unlockIllusion(level, atA, 'AB');
  assert.notEqual(fixed, atA);
  assert.deepEqual(fixed.unlocked, ['AB']);
  assert.equal(fixed.moves, 1);
  assert.equal(unlockIllusion(level, fixed, 'AB'), fixed);
});

test('movement collects cores and the exit stays incomplete until every core is held', () => {
  const initial = createSession(level);
  assert.equal(advanceSession(level, initial, 'B'), initial);

  const atA = advanceSession(level, initial, 'A');
  const earlyExit = advanceSession(level, atA, 'E');
  assert.equal(earlyExit.complete, false);
  assert.equal(earlyExit.moves, 2);

  const backAtA = advanceSession(level, earlyExit, 'A');
  const fixed = unlockIllusion(level, backAtA, 'AB');
  const atCore = advanceSession(level, fixed, 'B');
  assert.deepEqual(atCore.collected, ['B']);
  assert.equal(atCore.complete, false);

  const complete = advanceSession(level, atCore, 'E');
  assert.equal(complete.complete, true);
  assert.equal(complete.moves, 5);
  assert.equal(advanceSession(level, complete, 'B'), complete);
});

test('walking ends immediately when an intermediate node completes the level', () => {
  const loop = {
    ...level,
    id: 'loop',
    start: 'E',
    exit: 'S',
    nodes: [
      { id: 'E', p: [2, 0, 0], label: '远端' },
      { id: 'S', p: [1, 0, 0], label: '星门' },
      { id: 'A', p: [0, 0, 0], label: '另一侧' },
    ],
    edges: [['E', 'S'], ['S', 'A']],
    illusions: [],
  };
  const session = { node: 'E', collected: [], unlocked: [], moves: 4, complete: false };
  const step = advanceWalk(loop, session, ['E', 'S', 'A'], 0);
  assert.equal(step.session.node, 'S');
  assert.equal(step.session.complete, true);
  assert.equal(step.done, true);
  assert.equal(step.session.moves, 5);

  const unfinished = advanceWalk(loop, { ...session, collected: ['fake'] }, ['E', 'S', 'A'], 0);
  assert.equal(unfinished.session.complete, false);
  assert.equal(unfinished.done, false);
  assert.equal(unfinished.segment, 1);
});

test('the solver accounts for uncollected cores instead of merely reaching the exit', () => {
  assert.deepEqual(solve(level, createSession(level)), ['S', 'A', 'B', 'E']);
  assert.equal(parMoves(level), 3);
});

test('hints unlock and traverse a shortest legal route', () => {
  let session = createSession(level);
  assert.deepEqual(getHint(level, session), { type: 'move', node: 'A' });
  session = advanceSession(level, session, 'A');
  assert.deepEqual(getHint(level, session), { type: 'align', illusion: 'AB' });
  session = unlockIllusion(level, session, 'AB');
  assert.deepEqual(getHint(level, session), { type: 'move', node: 'B' });
  session = advanceSession(level, session, 'B');
  assert.deepEqual(getHint(level, session), { type: 'move', node: 'E' });
  session = advanceSession(level, session, 'E');
  assert.equal(getHint(level, session), null);
});

test('stars use shortest-route thresholds without punishing hints', () => {
  assert.equal(starsFor(3, 3), 3);
  assert.equal(starsFor(5, 3), 2);
  assert.equal(starsFor(6, 3), 1);
});

test('all six campaign levels are solvable and their hints reproduce par', () => {
  assert.equal(LEVELS.length, 6);
  assert.equal(new Set(LEVELS.map((item) => item.id)).size, 6);

  for (const item of LEVELS) {
    assert.ok(item.illusions.length > 0, `${item.id}: needs an illusion bridge`);
    assert.ok(item.nodes.some((node) => node.core), `${item.id}: needs a core`);
    const par = parMoves(item);
    assert.ok(par > 0, `${item.id}: par`);
    assert.equal(solve(item, createSession(item)).length - 1, par, `${item.id}: solver agrees with par`);

    let session = createSession(item);
    for (let guard = 0; guard < 100 && !session.complete; guard += 1) {
      const hint = getHint(item, session);
      assert.ok(hint, `${item.id}: hint exists before completion`);
      session = hint.type === 'align'
        ? unlockIllusion(item, session, hint.illusion)
        : advanceSession(item, session, hint.node);
    }
    assert.equal(session.complete, true, `${item.id}: hints complete the level`);
    assert.equal(session.moves, par, `${item.id}: hints reproduce the shortest route`);
    assert.deepEqual(
      [...session.unlocked].sort(),
      item.illusions.map((edge) => edge.id).sort(),
      `${item.id}: every authored illusion bridge is required by the shortest route`,
    );
  }
});
