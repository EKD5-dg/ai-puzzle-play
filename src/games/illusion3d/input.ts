import type { OrbitCamera } from './projection.ts';
import type { IllusionLevel, Vec3 } from './types.ts';

interface GesturePoint {
  id: number;
  x: number;
  y: number;
}

export interface GestureState {
  pointers: GesturePoint[];
  origin: { x: number; y: number } | null;
  dragged: boolean;
  multi: boolean;
  pinch: number;
  slop: number;
}

export type GestureEvent =
  | { type: 'down'; id: number; x: number; y: number; pointerType?: string }
  | { type: 'move'; id: number; x: number; y: number }
  | { type: 'up'; id: number; x: number; y: number }
  | { type: 'cancel'; id: number };

export interface GestureResult {
  state: GestureState;
  orbit: { dx: number; dy: number } | null;
  zoom: number | null;
  tap: { x: number; y: number } | null;
}

function distance(a: GesturePoint, b: GesturePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function idleResult(state: GestureState): GestureResult {
  return { state, orbit: null, zoom: null, tap: null };
}

export function createGesture(): GestureState {
  return { pointers: [], origin: null, dragged: false, multi: false, pinch: 0, slop: 6 };
}

export function reduceGesture(previous: GestureState, event: GestureEvent): GestureResult {
  if (event.type === 'down') {
    const pointers = [...previous.pointers.filter((point) => point.id !== event.id), { id: event.id, x: event.x, y: event.y }];
    if (pointers.length === 1) {
      return idleResult({
        pointers,
        origin: { x: event.x, y: event.y },
        dragged: false,
        multi: false,
        pinch: 0,
        slop: event.pointerType === 'touch' ? 10 : 6,
      });
    }
    return idleResult({
      pointers,
      origin: previous.origin,
      dragged: true,
      multi: true,
      pinch: pointers.length === 2 ? distance(pointers[0], pointers[1]) : previous.pinch,
      slop: previous.slop,
    });
  }

  if (event.type === 'cancel') {
    const pointers = previous.pointers.filter((point) => point.id !== event.id);
    if (pointers.length === 0) return idleResult(createGesture());
    return idleResult({ ...previous, pointers, pinch: 0 });
  }

  const existing = previous.pointers.find((point) => point.id === event.id);
  if (!existing) return idleResult(previous);
  const current = { id: event.id, x: event.x, y: event.y };
  const pointers = previous.pointers.map((point) => point.id === event.id ? current : point);

  if (event.type === 'move') {
    if (pointers.length === 2) {
      const pinch = distance(pointers[0], pointers[1]);
      return {
        state: { ...previous, pointers, dragged: true, pinch },
        orbit: null,
        zoom: previous.pinch > 0 ? pinch / previous.pinch : null,
        tap: null,
      };
    }
    if (pointers.length === 1 && !previous.multi) {
      const dragged = previous.dragged || !previous.origin || Math.hypot(event.x - previous.origin.x, event.y - previous.origin.y) > previous.slop;
      return {
        state: { ...previous, pointers, dragged },
        orbit: { dx: event.x - existing.x, dy: event.y - existing.y },
        zoom: null,
        tap: null,
      };
    }
    return idleResult({ ...previous, pointers });
  }

  const tap = pointers.length === 1 && !previous.dragged && !previous.multi ? { x: event.x, y: event.y } : null;
  const remaining = previous.pointers.filter((point) => point.id !== event.id);
  if (remaining.length === 0) return { state: createGesture(), orbit: null, zoom: null, tap };
  return {
    state: { ...previous, pointers: remaining, origin: { x: remaining[0].x, y: remaining[0].y }, pinch: 0 },
    orbit: null,
    zoom: null,
    tap,
  };
}

export function applyOrbit(camera: OrbitCamera, dx: number, dy: number): OrbitCamera {
  return {
    ...camera,
    yaw: camera.yaw - dx * 0.007,
    pitch: Math.max(0.28, Math.min(1.18, camera.pitch + dy * 0.005)),
  };
}

export function zoomCamera(camera: OrbitCamera, factor: number): OrbitCamera {
  return { ...camera, zoom: Math.max(0.65, Math.min(1.8, camera.zoom * factor)) };
}

export function wheelZoomFactor(deltaY: number, deltaMode: number, viewportHeight: number): number {
  const unit = deltaMode === 1 ? 32 : deltaMode === 2 ? viewportHeight : 1;
  return Math.exp(-deltaY * unit * 0.001);
}

export function walkPosition(
  level: Pick<IllusionLevel, 'nodes'>,
  path: string[],
  segment: number,
  progress: number,
): Vec3 {
  const from = level.nodes.find((node) => node.id === path[segment]);
  const to = level.nodes.find((node) => node.id === path[segment + 1]);
  if (!from || !to) return level.nodes[0].p;
  const t = Math.max(0, Math.min(1, progress));
  return [
    from.p[0] + (to.p[0] - from.p[0]) * t,
    from.p[1] + (to.p[1] - from.p[1]) * t,
    from.p[2] + (to.p[2] - from.p[2]) * t,
  ];
}

export interface TapHit {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export function selectTapTarget(
  hits: readonly TapHit[],
  x: number,
  y: number,
  currentNode: string,
  reachable: ReadonlySet<string>,
  minRadius = 18,
): string | null {
  const candidates = hits
    .map((hit) => ({ hit, distance: Math.hypot(hit.x - x, hit.y - y) }))
    .filter(({ hit, distance }) => distance <= Math.max(minRadius, hit.radius));
  if (candidates.length === 0) return null;
  const preferred = candidates.filter(({ hit }) => hit.id !== currentNode && reachable.has(hit.id));
  const pool = preferred.length > 0 ? preferred : candidates;
  pool.sort((a, b) => a.distance - b.distance);
  return pool[0].hit.id;
}
