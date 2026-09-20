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
WEB_ROOT="/srv/holocard-web"
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

RELEASE="$(date +%Y%m%d-%H%M%S)-${COMMIT}"

echo "==> 上传前端到 ${HOST}:${WEB_ROOT}/releases/${RELEASE}"
# /srv 是 root 的，所以切换发生在我们自己拥有的 ${WEB_ROOT} 里：
# 先建好新的软链再 mv 覆盖，mv 是原子的，切换瞬间不会有请求读到半截站点
ssh -o BatchMode=yes "${HOST}" "mkdir -p '${WEB_ROOT}/releases/${RELEASE}'"
tar -C dist -cf - . | ssh -o BatchMode=yes "${HOST}" "tar -xf - -C '${WEB_ROOT}/releases/${RELEASE}'"
ssh -o BatchMode=yes "${HOST}" "
  set -e
  chmod -R a+rX '${WEB_ROOT}/releases/${RELEASE}'
  ln -sfn 'releases/${RELEASE}' '${WEB_ROOT}/current.new'
  mv -T '${WEB_ROOT}/current.new' '${WEB_ROOT}/current'
  # 只留最近 5 个版本，回滚够用，也不会把盘撑满
  ls -1dt '${WEB_ROOT}'/releases/*/ | tail -n +6 | xargs -r rm -rf
  echo '当前版本:' \$(readlink '${WEB_ROOT}/current')
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
