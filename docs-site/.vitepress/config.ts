import { defineConfig } from 'vitepress';

/**
 * 站内文档（VitePress），发在 https://holocard.longsizhuo.com/docs/ 下。
 * pnpm build 时跟在网站构建后面生成到 dist/docs，由服务端当静态文件发，部署流程不用改。
 * 本地预览：pnpm docs:dev
 */
/** 顶栏：回到网站 + 几个主要栏目 */
const nav = (prefix: string, t: { guide: string; api: string; player: string; develop?: string }) => [
  { text: t.guide, link: `${prefix}/guide/` },
  { text: 'API', link: `${prefix}/api/` },
  { text: t.player, link: `${prefix}/player/` },
  ...(t.develop ? [{ text: t.develop, link: `${prefix}/develop/` }] : []),
  { text: 'HoloCard', link: 'https://holocard.longsizhuo.com/', target: '_self' },
];

/** 侧边栏：使用者看的在前，开发、部署在后（日文版只有前一组） */
const sidebar = (
  prefix: string,
  t: { use: string; guide: string; player: string; format: string },
  dev?: { title: string; local: string; arch: string; pipeline: string; renderer: string; deploy: string },
) => [
  {
    text: t.use,
    items: [
      { text: t.guide, link: `${prefix}/guide/` },
      { text: 'API', link: `${prefix}/api/` },
      { text: t.player, link: `${prefix}/player/` },
      { text: t.format, link: `${prefix}/format/` },
    ],
  },
  ...(dev
    ? [
        {
          text: dev.title,
          items: [
            { text: dev.local, link: `${prefix}/develop/` },
            { text: dev.arch, link: `${prefix}/develop/architecture` },
            { text: dev.pipeline, link: `${prefix}/develop/pipeline` },
            { text: dev.renderer, link: `${prefix}/develop/renderer` },
            { text: dev.deploy, link: `${prefix}/deploy/` },
          ],
        },
      ]
    : []),
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
      themeConfig: {
        nav: nav('', { guide: '指南', api: 'API', player: '播放器', develop: '开发' }),
        sidebar: sidebar('', { use: '使用', guide: '介绍与使用', player: '播放器', format: '文件格式' }, { title: '开发与部署', local: '本地开发', arch: '架构与模块', pipeline: '分层流水线', renderer: '渲染器', deploy: '自托管部署' }),
        outline: { level: [2, 3], label: '本页目录' },
        docFooter: { prev: '上一页', next: '下一页' },
        darkModeSwitchLabel: '外观',
        sidebarMenuLabel: '菜单',
        returnToTopLabel: '回到顶部',
      },
    },
    en: {
      label: 'English',
      lang: 'en',
      description: 'Turn photos into layered holographic cards over HTTP and play them on your page with @holocard/player',
      themeConfig: {
        nav: nav('/en', { guide: 'Guide', api: 'API', player: 'Player', develop: 'Development' }),
        sidebar: sidebar('/en', { use: 'Using HoloCard', guide: 'Guide', player: 'Player', format: 'File format' }, { title: 'Development', local: 'Local development', arch: 'Architecture', pipeline: 'Layering pipeline', renderer: 'Renderer', deploy: 'Self-hosting' }),
      },
    },
    ja: {
      label: '日本語',
      lang: 'ja',
      description: 'HTTP で写真をレイヤーカードにして、@holocard/player でページに載せる',
      themeConfig: {
        nav: nav('/ja', { guide: 'ガイド', api: 'API', player: 'プレーヤー' }),
        sidebar: sidebar('/ja', { use: '使い方', guide: 'ガイド', player: 'プレーヤー', format: 'ファイル形式' }),
        outline: { level: [2, 3], label: '目次' },
        docFooter: { prev: '前へ', next: '次へ' },
      },
    },
  },
});
