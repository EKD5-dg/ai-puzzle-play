import { useEffect, useState } from 'react';

/**
 * 立绘组件：加载 AI 生成的游戏立绘（深蓝底 #1d2b53），
 * 运行时用 Canvas 抠除背景色，输出透明 PNG dataURL。
 */
interface PortraitProps {
  src: string;
  className?: string;
  /** 抠图颜色容差（默认 4500 ≈ 67 像素距离） */
  tolerance?: number;
}

export function Portrait({ src, className, tolerance = 4500 }: PortraitProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      try {
        const maxSide = 480;
        const ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        const bg = [0x1d, 0x2b, 0x53];
        const out = new Uint8ClampedArray(d);
        for (let i = 0; i < d.length; i += 4) {
          const dr = d[i] - bg[0];
          const dg = d[i + 1] - bg[1];
          const db = d[i + 2] - bg[2];
          if (dr * dr + dg * dg + db * db < tolerance) {
            out[i + 3] = 0;
          }
        }
        ctx.putImageData(new ImageData(out, w, h), 0, 0);
        if (!cancelled) setDataUrl(c.toDataURL('image/png'));
      } catch {
        if (!cancelled) setDataUrl(src);
      }
    };
    img.onerror = () => {
      if (!cancelled) setDataUrl(src);
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, tolerance]);

  if (!dataUrl) return <div className="portrait-loading" aria-hidden />;
  return <img src={dataUrl} className={className} alt="" draggable={false} />;
}
