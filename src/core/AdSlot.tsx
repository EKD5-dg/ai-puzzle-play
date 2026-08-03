import { useEffect } from 'react';

/**
 * AdSense 预留广告位组件。
 * - 未开通 AdSense（ADSENSE_CLIENT 为空）时组件渲染为空，页面无任何痕迹；
 * - AdSense 审核通过后：
 *   1. 把 client ID 填入 ADSENSE_CLIENT；
 *   2. 在 index.html <head> 加入 adsbygoogle 脚本（见文件底部注释）；
 *   3. 到 AdSense 后台为每个位置创建广告单元，把 slot ID 填到 App.tsx / GameShell.tsx 的调用处。
 */
const ADSENSE_CLIENT = ''; // e.g. 'ca-pub-1234567890123456'

interface AdSlotProps {
  /** AdSense 广告单元 slot ID */
  slot: string;
  /** 位置形态：首页顶部横幅 / 游戏区下方矩形 */
  variant: 'leaderboard' | 'rectangle';
}

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

export function AdSlot({ slot, variant }: AdSlotProps) {
  useEffect(() => {
    if (!ADSENSE_CLIENT) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      /* ignore */
    }
  }, [slot]);

  if (!ADSENSE_CLIENT) return null;

  return (
    <div className={'ad-slot ad-slot-' + variant}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block' }}
        data-ad-client={ADSENSE_CLIENT}
        data-ad-slot={slot}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
}

/*
 * index.html 需要在 AdSense 开通后于 <head> 添加：
 * <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-xxxx" crossorigin="anonymous"></script>
 */
