#!/usr/bin/env bash
#
# 发版到自己的服务器
#
# 链路：浏览器 → Cloudflare → cloudflared 隧道 → nginx（只听回环）→ /var/www/holocard/current
#
# 本脚本只负责「内容」：构建、打源码包、预压缩、上传、切换。
# 服务器侧的一次性配置（nginx 站点、隧道 ingress、DNS）见 deploy/README.md。
#
# 用法：
#   bash scripts/deploy.sh            发到 ~/.ssh/config 里名为 mail 的主机
#   HOLOCARD_HOST=别的主机 bash scripts/deploy.sh

set -euo pipefail

HOST="${HOLOCARD_HOST:-mail}"
REMOTE_ROOT="/var/www/holocard"

cd "$(dirname "$0")/.."

# 源码包是从 HEAD 打出来的。工作区不干净的话，线上跑的代码和提供下载的源码就对不上——
# 对 GPL 来说这不是小事，所以直接拒绝发版。
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交的改动，先提交再发版：" >&2
  git status --short >&2
  exit 1
fi

COMMIT="$(git rev-parse --short HEAD)"
RELEASE="$(date +%Y%m%d-%H%M%S)-${COMMIT}"

echo "==> 构建 ${COMMIT}"
pnpm build

echo "==> 打源码包"
mkdir -p dist/source
git archive --format=tar.gz --prefix="holocard-${COMMIT}/" -o dist/source/holocard-src.tar.gz HEAD
echo "${COMMIT}" > dist/source/COMMIT

echo "==> 预压缩"
# nginx 开了 gzip_static，有 .gz 就直接发，不用每次请求现压。
# 流量要走家里的上行带宽，26MB 的 wasm 压完只有 6.7MB。
find dist -type f \
  \( -name '*.js' -o -name '*.css' -o -name '*.wasm' -o -name '*.svg' -o -name '*.json' -o -name '*.html' \) \
  -exec gzip -k -9 -f {} \;

echo "==> 上传到 ${HOST}:${REMOTE_ROOT}/releases/${RELEASE}"
ssh -o BatchMode=yes "${HOST}" "mkdir -p '${REMOTE_ROOT}/releases/${RELEASE}'"
tar -C dist -cf - . | ssh -o BatchMode=yes "${HOST}" "tar -xf - -C '${REMOTE_ROOT}/releases/${RELEASE}'"

echo "==> 切换"
# 先建好新的软链再 mv 覆盖：mv 是原子的，切换瞬间不会有请求读到半截目录。
# 旧版本全部留着不删，回滚只要把 current 指回去。
ssh -o BatchMode=yes "${HOST}" "
  set -e
  chmod -R a+rX '${REMOTE_ROOT}/releases/${RELEASE}'
  ln -sfn 'releases/${RELEASE}' '${REMOTE_ROOT}/current.new'
  mv -T '${REMOTE_ROOT}/current.new' '${REMOTE_ROOT}/current'
  echo '当前版本:' \$(readlink '${REMOTE_ROOT}/current')
  echo '已有版本:' \$(ls -1 '${REMOTE_ROOT}/releases' | wc -l) '个，占用' \$(du -sh '${REMOTE_ROOT}/releases' | cut -f1)
"

echo "==> 完成：${RELEASE}"
