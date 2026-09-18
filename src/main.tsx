import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ToastProvider } from './core/Toast';
import './index.css';

// 部署后按需加载的游戏分包文件名会变（带 hash），旧标签页点进游戏会 404 并让整棵 React 树崩成白屏。
// 遇到这种预加载失败就自动整页刷新一次拿新产物；标记只活过一次加载，避免真离线时无限刷新。
const CHUNK_RELOADED_KEY = 'pp:chunk-reloaded';
window.addEventListener('vite:preloadError', () => {
  try {
    if (sessionStorage.getItem(CHUNK_RELOADED_KEY)) return; // 为它刷新过一次还是失败：多半是真离线
    sessionStorage.setItem(CHUNK_RELOADED_KEY, '1');
  } catch {
    /* 隐私模式下退化为不自动刷新 */
  }
  window.location.reload();
});
try {
  if (sessionStorage.getItem(CHUNK_RELOADED_KEY)) sessionStorage.removeItem(CHUNK_RELOADED_KEY);
} catch {
  /* ignore */
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>,
);
