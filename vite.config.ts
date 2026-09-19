import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    headers: {
      // onnxruntime-web 的多线程 WASM 需要 SharedArrayBuffer，
      // 而 SharedArrayBuffer 要求页面处于跨源隔离状态。
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    // transformers.js 自带预编译产物，交给 Vite 预打包反而会破坏 WASM 路径解析
    exclude: ['@huggingface/transformers'],
  },
  build: {
    target: 'esnext', // WebGPU / 顶层 await 需要
  },
});
