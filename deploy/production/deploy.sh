#!/usr/bin/env bash
#
# 把 main 上的某个提交发到线上。平时由 holocard-deploy.timer 每分钟调一次（--if-new），手动用法：
#   deploy.sh            发 origin/main 当前的提交
#   deploy.sh <sha>      发指定提交（回滚到某一版也用它）
#   deploy.sh --if-new   只在 main 有还没发过、也没失败过的新提交时才发（定时器用）
#
# 回滚到旧版本：先 touch /var/lib/holocard/paused 让定时器停手，再 deploy.sh <旧 sha>；
# 修好之后 rm 掉 paused，定时器下一分钟就把 main 发上去。
#
# 以 ubuntu 用户跑（要用 gh 登录态和免密 sudo 重启服务）。
# 和 staging 不同，这里不进沙箱构建：只发 main 上的提交，也就是已经合并、审过的代码。
# 前端和服务端都按版本放目录、用 current 软链指当前版本；新版本健康检查不过就切回上一版。

set -euo pipefail

REPO="longsizhuo/holocard"
STATE_DIR="/var/lib/holocard"
TREE="$STATE_DIR/repo"
WEB_ROOT="/srv/holocard-web"
APP_ROOT="/opt/holocard"
PORT=8791
PUBLIC_URL="https://holocard.longsizhuo.com"
KEEP=5
# 发版前等手上的活干完（分层、导出），最多等这么久，超时照发
DRAIN_SECONDS=600
# 只动了这些路径的提交不影响站点，不重启服务，直接记成已发
NOT_APP='^(deploy/|docs/|\.github/|lab/|scripts/deploy\.sh$)|\.md$'

export PATH="/opt/holocard/node22/bin:/usr/bin:/bin"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

IF_NEW=0
if [ "${1:-}" = "--if-new" ]; then
  IF_NEW=1
  shift
fi

# 同一时间只允许一次发版。定时器撞上正在进行的那次就直接退出，等下一分钟
exec 9>"$STATE_DIR/deploy.lock"
if [ "$IF_NEW" = 1 ]; then
  flock -n 9 || exit 0
  [ -e "$STATE_DIR/paused" ] && exit 0
else
  flock 9
fi

if [ ! -d "$TREE/.git" ]; then
  git clone --quiet "https://github.com/$REPO.git" "$TREE"
fi
git -C "$TREE" fetch --quiet origin main
# 指定的提交不一定在 main 上（手动发某个分支的提交）。GitHub 允许按完整 sha 拉
if [ -n "${1:-}" ]; then git -C "$TREE" fetch --quiet origin "$1" 2>/dev/null || true; fi
SHA="$(git -C "$TREE" rev-parse "${1:-origin/main}^{commit}")"
SHORT="${SHA:0:7}"
DEPLOYED="$(cat "$STATE_DIR/deployed" 2>/dev/null || true)"

log() { echo "[production] $SHORT：$*"; }

if [ "$IF_NEW" = 1 ]; then
  [ "$SHA" = "$DEPLOYED" ] && exit 0
  # 失败过的提交不再每分钟重试一遍（每次都要重启服务），推新提交才会再试
  [ "$SHA" = "$(cat "$STATE_DIR/attempted" 2>/dev/null || true)" ] && exit 0
  if [ -n "$DEPLOYED" ] && git -C "$TREE" cat-file -e "$DEPLOYED" 2>/dev/null &&
    ! git -C "$TREE" diff --name-only "$DEPLOYED" "$SHA" | grep -Evq "$NOT_APP"; then
    log "只改了文档、部署脚本这类不影响站点的文件，不用发"
    echo "$SHA" >"$STATE_DIR/deployed"
    exit 0
  fi
fi
echo "$SHA" >"$STATE_DIR/attempted"

# ---------- GitHub 部署记录 ----------
# 提交和仓库首页上显示「部署中 / 已上线 / 失败」
DEPLOYMENT_ID="$(
  printf '{"ref":"%s","environment":"production","production_environment":true,"auto_merge":false,"required_contexts":[]}' "$SHA" |
    gh api "repos/$REPO/deployments" --input - --jq .id 2>/dev/null || true
)"
report() {
  [ -n "$DEPLOYMENT_ID" ] || return 0
  gh api "repos/$REPO/deployments/$DEPLOYMENT_ID/statuses" \
    -f state="$1" -f environment_url="$PUBLIC_URL" -f description="$2" >/dev/null 2>&1 || true
}
trap 'report failure "发版失败，见服务器 journalctl -u holocard-deploy"' ERR
report in_progress "正在构建"

# ---------- 构建 ----------
# 一直用同一份检出：node_modules 留着，第二次装依赖很快。清掉其余未跟踪的文件，构建只看这个提交
log "构建"
git -C "$TREE" checkout --quiet --force --detach "$SHA"
git -C "$TREE" clean -qfdx -e node_modules
# 埋点的站点 id 不进仓库，发版机上自己留一份；少了它站点照常工作，只是没有统计
if [ -f "$STATE_DIR/env.production" ]; then cp "$STATE_DIR/env.production" "$TREE/.env.production"; fi
(
  cd "$TREE"
  corepack pnpm install --frozen-lockfile --reporter=silent
  corepack pnpm build >/dev/null
  corepack pnpm exec vite build --config vite.server.config.ts --logLevel error
)

RELEASE="$(date +%Y%m%d-%H%M%S)-$SHORT"
install -d "$WEB_ROOT/releases/$RELEASE" "$APP_ROOT/releases/$RELEASE"
cp -r "$TREE/dist/." "$WEB_ROOT/releases/$RELEASE/"
cp -r "$TREE/dist-server/." "$APP_ROOT/releases/$RELEASE/"
chmod -R a+rX "$WEB_ROOT/releases/$RELEASE" "$APP_ROOT/releases/$RELEASE"

# ---------- 等手上的活干完 ----------
# 重启会打断正在分层、导出的卡，用户那边就是一次失败。空闲了再重启；一直忙就等到上限照发
busy() {
  curl -sf -m 3 "http://127.0.0.1:$PORT/api/health" | python3 -c '
import json, sys
h = json.load(sys.stdin)
sys.exit(0 if h["running"] + h["queued"] + h.get("exporting", 0) + h.get("exportQueued", 0) > 0 else 1)'
}
report in_progress "等服务空闲"
for _ in $(seq 1 "$DRAIN_SECONDS"); do
  busy || break
  sleep 1
done

# ---------- 上线 ----------
# 原子切换：先建好新软链再 mv 覆盖
switch() {
  ln -sfn "releases/$1" "$WEB_ROOT/current.new" && mv -T "$WEB_ROOT/current.new" "$WEB_ROOT/current"
  ln -sfn "releases/$1" "$APP_ROOT/current.new" && mv -T "$APP_ROOT/current.new" "$APP_ROOT/current"
}
healthy() {
  sudo systemctl restart holocard
  for _ in $(seq 1 30); do
    sleep 1
    curl -sf -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null && return 0
  done
  return 1
}

PREVIOUS="$(basename "$(readlink "$APP_ROOT/current" 2>/dev/null)" 2>/dev/null || true)"
switch "$RELEASE"
log "重启服务"
if healthy; then
  report success "$SHORT"
  # 查库、下架、发对外接口 key 的脚本：服务器上没装 sqlite3 命令行，用它们查、下架、发 key。
  # 不进版本目录，平铺在 /opt/holocard 下，运维文档里的 cd /opt/holocard && node db.mjs 照旧能用
  cp "$TREE/scripts/db.mjs" "$TREE/scripts/takedown.mjs" "$TREE/scripts/apikey.mjs" "$APP_ROOT/"
  echo "$SHA" >"$STATE_DIR/deployed"
  # 各留最近几个版本，回滚够用
  for root in "$WEB_ROOT" "$APP_ROOT"; do
    ls -1dt "$root"/releases/*/ | tail -n +$((KEEP + 1)) | xargs -r rm -rf
  done
  log "完成"
  exit 0
fi

log "新版本 30 秒内没有就绪，切回上一版"
sudo journalctl -u holocard -n 20 --no-pager >&2
if [ -n "$PREVIOUS" ] && [ -d "$APP_ROOT/releases/$PREVIOUS" ] && [ -d "$WEB_ROOT/releases/$PREVIOUS" ]; then
  switch "$PREVIOUS"
  healthy || log "上一版也起不来了"
fi
rm -rf "$WEB_ROOT/releases/$RELEASE" "$APP_ROOT/releases/$RELEASE"
false
