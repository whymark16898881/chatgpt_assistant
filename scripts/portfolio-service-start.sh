#!/bin/sh
# Boot-safe start for CFO readonly collector on Mark. Existing share only.
set -eu
cfo_root=${CFO_TARGET_DIR:-/volume1/docker/cfo}
cd "$cfo_root"
cfo_mount="$cfo_root/portfolio-source"
cfo_cred="$cfo_root/secrets/smb-cfo.cred"
if [ ! -s "$cfo_cred" ]; then echo '只读SMB凭证尚未配置'; exit 1; fi
mkdir -p "$cfo_mount"
if ! findmnt -rn -M "$cfo_mount" >/dev/null 2>&1; then
 if [ -n "$(ls -A "$cfo_mount")" ]; then echo '挂载目录非空，停止'; exit 1; fi
 mount -t cifs '//192.168.1.111/cfo-export' "$cfo_mount" \
  -o "credentials=$cfo_cred,ro,noexec,nosuid,nodev,vers=3.1.1,seal,uid=1000,gid=1000,forceuid,forcegid,file_mode=0440,dir_mode=0550"
fi
if [ "$(findmnt -rn -M "$cfo_mount" -o FSTYPE)" != cifs ] || [ "$(findmnt -rn -M "$cfo_mount" -o SOURCE)" != '//192.168.1.111/cfo-export' ]; then echo '数据目录不是预期的只读共享'; exit 1; fi
for cfo_flag in ro noexec nosuid nodev; do
 findmnt -rn -M "$cfo_mount" -o OPTIONS | grep -Eq "(^|,)$cfo_flag(,|$)" || { echo '挂载保护选项不符，停止'; exit 1; }
done
cfo_attempt=0
until docker info >/dev/null 2>&1 && [ "$(docker inspect -f '{{.State.Health.Status}}' cfo-postgres-1 2>/dev/null)" = healthy ]; do
 cfo_attempt=$((cfo_attempt+1));if [ "$cfo_attempt" -ge 45 ]; then echo '等待CFO Docker/数据库超时'; exit 1; fi;sleep 2
done
# Recreate AFTER verified mount so an early Docker auto-start cannot pin an empty folder.
docker compose --env-file .env.portfolio -f compose.yaml -f compose.portfolio.yaml up -d --no-deps --no-build --force-recreate portfolio-sync
