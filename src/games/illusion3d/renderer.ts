import { isPointVisible } from './geometry.ts';
import type { FaceMaterial, Mesh } from './geometry.ts';
import { cameraPosition, projectPoint, runeAnchor } from './projection.ts';
import type { AlignmentCandidate, AlignmentState, OrbitCamera, Viewport } from './projection.ts';
import type { IllusionHint, IllusionLevel, IllusionSession, LevelNode, Vec3 } from './types.ts';

type RenderMaterial = FaceMaterial | 'core' | 'cloak' | 'skin' | 'scarf';

interface RenderTriangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  normal: Vec3;
  material: RenderMaterial;
}

export interface TravelerVisual {
  position: Vec3;
  moving: boolean;
  phase: number;
}

export interface RenderFrame {
  level: IllusionLevel;
  session: IllusionSession;
  mesh: Mesh;
  camera: OrbitCamera;
  viewport: Viewport;
  traveler: TravelerVisual;
  visibleNodes: ReadonlySet<string>;
  reachable: ReadonlySet<string>;
  candidate: AlignmentCandidate | null;
  alignment: AlignmentState;
  hint: IllusionHint | null;
  selected: string | null;
  time: number;
}

export interface NodeHit {
  id: string;
  x: number;
  y: number;
  radius: number;
}

const PALETTE: Record<RenderMaterial, readonly [number, number, number]> = {
  cap: [211, 204, 182],
  stone: [133, 151, 153],
  path: [177, 183, 166],
  bridge: [245, 190, 88],
  underside: [55, 78, 88],
  gate: [126, 153, 158],
  core: [255, 205, 96],
  cloak: [198, 74, 69],
  skin: [239, 207, 163],
  scarf: [239, 137, 79],
};

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

function makeTriangle(a: Vec3, b: Vec3, c: Vec3, material: RenderMaterial, inside: Vec3): RenderTriangle {
  let normal = normalize(cross(sub(b, a), sub(c, a)));
  let second = b;
  let third = c;
  const faceCenter = scale(add(add(a, b), c), 1 / 3);
  if (dot(normal, sub(faceCenter, inside)) < 0) {
    second = c;
    third = b;
    normal = scale(normal, -1);
  }
  return { a, b: second, c: third, normal, material };
}

function octahedron(center: Vec3, radius: number, angle: number, material: RenderMaterial): RenderTriangle[] {
  const top = add(center, [0, radius * 1.3, 0]);
  const bottom = add(center, [0, -radius * 1.3, 0]);
  const ring: Vec3[] = [];
  for (let index = 0; index < 4; index += 1) {
    const theta = angle + index * Math.PI / 2;
    ring.push(add(center, [Math.cos(theta) * radius, 0, Math.sin(theta) * radius]));
  }
  const triangles: RenderTriangle[] = [];
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    triangles.push(makeTriangle(top, ring[index], ring[next], material, center));
    triangles.push(makeTriangle(bottom, ring[next], ring[index], material, center));
  }
  return triangles;
}

function cloak(position: Vec3, bob: number): RenderTriangle[] {
  const center = add(position, [0, 0.28 + bob, 0]);
  const bottom: Vec3[] = [];
  const top: Vec3[] = [];
  for (let index = 0; index < 8; index += 1) {
    const angle = index * Math.PI / 4;
    bottom.push(add(position, [Math.cos(angle) * 0.18, 0.04 + bob, Math.sin(angle) * 0.18]));
    top.push(add(position, [Math.cos(angle) * 0.075, 0.5 + bob, Math.sin(angle) * 0.075]));
  }
  const triangles: RenderTriangle[] = [];
  for (let index = 0; index < 8; index += 1) {
    const next = (index + 1) % 8;
    triangles.push(makeTriangle(bottom[index], bottom[next], top[next], 'cloak', center));
    triangles.push(makeTriangle(bottom[index], top[next], top[index], 'cloak', center));
  }
  triangles.push(...octahedron(add(position, [0, 0.64 + bob, 0]), 0.12, Math.PI / 4, 'skin'));
  triangles.push(makeTriangle(
    add(position, [-0.07, 0.49 + bob, 0.07]),
    add(position, [0.1, 0.47 + bob, 0.08]),
    add(position, [0.26, 0.32 + bob, 0.18]),
    'scarf',
    add(position, [0, -1, 0]),
  ));
  return triangles;
}

function shade(material: RenderMaterial, normal: Vec3, depth: number): string {
  const light = normalize([-0.45, 0.85, 0.3]);
  const emissive = material === 'bridge' || material === 'core';
  const brightness = emissive ? 0.9 + Math.max(0, dot(normal, light)) * 0.1 : 0.5 + Math.max(0, dot(normal, light)) * 0.5;
  const fog = Math.max(0, Math.min(0.38, (depth - 12) / 28));
  const base = PALETTE[material];
  const channels = base.map((channel, index) => {
    const fogColor = [19, 39, 51][index];
    return Math.round(channel * brightness * (1 - fog) + fogColor * fog);
  });
  return `rgb(${channels[0]},${channels[1]},${channels[2]})`;
}

function drawBackground(ctx: CanvasRenderingContext2D, viewport: Viewport, time: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, viewport.height);
  sky.addColorStop(0, '#071827');
  sky.addColorStop(0.58, '#123744');
  sky.addColorStop(1, '#28535a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  const aura = ctx.createRadialGradient(
    viewport.width * 0.72,
    viewport.height * 0.18,
    0,
    viewport.width * 0.72,
    viewport.height * 0.18,
    viewport.width * 0.55,
  );
  aura.addColorStop(0, 'rgba(88,156,160,0.18)');
  aura.addColorStop(1, 'rgba(8,24,39,0)');
  ctx.fillStyle = aura;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  ctx.fillStyle = '#c5e4df';
  for (let index = 0; index < 52; index += 1) {
    const hx = Math.abs(Math.sin(index * 127.1 + 31.7) * 43758.5453) % 1;
    const hy = Math.abs(Math.sin(index * 269.5 + 11.3) * 18347.2341) % 1;
    const size = 0.55 + (index % 4) * 0.28;
    ctx.globalAlpha = 0.18 + (index % 5) * 0.07 + Math.sin(time * 0.4 + index) * 0.025;
    ctx.fillRect(hx * viewport.width, hy * viewport.height * 0.72, size, size);
  }
  ctx.globalAlpha = 1;
}

function tracePolygon(ctx: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>): void {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) ctx.lineTo(points[index].x, points[index].y);
  ctx.closePath();
}

function drawPortal(ctx: CanvasRenderingContext2D, frame: RenderFrame): void {
  const node = frame.level.nodes.find((item) => item.id === frame.level.exit);
  if (!node || !frame.visibleNodes.has(node.id)) return;
  const center = add(node.p, [0, 0.56, 0]);
  if (!isPointVisible(center, frame.mesh, frame.camera, frame.viewport)) return;
  const right: Vec3 = [Math.cos(frame.level.camera.yaw), 0, -Math.sin(frame.level.camera.yaw)];
  const points: Vec3[] = [];
  for (let index = 0; index < 28; index += 1) {
    const angle = index / 28 * Math.PI * 2;
    points.push(add(center, add(scale(right, Math.cos(angle) * 0.27), [0, Math.sin(angle) * 0.43, 0])));
  }
  const projected = points.map((point) => projectPoint(point, frame.camera, frame.viewport));
  const open = frame.session.collected.length === frame.level.nodes.filter((item) => item.core).length;
  ctx.save();
  tracePolygon(ctx, projected);
  ctx.fillStyle = open ? `rgba(255,199,100,${0.12 + Math.sin(frame.time * 2) * 0.025})` : 'rgba(77,109,118,0.1)';
  ctx.fill();
  ctx.shadowBlur = open ? 18 : 0;
  ctx.shadowColor = '#ffc96d';
  ctx.strokeStyle = open ? '#ffd584' : '#66858b';
  ctx.lineWidth = open ? 2.4 : 1.4;
  ctx.stroke();
  ctx.restore();
}

function drawGlow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string): void {
  const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
  glow.addColorStop(0, color);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function drawRunes(ctx: CanvasRenderingContext2D, frame: RenderFrame): NodeHit[] {
  const hits: NodeHit[] = [];
  const nodeById = new Map(frame.level.nodes.map((node) => [node.id, node]));
  if (frame.candidate) {
    const edge = frame.level.illusions.find((item) => item.id === frame.candidate?.id);
    if (edge) {
      const a = nodeById.get(edge.a);
      const b = nodeById.get(edge.b);
      if (a && b && frame.visibleNodes.has(a.id) && frame.visibleNodes.has(b.id)) {
        const pa = projectPoint(runeAnchor(a.p), frame.camera, frame.viewport);
        const pb = projectPoint(runeAnchor(b.p), frame.camera, frame.viewport);
        const alpha = Math.max(0.08, 1 - frame.candidate.gap / 42);
        ctx.save();
        ctx.strokeStyle = `rgba(255,209,119,${alpha})`;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 5]);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  for (const node of frame.level.nodes) {
    if (!frame.visibleNodes.has(node.id)) continue;
    const projected = projectPoint(node.p, frame.camera, frame.viewport);
    if (projected.depth <= 0.05) continue;
    if (projected.x < -20 || projected.x > frame.viewport.width + 20 || projected.y < -20 || projected.y > frame.viewport.height + 20) continue;
    hits.push({ id: node.id, x: projected.x, y: projected.y, radius: Math.max(12, Math.min(30, projected.scale * 0.48)) });

    const activeTarget = frame.selected === node.id || (frame.hint?.type === 'move' && frame.hint.node === node.id);
    if (frame.reachable.has(node.id) && node.id !== frame.session.node) {
      ctx.beginPath();
      ctx.arc(projected.x, projected.y, activeTarget ? 8 + Math.sin(frame.time * 4) : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = activeTarget ? '#ffe0a0' : 'rgba(121,225,211,0.78)';
      ctx.fill();
    }

    const pending = frame.level.illusions.filter(
      (edge) => !frame.session.unlocked.includes(edge.id) && (edge.a === node.id || edge.b === node.id),
    );
    if (pending.length === 0) continue;
    const anchor = runeAnchor(node.p);
    if (!isPointVisible(anchor, frame.mesh, frame.camera, frame.viewport)) continue;
    const rune = projectPoint(anchor, frame.camera, frame.viewport);
    const eligible = frame.session.node === node.id;
    const candidate = pending.some((edge) => frame.candidate?.id === edge.id);
    const hinted = pending.some((edge) => frame.hint?.type === 'align' && frame.hint.illusion === edge.id);
    const charging = pending.some((edge) => frame.alignment.edgeId === edge.id);
    const radius = Math.max(5, Math.min(14, rune.scale * 0.16));

    ctx.save();
    ctx.strokeStyle = 'rgba(132,202,197,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(projected.x, projected.y);
    ctx.lineTo(rune.x, rune.y);
    ctx.stroke();
    if (candidate || hinted) drawGlow(ctx, rune.x, rune.y, radius * 3.2, 'rgba(255,196,91,0.22)');
    ctx.strokeStyle = candidate || hinted ? '#ffd37e' : eligible ? '#83ddd0' : 'rgba(132,184,185,0.55)';
    ctx.lineWidth = eligible ? 2 : 1.2;
    ctx.setLineDash(eligible ? [] : [3, 3]);
    ctx.beginPath();
    ctx.arc(rune.x, rune.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(rune.x, rune.y, radius * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = candidate || hinted ? '#ffe3a5' : eligible ? '#b0f0df' : 'rgba(136,183,184,0.55)';
    ctx.fill();
    if (charging && eligible) {
      ctx.beginPath();
      ctx.arc(rune.x, rune.y, radius + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frame.alignment.charge / 0.26);
      ctx.strokeStyle = '#fff0b8';
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }
    ctx.restore();
  }
  return hits;
}

function drawLabel(ctx: CanvasRenderingContext2D, node: LevelNode, frame: RenderFrame): void {
  const point = projectPoint(add(node.p, [0, -0.18, 0]), frame.camera, frame.viewport);
  ctx.save();
  ctx.font = '11px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const width = ctx.measureText(node.label).width + 16;
  ctx.fillStyle = 'rgba(5,20,29,0.82)';
  ctx.fillRect(point.x - width / 2, point.y + 10, width, 23);
  ctx.fillStyle = '#e5f0e8';
  ctx.fillText(node.label, point.x, point.y + 22);
  ctx.restore();
}

export function drawScene(ctx: CanvasRenderingContext2D, frame: RenderFrame): NodeHit[] {
  drawBackground(ctx, frame.viewport, frame.time);
  const triangles: RenderTriangle[] = [...frame.mesh];
  for (const node of frame.level.nodes) {
    if (!node.core || frame.session.collected.includes(node.id) || !frame.visibleNodes.has(node.id)) continue;
    const center = add(node.p, [0, 0.76 + Math.sin(frame.time * 2.1 + node.p[0]) * 0.05, 0]);
    triangles.push(...octahedron(center, 0.19, frame.time * 0.9 + node.p[2], 'core'));
  }
  const bob = frame.traveler.moving ? Math.sin(frame.traveler.phase * Math.PI * 2) * 0.025 : 0;
  triangles.push(...cloak(frame.traveler.position, bob));

  const eye = cameraPosition(frame.camera);
  const visible = triangles.flatMap((triangle) => {
    if (dot(triangle.normal, sub(eye, triangle.a)) <= 0) return [];
    const points = [triangle.a, triangle.b, triangle.c].map((point) => projectPoint(point, frame.camera, frame.viewport));
    if (points.some((point) => point.depth <= 0.05)) return [];
    return [{ triangle, points, depth: (points[0].depth + points[1].depth + points[2].depth) / 3 }];
  });
  visible.sort((a, b) => b.depth - a.depth);
  for (const item of visible) {
    tracePolygon(ctx, item.points);
    ctx.fillStyle = shade(item.triangle.material, item.triangle.normal, item.depth);
    ctx.fill();
    ctx.strokeStyle = item.triangle.material === 'bridge' ? 'rgba(255,232,167,0.42)' : 'rgba(225,239,226,0.1)';
    ctx.lineWidth = 0.55;
    ctx.stroke();
  }

  for (const node of frame.level.nodes) {
    if (!node.core || frame.session.collected.includes(node.id) || !frame.visibleNodes.has(node.id)) continue;
    const center = add(node.p, [0, 0.76 + Math.sin(frame.time * 2.1 + node.p[0]) * 0.05, 0]);
    if (!isPointVisible(center, frame.mesh, frame.camera, frame.viewport)) continue;
    const point = projectPoint(center, frame.camera, frame.viewport);
    drawGlow(ctx, point.x, point.y, Math.max(12, point.scale * 0.42), 'rgba(255,190,75,0.24)');
  }

  drawPortal(ctx, frame);
  const hits = drawRunes(ctx, frame);
  const labelId = frame.selected ?? (frame.hint?.type === 'move' ? frame.hint.node : null);
  const labelNode = frame.level.nodes.find((node) => node.id === labelId && frame.visibleNodes.has(node.id));
  if (labelNode) drawLabel(ctx, labelNode, frame);
  return hits;
}
