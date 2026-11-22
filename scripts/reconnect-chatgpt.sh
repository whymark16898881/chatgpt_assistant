#!/bin/sh
# Reconnect only an already-running formal OpenAI client after application restart.
# Does not start stopped clients, the cfo-test client or the Cloudflare connector.
set +x
set -eu
root=${CFO_TARGET_DIR:-/volume1/docker/cfo}
project=${CFO_PROJECT_NAME:-cfo}
cd "$root"
ids=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=tunnel' --filter 'label=com.docker.compose.oneoff=False')
if [ -z "$ids" ]; then echo 'MCP_RECONNECT_SKIPPED：没有正在运行的正式连接器，保持原状态。'; exit 0; fi
set -- $ids
if [ "$#" != 1 ]; then echo 'MCP_RECONNECT_PENDING：正式连接器数量异常，未自动重启。'; exit 1; fi
connector=$1
app=$(docker compose -p "$project" -f compose.yaml ps -q app)
if [ -z "$app" ]; then echo 'MCP_RECONNECT_PENDING：未找到正式应用。'; exit 1; fi
attempt=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$app")" = healthy ]; do
 attempt=$((attempt+1));if [ "$attempt" -ge 30 ]; then echo 'MCP_RECONNECT_PENDING：正式应用尚未healthy。'; exit 1; fi
 sleep 2
done
docker exec "$app" node scripts/check-chatgpt.mjs
# Restarting the container keeps whatever image it was created with, so a pinned
# image upgrade never took effect. up -d leaves the container alone when nothing
# changed and recreates it when the pin moved, which is what an upgrade needs.
docker compose -p "$project" -f compose.yaml -f compose.chatgpt.yaml up -d tunnel >/dev/null
echo 'MCP_CONNECTOR_RECONNECTED：已重启正式OpenAI连接器，仍需ChatGPT实际工具调用确认；未操作旧测试或网页连接器。'
