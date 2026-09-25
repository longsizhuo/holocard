/**
 * holocard.staging.longsizhuo.com → holocard-staging.longsizhuo.com 的原样转发。
 *
 * 为什么多这一跳：holocard.staging 是二级子域名，Cloudflare 免费的通用证书只覆盖一级子域名，
 * 直接用橙云代理会 TLS 握手失败，要么就得买高级证书。而 Worker 的自定义域名 Cloudflare 会自动免费签证书，
 * 所以这个域名挂在 Worker 上，Worker 再把请求整个转给真正提供服务的 holocard-staging（服务器上的 Caddy → staging 服务）。
 *
 * 方法、路径、查询串、请求头、请求体原样带过去，响应原样带回来，重定向也不在这里跟随。
 */
const UPSTREAM = 'holocard-staging.longsizhuo.com';

export default {
  fetch(request) {
    const url = new URL(request.url);
    url.hostname = UPSTREAM;
    return fetch(new Request(url, request));
  },
};
