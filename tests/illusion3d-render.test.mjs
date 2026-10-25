import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS } from '../src/games/illusion3d/levels.ts';
import { createSession, reachableNodes } from '../src/games/illusion3d/logic.ts';
import { buildLevelMesh } from '../src/games/illusion3d/geometry.ts';
import { makeCamera } from '../src/games/illusion3d/projection.ts';
import { drawScene } from '../src/games/illusion3d/renderer.ts';

function recordingContext() {
  const calls = [];
  const gradient = { addColorStop: (...args) => calls.push(['addColorStop', ...args]) };
  const target = {
    globalAlpha: 1,
    lineWidth: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    shadowBlur: 0,
    shadowColor: 'transparent',
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    measureText: (text) => ({ width: String(text).length * 6 }),
    getLineDash: () => [],
  };
  const ctx = new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property];
      return (...args) => calls.push([property, ...args]);
    },
  });
  return { ctx, calls };
}

function frameFor(level, visibleNodes) {
  const session = {
    ...createSession(level),
    unlocked: level.illusions.map((edge) => edge.id),
  };
  return {
    level,
    session,
    mesh: buildLevelMesh(level, new Set(session.unlocked)),
    camera: makeCamera(level),
    viewport: { width: 640, height: 400 },
    traveler: { position: level.nodes[0].p, moving: false, phase: 0 },
    visibleNodes,
    reachable: new Set(reachableNodes(level, session)),
    candidate: null,
    alignment: { edgeId: null, charge: 0 },
    hint: null,
    selected: null,
    time: 0,
  };
}

test('every campaign scene emits finite canvas coordinates and node hit regions', () => {
  for (const level of LEVELS) {
    const { ctx, calls } = recordingContext();
    const hits = drawScene(ctx, frameFor(level, new Set(level.nodes.map((node) => node.id))));
    assert.ok(hits.length > 0, `${level.id}: hit regions`);
    assert.ok(calls.length > 100, `${level.id}: real drawing work`);
    for (const call of calls) {
      for (const value of call.slice(1)) {
        if (typeof value === 'number') assert.ok(Number.isFinite(value), `${level.id}: ${call[0]} received ${value}`);
      }
    }
    for (const hit of hits) {
      assert.ok(Number.isFinite(hit.x) && Number.isFinite(hit.y) && hit.radius > 0);
    }
  }
});

test('occluded nodes do not remain clickable through the ruins', () => {
  const level = LEVELS[0];
  const { ctx } = recordingContext();
  const hits = drawScene(ctx, frameFor(level, new Set()));
  assert.deepEqual(hits, []);
});

test('traveler geometry remains finite at every node in every level', () => {
  for (const level of LEVELS) {
    for (const node of level.nodes) {
      const { ctx, calls } = recordingContext();
      const frame = frameFor(level, new Set(level.nodes.map((item) => item.id)));
      frame.traveler = { position: node.p, moving: true, phase: 0.37 };
      drawScene(ctx, frame);
      for (const call of calls) {
        for (const value of call.slice(1)) {
          if (typeof value === 'number') assert.ok(Number.isFinite(value), `${level.id}/${node.id}: ${call[0]}`);
        }
      }
    }
  }
});
