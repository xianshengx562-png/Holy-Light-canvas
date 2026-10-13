import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 相对路径打包（`base: './'`）：Capacitor 是从 `file:///android_asset/public/`
 * 加载页面的，`/` 开头的绝对路径在壳里指不到文件 —— 会白屏。
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5178,
  },
});
