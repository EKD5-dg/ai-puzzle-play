import { useEffect, useRef } from 'react';

/**
 * 像素精灵引擎：将字符像素矩阵渲染为 Canvas（关闭平滑，纯像素风格）。
 * 所有角色/怪物均为代码手绘，无任何外部图片资源。
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

/* ============ 勇者：金发蓝甲剑士 ============ */
export const HERO_PIXELS = [
  '................',
  '......GGGG......',
  '.....GGGGGG.....',
  '.....GyyyyG.....',
  '.....yywwyy.....',
  '......yyyy......',
  '.....BBBBBB.....',
  '....BBBBBBBB....',
  '....BBBBBBBB....',
  '....BBkBBkBB....',
  '.....BBBBBB.....',
  '....ssssssss....',
  '...ssssssssss...',
  '...sBs....sBs...',
  '...sss....sss...',
  '................',
];

export const HERO_PALETTE: PixelPalette = {
  G: '#e8b34b',
  y: '#f5d76e',
  w: '#ffffff',
  B: '#3b6fb0',
  k: '#1e1e2e',
  s: '#f2c9a0',
};

/* ============ 史莱姆：果冻团子 ============ */
const SLIME_PIXELS = [
  '................',
  '................',
  '................',
  '......gggg......',
  '....gggggggg....',
  '...gggggggggg...',
  '..ggwwggggwwgg..',
  '..gggggggggggg..',
  '.gggggggggggggg.',
  '.gggggggggggggg.',
  '.gggggggggggggg.',
  '.gggggggggggggg.',
  '.gggggggggggggg.',
  '..gggggggggggg..',
  '...gggggggggg...',
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
  '....wwwwwwww....',
  '.....ww..ww.....',
  '.....ww..ww.....',
  '.....wwwwww.....',
  '....wwwwwwww....',
  '...ww.wwww.ww...',
  '..wwwwwwwwwwww..',
  '..wwwwwwwwwwww..',
  '..www......www..',
  '................',
];

/* ============ 僵尸 ============ */
const ZOMBIE_PIXELS = [
  '................',
  '.....gggggg.....',
  '....gggggggg....',
  '....gwwggwwg....',
  '....gggggggg....',
  '.....gggggg.....',
  '....dddddddd....',
  '...dddddddddd...',
  '...ddrdddrdd....',
  '...dddddddddd...',
  '....dddddddd....',
  '...gggggggggg...',
  '..gggggggggggg..',
  '..gggg....gggg..',
  '..ggg......ggg..',
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
  '.....pppppp.....',
  '.....pppppp.....',
  '.....pppppp.....',
  '....pppppppp....',
  '...pppp..pppp...',
  '..pppp....pppp..',
  '.pppp......pppp.',
  '................',
];

/* ============ 火焰魔 ============ */
const FIRE_DEMON_PIXELS = [
  '................',
  '..kkkkkkkkkk....',
  '.krrrrrrrrrrk...',
  '.krrrrrrrrrrk...',
  '.rrwwrrrrwwrr...',
  '.rrrrrrrrrrrr...',
  '.rrrrrrrrrrrr...',
  '..rrrrrrrrrr....',
  '...oooooooo.....',
  '..oooooooooo....',
  '.oooooorroooo...',
  '.oooorrrrrroo...',
  '.ooorrrrrrrro...',
  '..oorrrrrrrro...',
  '...oorrrrrroo...',
  '................',
];

/* ============ 恶龙：最终 Boss ============ */
const DRAGON_PIXELS = [
  '....................',
  '......PPPP..........',
  '.....PPPPPP..yyyy...',
  '....PPPPPPPP..yPPP..',
  '...PPwwPPPPPPPPP....',
  '...PPwwPPPPPPPPP....',
  '....PPPPPPPPPPPPP...',
  '.....PPPPPPPPPPP....',
  '....PPPPPPPPPPP.....',
  '...PPPPyyyPPPPP.....',
  '..PP.PPPPyPPPP......',
  '.PPP.PPPPPP.PPP.....',
  '.PPP.PPPPPP.PPP.....',
  '..PP..PPPP...PP.....',
  '......PPPP..........',
  '....................',
];

interface SpriteDef {
  pixels: string[];
  palette: PixelPalette;
}

export const MONSTER_SPRITES: Record<string, SpriteDef> = {
  史莱姆: {
    pixels: SLIME_PIXELS,
    palette: { g: '#5ecf4e', w: '#eaffea' },
  },
  骷髅兵: {
    pixels: SKELETON_PIXELS,
    palette: { w: '#e8e8f0', k: '#1e1e2e' },
  },
  僵尸: {
    pixels: ZOMBIE_PIXELS,
    palette: { g: '#6fbf5a', w: '#ffffff', d: '#8a5a3a', r: '#b03a3a' },
  },
  暗影幽魂: {
    pixels: GHOST_PIXELS,
    palette: { p: '#9a6fd8', w: '#f0eaff' },
  },
  火焰魔: {
    pixels: FIRE_DEMON_PIXELS,
    palette: { k: '#1e1e2e', r: '#e05252', w: '#ffe066', o: '#f08c3a' },
  },
  恶龙: {
    pixels: DRAGON_PIXELS,
    palette: { P: '#7c3aed', w: '#fff3a0', y: '#e8b34b', k: '#1e1e2e' },
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
