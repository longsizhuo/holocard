# api

网页接口 /api 返回的结构（只有类型）。服务端返回前用 satisfies 对上，前端按它解析，一边改了另一边类型检查过不去。

## 与其他目录的关系

- 被 server/routes/、server/render/exports.ts 和 web/site 引用；对外接口 /v1 的结构以 docs-site/api/ 为准

各文件的职责见 docs-site/develop/architecture.md 的对应小节。
