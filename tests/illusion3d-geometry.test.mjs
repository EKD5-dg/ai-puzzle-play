import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS } from '../src/games/illusion3d/levels.ts';
import { buildLevelMesh, isPointVisible } from '../src/games/illusion3d/geometry.ts';
import { makeCamera, runeAnchor } from '../src/games/illusion3d/projection.ts';

const viewport = { width: 640, height: 400 };

function triangleArea(triangle) {
  const a = triangle.a;
  const b = triangle.b;
  const c = triangle.c;
  const u = b.map((value, index) => value - a[index]);
  const v = c.map((value, index) => value - a[index]);
  return Math.hypot(
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ) / 2;
}

test('all generated stone and bridge triangles are finite and non-degenerate', () => {
  for (const level of LEVELS) {
    const locked = buildLevelMesh(level, new Set());
    const unlocked = buildLevelMesh(level, new Set(level.illusions.map((edge) => edge.id)));
    assert.ok(unlocked.length > locked.length, `${level.id}: fixed bridges add geometry`);
    for (const triangle of unlocked) {
      assert.ok([...triangle.a, ...triangle.b, ...triangle.c].every(Number.isFinite));
      assert.ok(triangleArea(triangle) > 1e-8, `${level.id}: degenerate triangle`);
      assert.ok(Math.abs(Math.hypot(...triangle.normal) - 1) < 1e-8, `${level.id}: unit normal`);
    }
  }
});

test('occlusion uses the wall in front rather than glowing through it', () => {
  const wall = [
    { a: [-1, -1, 0], b: [1, -1, 0], c: [1, 1, 0], normal: [0, 0, 1], material: 'stone' },
    { a: [-1, -1, 0], b: [1, 1, 0], c: [-1, 1, 0], normal: [0, 0, 1], material: 'stone' },
  ];
  const camera = { yaw: 0, pitch: 0, distance: 10, zoom: 1, target: [0, 0, 0] };
  assert.equal(isPointVisible([0, 0, -2], wall, camera, viewport), false);
  assert.equal(isPointVisible([0, 0, 2], wall, camera, viewport), true);
  assert.equal(isPointVisible([3, 0, -2], wall, camera, viewport), true);
});

test('authored alignment views keep both rune anchors visible', () => {
  for (const level of LEVELS) {
    const mesh = buildLevelMesh(level, new Set());
    for (const edge of level.illusions) {
      const camera = makeCamera(level, edge.view);
      for (const id of [edge.a, edge.b]) {
        const node = level.nodes.find((item) => item.id === id);
        const anchor = runeAnchor(node.p);
        assert.equal(
          isPointVisible(anchor, mesh, camera, viewport),
          true,
          `${level.id}/${edge.id}: ${id} must be visible`,
        );
      }
    }
  }
});

test('exit runes remain visible across most orbit angles', () => {
  for (const level of LEVELS) {
    const mesh = buildLevelMesh(level, new Set());
    const exit = level.nodes.find((node) => node.id === level.exit);
    let visible = 0;
    const samples = 36;
    for (let index = 0; index < samples; index += 1) {
      const camera = makeCamera(level, { yaw: index / samples * Math.PI * 2, pitch: 0.6 });
      if (isPointVisible(runeAnchor(exit.p), mesh, camera, viewport)) visible += 1;
    }
    assert.ok(visible / samples >= 0.7, `${level.id}: exit visible ${visible}/${samples}`);
  }
});
