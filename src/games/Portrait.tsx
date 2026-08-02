import { useEffect, useState } from 'react';

/**
 * 像素化立绘组件：加载 AI 生成的 8-bit 像素风角色图（深蓝底 #1d2b53），
 * 处理流程：抠除背景 → 裁剪角色区域 → 降采样为低分辨率像素 → 输出 dataURL。
 * 显示时配合 image-rendering: pixelated 放大，呈现真实复古像素质感。
 */

/** 模块级内存缓存：同一立绘只下载+处理一次，切换楼层/再次战斗秒开 */
const dataUrlCache = new Map<string, string>();

interface PortraitProps {
  src: string;
  className?: string;
  /** 抠图颜色容差（默认 4500 ≈ 67 像素距离） */
  tolerance?: number;
  /** 降采样后的像素高度（宽按比例，正方形画布） */
  pixelSize?: number;
  /** 图片加载失败时显示的占位 emoji（避免浏览器破图） */
  fallback?: string;
}

export function Portrait({ src, className, tolerance = 4500, pixelSize = 64, fallback = '❓' }: PortraitProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(() => dataUrlCache.get(src) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // 已有缓存（含初始化命中）：无需重新下载与处理
    const cached = dataUrlCache.get(src);
    if (cached) {
      setDataUrl(cached);
      return;
    }
    let cancelled = false;
    // 清除上一个 src 的立绘，避免切换怪物时旧图残留
    setDataUrl(null);
    setFailed(false);
    const img = new Image();
    img.onload = () => {
      try {
        // 1. 缩到处理尺寸（加速）
        const maxSide = 640;
        const ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);

        // 2. 抠除深蓝背景
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

        // 3. 计算角色边界框（非透明像素）
        const alpha = ctx.getImageData(0, 0, w, h).data;
        let minX = w;
        let minY = h;
        let maxX = 0;
        let maxY = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (alpha[(y * w + x) * 4 + 3] > 30) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX <= minX || maxY <= minY) return;
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;

        // 4. 按角色宽高比降采样到像素画布（水平居中，底部贴齐保证同一水平线）
        const scale = pixelSize / Math.max(bw, bh);
        const pw = Math.max(1, Math.round(bw * scale));
        const ph = Math.max(1, Math.round(bh * scale));
        const px = Math.round((pixelSize - pw) / 2);
        const py = pixelSize - ph; // 贴底：所有角色脚底对齐
        const p = document.createElement('canvas');
        p.width = pixelSize;
        p.height = pixelSize;
        const pctx = p.getContext('2d');
        if (!pctx) return;
        pctx.imageSmoothingEnabled = true; // 降采样需要平滑，像素感由显示端放大产生
        pctx.drawImage(c, minX, minY, bw, bh, px, py, pw, ph);

        if (!cancelled) {
          const url = p.toDataURL('image/png');
          dataUrlCache.set(src, url);
          setDataUrl(url);
        }
      } catch {
        // 处理失败：回退原图（至少能看到角色）
        if (!cancelled) setDataUrl(src);
      }
    };
    img.onerror = () => {
      // 加载失败：显示 emoji 占位，避免显示破图
      if (!cancelled) setFailed(true);
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, tolerance, pixelSize]);

  if (failed) return <div className="portrait-fallback" aria-hidden>{fallback}</div>;
  if (!dataUrl) return <div className="portrait-loading" aria-hidden />;
  return <img src={dataUrl} className={className} alt="" draggable={false} />;
}
