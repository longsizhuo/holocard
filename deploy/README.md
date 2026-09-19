# 部署

线上地址：https://holocard.longsizhuo.com

```
浏览器 → Cloudflare → cloudflared 隧道 → nginx（127.0.0.1:8377）→ /var/www/holocard/current
```

服务器在内网，没有公网入口，完全靠 Cloudflare Tunnel 接出去，和 `ssh.longsizhuo.com` 走同一条隧道。
nginx 只监听回环地址，不对外开任何端口；TLS 在 Cloudflare 边缘终结。

## 日常发版

```bash
bash scripts/deploy.sh
```

脚本做的事：构建 → 从 HEAD 打源码包 → 预压缩 → 上传到 `releases/<时间>-<commit>` → 原子切换 `current` 软链。
工作区有未提交改动时会拒绝发版——源码包是从 HEAD 打的，不干净的话线上代码和提供下载的源码就对不上。

旧版本全部保留，回滚就是把软链指回去：

```bash
ssh mail 'ls /var/www/holocard/releases'
ssh mail 'cd /var/www/holocard && ln -sfn releases/<要回滚到的版本> current.new && mv -T current.new current'
```

## 为什么必须自己配 nginx，而不是丢到 GitHub Pages

两个响应头和一个 MIME 类型，GitHub Pages 都给不了：

- `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`：页面要处于跨源隔离状态，
  onnxruntime-web 的多线程 WASM 才能用 `SharedArrayBuffer`。
- `application/wasm`：nginx 1.18 自带的 `mime.types` 里没有 wasm，
  而浏览器的 `WebAssembly.instantiateStreaming` 对 MIME 类型是严格校验的。

## 一次性配置

以下只在第一次部署时做过一遍，记录下来备查。

**1. 站点目录**

```bash
sudo mkdir -p /var/www/holocard/releases
sudo chown -R longsizhuo:longsizhuo /var/www/holocard
```

**2. nginx 站点**：见 [nginx-holocard.conf](nginx-holocard.conf)，文件头有安装步骤。
独立的一个 vhost，没有动 `default` 里已有的站点。

**3. 隧道 ingress**：在 `/etc/cloudflared/config.yml` 的兜底规则**之前**加一条，然后重启 cloudflared。

```yaml
ingress:
  - hostname: ssh.longsizhuo.com
    service: ssh://localhost:22
  - hostname: holocard.longsizhuo.com      # 新增
    service: http://127.0.0.1:8377         # 新增
  - service: http_status:404
```

改之前先 `cloudflared tunnel --config <文件> ingress validate` 校验。
这条隧道同时承载着 SSH 入口，配置写坏了重启会把远程 SSH 一起带下线。

**4. DNS**：在 Cloudflare 上建一条指向隧道的 CNAME。

```bash
cloudflared tunnel route dns 1a956a2e-0b74-43b6-b667-081b65584c36 holocard.longsizhuo.com
```

## 用户侧的流量

| | 来源 | 体积 |
|---|---|---|
| 页面本身 | 本服务器 | 约 27KB |
| onnxruntime 的 wasm | 本服务器 | 6.7MB（gzip 后），带哈希永久缓存 |
| 深度模型权重 | Hugging Face CDN | 约 50MB，不经过本服务器 |

后两项只在用户真的上传了照片时才会拉取，而且都是一次性的。
