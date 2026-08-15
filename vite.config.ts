import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: false,
    // 开发服务器禁用一切模块缓存，避免浏览器加载到旧代码（魔方渲染曾因此反复"修不好"）
    headers: {
      'Cache-Control': 'no-store',
    },
  },
});
