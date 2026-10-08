import { defineConfig } from 'vite';

/**
 * npm 包 holocard（<holo-card> 播放器）的构建：只打 src/player 和它用到的渲染器，打成一个 ES 模块。
 * 样式用 ?inline 读成字符串、装进 Shadow DOM；card.ts 自己 import 的全局 CSS 会被单独抽成一个文件，不进包。
 */
export default defineConfig({
  // 网站的 public/（图标、样卡、分享图）不进包
  publicDir: false,
  build: {
    outDir: 'packages/player/dist',
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry: 'src/player/index.ts', formats: ['es'], fileName: () => 'holocard.js' },
  },
});
