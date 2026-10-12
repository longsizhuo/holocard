# site

线上站点 holocard.longsizhuo.com 的前端：卡带和卡包、调参面板、上传、分享与导出、账号与卡册。入口是 main.ts，只做接线。

## 与其他目录的关系

- 引用 src/ 的渲染器、格式、i18n 和分层流水线（没有服务端时的回退）；接口走 server/routes/ 的 /api，返回结构见 src/api

各文件的职责见 docs-site/develop/architecture.md 的对应小节。
