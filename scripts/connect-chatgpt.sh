#!/bin/sh
# OpenAI MCP connector; the Cloudflare web tunnel is a separate project.
set +x
set -eu
umask 077
case "${1:-}" in
 ''|--reuse-existing) exec sh scripts/migrate-chatgpt-connector.sh;;
 --rollback) exec sh scripts/migrate-chatgpt-connector.sh --rollback;;
 --new) ;;
 *) echo '用法: connect-chatgpt.sh [--reuse-existing|--rollback|--new]'; exit 2;;
esac
if [ ! -f compose.chatgpt.yaml ] || [ ! -f .env.public ]; then echo '请先部署本版CFO并保留公网配置'; exit 1; fi
if [ "$(docker inspect -f '{{.State.Health.Status}}' cfo-app-1 2>/dev/null)" != healthy ]; then echo 'CFO应用尚未healthy'; exit 1; fi
CFO_TARGET_DIR="$PWD" sh scripts/prepare-chatgpt-credential.sh
if [ ! -s .env.chatgpt ]; then
 if [ ! -t 0 ]; then echo '请在NAS交互终端输入新的正式隧道ID'; exit 1; fi
 printf '新的正式OpenAI Tunnel ID（不是Cloudflare ID，也不是API key）: '
 IFS= read -r cfo_tunnel_id
 cfo_app_image=$(docker inspect -f '{{.Config.Image}}' cfo-app-1)
 docker run --rm --network none --env CFO_TUNNEL_ID="$cfo_tunnel_id" --entrypoint node "$cfo_app_image" \
  -e 'const s=process.env.CFO_TUNNEL_ID;if(!/^tunnel_[A-Za-z0-9_-]{16,100}$/.test(s)||s==="tunnel_6af4529b32cc8191b39327c4cdded4ce"){console.error("请使用新建的正式OpenAI隧道ID，不复用旧测试隧道");process.exit(1)}'
 printf 'CFO_TUNNEL_ID=%s\n' "$cfo_tunnel_id" > .env.chatgpt
 chmod 600 .env.chatgpt
fi
docker compose -f compose.yaml exec -T app node scripts/check-chatgpt.mjs
docker compose --env-file .env.public --env-file .env.chatgpt \
 -f compose.yaml -f compose.https.yaml -f compose.chatgpt.yaml up -d --no-deps tunnel
docker compose --env-file .env.public --env-file .env.chatgpt \
 -f compose.yaml -f compose.https.yaml -f compose.chatgpt.yaml ps tunnel
echo '正式MCP连接器已启动，仍需在ChatGPT安装正式插件并实际调用cfo_health验证。'
