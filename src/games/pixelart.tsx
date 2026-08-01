import { useEffect, useRef } from 'react';

/**
 * 像素精灵引擎：将字符像素矩阵渲染为 Canvas（关闭平滑，纯像素风格）。
 * 所有角色/怪物均为代码手绘，无任何外部图片资源。
 *
 * 绘画规范（参考经典 16-bit RPG 精灵标准）：
 * - 16×16 采用 Q 版 2 头身比例（头 8 行 / 身体 8 行），肩宽 > 腰宽（S 曲线）
 * - 统一 1px 深色描边（Pico-8 深蓝黑，柔和于纯黑）
 * - 每部位 2-3 色阶（高光 / 基色 / 阴影）
 * - 配色采用 Pico-8 经典 16 色板，角色用暖色签名色（勇者红头巾）
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

/* Pico-8 风格调色板 */
const OUTLINE = '#1d2b53'; // Pico-8 深蓝黑（描边）
const RED = '#ff004d'; // Pico-8 红
const ORANGE = '#ffa300'; // Pico-8 橙
const YELLOW = '#ffec27'; // Pico-8 黄
const GREEN = '#00e436'; // Pico-8 绿
const GREEN_DARK = '#008751'; // Pico-8 深绿
const BLUE = '#29adff'; // Pico-8 蓝
const WHITE = '#fff1e8'; // Pico-8 白
const SKIN = '#ffccaa'; // Pico-8 皮肤
const PURPLE = '#83769c'; // Pico-8 紫
const BROWN = '#ab5236'; // Pico-8 棕

/* ============ 勇者：红头巾 · 金发 · 蓝甲 · 佩剑（24×24 特制） ============ */
export const HERO_PIXELS = [
  '.........kkkkk..........',
  '........kkRRRRRkk.......',
  '.......kkRRRRRRRkk......',
  '......kRRkkkkkRRk.......',
  '......kGGGGGGGGGk.......',
  '......kGsssssssGk.......',
  '......kGsWWssWWsGk......',
  '......kGsssssssGk.......',
  '.......kGsssssGk........',
  '........kkkkkkk.........',
  '......kkkkkkkkkkkk......',
  '.....kkBBBBBBBBBBkk.....',
  '......kBbBBBBBBbBk...wW.',
  '......kBBBBBBBBBBk....w.',
  '......kBBBBWWBBBBk....w.',
  '........kBBBBBBk......w.',
  '........kDDDDDDk......w.',
  '.........kBBBBk.......w.',
  '.........kSS..kSS.......',
  '.........kSS..kSS.......',
  '........kSSS..kSSS......',
  '........kkkk..kkkk......',
  '........................',
  '........................',
];

export const HERO_PALETTE: PixelPalette = {
  k: OUTLINE,
  R: RED,
  G: YELLOW,
  s: SKIN,
  W: WHITE,
  w: WHITE,
  B: BLUE,
  b: '#1f7fa8',
  D: ORANGE,
  S: BROWN,
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
  '.kggggggggggggk.',
  '..kkkkkkkkkkkk..',
  '................',
];

/* ============ 骷髅兵 ============ */
const SKELETON_PIXELS = [
  '................',
  '.....wwwwww.....',
  '....wwwwwwww....',
  '....wwwwwwww....',
  '....kkwwwwkk....',
  '....wwwwwwww....',
  '.....wkkkkw.....',
  '.....wwwwww.....',
  '....kkkkkkkk....',
  '..wwwwwwwwwwww..',
  '..wwwwwwwwwwww..',
  '..wkkwwwwwwkkw..',
  '..wwwwwwwwwwww..',
  '..wwwwwwwwwwww..',
  '..wwww..wwww....',
  '................',
];

/* ============ 僵尸 ============ */
const ZOMBIE_PIXELS = [
  '.....kkkk.......',
  '....kggggk......',
  '....kggggk......',
  '....kggggk......',
  '....kggggk......',
  '....krggrk......',
  '....kggggk......',
  '.....kkkk.......',
  '....kddddk......',
  '...kddddddk.....',
  '...kdkddkdk.....',
  '...kddddddk.....',
  '....kddddk......',
  '...kggggk.......',
  '...kggggk.......',
  '................',
];

/* ============ 暗影幽魂 ============ */
const GHOST_PIXELS = [
  '................',
  '................',
  '....pppppp......',
  '...pppppppp.....',
  '...pppppppp.....',
  '...pwwppwwp.....',
  '...pppppppp.....',
  '....pppppp......',
  '....PPPPPP......',
  '....PPPPPP......',
  '...PPPPPPPP.....',
  '..PPPP..PPPP....',
  '.PPPPP....PPPP..',
  '.PPPP......PPPP.',
  '................',
];

/* ============ 火焰魔 ============ */
const FIRE_DEMON_PIXELS = [
  '................',
  '..kkk...kkk.....',
  '..krrk.krrk.....',
  '..krrkkkrrk.....',
  '.kkrrrrrrrkk....',
  '.krrrrrrrrrk....',
  '.krrrrrrrrrk....',
  '..krrrrrrrk.....',
  '...krrwwrrk.....',
  '....kooooook....',
  '...koorrrroook..',
  '..koorrrrrrrook.',
  '..koorrrrrrrook.',
  '...kkkkkkkkkk...',
  '................',
];

/* ============ 恶龙：最终 Boss（大头 Q 版） ============ */
const DRAGON_PIXELS = [
  '.............................',
  '.........kkkkk...............',
  '........kPPPPPk.....kkkk.....',
  '.......kPPPPPPPk...kkPPPPk...',
  '.......kPPkkkPPk..kkPPPPPPk..',
  '......kPPwwwwPPkkkPPPPPPPPk..',
  '......kPPwwwwPPkkPPPPPPPPk...',
  '.......kkkkkkkPPPPPPPPPPk....',
  '.........kPPPPPPPPPPPPk......',
  '.........kPPPkkkkkkkkk.......',
  '.........kPPPyyyyyyyyy.......',
  '........kPPPPPPPPPPPP........',
  '........kPPPPk..kPPPP........',
  '........kkkkkk..kkkkkk.......',
  '.................kkkkk.......',
  '.............................',
];

interface SpriteDef {
  pixels: string[];
  palette: PixelPalette;
}

export const MONSTER_SPRITES: Record<string, SpriteDef> = {
  史莱姆: {
    pixels: SLIME_PIXELS,
    palette: { g: GREEN, h: '#8af2a8', w: WHITE, k: OUTLINE },
  },
  骷髅兵: {
    pixels: SKELETON_PIXELS,
    palette: { w: WHITE, k: OUTLINE },
  },
  僵尸: {
    pixels: ZOMBIE_PIXELS,
    palette: { g: GREEN_DARK, r: RED, d: BROWN, k: OUTLINE },
  },
  暗影幽魂: {
    pixels: GHOST_PIXELS,
    palette: { p: '#b3a4d8', P: PURPLE, w: WHITE },
  },
  火焰魔: {
    pixels: FIRE_DEMON_PIXELS,
    palette: { k: OUTLINE, r: RED, w: YELLOW, o: ORANGE },
  },
  恶龙: {
    pixels: DRAGON_PIXELS,
    palette: { k: OUTLINE, P: '#9a6fd8', w: YELLOW, y: '#ffd9a0' },
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
