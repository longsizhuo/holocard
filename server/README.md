# server

分层服务：一个 Node 进程发前端静态文件，同时提供 `/api`。打包成 `dist-server/` 下的 `holocard-server.mjs`（入口）、
`segment-worker.mjs`（分层工作线程）和 `chunks/`（两边共用的代码），整个目录一起部署。

- `index.ts`：HTTP 路由、任务队列、限流、分享页的 OG 标签、层文件和缩略图、存作者配置（`PUT /api/cards/<id>/config`）、对外接口 `/v1`（`handleV1`）
- `apikeys.ts`：对外接口 key 的生成、哈希、从请求头里取（发 key 用 `scripts/apikey.mjs`）
- `segment-worker.ts`：分层流水线的工作线程。模型推理和切层补洞放在主线程上会让整个服务卡几十秒，所以挪到这里
- `db.ts` / `cards.ts`：卡片数据库（node:sqlite）、访问计数和过期清理
- `moderation.ts`：裸露识别（NudeNet，只记录不拦），分层完成后跑，结果进 `cards.nsfw` / `nsfw_part`
- `perf.ts`：性能埋点 `POST /api/perf` 的校验和表结构（前端见 `src/demo/perf.ts`，字段说明见 `deploy/README.md`）
- `images.ts`：sharp 实现的图片编解码，原图规范化（摆正、去 EXIF），层图转 WebP，卡册缩略图
- `preview.ts`：无头浏览器截分享图
- `export.ts` / `motionphoto.ts`：导出动图（GIF、APNG、安卓动态照片）
- `dev.env`：`pnpm dev:server` 的本地默认目录（模型读 `.models/`，产物和数据库写在 `out/`）

部署和服务器布局见 `deploy/README.md`。
