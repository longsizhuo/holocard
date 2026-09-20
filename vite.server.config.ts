import { defineConfig } from 'vite';

/**
 * 服务端构建：把分层流水线和 HTTP 服务打成一个 ESM 文件。
 *
 * 和浏览器端共用 src/segmenter 的全部代码，只有图片解码/编码走 sharp
 * （见 src/segmenter/image-io.ts 的后端抽象）。
 * 原生模块和 node 内置模块保持 external，不进包。
 */
export default defineConfig({
  build: {
    ssr: 'server/index.ts',
    outDir: 'dist-server',
    target: 'node22',
    emptyOutDir: true,
    minify: false, // 服务端不在乎体积，可读的堆栈更有用
    rollupOptions: {
      external: ['sharp', '@huggingface/transformers', /^node:/],
      output: { format: 'esm', entryFileNames: 'holocard-server.mjs' },
    },
  },
});
