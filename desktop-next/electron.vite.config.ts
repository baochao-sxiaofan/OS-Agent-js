import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // 沙箱内预加载脚本只支持 CommonJS；主进程仍使用 ESM。
    build: { rollupOptions: { input: resolve('preload/index.ts'),
      output: { format: 'cjs', entryFileNames: 'index.cjs' } } },
  },
  renderer: {
    root: resolve('renderer'),
    plugins: [react()],
    server: { port: 5188 },
    build: { rollupOptions: { input: resolve('renderer/index.html') } },
  },
});
