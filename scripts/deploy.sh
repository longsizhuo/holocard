#!/usr/bin/env bash
#
# 发版到 Oracle
#
# 链路：浏览器 → Cloudflare → Caddy（:80/:443）→
#         静态前端 /srv/holocard
#         /api/* 反代到分层服务 127.0.0.1:8791
#
# 本脚本只管「内容」：构建、打源码包、上传、重启服务。
# 服务器侧的一次性配置（目录、Node、依赖、权重、systemd、Caddy、DNS）见 deploy/README.md。
#
# 用法：
#   bash scripts/deploy.sh            发到 ~/.ssh/config 里名为 oracle 的主机
#   HOLOCARD_HOST=别的主机 bash scripts/deploy.sh

set -euo pipefail

HOST="${HOLOCARD_HOST:-oracle}"
WEB_DIR="/srv/holocard"
APP_DIR="/opt/holocard"

cd "$(dirname "$0")/.."

# 源码包是从 HEAD 打出来的。工作区不干净的话，线上跑的代码和提供下载的源码就对不上——
# 对 GPL 来说这不是小事，所以直接拒绝发版。
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交的改动，先提交再发版：" >&2
  git status --short >&2
  exit 1
fi

COMMIT="$(git rev-parse --short HEAD)"
echo "==> 构建 ${COMMIT}"
pnpm build
pnpm exec vite build --config vite.server.config.ts

echo "==> 打源码包"
mkdir -p dist/source
git archive --format=tar.gz --prefix="holocard-${COMMIT}/" -o dist/source/holocard-src.tar.gz HEAD
echo "${COMMIT}" > dist/source/COMMIT

echo "==> 上传前端到 ${HOST}:${WEB_DIR}"
# 先传进一个临时目录再原子换名，切换瞬间不会有请求读到半截站点
ssh -o BatchMode=yes "${HOST}" "rm -rf ${WEB_DIR}.new && mkdir -p ${WEB_DIR}.new"
tar -C dist -cf - . | ssh -o BatchMode=yes "${HOST}" "tar -xf - -C ${WEB_DIR}.new"
ssh -o BatchMode=yes "${HOST}" "
  set -e
  chmod -R a+rX ${WEB_DIR}.new
  rm -rf ${WEB_DIR}.old
  [ -d ${WEB_DIR} ] && mv ${WEB_DIR} ${WEB_DIR}.old || true
  mv ${WEB_DIR}.new ${WEB_DIR}
  rm -rf ${WEB_DIR}.old
"

echo "==> 上传服务到 ${HOST}:${APP_DIR}"
tar -C dist-server -cf - . | ssh -o BatchMode=yes "${HOST}" "tar -xf - -C ${APP_DIR}"

echo "==> 重启分层服务"
ssh -o BatchMode=yes "${HOST}" "
  set -e
  sudo systemctl restart holocard
  # 等它真的起来，别只看 systemctl 的返回值
  for i in \$(seq 1 20); do
    sleep 1
    if curl -sf -m 3 http://127.0.0.1:8791/api/health >/dev/null; then
      echo '服务健康检查通过：' \$(curl -s -m 3 http://127.0.0.1:8791/api/health)
      exit 0
    fi
  done
  echo '服务没能在 20 秒内就绪，最近日志：' >&2
  sudo journalctl -u holocard -n 20 --no-pager >&2
  exit 1
"

echo "==> 完成：${COMMIT}"
