import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrbit, createGesture, reduceGesture, selectTapTarget, walkPosition, wheelZoomFactor, zoomCamera } from '../src/games/illusion3d/input.ts';

test('a press and release without movement is exactly one tap', () => {
  const empty = createGesture();
  const down = reduceGesture(empty, { type: 'down', id: 1, x: 40, y: 50 });
  const up = reduceGesture(down.state, { type: 'up', id: 1, x: 40, y: 50 });
  assert.deepEqual(up.tap, { x: 40, y: 50 });
  assert.equal(up.orbit, null);
  assert.equal(up.zoom, null);
  assert.deepEqual(up.state, empty);
});

test('dragging orbits but never emits a release click', () => {
  let result = reduceGesture(createGesture(), { type: 'down', id: 1, x: 10, y: 10 });
  result = reduceGesture(result.state, { type: 'move', id: 1, x: 28, y: 17 });
  assert.deepEqual(result.orbit, { dx: 18, dy: 7 });
  assert.equal(result.state.dragged, true);
  result = reduceGesture(result.state, { type: 'up', id: 1, x: 28, y: 17 });
  assert.equal(result.tap, null);
});

test('pinching zooms and cannot leak a tap or one-finger orbit on release', () => {
  let result = reduceGesture(createGesture(), { type: 'down', id: 1, x: 20, y: 20 });
  result = reduceGesture(result.state, { type: 'down', id: 2, x: 60, y: 20 });
  assert.equal(result.zoom, null);
  result = reduceGesture(result.state, { type: 'move', id: 2, x: 100, y: 20 });
  assert.equal(result.zoom, 2);
  assert.equal(result.orbit, null);
  result = reduceGesture(result.state, { type: 'up', id: 2, x: 100, y: 20 });
  assert.equal(result.tap, null);
  result = reduceGesture(result.state, { type: 'move', id: 1, x: 30, y: 30 });
  assert.equal(result.orbit, null);
  result = reduceGesture(result.state, { type: 'up', id: 1, x: 30, y: 30 });
  assert.equal(result.tap, null);
});

test('cancelled pointers never become taps', () => {
  const down = reduceGesture(createGesture(), { type: 'down', id: 7, x: 4, y: 8 });
  const cancel = reduceGesture(down.state, { type: 'cancel', id: 7 });
  assert.equal(cancel.tap, null);
  assert.deepEqual(cancel.state, createGesture());
});

test('camera orbit, pitch, and zoom stay inside usable limits', () => {
  const camera = { yaw: 0.5, pitch: 1.17, distance: 12, zoom: 1, target: [0, 0, 0] };
  const orbited = applyOrbit(camera, 10, 100);
  assert.ok(orbited.yaw < camera.yaw);
  assert.equal(orbited.pitch, 1.18);
  assert.equal(applyOrbit(camera, 0, -10000).pitch, 0.28);
  assert.equal(zoomCamera(camera, 100).zoom, 1.8);
  assert.equal(zoomCamera(camera, 0.001).zoom, 0.65);
});

test('overlapping tap targets prefer a reachable non-current node', () => {
  const hits = [
    { id: 'A', x: 0, y: 0, radius: 20 },
    { id: 'B', x: 1, y: 0, radius: 20 },
  ];
  const reachable = new Set(['B']);
  assert.equal(selectTapTarget(hits, 0.4, 0, 'A', reachable), 'B');
  assert.equal(selectTapTarget(hits, -10, 0, 'A', reachable), 'B');
  assert.equal(selectTapTarget(hits, 100, 100, 'A', reachable), null);
  assert.equal(selectTapTarget(hits, 0.4, 0, 'A', new Set()), 'A');
});

test('touch taps tolerate more jitter than mouse drags', () => {
  let touch = reduceGesture(createGesture(), { type: 'down', id: 1, x: 10, y: 10, pointerType: 'touch' });
  touch = reduceGesture(touch.state, { type: 'move', id: 1, x: 18, y: 10 });
  touch = reduceGesture(touch.state, { type: 'up', id: 1, x: 18, y: 10 });
  assert.deepEqual(touch.tap, { x: 18, y: 10 });

  let mouse = reduceGesture(createGesture(), { type: 'down', id: 2, x: 10, y: 10, pointerType: 'mouse' });
  mouse = reduceGesture(mouse.state, { type: 'move', id: 2, x: 18, y: 10 });
  mouse = reduceGesture(mouse.state, { type: 'up', id: 2, x: 18, y: 10 });
  assert.equal(mouse.tap, null);
});

test('wheel zoom normalizes pixel, line, and page delta modes', () => {
  assert.ok(wheelZoomFactor(100, 0, 800) < 1);
  assert.equal(wheelZoomFactor(-100, 0, 800), Math.exp(0.1));
  assert.equal(wheelZoomFactor(-3, 1, 800), Math.exp(0.096));
  assert.equal(wheelZoomFactor(-1, 2, 800), Math.exp(0.8));
});

test('walk interpolation follows the active segment in world space', () => {
  const level = {
    nodes: [
      { id: 'A', p: [0, 0, 0] },
      { id: 'B', p: [2, 0, 0] },
      { id: 'C', p: [2, 2, 0] },
    ],
  };
  assert.deepEqual(walkPosition(level, ['A', 'B', 'C'], 0, 0.5), [1, 0, 0]);
  assert.deepEqual(walkPosition(level, ['A', 'B', 'C'], 1, 0.5), [2, 1, 0]);
  assert.deepEqual(walkPosition(level, ['A', 'B', 'C'], 1, 1), [2, 2, 0]);
});
