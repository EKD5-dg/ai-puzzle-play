import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS } from '../src/games/illusion3d/levels.ts';
import { createSession } from '../src/games/illusion3d/logic.ts';
import { findAlignableEdge, makeCamera, projectPoint, runeAnchor, stepAlignment } from '../src/games/illusion3d/projection.ts';

const viewport = { width: 640, height: 400 };

test('perspective projection preserves screen axes and depth scale', () => {
  const camera = { yaw: 0, pitch: 0, distance: 10, zoom: 1, target: [0, 0, 0] };
  const center = projectPoint([0, 0, 0], camera, viewport);
  const right = projectPoint([1, 0, 0], camera, viewport);
  const above = projectPoint([0, 1, 0], camera, viewport);
  const nearer = projectPoint([0, 0, 1], camera, viewport);

  assert.deepEqual(center, { x: 320, y: 200, depth: 10, scale: 56 });
  assert.ok(right.x > center.x);
  assert.ok(above.y < center.y);
  assert.ok(nearer.depth < center.depth);
  assert.ok(nearer.scale > center.scale);
});

test('every authored alignment view really overlaps its two anchors on screen', () => {
  for (const level of LEVELS) {
    for (const edge of level.illusions) {
      const camera = makeCamera(level, edge.view);
      const a = level.nodes.find((node) => node.id === edge.a);
      const b = level.nodes.find((node) => node.id === edge.b);
      const pa = projectPoint(runeAnchor(a.p), camera, viewport);
      const pb = projectPoint(runeAnchor(b.p), camera, viewport);
      const gap = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      assert.ok(
        gap <= Math.min(viewport.width, viewport.height) * 0.05,
        `${level.id}/${edge.id}: projected gap ${gap.toFixed(2)}px`,
      );

      const session = { ...createSession(level), node: edge.a };
      const candidate = findAlignableEdge(level, session, camera, viewport);
      assert.equal(candidate?.id, edge.id, `${level.id}/${edge.id}: alignable from endpoint`);
    }
  }
});

test('alignment candidates require an endpoint, an unlocked edge, and visible on-screen anchors', () => {
  const level = LEVELS[0];
  const edge = level.illusions[0];
  const camera = makeCamera(level, edge.view);
  const atStart = createSession(level);
  assert.equal(findAlignableEdge(level, atStart, camera, viewport), null);

  const atA = { ...atStart, node: edge.a };
  assert.equal(findAlignableEdge(level, { ...atA, unlocked: [edge.id] }, camera, viewport), null);
  assert.equal(findAlignableEdge(level, atA, camera, viewport, () => false), null);
  assert.equal(findAlignableEdge(level, atA, camera, { width: 20, height: 20 }), null);
});

test('alignment charge survives threshold jitter and locks only after sustained overlap', () => {
  let state = { edgeId: null, charge: 0 };
  let result = stepAlignment(state, { id: 'A', gap: 10 }, 0.1, viewport);
  state = result.state;
  assert.equal(result.locked, null);
  assert.equal(state.charge, 0.1);

  result = stepAlignment(state, { id: 'A', gap: 10 }, 0.1, viewport);
  state = result.state;
  result = stepAlignment(state, { id: 'A', gap: 30 }, 0.05, viewport);
  state = result.state;
  assert.equal(state.charge, 0.2);

  result = stepAlignment(state, { id: 'A', gap: 12 }, 0.06, viewport);
  assert.equal(result.locked, 'A');
  assert.deepEqual(result.state, { edgeId: null, charge: 0 });
});

test('alignment charge decays outside the release gap instead of locking later from stale progress', () => {
  let state = { edgeId: 'A', charge: 0.2 };
  let result = stepAlignment(state, { id: 'A', gap: 60 }, 0.05, viewport);
  state = result.state;
  assert.equal(state.charge, 0.1);
  result = stepAlignment(state, null, 0.05, viewport);
  assert.deepEqual(result.state, { edgeId: null, charge: 0 });
  assert.equal(result.locked, null);
});

test('switching anchor pairs resets partial alignment charge', () => {
  const result = stepAlignment(
    { edgeId: 'A', charge: 0.24 },
    { id: 'B', gap: 2 },
    0.05,
    viewport,
  );
  assert.equal(result.locked, null);
  assert.deepEqual(result.state, { edgeId: 'B', charge: 0.05 });
});
