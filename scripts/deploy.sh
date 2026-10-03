#!/usr/bin/env bash
#
# 手动发版到 Oracle。平时不用：main 有新提交时服务器上的定时器会自动发（deploy/production/）。
# 这个脚本只是让服务器上的同一套流程去发本地 HEAD 这个提交——构建、等服务空闲、切版本、
# 健康检查不过自动切回，全在服务器上做（见 deploy/production/deploy.sh）。
#
# 用法：
#   bash scripts/deploy.sh            发到 ~/.ssh/config 里名为 oracle 的主机
#   HOLOCARD_HOST=别的主机 bash scripts/deploy.sh
#
# 发的不是 main 的最新提交时（比如回滚），先在服务器上 touch /var/lib/holocard/paused，
# 否则定时器下一分钟就把 main 发回去。

set -euo pipefail

HOST="${HOLOCARD_HOST:-oracle}"

cd "$(dirname "$0")/.."

# 服务器是从 GitHub 拉代码构建的：没提交、没推的改动根本到不了线上
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交的改动，先提交再发版：" >&2
  git status --short >&2
  exit 1
fi

SHA="$(git rev-parse HEAD)"
if ! git branch -r --contains HEAD 2>/dev/null | grep -q .; then
  echo "HEAD (${SHA:0:7}) 还没推到远端，服务器拉不到。先 git push。" >&2
  exit 1
fi

ssh -o BatchMode=yes "${HOST}" "/usr/local/lib/holocard/deploy.sh ${SHA}"
