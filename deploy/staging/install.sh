#!/usr/bin/env bash
#
# 在服务器上装好 staging（一次性，重复跑也安全）。改了这个目录里的文件、合进 main 之后再跑一遍。
#   sudo bash deploy/staging/install.sh
#
# 要从 main 上跑：定时任务执行的是这里装进 /usr/local/lib 的那一份，
# 而不是 PR 里的——否则一个 PR 改了部署脚本，下一分钟就会以 ubuntu 的身份执行它。

set -euo pipefail
cd "$(dirname "$0")"

# 跑 staging 服务和构建的专用用户：没有家目录、不能登录
id holocard-stg >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin holocard-stg

# 服务的数据只有它自己能写
install -d -o holocard-stg -g holocard-stg /srv/holocard-staging/layers /srv/holocard-staging/data
# 前端、服务端的各个版本由部署脚本（ubuntu）写，服务只读。web 本身也要是 ubuntu 的：部署时在它下面切换 current 软链
install -d -o ubuntu -g ubuntu /srv/holocard-staging/web /srv/holocard-staging/web/releases \
  /opt/holocard-staging /opt/holocard-staging/releases /var/lib/holocard-staging
# 构建区归 holocard-stg：依赖缓存、corepack 下的 pnpm、每次导出的源码都在这里
install -d -o holocard-stg -g holocard-stg /var/lib/holocard-staging/build /var/lib/holocard-staging/build/home

# 依赖和线上共用一份，省下约 480MB。PR 要是改了服务端依赖的版本，这里得改成单独装。
# 各版本目录里没有 node_modules，Node 会往上找到这一个
ln -sfn /opt/holocard/node_modules /opt/holocard-staging/node_modules
install -m 644 -o ubuntu -g ubuntu /opt/holocard/package.json /opt/holocard-staging/package.json
chown -h ubuntu:ubuntu /opt/holocard-staging/node_modules
# 早期版本是把服务端文件直接平铺在 /opt/holocard-staging 下，现在按版本放，清掉旧的
find /opt/holocard-staging -maxdepth 1 -type f ! -name package.json -delete
rm -rf /opt/holocard-staging/samples
# 早期版本的源码是完整克隆（带工作区），现在只要裸仓库
if [ -f /var/lib/holocard-staging/src/package.json ]; then rm -rf /var/lib/holocard-staging/src; fi

install -d /usr/local/lib/holocard-staging
install -m 755 deploy.sh poll.py /usr/local/lib/holocard-staging/
install -m 644 firewall.nft /usr/local/lib/holocard-staging/
install -m 644 holocard-staging.service holocard-staging-firewall.service \
  holocard-staging-poll.service holocard-staging-poll.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable holocard-staging-firewall holocard-staging holocard-staging-poll.timer
# 规则改了要重新加载；它是 oneshot + RemainAfterExit，restart 就是再跑一遍 nft -f
systemctl restart holocard-staging-firewall
systemctl start holocard-staging-poll.timer

echo "装好了。第一次部署：/usr/local/lib/holocard-staging/deploy.sh <PR 号>（以 ubuntu 身份）"
