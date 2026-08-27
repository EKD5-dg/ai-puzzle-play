import { lazy } from 'react';
import type { GameDefinition } from './types';
import {
  meta2048,
  metaMines,
  metaMemory,
  metaSliding,
  metaSudoku,
  metaTetris,
  metaDragon,
  metaSokoban,
  metaSnake,
  metaGomoku,
  metaOthello,
  metaPacMan,
  metaInvaders,
  metaFrogger,
  metaMole,
  metaTaiko,
  metaSimon,
  metaDigit,
  metaColorSeq,
  metaBirds,
  metaCube,
  metaMaze3D,
  metaPong3D,
  metaSki3D,
  metaStack3D,
  metaTunnel3D,
} from './gameMetas';

/**
 * 游戏注册表 —— 新增游戏的唯一入口：
 * 在这里追加一条 { meta, component } 即可自动出现在大厅、
 * 获得路由与成绩持久化，无需改动任何其他代码。
 * 组件使用 React.lazy 懒加载：首屏只下载大厅与公共代码，
 * 游戏代码按需分包，进入游戏时才加载对应 chunk。
 */
export const games: GameDefinition[] = [
  { meta: meta2048, component: lazy(() => import('../games/Game2048')) },
  { meta: metaMines, component: lazy(() => import('../games/Minesweeper')) },
  { meta: metaMemory, component: lazy(() => import('../games/MemoryMatch')) },
  { meta: metaSliding, component: lazy(() => import('../games/SlidingPuzzle')) },
  { meta: metaSudoku, component: lazy(() => import('../games/Sudoku')) },
  { meta: metaTetris, component: lazy(() => import('../games/Tetris')) },
  { meta: metaDragon, component: lazy(() => import('../games/DragonQuest')) },
  { meta: metaSokoban, component: lazy(() => import('../games/Sokoban')) },
  { meta: metaSnake, component: lazy(() => import('../games/Snake')) },
  { meta: metaGomoku, component: lazy(() => import('../games/Gomoku')) },
  { meta: metaOthello, component: lazy(() => import('../games/Othello')) },
  { meta: metaPacMan, component: lazy(() => import('../games/PacMan')) },
  { meta: metaInvaders, component: lazy(() => import('../games/SpaceInvaders')) },
  { meta: metaFrogger, component: lazy(() => import('../games/Frogger')) },
  { meta: metaMole, component: lazy(() => import('../games/WhackMole')) },
  { meta: metaTaiko, component: lazy(() => import('../games/Taiko')) },
  { meta: metaSimon, component: lazy(() => import('../games/Simon')) },
  { meta: metaDigit, component: lazy(() => import('../games/DigitMemory')) },
  { meta: metaColorSeq, component: lazy(() => import('../games/ColorSequence')) },
  { meta: metaBirds, component: lazy(() => import('../games/AngryBirds')) },
  { meta: metaCube, component: lazy(() => import('../games/RubiksCube')) },
  { meta: metaMaze3D, component: lazy(() => import('../games/Maze3D')) },
  { meta: metaPong3D, component: lazy(() => import('../games/Pong3D')) },
  { meta: metaSki3D, component: lazy(() => import('../games/Ski3D')) },
  { meta: metaStack3D, component: lazy(() => import('../games/Stack3D')) },
  { meta: metaTunnel3D, component: lazy(() => import('../games/Tunnel3D')) },
];

/** 按 id 查找游戏 */
export function findGame(id: string): GameDefinition | undefined {
  return games.find((g) => g.meta.id === id);
}
