import type { CameraView, IllusionLevel, IllusionSession, Vec3 } from './types.ts';

export interface OrbitCamera extends CameraView {
  distance: number;
  zoom: number;
  target: Vec3;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface ProjectedPoint {
  x: number;
  y: number;
  depth: number;
  scale: number;
}

export function runeAnchor(point: Vec3): Vec3 {
  return [point[0], point[1] + 0.5, point[2]];
}

export interface AlignmentCandidate {
  id: string;
  gap: number;
}

export interface AlignmentState {
  edgeId: string | null;
  charge: number;
}

interface CameraBasis {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

/** 每帧复用一次的相机基/焦距：避免每次 projectPoint 都重算三角函数与归一化 */
export interface CameraFrame {
  position: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  focal: number;
  width: number;
  height: number;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
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

export function cameraBasis(camera: OrbitCamera): CameraBasis {
  const cp = Math.cos(camera.pitch);
  const offset: Vec3 = [
    Math.sin(camera.yaw) * cp,
    Math.sin(camera.pitch),
    Math.cos(camera.yaw) * cp,
  ];
  const forward = normalize([-offset[0], -offset[1], -offset[2]]);
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));
  return { right, up, forward };
}

export function cameraPosition(camera: OrbitCamera): Vec3 {
  const cp = Math.cos(camera.pitch);
  return [
    camera.target[0] + Math.sin(camera.yaw) * cp * camera.distance,
    camera.target[1] + Math.sin(camera.pitch) * camera.distance,
    camera.target[2] + Math.cos(camera.yaw) * cp * camera.distance,
  ];
}

export function makeCamera(level: IllusionLevel, view: CameraView = level.camera, zoom = 1): OrbitCamera {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const node of level.nodes) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], node.p[axis]);
      max[axis] = Math.max(max[axis], node.p[axis]);
    }
  }
  const target: Vec3 = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const radius = Math.max(...level.nodes.map((node) => Math.hypot(...sub(node.p, target))));
  return {
    ...view,
    target,
    distance: Math.max(14, radius * 5),
    zoom: zoom * Math.min(1, 3.2 / radius),
  };
}

export function makeCameraFrame(camera: OrbitCamera, viewport: Viewport): CameraFrame {
  const basis = cameraBasis(camera);
  return {
    position: cameraPosition(camera),
    right: basis.right,
    up: basis.up,
    forward: basis.forward,
    focal: Math.min(viewport.width, viewport.height) * 1.4 * camera.zoom * (camera.distance / 10),
    width: viewport.width,
    height: viewport.height,
  };
}

export function projectPointWithFrame(point: Vec3, frame: CameraFrame): ProjectedPoint {
  const relative = sub(point, frame.position);
  const depth = dot(relative, frame.forward);
  const scale = frame.focal / depth;
  return {
    x: frame.width / 2 + dot(relative, frame.right) * scale,
    y: frame.height / 2 - dot(relative, frame.up) * scale,
    depth,
    scale,
  };
}

export function projectPoint(point: Vec3, camera: OrbitCamera, viewport: Viewport): ProjectedPoint {
  return projectPointWithFrame(point, makeCameraFrame(camera, viewport));
}

export function findAlignableEdge(
  level: IllusionLevel,
  session: IllusionSession,
  camera: OrbitCamera,
  viewport: Viewport,
  isVisible: (nodeId: string) => boolean = () => true,
): AlignmentCandidate | null {
  let best: AlignmentCandidate | null = null;
  for (const edge of level.illusions) {
    if (session.unlocked.includes(edge.id)) continue;
    if (session.node !== edge.a && session.node !== edge.b) continue;
    if (edge.a !== session.node && !isVisible(edge.a)) continue;
    if (edge.b !== session.node && !isVisible(edge.b)) continue;
    const a = level.nodes.find((node) => node.id === edge.a);
    const b = level.nodes.find((node) => node.id === edge.b);
    if (!a || !b) continue;
    const pa = projectPoint(runeAnchor(a.p), camera, viewport);
    const pb = projectPoint(runeAnchor(b.p), camera, viewport);
    const onScreen = [pa, pb].every(
      (p) => p.depth > 0.2 && p.x >= 12 && p.x <= viewport.width - 12 && p.y >= 12 && p.y <= viewport.height - 12,
    );
    if (!onScreen) continue;
    const gap = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    if (!best || gap < best.gap) best = { id: edge.id, gap };
  }
  return best;
}

export function stepAlignment(
  previous: AlignmentState,
  candidate: AlignmentCandidate | null,
  dt: number,
  viewport: Viewport,
): { state: AlignmentState; locked: string | null } {
  const enterGap = Math.max(18, Math.min(viewport.width, viewport.height) * 0.055);
  const releaseGap = enterGap * 1.8;
  let state = previous;
  if (candidate && state.edgeId !== candidate.id) state = { edgeId: candidate.id, charge: 0 };

  if (!candidate || candidate.gap > releaseGap) {
    const charge = Math.max(0, state.charge - dt * 2);
    return { state: { edgeId: charge > 0 ? state.edgeId : null, charge }, locked: null };
  }
  if (candidate.gap > enterGap) return { state, locked: null };

  const charge = Math.min(0.26, state.charge + dt);
  if (charge >= 0.26) return { state: { edgeId: null, charge: 0 }, locked: candidate.id };
  return { state: { edgeId: candidate.id, charge }, locked: null };
}
