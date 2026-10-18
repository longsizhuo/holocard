# web

页面：html 的位置就是线上地址（index.html 是 /，masks.html 是 /masks，lineart.html 是 /lineart），vite 以这里为根构建到 dist/。

## 内容

- `site/` — 线上站点（首页、卡片页 /c/<id>、截图用的渲染页 /render/<id>）
- `masks/` — 卡面遮罩页 /masks 的脚本
- `lineart/` — 线稿提取页 /lineart 的脚本
- `tools/` — 两个工具页共用的：取元素、语言切换、错误翻译、读像素、提交并轮询
- `lab/blind/` — 双盲对比页，由 scripts/blind/pack.mjs 单独构建
- `public/` — 原样发布的静态资源：图标、分享图、示例卡 samples/demo、llms.txt

## 与其他目录的关系

- 引用 src/ 里的库；服务端（server/routes/static.ts）发构建好的页面。src/ 和 server/ 都不引用这里

各文件的职责见 docs-site/develop/architecture.md 的对应小节。
