/**
 * 全部游戏的元信息集中定义（唯一权威来源）。
 * 游戏组件与注册表均从这里导入 meta，避免静态导入游戏文件导致无法按需分包。
 */
import type { GameMeta } from './types';

/** 愤怒小鸟图标：SVG 绘制，全平台颜色一致（emoji 的鸟在 Android 上是蓝色） */
export function RedBirdIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 64 64" aria-hidden>
      {/* 尾部羽毛 */}
      <path d="M6 26l10 6-10 8z" fill="#2b1510" />
      <path d="M4 32l12 2-8 10z" fill="#2b1510" />
      <path d="M9 40l10-2-4 12z" fill="#2b1510" />
      {/* 身体 */}
      <circle cx="30" cy="36" r="22" fill="#d93a2b" />
      {/* 头冠 */}
      <circle cx="23" cy="11" r="4.5" fill="#d93a2b" />
      <circle cx="30" cy="7.5" r="5" fill="#d93a2b" />
      <circle cx="37" cy="11" r="4.5" fill="#d93a2b" />
      {/* 肚皮 */}
      <ellipse cx="28" cy="44" rx="13" ry="10" fill="#f6d6a0" />
      {/* 眼睛 */}
      <circle cx="24" cy="27" r="5.5" fill="#fff" />
      <circle cx="38" cy="27" r="5.5" fill="#fff" />
      <circle cx="26.5" cy="27.5" r="2.6" fill="#2b1510" />
      <circle cx="40.5" cy="27.5" r="2.6" fill="#2b1510" />
      {/* 愤怒的眉毛 */}
      <path d="M16 17l12 5" stroke="#2b1510" strokeWidth="3.6" strokeLinecap="round" />
      <path d="M46 17l-12 5" stroke="#2b1510" strokeWidth="3.6" strokeLinecap="round" />
      {/* 嘴 */}
      <path d="M30 34l15 4-15 4z" fill="#f59e1e" />
      <path d="M32 42l11 1.5-11 3z" fill="#d97b0a" />
    </svg>
  );
}

export const meta2048: GameMeta = {
  id: 'game-2048',
  title: '2048',
  description: '合并相同数字，冲击 2048！',
  icon: '🔢',
  difficulty: '中等',
  category: '逻辑',
  tags: ['数字', '合并'],
  bestScoreLabel: '最高分',
  higherIsBetter: true,
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
  higherIsBetter: false,
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
  higherIsBetter: false,
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
  higherIsBetter: false,
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
  higherIsBetter: false,
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
  higherIsBetter: true,
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
  higherIsBetter: true,
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
  higherIsBetter: false,
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
  higherIsBetter: true,
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
  higherIsBetter: true,
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
  higherIsBetter: true,
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
  higherIsBetter: true,
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
  higherIsBetter: true,
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
  higherIsBetter: true,
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
  higherIsBetter: true,
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
  higherIsBetter: true,
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
  higherIsBetter: true,
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
  higherIsBetter: true,
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
  higherIsBetter: true,
};

export const metaBirds: GameMeta = {
  id: 'angry-birds',
  title: '愤怒的小鸟',
  description: '拉弹弓发射小鸟，砸毁猪猪的堡垒！',
  icon: <RedBirdIcon />,
  difficulty: '中等',
  category: '经典',
  tags: ['物理', '弹射'],
  bestScoreLabel: '最高关卡',
  higherIsBetter: true,
};

export const metaCube: GameMeta = {
  id: 'rubiks-cube',
  title: '3D 魔方',
  description: '旋转魔方各层，还原六面颜色！',
  icon: '🧊',
  difficulty: '困难',
  category: '逻辑',
  tags: ['3D', '空间', '经典'],
  bestScoreLabel: '最快还原',
  higherIsBetter: false,
};

export const metaMaze3D: GameMeta = {
  id: 'maze-3d',
  title: '3D 迷宫',
  description: '第一人称视角探索迷宫，集齐宝石开启传送门逃脱！',
  icon: '🌀',
  difficulty: '中等',
  category: '经典',
  tags: ['3D', '迷宫', '街机'],
  bestScoreLabel: '最快逃脱',
  higherIsBetter: false,
};

export const metaPong3D: GameMeta = {
  id: 'pong-3d',
  title: '3D 乒乓球',
  description: '在霓虹隧道中迎战 AI，挥拍加旋，逐级加速别漏球！',
  icon: '🏓',
  difficulty: '中等',
  category: '经典',
  tags: ['3D', '街机', '对战'],
  bestScoreLabel: '最高分',
  higherIsBetter: true,
};

export const metaSki3D: GameMeta = {
  id: 'ski-3d',
  title: '3D 滑雪冲刺',
  description: '从雪山之巅俯冲而下，避开障碍收集宝石，滑得更远！',
  icon: '⛷️',
  difficulty: '中等',
  category: '反应',
  tags: ['3D', '躲避', '竞速'],
  bestScoreLabel: '最远距离',
  higherIsBetter: true,
};

export const metaStack3D: GameMeta = {
  id: 'stack-3d',
  title: '3D 层层叠',
  description: '看准时机放下滑行方块，悬空部分被切落，堆出你的通天塔！',
  icon: '🗼',
  difficulty: '简单',
  category: '反应',
  tags: ['3D', '堆叠', '手速'],
  bestScoreLabel: '最高层数',
  higherIsBetter: true,
};

export const metaTunnel3D: GameMeta = {
  id: 'tunnel-3d',
  title: '3D 星空隧道',
  description: '驾驶飞船穿越旋转能量环与陨石群，收集核心飞得更远！',
  icon: '🌌',
  difficulty: '中等',
  category: '反应',
  tags: ['3D', '躲避', '飞行'],
  bestScoreLabel: '最远距离',
  higherIsBetter: true,
};

export const metaTactics3D: GameMeta = {
  id: 'tactics-3d',
  title: '3D 战棋',
  description: '等距 3D 战棋对决：指挥三位英雄抢占高地，全歼兽人军团！',
  icon: '⚔️',
  difficulty: '中等',
  category: '策略',
  tags: ['3D', '战棋', '回合制'],
  bestScoreLabel: '最少回合',
  higherIsBetter: false,
};

/** 成绩比较方向权威表：false=成绩越小越好（步数/时间类）。由各 meta 派生，云同步服务端也内置了同样白名单（functions/api/sync.js），新增"成绩取小"的游戏需两处同步 */
export const HIGHER_IS_BETTER: Record<string, boolean> = Object.fromEntries(
  [
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
    metaTactics3D,
  ].map((m) => [m.id, m.higherIsBetter]),
);

