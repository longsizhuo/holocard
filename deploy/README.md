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

**3. 专用隧道**

服务器上原有的那条 `ssh-tunnel` 是在 Cloudflare 后台远程管理的：cloudflared 启动后会被云端下发的配置覆盖，
本地 `config.yml` 里的 ingress 形同虚设，从命令行改不了它的入口规则。
所以给 HoloCard 单独建了一条本地管理的隧道，和 SSH 那条完全隔离：

```bash
cloudflared tunnel create holocard
# 配置：~/.cloudflared/holocard.yml
# 服务：/etc/systemd/system/cloudflared-holocard.service（以 longsizhuo 身份运行）
sudo systemctl enable --now cloudflared-holocard
```

```yaml
# ~/.cloudflared/holocard.yml
tunnel: 8517be93-9aba-4ffd-99ea-e87b6bc9db9a
credentials-file: /home/longsizhuo/.cloudflared/8517be93-9aba-4ffd-99ea-e87b6bc9db9a.json

ingress:
  - hostname: holocard.longsizhuo.com
    service: http://127.0.0.1:8377
  - service: http_status:404
```

**4. DNS**

```bash
cloudflared tunnel route dns -f 8517be93-9aba-4ffd-99ea-e87b6bc9db9a holocard.longsizhuo.com
```

这台机器到 `api.cloudflare.com` 的线路时通时断，`cloudflared tunnel` 的各个子命令经常报
`context deadline exceeded`，多试几次就好，不是权限问题。

## 整个撤掉

```bash
sudo systemctl disable --now cloudflared-holocard
sudo rm /etc/systemd/system/cloudflared-holocard.service && sudo systemctl daemon-reload
cloudflared tunnel delete holocard
sudo rm /etc/nginx/sites-enabled/holocard /etc/nginx/sites-available/holocard
sudo nginx -t && sudo systemctl reload nginx
# 最后到 Cloudflare 后台删掉 holocard 这条 CNAME
```

## 用户侧的流量

用无缓存的浏览器对线上站点实测（`node scripts/verify-live.mjs --image 照片路径`）：

| | 来源 | 体积 |
|---|---|---|
| 页面本身 | 本服务器 | 约 27KB |
| 推理代码 | 本服务器 | 约 160KB |
| onnxruntime 的 wasm | jsDelivr CDN | 约 5.3MB |
| 深度模型权重 | Hugging Face CDN | 约 47MB |

后三项只在用户真的上传了照片时才会拉取，而且都是一次性的。
大头都走公共 CDN，家里的上行带宽对每个新访客只出约 200KB。

dist 里那份 26MB 的 wasm 线上没有任何请求会用到（transformers.js 默认从 jsDelivr 取），
只是白占每个 release 约 33MB 的磁盘。
