#!/bin/sh
# Reuse the existing ChatGPT plugin's OpenAI tunnel; never run two clients for it.
set +x
set -eu
umask 077
mode=${1:-migrate}
case "$mode" in migrate|--rollback) ;; *) echo '用法: migrate-chatgpt-connector.sh [--rollback]'; exit 2;; esac
root=${CFO_TARGET_DIR:-/volume1/docker/cfo}
cd "$root"
project=${CFO_PROJECT_NAME:-cfo}
old=cfo-test-tunnel-1
expected=tunnel_6af4529b32cc8191b39327c4cdded4ce
for tool in docker flock; do command -v "$tool" >/dev/null || { echo "缺少工具: $tool"; exit 1; }; done
if [ ! -f compose.chatgpt.yaml ] || [ ! -s .env.public ] || [ ! -s secrets/web-password.txt ]; then echo '正式CFO配置不完整，未切换'; exit 1; fi
# Serialize against both another migration and the GitHub updater.
mkdir -p secrets/chatgpt-migration
state="$PWD/secrets/chatgpt-migration"
exec 9>"$state/migration.lock"
flock -n 9 || { echo '已有插件迁移正在运行'; exit 1; }
update_lock="${CFO_DEPLOY_ROOT:-$(dirname "$PWD")/cfo-deploy}/update.lock"
if [ -f "$update_lock" ]; then exec 8>"$update_lock"; flock -n 8 || { echo 'GitHub升级正在运行，请完成后重试'; exit 1; }; fi
compose(){ docker compose -p "$project" --env-file .env.public --env-file .env.chatgpt -f compose.yaml -f compose.https.yaml -f compose.chatgpt.yaml "$@"; }
field(){ docker inspect -f "$1" "$2"; }
tunnel_id(){ docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" | sed -n 's/^CONTROL_PLANE_TUNNEL_ID=//p'; }
rollback_needed=false
new_id=''
restore_old(){
 if [ -n "$new_id" ]; then
  docker update --restart=no "$new_id" >/dev/null || return 1
  docker stop "$new_id" >/dev/null || return 1
 fi
 old_id=$(cat "$state/old-container")
 policy=$(cat "$state/old-restart-policy")
 docker update "--restart=$policy" "$old_id" >/dev/null || return 1
 if [ "$(cat "$state/old-running")" = true ]; then docker start "$old_id" >/dev/null || return 1; fi
 rm -f "$state/complete"
 echo 'CHATGPT_CONNECTOR_ROLLED_BACK：已恢复原连接器；数据库和凭证未回退。'
}
finish(){
 code=$?
 trap - EXIT HUP INT TERM
 if [ "$rollback_needed" = true ]; then restore_old || echo '连接器回退未完成，请检查容器状态；不要同时启动两条同ID连接器。'; fi
 exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
if [ "$mode" = --rollback ]; then
 for file in old-container old-restart-policy old-running; do [ -s "$state/$file" ] || { echo '没有完整迁移记录，未修改'; exit 1; }; done
 old_id=$(cat "$state/old-container")
 [ "$(tunnel_id "$old_id")" = "$expected" ] || { echo '原连接器身份不符，未修改'; exit 1; }
 new_id=$(compose ps -aq tunnel)
 if [ -n "$new_id" ]; then [ "$(tunnel_id "$new_id")" = "$expected" ] || { echo '正式连接器使用其他隧道，未修改'; exit 1; }; fi
 restore_old
 exit 0
fi
[ "$(field '{{index .Config.Labels "com.docker.compose.project"}}' "$old")" = cfo-test ] || { echo '原连接器项目身份不符，未修改'; exit 1; }
[ "$(field '{{index .Config.Labels "com.docker.compose.service"}}' "$old")" = tunnel ] || { echo '原连接器服务身份不符，未修改'; exit 1; }
[ "$(tunnel_id "$old")" = "$expected" ] || { echo '原插件隧道ID与已确认配置不符，未切换'; exit 1; }
[ "$(field '{{.State.Health.Status}}' "${project}-app-1")" = healthy ] || { echo '正式CFO尚未healthy，未切换'; exit 1; }
if [ -e .env.chatgpt ]; then
 [ "$(sed -n 's/^CFO_TUNNEL_ID=//p' .env.chatgpt)" = "$expected" ] || { echo '已有其他正式隧道配置，未覆盖，未停止原连接器'; exit 1; }
else
 printf 'CFO_TUNNEL_ID=%s\n' "$expected" > "$state/env.new"
 mv "$state/env.new" .env.chatgpt
fi
CFO_TARGET_DIR="$PWD" sh scripts/prepare-chatgpt-credential.sh
# Check actual formal tools before touching the original connector.
docker compose -p "$project" -f compose.yaml exec -T app node scripts/check-chatgpt.mjs
new_id=$(compose ps -aq tunnel)
if [ -n "$new_id" ]; then [ "$(tunnel_id "$new_id")" = "$expected" ] || { echo '已有正式容器使用其他隧道，未切换'; exit 1; }; fi
if [ -f "$state/complete" ] && [ -n "$new_id" ] && [ "$(field '{{.State.Running}}' "$new_id")" = true ]; then
 [ "$(field '{{.State.Running}}' "$old")" = false ] || { echo '发现新旧连接器同时运行，请检查，未自动改动'; exit 1; }
 echo 'CHATGPT_CONNECTOR_ALREADY_MIGRATED：已复用原插件隧道；请在ChatGPT刷新工具并调用cfo_health。'
 exit 0
fi
if [ -n "$new_id" ] && [ "$(field '{{.State.Running}}' "$new_id")" = true ]; then echo '正式连接器已运行但无有效完成状态，请先核对，未修改'; exit 1; fi
# Pull and create first. A download/configuration error leaves the old client online.
compose create --no-deps tunnel
new_id=$(compose ps -aq tunnel)
[ -n "$new_id" ] && [ "$(tunnel_id "$new_id")" = "$expected" ] || { echo '新连接器身份验证失败，未停止原连接器'; exit 1; }
if [ "$(field '{{.State.Running}}' "$new_id")" = true ]; then echo '正式连接器已运行但无完成记录，请先核对，未停止原连接器'; exit 1; fi
old_id=$(field '{{.Id}}' "$old")
if [ -e "$state/old-container" ]; then
 [ "$(cat "$state/old-container")" = "$old_id" ] && [ -s "$state/old-restart-policy" ] && [ -s "$state/old-running" ] || { echo '迁移记录与原容器不符或不完整，未停止原连接器'; exit 1; }
else
 policy=$(field '{{.HostConfig.RestartPolicy.Name}}' "$old")
 if [ "$policy" = on-failure ]; then retries=$(field '{{.HostConfig.RestartPolicy.MaximumRetryCount}}' "$old"); if [ "$retries" -gt 0 ]; then policy="on-failure:$retries"; fi; fi
 printf '%s\n' "$policy" > "$state/old-restart-policy"
 field '{{.State.Running}}' "$old" > "$state/old-running"
 printf '%s\n' "$old_id" > "$state/old-container"
fi
rollback_needed=true
docker update --restart=no "$old" >/dev/null
docker stop "$old" >/dev/null
docker update --restart=unless-stopped "$new_id" >/dev/null
started=$(date +%s)
compose up -d --no-deps --no-build tunnel
attempt=0
while :; do
 [ "$(field '{{.State.Running}}' "$new_id")" = true ] || { echo '新连接器未持续运行，恢复原入口'; exit 1; }
 # These logs prove connector startup only, not actual ChatGPT tool execution.
 logs=$(docker logs --since "$started" --tail 100 "$new_id" 2>&1)
 if printf '%s' "$logs" | grep -q 'poller started' && printf '%s' "$logs" | grep -q 'tunnel metadata fetched'; then break; fi
 attempt=$((attempt+1)); [ "$attempt" -lt 60 ] || { echo '等待连接器注册超时，恢复原入口'; exit 1; }
 sleep 2
done
printf '%s\n' "$expected" > "$state/complete"
rollback_needed=false
echo 'CHATGPT_CONNECTOR_SWITCHED：原插件隧道已切到正式CFO；旧测试连接器已停止并关闭自动重启，其他测试容器未动。'
echo '仍需ChatGPT内刷新工具，并实际调用cfo_health；本消息不代表已完成截图记账验收。'
