/**
 * 全部游戏的元信息集中定义（唯一权威来源）。
 * 游戏组件与注册表均从这里导入 meta，避免静态导入游戏文件导致无法按需分包。
 */
import type { GameMeta } from './types';

export const meta2048: GameMeta = {
  id: 'game-2048',
  title: '2048',
  description: '合并相同数字，冲击 2048！',
  icon: '🔢',
  difficulty: '中等',
  category: '逻辑',
  tags: ['数字', '合并'],
  bestScoreLabel: '最高分',
};

export const metaMines: GameMeta = {
  id: 'minesweeper',
  title: '扫雷',
  description: '推理地雷位置，点击所有安全格！',
  icon: '💣',
  difficulty: '中等',
  category: '逻辑',
  tags: ['推理', '经典'],
  bestScoreLabel: '最快通关',
};

export const metaMemory: GameMeta = {
  id: 'memory-match',
  title: '记忆翻牌',
  description: '记住图案的位置，翻出所有配对！',
  icon: '🃏',
  difficulty: '简单',
  category: '记忆',
  tags: ['配对', '记忆'],
  bestScoreLabel: '最少步数',
};

export const metaSliding: GameMeta = {
  id: 'sliding-puzzle',
  title: '数字华容道',
  description: '滑动方块，按顺序还原数字！',
  icon: '🧩',
  difficulty: '中等',
  category: '逻辑',
  tags: ['滑块', '排序'],
  bestScoreLabel: '最少步数',
};

export const metaSudoku: GameMeta = {
  id: 'sudoku',
  title: '数独',
  description: '每行、每列、每宫填入 1-9 不重复！',
  icon: '🔢',
  difficulty: '困难',
  category: '逻辑',
  tags: ['数字', '推理'],
  bestScoreLabel: '最快完成',
};

export const metaTetris: GameMeta = {
  id: 'tetris',
  title: '俄罗斯方块',
  description: '旋转、下落、消行，挑战你的极限反应！',
  icon: '🧱',
  difficulty: '困难',
  category: '反应',
  tags: ['反应', '经典'],
  bestScoreLabel: '最高分',
};

export const metaDragon: GameMeta = {
  id: 'dragon-quest',
  title: '勇者斗恶龙',
  description: '挑战十层迷宫，升级变强，击败恶龙救出公主！',
  icon: '🐉',
  difficulty: '中等',
  category: '策略',
  tags: ['RPG', '回合制'],
  bestScoreLabel: '最高层数',
};

export const metaSokoban: GameMeta = {
  id: 'sokoban',
  title: '推箱子',
  description: '把箱子推到目标点，规划路线步步为营！',
  icon: '📦',
  difficulty: '中等',
  category: '逻辑',
  tags: ['推箱', '关卡'],
  bestScoreLabel: '最少步数',
};

export const metaSnake: GameMeta = {
  id: 'snake',
  title: '贪吃蛇',
  description: '吃食物变长，避开墙壁和自己！',
  icon: '🐍',
  difficulty: '简单',
  category: '经典',
  tags: ['经典', '街机'],
  bestScoreLabel: '最高分',
};

export const metaGomoku: GameMeta = {
  id: 'gomoku',
  title: '五子棋',
  description: '黑白对弈，五子连珠！挑战电脑 AI！',
  icon: '⚫',
  difficulty: '中等',
  category: '策略',
  tags: ['对战', 'AI'],
  bestScoreLabel: '最多连胜',
};

export const metaOthello: GameMeta = {
  id: 'othello',
  title: '黑白棋',
  description: '翻转棋盘，夹住对方棋子！最后棋子多者胜！',
  icon: '⚪',
  difficulty: '困难',
  category: '策略',
  tags: ['翻转棋', 'AI'],
  bestScoreLabel: '最高胜率',
};

export const metaPacMan: GameMeta = {
  id: 'pac-man',
  title: '吃豆人',
  description: '吃掉所有豆子，躲避幽灵追击！',
  icon: '👻',
  difficulty: '中等',
  category: '经典',
  tags: ['日系', '街机'],
  bestScoreLabel: '最高分',
};

export const metaInvaders: GameMeta = {
  id: 'space-invaders',
  title: '太空侵略者',
  description: '击落外星人军团，保卫地球！',
  icon: '👾',
  difficulty: '中等',
  category: '经典',
  tags: ['日系', '射击'],
  bestScoreLabel: '最高分',
};

export const metaFrogger: GameMeta = {
  id: 'frogger',
  title: '青蛙过河',
  description: '躲过车流、踏着浮木，把青蛙送回家！',
  icon: '🐸',
  difficulty: '中等',
  category: '经典',
  tags: ['日系', '躲避'],
  bestScoreLabel: '最高分',
};

export const metaMole: GameMeta = {
  id: 'whack-mole',
  title: '打地鼠',
  description: '快速敲击冒头的地鼠，30 秒限时挑战！',
  icon: '🔨',
  difficulty: '简单',
  category: '经典',
  tags: ['日系', '街机'],
  bestScoreLabel: '最高分',
};

export const metaTaiko: GameMeta = {
  id: 'taiko',
  title: '太鼓达人',
  description: '跟随鼓点敲击！咚（红）咔（蓝）！',
  icon: '🥁',
  difficulty: '中等',
  category: '反应',
  tags: ['日系', '节奏'],
  bestScoreLabel: '最高分',
};

export const metaSimon: GameMeta = {
  id: 'simon',
  title: '西蒙说',
  description: '记住四色灯的序列，按顺序复述！',
  icon: '🎛️',
  difficulty: '中等',
  category: '记忆',
  tags: ['序列', '经典'],
  bestScoreLabel: '最高轮数',
};

export const metaDigit: GameMeta = {
  id: 'digit-memory',
  title: '数字记忆',
  description: '记住数字序列，按顺序点出来！',
  icon: '🔢',
  difficulty: '简单',
  category: '记忆',
  tags: ['数字', '训练'],
  bestScoreLabel: '最高位数',
};

export const metaColorSeq: GameMeta = {
  id: 'color-sequence',
  title: '颜色序列',
  description: '记住颜色块的闪烁顺序！',
  icon: '🎨',
  difficulty: '简单',
  category: '记忆',
  tags: ['序列', '颜色'],
  bestScoreLabel: '最高轮数',
};

