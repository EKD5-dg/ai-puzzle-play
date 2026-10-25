import type { IllusionHint, IllusionLevel, IllusionSession } from './types.ts';

function coreIds(level: IllusionLevel): string[] {
  return level.nodes.filter((node) => node.core).map((node) => node.id);
}

function neighbors(
  level: IllusionLevel,
  node: string,
  unlocked: ReadonlySet<string>,
  includeLocked = false,
): string[] {
  const result: string[] = [];
  for (const [a, b] of level.edges) {
    if (a === node) result.push(b);
    else if (b === node) result.push(a);
  }
  for (const edge of level.illusions) {
    if (!includeLocked && !unlocked.has(edge.id)) continue;
    if (edge.a === node) result.push(edge.b);
    else if (edge.b === node) result.push(edge.a);
  }
  return result;
}

function withCore(level: IllusionLevel, session: IllusionSession, node: string): string[] {
  const target = level.nodes.find((item) => item.id === node);
  if (!target?.core || session.collected.includes(node)) return session.collected;
  return [...session.collected, node];
}

function isComplete(level: IllusionLevel, node: string, collected: string[]): boolean {
  return node === level.exit && collected.length === coreIds(level).length;
}

export function createSession(level: IllusionLevel): IllusionSession {
  const collected = level.nodes.find((node) => node.id === level.start)?.core ? [level.start] : [];
  return {
    node: level.start,
    collected,
    unlocked: [],
    moves: 0,
    complete: isComplete(level, level.start, collected),
  };
}

export function findPath(
  level: IllusionLevel,
  from: string,
  to: string,
  unlocked: ReadonlySet<string>,
): string[] | null {
  if (from === to) return [from];
  const queue: Array<{ node: string; path: string[] }> = [{ node: from, path: [from] }];
  const visited = new Set([from]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const next of neighbors(level, current.node, unlocked)) {
      if (visited.has(next)) continue;
      const path = [...current.path, next];
      if (next === to) return path;
      visited.add(next);
      queue.push({ node: next, path });
    }
  }
  return null;
}

export function reachableNodes(level: IllusionLevel, session: IllusionSession): string[] {
  const unlocked = new Set(session.unlocked);
  return level.nodes
    .map((node) => node.id)
    .filter((node) => findPath(level, session.node, node, unlocked) !== null);
}

export function unlockIllusion(
  level: IllusionLevel,
  session: IllusionSession,
  illusionId: string,
): IllusionSession {
  const edge = level.illusions.find((item) => item.id === illusionId);
  if (!edge || session.complete || session.unlocked.includes(illusionId)) return session;
  if (session.node !== edge.a && session.node !== edge.b) return session;
  return { ...session, unlocked: [...session.unlocked, illusionId] };
}

export function advanceSession(
  level: IllusionLevel,
  session: IllusionSession,
  next: string,
): IllusionSession {
  if (session.complete) return session;
  const path = findPath(level, session.node, next, new Set(session.unlocked));
  if (!path || path.length !== 2) return session;
  const collected = withCore(level, session, next);
  return {
    ...session,
    node: next,
    collected,
    moves: session.moves + 1,
    complete: isComplete(level, next, collected),
  };
}

export function advanceWalk(
  level: IllusionLevel,
  session: IllusionSession,
  path: string[],
  segment: number,
): { session: IllusionSession; segment: number; done: boolean } {
  if (segment >= path.length - 1) return { session, segment, done: true };
  const next = advanceSession(level, session, path[segment + 1]);
  const nextSegment = segment + 1;
  return {
    session: next,
    segment: nextSegment,
    done: next === session || next.complete || nextSegment >= path.length - 1,
  };
}

export function solve(level: IllusionLevel, session: IllusionSession): string[] | null {
  if (session.complete) return [session.node];
  const cores = coreIds(level);
  const coreBits = new Map(cores.map((id, index) => [id, 1 << index]));
  const fullMask = (1 << cores.length) - 1;
  const initialMask = session.collected.reduce((mask, id) => mask | (coreBits.get(id) ?? 0), 0);
  const queue: Array<{ node: string; mask: number; path: string[] }> = [
    { node: session.node, mask: initialMask, path: [session.node] },
  ];
  const visited = new Set([`${session.node}:${initialMask}`]);
  const unlocked = new Set(session.unlocked);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const next of neighbors(level, current.node, unlocked, true)) {
      const mask = current.mask | (coreBits.get(next) ?? 0);
      const path = [...current.path, next];
      if (next === level.exit && mask === fullMask) return path;
      const key = `${next}:${mask}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ node: next, mask, path });
    }
  }
  return null;
}

export function parMoves(level: IllusionLevel): number {
  const solution = solve(level, createSession(level));
  if (!solution) throw new Error(`Unsolvable illusion level: ${level.id}`);
  return solution.length - 1;
}

export function getHint(level: IllusionLevel, session: IllusionSession): IllusionHint | null {
  const solution = solve(level, session);
  if (!solution || solution.length < 2) return null;
  const next = solution[1];
  const illusion = level.illusions.find(
    (edge) =>
      (edge.a === session.node && edge.b === next) ||
      (edge.b === session.node && edge.a === next),
  );
  if (illusion && !session.unlocked.includes(illusion.id)) {
    return { type: 'align', illusion: illusion.id };
  }
  return { type: 'move', node: next };
}

export function starsFor(moves: number, par: number): 1 | 2 | 3 {
  if (moves <= par) return 3;
  if (moves <= par + 2) return 2;
  return 1;
}
