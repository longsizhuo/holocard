import { defineConfig } from 'vite';

/**
 * 双盲对比页的构建：只把 src/lab/blind.ts（连同站里的卡片渲染器）打成 blind.js + blind.css。
 * 页面 lab/blind/index.html 和每次实验的数据由 scripts/blind/pack.mjs 放到同一个目录里，见 scripts/blind/README.md
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist-lab/blind',
    emptyOutDir: true,
    assetsDir: '',
    rollupOptions: {
      input: 'src/lab/blind.ts',
      output: { entryFileNames: 'blind.js', assetFileNames: 'blind.[ext]', format: 'es' },
    },
  },
});
