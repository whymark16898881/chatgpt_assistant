#!/bin/sh
# Managed by Personal CFO GitHub deployment
# GitHub stable -> immutable checkout -> existing NAS backup/build/health upgrade.
set +x
set -eu
umask 077
repo=whymark16898881/chatgpt_assistant
mode=${1:-update}
case "$mode" in update|--automatic|--retry|--check|--status) ;; *) echo '用法: cfo-update [--check|--status|--retry]'; exit 2;; esac
if [ "$(id -u)" != 0 ] && [ "${CFO_DEPLOY_TEST_MODE:-}" != isolated ]; then echo '请使用sudo运行cfo-update'; exit 1; fi
root=${CFO_TARGET_DIR:-/volume1/docker/cfo}
state=${CFO_DEPLOY_ROOT:-$(dirname "$root")/cfo-deploy}
project=${CFO_PROJECT_NAME:-cfo}
if [ ! -f "$root/compose.yaml" ] || [ ! -s "$root/secrets/web-password.txt" ]; then echo '未找到现有CFO配置，未修改'; exit 1; fi
root=$(cd "$root" && pwd -P)
mkdir -p "$state"
state=$(cd "$state" && pwd -P)
case "$state/" in //|"$root/"*) echo '部署状态目录必须独立于线上CFO目录'; exit 1;; esac
marker="$state/managed-by-personal-cfo"
if [ ! -e "$marker" ]; then
 if [ -n "$(ls -A "$state")" ]; then echo '部署目录非空且非本工具管理，未覆盖'; exit 1; fi
 printf '%s\n' 'personal-cfo-github-v1' > "$marker"
fi
if [ "$(cat "$marker")" != personal-cfo-github-v1 ]; then echo '部署目录标识不符'; exit 1; fi
if [ "$mode" = --status ]; then
 printf '已部署commit: ';if [ -f "$state/applied-commit" ]; then cat "$state/applied-commit";else echo '尚未通过GitHub更新';fi
 if [ -f "$state/failed-commit" ]; then printf '失败待处理commit: ';cat "$state/failed-commit";fi
 if [ -f "$state/in-progress" ]; then printf '正在部署commit: ';cat "$state/in-progress";fi
 curl -q -fsS --max-time 10 -w '\n' http://127.0.0.1:3200/health || true
 exit 0
fi
for command in curl tar flock docker; do command -v "$command" >/dev/null || { echo "缺少工具: $command"; exit 1; }; done
exec 9>"$state/update.lock"
if ! flock -n 9; then
 echo '已有CFO更新任务正在运行'
 if [ "$mode" = --automatic ]; then exit 0; else exit 75; fi
fi
sha=$(curl -q -fsSL --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 --retry 2 -H 'Accept: application/vnd.github.sha' -H 'User-Agent: Personal-CFO-updater' "https://api.github.com/repos/$repo/commits/stable")
case "$sha" in ''|*[!0-9a-f]*) echo 'GitHub未返回有效commit，未部署'; exit 1;; esac
if [ "${#sha}" != 40 ]; then echo 'GitHub commit长度不符，未部署'; exit 1; fi
applied=$(cat "$state/applied-commit" 2>/dev/null || true)
printf 'GitHub stable: %s\n' "$sha"
if [ "$mode" = --check ]; then printf 'NAS deployed: %s\n' "${applied:-none}"; exit 0; fi
if [ "$sha" = "$applied" ]; then echo 'ALREADY_CURRENT：当前已是发布版本'; exit 0; fi
failed=$(cat "$state/failed-commit" 2>/dev/null || true)
if [ "$sha" = "$failed" ] && [ "$mode" != --retry ]; then echo '该commit上次部署失败，自动重试已暂停；修复后运行sudo cfo-update --retry'; exit 0; fi
mkdir -p "$state/releases"
tmp=''
cleanup(){ if [ -n "$tmp" ]; then case "$tmp" in "$state"/releases/.fetch.*) rm -rf -- "$tmp";; esac;fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
candidate="$state/releases/$sha"
if [ -e "$candidate" ]; then
 if [ ! -f "$candidate/.cfo-source-commit" ] || [ "$(cat "$candidate/.cfo-source-commit")" != "$sha" ]; then echo '源码缓存标识不符，未覆盖'; exit 1; fi
else
 tmp=$(mktemp -d "$state/releases/.fetch.XXXXXX")
 curl -q -fsSL --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 --retry 2 "https://codeload.github.com/$repo/tar.gz/$sha" -o "$tmp/source.tar.gz"
 if ! tar -tzf "$tmp/source.tar.gz" | awk 'BEGIN{ok=1} /^\//{ok=0} /(^|\/)\.\.(\/|$)/{ok=0} END{exit !ok}'; then echo '源码包路径不安全，未部署'; exit 1; fi
 mkdir "$tmp/source"
 tar -xzf "$tmp/source.tar.gz" --strip-components=1 -C "$tmp/source"
 for file in scripts/upgrade-existing.sh scripts/backup.sh Dockerfile compose.yaml lib/version.mjs; do
  if [ ! -f "$tmp/source/$file" ]; then echo 'GitHub源码不完整，未部署'; exit 1; fi
 done
 printf '%s\n' "$sha" > "$tmp/source/.cfo-source-commit"
 mv "$tmp/source" "$candidate"
fi
# Save only code configuration here. Secrets, database and receipts are backed up
# privately by upgrade-existing.sh. Never restore a database automatically.
rollback_dir=$(mktemp -d "$state/.rollback.XXXXXX")
for file in compose.yaml compose.https.yaml compose.portfolio.yaml; do if [ -f "$root/$file" ]; then cp "$root/$file" "$rollback_dir/$file";fi;done
old_app=$(docker compose -p "$project" -f "$root/compose.yaml" ps -q app)
old_image=''
if [ -n "$old_app" ]; then old_image=$(docker inspect -f '{{.Image}}' "$old_app");fi
old_collector=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=portfolio-sync' --filter 'label=com.docker.compose.oneoff=False')
collector_image=''
if [ -n "$old_collector" ]; then collector_image=$(docker inspect -f '{{.Image}}' "$old_collector");fi
rollback(){
 case "$old_image" in sha256:*) ;; *) echo '旧镜像标识不可用，请检查日志'; return 1;; esac
 for file in compose.yaml compose.https.yaml compose.portfolio.yaml; do if [ -f "$rollback_dir/$file" ]; then cp "$rollback_dir/$file" "$root/$file";fi;done
 printf 'services:\n  app:\n    image: %s\n' "$old_image" > "$rollback_dir/images.yaml"
 if [ -n "$collector_image" ]; then printf '  portfolio-sync:\n    image: %s\n' "$collector_image" >> "$rollback_dir/images.yaml";fi
 if [ -s "$root/.env.public" ]; then
  docker compose --project-directory "$root" -p "$project" --env-file "$root/.env.public" -f "$root/compose.yaml" -f "$root/compose.https.yaml" -f "$rollback_dir/images.yaml" up -d --no-deps --no-build app || return 1
 else
  docker compose --project-directory "$root" -p "$project" -f "$root/compose.yaml" -f "$rollback_dir/images.yaml" up -d --no-deps --no-build app || return 1
 fi
 if [ -n "$collector_image" ] && [ -s "$root/.env.portfolio" ]; then
  docker compose --project-directory "$root" -p "$project" --env-file "$root/.env.portfolio" -f "$root/compose.yaml" -f "$root/compose.portfolio.yaml" -f "$rollback_dir/images.yaml" up -d --no-deps --no-build portfolio-sync || return 1
 fi
 if [ -f "$candidate/scripts/reconnect-chatgpt.sh" ]; then
  CFO_TARGET_DIR="$root" CFO_PROJECT_NAME="$project" sh "$candidate/scripts/reconnect-chatgpt.sh" || echo 'MCP_RECONNECT_PENDING：旧网站已恢复，插件连接仍需检查。'
 fi
 echo 'OLD_IMAGES_RESTORED：已恢复旧服务镜像，数据库未回退；请核验网页健康。'
}
printf '%s\n' "$sha" > "$state/in-progress"
if CFO_TARGET_DIR="$root" CFO_PROJECT_NAME="$project" sh "$candidate/scripts/upgrade-existing.sh"; then
 printf '%s\n' "$sha" > "$state/.applied-commit.tmp"
 mv "$state/.applied-commit.tmp" "$state/applied-commit"
 rm -f "$state/failed-commit" "$state/in-progress"
 # Replace the installed updater atomically, so a running shell keeps its old inode.
 installed=${CFO_UPDATER_INSTALLED_PATH:-/usr/local/lib/personal-cfo/github-update.sh}
 if [ -f "$installed" ] && grep -q '^# Managed by Personal CFO GitHub deployment$' "$installed" && [ -f "$candidate/scripts/github-update.sh" ]; then
  cp "$candidate/scripts/github-update.sh" "$installed.new"
  chmod 700 "$installed.new"
  mv "$installed.new" "$installed"
 fi
 printf 'GITHUB_DEPLOY_READY: %s\n' "$sha"
else
 code=$?
 printf '%s\n' "$sha" > "$state/failed-commit"
 rm -f "$state/in-progress"
 rollback || echo '旧服务恢复未完成，请检查app/collector日志；未恢复旧数据库。'
 echo 'GITHUB_DEPLOY_FAILED：该版本自动重试已暂停。'
 exit "$code"
fi
