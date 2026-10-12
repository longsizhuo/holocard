import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const web = (path: string) => fileURLToPath(new URL(`web/${path}`, import.meta.url));

// 页面都在 web/ 下（html 的位置就是线上地址：web/index.html 是 /，web/masks.html 是 /masks），
// 前后端共用的库在 src/，服务端在 server/。路径写成绝对的：脚本里换了工作目录调 build() 也对（见 scripts/og-preview.ts）
export default defineConfig({
  root: web(''),
  // .env 留在仓库根目录，服务端构建（config/vite.server.config.ts）也读同一份
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  server: {
    // 固定端口：录制/验证脚本和 README 都按这个来，用默认的 5173 会对不上
    port: 5273,
    strictPort: true,
    // 开发时把 /api 转给本地跑着的分层服务（pnpm dev:server）
    proxy: {
      '/api': {
        target: process.env.HOLOCARD_API ?? 'http://127.0.0.1:8791',
        changeOrigin: true,
      },
    },
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
    outDir: fileURLToPath(new URL('dist', import.meta.url)),
    // 产物目录在 root 外面，vite 默认不清空，要明说
    emptyOutDir: true,
    rollupOptions: {
      // 两个页面：首页（卡带、分享页、渲染页都是它）和卡面遮罩页（/masks，见 web/masks/main.ts）
      input: { main: web('index.html'), masks: web('masks.html') },
    },
  },
});
