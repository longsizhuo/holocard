# deploy/staging/worker

`holocard.staging.longsizhuo.com` 上的 Cloudflare Worker（`holocard-staging-proxy`），把请求原样转发给
`holocard-staging.longsizhuo.com`（服务器上的 staging）。

存在的唯一理由是证书：二级子域名 Cloudflare 免费证书不覆盖，而 Worker 自定义域名会自动免费签。
来龙去脉和部署命令见 [../README.md](../README.md) 的「域名」一节。
