import type { TiltInput, Viewport } from './types.ts';

export interface ControlState {
  pointerId: number | null;
  origin: { x: number; y: number } | null;
  current: { x: number; y: number } | null;
  keys: string[];
}

export type ControlEvent =
  | { type: 'down'; id: number; x: number; y: number; button: number }
  | { type: 'move'; id: number; x: number; y: number }
  | { type: 'up'; id: number }
  | { type: 'cancel'; id: number }
  | { type: 'key'; key: string; down: boolean }
  | { type: 'clear' };

export const DEAD_ZONE = 0.07;
/** 拖出舞台宽度的这个比例即满舵 */
const DRAG_X = 0.26;
const DRAG_Z = 0.3;

const KEY_MAP: Record<string, 'x-' | 'x+' | 'z-' | 'z+'> = {
  ArrowLeft: 'x-', a: 'x-', A: 'x-',
  ArrowRight: 'x+', d: 'x+', D: 'x+',
  ArrowUp: 'z-', w: 'z-', W: 'z-',
  ArrowDown: 'z+', s: 'z+', S: 'z+',
};

export function isTiltKey(key: string): boolean {
  return key in KEY_MAP;
}

export function createControl(): ControlState {
  return { pointerId: null, origin: null, current: null, keys: [] };
}

const clamp1 = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);
const dead = (v: number) => (Math.abs(v) < DEAD_ZONE ? 0 : v);

export function pointerTilt(state: ControlState, viewport: Viewport): TiltInput {
  if (!state.origin || !state.current) return { x: 0, z: 0 };
  const dx = state.current.x - state.origin.x;
  const dz = state.current.y - state.origin.y;
  return {
    x: dead(clamp1(dx / Math.max(24, viewport.width * DRAG_X))),
    z: dead(clamp1(dz / Math.max(24, viewport.height * DRAG_Z))),
  };
}

export function keyTilt(state: ControlState): TiltInput {
  let x = 0;
  let z = 0;
  for (const key of state.keys) {
    const dir = KEY_MAP[key];
    if (dir === 'x-') x -= 1;
    else if (dir === 'x+') x += 1;
    else if (dir === 'z-') z -= 1;
    else if (dir === 'z+') z += 1;
  }
  return { x: clamp1(x), z: clamp1(z) };
}

/** 指针优先：拖着的时候按键不叠加，避免两套输入互相打架 */
export function controlTilt(state: ControlState, viewport: Viewport): TiltInput {
  if (state.pointerId !== null) return pointerTilt(state, viewport);
  return keyTilt(state);
}

export function reduceControl(
  state: ControlState,
  event: ControlEvent,
): { state: ControlState; changed: boolean } {
  switch (event.type) {
    case 'down': {
      // 只接受主键；已有一个活动指针时忽略多余手指
      if (event.button !== 0 || state.pointerId !== null) return { state, changed: false };
      return {
        state: { ...state, pointerId: event.id, origin: { x: event.x, y: event.y }, current: { x: event.x, y: event.y } },
        changed: true,
      };
    }
    case 'move': {
      if (state.pointerId !== event.id || !state.origin) return { state, changed: false };
      return { state: { ...state, current: { x: event.x, y: event.y } }, changed: true };
    }
    case 'up':
    case 'cancel': {
      if (state.pointerId !== event.id) return { state, changed: false };
      return { state: { ...state, pointerId: null, origin: null, current: null }, changed: true };
    }
    case 'key': {
      if (!isTiltKey(event.key)) return { state, changed: false };
      const has = state.keys.includes(event.key);
      if (event.down === has) return { state, changed: false };
      // 同一方向的两种写法（方向键与 WASD）只保留一个，松一个不会误清另一个
      const keys = event.down
        ? [...state.keys.filter((k) => KEY_MAP[k] !== KEY_MAP[event.key]), event.key]
        : state.keys.filter((k) => k !== event.key);
      return { state: { ...state, keys }, changed: true };
    }
    case 'clear':
      return { state: createControl(), changed: true };
  }
}