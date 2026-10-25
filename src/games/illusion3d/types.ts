export type Vec3 = readonly [number, number, number];

export interface CameraView {
  yaw: number;
  pitch: number;
}

export interface LevelNode {
  id: string;
  p: Vec3;
  label: string;
  core?: boolean;
}

export interface IllusionEdge {
  id: string;
  a: string;
  b: string;
  view: CameraView;
}

export interface IllusionLevel {
  id: string;
  name: string;
  subtitle: string;
  start: string;
  exit: string;
  nodes: LevelNode[];
  edges: ReadonlyArray<readonly [string, string]>;
  illusions: IllusionEdge[];
  camera: CameraView;
}

export interface IllusionSession {
  node: string;
  collected: string[];
  unlocked: string[];
  moves: number;
  complete: boolean;
}

export type IllusionHint =
  | { type: 'move'; node: string }
  | { type: 'align'; illusion: string };
