#!/usr/bin/env bash
#
# 在服务器上装好线上自动发版（一次性，重复跑也安全）。改了这个目录里的文件、合进 main 之后再跑一遍。
#   sudo bash deploy/production/install.sh [.env.production 的路径]
#
# 装完之后定时器每分钟看一次 main，有新提交就发版（见 deploy.sh）。

set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${1:-../../.env.production}"
STATE_DIR=/var/lib/holocard
APP_ROOT=/opt/holocard
WEB_ROOT=/srv/holocard-web

install -d -o ubuntu -g ubuntu "$STATE_DIR" "$APP_ROOT/releases"
if [ -f "$ENV_FILE" ]; then
  install -m 600 -o ubuntu -g ubuntu "$ENV_FILE" "$STATE_DIR/env.production"
else
  echo "没找到 $ENV_FILE，线上前端不带统计" >&2
fi

# 第一次装：服务端还是平铺在 /opt/holocard 下的老布局。把正在跑的这一版收进 releases，
# 名字和前端当前那一版一样——回滚时前后端按同一个名字一起切
if [ ! -e "$APP_ROOT/current" ]; then
  RELEASE="$(basename "$(readlink "$WEB_ROOT/current")")"
  install -d -o ubuntu -g ubuntu "$APP_ROOT/releases/$RELEASE"
  cp -r "$APP_ROOT/holocard-server.mjs" "$APP_ROOT/segment-worker.mjs" "$APP_ROOT/chunks" \
    "$APP_ROOT/releases/$RELEASE/"
  chown -R ubuntu:ubuntu "$APP_ROOT/releases/$RELEASE"
  ln -sfn "releases/$RELEASE" "$APP_ROOT/current"
  chown -h ubuntu:ubuntu "$APP_ROOT/current"
fi

install -d /usr/local/lib/holocard /etc/systemd/system/holocard.service.d
install -m 755 deploy.sh /usr/local/lib/holocard/
install -m 644 holocard-release.conf /etc/systemd/system/holocard.service.d/release.conf
install -m 644 holocard-deploy.service holocard-deploy.timer /etc/systemd/system/
systemctl daemon-reload
# 不在这里重启 holocard：覆盖配置等下一次发版重启时生效，那时 current 已经指好了
systemctl enable --now holocard-deploy.timer

echo "装好了。定时器一分钟内会检查 main；看进度：journalctl -fu holocard-deploy"
