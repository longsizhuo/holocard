/**
 * 打包 scripts/cardmask-eval.ts（卡面遮罩的评测），做法同 vite.og.config.ts：
 * TS 源码打成一个 ESM 文件交给 node 跑，原生模块和 node 内置模块保持 external
 */
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'scripts/cardmask-eval.ts',
    outDir: '.cardmask/bin',
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    rollupOptions: {
      external: ['sharp', '@huggingface/transformers', /^node:/],
      output: { entryFileNames: 'cardmask-eval.mjs' },
    },
  },
});
