import { useEffect, useRef } from 'react';

/**
 * 像素精灵引擎：将字符像素矩阵渲染为 Canvas（关闭平滑，纯像素风格）。
 * 所有角色/怪物均为代码手绘，无任何外部图片资源。
 *
 * 绘画规范（保证观感）：
 * - k 统一为深色描边，勾勒轮廓
 * - 每个角色使用 3 档色阶（亮色高光 / 基色 / 暗色阴影）
 */

export interface PixelPalette {
  [char: string]: string;
}

interface PixelSpriteProps {
  /** 像素矩阵：每行一个字符串，字符对应调色板颜色，'.' 为透明 */
  pixels: string[];
  palette: PixelPalette;
  /** 每像素显示尺寸（px） */
  scale?: number;
  className?: string;
}

export function PixelSprite({ pixels, palette, scale = 5, className }: PixelSpriteProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = false;
    pixels.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const color = palette[row[x]];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    });
  }, [pixels, palette, scale]);

  const h = pixels.length * scale;
  const w = Math.max(...pixels.map((r) => r.length)) * scale;

  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
      className={className}
      style={{ imageRendering: 'pixelated', width: w, height: h }}
    />
  );
}

/* 通用描边色 */
const OUTLINE = '#26263c';

/* ============ 勇者：红头巾 · 金发 · 蓝甲 ============ */
export const HERO_PIXELS = [
  '................',
  '.....kkkkk......',
  '....kRRRRRk.....',
  '....kRRRRRRk....',
  '....kRRRRRRk....',
  '....kRRkkRRk....',
  '.....kRRRRk.....',
  '......GGGG......',
  '.....GssssG.....',
  '.....GsWWsG.....',
  '.....GsWWsG.....',
  '......GssG......',
  '.....kkkkkk.....',
  '....kBbBBbBk....',
  '..kkBBBBBBBBkk..',
  '..kBbBBBBBBbBk..',
  '...kkBBBBBBkk...',
  '....kSSSSSSk....',
  '....kSkkkkSk....',
  '................',
];

export const HERO_PALETTE: PixelPalette = {
  k: OUTLINE,
  R: '#d64545',
  G: '#e8b34b',
  s: '#f2c9a0',
  W: '#ffffff',
  B: '#4a7fc4',
  b: '#33609a',
  S: '#8a5a3a',
};

/* ============ 史莱姆：果冻团子 ============ */
const SLIME_PIXELS = [
  '................',
  '................',
  '......gggg......',
  '....gghhgggg....',
  '...gghhhhgggg...',
  '..gggggggggggg..',
  '..ggwwggggwwgg..',
  '..gggggggggggg..',
  '.gggggggggggggg.',
  '.gggggggggggggg.',
  '.gggggggggggggg.',
  '.GGggggggggggGG.',
  '.kGGGGGGGGGGGGk.',
  '..kkkkkkkkkkkk..',
  '................',
];

/* ============ 骷髅兵 ============ */
const SKELETON_PIXELS = [
  '................',
  '.....kkkkkk.....',
  '....kwwwwwwk....',
  '....kwwwwwwk....',
  '....kwwwwwwk....',
  '....wkkwwkkw....',
  '....wwwwwwww....',
  '.....wkkkkw.....',
  '.....wwwwww.....',
  '.....kkkkkk.....',
  '....kkkkkkkk....',
  '..wwkkwwwwkkww..',
  '..wwwwwwwwwwww..',
  '..wwkwwwwwwkww..',
  '..wwwwwwwwwwww..',
  '..wwwwwwwwwwww..',
  '..kkkkkkkkkkkk..',
  '................',
];

/* ============ 僵尸 ============ */
const ZOMBIE_PIXELS = [
  '................',
  '.....kkkkkk.....',
  '....kggggggk....',
  '....kggggggk....',
  '....kggggggk....',
  '.....kggggk.....',
  '....ksWWWWsk....',
  '....ksWWWWsk....',
  '.....kssssk.....',
  '....kkkkkkkk....',
  '...kddddddddk...',
  '..kddkddddkddk..',
  '..kddddddddddk..',
  '..kddkddddkddk..',
  '...kddddddddk...',
  '....kggggggk....',
  '...kggggggggk...',
  '..kggkggggkggk..',
  '..kkkkkkkkkkkk..',
  '................',
];

/* ============ 暗影幽魂 ============ */
const GHOST_PIXELS = [
  '................',
  '.....pppppp.....',
  '....pppppppp....',
  '....pppppppp....',
  '....pwwppwwp....',
  '....pppppppp....',
  '.....pppppp.....',
  '.....pppppp.....',
  '....PPPPPPPP....',
  '....PPPPPPPP....',
  '.....PPPPPP.....',
  '....PPPPPPPP....',
  '...PPPP..PPPP...',
  '..PPPP....PPPP..',
  '.PPPPP......PPPP',
  '................',
];

/* ============ 火焰魔 ============ */
const FIRE_DEMON_PIXELS = [
  '................',
  '..kkk.....kkk...',
  '..krrk...krrk...',
  '..krrkkkkkrrk...',
  '.kkrrrrrrrrrkk..',
  '.krrrrrrrrrrrk..',
  '.krrwwrrrwwrrk..',
  '.krrrrrrrrrrrk..',
  '..kkrrrrrrrkk...',
  '....kooooook....',
  '...koorrrroook..',
  '..koorrrrrrrook.',
  '.koorrrrrrrrrook',
  '.koorrrrrrrrrook',
  '..koorrrrrrrook.',
  '...kkkkkkkkkk...',
  '................',
];

/* ============ 恶龙：最终 Boss ============ */
const DRAGON_PIXELS = [
  '.............................',
  '......kkkkk..................',
  '.....kPPPPPk......kkkk.......',
  '....kPPPPPPPk...kkPPPPk......',
  '....kPPPPPPPkkkkkPPPPPPk.....',
  '...kPPkkkPPPPPPPPPPPPPPk.....',
  '...kPPwwkkkkPPPPPPPPPPk......',
  '...kPPwwkkkkkPPPPPPPk........',
  '..kkkkkkkkkkkkPPPPPPk........',
  '..kPPkkkkkkkkkkkkkPPk........',
  '.kPPPPyyyyyyyyyyPPPPk........',
  '.kPPPPkkkkkkkkkkkPPPPk.......',
  '.kPPPPk.......kPPPPk.........',
  '.kkkkkk.......kkkkkk.........',
  '............kkkkkkk..........',
  '...........kkkkkkkkk.........',
  '..........kkkkkkkkkkk........',
  '.............................',
];

interface SpriteDef {
  pixels: string[];
  palette: PixelPalette;
}

export const MONSTER_SPRITES: Record<string, SpriteDef> = {
  史莱姆: {
    pixels: SLIME_PIXELS,
    palette: { g: '#4ecf4e', h: '#8df08d', w: '#eaffea', G: '#2f9c38', k: OUTLINE },
  },
  骷髅兵: {
    pixels: SKELETON_PIXELS,
    palette: { w: '#ececf4', k: OUTLINE },
  },
  僵尸: {
    pixels: ZOMBIE_PIXELS,
    palette: { g: '#5fae52', W: '#d8f0d8', s: '#8fd488', d: '#8a5a3a', k: OUTLINE },
  },
  暗影幽魂: {
    pixels: GHOST_PIXELS,
    palette: { p: '#b08cff', P: '#7c4fd8', w: '#f0eaff' },
  },
  火焰魔: {
    pixels: FIRE_DEMON_PIXELS,
    palette: { k: OUTLINE, r: '#e05252', w: '#ffe066', o: '#f08c3a' },
  },
  恶龙: {
    pixels: DRAGON_PIXELS,
    palette: { k: OUTLINE, P: '#8b5cf6', w: '#ffe066', y: '#e8b34b' },
  },
};

/* ============ 楼层场景主题 ============ */
export interface SceneTheme {
  cls: string;
  deco: string[];
  label: string;
}

export function sceneTheme(floor: number): SceneTheme {
  if (floor >= 10) return { cls: 'scene-throne', deco: ['👑', '🔥', '🏰', '⚜️'], label: '王座之间' };
  if (floor >= 9) return { cls: 'scene-volcano', deco: ['🌋', '🔥', '🪨', '💥'], label: '火焰山麓' };
  if (floor >= 7) return { cls: 'scene-shadow', deco: ['👁️', '🌑', '🕸️', '💜'], label: '暗影领域' };
  if (floor >= 5) return { cls: 'scene-grave', deco: ['⚰️', '🌫️', '🕯️', '🦉'], label: '幽暗墓地' };
  if (floor >= 3) return { cls: 'scene-cave', deco: ['🪨', '🕯️', '🦇', '🧱'], label: '地下洞穴' };
  return { cls: 'scene-forest', deco: ['🌲', '🌳', '🍄', '🌿'], label: '翠绿森林' };
}
