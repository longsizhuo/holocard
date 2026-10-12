# config

站点前端以外各产物的 vite 构建配置。站点前端的 vite.config.ts 留在仓库根目录，因为 pnpm dev 默认读它。

## 内容

- `vite.server.config.ts` — 服务端，`pnpm build:server`
- `vite.player.config.ts` — npm 包，`pnpm build:player`
- `vite.og.config.ts` — 分享图预览工具，`pnpm og`
- `vite.cardmask.config.ts` — 卡面遮罩评测，`pnpm cardmask:eval`
- `vite.lab.config.ts` — 双盲对比页，由 scripts/blind/pack.mjs 调用

## 与其他目录的关系

- 配置里的相对路径都相对仓库根目录（命令在根目录跑）
