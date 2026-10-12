# src

库：页面（web/）和服务端（server/）都从这里引用，库之间可以互相引用，但不引用 web/ 和 server/。

## 内容

- `api/` — 网页接口 /api 返回的结构，前后端共用
- `format/` — .layers 格式：类型、读写与校验、作者配置
- `segmenter/` — 分层流水线，服务端和浏览器端共用
- `renderer/` — 闪卡渲染器
- `cardmask/` — 卡面遮罩的识别规则
- `player/` — `<holo-card>` 自定义元素，npm 包 @holocard/player 的入口
- `i18n/` — 界面文字与语言判定

各文件的职责见 docs-site/develop/architecture.md 的对应小节。
