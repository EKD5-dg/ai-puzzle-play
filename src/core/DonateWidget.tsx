import { useEffect, useRef, useState } from 'react';

/**
 * 收款码占位：把真实二维码图片放到 public/images/ 后，替换下面两个路径即可。
 * 图片不存在时面板内显示文字占位框，不会破版。
 */
const PAY_CODES: { label: string; img: string }[] = [
  { label: '微信', img: '/images/pay-wechat.jpg' },
  { label: '支付宝', img: '/images/pay-alipay.jpg' },
];

/**
 * 全局打赏组件（零侵入方案）：
 * - 监听 pp:achievement 事件（sfx.win / sfx.record 胜利、新纪录时广播），
 *   自动在右下角弹出「请作者喝杯咖啡」提示，6 秒后自动收起；
 * - 点击提示或页脚常驻入口，打开收款码面板。
 * 所有 20 款游戏无需任何改动即自动接入。
 */
export function DonateWidget() {
  const [hintVisible, setHintVisible] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    const onAchievement = () => {
      setHintVisible(true);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setHintVisible(false), 6000);
    };
    const onOpen = () => {
      setHintVisible(false);
      setPanelOpen(true);
    };
    window.addEventListener('pp:achievement', onAchievement);
    window.addEventListener('pp:donate-open', onOpen);
    return () => {
      window.removeEventListener('pp:achievement', onAchievement);
      window.removeEventListener('pp:donate-open', onOpen);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);

  return (
    <>
      {hintVisible && !panelOpen && (
        <button
          className="donate-hint"
          onClick={() => setPanelOpen(true)}
        >
          🎉 玩得开心？请作者喝杯咖啡 ☕
        </button>
      )}
      {panelOpen && (
        <div className="donate-mask" onClick={() => setPanelOpen(false)}>
          <div className="donate-panel" onClick={(e) => e.stopPropagation()}>
            <h3>☕ 请作者喝杯咖啡</h3>
            <p>如果你喜欢这些游戏，随意支持一下，是我持续更新的动力～</p>
            <div className="donate-codes">
              {PAY_CODES.map((p) => (
                <div key={p.label} className="donate-code">
                  <img
                    className="donate-qr"
                    src={p.img}
                    alt={p.label + '收款码'}
                    onError={(e) => {
                      // 收款码图片未放置时显示占位框，不破版
                      (e.target as HTMLImageElement).style.display = 'none';
                      const box = (e.target as HTMLImageElement).nextElementSibling;
                      if (box) (box as HTMLElement).style.display = 'flex';
                    }}
                  />
                  <div className="donate-qr-placeholder" style={{ display: 'none' }}>
                    <span>{p.label}收款码</span>
                    <small>放置图片：{p.img}</small>
                  </div>
                  <span className="donate-label">{p.label}</span>
                </div>
              ))}
            </div>
            <button className="btn" onClick={() => setPanelOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </>
  );
}
