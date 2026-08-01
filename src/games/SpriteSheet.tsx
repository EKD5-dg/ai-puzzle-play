import { useEffect, useRef, useState } from 'react';

/**
 * 精灵表渲染组件：从 PNG 精灵表按格子索引裁剪渲染（Canvas，像素风）。
 * 素材来源：DawnLike 16x16 Universal Rogue-like tileset（CC-BY-SA 3.0，作者 DragonDePlatino）
 * 素材文件位于 public/sprites/dawnlike/
 */
interface SpriteSheetProps {
  /** 精灵表图片路径（相对 public 根） */
  src: string;
  /** 格子索引（从 0 开始，行优先） */
  index: number;
  /** 每行格子数（默认 8） */
  cols?: number;
  /** 每格尺寸（默认 16） */
  cell?: number;
  /** 显示缩放 */
  scale?: number;
  className?: string;
}

export function SpriteSheet({ src, index, cols = 8, cell = 16, scale = 4, className }: SpriteSheetProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setLoaded(true);
    };
    img.src = src;
    return () => {
      img.onload = null;
    };
  }, [src]);

  useEffect(() => {
    const cv = canvasRef.current;
    const img = imgRef.current;
    if (!cv || !img || !loaded) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = false;
    const row = Math.floor(index / cols);
    const col = index % cols;
    ctx.drawImage(img, col * cell, row * cell, cell, cell, 0, 0, cell * scale, cell * scale);
  }, [loaded, index, cols, cell, scale]);

  return (
    <canvas
      ref={canvasRef}
      width={cell * scale}
      height={cell * scale}
      className={className}
      style={{ imageRendering: 'pixelated', width: cell * scale, height: cell * scale }}
    />
  );
}
