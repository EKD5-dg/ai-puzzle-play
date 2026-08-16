import { useEffect, useState } from 'react';

/**
 * 像素化立绘组件：加载 AI 生成的 8-bit 像素风角色图（深蓝底 #1d2b53），
 * 处理流程：抠除背景 → 裁剪角色区域 → 降采样为低分辨率像素 → 输出 dataURL。
 * 显示时配合 image-rendering: pixelated 放大，呈现真实复古像素质感。
 */

/** 模块级内存缓存：同一立绘只下载+处理一次，切换楼层/再次战斗秒开 */
const dataUrlCache = new Map<string, string>();

/** 持久化缓存：处理结果写入 localStorage，下次打开页面直接命中，免下载免处理 */
const CACHE_KEY = 'pp:portrait-cache:v1';

function hydrateCache(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const map = JSON.parse(raw) as Record<string, unknown>;
    for (const [src, url] of Object.entries(map)) {
      if (typeof url === 'string' && url.startsWith('data:image/')) dataUrlCache.set(src, url);
    }
  } catch {
    /* 缓存损坏/隐私模式时忽略 */
  }
}

function persistCache(): void {
  try {
    const obj: Record<string, string> = {};
    for (const [src, url] of dataUrlCache) {
      if (url.startsWith('data:image/')) obj[src] = url;
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
  } catch {
    /* 容量不足等时忽略 */
  }
}

hydrateCache();

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

const DEFAULT_TOLERANCE = 4500;
const DEFAULT_PIXEL_SIZE = 64;

/** 处理一张立绘为像素 dataURL；失败返回 null（保留原图兜底） */
function processPortrait(img: HTMLImageElement, tolerance: number, pixelSize: number): string | null {
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
    if (!ctx) return null;
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
    if (maxX <= minX || maxY <= minY) return null;
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
    if (!pctx) return null;
    pctx.imageSmoothingEnabled = true; // 降采样需要平滑，像素感由显示端放大产生
    pctx.drawImage(c, minX, minY, bw, bh, px, py, pw, ph);

    return p.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** 处理完成后的收尾：写入内存 + 本地缓存 */
function cacheUrl(src: string, url: string): void {
  dataUrlCache.set(src, url);
  persistCache();
}

/**
 * 预加载并处理一组立绘（并发下载）：结果写入内存与 localStorage 缓存。
 * 在游戏模块加载时调用一次，之后战斗场景切换立绘零等待。
 */
export function preloadPortraits(srcs: string[]): void {
  for (const src of srcs) {
    if (dataUrlCache.has(src)) continue;
    const img = new Image();
    img.onload = () => {
      const url = processPortrait(img, DEFAULT_TOLERANCE, DEFAULT_PIXEL_SIZE);
      if (url) cacheUrl(src, url);
    };
    // 预加载失败静默：战斗时组件自身会重试并显示 emoji 兜底
    img.src = src;
  }
}

export function Portrait({ src, className, tolerance = DEFAULT_TOLERANCE, pixelSize = DEFAULT_PIXEL_SIZE, fallback = '❓' }: PortraitProps) {
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
      const url = processPortrait(img, tolerance, pixelSize);
      if (cancelled) return;
      if (url) {
        cacheUrl(src, url);
        setDataUrl(url);
      } else {
        // 处理失败：回退原图（至少能看到角色）
        setDataUrl(src);
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
