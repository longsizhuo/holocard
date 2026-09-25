# server

分层服务：一个 Node 进程发前端静态文件，同时提供 `/api`。打包成单文件 `dist-server/holocard-server.mjs` 部署。

- `index.ts`：HTTP 路由、任务队列、限流、分享页的 OG 标签、层文件和缩略图
- `db.ts` / `cards.ts`：卡片数据库（node:sqlite）、访问计数和过期清理
- `images.ts`：sharp 实现的图片编解码，原图规范化（摆正、去 EXIF），层图转 WebP，卡册缩略图
- `preview.ts`：无头浏览器截分享图
- `export.ts` / `motionphoto.ts`：导出动图（GIF、APNG、安卓动态照片）

部署和服务器布局见 `deploy/README.md`。
