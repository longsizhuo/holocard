#!/usr/bin/env bash
#
# 把某个 PR 的某个提交部署到 staging。平时由 poll.py 自动调，手动用法：
#   deploy.sh <PR 号> [提交 sha]      不给 sha 就用这个 PR 当前的最新提交
#
# 以 ubuntu 用户跑（要用 gh 登录态和免密 sudo），但 PR 里的代码一行都不以 ubuntu 的身份执行：
#   取代码   ubuntu     git fetch / archive，不执行仓库里的任何东西
#   装依赖、构建  holocard-stg  在沙箱里跑（见 build），看不见 /home、看不见线上数据、连不了本机的服务
#   上线     ubuntu     只是拷文件、切软链、重启服务
# 前端和服务端都按版本放目录、用 current 软链指当前版本；新版本健康检查不过就切回上一版。

set -euo pipefail

REPO="longsizhuo/holocard"
STATE_DIR="/var/lib/holocard-staging"
SRC="$STATE_DIR/src"
BUILD="$STATE_DIR/build"
WEB_ROOT="/srv/holocard-staging/web"
APP_ROOT="/opt/holocard-staging"
PORT=8793
# 对外地址，写进 GitHub 的部署记录里，PR 页面上会出现「View deployment」按钮
PUBLIC_URL="${HOLOCARD_STAGING_URL:-https://holocard-staging.longsizhuo.com}"
KEEP=3

PR="${1:?用法：deploy.sh <PR 号> [提交 sha]}"
SHA="${2:-$(gh pr view "$PR" -R "$REPO" --json headRefOid --jq .headRefOid)}"
SHORT="${SHA:0:7}"

# 同一时间只允许一次部署：定时任务和手动部署撞上时，后来的等前一个做完
exec 9>"$STATE_DIR/deploy.lock"
flock 9

log() { echo "[staging] PR #$PR $SHORT：$*"; }

# ---------- GitHub 部署记录 ----------
# 在 PR 时间线上显示「部署中 / 已部署到 staging / 部署失败」，新的一次成功后旧的自动变成 inactive
DEPLOYMENT_ID="$(
  printf '{"ref":"%s","environment":"staging","auto_merge":false,"required_contexts":[],"description":"PR #%s"}' "$SHA" "$PR" |
    gh api "repos/$REPO/deployments" --input - --jq .id 2>/dev/null || true
)"
report() {
  [ -n "$DEPLOYMENT_ID" ] || return 0
  gh api "repos/$REPO/deployments/$DEPLOYMENT_ID/statuses" \
    -f state="$1" -f environment_url="$PUBLIC_URL" -f description="$2" >/dev/null 2>&1 || true
}
trap 'report failure "部署失败，见服务器 journalctl -u holocard-staging-poll"' ERR
report in_progress "正在构建"

# ---------- 取代码（ubuntu，不执行任何仓库代码） ----------
if [ ! -d "$SRC/.git" ]; then
  git clone --quiet --bare "https://github.com/$REPO.git" "$SRC/.git"
fi
git -C "$SRC" fetch --quiet origin "+refs/pull/$PR/head:refs/pr/$PR"
# 导出成一份干净的文件树交给 holocard-stg。不带 .git，也没有 .env.production：前端不带统计 id
sudo rm -rf "$BUILD/tree"
sudo install -d -o ubuntu -g ubuntu "$BUILD/tree"
git -C "$SRC" archive "$SHA" | tar -x -C "$BUILD/tree"
sudo chown -R holocard-stg:holocard-stg "$BUILD/tree"

# ---------- 装依赖、构建（holocard-stg，沙箱里） ----------
# 和 holocard-staging.service 同一套隔离：看不见 /home（gh 凭证、各种密钥）、/srv 和 /opt 只留用得到的，
# 出站只能上公网（npm）不能碰本机服务（holocard-staging-firewall 按用户拦）。pnpm 的缓存留在 $BUILD 里，第二次装很快
log "装依赖、构建"
sudo systemd-run --quiet --wait --pipe --collect \
  --uid=holocard-stg --gid=holocard-stg --working-directory="$BUILD/tree" \
  -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p PrivateDevices=yes \
  -p "TemporaryFileSystem=/srv:ro /opt:ro" -p BindReadOnlyPaths=/opt/holocard/node22 -p "ReadWritePaths=$BUILD" \
  -p MemoryMax=2G -p CPUQuota=200% -p RuntimeMaxSec=900 \
  -E PATH=/opt/holocard/node22/bin:/usr/bin:/bin -E HOME="$BUILD/home" -E COREPACK_HOME="$BUILD/corepack" \
  -E COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -E npm_config_store_dir="$BUILD/pnpm-store" \
  bash -c 'corepack pnpm install --frozen-lockfile --reporter=silent &&
           corepack pnpm build >/dev/null &&
           corepack pnpm exec vite build --config vite.server.config.ts --logLevel error'

# ---------- 上线（ubuntu） ----------
RELEASE="$(date +%Y%m%d-%H%M%S)-pr$PR-$SHORT"
install -d "$WEB_ROOT/releases/$RELEASE" "$APP_ROOT/releases/$RELEASE"
cp -r "$BUILD/tree/dist/." "$WEB_ROOT/releases/$RELEASE/"
cp -r "$BUILD/tree/dist-server/." "$APP_ROOT/releases/$RELEASE/"
# 测的人想确认「我现在测的是哪一版」，打开 /staging.json 就知道
printf '{"pr":%s,"sha":"%s","deployedAt":"%s","url":"https://github.com/%s/pull/%s"}\n' \
  "$PR" "$SHA" "$(date -Iseconds)" "$REPO" "$PR" >"$WEB_ROOT/releases/$RELEASE/staging.json"
chmod -R a+rX "$WEB_ROOT/releases/$RELEASE" "$APP_ROOT/releases/$RELEASE"

# 原子切换：先建好新软链再 mv 覆盖
switch() {
  ln -sfn "releases/$1" "$WEB_ROOT/current.new" && mv -T "$WEB_ROOT/current.new" "$WEB_ROOT/current"
  ln -sfn "releases/$1" "$APP_ROOT/current.new" && mv -T "$APP_ROOT/current.new" "$APP_ROOT/current"
}
healthy() {
  sudo systemctl restart holocard-staging
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
  report success "PR #$PR $SHORT"
  echo "$PR $SHA" >"$STATE_DIR/deployed"
  # 各留最近几个版本，回滚够用
  for root in "$WEB_ROOT" "$APP_ROOT"; do
    ls -1dt "$root"/releases/*/ | tail -n +$((KEEP + 1)) | xargs -r rm -rf
  done
  log "完成"
  exit 0
fi

log "新版本 30 秒内没有就绪，切回上一版"
sudo journalctl -u holocard-staging -n 20 --no-pager >&2
if [ -n "$PREVIOUS" ] && [ -d "$APP_ROOT/releases/$PREVIOUS" ]; then
  switch "$PREVIOUS"
  healthy || log "上一版也起不来了"
fi
rm -rf "$WEB_ROOT/releases/$RELEASE" "$APP_ROOT/releases/$RELEASE"
false
