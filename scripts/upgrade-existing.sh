#!/bin/sh
# Run from an extracted UPDATE folder, not inside the live CFO folder.
# Keeps .env*, secrets, original files, DB volumes and public connector untouched.
set +x
set -eu
umask 077
cfo_source=$(cd "$(dirname "$0")/.." && pwd -P)
cfo_target=${CFO_TARGET_DIR:-/volume1/docker/cfo}
cfo_target=$(cd "$cfo_target" && pwd -P)
if [ "$cfo_source" = "$cfo_target" ]; then echo '请从独立解压的更新文件夹运行，不要先覆盖线上项目'; exit 1; fi
if [ ! -f "$cfo_source/lib/version.mjs" ] || [ ! -f "$cfo_target/compose.yaml" ] || [ ! -s "$cfo_target/secrets/web-password.txt" ]; then echo '更新包或现有CFO目录不完整'; exit 1; fi
# The image tag lives in the compose files and the version in lib/version.mjs; a mismatch
# must stop before anything on the live installation is touched, not halfway through a build.
cfo_version=$(sed -n "s/^export const VERSION='\(.*\)';$/\1/p" "$cfo_source/lib/version.mjs")
if [ -z "$cfo_version" ]; then echo '无法从lib/version.mjs读出版本号'; exit 1; fi
cfo_image="personal-cfo:$cfo_version"
for cfo_file in compose.yaml compose.portfolio.yaml compose.import.yaml; do
 if grep -q 'image: personal-cfo:' "$cfo_source/$cfo_file" && ! grep -q "image: $cfo_image\$" "$cfo_source/$cfo_file"; then
  echo "更新包的 $cfo_file 镜像标签与 lib/version.mjs($cfo_version) 不一致，未升级"; exit 1
 fi
done
COMPOSE_PROJECT_NAME=${CFO_PROJECT_NAME:-cfo}
export COMPOSE_PROJECT_NAME
cd "$cfo_target"
cfo_db=$(docker compose -f compose.yaml ps -q postgres)
if [ -z "$cfo_db" ] || [ "$(docker inspect -f '{{.State.Health.Status}}' "$cfo_db")" != healthy ]; then echo '现有数据库尚未healthy；停止升级'; exit 1; fi
cfo_active_collector=$(docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter 'label=com.docker.compose.service=portfolio-sync')
cfo_backup_root=${CFO_BACKUP_DIR:-$(dirname "$cfo_target")/cfo-backups}
mkdir -p "$cfo_backup_root"
cfo_source_backup="$cfo_backup_root/source-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -m 700 "$cfo_source_backup"
# Source backup excludes secrets; the consistent data backup below includes them privately.
for cfo_file in Dockerfile .dockerignore package.json package-lock.json next.config.mjs next-env.d.ts tsconfig.json server.mjs schema.sql compose.yaml compose.https.yaml compose.chatgpt.yaml compose.import.yaml compose.portfolio.yaml app lib scripts probe; do
 if [ -e "$cfo_file" ]; then printf '%s\n' "$cfo_file"; fi
done > "$cfo_source_backup/files.list"
tar -cf "$cfo_source_backup/source.tar" -T "$cfo_source_backup/files.list"
CFO_BACKUP_DIR="$cfo_backup_root" sh "$cfo_source/scripts/backup.sh"
for cfo_file in Dockerfile .dockerignore package.json package-lock.json next.config.mjs next-env.d.ts tsconfig.json server.mjs schema.sql compose.yaml compose.https.yaml compose.chatgpt.yaml compose.import.yaml compose.portfolio.yaml README.md; do
 cp "$cfo_source/$cfo_file" "$cfo_target/$cfo_file"
done
for cfo_dir in app lib scripts; do
 mkdir -p "$cfo_target/$cfo_dir"
 cp -R "$cfo_source/$cfo_dir/." "$cfo_target/$cfo_dir/"
done
mkdir -p "$cfo_target/probe"
for cfo_file in download.mjs policy.mjs errors.mjs; do cp "$cfo_source/probe/$cfo_file" "$cfo_target/probe/$cfo_file"; done
# Optional public connector source is deliberately not replaced or restarted.
if [ -n "${CFO_BUILD_CA_FILE:-}" ]; then
 if [ ! -r "$CFO_BUILD_CA_FILE" ]; then echo '配置的构建CA文件不可读'; exit 1; fi
 docker build --secret "id=proxy_ca,src=$CFO_BUILD_CA_FILE" -t "$cfo_image" .
else
 docker compose -f compose.yaml build app
fi
docker run --rm --network none --entrypoint node "$cfo_image" scripts/check-runtime.mjs
docker run --rm --network none -e "CFO_EXPECTED_VERSION=$cfo_version" --entrypoint node "$cfo_image" --input-type=module \
 -e 'import{VERSION}from"/app/lib/version.mjs";import{createAuth}from"/app/lib/auth.mjs";if(VERSION!==process.env.CFO_EXPECTED_VERSION)process.exit(1);createAuth("Ab12!xyZ");console.log("Image version and password policy verified.")'
if [ -s .env.public ]; then
 docker compose --env-file .env.public -f compose.yaml -f compose.https.yaml up -d --no-deps --no-build app
else
 docker compose -f compose.yaml up -d --no-deps --no-build app
fi
cfo_attempt=0
until curl -fsS http://127.0.0.1:3200/health | grep -q "\"version\":\"$cfo_version\""; do
 cfo_attempt=$((cfo_attempt + 1))
 if [ "$cfo_attempt" -ge 60 ]; then echo '新版本尚未ready，请检查app日志；保留原镜像及备份，不删卷'; exit 1; fi
 sleep 2
done
if [ -n "$cfo_active_collector" ] && [ -s .env.portfolio ]; then
 docker compose --env-file .env.portfolio -f compose.yaml -f compose.portfolio.yaml up -d --no-deps --no-build --force-recreate portfolio-sync
fi
if ! CFO_TARGET_DIR="$cfo_target" CFO_PROJECT_NAME="$COMPOSE_PROJECT_NAME" sh "$cfo_source/scripts/reconnect-chatgpt.sh"; then
 echo 'MCP_RECONNECT_PENDING：网站升级已完成，正式插件连接仍需检查。'
fi
printf 'UPGRADE_READY: %s。源码备份：%s\n' "$cfo_version" "$cfo_source_backup"
echo '原密码、数据库、票据、公网配置和连接器保留。请验证网页及采集器；账户结果出口和自动损益仍需实际验收。'
