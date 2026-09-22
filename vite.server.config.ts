import { defineConfig } from 'vite';

/**
 * 服务端构建：把分层流水线和 HTTP 服务打成一个 ESM 文件。
 *
 * 和浏览器端共用 src/segmenter 的全部代码，只有图片解码/编码走 sharp
 * （见 src/segmenter/image-io.ts 的后端抽象）。
 * 原生模块和 node 内置模块保持 external，不进包。
 */
export default defineConfig({
  ssr: {
    /*
     * 纯 JS 的小依赖直接打进包里。服务器上的 node_modules 是单独维护的（只装了原生模块和
     * playwright-core），发版脚本不在那边装包——打进来就不用每加一个依赖都去服务器上手工装。
     */
    noExternal: ['upng-js', 'pako', 'heic-decode', 'libheif-js'],
  },
  /*
   * libheif-js 的 Emscripten 胶水代码在 Node 分支里会读 __dirname（找 wasm 文件用）。
   * 打成 ESM 之后没有这个变量，服务一启动就崩。它的 wasm 是内嵌的，给个真实目录就行。
   */
  define: {
    __dirname: 'import.meta.dirname',
    __filename: 'import.meta.filename',
  },
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
