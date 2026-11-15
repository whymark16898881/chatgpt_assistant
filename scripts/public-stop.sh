#!/bin/sh
# Stop only the optional CFO public connector; preserve app, DB, files and secrets.
set -eu
docker compose -f compose.cloudflare.yaml stop connector
echo '公网连接器已停止，CFO应用和数据库保持运行。'
