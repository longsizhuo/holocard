# staging

给人线上测试 PR 的环境：https://holocard.staging.longsizhuo.com （域名见文末）。

## 怎么更新

服务器上每分钟跑一次 `poll.py`（`holocard-staging-poll.timer`）：哪个 PR 有新推送，就用 `deploy.sh` 把它部署上去。
PR 页面的 Deployments 里会显示「部署中 / 已部署 / 失败」和访问链接；打开 `/staging.json` 能看到当前是哪个 PR 的哪个提交。

- **只部署可信的 PR**：分支在本仓库里（不是 fork）、作者有写权限。staging 跑的是没评审过的代码，不能谁开个 PR 都能在这台机器上执行
- **只改了文档、`deploy/`、`.github/` 的 PR 不部署**：它们不影响站点，部署了只会把正在测的 PR 顶掉
- **只有一条泳道**：后推送的覆盖先推送的。想测哪个 PR，往它上面推一次，或者手动：
  `/usr/local/lib/holocard-staging/deploy.sh <PR 号>`（以 ubuntu 身份）
- 前端和服务端都按版本放目录（各留 3 个），`current` 软链指当前版本。构建失败不影响正在跑的 staging；
  新版本起来了但健康检查不过，自动切回上一版。同一个提交失败了不会每分钟重试，推新提交才会再试
- 用拉而不是推：服务器去问 GitHub，不对外开口子，GitHub 上也不放服务器的密钥

## 和线上怎么隔开

| | 线上 | staging |
|---|---|---|
| 服务 / 端口 | `holocard` / 8791 | `holocard-staging` / 8793 |
| 运行用户 | ubuntu | `holocard-stg`（专用，见下） |
| 数据 | `/srv/holocard-*` | `/srv/holocard-staging/`，没人看的卡 2 天清掉 |
| 资源上限 | 3G 内存 / 2 核 | 1.5G / 1 核，队列上限 4 |
| 统计、收录 | umami、允许收录 | 都不带（构建时没有 `.env.production`；网关加 noindex） |

staging 跑的是没评审过的代码，所以**构建和运行都不以 ubuntu 的身份执行 PR 里的代码**：

- 取代码由 ubuntu 做（git fetch / archive，不执行仓库里的任何东西），装依赖、构建、运行都是 `holocard-stg`，在 systemd 沙箱里
- 文件：看不见 /home（gh 凭证、各种密钥）；/srv 和 /opt 换成空目录，只挂回用得到的几个——光「只读」不够，线上的卡片目录和数据库是所有人可读的
- 网络：`holocard-staging-firewall` 用 nftables 按用户拦出站，只放行公网（装依赖）、本机 DNS 和自己的 8793；
  线上服务、数据库、本机其他端口、内网、云元数据一律拒绝。只管这一个用户，别的进程不受影响

Node 运行时、`node_modules`、无头浏览器、模型权重和线上共用一份（只读）。
**已知限制**：PR 要是改了服务端依赖（transformers / sharp / playwright-core）的版本，staging 用的仍是线上那份，得临时改成单独装。

## 为什么不做泳道（每个 PR 一个独立环境）

- 每条泳道都是一个完整的分层服务，加载模型后常驻 1G 上下，这台机器还跑着 Minecraft、数据库和别的生产服务
- 每个 PR 一个子域名（`pr-4.holocard.staging...`）是三级域名，同样需要付费证书
- 眼下同时开着的 PR 就一两个、测的人就两三个，一条泳道 + 「最后推送的生效」够用

同时要测的 PR 多起来、互相覆盖成了问题时再做。最省的升级是按标签选：只部署打了 `staging` 标签的 PR。

## 安装

```bash
sudo bash deploy/staging/install.sh
```

**从 main 上跑**：定时任务执行的是装进 `/usr/local/lib/holocard-staging/` 的那一份，不是 PR 里的，
否则一个 PR 改了部署脚本，下一分钟就会以 ubuntu 的身份执行它。改了这个目录里的文件、合进 main 之后再跑一遍。

网关在 `~/caddy-gateway/Caddyfile` 里（`holocard-staging` 那一段），排查看 `journalctl -u holocard-staging-poll` 和 `-u holocard-staging`。

## 域名

`holocard.staging.longsizhuo.com` 是二级子域名，Cloudflare 免费的通用证书只覆盖根域名和一级子域名，
橙云代理下访问会 TLS 握手失败。要么买高级证书（Advanced Certificate Manager），要么用一级子域名
`holocard-staging.longsizhuo.com`。网关两个都挂着；换域名时改 `holocard-staging.service` 的
`HOLOCARD_PUBLIC_ORIGIN` 和 `deploy.sh` 的 `PUBLIC_URL`。
