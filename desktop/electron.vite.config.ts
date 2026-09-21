import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import {
  defineConfig,
  externalizeDepsPlugin,
} from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('main/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('preload/index.ts'),
        // Electron 沙箱预加载脚本不支持 ESM，即使应用声明了 type: module。
        // 因此将这层桥接代码打包为单个 CommonJS 文件。
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
          inlineDynamicImports: true,
        },
      },
    },
  },
  renderer: {
    root: resolve('renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve('renderer/index.html'),
      },
    },
  },
});
