import type { GameDefinition } from './types';
import Game2048, { meta as meta2048 } from '../games/Game2048';
import Minesweeper, { meta as metaMines } from '../games/Minesweeper';
import MemoryMatch, { meta as metaMemory } from '../games/MemoryMatch';
import SlidingPuzzle, { meta as metaSliding } from '../games/SlidingPuzzle';
import Sudoku, { meta as metaSudoku } from '../games/Sudoku';
import Tetris, { meta as metaTetris } from '../games/Tetris';
import DragonQuest, { meta as metaDragon } from '../games/DragonQuest';
import Sokoban, { meta as metaSokoban } from '../games/Sokoban';
import Snake, { meta as metaSnake } from '../games/Snake';
import Gomoku, { meta as metaGomoku } from '../games/Gomoku';
import Othello, { meta as metaOthello } from '../games/Othello';
import PacMan, { meta as metaPacMan } from '../games/PacMan';
import SpaceInvaders, { meta as metaInvaders } from '../games/SpaceInvaders';
import Frogger, { meta as metaFrogger } from '../games/Frogger';
import WhackMole, { meta as metaMole } from '../games/WhackMole';

/**
 * 游戏注册表 —— 新增游戏的唯一入口：
 * 在这里追加一条 { meta, component } 即可自动出现在大厅、
 * 获得路由与成绩持久化，无需改动任何其他代码。
 */
export const games: GameDefinition[] = [
  { meta: meta2048, component: Game2048 },
  { meta: metaMines, component: Minesweeper },
  { meta: metaMemory, component: MemoryMatch },
  { meta: metaSliding, component: SlidingPuzzle },
  { meta: metaSudoku, component: Sudoku },
  { meta: metaTetris, component: Tetris },
  { meta: metaDragon, component: DragonQuest },
  { meta: metaSokoban, component: Sokoban },
  { meta: metaSnake, component: Snake },
  { meta: metaGomoku, component: Gomoku },
  { meta: metaOthello, component: Othello },
  { meta: metaPacMan, component: PacMan },
  { meta: metaInvaders, component: SpaceInvaders },
  { meta: metaFrogger, component: Frogger },
  { meta: metaMole, component: WhackMole },
];

/** 按 id 查找游戏 */
export function findGame(id: string): GameDefinition | undefined {
  return games.find((g) => g.meta.id === id);
}
