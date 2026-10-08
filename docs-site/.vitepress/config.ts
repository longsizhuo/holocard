import { defineConfig } from 'vitepress';

/**
 * 站内文档（VitePress），发在 https://holocard.longsizhuo.com/docs/ 下。
 * pnpm build 时跟在网站构建后面生成到 dist/docs，由服务端当静态文件发，部署流程不用改。
 * 本地预览：pnpm docs:dev
 */
const nav = (home: string, api: string) => [
  { text: 'HoloCard', link: 'https://holocard.longsizhuo.com/', target: '_self' },
  { text: api, link: home },
];

export default defineConfig({
  base: '/docs/',
  outDir: '../dist/docs',
  title: 'HoloCard',
  head: [['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }]],
  themeConfig: {
    search: {
      provider: 'local',
      options: {
        locales: {
          root: { translations: { button: { buttonText: '搜索', buttonAriaLabel: '搜索' }, modal: { noResultsText: '没有找到', resetButtonTitle: '清空', footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' } } } },
          ja: { translations: { button: { buttonText: '検索', buttonAriaLabel: '検索' }, modal: { noResultsText: '見つかりません', resetButtonTitle: 'クリア', footer: { selectText: '選択', navigateText: '移動', closeText: '閉じる' } } } },
        },
      },
    },
    outline: [2, 3],
  },
  locales: {
    root: {
      label: '中文',
      lang: 'zh-CN',
      description: '用 HTTP 接口把照片做成分层闪卡，再用 @holocard/player 放进你的网页',
      themeConfig: { nav: nav('/', '接口文档'), outline: { level: [2, 3], label: '本页目录' } },
    },
    en: {
      label: 'English',
      lang: 'en',
      description: 'Turn photos into layered holographic cards over HTTP and play them on your page with @holocard/player',
      themeConfig: { nav: nav('/en/', 'API docs') },
    },
    ja: {
      label: '日本語',
      lang: 'ja',
      description: 'HTTP で写真をレイヤーカードにして、@holocard/player でページに載せる',
      themeConfig: { nav: nav('/ja/', 'API ドキュメント'), outline: { level: [2, 3], label: '目次' } },
    },
  },
});
