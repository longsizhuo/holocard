# src/demo

演示页，也就是线上 holocard.longsizhuo.com 的前端。

- `main.ts`：页面入口。上传、分层、调参面板、分享、删除、导出，以及三种路由（`/`、`/c/<id>`、`/render/<id>`）
- `api.ts`：分层服务的客户端。只有没有后端时才回退到浏览器端流水线
- `export.ts`：导出动图（按设备选 GIF / 动态照片 / APNG）
- `deck.ts`：主舞台的卡带：这次访问做的卡左右切换，上传时先放一个卡包，开包后换成新卡
- `pack-gl.ts`：WebGL 卡包（真 3D 铝箔袋，撕开时卡从袋口升出来交给卡带），能用 WebGL 的设备都用它
- `pack.ts` / `pack-art.ts`：两种卡包共用的接口和外壳（状态、底下那行字、炸开的光）；平面版卡包（没有 WebGL 时的退路）和它的图案
- `sfx.ts`：开包音效，Web Audio 现合成，不带音频文件；开关记在本机
- `ih-logo.svg`：involutionhell.com 的 logo（深色底版），印在卡包正面和卡背上
- `albums-ui.ts`：「我的卡册」，这台设备上做过的卡（数据是 `api.ts` 里删除口令那份记录），原生 `<dialog>`；每次打开先开一包，再发牌进网格
- `route.ts`：路由和分享链接
- `track.ts`：自建 umami 埋点，没配站点 id 时一个字节都不加载
- `perf.ts`：性能埋点。静置时量 10 秒帧率，发给自己的服务端（staging 和线上都有，不走 umami）
- `style.css`：珠光主题
