import { makeCameraFrame, projectPointWithFrame } from './projection.ts';
import type { CameraFrame, OrbitCamera, ProjectedPoint, Viewport } from './projection.ts';
import type { IllusionLevel, Vec3 } from './types.ts';

export type FaceMaterial = 'stone' | 'cap' | 'path' | 'bridge' | 'underside' | 'gate';

export interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  normal: Vec3;
  material: FaceMaterial;
}

export type Mesh = Triangle[];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v: Vec3, amount: number): Vec3 {
  return [v[0] * amount, v[1] * amount, v[2] * amount];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
}

function centroid(points: Vec3[]): Vec3 {
  const sum = points.reduce<Vec3>((acc, point) => add(acc, point), [0, 0, 0]);
  return scale(sum, 1 / points.length);
}

function pushTriangle(mesh: Mesh, a: Vec3, b: Vec3, c: Vec3, material: FaceMaterial, inside?: Vec3): void {
  let normal = normalize(cross(sub(b, a), sub(c, a)));
  let second = b;
  let third = c;
  if (inside && dot(normal, sub(centroid([a, b, c]), inside)) < 0) {
    second = c;
    third = b;
    normal = scale(normal, -1);
  }
  mesh.push({ a, b: second, c: third, normal, material });
}

function pushQuad(mesh: Mesh, points: [Vec3, Vec3, Vec3, Vec3], material: FaceMaterial, inside: Vec3): void {
  pushTriangle(mesh, points[0], points[1], points[2], material, inside);
  pushTriangle(mesh, points[0], points[2], points[3], material, inside);
}

function prismBetween(a: Vec3, b: Vec3, width: number, thickness: number, material: FaceMaterial): Mesh {
  const mesh: Mesh = [];
  const axis = normalize(sub(b, a));
  const side = Math.abs(axis[1]) > 0.95 ? [1, 0, 0] as const : cross(axis, [0, 1, 0]);
  const across = normalize(side);
  const up = normalize(cross(across, axis));
  const corners: Vec3[] = [];
  for (const endpoint of [a, b]) {
    for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      corners.push(add(endpoint, add(scale(across, s * width / 2), scale(up, t * thickness / 2))));
    }
  }
  const inside = scale(add(a, b), 0.5);
  pushQuad(mesh, [corners[0], corners[3], corners[2], corners[1]], material, inside);
  pushQuad(mesh, [corners[4], corners[5], corners[6], corners[7]], material, inside);
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    pushQuad(mesh, [corners[index], corners[next], corners[next + 4], corners[index + 4]], material, inside);
  }
  return mesh;
}

function platform(point: Vec3): Mesh {
  const mesh: Mesh = [];
  const top: Vec3[] = [];
  const bottom: Vec3[] = [];
  const inside: Vec3 = [point[0], point[1] - 0.28, point[2]];
  for (let index = 0; index < 8; index += 1) {
    const angle = index * Math.PI / 4 + Math.PI / 8;
    const x = point[0] + Math.cos(angle) * 0.46;
    const z = point[2] + Math.sin(angle) * 0.46;
    top.push([x, point[1], z]);
    bottom.push([x, point[1] - 0.24, z]);
  }
  for (let index = 0; index < 8; index += 1) {
    const next = (index + 1) % 8;
    pushTriangle(mesh, point, top[index], top[next], 'cap', inside);
    pushQuad(mesh, [top[index], top[next], bottom[next], bottom[index]], 'stone', inside);
    pushTriangle(mesh, bottom[index], bottom[next], [point[0], point[1] - 0.78, point[2]], 'underside', inside);
  }
  return mesh;
}

function gate(level: IllusionLevel): Mesh {
  const node = level.nodes.find((item) => item.id === level.exit);
  if (!node) return [];
  const right: Vec3 = [Math.cos(level.camera.yaw), 0, -Math.sin(level.camera.yaw)];
  const leftBase = add(node.p, scale(right, -0.34));
  const rightBase = add(node.p, scale(right, 0.34));
  const leftTop = add(leftBase, [0, 1.08, 0]);
  const rightTop = add(rightBase, [0, 1.08, 0]);
  return [
    ...prismBetween(leftBase, leftTop, 0.13, 0.13, 'gate'),
    ...prismBetween(rightBase, rightTop, 0.13, 0.13, 'gate'),
    ...prismBetween(leftTop, rightTop, 0.14, 0.14, 'gate'),
  ];
}

export function buildLevelMesh(level: IllusionLevel, unlocked: ReadonlySet<string>): Mesh {
  const mesh: Mesh = [];
  const nodes = new Map(level.nodes.map((node) => [node.id, node]));
  for (const node of level.nodes) mesh.push(...platform(node.p));
  for (const [aId, bId] of level.edges) {
    const a = nodes.get(aId);
    const b = nodes.get(bId);
    if (!a || !b) continue;
    mesh.push(...prismBetween(
      [a.p[0], a.p[1] - 0.1, a.p[2]],
      [b.p[0], b.p[1] - 0.1, b.p[2]],
      0.34,
      0.12,
      'path',
    ));
  }
  for (const edge of level.illusions) {
    if (!unlocked.has(edge.id)) continue;
    const a = nodes.get(edge.a);
    const b = nodes.get(edge.b);
    if (!a || !b) continue;
    mesh.push(...prismBetween(
      [a.p[0], a.p[1] - 0.06, a.p[2]],
      [b.p[0], b.p[1] - 0.06, b.p[2]],
      0.4,
      0.1,
      'bridge',
    ));
  }
  mesh.push(...gate(level));
  return mesh;
}

/** 一帧内所有网格三角形的投影结果，供多个可见性查询复用 */
export interface ProjectedTriangle {
  triangle: Triangle;
  a: ProjectedPoint;
  b: ProjectedPoint;
  c: ProjectedPoint;
  depth: number;
}

/** 每帧只投影一次全部三角形（376 个），可见性查询不再各自重投影 3 个顶点 */
export function projectMesh(mesh: Mesh, frame: CameraFrame): ProjectedTriangle[] {
  return mesh.map((triangle) => {
    const a = projectPointWithFrame(triangle.a, frame);
    const b = projectPointWithFrame(triangle.b, frame);
    const c = projectPointWithFrame(triangle.c, frame);
    return { triangle, a, b, c, depth: (a.depth + b.depth + c.depth) / 3 };
  });
}

export function isPointVisibleWithFrame(
  point: Vec3,
  screenMesh: ProjectedTriangle[],
  frame: CameraFrame,
): boolean {
  const target = projectPointWithFrame(point, frame);
  if (target.depth <= 0.05) return false;
  for (const item of screenMesh) {
    const { a, b, c } = item;
    if (a.depth <= 0.05 || b.depth <= 0.05 || c.depth <= 0.05) continue;
    const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(denominator) < 1e-7) continue;
    const wa = ((b.y - c.y) * (target.x - c.x) + (c.x - b.x) * (target.y - c.y)) / denominator;
    const wb = ((c.y - a.y) * (target.x - c.x) + (a.x - c.x) * (target.y - c.y)) / denominator;
    const wc = 1 - wa - wb;
    if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
    const surfaceDepth = 1 / (wa / a.depth + wb / b.depth + wc / c.depth);
    if (surfaceDepth < target.depth - 0.035) return false;
  }
  return true;
}

/** 兼容旧调用：内部仍按一次查询构建投影缓存（测试/低频路径） */
export function isPointVisible(
  point: Vec3,
  mesh: Mesh,
  camera: OrbitCamera,
  viewport: Viewport,
): boolean {
  const frame = makeCameraFrame(camera, viewport);
  return isPointVisibleWithFrame(point, projectMesh(mesh, frame), frame);
}
