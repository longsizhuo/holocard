# src/demo

演示页，也就是线上 holocard.longsizhuo.com 的前端。

- `main.ts`：页面入口。上传、分层、调参面板、分享、删除、导出，以及三种路由（`/`、`/c/<id>`、`/render/<id>`）
- `api.ts`：分层服务的客户端。只有没有后端时才回退到浏览器端流水线
- `export.ts`：导出动图（按设备选 GIF / 动态照片 / APNG）
- `deck.ts`：主舞台的卡带：这次访问做的卡左右切换，上传时先放一个卡包，开包后换成新卡
- `pack.ts` / `pack-art.ts`：卡包（状态、撕开和炸开两种开法）和它的图案（浏览器里现画，拼成两层的 LayerSet）
- `albums.ts` / `albums-ui.ts`：卡册的数据（只存本机 localStorage）和界面（原生 `<dialog>`）
- `route.ts`：路由和分享链接
- `track.ts`：自建 umami 埋点，没配站点 id 时一个字节都不加载
- `perf.ts`：性能埋点。静置时量 10 秒帧率，发给自己的服务端（staging 和线上都有，不走 umami）
- `style.css`：珠光主题
