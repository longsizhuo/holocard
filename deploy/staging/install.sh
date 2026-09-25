#!/usr/bin/env bash
#
# 在服务器上装好 staging（一次性，重复跑也安全）。改了 poll.py / deploy.sh / 单元文件之后再跑一遍即可。
#   sudo bash deploy/staging/install.sh
#
# 要从 main 上跑：定时任务执行的是这里装进 /usr/local/lib 的那一份，
# 而不是 PR 里的——否则一个 PR 改了部署脚本，下一分钟就会以 ubuntu 的身份执行它。

set -euo pipefail
cd "$(dirname "$0")"

# 运行 staging 服务的专用用户：没有家目录、不能登录
id holocard-stg >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin holocard-stg

# 服务的数据只有它自己能写；前端和服务端文件由部署脚本（ubuntu）写，它只读
install -d -o holocard-stg -g holocard-stg /srv/holocard-staging/layers /srv/holocard-staging/data
# web 本身也要是 ubuntu 的：部署时在它下面原子切换 current 软链
install -d -o ubuntu -g ubuntu /srv/holocard-staging/web /srv/holocard-staging/web/releases /opt/holocard-staging /var/lib/holocard-staging
# 依赖和线上共用一份，省下约 480MB。PR 要是改了服务端依赖的版本，这里得改成单独装
ln -sfn /opt/holocard/node_modules /opt/holocard-staging/node_modules
install -m 644 -o ubuntu -g ubuntu /opt/holocard/package.json /opt/holocard-staging/package.json
# 目录里的东西都归部署脚本（ubuntu）管，它会覆盖、改权限
chown -h ubuntu:ubuntu /opt/holocard-staging/node_modules

install -d /usr/local/lib/holocard-staging
install -m 755 deploy.sh poll.py /usr/local/lib/holocard-staging/
install -m 644 holocard-staging.service holocard-staging-poll.service holocard-staging-poll.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable holocard-staging holocard-staging-poll.timer
systemctl start holocard-staging-poll.timer

echo "装好了。第一次部署：/usr/local/lib/holocard-staging/deploy.sh <PR 号>（以 ubuntu 身份）"
