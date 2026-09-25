#!/usr/bin/env bash
#
# 把某个 PR 的某个提交部署到 staging。平时由 poll.py 自动调，手动用法：
#   deploy.sh <PR 号> [提交 sha]      不给 sha 就用这个 PR 当前的最新提交
#
# 在服务器上以 ubuntu 用户跑（需要 gh 登录态和免密 sudo 重启服务）。
# 构建在 /var/lib/holocard-staging/src 这份独立的克隆里做，不碰任何人的工作区。
# 构建失败时线上的 staging 不受影响：前端软链和服务端文件都是构建成功之后才换。

set -euo pipefail

REPO="longsizhuo/holocard"
# 定时任务不走交互 shell，nvm 装的 node / pnpm 要自己加进 PATH
export PATH="/home/ubuntu/.nvm/versions/node/v24.14.0/bin:$PATH"

STATE_DIR="/var/lib/holocard-staging"
SRC="$STATE_DIR/src"
WEB_ROOT="/srv/holocard-staging/web"
APP_DIR="/opt/holocard-staging"
PORT=8793
# 对外地址，写进 GitHub 的部署记录里，PR 页面上会出现「View deployment」按钮
PUBLIC_URL="${HOLOCARD_STAGING_URL:-https://holocard.staging.longsizhuo.com}"

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

# ---------- 取代码、构建 ----------
if [ ! -d "$SRC/.git" ]; then
  git clone --quiet "https://github.com/$REPO.git" "$SRC"
fi
git -C "$SRC" fetch --quiet origin "+refs/pull/$PR/head:refs/remotes/origin/pr/$PR"
git -C "$SRC" checkout --quiet --force --detach "$SHA"
# 清掉上一次的构建产物和残留文件，但保留 node_modules，装依赖快很多
git -C "$SRC" clean -fdxq -e node_modules

log "装依赖、构建"
cd "$SRC"
pnpm install --frozen-lockfile --silent
# 这份克隆里没有 .env.production，前端不带统计 id，staging 的访问不会进线上统计
pnpm build >/dev/null
pnpm exec vite build --config vite.server.config.ts --logLevel error

# ---------- 上线 ----------
RELEASE="$(date +%Y%m%d-%H%M%S)-pr$PR-$SHORT"
mkdir -p "$WEB_ROOT/releases/$RELEASE"
cp -r dist/. "$WEB_ROOT/releases/$RELEASE/"
# 测的人想确认「我现在测的是哪一版」，打开 /staging.json 就知道
printf '{"pr":%s,"sha":"%s","deployedAt":"%s","url":"https://github.com/%s/pull/%s"}\n' \
  "$PR" "$SHA" "$(date -Iseconds)" "$REPO" "$PR" >"$WEB_ROOT/releases/$RELEASE/staging.json"
chmod -R a+rX "$WEB_ROOT/releases/$RELEASE"
ln -sfn "releases/$RELEASE" "$WEB_ROOT/current.new"
mv -T "$WEB_ROOT/current.new" "$WEB_ROOT/current"
# 只留最近 3 个版本
ls -1dt "$WEB_ROOT"/releases/*/ | tail -n +4 | xargs -r rm -rf

cp -r dist-server/. "$APP_DIR/"
chmod -R a+rX "$APP_DIR"

log "重启服务"
sudo systemctl restart holocard-staging
for _ in $(seq 1 30); do
  sleep 1
  if curl -sf -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null; then
    report success "PR #$PR $SHORT"
    echo "$PR $SHA" >"$STATE_DIR/deployed"
    log "完成"
    exit 0
  fi
done

log "服务 30 秒内没有就绪"
sudo journalctl -u holocard-staging -n 20 --no-pager >&2
false
