/**
 * 打包 scripts/og-preview.ts（分享图预览工具）
 *
 * 和服务端一样：TS 源码经 vite 打成一个 ESM 文件再交给 node 跑，
 * 原生模块、node 内置模块、vite 自己都保持 external。
 */
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'scripts/og-preview.ts',
    outDir: '.og-cache/bin',
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    rollupOptions: {
      external: ['sharp', '@huggingface/transformers', 'playwright-core', 'vite', /^node:/],
      output: { entryFileNames: 'og-preview.mjs' },
    },
  },
});
