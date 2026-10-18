# server

分层服务：一个 Node 进程，同时发前端页面、提供 /api、/auth、/v1。入口 index.ts 是路由表和启动代码，用 config/vite.server.config.ts 打包到 dist-server/。

## 内容

- `routes/` — 各组接口的处理函数
- `pipeline/` — 分层任务、工作线程、图片处理、卡面遮罩
- `render/` — 用无头浏览器截分享图、导出动图
- `store/` — 数据库与保留策略
- `account/` — 登录、会话、API key

## 与其他目录的关系

- 引用 src/ 的库；不引用 web/

各文件的职责见 docs-site/develop/architecture.md 的对应小节。
