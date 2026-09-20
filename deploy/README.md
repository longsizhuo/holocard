# 部署

线上地址：https://holocard.longsizhuo.com

```
浏览器 → Cloudflare → Caddy(:80) → holocard 服务 (127.0.0.1:8791)
                                      ├── /           前端静态文件 /srv/holocard-web/current
                                      ├── /api/jobs   提交与轮询
                                      └── /api/layers 产出的层文件
```

跑在 Oracle（`<源站 IP>`，Ampere ARM64，4 核 / 23G 内存）。
那台机器同时跑着 involutionhell.com 的一整套服务和 Minecraft，所以分层服务有资源上限，见下。

**静态文件为什么也由 Node 发，而不是 Caddy 的 `file_server`**：那台机器的 Caddy 跑在 Docker 容器里，
给它加一个目录挂载要重建容器，会让同机所有站点瞬断。让服务自己发更安全，
副作用是它变得自包含——别人 clone 下来跑一个 Node 进程就是完整的站点，不需要任何反向代理。

## 日常发版

```bash
bash scripts/deploy.sh
```

构建前端与服务 → 从 HEAD 打源码包 → 上传到 `releases/<时间>-<commit>` → 原子切软链 → 重启服务并等健康检查通过。
工作区有未提交改动时会拒绝发版：源码包是从 HEAD 打的，不干净的话线上代码和提供下载的源码就对不上。

前端保留最近 5 个版本，回滚就是把软链指回去：

```bash
ssh oracle 'ls /srv/holocard-web/releases'
ssh oracle 'cd /srv/holocard-web && ln -sfn releases/<版本> current.new && mv -T current.new current'
```

服务端回滚需要重新发一次对应的 commit（`dist-server` 是覆盖式上传，不留历史）。

## 服务器上的布局

| 路径 | 内容 |
|---|---|
| `/opt/holocard/holocard-server.mjs` | 服务本体（单文件 ESM） |
| `/opt/holocard/node22/` | Node 22 运行时（系统自带的是 18，sharp 要求 ≥20.9） |
| `/opt/holocard/node_modules/` | transformers.js + onnxruntime-node + sharp，约 483MB |
| `/srv/holocard-models/` | Depth Anything V2-Small 权重（q8，27MB） |
| `/srv/holocard-web/` | 前端 releases + current 软链 |
| `/srv/holocard-layers/` | 用户产出的层文件。每张卡一个 `meta.json`，保留策略见下 |
| `/opt/holocard/browsers/` | Playwright 的 arm64 Chromium，渲染 OG 预览图用，662MB |

## 资源限制

`/etc/systemd/system/holocard.service` 里：

```
MemoryMax=3G      # 推理峰值约 780MB，再加常驻 Chromium 约 400MB
CPUQuota=200%     # 4 核里最多占 2 核，留给 Minecraft 和数据库
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/holocard/browsers
```

渲染 OG 预览图的 Chromium 常驻复用，空闲 5 分钟自动关掉。
那台 ARM 机器没有显卡，启动参数里必须带 `--disable-gpu --use-gl=swiftshader --in-process-gpu`，
否则 headless shell 截图直接报 `Unable to capture screenshot`。

服务侧：单并发（`HOLOCARD_CONCURRENCY=1`），队列上限 12，满了直接返回 503 而不是让人排十分钟。
上传上限 16MB，按魔数校验图片格式，拒绝解压炸弹。
按 IP 限流：10 分钟 10 次，取 `cf-connecting-ip`。

## 保留与删除

每张卡的目录里有一份 `meta.json`（产出时间、是否分享过、被访问几次、最后一次访问、删除口令）。
清理只看它，不看目录 mtime——mtime 会被任何一次写入刷新，拿它当依据等于永不过期。

| | 窗口从哪算 | 多长 |
|---|---|---|
| 没分享过 | 产出时间 | 7 天 |
| 分享过 | **最后一次被打开** | 7 天起，访问量每翻一番延一档，封顶 112 天 |

档位：1 次 → 7 天，2-3 次 → 14 天，4-7 次 → 28 天，8-15 次 → 56 天，16 次以上 → 112 天。
关键是分享过的卡从「最后一次访问」起算：一直有人看就不断续期，等于长期保留；
彻底没人看了才开始倒计时。热门的留得久、冷的自然退场，磁盘占用有上界。

访问计数按 IP 做一小时去重（自己反复刷不会把保留期刷上去），`HEAD` 不计
（那多半是抓取工具和监控）。计数在内存里累计、每分钟合并写盘一次，
退出前（`SIGTERM`）也会落一次，所以发版重启不会丢掉一分钟的数据。

删除：产出时服务端生成一个删除口令，**只在 `POST /api/jobs` 的响应里给一次**，
前端存进 `localStorage`。`DELETE /api/cards/{id}` 带 `x-holocard-token` 头才能删。
口令不放在 `GET /api/jobs/{id}` 里——那个接口任何知道 id 的人都能打，而卡一分享出去
id 就是公开的。这个站没有账号，「所有者」就是「手上有口令的人」；用户清了浏览器数据
就等于放弃删除权，页面上写明了这一点。

## 埋点

自建 umami，站点 `HoloCard` / `holocard.longsizhuo.com`，
website id `a67a8797-af1a-41a9-8278-279c05b60c9c`，看板在 https://umami.involutionhell.com 。

id 通过 `.env.production` 里的 `VITE_UMAMI_ID` 在构建时注入。
**这个文件不进仓库**（见 `.gitignore`）：提交了的话，别人 clone 下来自托管会被动把数据上报到我们这。
所以每台发版机都要自己有一份；`deploy.sh` 开头会打印当前用的是哪个 id，缺了会警告。

上报的内容：页面浏览（`/c/<uuid>` 归一成 `/c`，具体哪张卡放在事件数据里，
否则页面列表会被几千个 uuid 撑爆）、`upload`（只带体积档位）、`segment-ok`、
`segment-fail`（只带错误信息前 120 字）、`share`、`delete`。不带文件名。

`/render/<id>`（无头浏览器截 OG 图的页面）不加载统计脚本——否则每生成一张预览图
就多一条假访问，而且刚好落在分享这个动作上，会把「分享后有多少人真的点开」打歪。

## 一次性配置

以下只在第一次部署时做过一遍，记录备查。

**1. 目录与运行时**

```bash
sudo mkdir -p /opt/holocard /srv/holocard-web/releases /srv/holocard-models /srv/holocard-layers
sudo chown -R ubuntu:ubuntu /opt/holocard /srv/holocard-web /srv/holocard-models /srv/holocard-layers

cd /opt/holocard
curl -sL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-arm64.tar.xz | tar -xJ
mv node-v22.14.0-linux-arm64 node22

printf '{"name":"holocard","private":true,"type":"module","dependencies":{"@huggingface/transformers":"4.3.0","sharp":"^0.35.4"}}' > package.json
PATH=/opt/holocard/node22/bin:$PATH npm install --no-audit --no-fund
```

**2. 模型权重**（服务端跑推理，浏览器不下载任何模型）

```bash
D=/srv/holocard-models/onnx-community/depth-anything-v2-small
mkdir -p $D/onnx
B=https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main
curl -sL $B/config.json -o $D/config.json
curl -sL $B/preprocessor_config.json -o $D/preprocessor_config.json
curl -sL $B/onnx/model_quantized.onnx -o $D/onnx/model_quantized.onnx
```

用 q8 而不是 fp16：在 ARM CPU 上实测快一倍（2.7s 对 5s+）、内存省三成，而深度图差别在切层这一步看不出来。

**2.5 渲染 OG 预览图的浏览器**

```bash
cd /opt/holocard
PLAYWRIGHT_BROWSERS_PATH=/opt/holocard/browsers npx --yes playwright@latest install chromium
```

注意别用 `npm install --save` 在这个目录里装东西——它会重写 package.json 并把
transformers.js、onnxruntime-node、sharp 全 prune 掉（我踩过）。要加依赖先改 package.json 再 `npm install`。

**3. systemd**：见 `/etc/systemd/system/holocard.service`，内容如上「资源限制」一节。

```bash
sudo systemctl enable --now holocard
```

**4. Caddy**：在 `/home/ubuntu/caddy-gateway/Caddyfile` 末尾追加。改之前先备份，改完先 `validate` 再 `reload`——
这个 Caddy 同时在服务 involutionhell.com 的一整套站点。

```
http://holocard.longsizhuo.com {
    reverse_proxy 127.0.0.1:8791 {
        # 一次分层要几秒到几十秒，别让网关提前掐断
        transport http {
            read_timeout 180s
            write_timeout 180s
        }
    }
}
```

```bash
sudo docker exec global-caddy-gateway caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo docker exec global-caddy-gateway caddy reload  --config /etc/caddy/Caddyfile --adapter caddyfile
```

**5. DNS**：在 Cloudflare 上把 `holocard` 指向 `<源站 IP>`，A 记录、开橙云（proxied），
和 `longsizhuo.com` 一样用 Flexible 模式（Caddy 只监听 80）。

## 用户侧的流量

| | 来源 | 体积 |
|---|---|---|
| 页面 + 渲染器 | 本服务 | 约 27KB |
| 上传照片 | → 本服务 | 用户的原图 |
| 产出的层文件 | 本服务 | 约 6MB（3 张 PNG） |

**模型权重和推理运行时都不再下发给浏览器**。改造前每个新访客首次使用要下 47MB 权重 + 5.3MB wasm。

浏览器端的流水线代码仍然保留，只在服务端不可用时作为回退（自托管的纯静态部署走这条路），
那时才会按需下载模型。

## 整个撤掉

```bash
sudo systemctl disable --now holocard
sudo rm /etc/systemd/system/holocard.service && sudo systemctl daemon-reload
sudo rm -rf /opt/holocard /srv/holocard-web /srv/holocard-models /srv/holocard-layers
# 从 Caddyfile 里删掉 holocard 那个 block，再 validate + reload
# 最后到 Cloudflare 后台删掉 holocard 这条记录
```
