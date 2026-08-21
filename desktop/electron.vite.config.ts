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
