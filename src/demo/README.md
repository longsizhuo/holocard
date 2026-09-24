# src/demo

演示页，也就是线上 holocard.longsizhuo.com 的前端。

- `main.ts`：页面入口。上传、分层、调参面板、分享、删除、导出，以及三种路由（`/`、`/c/<id>`、`/render/<id>`）
- `api.ts`：分层服务的客户端。只有没有后端时才回退到浏览器端流水线
- `export.ts`：导出动图（按设备选 GIF / 动态照片 / APNG）
- `albums.ts` / `albums-ui.ts`：卡册的数据（只存本机 localStorage）和界面（原生 `<dialog>`）
- `route.ts`：路由和分享链接
- `track.ts`：自建 umami 埋点，没配站点 id 时一个字节都不加载
- `style.css`：珠光主题
